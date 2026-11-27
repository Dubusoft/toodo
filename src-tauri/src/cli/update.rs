//! `toodo update`: installs the newest Toodo of a channel and restarts the server on it,
//! from npm (`@dubusoft/toodo` and its dist-tags) or from GitHub releases (a release
//! install, see [`release`]).
//!
//! From npm, the CLI runs from the platform package `@dubusoft/toodo-<os>-<arch>`
//! (`bin/toodo` with `package.json` one directory up), which npm installs inside
//! `@dubusoft/toodo`.

use std::cmp::Ordering;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use super::Var;
use super::launchd;
use super::process;
use super::release;
use super::service;
use super::settings::{self, Bundle, DataDir};
use crate::commands::updates::{PACKAGE, channel_of, compare_versions};

const PLATFORM_PACKAGE: &str = "@dubusoft/toodo-";
/// The API command the health check calls, as `scripts/install-server.sh` does.
const HEALTH_PATH: &str = "/api/rpc/list_tasks";
/// How long `npm view` and `npm root -g` get before they are stopped.
const NPM_QUERY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long `npm i -g` gets before it is stopped: a download of every platform package on
/// a slow link, with room to spare.
const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long a server that accepts connections gets to answer an API command.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_RETRY: Duration = Duration::from_millis(250);

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

/// Where `toodo update` gets new versions from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Source {
    /// The npm package [`PACKAGE`] and its dist-tags.
    Npm,
    /// The release assets of a GitHub repository, see [`release`].
    Github,
}

impl Source {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "npm" => Some(Self::Npm),
            "github" => Some(Self::Github),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Github => "github",
        }
    }

    /// Where the CLI at `exe` updates from: GitHub for a release install, else npm.
    fn of(exe: &Path) -> Self {
        if release::Install::of(exe).is_some() {
            Self::Github
        } else {
            Self::Npm
        }
    }
}

/// The running CLI, with links resolved: a release install is run through
/// `~/.local/bin/toodo`.
fn installed_exe() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    Ok(fs::canonicalize(&exe).unwrap_or(exe))
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
    npm_install(&npm, &spec).map_err(|cause| {
        format!(
            "{cause}; nothing was set up; fix the npm error above (for EACCES, give npm a \
             prefix you own: npm config set prefix ~/.local, with ~/.local/bin on PATH) and \
             rerun {rerun}"
        )
    })?;
    let root = process::run_within(
        &npm.display().to_string(),
        &["root", "-g"],
        NPM_QUERY_TIMEOUT,
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
/// version) of `source` (by default where the CLI came from) has a newer version, and
/// changes nothing.
pub(super) fn check(
    channel: Option<Channel>,
    source: Option<Source>,
    var: Var,
) -> Result<(), String> {
    let installed = version();
    let tag = channel.unwrap_or_else(|| Channel::of(&installed)).tag();
    let exe = installed_exe().ok();
    let target = match source.unwrap_or_else(|| exe.as_deref().map_or(Source::Npm, Source::of)) {
        Source::Npm => {
            let npm = process::find_on_path("npm", var).ok_or_else(|| {
                "npm is not on PATH; install Node.js with npm, or add its bin directory to \
                 PATH, and rerun toodo update --check"
                    .to_owned()
            })?;
            published_version(&npm, &format!("{PACKAGE}@{tag}"))?
        }
        Source::Github => {
            let install = exe.as_deref().and_then(release::Install::of);
            release::Github::new(install.as_ref().map(|install| install.repo.as_str()), var)
                .newest(tag, &release::platform())?
                .version
        }
    };
    let mut option = channel.map_or_else(String::new, |_| format!(" --channel {tag}"));
    if let Some(source) = source {
        option.push_str(&format!(" --source {}", source.name()));
    }
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
/// `--data-dir` option for the commands it suggests. `source` defaults to where the CLI
/// came from: GitHub releases for a release install, else npm. A channel version older
/// than the installed one is installed only with `allow_downgrade`.
pub(super) fn update(
    channel: Option<Channel>,
    source: Option<Source>,
    allow_downgrade: bool,
    data: &DataDir,
    flag: &str,
    var: Var,
) -> Result<(), String> {
    let exe = installed_exe().map_err(|error| {
        format!(
            "cannot tell where toodo is installed: {error}; update it with: \
             npm i -g {PACKAGE} --include=optional"
        )
    })?;
    match source.unwrap_or_else(|| Source::of(&exe)) {
        Source::Npm => update_from_npm(&exe, channel, allow_downgrade, data, flag, var),
        Source::Github => update_from_github(&exe, channel, allow_downgrade, data, flag, var),
    }
}

fn update_from_npm(
    exe: &Path,
    channel: Option<Channel>,
    allow_downgrade: bool,
    data: &DataDir,
    flag: &str,
    var: Var,
) -> Result<(), String> {
    let installed = Package::of(exe).ok_or_else(|| {
        format!(
            "{} is not from the npm package {PACKAGE}, so toodo update cannot update it with \
             npm; install it from GitHub releases with: toodo update --source github, \
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

    let server = Server::of(data, flag, var)?;
    let running = is_running(server.supervisor, data);

    let old = &installed.version;
    let target = published_version(&npm, &format!("{PACKAGE}@{tag}"))?;
    let rerun = format!("toodo update --channel {tag} --allow-downgrade{flag}");
    let Some(downgrade) = plan(old, &target, tag, allow_downgrade, &rerun, false)? else {
        return Ok(());
    };
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
    npm_install(&npm, &spec).map_err(|cause| {
        format!(
            "{cause}; toodo-server was not restarted and keeps running {old}; fix the npm \
             error above and rerun toodo update, or go back to {old} with: npm i -g \
             {PACKAGE}@{old} --include=optional"
        )
    })?;

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
    settle(&server, running, &bundle, &changed).map_err(|failure| match failure {
        Settle::Failed(error) => error,
        Settle::NotUp(cause) => {
            let back = format!("npm i -g {PACKAGE}@{old} --include=optional");
            let restore = || {
                npm_install(&npm, &format!("{PACKAGE}@{old}"))
                    .and_then(|()| Bundle::beside(&bin.join("toodo")))
            };
            roll_back(&server, old, &changed, &cause, restore, Some(&back))
        }
    })
}

/// Updates the release install from GitHub releases, or replaces an install from npm or
/// a checkout (the CLI at `exe`) with one.
fn update_from_github(
    exe: &Path,
    channel: Option<Channel>,
    allow_downgrade: bool,
    data: &DataDir,
    flag: &str,
    var: Var,
) -> Result<(), String> {
    let install = release::Install::of(exe);
    let old = version();
    let channel = channel.unwrap_or_else(|| Channel::of(&old));
    let tag = channel.tag();
    let github = release::Github::new(install.as_ref().map(|install| install.repo.as_str()), var);
    let dir = release::install_dir(var)?;

    let server = Server::of(data, flag, var)?;
    let running = is_running(server.supervisor, data);

    let target = github.newest(tag, &release::platform())?;
    // Moving to a release install installs the same version too.
    let switching = install.is_none();
    let rerun = format!("toodo update --channel {tag} --source github --allow-downgrade{flag}");
    let Some(downgrade) = plan(
        &old,
        &target.version,
        tag,
        allow_downgrade,
        &rerun,
        switching,
    )?
    else {
        return Ok(());
    };
    let verb = if downgrade { "Downgrading" } else { "Updating" };
    println!(
        "{verb} toodo {old} to {} (release v{} of {})...",
        target.version, target.version, github.repo
    );
    let staging = github.stage(&target, &dir)?;
    let previous = release::put_in_place(&staging, &dir)?;
    let bundle = Bundle::beside(&dir.join("bin/toodo"))?;
    let changed = format!("toodo {old} -> {}", target.version);
    let failed = match settle(&server, running, &bundle, &changed) {
        Ok(()) => None,
        Err(Settle::Failed(error)) => Some(error),
        Err(Settle::NotUp(cause)) => {
            let restore = || {
                release::restore(previous.as_deref(), &dir)?;
                Bundle::beside(exe)
            };
            return Err(roll_back(&server, &old, &changed, &cause, restore, None));
        }
    };
    release::discard(previous.as_deref());
    let link = release::link(&dir, var)?;
    if switching {
        println!(
            "toodo now updates from the GitHub releases of {}: it is installed in {} and \
             linked from {}.",
            github.repo,
            dir.display(),
            link.display()
        );
        if Package::of(exe).is_some() {
            println!("Remove the npm copy with: npm rm -g {PACKAGE}");
        }
        if let Some(found) = process::find_on_path("toodo", var).filter(|found| *found != link) {
            println!(
                "note: toodo on PATH is {}; put {} before it on PATH",
                found.display(),
                link.parent().unwrap_or(Path::new("/")).display()
            );
        }
    }
    failed.map_or(Ok(()), Err)
}

/// Whether to install `target`, the version on `tag`, over `old`: `Some(downgrade)` to
/// install it, `None` after printing why not. `rerun` is the command that installs an
/// older version anyway; with `reinstall` the same version is installed again.
fn plan(
    old: &str,
    target: &str,
    tag: &str,
    allow_downgrade: bool,
    rerun: &str,
    reinstall: bool,
) -> Result<Option<bool>, String> {
    let order = compare_versions(target, old);
    if target == old || order == Some(Ordering::Equal) {
        if reinstall {
            return Ok(Some(false));
        }
        println!("toodo {old} is the newest on {tag}; nothing to update.");
        return Ok(None);
    }
    let downgrade = order != Some(Ordering::Greater);
    if downgrade && !allow_downgrade {
        if order.is_none() {
            return Err(format!(
                "cannot tell whether {target} on {tag} is newer than the installed {old}; \
                 nothing changed; to install {target} anyway, run: {rerun}"
            ));
        }
        println!(
            "toodo {old} is newer than {target}, the version on {tag}; nothing changed. \
             To install {target} anyway, run: {rerun}"
        );
        return Ok(None);
    }
    Ok(Some(downgrade))
}

/// Why the server does not run the new version after its files were installed.
enum Settle {
    /// The server is stopped and its service still has the old files; the error says
    /// what to run.
    Failed(String),
    /// The server did not come back after the restart, for this cause.
    NotUp(String),
}

/// Puts the server on `bundle` after the update `changed`: restarts it when it is
/// `running`, else copies the new files where its service runs them from.
fn settle(server: &Server, running: bool, bundle: &Bundle, changed: &str) -> Result<(), Settle> {
    let Server {
        supervisor,
        data,
        listen,
        flag,
        var,
    } = *server;
    if !running {
        // The unit runs copies of the server and the web app, so `toodo start` would
        // start the old version unless they are refreshed now.
        if matches!(supervisor, Supervisor::Systemd | Supervisor::Launchd) {
            service::install_bundle(bundle, var).map_err(|cause| {
                Settle::Failed(format!(
                    "updated {changed}, but the service still has the old server: {cause}; \
                     install the new one with: toodo service install{flag}"
                ))
            })?;
        }
        println!(
            "Updated {changed}. toodo-server is not running; start it with: toodo start{flag}"
        );
        super::agents::refresh(data, listen, var);
        return Ok(());
    }
    server.restart(bundle).map_err(Settle::NotUp)?;
    println!(
        "Updated {changed}. toodo-server restarted ({}) and answers on {}",
        describe(supervisor),
        settings::web_url(listen)
    );
    super::agents::refresh(data, listen, var);
    Ok(())
}

/// Goes back to `old` after the server did not come back on the update `changed` for
/// `cause`: `restore` puts the files of `old` back and returns them, and the server is
/// restarted on them. Returns the error `toodo update` reports. `back` is the command
/// that installs `old` again by hand, when there is one.
fn roll_back(
    server: &Server,
    old: &str,
    changed: &str,
    cause: &str,
    restore: impl FnOnce() -> Result<Bundle, String>,
    back: Option<&str>,
) -> String {
    eprintln!("toodo-server did not come back after the update: {cause}");
    eprintln!("Going back to toodo {old}...");
    let restored = restore().and_then(|bundle| server.restart(&bundle));
    let Server {
        supervisor,
        listen,
        flag,
        ..
    } = *server;
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
            recovery(supervisor, old, flag, back)
        ),
    }
}

/// Runs `npm i -g <spec> --include=optional`, stopping it after [`NPM_INSTALL_TIMEOUT`].
fn npm_install(npm: &Path, spec: &str) -> Result<(), String> {
    npm_install_within(npm, spec, NPM_INSTALL_TIMEOUT)
}

fn npm_install_within(npm: &Path, spec: &str, limit: Duration) -> Result<(), String> {
    let status = process::status_within(npm, &["i", "-g", spec, "--include=optional"], limit)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::TimedOut => {
                format!("`npm i -g {spec} --include=optional` {error}")
            }
            _ => format!("cannot run {}: {error}", npm.display()),
        })?;
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
    let output = process::run_within(
        &npm.display().to_string(),
        &["view", spec, "version"],
        NPM_QUERY_TIMEOUT,
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
    let output = process::run_within(
        &npm.display().to_string(),
        &["root", "-g"],
        NPM_QUERY_TIMEOUT,
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

/// The server `toodo update` restarts: who runs it, its data directory, where it
/// listens, and the `--data-dir` option of the commands it suggests.
#[derive(Clone, Copy)]
struct Server<'a> {
    supervisor: Supervisor,
    data: &'a DataDir,
    listen: SocketAddr,
    flag: &'a str,
    var: Var<'a>,
}

impl<'a> Server<'a> {
    /// The server of `data`, and who runs it.
    fn of(data: &'a DataDir, flag: &'a str, var: Var<'a>) -> Result<Self, String> {
        Ok(Self {
            supervisor: supervisor(data, var)?,
            data,
            listen: settings::listen(data)?,
            flag,
            var,
        })
    }

    /// Restarts the server on the files of `bundle`, and waits until it answers.
    fn restart(&self, bundle: &Bundle) -> Result<(), String> {
        let Self {
            supervisor,
            data,
            listen,
            flag,
            var,
        } = *self;
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
        }?;
        healthy(listen).map_err(|cause| format!("toodo-server does not answer: {cause}"))
    }
}

/// Calls an API command without a token, which the server answers with `401`. A server
/// that was just restarted may accept connections before it answers (or an old process may
/// still be closing them), so this asks again until [`HEALTH_TIMEOUT`] passes.
pub(super) fn healthy(listen: SocketAddr) -> Result<(), String> {
    answers_unauthorized(settings::local_address(listen), HEALTH_TIMEOUT)
}

/// Asks `address` until it answers `401` or `timeout` passes. An answer with another status
/// ends the wait at once; the timeout error carries the cause of the last attempt.
fn answers_unauthorized(address: SocketAddr, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let cause = match status_without_token(address, deadline) {
            Ok(401) => return Ok(()),
            Ok(code) => {
                return Err(format!(
                    "POST http://{address}{HEALTH_PATH} without a token answered {code} instead \
                     of 401"
                ));
            }
            Err(cause) => cause,
        };
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!(
                "POST http://{address}{HEALTH_PATH} got no HTTP response within {timeout:?}; \
                 last attempt: {cause}"
            ));
        }
        thread::sleep(HEALTH_RETRY.min(left));
    }
}

/// The status `address` answers an API command without a token with, waiting at most until
/// `deadline`.
fn status_without_token(address: SocketAddr, deadline: Instant) -> Result<u16, String> {
    // Socket timeouts must not be zero; a spent deadline still gets a last short try.
    let left = || {
        deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1))
    };
    let mut stream = TcpStream::connect_timeout(&address, left().min(Duration::from_secs(5)))
        .map_err(|error| format!("cannot connect to {address}: {error}"))?;
    let timeout = Some(left().min(Duration::from_secs(10)));
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
    let read = stream.take(4096).read_to_end(&mut response);
    match (status_code(&response), read) {
        (Some(code), _) => Ok(code),
        (None, Err(error)) => Err(format!("cannot read the answer of {address}: {error}")),
        (None, Ok(_)) => Err(format!(
            "{address} closed the connection without an HTTP response"
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
/// going back to it failed too; `back` installs `previous` again, when there is a command
/// for it.
fn recovery(supervisor: Supervisor, previous: &str, flag: &str, back: Option<&str>) -> String {
    let hint = log_hint(supervisor, flag);
    let (fix, rerun) = match supervisor {
        Supervisor::Systemd | Supervisor::Launchd => (
            format!("Fix it and restart with: toodo restart{flag}"),
            format!("toodo service install{flag}"),
        ),
        Supervisor::PidFile => (
            format!("Fix it and start it with: toodo start{flag}"),
            format!("toodo start{flag}"),
        ),
    };
    match back {
        Some(back) => format!("{hint}\n{fix}\nOr go back to {previous} with: {back} && {rerun}"),
        None => format!("{hint}\n{fix}"),
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
    fn an_install_past_its_limit_is_stopped() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let npm = dir.path().join("npm");
        fs::write(&npm, "#!/bin/sh\nexec sleep 30\n").unwrap();
        fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.path().display().to_string();
        let var = |name: &str| (name == "PATH").then(|| path.clone());
        let npm = process::find_on_path("npm", &var).unwrap();

        let started = std::time::Instant::now();
        let error =
            npm_install_within(&npm, "@dubusoft/toodo@1.0.0", Duration::from_secs(1)).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(
            error.starts_with(
                "`npm i -g @dubusoft/toodo@1.0.0 --include=optional` did not finish within 1 s \
                 and was stopped; check that the command works"
            ),
            "{error}"
        );
    }

    #[test]
    fn the_status_code_comes_from_the_status_line() {
        assert_eq!(status_code(b"HTTP/1.1 401 Unauthorized\r\n\r\n"), Some(401));
        assert_eq!(status_code(b"HTTP/1.0 200 OK\r\n"), Some(200));
        assert_eq!(status_code(b"SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(status_code(b""), None);
    }

    /// Reads a request up to its `{}` body, so that closing the connection sends no reset.
    fn read_request(stream: &mut TcpStream) {
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.ends_with(b"{}") {
            let read = stream.read(&mut buffer).expect("read the request");
            assert!(read > 0, "the request ended early");
            request.extend_from_slice(&buffer[..read]);
        }
    }

    #[test]
    fn a_server_that_answers_late_is_healthy() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let server = thread::spawn(move || {
            // Like an old server going away: the first connection gets no answer.
            drop(listener.accept().expect("accept the first connection"));
            let (mut stream, _) = listener.accept().expect("accept the second connection");
            read_request(&mut stream);
            thread::sleep(Duration::from_millis(300));
            stream
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                .expect("answer");
        });
        assert_eq!(
            answers_unauthorized(address, Duration::from_secs(5)),
            Ok(())
        );
        server.join().expect("the server thread");
    }

    #[test]
    fn a_server_that_never_answers_times_out_with_the_cause() {
        // The kernel accepts connections to a listener nobody serves.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let error = answers_unauthorized(address, Duration::from_millis(500))
            .expect_err("a silent server is not healthy");
        assert!(
            error.contains("got no HTTP response within 500ms; last attempt: cannot read"),
            "{error}"
        );
        drop(listener);
    }

    #[test]
    fn another_status_fails_at_once() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            read_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                .expect("answer");
        });
        let error = answers_unauthorized(address, Duration::from_secs(5))
            .expect_err("404 is not the server");
        assert!(error.contains("answered 404 instead of 401"), "{error}");
        server.join().expect("the server thread");
    }
}
