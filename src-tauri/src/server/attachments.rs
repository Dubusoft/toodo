//! Files attached to chat messages, over HTTP:
//!
//! - `POST /api/chat/attachments?name=<file name>` uploads a person's file, and
//!   `POST /mcp/attachments?name=<file name>` one of the agent, with the MCP token. The
//!   request body is the file and its `Content-Type` the file's media type. The answer is
//!   the attachment (`201`), which a message then takes by its ID; an upload no message
//!   takes within a day is dropped.
//! - `GET /api/chat/attachments/{id}` and `GET /mcp/attachments/{id}` send a file back.
//!
//! The files are kept in `attachments/` of the data directory under a random key. Common
//! raster images are sent inline; everything else is sent as a download, and every file
//! with `nosniff` and a sandboxing CSP, so an uploaded page never runs as the app.

use std::sync::Arc;

use axum::Extension;
use axum::body::Body;
use axum::extract::{self, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tokio_util::io::ReaderStream;

use super::Services;
use super::files::{failed, receive, remove};
use super::rpc::json;
use crate::commands::types::{self, ChatAttachment, ChatAttachmentId};
use crate::commands::{CommandError, CommandErrorCode, blocking, lock};
use crate::domain::chat::{self, ChatAuthor};
use crate::mcp::{Access, Backend as _};
use crate::storage::StorageError;

/// The largest file an upload takes, in bytes.
pub const ATTACHMENT_LIMIT: u64 = 25 * 1024 * 1024;

/// How long an upload waits for a message to take it, in seconds.
const UNSENT_FOR: i64 = 24 * 60 * 60;

/// The media types sent inline: images a browser shows without running anything.
const INLINE: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Debug, Deserialize)]
pub struct Upload {
    #[serde(default)]
    name: String,
}

pub async fn upload_by_person(
    State(services): State<Arc<Services>>,
    Query(upload): Query<Upload>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    receive_upload(services, ChatAuthor::User, &upload.name, &headers, body).await
}

pub async fn upload_by_agent(
    State(services): State<Arc<Services>>,
    access: Option<Extension<Access>>,
    Query(upload): Query<Upload>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Some(refused) = local_only(access) {
        return refused;
    }
    receive_upload(services, ChatAuthor::Agent, &upload.name, &headers, body).await
}

pub async fn download_by_person(
    State(services): State<Arc<Services>>,
    extract::Path(id): extract::Path<i64>,
) -> Response {
    send(services, id).await
}

pub async fn download_by_agent(
    State(services): State<Arc<Services>>,
    access: Option<Extension<Access>>,
    extract::Path(id): extract::Path<i64>,
) -> Response {
    if let Some(refused) = local_only(access) {
        return refused;
    }
    send(services, id).await
}

/// Refuses chat apps signed in over OAuth: the chat, like its MCP tools, is for the agent
/// with the MCP token.
fn local_only(access: Option<Extension<Access>>) -> Option<Response> {
    match access {
        Some(Extension(Access::Static)) => None,
        _ => Some(failed(CommandError::new(
            CommandErrorCode::NotPermitted,
            "chat attachments are local-only; use the MCP token of the server",
        ))),
    }
}

fn too_large() -> Response {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        format!(
            "a chat attachment is at most {} MB",
            ATTACHMENT_LIMIT / 1024 / 1024
        ),
    )
        .into_response()
}

/// A random key to store a file under.
fn file_key() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

async fn receive_upload(
    services: Arc<Services>,
    uploader: ChatAuthor,
    name: &str,
    headers: &HeaderMap,
    body: Body,
) -> Response {
    let name = match types::file_name(name) {
        Ok(name) => name,
        Err(error) => return failed(error),
    };
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > services.attachment_limit) {
        return too_large();
    }
    let content_type = types::content_type(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
    );
    let dir = services.attachment_dir.clone();
    let stored = file_key().and_then(|key| {
        super::create_private_dir(&dir)?;
        Ok(key)
    });
    let key = match stored {
        Ok(key) => key,
        Err(error) => {
            return failed(CommandError::internal(format!(
                "cannot store the upload: {error}"
            )));
        }
    };
    let path = dir.join(&key);
    if let Err(error) = receive(body, &path, services.attachment_limit).await {
        remove(&path).await;
        return match error {
            super::files::UploadError::TooLarge => too_large(),
            error => error.into_response(services.attachment_limit),
        };
    }
    let size = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata.len() as i64,
        Err(error) => {
            remove(&path).await;
            return failed(CommandError::internal(format!(
                "cannot read the upload: {error}"
            )));
        }
    };
    let recorded = blocking(move || {
        let mut storage = lock(&services.storage);
        let attachment =
            storage.create_chat_attachment(&key, uploader, &name, &content_type, size)?;
        let unsent_since = storage.now() - UNSENT_FOR;
        let stale = storage.remove_stale_chat_attachments(unsent_since)?;
        Ok((attachment, stale))
    })
    .await;
    match recorded {
        Ok((attachment, stale)) => {
            for key in stale {
                remove(&dir.join(key)).await;
            }
            json(StatusCode::CREATED, &ChatAttachment::from(&attachment))
        }
        Err(error) => {
            remove(&path).await;
            failed(error)
        }
    }
}

async fn send(services: Arc<Services>, id: i64) -> Response {
    let id = chat::ChatAttachmentId::from(ChatAttachmentId(id));
    let reader = services.clone();
    let found = blocking(move || {
        lock(reader.reader())
            .chat_attachment(id)?
            .ok_or_else(|| StorageError::ChatAttachmentNotFound(id).into())
    })
    .await;
    let (attachment, key) = match found {
        Ok(found) => found,
        Err(error) => return failed(error),
    };
    let path = services.attachment_dir.join(&key);
    match tokio::fs::File::open(&path).await {
        Ok(file) => file_response(&attachment, file),
        Err(error) => failed(CommandError::internal(format!(
            "cannot read chat attachment {}: {error}",
            id.0
        ))),
    }
}

fn file_response(attachment: &chat::ChatAttachment, file: tokio::fs::File) -> Response {
    let disposition = if INLINE.contains(&attachment.content_type.as_str()) {
        "inline"
    } else {
        "attachment"
    };
    (
        [
            (header::CONTENT_TYPE, attachment.content_type.clone()),
            (header::CONTENT_LENGTH, attachment.size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                content_disposition(disposition, &attachment.name),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
            (
                header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'".to_owned(),
            ),
            (header::CACHE_CONTROL, "private, max-age=86400".to_owned()),
        ],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response()
}

/// `Content-Disposition` with `name` as an ASCII fallback and, in full, as UTF-8 (RFC 6266).
fn content_disposition(disposition: &str, name: &str) -> String {
    let fallback: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect();
    format!("{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_sent_as_ascii_and_as_utf8() {
        assert_eq!(
            content_disposition("attachment", "보고서 \"v2\".pdf"),
            "attachment; filename=\"___ _v2_.pdf\"; \
             filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C%20%22v2%22.pdf"
        );
    }
}
