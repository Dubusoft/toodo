//! Per-device access tokens for `/api`. Every request bears either the shared web token
//! (`web-token` in the data directory) or the token of a device that is not revoked. The
//! shared token registers devices: a browser signs in with it once and then keeps a token
//! of its own, which can be revoked alone. A device token cannot register more devices,
//! so a lost device's token cannot outlive its revocation through another one.
//!
//! - `GET /api/devices` lists every device, marking the one that asks.
//! - `POST /api/devices` with `{ "label": string }` registers a device and returns
//!   `{ "device": ..., "token": string }`; the token is shown only this once.
//! - `POST /api/devices/{id}/revoke` revokes a device for good.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::Services;
use super::rpc::{Reply, json};
use crate::commands::{CommandError, CommandResult, lock};
use crate::domain::device::{Device, DeviceId, DeviceLabel};
use crate::mcp;

/// Who a request to `/api` comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    /// A client that bears the shared web token.
    Shared,
    Device(DeviceId),
}

/// What `/api` requests are checked against.
#[derive(Clone)]
pub struct Gate {
    pub services: Arc<Services>,
    pub shared_token: Arc<String>,
    /// The MCP token, which `/api` rejects with a reason of its own.
    pub mcp_token: Arc<String>,
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

/// Lets a request through when it bears the shared token or an active device's token,
/// with its [`Caller`] as a request extension; a device's last-seen time moves with it.
pub async fn require_access(
    State(gate): State<Gate>,
    mut request: Request,
    next: Next,
) -> Response {
    let rejected = |rejection| mcp::unauthorized(mcp::Surface::Api, rejection, None);
    let presented = match mcp::bearer(request.headers()) {
        Ok(presented) => presented,
        Err(rejection) => return rejected(rejection),
    };
    let caller = if mcp::same_secret(presented, &gate.shared_token) {
        Caller::Shared
    } else if mcp::same_secret(presented, &gate.mcp_token) {
        return rejected(mcp::Rejection::OtherSurfaceToken);
    } else {
        let hash = token_hash(presented);
        let services = gate.services.clone();
        let found = blocking(move || Ok(lock(&services.storage).authenticate_device(&hash)?)).await;
        match found {
            Ok(Some(device)) => Caller::Device(device.id),
            Ok(None) => return rejected(mcp::Rejection::WrongToken),
            Err(error) => return Reply::Failed(error).into_response(),
        }
    };
    request.extensions_mut().insert(caller);
    next.run(request).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: i64,
    label: String,
    created_at: i64,
    last_seen_at: i64,
    revoked_at: Option<i64>,
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
            current: caller == Caller::Device(device.id),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct NewDevice {
    label: String,
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
    if caller != Caller::Shared {
        let error = CommandError::rejected(
            "only the shared web token can register a device; sign in with it on the new device",
        );
        return json(StatusCode::FORBIDDEN, &error);
    }
    let label = match DeviceLabel::parse(&new.label) {
        Ok(label) => label,
        Err(error) => {
            return Reply::Failed(CommandError::invalid_input(error.to_string())).into_response();
        }
    };
    let registered = blocking(move || {
        let token = mcp::random_token()
            .map_err(|error| CommandError::internal(format!("cannot create a token: {error}")))?;
        let device = lock(&services.storage).create_device(&label, &token_hash(&token))?;
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
    fn tokens_are_stored_as_their_sha256() {
        assert_eq!(
            token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
