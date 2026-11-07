//! Single-owner authorization server for public MCP connections.

mod clients;
mod routes;

use std::fmt;

use sha2::{Digest, Sha256};

use crate::commands::{StorageState, lock};

pub use clients::{ClientMetadataFetcher, FetchFuture, HttpClientMetadataFetcher};
pub use routes::router;

/// Validated origin used as the OAuth issuer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicUrl(String);

impl PublicUrl {
    pub fn parse(value: &str) -> Result<Self, String> {
        let invalid = || {
            "Set TOODO_PUBLIC_URL to an HTTPS origin such as https://toodo.example.com (HTTP is allowed only for localhost, 127.0.0.1, or [::1]); remove credentials, paths, queries, and fragments.".to_owned()
        };
        let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
        if !valid_web_url(&url)
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        Ok(Self(url.as_str().trim_end_matches('/').to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn resource(&self) -> String {
        format!("{}/mcp", self.0)
    }
}

impl fmt::Display for PublicUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn valid_web_url(url: &reqwest::Url) -> bool {
    url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
}

/// The single-user identity attached to OAuth grants.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OwnerKey(pub String);

impl OwnerKey {
    pub fn implicit() -> Self {
        Self("implicit".to_owned())
    }
}

/// The owner who approves consent on this single-user server: the implicit owner the
/// runtime records use until tenants exist. This is the only owner resolver; grant and token
/// logic carries its result unchanged.
pub fn server_owner() -> OwnerKey {
    OwnerKey::implicit()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Read,
    Write,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "toodo.read",
            Self::Write => "toodo.write",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scopes(u8);

impl Scopes {
    pub const ALL: Self = Self(3);
    pub const READ: Self = Self(1);

    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        let Some(value) = value else {
            return Ok(Self::ALL);
        };
        let invalid = || {
            "Request only toodo.read and toodo.write scopes, then start the connection again from the app.".to_owned()
        };
        let mut scopes = Self(0);
        for scope in value.split_ascii_whitespace() {
            scopes.0 |= match scope {
                "toodo.read" => 1,
                "toodo.write" => 2,
                _ => return Err(invalid()),
            };
        }
        if scopes.0 == 0 {
            return Err(invalid());
        }
        Ok(scopes)
    }

    pub fn contains(self, scope: Scope) -> bool {
        self.0
            & match scope {
                Scope::Read => 1,
                Scope::Write => 2,
            }
            != 0
    }

    pub fn is_subset_of(self, other: Self) -> bool {
        self.0 & !other.0 == 0
    }

    pub fn can_read(self) -> bool {
        self.0 != 0
    }

    pub fn can_write(self) -> bool {
        self.contains(Scope::Write)
    }
}

impl fmt::Display for Scopes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let scopes = [Scope::Read, Scope::Write]
            .into_iter()
            .filter(|scope| self.contains(*scope))
            .map(Scope::as_str)
            .collect::<Vec<_>>();
        f.write_str(&scopes.join(" "))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveGrant {
    pub owner_key: OwnerKey,
    pub grant_id: i64,
    pub scopes: Scopes,
}

/// Resolves an access bearer and records last use; database failures remain errors.
pub fn resolve_access_token(
    storage: &StorageState,
    token: &str,
) -> crate::storage::Result<Option<LiveGrant>> {
    Ok(lock(storage)
        .oauth_access(&hash(token))?
        .map(|g| LiveGrant {
            owner_key: g.owner_key,
            grant_id: g.id,
            scopes: g.scopes,
        }))
}

pub(crate) fn hash(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}

fn random() -> Result<String, routes::OAuthError> {
    crate::mcp::random_token().map_err(|_| routes::OAuthError::internal())
}
