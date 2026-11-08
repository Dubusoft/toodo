//! `toodo update`: installs the newest `@dubusoft/toodo` of an npm dist-tag and restarts
//! the server on it.
//!
//! The CLI runs from the platform package `@dubusoft/toodo-<os>-<arch>` (`bin/toodo` with
//! `package.json` one directory up), which npm installs inside `@dubusoft/toodo`.

use std::cmp::Ordering;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use super::Var;
use super::launchd;
use super::process;
use super::service;
use super::settings::{self, Bundle, DataDir};
use crate::commands::updates::{PACKAGE, channel_of, compare_versions};

const PLATFORM_PACKAGE: &str = "@dubusoft/toodo-";
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
        if channel_of(version) == "dev" {
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

/// Under `npx` the CLI runs from npm's cache, which npm may clean at any time, and no
/// `toodo` is left on `PATH`. Then this installs the same version globally and runs `args`
/// with that install instead, so the server it starts and the commands it suggests outlive
/// the cache. Returns `Ok` without doing anything when the CLI does not run from npx.
pub(super) fn leave_npx_cache(args: &[String], var: Var) -> Result<(), String> {
    let Ok(exe) = std::env::current_exe() else {
        return Ok(());
    };
    if !in_npx_cache(&exe) {
        return Ok(());
    }
    let Some(installed) = Package::of(&exe) else {
        return Ok(());
    };
    let spec = format!("{PACKAGE}@{}", installed.version);
    let rerun = format!("npx {spec} {}", args.join(" "));
    let npm = process::find_on_path("npm", var).ok_or_else(|| {
        format!(
            "npm is not on PATH; nothing was set up; add the bin directory of Node.js to PATH \
             and rerun {rerun}"
        )
    })?;
    println!(
        "npx runs toodo from npm's cache, which npm may clean; installing {spec} globally \
         first..."
    );
    let status = Command::new(&npm)
        .args(["i", "-g", &spec, "--include=optional"])
        .stdin(Stdio::null())
        .status()
        .map_err(|error| {
            format!(
                "cannot run {}: {error}; nothing was set up; check your npm and rerun {rerun}",
                npm.display()
            )
        })?;
    if !status.success() {
        return Err(format!(
            "`npm i -g {spec} --include=optional` failed ({status}); nothing was set up; fix \
             the npm error above (for EACCES, give npm a prefix you own: npm config set \
             prefix ~/.local, with ~/.local/bin on PATH) and rerun {rerun}"
        ));
    }
    let root = process::run(
        &npm.display().to_string(),
        &["root", "-g"],
        &format!("check your npm and rerun {rerun}"),
    )?;
    let global = global_cli(Path::new(root.trim()), &installed.name)
        .filter(|cli| Package::of(cli).is_some_and(|package| package.version == installed.version))
        .ok_or_else(|| {
            format!(
                "npm installed {spec}, but {} holds no {} {}; reinstall it with: npm i -g \
                 {spec} --include=optional, then run: toodo {}",
                root.trim(),
                installed.name,
                installed.version,
                args.join(" ")
            )
        })?;
    let error = Command::new(&global).args(args).exec();
    Err(format!(
        "cannot run {}: {error}; run it yourself: {} {}",
        global.display(),
        global.display(),
        args.join(" ")
    ))
}

/// Whether `exe` runs from npm's npx cache (`~/.npm/_npx/<hash>/node_modules/...`).
fn in_npx_cache(exe: &Path) -> bool {
    exe.components()
        .any(|component| component.as_os_str() == "_npx")
}

/// The CLI of the platform package `platform` in npm's global root `root`: inside
/// [`PACKAGE`], where npm puts it, else hoisted beside it.
fn global_cli(root: &Path, platform: &str) -> Option<PathBuf> {
    [
        root.join(PACKAGE).join("node_modules").join(platform),
        root.join(platform),
    ]
    .into_iter()
    .map(|dir| dir.join("bin/toodo"))
    .find(|cli| cli.is_file())
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

/// `toodo update --check`: prints whether the channel (by default the one of the installed
/// version) has a newer version, and changes nothing.
pub(super) fn check(channel: Option<Channel>, var: Var) -> Result<(), String> {
    let installed = version();
    let tag = channel.unwrap_or_else(|| Channel::of(&installed)).tag();
    let npm = process::find_on_path("npm", var).ok_or_else(|| {
        "npm is not on PATH; install Node.js with npm, or add its bin directory to PATH, \
         and rerun toodo update --check"
            .to_owned()
    })?;
    let target = published_version(&npm, &format!("{PACKAGE}@{tag}"))?;
    let option = channel.map_or_else(String::new, |_| format!(" --channel {tag}"));
    println!("{}", check_report(&installed, &target, tag, &option));
    Ok(())
}

/// What `toodo update --check` prints for the `installed` version and `target`, the one
/// on `tag`; `option` is the `--channel` option of the suggested `toodo update`.
fn check_report(installed: &str, target: &str, tag: &str, option: &str) -> String {
    match compare_versions(target, installed) {
        Some(Ordering::Greater) => format!(
            "toodo {target} is available on {tag} (installed: {installed}); install it and \
             restart the server with: toodo update{option}"
        ),
        Some(Ordering::Less) => format!(
            "toodo {installed} is newer than {target}, the version on {tag}; nothing to update"
        ),
        Some(Ordering::Equal) => format!("toodo {installed} is the newest on {tag}"),
        None if target == installed => format!("toodo {installed} is the newest on {tag}"),
        None => format!(
            "cannot tell whether {target} on {tag} is newer than the installed {installed}; \
             install it anyway with: toodo update --channel {tag} --allow-downgrade"
        ),
    }
}

/// Who runs the server, as far as an update is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Supervisor {
    Systemd,
    /// The launchd agent [`launchd::LABEL`] on macOS.
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
    let supervisor = supervisor(data, var)?;
    let running = is_running(supervisor, data);

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
        if matches!(supervisor, Supervisor::Systemd | Supervisor::Launchd) {
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
        super::agents::refresh(data, listen, var);
        return Ok(());
    }
    let restarted = restart(supervisor, &bundle, data, listen, flag, var).and_then(|()| {
        healthy(listen).map_err(|cause| format!("toodo-server does not answer: {cause}"))
    });
    match restarted {
        Ok(()) => {
            println!(
                "Updated {changed}. toodo-server restarted ({}) and answers on {}",
                describe(supervisor),
                settings::web_url(listen)
            );
            super::agents::refresh(data, listen, var);
            Ok(())
        }
        Err(cause) => Err(roll_back(
            &npm, &bin, old, supervisor, data, listen, flag, var, &changed, &cause,
        )),
    }
}

/// Installs `old` again after the server did not come back on the update `changed`
/// for `cause`, restarts the server on it, and returns the error `toodo update` reports.
#[allow(clippy::too_many_arguments)]
fn roll_back(
    npm: &Path,
    bin: &Path,
    old: &str,
    supervisor: Supervisor,
    data: &DataDir,
    listen: SocketAddr,
    flag: &str,
    var: Var,
    changed: &str,
    cause: &str,
) -> String {
    eprintln!("toodo-server did not come back after the update: {cause}");
    eprintln!("Going back to toodo {old}...");
    let spec = format!("{PACKAGE}@{old}");
    let restored = npm_install(npm, &spec)
        .and_then(|()| Bundle::beside(&bin.join("toodo")))
        .and_then(|bundle| restart(supervisor, &bundle, data, listen, flag, var))
        .and_then(|()| {
            healthy(listen).map_err(|cause| format!("toodo-server does not answer: {cause}"))
        });
    match restored {
        Ok(()) => format!(
            "updated {changed}, but the server did not come back: {cause}; went back to \
             {old}, and toodo-server answers on {} again.\n{}",
            settings::web_url(listen),
            log_hint(supervisor, flag)
        ),
        Err(again) => format!(
            "updated {changed}, but the server did not come back: {cause}; going back to {old} \
             failed too: {again}\n{}",
            recovery(supervisor, old, flag)
        ),
    }
}

/// Runs `npm i -g <spec> --include=optional`.
fn npm_install(npm: &Path, spec: &str) -> Result<(), String> {
    let status = Command::new(npm)
        .args(["i", "-g", spec, "--include=optional"])
        .stdin(Stdio::null())
        .status()
        .map_err(|error| format!("cannot run {}: {error}", npm.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "`npm i -g {spec} --include=optional` failed ({status})"
        ))
    }
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

fn supervisor(data: &DataDir, var: Var) -> Result<Supervisor, String> {
    if service::manages(&service::unit_path(var)?, data) {
        return Ok(Supervisor::Systemd);
    }
    if launchd::supported() && launchd::manages(&launchd::plist_path(var)?, data) {
        return Ok(Supervisor::Launchd);
    }
    Ok(Supervisor::PidFile)
}

fn is_running(supervisor: Supervisor, data: &DataDir) -> bool {
    match supervisor {
        Supervisor::Systemd => service::is_active(),
        Supervisor::Launchd => launchd::is_running(),
        Supervisor::PidFile => process::running_pid(data).is_some(),
    }
}

fn describe(supervisor: Supervisor) -> String {
    match supervisor {
        Supervisor::Systemd => service::UNIT_NAME.to_owned(),
        Supervisor::Launchd => format!("launchd job {}", launchd::LABEL),
        Supervisor::PidFile => "toodo start".to_owned(),
    }
}

/// Restarts the server on the files of `bundle`, and waits until it accepts connections.
fn restart(
    supervisor: Supervisor,
    bundle: &Bundle,
    data: &DataDir,
    listen: SocketAddr,
    flag: &str,
    var: Var,
) -> Result<(), String> {
    match supervisor {
        Supervisor::Systemd => {
            // The unit runs copies of the server and the web app; refresh them first.
            service::install_bundle(bundle, var)?;
            service::systemctl("restart")?;
            service::wait_until_up(listen)
        }
        Supervisor::Launchd => {
            // The job runs copies of the server and the web app; refresh them first.
            service::install_bundle(bundle, var)?;
            launchd::kickstart(true)?;
            launchd::wait_until_up(listen, var)
        }
        Supervisor::PidFile => {
            process::stop(data)?;
            process::spawn(bundle, data, listen, flag).map(drop)
        }
    }
}

/// Calls an API command without a token, which the server answers with `401`.
pub(super) fn healthy(listen: SocketAddr) -> Result<(), String> {
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

/// Where to find out why the server did not come back.
fn log_hint(supervisor: Supervisor, flag: &str) -> String {
    let more = match supervisor {
        Supervisor::Launchd => format!(" and: launchctl print gui/$(id -u)/{}", launchd::LABEL),
        Supervisor::Systemd | Supervisor::PidFile => String::new(),
    };
    format!("Find the cause with: toodo logs{flag}{more}")
}

/// What to run when the server did not come back after updating from `previous` and
/// going back to it failed too.
fn recovery(supervisor: Supervisor, previous: &str, flag: &str) -> String {
    let back = format!("npm i -g {PACKAGE}@{previous} --include=optional");
    let hint = log_hint(supervisor, flag);
    match supervisor {
        Supervisor::Systemd | Supervisor::Launchd => format!(
            "{hint}
Fix it and restart with: toodo restart{flag}
Or go back to {previous} with: {back} && toodo service install{flag}"
        ),
        Supervisor::PidFile => format!(
            "{hint}
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
    fn the_check_reports_a_newer_version_with_the_command_to_install_it() {
        assert_eq!(
            check_report("1.3.2", "1.4.0", "latest", ""),
            "toodo 1.4.0 is available on latest (installed: 1.3.2); install it and restart \
             the server with: toodo update"
        );
        assert!(
            check_report("1.3.2", "1.3.3-dev.70", "dev", " --channel dev")
                .ends_with("toodo update --channel dev")
        );
        assert_eq!(
            check_report("1.3.2", "1.3.2", "latest", ""),
            "toodo 1.3.2 is the newest on latest"
        );
        assert!(check_report("1.4.0", "1.3.2", "latest", "").contains("nothing to update"));
        assert!(check_report("1.3.2", "next", "latest", "").contains("--allow-downgrade"));
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
    fn only_a_cli_under_npx_runs_from_its_cache() {
        assert!(in_npx_cache(Path::new(
            "/home/a/.npm/_npx/0f1e/node_modules/@dubusoft/toodo-linux-x64/bin/toodo"
        )));
        assert!(!in_npx_cache(Path::new(
            "/usr/lib/node_modules/@dubusoft/toodo/node_modules/@dubusoft/toodo-linux-x64/bin/toodo"
        )));
        assert!(!in_npx_cache(Path::new("/home/a/my_npx/bin/toodo")));
    }

    #[test]
    fn the_global_cli_is_found_inside_the_package_or_hoisted() {
        let root = tempfile::tempdir().unwrap();
        let platform = "@dubusoft/toodo-linux-x64";
        assert_eq!(global_cli(root.path(), platform), None);
        let hoisted = root.path().join(platform).join("bin");
        fs::create_dir_all(&hoisted).unwrap();
        fs::write(hoisted.join("toodo"), "").unwrap();
        assert_eq!(
            global_cli(root.path(), platform),
            Some(hoisted.join("toodo"))
        );
        let nested = root
            .path()
            .join(PACKAGE)
            .join("node_modules")
            .join(platform)
            .join("bin");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("toodo"), "").unwrap();
        assert_eq!(
            global_cli(root.path(), platform),
            Some(nested.join("toodo"))
        );
    }

    #[test]
    fn the_status_code_comes_from_the_status_line() {
        assert_eq!(status_code(b"HTTP/1.1 401 Unauthorized\r\n\r\n"), Some(401));
        assert_eq!(status_code(b"HTTP/1.0 200 OK\r\n"), Some(200));
        assert_eq!(status_code(b"SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(status_code(b""), None);
    }
}
