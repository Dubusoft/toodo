//! `toodo update`: installs the newest `@dubusoft/toodo` of an npm dist-tag and restarts
//! the server on it.
//!
//! The CLI runs from the platform package `@dubusoft/toodo-<os>-<arch>` (`bin/toodo` with
//! `package.json` one directory up), which npm installs inside `@dubusoft/toodo`.

use std::cmp::Ordering;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use super::Var;
use super::process;
use super::service;
use super::settings::{self, Bundle, DataDir};

const PACKAGE: &str = "@dubusoft/toodo";
const PLATFORM_PACKAGE: &str = "@dubusoft/toodo-";
/// The launchd job the server runs as on macOS, when one is set up.
const LAUNCHD_LABEL: &str = "toodo-server";
/// The API command the health check calls, as `scripts/install-server.sh` does.
const HEALTH_PATH: &str = "/api/rpc/list_tasks";

/// An npm dist-tag of [`PACKAGE`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Channel {
    /// `X.Y.Z-dev.N` prereleases built from the `dev` branch.
    Dev,
    Latest,
}

impl Channel {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "dev" => Some(Self::Dev),
            "latest" => Some(Self::Latest),
            _ => None,
        }
    }

    fn tag(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Latest => "latest",
        }
    }

    /// The channel an installed `version` follows: prereleases come from `dev`.
    fn of(version: &str) -> Self {
        if version.contains('-') {
            Self::Dev
        } else {
            Self::Latest
        }
    }
}

/// The platform package this CLI runs from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Package {
    /// Its directory, holding `package.json` and `bin/`.
    pub dir: PathBuf,
    pub name: String,
    pub version: String,
}

impl Package {
    /// The package of the CLI at `exe` (`<package>/bin/toodo`), when it came from npm.
    pub fn of(exe: &Path) -> Option<Self> {
        let dir = exe.parent()?.parent()?.to_path_buf();
        let text = fs::read_to_string(dir.join("package.json")).ok()?;
        let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
        let name = manifest.get("name")?.as_str()?.to_owned();
        if !name.starts_with(PLATFORM_PACKAGE) {
            return None;
        }
        let version = manifest.get("version")?.as_str()?.to_owned();
        Some(Self { dir, name, version })
    }
}

/// The version `toodo --version` prints: the npm package's when the CLI came from npm,
/// else the version of the build.
pub(super) fn version() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| Package::of(&exe))
        .map_or_else(
            || env!("TOODO_VERSION").to_owned(),
            |package| package.version,
        )
}

/// Who runs the server, as far as an update is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Runner {
    Systemd,
    /// The launchd job [`LAUNCHD_LABEL`] on macOS.
    Launchd,
    /// `toodo start`, with a pid file.
    PidFile,
}

/// `toodo update`. `data` is the data directory whose server is restarted, `flag` its
/// `--data-dir` option for the commands it suggests. A channel version older than the
/// installed one is installed only with `allow_downgrade`.
pub(super) fn update(
    channel: Option<Channel>,
    allow_downgrade: bool,
    data: &DataDir,
    flag: &str,
    var: Var,
) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| {
        format!(
            "cannot tell where toodo is installed: {error}; update it with: \
             npm i -g {PACKAGE} --include=optional"
        )
    })?;
    let installed = Package::of(&exe).ok_or_else(|| {
        format!(
            "{} is not from the npm package {PACKAGE}, so toodo update cannot update it; \
             install the npm package with: npm i -g {PACKAGE} --include=optional, or rebuild \
             your checkout and rerun scripts/install-server.sh (docs/server.md)",
            exe.display()
        )
    })?;
    // npm replaces the package directory, so the new bundle is found at the same path.
    let bin = exe.parent().unwrap_or(Path::new("/")).to_path_buf();
    let channel = channel.unwrap_or_else(|| Channel::of(&installed.version));
    let tag = channel.tag();

    let npm = process::find_on_path("npm", var).ok_or_else(|| {
        "npm is not on PATH; install Node.js with npm, or add its bin directory to PATH, \
         and rerun toodo update"
            .to_owned()
    })?;
    check_global_root(&npm, &installed.dir)?;

    let listen = settings::listen(data)?;
    let runner = runner(data, var)?;
    let running = is_running(runner, data);

    let old = &installed.version;
    let target = published_version(&npm, &format!("{PACKAGE}@{tag}"))?;
    let order = compare_versions(&target, old);
    if &target == old || order == Some(Ordering::Equal) {
        println!("toodo {old} is the newest on {tag}; nothing to update.");
        return Ok(());
    }
    let downgrade = order != Some(Ordering::Greater);
    if downgrade && !allow_downgrade {
        let anyway = format!("toodo update --channel {tag} --allow-downgrade{flag}");
        if order.is_none() {
            return Err(format!(
                "cannot tell whether {target} on {tag} is newer than the installed {old}; \
                 nothing changed; to install {target} anyway, run: {anyway}"
            ));
        }
        println!(
            "toodo {old} is newer than {target}, the version on {tag}; nothing changed. \
             To install {target} anyway, run: {anyway}"
        );
        return Ok(());
    }
    // npm publishes the platform packages after the main one; without its platform
    // package npm would remove the installed one and leave no toodo to run.
    let platform = format!("{}@{target}", installed.name);
    if published_version(&npm, &platform).ok().as_ref() != Some(&target) {
        return Err(format!(
            "{PACKAGE}@{target} is on {tag}, but {platform} is not on npm yet; nothing \
             changed and toodo-server keeps running {old}; rerun toodo update in a few minutes"
        ));
    }
    let spec = format!("{PACKAGE}@{target}");

    let verb = if downgrade { "Downgrading" } else { "Updating" };
    println!("{verb} toodo {old} to {target} ({PACKAGE}@{tag})...");
    let status = Command::new(&npm)
        .args(["i", "-g", &spec, "--include=optional"])
        .stdin(Stdio::null())
        .status()
        .map_err(|error| {
            format!(
                "cannot run {}: {error}; nothing changed, and toodo-server keeps running {}; \
                 check your npm and rerun toodo update",
                npm.display(),
                installed.version
            )
        })?;
    if !status.success() {
        return Err(format!(
            "`npm i -g {spec} --include=optional` failed ({status}); toodo-server was not \
             restarted and keeps running {}; fix the npm error above and rerun toodo update",
            installed.version
        ));
    }

    let new = Package::of(&bin.join("toodo")).ok_or_else(|| {
        format!(
            "npm finished, but {} holds no {PACKAGE} platform package any more; toodo-server \
             was not restarted and keeps running {old}; go back to it with: npm i -g \
             {PACKAGE}@{old} --include=optional",
            installed.dir.display()
        )
    })?;
    let bundle = Bundle::beside(&bin.join("toodo"))?;
    let changed = format!("toodo {} -> {}", installed.version, new.version);

    if !running {
        // The unit runs copies of the server and the web app, so `toodo start` would
        // start the old version unless they are refreshed now.
        if runner == Runner::Systemd {
            service::install_bundle(&bundle, var).map_err(|cause| {
                format!(
                    "updated {changed}, but the service still has the old server: {cause}; \
                     install the new one with: toodo service install{flag}"
                )
            })?;
        }
        println!(
            "Updated {changed}. toodo-server is not running; start it with: toodo start{flag}"
        );
        return Ok(());
    }
    let restarted = restart(runner, &bundle, data, listen, flag, var).and_then(|()| {
        healthy(listen).map_err(|cause| format!("toodo-server does not answer: {cause}"))
    });
    match restarted {
        Ok(()) => {
            println!(
                "Updated {changed}. toodo-server restarted ({}) and answers on {}",
                describe(runner),
                settings::web_url(listen)
            );
            Ok(())
        }
        Err(cause) => Err(format!(
            "updated {changed}, but the server did not come back: {cause}\n{}",
            recovery(runner, &installed.version, flag)
        )),
    }
}

/// How `version` compares with `installed` by semver precedence (build metadata is
/// ignored), or `None` when either is not a semver version.
fn compare_versions(version: &str, installed: &str) -> Option<Ordering> {
    let version = semver::Version::parse(version).ok()?;
    let installed = semver::Version::parse(installed).ok()?;
    Some(version.cmp_precedence(&installed))
}

/// The version npm resolves `spec` (`name@tag` or `name@version`) to.
fn published_version(npm: &Path, spec: &str) -> Result<String, String> {
    let output = process::run(
        &npm.display().to_string(),
        &["view", spec, "version"],
        "nothing changed; check your network and npm registry, then rerun toodo update",
    )?;
    match output.trim() {
        "" => Err(format!(
            "npm knows no {spec}; nothing changed; pick another channel with: toodo update \
             --channel dev|latest"
        )),
        version => Ok(version.to_owned()),
    }
}

/// Fails unless npm's global packages are where this CLI is installed: otherwise npm
/// would update another copy.
fn check_global_root(npm: &Path, package: &Path) -> Result<(), String> {
    let output = process::run(
        &npm.display().to_string(),
        &["root", "-g"],
        "check your npm and rerun toodo update",
    )?;
    let root = PathBuf::from(output.trim());
    let canonical = |path: &Path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if canonical(package).starts_with(canonical(&root)) {
        return Ok(());
    }
    let ours = install_root(package).map_or_else(
        || package.display().to_string(),
        |root| root.display().to_string(),
    );
    Err(format!(
        "npm installs global packages in {}, but this toodo is installed in {ours}; nothing \
         changed. Run the toodo of that npm (`$(npm prefix -g)/bin/toodo update`), or point npm \
         at this install with: npm_config_prefix=<the prefix of {ours}> toodo update",
        root.display()
    ))
}

/// The outermost `node_modules` directory above `package`: npm's global root that holds it.
fn install_root(package: &Path) -> Option<&Path> {
    package
        .ancestors()
        .filter(|dir| dir.file_name().is_some_and(|name| name == "node_modules"))
        .last()
}

fn launchd_plist(var: Var) -> Result<PathBuf, String> {
    Ok(settings::home(var)?
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist")))
}

fn runner(data: &DataDir, var: Var) -> Result<Runner, String> {
    if service::manages(&service::unit_path(var)?, data) {
        return Ok(Runner::Systemd);
    }
    if cfg!(target_os = "macos") && launchd_plist(var)?.is_file() {
        return Ok(Runner::Launchd);
    }
    Ok(Runner::PidFile)
}

fn launchd_target() -> Result<String, String> {
    let uid = process::run("id", &["-u"], "rerun toodo update")?;
    Ok(format!("gui/{}/{LAUNCHD_LABEL}", uid.trim()))
}

fn is_running(runner: Runner, data: &DataDir) -> bool {
    match runner {
        Runner::Systemd => service::is_active(),
        Runner::Launchd => {
            launchd_target().is_ok_and(|target| process::succeeds("launchctl", &["print", &target]))
        }
        Runner::PidFile => process::running_pid(data).is_some(),
    }
}

fn describe(runner: Runner) -> String {
    match runner {
        Runner::Systemd => service::UNIT_NAME.to_owned(),
        Runner::Launchd => format!("launchd job {LAUNCHD_LABEL}"),
        Runner::PidFile => "toodo start".to_owned(),
    }
}

/// Restarts the server on the files of `bundle`, and waits until it accepts connections.
fn restart(
    runner: Runner,
    bundle: &Bundle,
    data: &DataDir,
    listen: SocketAddr,
    flag: &str,
    var: Var,
) -> Result<(), String> {
    match runner {
        Runner::Systemd => {
            // The unit runs copies of the server and the web app; refresh them first.
            service::install_bundle(bundle, var)?;
            service::systemctl("restart")?;
            service::wait_until_up(listen)
        }
        Runner::Launchd => {
            let target = launchd_target()?;
            process::run(
                "launchctl",
                &["kickstart", "-k", &target],
                &format!("check the job with: launchctl print {target}"),
            )?;
            match process::wait_until_up(listen, || None) {
                process::Wait::Up => Ok(()),
                _ => Err(format!(
                    "{target} did not accept connections on {listen} in time"
                )),
            }
        }
        Runner::PidFile => {
            process::stop(data)?;
            process::spawn(bundle, data, listen, flag).map(drop)
        }
    }
}

/// Calls an API command without a token, which the server answers with `401`.
fn healthy(listen: SocketAddr) -> Result<(), String> {
    let address = settings::local_address(listen);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|error| format!("cannot connect to {address}: {error}"))?;
    let timeout = Some(Duration::from_secs(10));
    drop(stream.set_read_timeout(timeout));
    drop(stream.set_write_timeout(timeout));
    let request = format!(
        "POST {HEALTH_PATH} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\n\
         Content-Length: 2\r\nConnection: close\r\n\r\n{{}}"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("cannot send a request to {address}: {error}"))?;
    let mut response = Vec::new();
    drop(stream.take(4096).read_to_end(&mut response));
    match status_code(&response) {
        Some(401) => Ok(()),
        Some(code) => Err(format!(
            "POST http://{address}{HEALTH_PATH} without a token answered {code} instead of 401"
        )),
        None => Err(format!(
            "POST http://{address}{HEALTH_PATH} got no HTTP response"
        )),
    }
}

fn status_code(response: &[u8]) -> Option<u16> {
    let text = String::from_utf8_lossy(response);
    let line = text.lines().next()?;
    let mut parts = line.split(' ');
    parts.next()?.starts_with("HTTP/").then_some(())?;
    parts.next()?.parse().ok()
}

/// What to run when the server did not come back after updating from `previous`.
fn recovery(runner: Runner, previous: &str, flag: &str) -> String {
    let back = format!("npm i -g {PACKAGE}@{previous} --include=optional");
    match runner {
        Runner::Systemd => format!(
            "Find the cause with: journalctl --user -u toodo-server -n 50
Fix it and restart with: systemctl --user restart {unit}
Or go back to {previous} with: {back} && toodo service install{flag}",
            unit = service::UNIT_NAME
        ),
        Runner::Launchd => format!(
            "Find the cause with: launchctl print gui/$(id -u)/{LAUNCHD_LABEL}
Fix it and restart with: launchctl kickstart -k gui/$(id -u)/{LAUNCHD_LABEL}
Or go back to {previous} with: {back}, then restart it the same way"
        ),
        Runner::PidFile => format!(
            "Find the cause in the server log: toodo status{flag} shows where it is
Fix it and start it with: toodo start{flag}
Or go back to {previous} with: {back} && toodo start{flag}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prereleases_follow_dev_and_releases_latest() {
        assert_eq!(Channel::of("1.3.2-dev.9"), Channel::Dev);
        assert_eq!(Channel::of("1.3.1"), Channel::Latest);
        assert_eq!(Channel::parse("dev"), Some(Channel::Dev));
        assert_eq!(Channel::parse("latest"), Some(Channel::Latest));
        assert_eq!(Channel::parse("beta"), None);
    }

    #[test]
    fn versions_compare_by_semver_precedence() {
        assert_eq!(
            compare_versions("1.3.2-dev.1", "1.3.2-dev.8"),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_versions("1.3.2-dev.11", "1.3.2-dev.9"),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare_versions("1.3.2", "1.3.2-dev.11"),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare_versions("1.3.1", "1.3.2-dev.1"),
            Some(Ordering::Less)
        );
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Some(Ordering::Greater));
        assert_eq!(compare_versions("1.3.1+b", "1.3.1"), Some(Ordering::Equal));
        assert_eq!(compare_versions("next", "1.3.1"), None);
    }

    #[test]
    fn only_a_platform_package_gives_the_version() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("toodo-linux-x64");
        let exe = package.join("bin/toodo");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        assert_eq!(Package::of(&exe), None);
        fs::write(
            package.join("package.json"),
            r#"{"name":"some-other-package","version":"9.9.9"}"#,
        )
        .unwrap();
        assert_eq!(Package::of(&exe), None);
        fs::write(
            package.join("package.json"),
            r#"{"name":"@dubusoft/toodo-linux-x64","version":"1.3.2-dev.9"}"#,
        )
        .unwrap();
        assert_eq!(
            Package::of(&exe),
            Some(Package {
                dir: package,
                name: "@dubusoft/toodo-linux-x64".to_owned(),
                version: "1.3.2-dev.9".to_owned()
            })
        );
    }

    #[test]
    fn the_install_root_is_the_outermost_node_modules() {
        let package =
            Path::new("/p/lib/node_modules/@dubusoft/toodo/node_modules/@dubusoft/toodo-linux-x64");
        assert_eq!(
            install_root(package),
            Some(Path::new("/p/lib/node_modules"))
        );
        assert_eq!(install_root(Path::new("/opt/toodo")), None);
    }

    #[test]
    fn the_status_code_comes_from_the_status_line() {
        assert_eq!(status_code(b"HTTP/1.1 401 Unauthorized\r\n\r\n"), Some(401));
        assert_eq!(status_code(b"HTTP/1.0 200 OK\r\n"), Some(200));
        assert_eq!(status_code(b"SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(status_code(b""), None);
    }
}
