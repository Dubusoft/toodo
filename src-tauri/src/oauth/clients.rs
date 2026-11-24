//! Dynamic registration and client ID metadata document validation.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::routes::OAuthError;
use super::{Scopes, valid_web_url};
use crate::net::Outbound;
use crate::storage::oauth::Client;

pub type FetchFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + 'a>>;

pub trait ClientMetadataFetcher: Send + Sync {
    fn fetch<'a>(&'a self, url: &'a str) -> FetchFuture<'a>;
}

/// Fetches at most 64 KiB within five seconds from a public address, without redirects.
pub struct HttpClientMetadataFetcher {
    client: Outbound,
}

impl HttpClientMetadataFetcher {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Outbound::public(Duration::from_secs(5))?,
        })
    }
}

impl ClientMetadataFetcher for HttpClientMetadataFetcher {
    fn fetch<'a>(&'a self, url: &'a str) -> FetchFuture<'a> {
        Box::pin(async move {
            let invalid = || {
                "Publish a JSON client metadata document at the HTTPS client_id URL, without redirects and below 64 KiB.".to_owned()
            };
            // The outer timeout also bounds a slow response body.
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut response = self.client.get(url).await.map_err(|_| invalid())?;
                if !response.status().is_success()
                    || !response
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|v| {
                            v.split(';').next().unwrap_or("").trim() == "application/json"
                        })
                {
                    return Err(invalid());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
                    if bytes.len() + chunk.len() > 65536 {
                        return Err(invalid());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(bytes)
            })
            .await
            .map_err(|_| invalid())?
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Metadata {
    pub redirect_uris: Vec<String>,
    pub client_name: Option<String>,
    pub token_endpoint_auth_method: Option<String>,
    pub grant_types: Option<Vec<String>>,
    pub scope: Option<String>,
    pub client_id: Option<String>,
}

impl Metadata {
    pub fn validate(&self, cimd: bool) -> Result<String, OAuthError> {
        if self.redirect_uris.is_empty()
            || self.redirect_uris.iter().any(|value| {
                reqwest::Url::parse(value)
                    .map_or(true, |url| !valid_web_url(&url) || url.fragment().is_some())
            })
        {
            return Err(OAuthError::bad(
                "invalid_redirect_uri",
                "Register at least one HTTPS redirect URI (or HTTP loopback URI), without credentials or fragments.",
            ));
        }
        let method = self
            .token_endpoint_auth_method
            .as_deref()
            .unwrap_or(if cimd { "none" } else { "client_secret_basic" });
        if !matches!(
            method,
            "none" | "client_secret_post" | "client_secret_basic"
        ) || (cimd && method != "none")
            || self.grant_types.as_ref().is_some_and(|types| {
                types
                    .iter()
                    .any(|t| !matches!(t.as_str(), "authorization_code" | "refresh_token"))
            })
            || Scopes::parse(self.scope.as_deref()).is_err()
        {
            return Err(OAuthError::bad(
                "invalid_client_metadata",
                "Register supported scopes, authorization_code/refresh_token grant types, and a supported authentication method; metadata documents must use none.",
            ));
        }
        Ok(method.to_owned())
    }

    pub fn client(
        &self,
        id: String,
        method: String,
        secret_hash: Option<String>,
        at: i64,
    ) -> Client {
        Client {
            client_id: id,
            client_name: self.client_name.clone(),
            redirect_uris: self.redirect_uris.clone(),
            auth_method: method,
            secret_hash,
            created_at: at,
        }
    }
}

pub(super) type Cache = Mutex<HashMap<String, (Instant, Client)>>;

pub(super) async fn resolve(state: &super::routes::Server, id: &str) -> Result<Client, OAuthError> {
    let storage = state.storage.clone();
    let owned = id.to_owned();
    let registered = super::routes::blocking(move || {
        crate::commands::lock(&storage)
            .oauth_client(&owned)
            .map_err(|_| OAuthError::internal())
    })
    .await?;
    if let Some(client) = registered {
        return Ok(client);
    }
    let invalid = || {
        OAuthError::bad(
            "invalid_client",
            "Register the client or publish a valid HTTPS client_id metadata document, then start the connection again from the app.",
        )
    };
    let url = reqwest::Url::parse(id).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || !valid_web_url(&url)
        || url.path() == "/"
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    if let Some((_, client)) = state
        .cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(id)
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(600))
    {
        return Ok(client.clone());
    }
    let bytes = state.fetcher.fetch(id).await.map_err(|_| invalid())?;
    if bytes.len() > 65536 {
        return Err(invalid());
    }
    let metadata: Metadata = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if metadata.client_id.as_deref() != Some(id) {
        return Err(invalid());
    }
    let method = metadata.validate(true)?;
    let client = metadata.client(
        id.to_owned(),
        method,
        None,
        super::routes::now(&state.storage).await?,
    );
    let now = Instant::now();
    let mut cache = state.cache.lock().unwrap_or_else(PoisonError::into_inner);
    cache.retain(|_, (at, _)| now.duration_since(*at) < Duration::from_secs(600));
    cache.insert(id.to_owned(), (now, client.clone()));
    if cache.len() > 100 {
        let oldest = cache
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(id, _)| id.clone())
            .unwrap();
        cache.remove(&oldest);
    }
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_urls_with_private_address_literals_are_not_fetched() {
        let fetcher = HttpClientMetadataFetcher::new().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for url in [
            "https://127.0.0.1/client.json",
            "https://[::1]/client.json",
            "https://169.254.169.254/client.json",
        ] {
            assert!(runtime.block_on(fetcher.fetch(url)).is_err(), "{url}");
        }
    }
}
