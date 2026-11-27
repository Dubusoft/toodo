//! The command line: its usage and help texts, and parsing it into a [`Command`].

use std::net::SocketAddr;
use std::path::PathBuf;

use super::settings::ListenFlag;
use super::update::{Channel, Source};
use super::{Command, InitArgs, LOG_LINES, LogsArgs, UpdateArgs, review};

pub(super) const USAGE: &str =
    "Usage: toodo init [--port N | --listen HOST:PORT] [--data-dir DIR] [--no-mcp]
       toodo start [--data-dir DIR]
       toodo stop [--data-dir DIR]
       toodo restart [--data-dir DIR]
       toodo status [--data-dir DIR]
       toodo doctor [--data-dir DIR]
       toodo logs [--lines N] [--follow] [--data-dir DIR]
       toodo service install [--port N | --listen HOST:PORT] [--data-dir DIR]
       toodo update [--channel dev|latest] [--source npm|github]
                    [--allow-downgrade | --check] [--data-dir DIR]
       toodo uninstall [--delete-data] [--data-dir DIR]
       toodo review [--period week|month|quarter|year|custom] [--date DAY]
                    [--from DAY] [--to DAY] [--format markdown|csv] [--data-dir DIR]
       toodo --version | --help
       toodo COMMAND --help

Runs the Toodo server (toodo-server) for the current user and connects coding agents
to it.

Commands:
  init             create the data directory, its database and access tokens, save the
                   listen address, start the server, and register its MCP endpoint with
                   Claude Code and Codex where they are on PATH
  start            start the server in the background (through systemd or launchd once
                   installed), and register its MCP endpoint again with the agents init
                   registered it with, so they get a replaced token
  stop             stop the server
  restart          stop the server and start it again (through systemd or launchd once
                   installed), and register its MCP endpoint again like start
  status           show whether the server runs and where its files are; exits 0 when
                   it runs and 3 when it is stopped
  doctor           check the versions of toodo and the running server, whether the
                   server runs and answers, and its data files;
                   exits 0 when it finds no problem and 1 when it does
  logs             print the end of the server log (of journalctl for the service)
  service install  run the server as the systemd user service toodo-server.service, or
                   on macOS as the launchd agent toodo-server, which starts at login
  update           install the newest toodo of the channel (from npm, or from GitHub
                   releases for a release install), restart the server on it, check
                   that it answers, and register its MCP endpoint again like start;
                   a failed install
                   leaves the running server alone, a server that does not answer
                   after the update goes back to the previous version, and a channel
                   version older than the installed one is not installed; --check
                   only reports whether the channel has a newer version
  uninstall        stop the server and remove its service, the server copies the
                   service runs, and the MCP registrations; the data directory stays
                   unless --delete-data
  review           print the review of a week, month, quarter, year, or custom period
                   as Markdown or CSV, rendered by the running server

Options:
  --port N            port to listen on, keeping the saved host (default 47616)
  --listen HOST:PORT  address to listen on (default 127.0.0.1:47616); init and service
                      install save it in DIR/cli.json for the other commands
  --data-dir DIR      database, access tokens, and logs (default $TOODO_DATA_DIR, else
                      the directory init recorded in $XDG_CONFIG_HOME/toodo/data-dir
                      (~/.config/toodo/data-dir), else $XDG_DATA_HOME/toodo-server or
                      ~/.local/share/toodo-server); init records it there, so the
                      other commands find it without the option
  --no-mcp            do not register the MCP endpoint with coding agents
  --channel CHANNEL   channel update installs: dev (prereleases of the dev branch)
                      or latest (releases); default dev when the installed version is a
                      prerelease, else latest
  --source SOURCE     where update gets toodo: npm, or github (the releases of
                      $TOODO_RELEASE_REPO, default Dubusoft/toodo, read with $GH_TOKEN);
                      default github for a release install, else npm; github installs
                      to ~/.local/lib/toodo, linked from ~/.local/bin/toodo
  --allow-downgrade   let update install a channel version older than the installed one
  --check             let update only report whether the channel has a newer version
  --lines N, -n N     how many lines of the log logs prints (default 50)
  --follow, -f        let logs keep printing new lines until interrupted
  --delete-data       let uninstall delete the data directory too

`toodo COMMAND --help` shows the options of one command.";

const DATA_DIR_OPTION: &str =
    "  --data-dir DIR      database, access tokens, and logs (default $TOODO_DATA_DIR, else
                      the directory init recorded in ~/.config/toodo/data-dir, else
                      ~/.local/share/toodo-server)";

const LISTEN_OPTIONS: &str =
    "  --port N            port to listen on, keeping the saved host (default 47616)
  --listen HOST:PORT  address to listen on (default 127.0.0.1:47616), saved in
                      DIR/cli.json for the other commands. An address other than
                      loopback lets other machines reach the server; prefer an SSH or
                      Cloudflare tunnel to it (see docs/server.md)";

/// The help text of one command, named as in [`parse`].
pub(super) fn command_help(command: &str) -> String {
    let (usage, about, options) = match command {
        "init" => (
            "toodo init [--port N | --listen HOST:PORT] [--data-dir DIR] [--no-mcp]",
            "Creates the data directory, its database and access tokens, saves the listen
address, starts the server, and registers its MCP endpoint with Claude Code and Codex
where they are on PATH. Running it again keeps the database and tokens.",
            format!(
                "{LISTEN_OPTIONS}\n{DATA_DIR_OPTION}\n  --no-mcp            do not register the MCP \
                 endpoint with coding agents"
            ),
        ),
        "start" => (
            "toodo start [--data-dir DIR]",
            "Starts the server in the background: through systemd (launchd on macOS) once toodo
service install wrote the service, else as a process with server.pid and server.log in DIR.",
            DATA_DIR_OPTION.to_owned(),
        ),
        "stop" => (
            "toodo stop [--data-dir DIR]",
            "Stops the server, through systemd (launchd on macOS) once the service is installed.",
            DATA_DIR_OPTION.to_owned(),
        ),
        "restart" => (
            "toodo restart [--data-dir DIR]",
            "Stops the server and starts it again: through systemd (launchd on macOS) once toodo
service install wrote the service, else as a process with server.pid and server.log in DIR.
Then it registers the MCP endpoint again with the agents init registered it with.",
            DATA_DIR_OPTION.to_owned(),
        ),
        "doctor" => (
            "toodo doctor [--data-dir DIR]",
            "Checks the versions of toodo and the running server, whether the server runs and
answers, and the database and tokens in DIR. Prints each problem with its next step.
Exits 0 when it finds no problem and 1 when it does.",
            DATA_DIR_OPTION.to_owned(),
        ),
        "logs" => (
            "toodo logs [--lines N] [--follow] [--data-dir DIR]",
            "Prints the end of the server log: of journalctl for the systemd service, of
~/Library/Logs/toodo-server.log for the launchd agent, else of server.log in DIR.",
            format!(
                "  --lines N, -n N     how many lines to print (default {LOG_LINES})
  --follow, -f        keep printing new lines until interrupted
{DATA_DIR_OPTION}"
            ),
        ),
        "uninstall" => (
            "toodo uninstall [--delete-data] [--data-dir DIR]",
            "Stops the server and removes what toodo set up for it: the systemd service (the
launchd agent on macOS) with the copies of the server and the web app it runs, the
registration of its MCP endpoint with Claude Code and Codex, and the record of DIR in
~/.config/toodo/data-dir. DIR with the database, tokens, and backups stays unless
--delete-data. The toodo command itself stays; npm rm -g @dubusoft/toodo removes it.",
            format!(
                "  --delete-data       delete DIR too, if it holds a Toodo database
{DATA_DIR_OPTION}"
            ),
        ),
        "status" => (
            "toodo status [--data-dir DIR]",
            "Shows whether the server runs, its web app and MCP URLs, and where its data,
tokens, and log are. Exits 0 when it runs and 3 when it is stopped.",
            DATA_DIR_OPTION.to_owned(),
        ),
        "service install" => (
            "toodo service install [--port N | --listen HOST:PORT] [--data-dir DIR]",
            "Runs the server as the systemd user service toodo-server.service: copies
toodo-server to ~/.local/bin and the web app to ~/.local/share/toodo-server-web, writes
the unit, enables and restarts it, and turns on lingering. With --port or --listen it
saves a new listen address first, like init. On macOS it writes the launchd agent
~/Library/LaunchAgents/toodo-server.plist instead, which starts at login.",
            format!("{LISTEN_OPTIONS}\n{DATA_DIR_OPTION}"),
        ),
        "review" => (
            review::USAGE,
            review::ABOUT,
            format!("{}\n{DATA_DIR_OPTION}", review::OPTIONS),
        ),
        _ => (
            "toodo update [--channel dev|latest] [--source npm|github] [--allow-downgrade | --check]
             [--data-dir DIR]",
            "Installs the newest toodo of the channel, restarts the server on it, and checks
that it answers. A failed install leaves the running server alone; a server that does
not answer after the update goes back to the previous version. With --check it only
reports whether the channel has a newer version.

From npm it installs @dubusoft/toodo globally. From GitHub it downloads the release
asset of this platform from $TOODO_RELEASE_REPO (default Dubusoft/toodo) with the token
in $GH_TOKEN (else $GITHUB_TOKEN), checks its sha256, and installs it to
~/.local/lib/toodo, linked from ~/.local/bin/toodo; --source github on another install
moves it there.",
            format!(
                "  --channel CHANNEL   channel to install: dev (prereleases of the dev \
                 branch)
                      or latest (releases); default dev when the installed version is a
                      prerelease, else latest
  --source SOURCE     npm or github; default github for a release install, else npm
  --allow-downgrade   install a channel version older than the installed one
  --check             only report whether the channel has a newer version
{DATA_DIR_OPTION}"
            ),
        ),
    };
    format!(
        "Usage: {usage}\n\n{about}\n\nOptions:\n{options}\n  -h, --help          show this help"
    )
}
/// The commands [`parse`] takes options for itself; `service install` and `review` aside.
const COMMANDS: [&str; 9] = [
    "init",
    "start",
    "stop",
    "restart",
    "status",
    "doctor",
    "logs",
    "update",
    "uninstall",
];

/// Parses the arguments after the program name.
pub(super) fn parse(args: &[String]) -> Result<Command, String> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        let command = match args.first().map(String::as_str) {
            Some("service") => Some("service install"),
            Some(name) => COMMANDS
                .into_iter()
                .chain(["review"])
                .find(|command| *command == name),
            None => None,
        };
        return Ok(Command::Help(command));
    }
    if args.iter().any(|arg| arg == "-V" || arg == "--version") {
        return Ok(Command::Version);
    }
    let (command, options) = match args {
        [] => return Err("missing command".to_owned()),
        [service, install, rest @ ..] if service == "service" && install == "install" => {
            ("service install", rest)
        }
        [service, ..] if service == "service" => {
            return Err("service takes the subcommand install".to_owned());
        }
        [command, rest @ ..] if command == "review" => {
            return review::parse(rest).map(Command::Review);
        }
        [command, rest @ ..] => (command.as_str(), rest),
    };
    if command != "service install" && !COMMANDS.contains(&command) {
        return Err(format!("unknown command {command:?}"));
    }
    let mut init = InitArgs {
        listen: None,
        data_dir: None,
        mcp: true,
    };
    let mut channel = None;
    let mut source = None;
    let mut allow_downgrade = false;
    let mut check = false;
    let mut lines = LOG_LINES;
    let mut follow = false;
    let mut delete_data = false;
    let mut options = options.iter();
    while let Some(option) = options.next() {
        let (name, inline) = match option.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_owned())),
            _ => (option.as_str(), None),
        };
        let takes_value = matches!(
            name,
            "--port" | "--listen" | "--data-dir" | "--channel" | "--source" | "--lines" | "-n"
        );
        let value = if takes_value {
            match inline.or_else(|| options.next().cloned()) {
                Some(value) if !value.is_empty() => value,
                _ => return Err(format!("{name} needs a value")),
            }
        } else if inline.is_some() {
            return Err(format!("{name} takes no value"));
        } else {
            String::new()
        };
        let sets_listen = matches!(name, "--port" | "--listen");
        if sets_listen && !matches!(command, "init" | "service install") {
            return Err(format!(
                "{name} is an option of toodo init and toodo service install, not of {command}"
            ));
        }
        if name == "--no-mcp" && command != "init" {
            return Err(format!(
                "{name} is an option of toodo init, not of {command}"
            ));
        }
        if matches!(
            name,
            "--channel" | "--source" | "--allow-downgrade" | "--check"
        ) && command != "update"
        {
            return Err(format!(
                "{name} is an option of toodo update, not of {command}"
            ));
        }
        if matches!(name, "--lines" | "-n" | "--follow" | "-f") && command != "logs" {
            return Err(format!(
                "{name} is an option of toodo logs, not of {command}"
            ));
        }
        if name == "--delete-data" && command != "uninstall" {
            return Err(format!(
                "{name} is an option of toodo uninstall, not of {command}"
            ));
        }
        match name {
            "--data-dir" => init.data_dir = Some(PathBuf::from(value)),
            "--no-mcp" => init.mcp = false,
            "--allow-downgrade" => allow_downgrade = true,
            "--check" => check = true,
            "--follow" | "-f" => follow = true,
            "--delete-data" => delete_data = true,
            "--lines" | "-n" => match value.parse::<u32>() {
                Ok(parsed) => lines = parsed,
                Err(_) => {
                    return Err(format!("{name} takes a number of lines, got {value:?}"));
                }
            },
            "--channel" => match Channel::parse(&value) {
                Some(parsed) => channel = Some(parsed),
                None => {
                    return Err(format!("--channel takes dev or latest, got {value:?}"));
                }
            },
            "--source" => match Source::parse(&value) {
                Some(parsed) => source = Some(parsed),
                None => {
                    return Err(format!("--source takes npm or github, got {value:?}"));
                }
            },
            "--port" | "--listen" if init.listen.is_some() => {
                return Err("give either --port or --listen, once".to_owned());
            }
            "--port" => match value.parse::<u16>() {
                Ok(port) if port > 0 => init.listen = Some(ListenFlag::Port(port)),
                _ => {
                    return Err(format!(
                        "--port takes a port from 1 to 65535, got {value:?}"
                    ));
                }
            },
            "--listen" => match value.parse::<SocketAddr>() {
                Ok(address) => init.listen = Some(ListenFlag::Address(address)),
                Err(_) => {
                    return Err(format!(
                        "--listen takes HOST:PORT with an IP address, e.g. 127.0.0.1:47616 or \
                         [::]:47616, got {value:?}"
                    ));
                }
            },
            _ => return Err(format!("unknown option {option:?}")),
        }
    }
    if check && allow_downgrade {
        return Err(
            "--check only reports and installs nothing; drop --allow-downgrade, or drop \
             --check to install"
                .to_owned(),
        );
    }
    let data_dir = init.data_dir.clone();
    Ok(match command {
        "init" => Command::Init(init),
        "start" => Command::Start(data_dir),
        "stop" => Command::Stop(data_dir),
        "restart" => Command::Restart(data_dir),
        "status" => Command::Status(data_dir),
        "doctor" => Command::Doctor(data_dir),
        "logs" => Command::Logs(LogsArgs {
            lines,
            follow,
            data_dir,
        }),
        "uninstall" => Command::Uninstall(delete_data, data_dir),
        "update" => Command::Update(UpdateArgs {
            channel,
            source,
            allow_downgrade,
            check,
            data_dir,
        }),
        _ => Command::ServiceInstall(init.listen, data_dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(args: &[&str]) -> Result<Command, String> {
        parse(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn init_takes_its_options_in_both_forms() {
        assert_eq!(
            parsed(&["init"]).unwrap(),
            Command::Init(InitArgs {
                listen: None,
                data_dir: None,
                mcp: true
            })
        );
        assert_eq!(
            parsed(&["init", "--port", "47990", "--data-dir=/d", "--no-mcp"]).unwrap(),
            Command::Init(InitArgs {
                listen: Some(ListenFlag::Port(47990)),
                data_dir: Some(PathBuf::from("/d")),
                mcp: false
            })
        );
        assert_eq!(
            parsed(&["init", "--listen=0.0.0.0:80"]).unwrap(),
            Command::Init(InitArgs {
                listen: Some(ListenFlag::Address("0.0.0.0:80".parse().unwrap())),
                data_dir: None,
                mcp: true
            })
        );
    }

    #[test]
    fn the_other_commands_take_a_data_dir() {
        let dir = Some(PathBuf::from("/d"));
        assert_eq!(parsed(&["start"]).unwrap(), Command::Start(None));
        assert_eq!(
            parsed(&["stop", "--data-dir", "/d"]).unwrap(),
            Command::Stop(dir.clone())
        );
        assert_eq!(
            parsed(&["status", "--data-dir=/d"]).unwrap(),
            Command::Status(dir.clone())
        );
        assert_eq!(
            parsed(&["service", "install", "--data-dir", "/d"]).unwrap(),
            Command::ServiceInstall(None, dir.clone())
        );
        assert_eq!(
            parsed(&["service", "install", "--listen", "0.0.0.0:80"]).unwrap(),
            Command::ServiceInstall(
                Some(ListenFlag::Address("0.0.0.0:80".parse().unwrap())),
                None
            )
        );
        assert_eq!(
            parsed(&["service", "install", "--port=8080"]).unwrap(),
            Command::ServiceInstall(Some(ListenFlag::Port(8080)), None)
        );
        assert_eq!(
            parsed(&["update"]).unwrap(),
            Command::Update(UpdateArgs {
                channel: None,
                source: None,
                allow_downgrade: false,
                check: false,
                data_dir: None
            })
        );
        assert_eq!(
            parsed(&[
                "update",
                "--channel=latest",
                "--allow-downgrade",
                "--data-dir",
                "/d"
            ])
            .unwrap(),
            Command::Update(UpdateArgs {
                channel: Some(Channel::Latest),
                source: None,
                allow_downgrade: true,
                check: false,
                data_dir: dir.clone()
            })
        );
        assert_eq!(
            parsed(&["update", "--check", "--channel", "dev", "--source=github"]).unwrap(),
            Command::Update(UpdateArgs {
                channel: Some(Channel::Dev),
                source: Some(Source::Github),
                allow_downgrade: false,
                check: true,
                data_dir: None
            })
        );
        assert_eq!(
            parsed(&["restart", "--data-dir", "/d"]).unwrap(),
            Command::Restart(dir.clone())
        );
        assert_eq!(parsed(&["doctor"]).unwrap(), Command::Doctor(None));
        assert_eq!(
            parsed(&["logs"]).unwrap(),
            Command::Logs(LogsArgs {
                lines: LOG_LINES,
                follow: false,
                data_dir: None
            })
        );
        assert_eq!(
            parsed(&["logs", "-n", "200", "-f", "--data-dir=/d"]).unwrap(),
            Command::Logs(LogsArgs {
                lines: 200,
                follow: true,
                data_dir: dir.clone()
            })
        );
        assert_eq!(
            parsed(&["logs", "--lines=5", "--follow"]).unwrap(),
            Command::Logs(LogsArgs {
                lines: 5,
                follow: true,
                data_dir: None
            })
        );
        assert_eq!(
            parsed(&["uninstall"]).unwrap(),
            Command::Uninstall(false, None)
        );
        assert_eq!(
            parsed(&["uninstall", "--delete-data", "--data-dir", "/d"]).unwrap(),
            Command::Uninstall(true, dir)
        );
    }

    #[test]
    fn help_and_version_win_over_everything_else() {
        assert_eq!(parsed(&["--help"]).unwrap(), Command::Help(None));
        assert_eq!(
            parsed(&["init", "--bogus", "-h"]).unwrap(),
            Command::Help(Some("init"))
        );
        assert_eq!(
            parsed(&["service", "install", "--help"]).unwrap(),
            Command::Help(Some("service install"))
        );
        assert_eq!(
            parsed(&["update", "--help"]).unwrap(),
            Command::Help(Some("update"))
        );
        assert_eq!(
            parsed(&["logs", "-h"]).unwrap(),
            Command::Help(Some("logs"))
        );
        assert_eq!(
            parsed(&["uninstall", "--help"]).unwrap(),
            Command::Help(Some("uninstall"))
        );
        assert_eq!(parsed(&["run", "--help"]).unwrap(), Command::Help(None));
        assert_eq!(parsed(&["--version"]).unwrap(), Command::Version);
        assert_eq!(parsed(&["-V"]).unwrap(), Command::Version);
    }

    #[test]
    fn bad_arguments_are_rejected() {
        let error = |args: &[&str]| parsed(args).unwrap_err();
        assert_eq!(error(&[]), "missing command");
        assert_eq!(error(&["run"]), "unknown command \"run\"");
        assert_eq!(error(&["service"]), "service takes the subcommand install");
        assert_eq!(
            error(&["service", "remove"]),
            "service takes the subcommand install"
        );
        assert_eq!(error(&["init", "--port"]), "--port needs a value");
        assert_eq!(error(&["init", "--data-dir="]), "--data-dir needs a value");
        assert!(error(&["init", "--port", "0"]).contains("1 to 65535"));
        assert!(error(&["init", "--port", "http"]).contains("1 to 65535"));
        assert!(error(&["init", "--listen", "localhost:80"]).contains("HOST:PORT"));
        assert_eq!(
            error(&["init", "--port", "1", "--listen", "127.0.0.1:2"]),
            "give either --port or --listen, once"
        );
        assert_eq!(
            error(&["start", "--port", "1"]),
            "--port is an option of toodo init and toodo service install, not of start"
        );
        assert_eq!(
            error(&["service", "install", "--no-mcp"]),
            "--no-mcp is an option of toodo init, not of service install"
        );
        assert_eq!(error(&["init", "--no-mcp=yes"]), "--no-mcp takes no value");
        assert_eq!(
            error(&["update", "--channel", "beta"]),
            "--channel takes dev or latest, got \"beta\""
        );
        assert_eq!(
            error(&["start", "--channel", "dev"]),
            "--channel is an option of toodo update, not of start"
        );
        assert_eq!(
            error(&["start", "--allow-downgrade"]),
            "--allow-downgrade is an option of toodo update, not of start"
        );
        assert_eq!(error(&["status", "extra"]), "unknown option \"extra\"");
        assert_eq!(
            error(&["status", "--check"]),
            "--check is an option of toodo update, not of status"
        );
        assert!(error(&["update", "--check", "--allow-downgrade"]).contains("drop"));
        assert_eq!(
            error(&["doctor", "--follow"]),
            "--follow is an option of toodo logs, not of doctor"
        );
        assert_eq!(
            error(&["logs", "-n", "many"]),
            "-n takes a number of lines, got \"many\""
        );
        assert_eq!(
            error(&["stop", "--delete-data"]),
            "--delete-data is an option of toodo uninstall, not of stop"
        );
    }
}
