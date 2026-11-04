//! The launchd agent `toodo-server` on macOS: `~/Library/LaunchAgents/toodo-server.plist`
//! runs the copies of the server and the web app that [`service::install_bundle`] installs,
//! in the job domain of the logged-in user (`gui/<uid>`), and starts again at login.

use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use super::Var;
use super::process::{self, Wait};
use super::service;
use super::settings::{self, Bundle, DataDir};

pub(super) const LABEL: &str = "toodo-server";

/// How long launchd gets to unload the job after `launchctl bootout`.
const UNLOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether the server runs as a launchd agent on this platform instead of a systemd service.
pub(super) fn supported() -> bool {
    cfg!(target_os = "macos")
}

pub(super) fn plist_path(var: Var) -> Result<PathBuf, String> {
    Ok(settings::home(var)?
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist")))
}

/// Where the job writes the server's output.
pub(super) fn log_path(var: Var) -> Result<PathBuf, String> {
    Ok(settings::home(var)?
        .join("Library/Logs")
        .join(format!("{LABEL}.log")))
}

/// Whether the plist at `plist` exists and runs the server of `data`; the server of
/// another data directory is left to `toodo start`.
pub(super) fn manages(plist: &Path, data: &DataDir) -> bool {
    let wanted = env_line("TOODO_DATA_DIR", &data.path().display().to_string());
    fs::read_to_string(plist).is_ok_and(|text| text.lines().any(|line| line.trim() == wanted))
}

fn domain() -> Result<String, String> {
    let uid = process::run("id", &["-u"], "check that id is on PATH and rerun")?;
    Ok(format!("gui/{}", uid.trim()))
}

fn target() -> Result<String, String> {
    Ok(format!("{}/{LABEL}", domain()?))
}

/// The state `launchctl print` reports for the loaded job (`running`, `not running`, ...),
/// or `None` while it is not loaded.
fn state() -> Option<String> {
    let target = target().ok()?;
    let output = process::output("launchctl", &["print", &target]).ok()?;
    output.status.success().then(|| parse_state(&output.stdout))
}

/// The job state in the output of `launchctl print`: its first `state = ...` line.
fn parse_state(stdout: &[u8]) -> String {
    String::from_utf8_lossy(stdout)
        .lines()
        .find_map(|line| line.trim().strip_prefix("state = "))
        .map_or_else(|| "loaded".to_owned(), |state| state.trim().to_owned())
}

pub(super) fn is_running() -> bool {
    state().as_deref() == Some("running")
}

pub(super) fn describe_state() -> String {
    match state() {
        Some(state) => format!("launchd job {LABEL} {state}"),
        None => format!("launchd job {LABEL} not loaded"),
    }
}

/// Loads the job from its plist, which starts the server, or starts the loaded job.
pub(super) fn start(var: Var) -> Result<(), String> {
    if state().is_some() {
        return kickstart(false);
    }
    let plist = plist_path(var)?;
    let target = target()?;
    // A job disabled with `launchctl disable` refuses to load.
    process::run(
        "launchctl",
        &["enable", &target],
        &format!("check the job with: launchctl print {target}"),
    )?;
    process::run(
        "launchctl",
        &["bootstrap", &domain()?, &plist.display().to_string()],
        &format!(
            "the job runs in the session of the logged-in macOS user, so log in on the Mac \
             and rerun, or run the server without launchd: remove {} and run toodo start",
            plist.display()
        ),
    )
    .map(drop)
}

/// Starts the loaded job; `restart` kills a running server first.
pub(super) fn kickstart(restart: bool) -> Result<(), String> {
    let target = target()?;
    let mut args = vec!["kickstart"];
    if restart {
        args.push("-k");
    }
    args.push(&target);
    process::run(
        "launchctl",
        &args,
        &format!("check the job with: launchctl print {target}"),
    )
    .map(drop)
}

/// Unloads the job, which stops the server; returns whether it was loaded. The plist
/// stays, so the job starts again at the next login or `toodo start`.
pub(super) fn stop() -> Result<bool, String> {
    if state().is_none() {
        return Ok(false);
    }
    let target = target()?;
    process::run(
        "launchctl",
        &["bootout", &target],
        &format!("check the job with: launchctl print {target}"),
    )?;
    let deadline = Instant::now() + UNLOAD_TIMEOUT;
    while state().is_some() {
        if Instant::now() >= deadline {
            return Err(format!(
                "launchd did not unload {target} in time; check it with: launchctl print {target}"
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(true)
}

pub(super) fn wait_until_up(listen: SocketAddr, var: Var) -> Result<(), String> {
    let log = log_path(var)?;
    let hint = format!(
        "see {} and: launchctl print gui/$(id -u)/{LABEL}",
        log.display()
    );
    match process::wait_until_up(listen, || {
        state()
            .is_none()
            .then(|| format!("launchd job {LABEL} is not loaded"))
    }) {
        Wait::Up => Ok(()),
        Wait::Exited(reason) => Err(format!(
            "{reason} and did not accept connections on {listen}; {hint}"
        )),
        Wait::TimedOut => Err(format!(
            "launchd job {LABEL} did not accept connections on {listen} in time; {hint}"
        )),
    }
}

/// What the job runs.
pub(super) struct Job<'a> {
    pub exec: &'a Path,
    pub listen: SocketAddr,
    pub data_dir: &'a Path,
    pub web_dir: Option<&'a Path>,
    /// `PATH` for the server, see [`service::service_path`].
    pub path: &'a str,
    pub log: &'a Path,
}

/// The property list of the job. The server restarts after a crash, as the systemd unit
/// does (`Restart=on-failure`), but not after a clean exit.
pub(super) fn render(job: &Job) -> String {
    let mut env = vec![
        env_line("TOODO_LISTEN", &job.listen.to_string()),
        env_line("TOODO_DATA_DIR", &job.data_dir.display().to_string()),
    ];
    if let Some(web) = job.web_dir {
        env.push(env_line("TOODO_WEB_DIR", &web.display().to_string()));
    }
    env.push(env_line("PATH", job.path));
    let log = escape(&job.log.display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by toodo service install; rerun it instead of editing this file. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{exec}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		{env}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#,
        exec = escape(&job.exec.display().to_string()),
        env = env.join("\n\t\t"),
    )
}

/// One environment variable of the job, on one line so [`manages`] can find it.
fn env_line(name: &str, value: &str) -> String {
    format!("<key>{name}</key><string>{}</string>", escape(value))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `toodo service install` on macOS.
pub(super) fn install(data: &DataDir, listen: SocketAddr, var: Var) -> Result<(), String> {
    if process::find_on_path("launchctl", var).is_none() {
        return Err(
            "launchctl is not on PATH, so there is no launchd to run the server; add /bin to \
             PATH and rerun, or run the server with: toodo start"
                .to_owned(),
        );
    }
    let bundle = Bundle::find()?;
    if process::stop(data)? {
        println!("Stopped the toodo-server started by toodo start; the launchd job replaces it.");
    }
    let (server, web_dir) = service::install_bundle(&bundle, var)?;
    let path = service::service_path_now(var)?;
    let log = log_path(var)?;
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir).map_err(|error| {
            format!(
                "cannot create {}: {error}; check its permissions and rerun",
                dir.display()
            )
        })?;
    }
    let text = render(&Job {
        exec: &server,
        listen,
        data_dir: data.path(),
        web_dir: web_dir.as_deref(),
        path: &path,
        log: &log,
    });
    if stop()? {
        println!("Unloaded the previous launchd job {LABEL}.");
    }
    let plist = plist_path(var)?;
    service::write_atomically(&plist, text.as_bytes(), 0o644)?;
    println!("Wrote {}", plist.display());
    start(var)?;
    wait_until_up(listen, var)?;
    println!(
        "launchd job {LABEL} is running on {}; it starts again when you log in",
        settings::web_url(listen)
    );
    println!("Logs: {}", log.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plist_runs_the_server_with_its_environment() {
        let text = render(&Job {
            exec: Path::new("/Users/a/.local/bin/toodo-server"),
            listen: "127.0.0.1:47616".parse().unwrap(),
            data_dir: Path::new("/Users/a/.local/share/toodo-server"),
            web_dir: Some(Path::new("/Users/a/.local/share/toodo-server-web")),
            path: "/Users/a/.local/bin:/opt/homebrew/bin:/usr/bin",
            log: Path::new("/Users/a/Library/Logs/toodo-server.log"),
        });
        assert_eq!(
            text,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by toodo service install; rerun it instead of editing this file. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>toodo-server</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Users/a/.local/bin/toodo-server</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>TOODO_LISTEN</key><string>127.0.0.1:47616</string>
		<key>TOODO_DATA_DIR</key><string>/Users/a/.local/share/toodo-server</string>
		<key>TOODO_WEB_DIR</key><string>/Users/a/.local/share/toodo-server-web</string>
		<key>PATH</key><string>/Users/a/.local/bin:/opt/homebrew/bin:/usr/bin</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>StandardOutPath</key>
	<string>/Users/a/Library/Logs/toodo-server.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/a/Library/Logs/toodo-server.log</string>
</dict>
</plist>
"#
        );
    }

    #[test]
    fn paths_are_escaped_and_found_again() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir(PathBuf::from("/Users/a/R&D <toodo>"));
        let text = render(&Job {
            exec: Path::new("/b/toodo-server"),
            listen: "127.0.0.1:1".parse().unwrap(),
            data_dir: data.path(),
            web_dir: None,
            path: "/b",
            log: Path::new("/l"),
        });
        assert!(text.contains("<string>/Users/a/R&amp;D &lt;toodo&gt;</string>"));
        assert!(!text.contains("TOODO_WEB_DIR"));
        let plist = dir.path().join("toodo-server.plist");
        assert!(!manages(&plist, &data));
        fs::write(&plist, &text).unwrap();
        assert!(manages(&plist, &data));
        assert!(!manages(&plist, &DataDir(PathBuf::from("/Users/a/R&D"))));
    }

    #[test]
    fn the_job_state_is_the_first_state_line() {
        let output = b"gui/501/toodo-server = {\n\tactive count = 1\n\tstate = running\n\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n";
        assert_eq!(parse_state(output), "running");
        assert_eq!(parse_state(b"\tstate = not running\n"), "not running");
        assert_eq!(parse_state(b"gui/501/toodo-server = {\n}\n"), "loaded");
    }
}
