//! Per-device access tokens for `/api`. Every request bears either the shared web token
//! (`web-token` in the data directory) or the token of a device that is not revoked. The
//! shared token registers devices: a browser signs in with it once and then keeps a token
//! of its own, which can be revoked alone. A device token cannot register more devices,
//! so a lost device's token cannot outlive its revocation through another one.
//!
//! A device token expires on its own after the lifetime it was registered with, and a
//! read-only one may only read: it gets `403` for requests that change data, except for
//! its own notification settings and revoking itself. Too many wrong tokens from one
//! address lock it out for a while (see [`mcp::attempts`]).
//!
//! - `GET /api/devices` lists every device, marking the one that asks.
//! - `POST /api/devices` with `{ "label": string, "scope"?: "full" | "read",
//!   "expiresInDays"?: number | null }` registers a device and returns
//!   `{ "device": ..., "token": string }`; the token is shown only this once. The scope
//!   defaults to `full` and the lifetime to [`DEFAULT_LIFETIME_DAYS`]; `null` never
//!   expires. A device that is not revoked and has the same label is reused instead of
//!   adding another: it takes the new token and its old token stops working, so a
//!   browser that lost its stored token and signs in again keeps one device.
//! - `POST /api/devices/{id}/revoke` revokes a device for good.
//! - `GET /api/session` tells how the request signed in: `{ "via": "token" | "access" }`.
//!
//! With Cloudflare Access configured (see [`access`]), a request with a valid Access JWT
//! needs no token: it counts as the device whose token it bears, else as
//! [`Caller::Access`].

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::Services;
use super::access;
use super::rpc::{self, Reply, json};
use crate::commands::{CommandError, CommandErrorCode, CommandResult, lock};
use crate::domain::device::{
    DEFAULT_LIFETIME_DAYS, Device, DeviceId, DeviceLabel, DeviceScope, MAX_LIFETIME_DAYS,
};
use crate::mcp::{self, Backend as _, attempts};
use crate::storage::DeviceAuth;

/// Who a request to `/api` comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    /// A client that bears the shared web token.
    Shared,
    Device(DeviceId),
    /// A request Cloudflare Access signed in, without a token that works.
    Access,
}

/// What `/api` requests are checked against.
#[derive(Clone)]
pub struct Gate {
    pub services: Arc<Services>,
    pub shared_token: Arc<String>,
    /// The MCP token, which `/api` rejects with a reason of its own.
    pub mcp_token: Arc<String>,
    pub attempts: attempts::FailedAttempts,
    /// Checks Cloudflare Access JWTs, when the server is configured for them.
    pub access: Option<Arc<access::Verifier>>,
}

/// The hash a device's token is stored as. Tokens are 32 random bytes, so a fast hash
/// without salt is enough: there is nothing to guess from a leaked hash.
pub fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tokio::task::spawn_blocking(run)
        .await
        .unwrap_or_else(|error| Err(CommandError::internal(format!("panicked: {error}"))))
}

/// What `token_hash` stands for. The lookup runs on the read-only connection, so a
/// request waits for the database's writer only when the device's last-seen time is stale.
fn authenticate(services: &Services, token_hash: &str) -> CommandResult<DeviceAuth> {
    let auth = lock(services.reader()).authenticate_device(token_hash)?;
    if let DeviceAuth::Active {
        device,
        seen_is_stale: true,
    } = &auth
    {
        lock(&services.storage).mark_device_seen(device.id)?;
    }
    Ok(auth)
}

/// Whether a read-only device `id` may make this request: it may read, keep its own
/// notifications, and revoke itself.
fn read_only_allows(method: &Method, path: &str, id: DeviceId) -> bool {
    if method == Method::GET || method == Method::HEAD {
        return true;
    }
    if let Some(command) = path.strip_prefix("/api/rpc/") {
        return rpc::READ_COMMANDS.contains(&command);
    }
    path.starts_with("/api/push/") || path == format!("/api/devices/{id}/revoke")
}

fn read_only_refused() -> Response {
    json(
        StatusCode::FORBIDDEN,
        &CommandError::new(
            CommandErrorCode::NotPermitted,
            "this device signed in read-only, so it cannot change data; make the change on a \
             device with full access, or revoke this device under Settings > Devices and \
             sign in again with the shared web token, choosing full access",
        ),
    )
}

fn expired() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        "Toodo API: this device's token has expired. Sign in to the web app again with the \
         token in `web-token` in the server's data directory; the browser then gets a new \
         device token.\n",
    )
        .into_response()
}

/// Lets a request through when it bears the shared token or an active device's token
/// that may make it, or a valid Cloudflare Access JWT, with its [`Caller`] as a request
/// extension; a device's last-seen time moves with it.
pub async fn require_access(
    State(gate): State<Gate>,
    mut request: Request,
    next: Next,
) -> Response {
    let through_access = match &gate.access {
        Some(verifier) => verifier.admits(request.headers()).await,
        None => false,
    };
    let peer = attempts::peer(&request);
    let asked = Asked {
        headers: request.headers(),
        method: request.method(),
        path: request.uri().path(),
        peer,
    };
    let caller = match (by_token(&gate, asked, through_access).await, through_access) {
        (Ok(caller), _) => caller,
        (Err(_), true) => Caller::Access,
        (Err(refused), false) => return *refused,
    };
    request.extensions_mut().insert(caller);
    next.run(request).await
}

/// What [`by_token`] needs of a request.
#[derive(Clone, Copy)]
struct Asked<'a> {
    headers: &'a HeaderMap,
    method: &'a Method,
    path: &'a str,
    peer: std::net::IpAddr,
}

/// The caller the request's token stands for, or the response refusing it. Wrong tokens
/// count towards the lockout unless Access signed the request in.
async fn by_token(
    gate: &Gate,
    asked: Asked<'_>,
    through_access: bool,
) -> Result<Caller, Box<Response>> {
    let rejected = |rejection| Box::new(mcp::unauthorized(mcp::Surface::Api, rejection, None));
    let peer = asked.peer;
    if !through_access && let Some(wait) = gate.attempts.locked_out(peer) {
        return Err(Box::new(attempts::too_many("API", wait)));
    }
    let presented = mcp::bearer(asked.headers).map_err(rejected)?;
    if mcp::same_secret(presented, &gate.shared_token) {
        return Ok(Caller::Shared);
    }
    if mcp::same_secret(presented, &gate.mcp_token) {
        return Err(rejected(mcp::Rejection::OtherSurfaceToken));
    }
    let hash = token_hash(presented);
    let services = gate.services.clone();
    match blocking(move || authenticate(&services, &hash)).await {
        Ok(DeviceAuth::Active { device, .. }) => {
            if device.scope == DeviceScope::ReadOnly
                && !read_only_allows(asked.method, asked.path, device.id)
            {
                return Err(Box::new(read_only_refused()));
            }
            Ok(Caller::Device(device.id))
        }
        Ok(DeviceAuth::Expired(_)) => Err(Box::new(expired())),
        Ok(DeviceAuth::Unknown) => {
            if !through_access {
                gate.attempts.record(peer);
            }
            Err(rejected(mcp::Rejection::WrongToken))
        }
        Err(error) => Err(Box::new(Reply::Failed(error).into_response())),
    }
}

pub async fn session(Extension(caller): Extension<Caller>) -> Response {
    let via = if caller == Caller::Access {
        "access"
    } else {
        "token"
    };
    json(StatusCode::OK, &serde_json::json!({ "via": via }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: i64,
    label: String,
    created_at: i64,
    last_seen_at: i64,
    revoked_at: Option<i64>,
    expires_at: Option<i64>,
    /// `full` or `read`.
    scope: &'static str,
    /// Whether this is the device that asked.
    current: bool,
}

impl DeviceView {
    fn new(device: Device, caller: Caller) -> Self {
        Self {
            id: device.id.0,
            label: device.label.as_str().to_owned(),
            created_at: device.created_at,
            last_seen_at: device.last_seen_at,
            revoked_at: device.revoked_at,
            expires_at: device.expires_at,
            scope: device.scope.as_str(),
            current: caller == Caller::Device(device.id),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ScopeInput {
    #[default]
    Full,
    Read,
}

fn default_lifetime() -> Option<u32> {
    Some(DEFAULT_LIFETIME_DAYS)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDevice {
    label: String,
    #[serde(default)]
    scope: ScopeInput,
    /// Missing for [`DEFAULT_LIFETIME_DAYS`], `null` for a token that does not expire.
    #[serde(default = "default_lifetime")]
    expires_in_days: Option<u32>,
}

#[derive(Debug, Serialize)]
struct Registered {
    device: DeviceView,
    token: String,
}

pub async fn list(
    State(services): State<Arc<Services>>,
    Extension(caller): Extension<Caller>,
) -> Response {
    let devices = blocking(move || Ok(lock(&services.storage).list_devices()?)).await;
    let views = devices.map(|devices| {
        devices
            .into_iter()
            .map(|device| DeviceView::new(device, caller))
            .collect::<Vec<_>>()
    });
    Reply::result(views).into_response()
}

pub async fn register(
    State(services): State<Arc<Services>>,
    Extension(caller): Extension<Caller>,
    body: Bytes,
) -> Response {
    let new: NewDevice = match serde_json::from_slice(&body) {
        Ok(new) => new,
        Err(error) => return Reply::BadArguments(error.to_string()).into_response(),
    };
    if !matches!(caller, Caller::Shared | Caller::Access) {
        let error = CommandError::rejected(
            "only the shared web token or Cloudflare Access can register a device; sign in \
             with it on the new device",
        );
        return json(StatusCode::FORBIDDEN, &error);
    }
    let label = match DeviceLabel::parse(&new.label) {
        Ok(label) => label,
        Err(error) => {
            return Reply::Failed(CommandError::invalid_input(error.to_string())).into_response();
        }
    };
    let lifetime = new.expires_in_days;
    if lifetime.is_some_and(|days| !(1..=MAX_LIFETIME_DAYS).contains(&days)) {
        return Reply::Failed(CommandError::invalid_input(format!(
            "expiresInDays must be from 1 to {MAX_LIFETIME_DAYS}; send null for a token that \
             does not expire"
        )))
        .into_response();
    }
    let scope = match new.scope {
        ScopeInput::Full => DeviceScope::Full,
        ScopeInput::Read => DeviceScope::ReadOnly,
    };
    let registered = blocking(move || {
        let token = mcp::random_token()
            .map_err(|error| CommandError::internal(format!("cannot create a token: {error}")))?;
        let device =
            lock(&services.storage).create_device(&label, &token_hash(&token), scope, lifetime)?;
        Ok(Registered {
            device: DeviceView::new(device, caller),
            token,
        })
    })
    .await;
    match registered {
        Ok(registered) => json(StatusCode::CREATED, &registered),
        Err(error) => Reply::Failed(error).into_response(),
    }
}

pub async fn revoke(
    State(services): State<Arc<Services>>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<i64>,
) -> Response {
    let revoked = blocking(move || Ok(lock(&services.storage).revoke_device(DeviceId(id))?)).await;
    Reply::result(revoked.map(|device| DeviceView::new(device, caller))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_only_device_may_read_keep_its_notifications_and_revoke_itself() {
        let me = DeviceId(3);
        let allows = |method: Method, path: &str| read_only_allows(&method, path, me);
        assert!(allows(Method::GET, "/api/events"));
        assert!(allows(Method::GET, "/api/backups/export"));
        assert!(allows(Method::POST, "/api/rpc/list_tasks"));
        assert!(allows(Method::PUT, "/api/push/subscription"));
        assert!(allows(Method::POST, "/api/devices/3/revoke"));
        assert!(!allows(Method::POST, "/api/devices/4/revoke"));
        assert!(!allows(Method::POST, "/api/rpc/create_task"));
        assert!(!allows(Method::POST, "/api/rpc/mcp_server_info"));
        assert!(!allows(Method::POST, "/api/rpc/list%5Ftasks"));
        assert!(!allows(Method::POST, "/api/backups/restore"));
        assert!(!allows(Method::POST, "/api/stream-tickets"));
    }

    #[test]
    fn tokens_are_stored_as_their_sha256() {
        assert_eq!(
            token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
