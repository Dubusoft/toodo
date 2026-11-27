//! Database files over HTTP, for clients that do not share the server's filesystem:
//!
//! - `GET /api/backups/export` sends a consistent snapshot of the database.
//! - `GET /api/backups/{name}` sends a backup from the backup directory, by the file name
//!   `list_backups` reports.
//! - `POST /api/backups/restore` replaces all data with the Toodo database sent as the
//!   request body, after saving the current data as a pre-restore backup; the result is
//!   that backup, as `restore_backup` returns it.
//!
//! Files are sent as `application/vnd.sqlite3` attachments.

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{self, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use tower_http::timeout::TimeoutError;

use super::Services;
use super::rpc::Reply;
use crate::commands::{CommandError, backup, blocking};
use crate::mcp;

/// The largest database file a restore accepts.
pub const RESTORE_LIMIT: u64 = 256 * 1024 * 1024;

const SQLITE: &str = "application/vnd.sqlite3";

pub(super) fn failed(error: CommandError) -> Response {
    Reply::Failed(error).into_response()
}

pub(super) async fn remove(path: &Path) {
    if let Err(error) = tokio::fs::remove_file(path).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("toodo-server: cannot remove {}: {error}", path.display());
    }
}

/// The file at `path`, opened for sending, and its length in bytes.
async fn open(path: &Path) -> std::io::Result<(tokio::fs::File, u64)> {
    let file = tokio::fs::File::open(path).await?;
    let length = file.metadata().await?.len();
    Ok((file, length))
}

/// The file `opened` from `path` as an attachment named `name`, read from disk while it
/// is sent, so a download holds one chunk of it in memory rather than the whole file.
fn attachment(
    opened: std::io::Result<(tokio::fs::File, u64)>,
    path: &Path,
    name: &str,
) -> Response {
    match opened {
        Ok((file, length)) => (
            [
                (header::CONTENT_TYPE, SQLITE.to_owned()),
                (header::CONTENT_LENGTH, length.to_string()),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{name}\""),
                ),
                (header::CACHE_CONTROL, "no-store".to_owned()),
            ],
            Body::from_stream(ReaderStream::new(file)),
        )
            .into_response(),
        Err(error) => failed(CommandError::internal(format!(
            "cannot read {}: {error}",
            path.display()
        ))),
    }
}

pub async fn export(State(services): State<Arc<Services>>) -> Response {
    let snapshot = blocking(move || {
        let path = backup::export_snapshot(&services.storage, &services.backups)?;
        Ok((path, backup::export_file_name(&services.storage)))
    })
    .await;
    match snapshot {
        Ok((path, name)) => {
            // The open file keeps the snapshot readable while it is sent.
            let opened = open(&path).await;
            remove(&path).await;
            attachment(opened, &path, &name)
        }
        Err(error) => failed(error),
    }
}

pub async fn download(
    State(services): State<Arc<Services>>,
    extract::Path(name): extract::Path<String>,
) -> Response {
    match services.backups.backup_path(&name) {
        Ok(path) => attachment(open(&path).await, &path, &name),
        Err(error) => failed(error),
    }
}

pub async fn restore(
    State(services): State<Arc<Services>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let limit = services.restore_limit;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > limit) {
        return too_large(limit);
    }
    let path = match services.backups.scratch_path("upload") {
        Ok(path) => path,
        Err(error) => {
            return failed(CommandError::internal(format!(
                "cannot store the upload: {error}"
            )));
        }
    };
    let response = match receive(body, &path, limit).await {
        Ok(()) => {
            let upload = path.clone();
            Reply::result(
                blocking(move || {
                    backup::restore_file(&services.storage, &services.backups, &upload)
                })
                .await,
            )
            .into_response()
        }
        Err(error) => error.into_response(limit),
    };
    remove(&path).await;
    response
}

fn too_large(limit: u64) -> Response {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        format!(
            "a database to restore is at most {} MB",
            limit / 1024 / 1024
        ),
    )
        .into_response()
}

/// Why an upload did not arrive whole.
pub(super) enum UploadError {
    TooLarge,
    /// No more of the body arrived within [`mcp::READ_TIMEOUT`].
    Stalled,
    BrokenOff(axum::BoxError),
    Store(std::io::Error),
}

impl UploadError {
    pub(super) fn into_response(self, limit: u64) -> Response {
        match self {
            Self::TooLarge => too_large(limit),
            Self::Stalled => (
                StatusCode::REQUEST_TIMEOUT,
                format!(
                    "the upload stalled: nothing arrived for {} seconds",
                    mcp::READ_TIMEOUT.as_secs()
                ),
            )
                .into_response(),
            Self::BrokenOff(error) => (
                StatusCode::BAD_REQUEST,
                format!("the upload broke off: {error}"),
            )
                .into_response(),
            Self::Store(error) => failed(CommandError::internal(format!(
                "cannot store the upload: {error}"
            ))),
        }
    }
}

/// Writes the request body to `path`, failing once it grows past `limit` bytes.
pub(super) async fn receive(body: Body, path: &Path, limit: u64) -> Result<(), UploadError> {
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(UploadError::Store)?;
    let mut chunks = body.into_data_stream();
    let mut received: u64 = 0;
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|error| {
            let error = error.into_inner();
            if error.is::<TimeoutError>() {
                UploadError::Stalled
            } else {
                UploadError::BrokenOff(error)
            }
        })?;
        received += chunk.len() as u64;
        if received > limit {
            return Err(UploadError::TooLarge);
        }
        file.write_all(&chunk).await.map_err(UploadError::Store)?;
    }
    file.flush().await.map_err(UploadError::Store)
}
