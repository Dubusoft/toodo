//! The logs of plain and tmux runs over HTTP, whole rather than the tail `get_run_log`
//! returns:
//!
//! - `GET /api/runs/{id}/log` streams the stdout and stderr of a run as server-sent events:
//!   first the last `tail` bytes (default 64 KiB) of each, then what the agent writes, until
//!   the run ended and both logs were sent. Each `log` event is
//!   `{ "stream": "stdout" | "stderr", "offset", "next", "text" }`, where `offset` and
//!   `next` are byte offsets in the log; its id is `<stdout next>:<stderr next>`, so a client
//!   that reconnects with `Last-Event-ID` resumes where it was. `stdout` and `stderr` query
//!   parameters resume from given offsets too. An `end` event closes the stream; an `error`
//!   event tells that a read failed, and the stream tries again.
//! - `GET /api/runs/{id}/log/{stdout|stderr}` sends a whole log as a text attachment, up
//!   to where it was when asked.
//!
//! Logs are read again while the stream is open, every half second on the server and every
//! two seconds on an SSH machine. Text is cut at line ends and redacted of the run's MCP
//! token, as `get_run_log` returns it.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};

use super::Services;
use super::files::{blocking, failed};
use crate::commands::CommandError;
use crate::commands::run_logs::{self, LogSource};
use crate::domain::runtime::RunId;
use crate::runtime::log::LogStream;

/// The most of a log one event or one read of a download carries.
const PIECE: usize = 256 * 1024;

/// How much of the end of each log a new stream starts with.
const DEFAULT_TAIL: u64 = 64 * 1024;

const LOCAL_POLL: Duration = Duration::from_millis(500);
const REMOTE_POLL: Duration = Duration::from_secs(2);

#[derive(Debug, Default, Deserialize)]
pub struct StreamQuery {
    stdout: Option<u64>,
    stderr: Option<u64>,
    tail: Option<u64>,
}

#[derive(Serialize)]
struct Chunk<'a> {
    stream: &'static str,
    offset: u64,
    next: u64,
    text: &'a str,
}

/// Offsets as an event id gives them, `<stdout>:<stderr>`.
fn parse_offsets(id: &str) -> Option<[u64; 2]> {
    let (stdout, stderr) = id.split_once(':')?;
    Some([stdout.parse().ok()?, stderr.parse().ok()?])
}

/// A stream that follows the logs of a run.
struct Follow {
    services: Arc<Services>,
    source: Arc<LogSource>,
    offsets: [u64; 2],
    done: bool,
    last_error: Option<String>,
}

/// What one read of both logs found.
struct Pass {
    pieces: Vec<(LogStream, u64, run_logs::LogPiece)>,
    finished: bool,
}

impl Follow {
    async fn read(&self) -> Result<Pass, CommandError> {
        let (services, source, offsets) =
            (self.services.clone(), self.source.clone(), self.offsets);
        blocking(move || {
            // Whether it ended is read first, so the logs read after it are complete.
            let ended = run_logs::run_ended(&services.storage, source.run)?;
            let mut pieces = Vec::new();
            let mut finished = ended;
            for (index, stream) in LogStream::ALL.into_iter().enumerate() {
                let piece = source.read(
                    &services.plain,
                    &services.tmux,
                    stream,
                    offsets[index],
                    PIECE,
                    ended,
                )?;
                finished &= piece.at_end;
                pieces.push((stream, offsets[index], piece));
            }
            Ok(Pass { pieces, finished })
        })
        .await
    }

    /// The next events: the new text of the logs, or an error, waiting while there is
    /// none; `None` once the stream is over.
    async fn next(mut self) -> Option<(Vec<Event>, Self)> {
        if self.done {
            return None;
        }
        loop {
            let mut events = Vec::new();
            match self.read().await {
                Ok(pass) => {
                    self.last_error = None;
                    for (stream, offset, piece) in pass.pieces {
                        let index = LogStream::ALL.iter().position(|&s| s == stream).unwrap();
                        self.offsets[index] = piece.next;
                        if piece.text.is_empty() {
                            continue;
                        }
                        let data = serde_json::to_string(&Chunk {
                            stream: stream.as_wire(),
                            offset,
                            next: piece.next,
                            text: &piece.text,
                        })
                        .unwrap_or_default();
                        events.push(
                            Event::default()
                                .event("log")
                                .id(format!("{}:{}", self.offsets[0], self.offsets[1]))
                                .data(data),
                        );
                    }
                    if pass.finished {
                        events.push(Event::default().event("end").data("{}"));
                        self.done = true;
                        return Some((events, self));
                    }
                }
                Err(error) => {
                    if self.last_error.as_deref() != Some(error.message.as_str()) {
                        self.last_error = Some(error.message.clone());
                        let data = serde_json::json!({ "message": error.message }).to_string();
                        events.push(Event::default().event("error").data(data));
                    }
                }
            }
            if !events.is_empty() {
                return Some((events, self));
            }
            tokio::time::sleep(if self.source.remote {
                REMOTE_POLL
            } else {
                LOCAL_POLL
            })
            .await;
        }
    }
}

pub async fn stream(
    State(services): State<Arc<Services>>,
    Path(id): Path<i64>,
    Query(query): Query<StreamQuery>,
    headers: HeaderMap,
) -> Response {
    let id = RunId(id);
    let resume = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_offsets)
        .or(match (query.stdout, query.stderr) {
            (Some(stdout), Some(stderr)) => Some([stdout, stderr]),
            _ => None,
        });
    let tail = query.tail.unwrap_or(DEFAULT_TAIL);
    let opened = blocking({
        let services = services.clone();
        move || {
            let source = run_logs::log_source(&services.storage, &services.tmux, id)?;
            let offsets = match resume {
                Some(offsets) => offsets,
                None => {
                    let start =
                        |stream| source.tail_start(&services.plain, &services.tmux, stream, tail);
                    [start(LogStream::Stdout)?, start(LogStream::Stderr)?]
                }
            };
            Ok((source, offsets))
        }
    })
    .await;
    let (source, offsets) = match opened {
        Ok(opened) => opened,
        Err(error) => return failed(error),
    };
    let follow = Follow {
        services,
        source: Arc::new(source),
        offsets,
        done: false,
        last_error: None,
    };
    let events: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> = Box::pin(
        stream::unfold(follow, Follow::next)
            .flat_map(|events| stream::iter(events.into_iter().map(Ok))),
    );
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}

pub async fn download(
    State(services): State<Arc<Services>>,
    Path((id, name)): Path<(i64, String)>,
) -> Response {
    let Some(log) = LogStream::parse(&name) else {
        return failed(CommandError::invalid_input(format!(
            "there is no log {name:?}; download /api/runs/{id}/log/stdout or \
             /api/runs/{id}/log/stderr"
        )));
    };
    let id = RunId(id);
    let opened = blocking({
        let services = services.clone();
        move || {
            let source = run_logs::log_source(&services.storage, &services.tmux, id)?;
            let ended = run_logs::run_ended(&services.storage, id)?;
            Ok((source, ended))
        }
    })
    .await;
    let (source, ended) = match opened {
        Ok(opened) => opened,
        Err(error) => return failed(error),
    };
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::task::spawn_blocking(move || {
        let mut offset = 0;
        loop {
            let piece = source.read(&services.plain, &services.tmux, log, offset, PIECE, ended);
            let piece = match piece {
                Ok(piece) => piece,
                Err(error) => {
                    let _ = sender.blocking_send(Err(std::io::Error::other(error.message)));
                    return;
                }
            };
            if !piece.text.is_empty()
                && sender
                    .blocking_send(Ok(Bytes::from(piece.text.into_bytes())))
                    .is_err()
            {
                return;
            }
            if piece.at_end || piece.next == offset {
                return;
            }
            offset = piece.next;
        }
    });
    let body = stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"run-{id}-{}.log\"", log.as_wire()),
            ),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        Body::from_stream(body),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::parse_offsets;

    #[test]
    fn an_event_id_holds_both_offsets() {
        assert_eq!(parse_offsets("12:7"), Some([12, 7]));
        assert_eq!(parse_offsets("12"), None);
        assert_eq!(parse_offsets("a:7"), None);
    }
}
