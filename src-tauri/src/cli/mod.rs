//! The `toodo` CLI: sets up and runs `toodo-server` for the current user, and registers
//! its MCP endpoint with coding agents. It is shipped next to `toodo-server` (and the web
//! app in `../web`), see [`settings::Bundle`].
//!
//! The server runs either as the systemd user service `toodo-server.service` (on macOS
//! the launchd agent `toodo-server`), once `toodo service install` wrote it for the data
//! directory, or detached with a pid file in the data directory, started by `toodo start`.

mod agents;
mod args;
mod doctor;
mod launchd;
mod process;
mod release;
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
use args::{USAGE, command_help, parse};
use settings::{Bundle, DataDir, ListenFlag};
use update::{Channel, Source};

pub(crate) use process::find_on_path;

/// Reads an environment variable; tests pass their own.
type Var<'a> = &'a dyn Fn(&str) -> Option<String>;

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
    source: Option<Source>,
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
        Command::Update(args) if args.check => {
            update::check(args.channel, args.source, &var).map(|()| 0)
        }
        Command::Update(args) => data_dir(args.data_dir.as_deref(), &var).and_then(|data| {
            let flag = settings::data_dir_flag(&data, &var);
            update::update(
                args.channel,
                args.source,
                args.allow_downgrade,
                &data,
                &flag,
                &var,
            )
            .map(|()| 0)
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
