//! Running external programs, and the server as a detached process with a pid file.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::Var;
use super::settings::{self, Bundle, DataDir};

/// How long the server gets to accept connections after it was started.
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the server gets to exit after SIGTERM.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(100);
/// Lines of `server.log` shown when the server exits during its start.
const LOG_TAIL: usize = 20;

/// The executable `name` in a directory of `PATH`.
pub(crate) fn find_on_path(name: &str, var: Var) -> Option<PathBuf> {
    let path = var("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| {
            fs::metadata(candidate)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

pub(super) fn output(program: &str, args: &[&str]) -> io::Result<Output> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
}

/// Whether `program args` runs and exits with success.
pub(super) fn succeeds(program: &str, args: &[&str]) -> bool {
    output(program, args).is_ok_and(|output| output.status.success())
}

/// Runs `program args` and returns its stdout; on failure the error ends with `next_step`.
pub(super) fn run(program: &str, args: &[&str], next_step: &str) -> Result<String, String> {
    let command = format!("{program} {}", args.join(" "));
    let output = output(program, args)
        .map_err(|error| format!("cannot run `{command}`: {error}; {next_step}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "`{command}` failed ({}): {}; {next_step}",
            output.status,
            stderr.trim()
        ))
    }
}

/// Whether something accepts TCP connections at `address`.
pub(super) fn accepts(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok()
}

/// Fails, naming a free port to use instead, when `listen` cannot be bound.
/// `flag` is the `--data-dir` option the suggested command needs, see
/// [`settings::data_dir_flag`].
pub(super) fn ensure_port_free(listen: SocketAddr, flag: &str) -> Result<(), String> {
    if TcpListener::bind(listen).is_ok() {
        return Ok(());
    }
    let other = (1..=100)
        .filter_map(|offset| listen.port().checked_add(offset))
        .find(|port| TcpListener::bind(SocketAddr::new(listen.ip(), *port)).is_ok())
        .map_or_else(|| "<other>".to_owned(), |port| port.to_string());
    Err(format!(
        "{listen} is already in use by another program; pick another port with: \
         toodo init --port {other}{flag}"
    ))
}

pub(super) enum Wait {
    Up,
    /// The server is gone, for this reason.
    Exited(String),
    TimedOut,
}

/// Waits until `listen` accepts connections, as long as `exited` reports no exit.
pub(super) fn wait_until_up(
    listen: SocketAddr,
    mut exited: impl FnMut() -> Option<String>,
) -> Wait {
    let address = settings::local_address(listen);
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if accepts(address) {
            return Wait::Up;
        }
        if let Some(reason) = exited() {
            return Wait::Exited(reason);
        }
        if Instant::now() >= deadline {
            return Wait::TimedOut;
        }
        thread::sleep(POLL);
    }
}

/// Whether a command line (`/proc/<pid>/cmdline`, or the program `ps -o comm=` prints) is
/// that of `toodo-server`.
pub(super) fn is_server_cmdline(cmdline: &[u8]) -> bool {
    let program = cmdline.split(|byte| *byte == 0).next().unwrap_or_default();
    Path::new(OsStr::from_bytes(program.trim_ascii_end())).file_name()
        == Some(OsStr::new("toodo-server"))
}

/// Whether `pid` runs `toodo-server`. macOS has no `/proc`, so there `ps` tells.
fn is_server(pid: u32) -> bool {
    if cfg!(target_os = "linux") {
        fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmdline| is_server_cmdline(&cmdline))
    } else {
        output("ps", &["-p", &pid.to_string(), "-o", "comm="])
            .is_ok_and(|output| output.status.success() && is_server_cmdline(&output.stdout))
    }
}

/// The pid of the server started by `toodo start`, when it is still running.
pub(super) fn running_pid(data: &DataDir) -> Option<u32> {
    let pid = fs::read_to_string(data.pid()).ok()?.trim().parse().ok()?;
    is_server(pid).then_some(pid)
}

/// Starts `toodo-server` detached from this process, logging to `server.log`, and waits
/// until it accepts connections. Returns its pid.
pub(super) fn spawn(
    bundle: &Bundle,
    data: &DataDir,
    listen: SocketAddr,
    flag: &str,
) -> Result<u32, String> {
    let log_path = data.log();
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_path)
        .map_err(|error| {
            format!(
                "cannot open {}: {error}; check the permissions of {} or pass another --data-dir",
                log_path.display(),
                data.path().display()
            )
        })?;
    let stderr = log
        .try_clone()
        .map_err(|error| format!("cannot open {}: {error}", log_path.display()))?;
    let mut command = Command::new(&bundle.server);
    command
        .env("TOODO_LISTEN", listen.to_string())
        .env("TOODO_DATA_DIR", data.path())
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(stderr)
        .process_group(0);
    match &bundle.web {
        Some(web) => command.env("TOODO_WEB_DIR", web),
        None => command.env_remove("TOODO_WEB_DIR"),
    };
    let mut child = command.spawn().map_err(|error| {
        format!(
            "cannot start {}: {error}; reinstall the CLI with: npm install -g @dubusoft/toodo",
            bundle.server.display()
        )
    })?;
    let pid = child.id();
    fs::write(data.pid(), format!("{pid}\n"))
        .map_err(|error| format!("cannot write {}: {error}", data.pid().display()))?;
    let waited = wait_until_up(listen, || match child.try_wait() {
        Ok(Some(status)) => Some(status.to_string()),
        Ok(None) => None,
        Err(error) => Some(error.to_string()),
    });
    match waited {
        Wait::Up => Ok(pid),
        Wait::Exited(reason) => {
            drop(fs::remove_file(data.pid()));
            eprintln!("{}", tail(&log_path, LOG_TAIL));
            Err(format!(
                "toodo-server exited ({reason}) before it accepted connections on {listen}; \
                 the end of {} is above: fix what it reports and run toodo start{flag} again",
                log_path.display()
            ))
        }
        Wait::TimedOut => Err(format!(
            "toodo-server (pid {pid}) did not accept connections on {listen} within {} s; \
             check {}, then run toodo stop{flag} and toodo start{flag}",
            START_TIMEOUT.as_secs(),
            log_path.display()
        )),
    }
}

/// Stops the server started by `toodo start`: SIGTERM, then a bounded wait. Returns
/// whether one was running. A pid file whose process is not `toodo-server` is stale and
/// only removed.
pub(super) fn stop(data: &DataDir) -> Result<bool, String> {
    let Some(pid) = running_pid(data) else {
        drop(fs::remove_file(data.pid()));
        return Ok(false);
    };
    let pid_text = pid.to_string();
    run(
        "kill",
        &["-TERM", &pid_text],
        &format!("stop it yourself with: kill {pid}"),
    )?;
    let deadline = Instant::now() + STOP_TIMEOUT;
    while is_server(pid) {
        if Instant::now() >= deadline {
            return Err(format!(
                "toodo-server (pid {pid}) did not exit within {} s of SIGTERM; check {}, \
                 then end it with: kill -KILL {pid}",
                STOP_TIMEOUT.as_secs(),
                data.log().display()
            ));
        }
        thread::sleep(POLL);
    }
    drop(fs::remove_file(data.pid()));
    Ok(true)
}

/// The last `lines` lines of the file at `path`.
fn tail(path: &Path, lines: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_toodo_server_command_line_counts_as_the_server() {
        assert!(is_server_cmdline(b"/opt/pkg/bin/toodo-server\0"));
        assert!(is_server_cmdline(b"toodo-server\0import\0file\0"));
        assert!(!is_server_cmdline(b"/usr/bin/sleep\0toodo-server\0"));
        assert!(!is_server_cmdline(b"/opt/toodo-server-old\0"));
        assert!(!is_server_cmdline(b""));
        assert!(is_server_cmdline(b"/Users/a/.local/bin/toodo-server\n"));
        assert!(!is_server_cmdline(b"/usr/bin/sleep\n"));
    }

    #[test]
    fn a_stale_pid_file_is_removed_without_signaling() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir(dir.path().to_path_buf());
        // This test process is not toodo-server.
        fs::write(data.pid(), format!("{}\n", std::process::id())).unwrap();
        assert_eq!(running_pid(&data), None);
        assert!(!stop(&data).unwrap());
        assert!(!data.pid().exists());
    }

    #[test]
    fn programs_are_found_on_path_only_when_executable() {
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("tool");
        fs::write(&tool, "").unwrap();
        let path = dir.path().display().to_string();
        let var = |name: &str| (name == "PATH").then(|| path.clone());
        assert_eq!(find_on_path("tool", &var), None);
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_on_path("tool", &var), Some(tool));
        assert_eq!(find_on_path("missing", &var), None);
    }

    #[test]
    fn the_tail_keeps_the_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log");
        fs::write(&path, "a\nb\nc\n").unwrap();
        assert_eq!(tail(&path, 2), "b\nc");
        assert_eq!(tail(&path, 10), "a\nb\nc");
    }
}
