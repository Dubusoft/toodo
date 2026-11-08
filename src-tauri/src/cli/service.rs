//! The systemd user service `toodo-server.service`, in the layout
//! `scripts/install-server.sh` installs: `~/.local/bin/toodo-server`, the web app in
//! `$XDG_DATA_HOME/toodo-server-web`, and the unit in `~/.config/systemd/user`.

use std::fs;
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::Var;
use super::process::{self, Wait};
use super::settings::{self, Bundle, DataDir};

pub(super) const UNIT_NAME: &str = "toodo-server.service";

const JOURNAL_HINT: &str = "see: journalctl --user -u toodo-server";

pub(super) fn unit_path(var: Var) -> Result<PathBuf, String> {
    Ok(settings::config_home(var)?
        .join("systemd/user")
        .join(UNIT_NAME))
}

/// Whether the unit at `unit` exists and runs the server of `data`; the server of another
/// data directory is left to `toodo start`.
pub(super) fn manages(unit: &Path, data: &DataDir) -> bool {
    let wanted = format!("Environment=TOODO_DATA_DIR={}", data.path().display());
    fs::read_to_string(unit).is_ok_and(|text| text.lines().any(|line| line.trim() == wanted))
}

/// The state `systemctl --user is-active` reports: `active`, `inactive`, `failed`, ...
pub(super) fn state() -> String {
    match process::output("systemctl", &["--user", "is-active", UNIT_NAME]) {
        Ok(output) => parse_state(&output.stdout),
        Err(_) => "unknown (systemctl did not run)".to_owned(),
    }
}

/// The state in the output of `systemctl is-active`; it prints nothing for a unit that
/// was never loaded, which is `inactive`.
fn parse_state(stdout: &[u8]) -> String {
    let text = String::from_utf8_lossy(stdout);
    match text.trim() {
        "" => "inactive".to_owned(),
        state => state.to_owned(),
    }
}

pub(super) fn is_active() -> bool {
    state() == "active"
}

pub(super) fn systemctl(action: &str) -> Result<(), String> {
    process::run(
        "systemctl",
        &["--user", action, UNIT_NAME],
        &format!("check the service with: systemctl --user status {UNIT_NAME}"),
    )
    .map(drop)
}

/// Waits until the service accepts connections on `listen`.
pub(super) fn wait_until_up(listen: SocketAddr) -> Result<(), String> {
    match process::wait_until_up(listen, || {
        (!is_active()).then(|| format!("{UNIT_NAME} is {}", state()))
    }) {
        Wait::Up => Ok(()),
        Wait::Exited(reason) => Err(format!(
            "{reason} and did not accept connections on {listen}; {JOURNAL_HINT}"
        )),
        Wait::TimedOut => Err(format!(
            "{UNIT_NAME} did not accept connections on {listen} in time; {JOURNAL_HINT}"
        )),
    }
}

/// What the unit runs.
pub(super) struct Unit<'a> {
    pub exec: &'a Path,
    pub listen: SocketAddr,
    pub data_dir: &'a Path,
    pub web_dir: Option<&'a Path>,
    /// `PATH` for the service, see [`service_path`].
    pub path: &'a str,
}

/// The unit file. A server that keeps failing to start is restarted at most 5 times in
/// 5 minutes, then left failed.
pub(super) fn render(unit: &Unit) -> String {
    let mut text = format!(
        "# Written by toodo service install; rerun it instead of editing this file.
[Unit]
Description=Toodo server
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart={}
Environment=TOODO_LISTEN={}
Environment=TOODO_DATA_DIR={}
",
        unit.exec.display(),
        unit.listen,
        unit.data_dir.display()
    );
    if let Some(web) = unit.web_dir {
        text.push_str(&format!("Environment=TOODO_WEB_DIR={}\n", web.display()));
    }
    text.push_str(&format!(
        "Environment=PATH={}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
",
        unit.path
    ));
    text
}

/// `PATH` for the service: `bin_dir`, then the system directories, each once. The server
/// runs no other programs, so it needs nothing else.
pub(super) fn service_path(bin_dir: &Path) -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let candidates = std::iter::once(bin_dir.to_path_buf())
        .chain(["/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    for dir in candidates {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.iter()
        .map(|dir| dir.display().to_string())
        .collect::<Vec<_>>()
        .join(":")
}

/// [`service_path`] for the `~/.local/bin` the server is copied to.
pub(super) fn service_path_now(var: Var) -> Result<String, String> {
    let bin_dir = settings::home(var)?.join(".local/bin");
    Ok(service_path(&bin_dir))
}

/// `toodo service install`.
pub(super) fn install(data: &DataDir, listen: SocketAddr, var: Var) -> Result<(), String> {
    if process::find_on_path("systemctl", var).is_none() {
        return Err(
            "systemctl is not on PATH, so there is no systemd to run the service; \
             run the server with: toodo start"
                .to_owned(),
        );
    }
    if !process::succeeds("systemctl", &["--user", "show-environment"]) {
        let user = user(var).unwrap_or_else(|| "$USER".to_owned());
        return Err(format!(
            "no systemd user manager runs for this user (systemctl --user show-environment \
             failed); log in through a session, or run 'sudo loginctl enable-linger {user}', \
             then rerun toodo service install; or run the server with: toodo start"
        ));
    }
    let bundle = Bundle::find()?;

    if process::stop(data)? {
        println!("Stopped the toodo-server started by toodo start; the service replaces it.");
    }

    let (server, web_dir) = install_bundle(&bundle, var)?;

    let path = service_path_now(var)?;
    let text = render(&Unit {
        exec: &server,
        listen,
        data_dir: data.path(),
        web_dir: web_dir.as_deref(),
        path: &path,
    });
    let unit = unit_path(var)?;
    write_atomically(&unit, text.as_bytes(), 0o644)?;
    println!("Wrote {}", unit.display());

    process::run(
        "systemctl",
        &["--user", "daemon-reload"],
        &format!("check {} and rerun toodo service install", unit.display()),
    )?;
    systemctl("enable")?;
    systemctl("restart")?;
    wait_until_up(listen)?;
    println!("{UNIT_NAME} is running on {}", settings::web_url(listen));
    if let Some(user) = user(var) {
        enable_linger(&user);
    }
    println!("Logs: journalctl --user -u toodo-server");
    Ok(())
}

/// Turns lingering on for `user`, so the service keeps running after they log out;
/// systemd lets users do that for themselves unless a policy requires an admin.
fn enable_linger(user: &str) {
    let linger = process::output("loginctl", &["show-user", user, "-p", "Linger", "--value"])
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
    if linger.as_deref() == Some("yes") {
        return;
    }
    if process::succeeds("loginctl", &["enable-linger", user]) {
        println!("Turned on lingering for {user}, so the service keeps running after logout.");
    } else {
        println!(
            "note: lingering is off and loginctl enable-linger {user} failed, so the service \
             stops when you log out; keep it running with: sudo loginctl enable-linger {user}"
        );
    }
}

/// Copies the server and the web app of `bundle` to where the unit runs them from:
/// `~/.local/bin/toodo-server` and `$XDG_DATA_HOME/toodo-server-web`. Returns both paths.
pub(super) fn install_bundle(
    bundle: &Bundle,
    var: Var,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    let bin_dir = settings::home(var)?.join(".local/bin");
    let share_dir = settings::data_home(var)?;
    let server = install_file(&bundle.server, &bin_dir, "toodo-server")?;
    println!("Installed {}", server.display());
    let web_dir = match &bundle.web {
        Some(web) => {
            let dir = install_dir(web, &share_dir, "toodo-server-web")?;
            println!("Installed the web app in {}", dir.display());
            Some(dir)
        }
        None => {
            println!(
                "No web app at {}; the service serves the API and MCP only.",
                bundle.web_location().display()
            );
            None
        }
    };
    Ok((server, web_dir))
}

fn user(var: Var) -> Option<String> {
    var("USER")
        .or_else(|| var("LOGNAME"))
        .filter(|user| !user.is_empty())
}

/// Copies `source` to `dir/name` through a temporary file and a rename.
fn install_file(source: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    let bytes = fs::read(source).map_err(|error| {
        format!(
            "cannot read {}: {error}; reinstall the CLI with: npm install -g @dubusoft/toodo",
            source.display()
        )
    })?;
    let target = dir.join(name);
    write_atomically(&target, &bytes, 0o755)?;
    Ok(target)
}

/// Writes `bytes` to `target` with `mode` through a temporary file and a rename.
pub(super) fn write_atomically(target: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let dir = target.parent().unwrap_or(Path::new("/"));
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let temporary = dir.join(format!(".{name}.{}", std::process::id()));
    let failed = |error: std::io::Error| {
        format!(
            "cannot write {}: {error}; check the permissions of {} and rerun",
            target.display(),
            dir.display()
        )
    };
    fs::create_dir_all(dir).map_err(failed)?;
    fs::write(&temporary, bytes).map_err(failed)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(mode)).map_err(failed)?;
    fs::rename(&temporary, target).map_err(failed)
}

/// Copies the directory `source` to `parent/name`, replacing an existing one, through a
/// temporary directory and renames.
fn install_dir(source: &Path, parent: &Path, name: &str) -> Result<PathBuf, String> {
    let target = parent.join(name);
    let pid = std::process::id();
    let temporary = parent.join(format!(".{name}.{pid}"));
    let old = parent.join(format!(".{name}.old.{pid}"));
    let failed = |error: std::io::Error| {
        format!(
            "cannot install {}: {error}; check the permissions of {} and rerun",
            target.display(),
            parent.display()
        )
    };
    fs::create_dir_all(parent).map_err(failed)?;
    drop(fs::remove_dir_all(&temporary));
    copy_dir(source, &temporary).map_err(failed)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755)).map_err(failed)?;
    if target.exists() {
        drop(fs::remove_dir_all(&old));
        fs::rename(&target, &old).map_err(failed)?;
        fs::rename(&temporary, &target).map_err(failed)?;
        drop(fs::remove_dir_all(&old));
    } else {
        fs::rename(&temporary, &target).map_err(failed)?;
    }
    Ok(target)
}

fn copy_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let to = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unit_runs_the_server_with_a_start_limit() {
        let text = render(&Unit {
            exec: Path::new("/home/a/.local/bin/toodo-server"),
            listen: "127.0.0.1:47616".parse().unwrap(),
            data_dir: Path::new("/home/a/.local/share/toodo-server"),
            web_dir: Some(Path::new("/home/a/.local/share/toodo-server-web")),
            path: "/home/a/.local/bin:/usr/bin",
        });
        assert_eq!(
            text,
            "# Written by toodo service install; rerun it instead of editing this file.
[Unit]
Description=Toodo server
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart=/home/a/.local/bin/toodo-server
Environment=TOODO_LISTEN=127.0.0.1:47616
Environment=TOODO_DATA_DIR=/home/a/.local/share/toodo-server
Environment=TOODO_WEB_DIR=/home/a/.local/share/toodo-server-web
Environment=PATH=/home/a/.local/bin:/usr/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"
        );
    }

    #[test]
    fn a_blank_is_active_output_is_inactive() {
        assert_eq!(parse_state(b""), "inactive");
        assert_eq!(parse_state(b"\n"), "inactive");
        assert_eq!(parse_state(b"failed\n"), "failed");
    }

    #[test]
    fn a_unit_without_a_web_app_sets_no_web_dir() {
        let text = render(&Unit {
            exec: Path::new("/b/toodo-server"),
            listen: "0.0.0.0:1".parse().unwrap(),
            data_dir: Path::new("/d"),
            web_dir: None,
            path: "/b",
        });
        assert!(!text.contains("TOODO_WEB_DIR"));
        assert!(text.contains("Environment=TOODO_LISTEN=0.0.0.0:1\n"));
    }

    #[test]
    fn the_service_path_lists_each_directory_once_in_order() {
        assert_eq!(
            service_path(Path::new("/home/a/.local/bin")),
            "/home/a/.local/bin:/usr/local/bin:/usr/bin:/bin"
        );
        assert_eq!(
            service_path(Path::new("/usr/bin")),
            "/usr/bin:/usr/local/bin:/bin"
        );
    }

    #[test]
    fn only_a_unit_for_the_same_data_dir_manages_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let unit = dir.path().join(UNIT_NAME);
        let data = DataDir(PathBuf::from("/d/one"));
        assert!(!manages(&unit, &data));
        fs::write(&unit, "[Service]\nEnvironment=TOODO_DATA_DIR=/d/one\n").unwrap();
        assert!(manages(&unit, &data));
        assert!(!manages(&unit, &DataDir(PathBuf::from("/d/other"))));
    }

    #[test]
    fn a_directory_is_installed_over_an_existing_one() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("web");
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("index.html"), "new").unwrap();
        fs::write(source.join("assets/app.js"), "js").unwrap();
        let share = dir.path().join("share");
        fs::create_dir_all(share.join("toodo-server-web")).unwrap();
        fs::write(share.join("toodo-server-web/stale.html"), "old").unwrap();
        let target = install_dir(&source, &share, "toodo-server-web").unwrap();
        assert_eq!(
            fs::read_to_string(target.join("index.html")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(target.join("assets/app.js")).unwrap(),
            "js"
        );
        assert!(!target.join("stale.html").exists());
        let names: Vec<_> = fs::read_dir(&share)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["toodo-server-web"]);
    }
}
