//! Release installs: `toodo`, `toodo-server`, and the web app unpacked from a GitHub
//! release asset into `~/.local/lib/toodo` (`bin/toodo`, `bin/toodo-server`, `web/`, and
//! [`MARKER`]), with `~/.local/bin/toodo` linked to its CLI. `toodo update` replaces the
//! directory with the asset of a newer release, read with `GH_TOKEN` so that a private
//! repository works too.

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::Var;
use super::process;
use super::settings;
use crate::commands::updates::{channel_of, compare_versions};

/// The repository whose releases carry Toodo, unless `TOODO_RELEASE_REPO` or the install
/// names another one.
pub(super) const DEFAULT_REPO: &str = "Dubusoft/toodo";
/// The file that marks a release install and names the repository it updates from.
const MARKER: &str = "toodo-release.json";
const API: &str = "https://api.github.com";
/// How long a request for the list of releases or a checksum gets.
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the download of an asset gets: tens of megabytes on a slow link.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long `tar` gets to unpack an asset.
const UNPACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// A release install, found from the CLI that runs in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Install {
    /// The directory holding `bin/toodo` and [`MARKER`].
    pub dir: PathBuf,
    /// The `owner/name` repository it updates from.
    pub repo: String,
}

impl Install {
    /// The release install of the CLI at `exe` (`<dir>/bin/toodo`, links resolved).
    pub fn of(exe: &Path) -> Option<Self> {
        let exe = fs::canonicalize(exe).ok()?;
        let dir = exe.parent()?.parent()?.to_path_buf();
        let text = fs::read_to_string(dir.join(MARKER)).ok()?;
        let marker: serde_json::Value = serde_json::from_str(&text).ok()?;
        let repo = marker.get("repo")?.as_str()?.to_owned();
        Some(Self { dir, repo })
    }
}

/// Where `toodo update --source github` installs: `~/.local/lib/toodo`.
pub(super) fn install_dir(var: Var) -> Result<PathBuf, String> {
    Ok(settings::home(var)?.join(".local/lib/toodo"))
}

/// The platform part of the asset names of this build, e.g. `linux-x86_64` or
/// `darwin-aarch64`; musl builds end in `-musl`.
pub(super) fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let libc = if cfg!(target_env = "musl") {
        "-musl"
    } else {
        ""
    };
    format!("{os}-{}{libc}", std::env::consts::ARCH)
}

/// The asset of `version` for `platform`, as `scripts/package-server.sh` names it.
fn asset_name(version: &str, platform: &str) -> String {
    format!("toodo-server-v{version}-{platform}.tar.gz")
}

/// The releases of one repository, read with a token when there is one.
pub(super) struct Github {
    pub repo: String,
    token: Option<String>,
}

impl Github {
    /// The repository is `TOODO_RELEASE_REPO`, else `installed` (the repository of the
    /// release install), else [`DEFAULT_REPO`]; the token is `GH_TOKEN`, else
    /// `GITHUB_TOKEN`.
    pub fn new(installed: Option<&str>, var: Var) -> Self {
        let set = |name: &str| var(name).filter(|value| !value.trim().is_empty());
        let repo = set("TOODO_RELEASE_REPO")
            .or_else(|| installed.map(str::to_owned))
            .unwrap_or_else(|| DEFAULT_REPO.to_owned());
        let token = set("GH_TOKEN").or_else(|| set("GITHUB_TOKEN"));
        Self {
            repo: repo.trim().to_owned(),
            token: token.map(|token| token.trim().to_owned()),
        }
    }

    /// The newest release on the channel `tag` (`dev` or `latest`) that carries the asset
    /// of `platform` and its checksum.
    pub fn newest(&self, tag: &str, platform: &str) -> Result<Release, String> {
        let url = format!("{API}/repos/{}/releases?per_page=100", self.repo);
        let body = self.get(&url, "application/vnd.github+json", QUERY_TIMEOUT)?;
        let releases: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|error| format!("GET {url} sent no JSON: {error}; rerun toodo update"))?;
        pick(&releases, tag, platform).ok_or_else(|| {
            format!(
                "{} has no {tag} release with {}; nothing changed; pick another channel with: \
                 toodo update --channel dev|latest",
                self.repo,
                asset_name("<version>", platform)
            )
        })
    }

    /// Downloads the asset of `release`, checks it against its checksum, and unpacks it
    /// into a new directory beside `dir`, which it returns. The directory holds
    /// `bin/toodo`, `bin/toodo-server`, the web app in `web/` when the asset carries one,
    /// and [`MARKER`].
    pub fn stage(&self, release: &Release, dir: &Path) -> Result<PathBuf, String> {
        let parent = dir.parent().unwrap_or(Path::new("/"));
        let staging = parent.join(format!(".toodo.new.{}", std::process::id()));
        let failed = |error: std::io::Error| {
            format!(
                "cannot write {}: {error}; nothing changed; check the permissions of {} and \
                 rerun toodo update",
                staging.display(),
                parent.display()
            )
        };
        drop(fs::remove_dir_all(&staging));
        fs::create_dir_all(staging.join("bin")).map_err(failed)?;
        println!("Downloading {} from {}...", release.asset, self.repo);
        let staged = self
            .get(
                &release.asset_url,
                "application/octet-stream",
                DOWNLOAD_TIMEOUT,
            )
            .and_then(|tarball| {
                let checksum = self.get(
                    &release.checksum_url,
                    "application/octet-stream",
                    QUERY_TIMEOUT,
                )?;
                verify(
                    &tarball,
                    &String::from_utf8_lossy(&checksum),
                    &release.asset,
                )?;
                unpack(&tarball, &staging, &release.version)
            })
            .and_then(|()| {
                let marker = serde_json::json!({ "repo": self.repo, "version": release.version });
                fs::write(staging.join(MARKER), format!("{marker}\n")).map_err(failed)
            });
        if let Err(cause) = staged {
            drop(fs::remove_dir_all(&staging));
            return Err(cause);
        }
        Ok(staging)
    }

    /// The body of a GET of `url`, or an error that says what to do about it.
    fn get(&self, url: &str, accept: &str, limit: Duration) -> Result<Vec<u8>, String> {
        // reqwest uses the process-wide rustls provider; another one may already be set.
        drop(rustls::crypto::ring::default_provider().install_default());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("cannot start the HTTP client: {error}"))?;
        let response = runtime.block_on(async {
            let client = reqwest::Client::builder()
                .timeout(limit)
                .user_agent(format!("toodo/{}", env!("TOODO_VERSION")))
                .build()?;
            let mut request = client
                .get(url)
                .header(reqwest::header::ACCEPT, accept)
                .header("X-GitHub-Api-Version", "2022-11-28");
            // reqwest drops the header when a download redirects to another host.
            if let Some(token) = &self.token {
                request = request.bearer_auth(token);
            }
            let response = request.send().await?;
            let status = response.status().as_u16();
            let body = response.bytes().await?;
            Ok::<_, reqwest::Error>((status, body))
        });
        let (status, body) = response.map_err(|error| {
            format!(
                "GET {url} failed: {error}; nothing changed; check the network and rerun \
                 toodo update"
            )
        })?;
        match status {
            200..=299 => Ok(body.to_vec()),
            401 | 403 | 404 => Err(self.access_error(url, status)),
            _ => Err(format!(
                "GET {url} answered {status}; nothing changed; rerun toodo update later"
            )),
        }
    }

    fn access_error(&self, url: &str, status: u16) -> String {
        let repo = &self.repo;
        match self.token {
            None => format!(
                "GET {url} answered {status}: {repo} is private or does not exist, and no \
                 token was sent; nothing changed; set GH_TOKEN to a token that can read \
                 {repo} (for example GH_TOKEN=$(gh auth token)) and rerun toodo update, or \
                 name another repository with TOODO_RELEASE_REPO=owner/name"
            ),
            Some(_) => format!(
                "GET {url} answered {status}: the token in GH_TOKEN (or GITHUB_TOKEN) cannot \
                 read {repo}, or it does not exist; nothing changed; use a token with read \
                 access to its contents and rerun toodo update"
            ),
        }
    }
}

/// A release that carries the asset of this platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Release {
    pub version: String,
    pub asset: String,
    asset_url: String,
    checksum_url: String,
}

/// The newest of `releases` (the JSON list GitHub answers) on the channel `tag` that
/// carries the asset of `platform` and its checksum. Drafts and tags that are not
/// `v<semver>` are skipped; a prerelease version (`1.3.2-dev.7`) is on `dev`, any other on
/// `latest`.
fn pick(releases: &serde_json::Value, tag: &str, platform: &str) -> Option<Release> {
    releases
        .as_array()?
        .iter()
        .filter(|release| release.get("draft").and_then(serde_json::Value::as_bool) != Some(true))
        .filter_map(|release| {
            let version = release
                .get("tag_name")?
                .as_str()?
                .strip_prefix('v')?
                .to_owned();
            semver::Version::parse(&version).ok()?;
            if channel_of(&version) != tag {
                return None;
            }
            let asset = asset_name(&version, platform);
            let url_of = |name: &str| {
                release
                    .get("assets")?
                    .as_array()?
                    .iter()
                    .find(|item| {
                        item.get("name").and_then(serde_json::Value::as_str) == Some(name)
                    })?
                    .get("url")?
                    .as_str()
                    .map(str::to_owned)
            };
            let asset_url = url_of(&asset)?;
            let checksum_url = url_of(&format!("{asset}.sha256"))?;
            Some(Release {
                version,
                asset,
                asset_url,
                checksum_url,
            })
        })
        .max_by(|a, b| compare_versions(&a.version, &b.version).unwrap_or(Ordering::Equal))
}

/// Fails unless `bytes` hash to the sha256 in `checksum`, a `sha256sum` line for `name`.
fn verify(bytes: &[u8], checksum: &str, name: &str) -> Result<(), String> {
    let expected = checksum
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let actual = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if expected == actual {
        Ok(())
    } else {
        Err(format!(
            "the sha256 of the downloaded {name} is {actual}, but its checksum file says \
             {expected:?}; nothing changed; rerun toodo update, and if it fails again the \
             release asset is damaged"
        ))
    }
}

/// Unpacks the asset `tarball` (`toodo-server`, `toodo`, and `web/` at its top) into
/// `staging` as `bin/toodo-server`, `bin/toodo`, and `web/`, and checks that the server
/// runs here and reports `version`.
fn unpack(tarball: &[u8], staging: &Path, version: &str) -> Result<(), String> {
    let archive = staging.join("asset.tar.gz");
    let unpacked = staging.join("asset");
    let failed = |error: std::io::Error| {
        format!(
            "cannot unpack the release asset in {}: {error}; nothing changed",
            staging.display()
        )
    };
    fs::write(&archive, tarball).map_err(failed)?;
    fs::create_dir_all(&unpacked).map_err(failed)?;
    process::run_within(
        "tar",
        &[
            "-xzf",
            &archive.display().to_string(),
            "-C",
            &unpacked.display().to_string(),
        ],
        UNPACK_TIMEOUT,
        "nothing changed; rerun toodo update",
    )?;
    for name in ["toodo", "toodo-server"] {
        let file = unpacked.join(name);
        if !file.is_file() {
            return Err(format!(
                "the release asset carries no {name}; nothing changed; install a newer \
                 release"
            ));
        }
        fs::rename(&file, staging.join("bin").join(name)).map_err(failed)?;
    }
    if unpacked.join("web/index.html").is_file() {
        fs::rename(unpacked.join("web"), staging.join("web")).map_err(failed)?;
    }
    fs::remove_dir_all(&unpacked).map_err(failed)?;
    fs::remove_file(&archive).map_err(failed)?;

    let server = staging.join("bin/toodo-server");
    let reported = process::run_within(
        &server.display().to_string(),
        &["--version"],
        QUERY_TIMEOUT,
        "nothing changed; the release asset is not built for this machine",
    )?;
    let reported = reported.trim();
    let expected = format!("toodo-server {version}");
    let rest = reported.strip_prefix(&expected);
    if rest.is_some_and(|rest| rest.is_empty() || rest.starts_with(' ')) {
        Ok(())
    } else {
        Err(format!(
            "the release asset of {version} holds a server that reports {reported:?}; \
             nothing changed"
        ))
    }
}

/// Moves the staged directory to `dir`, keeping the install it replaces beside it.
/// Returns where that one went, `None` when there was none.
pub(super) fn put_in_place(staging: &Path, dir: &Path) -> Result<Option<PathBuf>, String> {
    let parent = dir.parent().unwrap_or(Path::new("/"));
    let failed = |error: std::io::Error| {
        format!(
            "cannot install {}: {error}; nothing changed; check the permissions of {} and \
             rerun toodo update",
            dir.display(),
            parent.display()
        )
    };
    let old = if dir.exists() {
        let old = parent.join(format!(".toodo.old.{}", std::process::id()));
        drop(fs::remove_dir_all(&old));
        fs::rename(dir, &old).map_err(failed)?;
        Some(old)
    } else {
        None
    };
    if let Err(error) = fs::rename(staging, dir) {
        if let Some(old) = &old {
            drop(fs::rename(old, dir));
        }
        drop(fs::remove_dir_all(staging));
        return Err(failed(error));
    }
    Ok(old)
}

/// Puts the install `old` that [`put_in_place`] kept back in `dir`, or removes `dir` when
/// there was none.
pub(super) fn restore(old: Option<&Path>, dir: &Path) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("cannot restore {}: {error}", dir.display());
    fs::remove_dir_all(dir).map_err(failed)?;
    match old {
        Some(old) => fs::rename(old, dir).map_err(failed),
        None => Ok(()),
    }
}

/// Removes the install `old` that [`put_in_place`] kept, once the new one works.
pub(super) fn discard(old: Option<&Path>) {
    if let Some(old) = old {
        drop(fs::remove_dir_all(old));
    }
}

/// Points `~/.local/bin/toodo` at the CLI of the release install in `dir`, replacing what
/// was there. Returns the link.
pub(super) fn link(dir: &Path, var: Var) -> Result<PathBuf, String> {
    let bin_dir = settings::home(var)?.join(".local/bin");
    let link = bin_dir.join("toodo");
    let target = dir.join("bin/toodo");
    if fs::read_link(&link).is_ok_and(|current| current == target) {
        return Ok(link);
    }
    let temporary = bin_dir.join(format!(".toodo.{}", std::process::id()));
    let failed = |error: std::io::Error| {
        format!(
            "cannot link {} to {}: {error}; link it yourself with: ln -sf {} {}",
            link.display(),
            target.display(),
            target.display(),
            link.display()
        )
    };
    fs::create_dir_all(&bin_dir).map_err(failed)?;
    drop(fs::remove_file(&temporary));
    std::os::unix::fs::symlink(&target, &temporary).map_err(failed)?;
    fs::rename(&temporary, &link).map_err(failed)?;
    Ok(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, assets: &[&str]) -> serde_json::Value {
        let assets: Vec<_> = assets
            .iter()
            .map(|name| serde_json::json!({ "name": name, "url": format!("https://api/{name}") }))
            .collect();
        serde_json::json!({ "tag_name": tag, "draft": draft, "assets": assets })
    }

    fn with_assets(tag: &str, platform: &str) -> serde_json::Value {
        let asset = asset_name(tag.trim_start_matches('v'), platform);
        release(tag, false, &[&asset, &format!("{asset}.sha256")])
    }

    #[test]
    fn the_platform_names_the_os_and_architecture() {
        let platform = platform();
        if cfg!(all(
            target_os = "linux",
            target_arch = "x86_64",
            target_env = "gnu"
        )) {
            assert_eq!(platform, "linux-x86_64");
        }
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(platform, "darwin-aarch64");
        }
    }

    #[test]
    fn the_newest_release_of_the_channel_with_this_platform_is_picked() {
        let platform = "linux-x86_64";
        let releases = serde_json::json!([
            // Newest, but its asset is still being uploaded.
            release(
                "v1.4.1-dev.12",
                false,
                &["toodo-server-v1.4.1-dev.12-linux-x86_64.tar.gz"]
            ),
            release("v1.4.1-dev.13", true, &[]),
            with_assets("v1.4.1-dev.9", platform),
            with_assets("v1.4.1-dev.11", platform),
            with_assets("v1.4.0", platform),
            with_assets("v1.3.9", platform),
            with_assets("nightly", platform),
        ]);
        let dev = pick(&releases, "dev", platform).unwrap();
        assert_eq!(dev.version, "1.4.1-dev.11");
        assert_eq!(dev.asset, "toodo-server-v1.4.1-dev.11-linux-x86_64.tar.gz");
        assert_eq!(
            dev.checksum_url,
            "https://api/toodo-server-v1.4.1-dev.11-linux-x86_64.tar.gz.sha256"
        );
        assert_eq!(
            pick(&releases, "latest", platform).unwrap().version,
            "1.4.0"
        );
        assert_eq!(pick(&releases, "latest", "darwin-aarch64"), None);
    }

    #[test]
    fn the_repository_and_token_come_from_the_environment_first() {
        let var = |name: &str| match name {
            "TOODO_RELEASE_REPO" => Some("me/fork".to_owned()),
            "GITHUB_TOKEN" => Some("t2".to_owned()),
            _ => None,
        };
        let github = Github::new(Some("Dubusoft/elsewhere"), &var);
        assert_eq!(github.repo, "me/fork");
        assert_eq!(github.token.as_deref(), Some("t2"));
        let none = |_: &str| None;
        assert_eq!(
            Github::new(Some("Dubusoft/elsewhere"), &none).repo,
            "Dubusoft/elsewhere"
        );
        let github = Github::new(None, &none);
        assert_eq!(github.repo, DEFAULT_REPO);
        assert!(github.access_error("u", 404).contains("set GH_TOKEN"));
    }

    #[test]
    fn a_download_must_match_its_checksum() {
        let sum = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(
            verify(b"hello", &format!("{sum}  a.tar.gz\n"), "a.tar.gz"),
            Ok(())
        );
        let error = verify(b"hello!", &format!("{sum}  a.tar.gz\n"), "a.tar.gz").unwrap_err();
        assert!(error.contains("nothing changed"), "{error}");
    }

    /// A release asset whose server reports `reported` to `--version`.
    fn asset(dir: &Path, reported: &str) -> Vec<u8> {
        use std::os::unix::fs::PermissionsExt;

        let source = dir.join("source");
        fs::create_dir_all(source.join("web")).unwrap();
        fs::write(source.join("web/index.html"), "<html>").unwrap();
        fs::write(source.join("toodo"), "#!/bin/sh\n").unwrap();
        fs::write(
            source.join("toodo-server"),
            format!("#!/bin/sh\necho '{reported}'\n"),
        )
        .unwrap();
        for name in ["toodo", "toodo-server"] {
            fs::set_permissions(source.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let tarball = dir.join("asset.tar.gz");
        let status = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(&source)
            .args(["toodo-server", "toodo", "web"])
            .status()
            .unwrap();
        assert!(status.success());
        fs::read(tarball).unwrap()
    }

    #[test]
    fn an_asset_unpacks_into_the_install_layout() {
        let dir = tempfile::tempdir().unwrap();
        let tarball = asset(dir.path(), "toodo-server 1.4.0 (commit 0123456789ab)");
        let staging = dir.path().join("staging");
        fs::create_dir_all(staging.join("bin")).unwrap();
        unpack(&tarball, &staging, "1.4.0").unwrap();
        assert!(staging.join("bin/toodo").is_file());
        assert!(staging.join("bin/toodo-server").is_file());
        assert!(staging.join("web/index.html").is_file());
        assert!(!staging.join("asset").exists());
        assert!(!staging.join("asset.tar.gz").exists());

        let other = dir.path().join("other");
        fs::create_dir_all(other.join("bin")).unwrap();
        let error = unpack(&tarball, &other, "1.4.0-dev.3").unwrap_err();
        assert!(error.contains("reports"), "{error}");
    }

    #[test]
    fn an_install_is_replaced_and_restored() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("toodo");
        let new = |version: &str| {
            let staging = root.path().join(format!("staging-{version}"));
            fs::create_dir_all(staging.join("bin")).unwrap();
            fs::write(staging.join("bin/toodo"), version).unwrap();
            fs::write(
                staging.join(MARKER),
                serde_json::json!({ "repo": "me/toodo", "version": version }).to_string(),
            )
            .unwrap();
            staging
        };
        assert_eq!(put_in_place(&new("1"), &dir).unwrap(), None);
        assert_eq!(
            Install::of(&dir.join("bin/toodo")),
            Some(Install {
                dir: fs::canonicalize(&dir).unwrap(),
                repo: "me/toodo".to_owned()
            })
        );
        let old = put_in_place(&new("2"), &dir).unwrap();
        assert_eq!(fs::read_to_string(dir.join("bin/toodo")).unwrap(), "2");
        restore(old.as_deref(), &dir).unwrap();
        assert_eq!(fs::read_to_string(dir.join("bin/toodo")).unwrap(), "1");
        assert!(!old.unwrap().exists());
        restore(None, &dir).unwrap();
        assert!(!dir.exists());
        assert_eq!(Install::of(Path::new("/nonexistent/bin/toodo")), None);
    }

    #[test]
    fn the_link_points_at_the_install() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().display().to_string();
        let var = |name: &str| (name == "HOME").then(|| path.clone());
        let dir = install_dir(&var).unwrap();
        let bin = home.path().join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        // A copy (or an npm link) of an earlier install.
        fs::write(bin.join("toodo"), "old").unwrap();
        let link = link(&dir, &var).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), dir.join("bin/toodo"));
        assert_eq!(super::link(&dir, &var).unwrap(), link);
    }
}
