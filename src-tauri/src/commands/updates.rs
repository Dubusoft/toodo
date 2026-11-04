//! Whether a newer Toodo is published on npm: the web app shows it in its settings, and
//! `toodo update --check` and `toodo update` compare versions the same way.

use std::cmp::Ordering;
use std::time::Duration;

use serde::Serialize;
use specta::Type;

/// The npm package Toodo is published as.
pub(crate) const PACKAGE: &str = "@dubusoft/toodo";
/// The registry the server asks, unless `TOODO_NPM_REGISTRY` names another one.
const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";
const TIMEOUT: Duration = Duration::from_secs(10);

/// The version this server runs and the newest one on the npm channel it follows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// The version this server runs.
    pub current: String,
    /// The npm dist-tag the version follows: `dev` for a prerelease, else `latest`.
    pub channel: String,
    /// The version on the channel, when the registry told it.
    pub latest: Option<String>,
    /// Whether `latest` is newer than `current`.
    pub newer: bool,
    /// Why the newest version is unknown, with what to do about it.
    pub error: Option<String>,
}

/// The npm dist-tag an installed `version` follows: prereleases come from `dev`.
pub(crate) fn channel_of(version: &str) -> &'static str {
    if version.contains('-') {
        "dev"
    } else {
        "latest"
    }
}

/// How `version` compares with `installed` by semver precedence (build metadata is
/// ignored), or `None` when either is not a semver version.
pub(crate) fn compare_versions(version: &str, installed: &str) -> Option<Ordering> {
    let version = semver::Version::parse(version).ok()?;
    let installed = semver::Version::parse(installed).ok()?;
    Some(version.cmp_precedence(&installed))
}

/// The check of `current` against the registry's dist-tags document of [`PACKAGE`],
/// e.g. `{"latest":"1.3.2","dev":"1.3.3-dev.70"}`.
fn from_dist_tags(current: &str, tags: &serde_json::Value) -> UpdateCheck {
    let channel = channel_of(current);
    let latest = tags
        .get(channel)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let error = latest.is_none().then(|| {
        format!(
            "npm has no {channel} version of {PACKAGE}; check for updates on the server with: \
             toodo update --check"
        )
    });
    UpdateCheck {
        current: current.to_owned(),
        channel: channel.to_owned(),
        newer: latest
            .as_deref()
            .and_then(|latest| compare_versions(latest, current))
            == Some(Ordering::Greater),
        latest,
        error,
    }
}

async fn dist_tags(registry: &str) -> Result<serde_json::Value, String> {
    // reqwest uses the process-wide rustls provider; another one may already be set.
    drop(rustls::crypto::ring::default_provider().install_default());
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!(
        "{}/-/package/{PACKAGE}/dist-tags",
        registry.trim_end_matches('/')
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GET {url} answered {status}"));
    }
    let body = response.bytes().await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map_err(|error| format!("GET {url} sent no JSON: {error}"))
}

/// Asks the npm registry (`TOODO_NPM_REGISTRY`, else the public one) for the newest
/// version on the channel of the running server.
#[specta::specta]
pub async fn check_update() -> UpdateCheck {
    let current = env!("TOODO_VERSION");
    let registry = std::env::var("TOODO_NPM_REGISTRY")
        .ok()
        .filter(|registry| !registry.is_empty())
        .unwrap_or_else(|| DEFAULT_REGISTRY.to_owned());
    match dist_tags(&registry).await {
        Ok(tags) => from_dist_tags(current, &tags),
        Err(cause) => UpdateCheck {
            current: current.to_owned(),
            channel: channel_of(current).to_owned(),
            latest: None,
            newer: false,
            error: Some(format!(
                "cannot reach the npm registry {registry}: {cause}; check the server's \
                 network, or check for updates on the server with: toodo update --check"
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prereleases_follow_dev_and_releases_latest() {
        assert_eq!(channel_of("1.3.2-dev.9"), "dev");
        assert_eq!(channel_of("1.3.1"), "latest");
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
    fn the_channel_of_the_running_version_decides_what_is_newer() {
        let tags = serde_json::json!({ "latest": "1.3.2", "dev": "1.3.3-dev.70" });
        let dev = from_dist_tags("1.3.3-dev.9", &tags);
        assert_eq!(dev.channel, "dev");
        assert_eq!(dev.latest.as_deref(), Some("1.3.3-dev.70"));
        assert!(dev.newer);
        assert_eq!(dev.error, None);
        let release = from_dist_tags("1.3.2", &tags);
        assert_eq!(release.latest.as_deref(), Some("1.3.2"));
        assert!(!release.newer);
        let ahead = from_dist_tags("1.4.0", &tags);
        assert!(!ahead.newer);
    }

    #[test]
    fn a_missing_channel_is_an_error_with_a_next_step() {
        let check = from_dist_tags("1.3.3-dev.9", &serde_json::json!({ "latest": "1.3.2" }));
        assert_eq!(check.latest, None);
        assert!(!check.newer);
        assert!(check.error.unwrap().contains("toodo update --check"));
    }
}
