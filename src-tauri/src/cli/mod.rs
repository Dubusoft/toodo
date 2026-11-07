//! The `toodo` CLI: sets up and runs `toodo-server` for the current user, and registers
//! its MCP endpoint with coding agents. It is shipped next to `toodo-server` (and the web
//! app in `../web`), see [`settings::Bundle`].
//!
//! The server runs either as the systemd user service `toodo-server.service` (on macOS
//! the launchd agent `toodo-server`), once `toodo service install` wrote it for the data
//! directory, or detached with a pid file in the data directory, started by `toodo start`.

mod agents;
mod doctor;
mod launchd;
mod process;
mod review;
mod service;
mod settings;
mod uninstall;
mod update;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use crate::mcp;
use crate::server;
use agents::Outcome;
use settings::{Bundle, DataDir, ListenFlag};
use update::Channel;

pub(crate) use process::find_on_path;

/// Reads an environment variable; tests pass their own.
type Var<'a> = &'a dyn Fn(&str) -> Option<String>;

const USAGE: &str = "Usage: toodo init [--port N | --listen HOST:PORT] [--data-dir DIR] [--no-mcp]
       toodo start [--data-dir DIR]
       toodo stop [--data-dir DIR]
       toodo restart [--data-dir DIR]
       toodo status [--data-dir DIR]
       toodo doctor [--data-dir DIR]
       toodo logs [--lines N] [--follow] [--data-dir DIR]
       toodo service install [--port N | --listen HOST:PORT] [--data-dir DIR]
       toodo update [--channel dev|latest] [--allow-downgrade | --check] [--data-dir DIR]
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
                   Claude Code and Codex where they are on PATH; then check git,
                   gh, ssh, herdr, tmux, and the agent CLIs and print what is missing
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
  update           install the newest @dubusoft/toodo of the channel with npm, restart
                   the server on it, check that it answers, and register its MCP
                   endpoint again like start; a failed install
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
  --channel CHANNEL   npm dist-tag update installs: dev (prereleases of the dev branch)
                      or latest (releases); default dev when the installed version is a
                      prerelease, else latest
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
fn command_help(command: &str) -> String {
    let (usage, about, options) = match command {
        "init" => (
            "toodo init [--port N | --listen HOST:PORT] [--data-dir DIR] [--no-mcp]",
            "Creates the data directory, its database and access tokens, saves the listen
address, starts the server, and registers its MCP endpoint with Claude Code and Codex
where they are on PATH. Then it checks git, gh, ssh, herdr, tmux, and the agent CLIs
and prints what is missing. Running it again keeps the database and tokens.",
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
            "toodo update [--channel dev|latest] [--allow-downgrade | --check] [--data-dir DIR]",
            "Installs the newest @dubusoft/toodo of the channel with npm, restarts the server
on it, and checks that it answers. A failed install leaves the running server alone; a
server that does not answer after the update goes back to the previous version. With
--check it only reports whether the channel has a newer version.",
            format!(
                "  --channel CHANNEL   npm dist-tag to install: dev (prereleases of the dev \
                 branch)
                      or latest (releases); default dev when the installed version is a
                      prerelease, else latest
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

/// A warning for a listen address that other machines can reach, `None` for loopback.
fn exposure_warning(listen: SocketAddr) -> Option<String> {
    if listen.ip().is_loopback() {
        return None;
    }
    Some(format!(
        "warning: toodo-server will listen on {listen}, which other machines can reach over \
         plain HTTP; anyone who reaches it can try the access tokens. To keep it on this \
         machine, rerun with --listen 127.0.0.1:{port} and reach it through an SSH or \
         Cloudflare tunnel (see docs/server.md); otherwise firewall the port.",
        port = listen.port()
    ))
}

/// The exit status of `toodo status` while the server is stopped.
const STOPPED: i32 = 3;

/// The lines `toodo logs` prints by default.
const LOG_LINES: u32 = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    /// The overview, or the help of the named command.
    Help(Option<&'static str>),
    Version,
    Init(InitArgs),
    Start(Option<PathBuf>),
    Stop(Option<PathBuf>),
    Restart(Option<PathBuf>),
    Status(Option<PathBuf>),
    Doctor(Option<PathBuf>),
    Logs(LogsArgs),
    /// Whether to delete the data directory, and the data directory.
    Uninstall(bool, Option<PathBuf>),
    /// The listen address to save and the data directory.
    ServiceInstall(Option<ListenFlag>, Option<PathBuf>),
    Update(UpdateArgs),
    Review(review::ReviewArgs),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LogsArgs {
    lines: u32,
    follow: bool,
    data_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UpdateArgs {
    channel: Option<Channel>,
    allow_downgrade: bool,
    /// Only report whether the channel has a newer version.
    check: bool,
    data_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InitArgs {
    listen: Option<ListenFlag>,
    data_dir: Option<PathBuf>,
    mcp: bool,
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
fn parse(args: &[String]) -> Result<Command, String> {
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
            "--port" | "--listen" | "--data-dir" | "--channel" | "--lines" | "-n"
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
        if matches!(name, "--channel" | "--allow-downgrade" | "--check") && command != "update" {
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
            allow_downgrade,
            check,
            data_dir,
        }),
        _ => Command::ServiceInstall(init.listen, data_dir),
    })
}

pub fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse(&args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("toodo: {error}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    let var = |name: &str| std::env::var(name).ok();
    let result = match command {
        Command::Help(None) => {
            println!("{USAGE}");
            Ok(0)
        }
        Command::Help(Some(command)) => {
            println!("{}", command_help(command));
            Ok(0)
        }
        Command::Version => {
            println!(
                "{}",
                server::with_commit("toodo", &update::version(), env!("TOODO_COMMIT"))
            );
            Ok(0)
        }
        Command::Init(init_args) => update::leave_npx_cache(&args, &var)
            .and_then(|()| init(&init_args, &var))
            .map(|()| 0),
        Command::Start(dir) => data_dir(dir.as_deref(), &var).and_then(|data| {
            start(&data, &var)?;
            // The server may have created a new token, see `docs/server.md`.
            agents::refresh(&data, settings::listen(&data)?, &var);
            Ok(0)
        }),
        Command::Stop(dir) => data_dir(dir.as_deref(), &var)
            .and_then(|data| stop(&data, &var))
            .map(|()| 0),
        Command::Restart(dir) => data_dir(dir.as_deref(), &var).and_then(|data| {
            restart(&data, &var)?;
            agents::refresh(&data, settings::listen(&data)?, &var);
            Ok(0)
        }),
        Command::Status(dir) => data_dir(dir.as_deref(), &var).and_then(|data| status(&data, &var)),
        Command::Doctor(dir) => {
            data_dir(dir.as_deref(), &var).and_then(|data| doctor::doctor(&data, &var))
        }
        Command::Logs(args) => {
            data_dir(args.data_dir.as_deref(), &var).and_then(|data| logs(&data, &args, &var))
        }
        Command::Uninstall(delete_data, dir) => data_dir(dir.as_deref(), &var)
            .and_then(|data| uninstall::uninstall(&data, delete_data, &var))
            .map(|()| 0),
        Command::ServiceInstall(flag, dir) => data_dir(dir.as_deref(), &var)
            .and_then(|data| service_install(&data, flag, &var))
            .map(|()| 0),
        Command::Update(args) if args.check => update::check(args.channel, &var).map(|()| 0),
        Command::Update(args) => data_dir(args.data_dir.as_deref(), &var).and_then(|data| {
            let flag = settings::data_dir_flag(&data, &var);
            update::update(args.channel, args.allow_downgrade, &data, &flag, &var).map(|()| 0)
        }),
        Command::Review(args) => data_dir(args.data_dir.as_deref(), &var)
            .and_then(|data| review::review(&args, &data, &var))
            .map(|()| 0),
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("toodo: {error}");
            std::process::exit(1);
        }
    }
}

/// How the commands this CLI suggests run it: `toodo` when that is this install on
/// `PATH`, else the path of this executable.
fn program(var: Var) -> String {
    let Ok(exe) = std::env::current_exe().and_then(std::fs::canonicalize) else {
        return "toodo".to_owned();
    };
    let found = find_on_path("toodo", var).and_then(|path| std::fs::canonicalize(path).ok());
    if found.is_some_and(|found| runs(&found, &exe)) {
        "toodo".to_owned()
    } else {
        exe.display().to_string()
    }
}

/// Whether `found`, the resolved `toodo` on `PATH`, runs `exe`: it is `exe`, or the npm
/// launcher (`<package>/bin/toodo.js`) of the package that holds `exe`.
fn runs(found: &Path, exe: &Path) -> bool {
    found == exe
        || found
            .parent()
            .and_then(Path::parent)
            .is_some_and(|package| exe.starts_with(package.join("node_modules")))
}

fn data_dir(flag: Option<&Path>, var: Var) -> Result<DataDir, String> {
    settings::data_dir(flag, var)
}

/// `toodo service install`: saves the address of `--port` or `--listen` like init, then
/// writes and restarts the service on the saved address (else the default).
fn service_install(data: &DataDir, flag: Option<ListenFlag>, var: Var) -> Result<(), String> {
    let saved = settings::saved_listen(data)?;
    let listen = settings::resolve_listen(flag, saved);
    if let Some(warning) = exposure_warning(listen) {
        eprintln!("{warning}");
    }
    if flag.is_some() && saved != Some(listen) {
        server::create_private_dir(data.path()).map_err(|error| {
            format!(
                "cannot create the data directory {}: {error}; check its permissions or pass \
                 another --data-dir",
                data.path().display()
            )
        })?;
        settings::save_listen(data, listen)?;
    }
    install_service(data, listen, var)
}

/// `toodo service install`: a launchd agent on macOS, else a systemd user service.
fn install_service(data: &DataDir, listen: SocketAddr, var: Var) -> Result<(), String> {
    if launchd::supported() {
        launchd::install(data, listen, var)
    } else {
        service::install(data, listen, var)
    }
}

/// Who runs the server of a data directory.
#[derive(Debug, Clone, Copy)]
enum Manager {
    /// The systemd user service.
    Service,
    /// The launchd agent on macOS.
    Launchd,
    /// `toodo start`, with a pid file.
    PidFile,
}

fn manager(data: &DataDir, var: Var) -> Result<Manager, String> {
    Ok(if service::manages(&service::unit_path(var)?, data) {
        Manager::Service
    } else if launchd::supported() && launchd::manages(&launchd::plist_path(var)?, data) {
        Manager::Launchd
    } else {
        Manager::PidFile
    })
}

fn is_running(manager: &Manager, data: &DataDir) -> bool {
    match manager {
        Manager::Service => service::is_active(),
        Manager::Launchd => launchd::is_running(),
        Manager::PidFile => process::running_pid(data).is_some(),
    }
}

fn init(args: &InitArgs, var: Var) -> Result<(), String> {
    let data = settings::data_dir(args.data_dir.as_deref(), var)?;
    let in_data = |error: &dyn std::fmt::Display| {
        format!(
            "cannot set up the data directory {}: {error}; check its permissions or pass \
             another --data-dir",
            data.path().display()
        )
    };
    let saved = settings::saved_listen(&data)?;
    let previous = saved.unwrap_or_else(settings::default_listen);
    let listen = settings::resolve_listen(args.listen, saved);
    if let Some(warning) = exposure_warning(listen) {
        eprintln!("{warning}");
    }
    let manager = manager(&data, var)?;
    let running = is_running(&manager, &data);
    // A server left running from another install, such as npm's npx cache, is restarted
    // on this one.
    let foreign = match manager {
        Manager::PidFile if running => Bundle::find()
            .ok()
            .and_then(|bundle| process::foreign_server(&data, &bundle)),
        _ => None,
    };
    // A busy port stops init before it creates anything.
    if !running {
        process::ensure_port_free(listen, &settings::data_dir_flag(&data, var))?;
    }
    server::create_private_dir(data.path()).map_err(|error| in_data(&error))?;
    let backups = crate::commands::backup::Backups::load(data.path());
    drop(server::open_storage(&data.database(), &backups)?);
    let mcp_token = mcp::load_token(&data.mcp_token()).map_err(|error| in_data(&error))?;
    mcp::load_token(&data.web_token()).map_err(|error| in_data(&error))?;
    settings::record_data_dir(&data, var)?;
    let flag = settings::data_dir_flag(&data, var);

    if running && listen == previous && foreign.is_none() {
        println!(
            "toodo-server is already running on {}; keeping it",
            settings::web_url(listen)
        );
    } else {
        // The running server holds the previous port, which it gives up on restart.
        if running && listen.port() != previous.port() {
            process::ensure_port_free(listen, &flag)?;
        }
        settings::save_listen(&data, listen)?;
        match manager {
            Manager::Service | Manager::Launchd => {
                if listen != previous {
                    println!("The listen address changed to {listen}; rewriting the service.");
                    install_service(&data, listen, var)?;
                } else {
                    start(&data, var)?;
                }
            }
            Manager::PidFile => {
                if let Some(old) = &foreign {
                    println!(
                        "toodo-server runs {}; restarting it on this install.",
                        old.display()
                    );
                    stop(&data, var)?;
                } else if running {
                    println!("The listen address changed to {listen}; restarting toodo-server.");
                    stop(&data, var)?;
                }
                start(&data, var)?;
            }
        }
    }

    let mut failed = Vec::new();
    if args.mcp {
        let url = settings::mcp_url(listen);
        for (agent, outcome) in agents::register(&url, &mcp_token, &data.mcp_token(), var) {
            match outcome {
                Outcome::Registered(place) => {
                    println!("MCP for {agent}: registered {url} ({place})");
                }
                Outcome::Skipped => println!("MCP for {agent}: skipped ({agent} is not on PATH)"),
                Outcome::Failed(error) => {
                    println!("MCP for {agent}: failed: {error}");
                    failed.push(agent);
                }
            }
        }
    } else {
        println!("MCP: not registered with any agent (--no-mcp)");
    }

    let web_token = data.web_token();
    let program = program(var);
    let status = format!("{program} status{flag}");
    let service_install = format!("{program} service install{flag}");
    // The commands line up in a column, also when they start with a long path.
    let width = 22.max(service_install.len() + 1);
    println!(
        "
Toodo is running.
  Web app:  {web}
  Sign in with the web access token in {token}; print it with: cat {token}
  MCP:      {mcp} (token in {mcp_token})

Next steps:
  {status:<width$} check the server and where its files are",
        web = settings::web_url(listen),
        token = web_token.display(),
        mcp = settings::mcp_url(listen),
        mcp_token = data.mcp_token().display(),
    );
    if let Manager::PidFile = manager {
        println!(
            "  {service_install:<width$} keep the server running as {}",
            if launchd::supported() {
                "a launchd agent that starts at login"
            } else {
                "a systemd user service"
            }
        );
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "registering the MCP endpoint failed for {}; run the command shown above, or fix \
             the cause and rerun toodo init",
            failed.join(" and ")
        ))
    }
}

fn start(data: &DataDir, var: Var) -> Result<(), String> {
    let listen = settings::listen(data)?;
    match manager(data, var)? {
        Manager::Service => {
            if service::is_active() {
                println!("{} is already running", service::UNIT_NAME);
                return Ok(());
            }
            service::systemctl("start")?;
            service::wait_until_up(listen)?;
            println!(
                "Started {} on {}",
                service::UNIT_NAME,
                settings::web_url(listen)
            );
        }
        Manager::Launchd => {
            if launchd::is_running() {
                println!("launchd job {} is already running", launchd::LABEL);
                return Ok(());
            }
            launchd::start(var)?;
            launchd::wait_until_up(listen, var)?;
            println!(
                "Started launchd job {} on {}",
                launchd::LABEL,
                settings::web_url(listen)
            );
        }
        Manager::PidFile => {
            if let Some(pid) = process::running_pid(data) {
                println!("toodo-server is already running (pid {pid})");
                return Ok(());
            }
            let flag = settings::data_dir_flag(data, var);
            process::ensure_port_free(listen, &flag)?;
            let bundle = Bundle::find()?;
            server::create_private_dir(data.path()).map_err(|error| {
                format!(
                    "cannot create {}: {error}; check the permissions of its parent or pass \
                     another --data-dir",
                    data.path().display()
                )
            })?;
            let pid = process::spawn(&bundle, data, listen, &flag)?;
            println!(
                "Started toodo-server (pid {pid}) on {}; log in {}",
                settings::web_url(listen),
                data.log().display()
            );
            if bundle.web.is_none() {
                println!(
                    "No web app at {}; serving the API and MCP only.",
                    bundle.web_location().display()
                );
            }
        }
    }
    Ok(())
}

fn stop(data: &DataDir, var: Var) -> Result<(), String> {
    match manager(data, var)? {
        Manager::Service => {
            if service::is_active() {
                service::systemctl("stop")?;
                println!("Stopped {}", service::UNIT_NAME);
            } else {
                println!("{} is not running", service::UNIT_NAME);
            }
        }
        Manager::Launchd => {
            if launchd::stop()? {
                println!(
                    "Stopped launchd job {}; it starts again at login or with: toodo start{}",
                    launchd::LABEL,
                    settings::data_dir_flag(data, var)
                );
            } else {
                println!("launchd job {} is not running", launchd::LABEL);
            }
        }
        Manager::PidFile => {
            if process::stop(data)? {
                println!("Stopped toodo-server");
            } else {
                println!("toodo-server is not running");
            }
        }
    }
    Ok(())
}

fn restart(data: &DataDir, var: Var) -> Result<(), String> {
    let listen = settings::listen(data)?;
    match manager(data, var)? {
        Manager::Service => {
            service::systemctl("restart")?;
            service::wait_until_up(listen)?;
            println!(
                "Restarted {} on {}",
                service::UNIT_NAME,
                settings::web_url(listen)
            );
        }
        Manager::Launchd => {
            if launchd::is_running() {
                launchd::kickstart(true)?;
            } else {
                launchd::start(var)?;
            }
            launchd::wait_until_up(listen, var)?;
            println!(
                "Restarted launchd job {} on {}",
                launchd::LABEL,
                settings::web_url(listen)
            );
        }
        Manager::PidFile => {
            if process::stop(data)? {
                println!("Stopped toodo-server");
            }
            start(data, var)?;
        }
    }
    Ok(())
}

/// Prints the end of the server log, and with `follow` new lines until interrupted, by
/// running `journalctl` or `tail` in place of this process.
fn logs(data: &DataDir, args: &LogsArgs, var: Var) -> Result<i32, String> {
    use std::os::unix::process::CommandExt;

    let lines = args.lines.to_string();
    let manager = manager(data, var)?;
    let mut command = match manager {
        Manager::Service => {
            let mut command = std::process::Command::new("journalctl");
            command.args([
                "--user",
                "-u",
                service::UNIT_NAME,
                "--no-pager",
                "-n",
                &lines,
            ]);
            if args.follow {
                command.arg("-f");
            }
            command
        }
        Manager::Launchd | Manager::PidFile => {
            let log = if matches!(manager, Manager::Launchd) {
                launchd::log_path(var)?
            } else {
                data.log()
            };
            if !log.is_file() {
                return Err(format!(
                    "there is no server log at {} yet; the server writes it once it runs, so \
                     start it with: toodo start{}",
                    log.display(),
                    settings::data_dir_flag(data, var)
                ));
            }
            // BSD tail on macOS takes no options after the file.
            let mut command = std::process::Command::new("tail");
            command.args(["-n", &lines]);
            if args.follow {
                command.arg("-f");
            }
            command.arg(log);
            command
        }
    };
    let program = command.get_program().to_string_lossy().into_owned();
    let error = command.exec();
    Err(format!(
        "cannot run {program}: {error}; check that it is on PATH, or read the log shown by \
         toodo status{}",
        settings::data_dir_flag(data, var)
    ))
}

/// Whether the server runs, who runs it, and where its log is.
struct ServerState {
    running: bool,
    /// The unit, launchd job, or pid, with its state.
    description: String,
    log: String,
}

fn server_state(manager: &Manager, data: &DataDir, var: Var) -> Result<ServerState, String> {
    let (running, description, log) = match manager {
        Manager::Service => {
            let state = service::state();
            (
                state == "active",
                format!("{} {state}", service::UNIT_NAME),
                "journalctl --user -u toodo-server".to_owned(),
            )
        }
        Manager::Launchd => (
            launchd::is_running(),
            launchd::describe_state(),
            launchd::log_path(var)?.display().to_string(),
        ),
        Manager::PidFile => {
            let pid = process::running_pid(data);
            (
                pid.is_some(),
                pid.map_or_else(|| "no process".to_owned(), |pid| format!("pid {pid}")),
                data.log().display().to_string(),
            )
        }
    };
    Ok(ServerState {
        running,
        description,
        log,
    })
}

/// Prints the state of the server; the exit status is 0 while it runs, [`STOPPED`] while
/// it does not.
fn status(data: &DataDir, var: Var) -> Result<i32, String> {
    let listen = settings::listen(data)?;
    let manager = manager(data, var)?;
    let ServerState {
        running,
        description: state,
        log,
    } = server_state(&manager, data, var)?;
    println!(
        "toodo-server: {} ({state})
  Web app:    {}
  MCP:        {}
  Data:       {}
  Web token:  {}
  MCP token:  {}
  Log:        {log}",
        if running { "running" } else { "stopped" },
        settings::web_url(listen),
        settings::mcp_url(listen),
        data.path().display(),
        data.web_token().display(),
        data.mcp_token().display(),
    );
    if running {
        Ok(0)
    } else {
        println!(
            "Start it with: {} start{}",
            program(var),
            settings::data_dir_flag(data, var)
        );
        Ok(STOPPED)
    }
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
                allow_downgrade: true,
                check: false,
                data_dir: dir.clone()
            })
        );
        assert_eq!(
            parsed(&["update", "--check", "--channel", "dev"]).unwrap(),
            Command::Update(UpdateArgs {
                channel: Some(Channel::Dev),
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

    #[test]
    fn only_addresses_beyond_loopback_get_an_exposure_warning() {
        let warning = |address: &str| exposure_warning(address.parse().unwrap());
        assert_eq!(warning("127.0.0.1:47616"), None);
        assert_eq!(warning("[::1]:47616"), None);
        assert!(
            warning("0.0.0.0:47616")
                .unwrap()
                .contains("--listen 127.0.0.1:47616")
        );
        assert!(warning("[::]:80").is_some());
        assert!(warning("192.168.1.5:47616").is_some());
    }

    #[test]
    fn the_toodo_on_path_runs_this_cli_directly_or_through_its_npm_launcher() {
        let package = Path::new("/p/lib/node_modules/@dubusoft/toodo");
        let exe = package.join("node_modules/@dubusoft/toodo-linux-x64/bin/toodo");
        assert!(runs(&exe, &exe));
        assert!(runs(&package.join("bin/toodo.js"), &exe));
        let npx = Path::new("/h/.npm/_npx/1a/node_modules/@dubusoft/toodo-linux-x64/bin/toodo");
        assert!(!runs(&package.join("bin/toodo.js"), npx));
        assert!(!runs(Path::new("/usr/local/bin/toodo"), &exe));
    }
}
