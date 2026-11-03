//! The pane view: a live mirror of a pane in a task's herdr workspace over a WebSocket.
//!
//! - `POST /api/stream-tickets` with `{ "taskId", "paneId" }` (behind the web token) checks
//!   that the pane is in the task's herdr workspace and returns a single-use ticket for it,
//!   valid for [`TICKET_LIFETIME`], since browsers cannot send a bearer token on a
//!   WebSocket.
//! - `GET /api/panes/stream?ticket=<ticket>` upgrades to the WebSocket. Its `Origin` must
//!   be the server's own or the desktop app's.
//!
//! herdr has no stream of pane output, so a [`Mirror`] per pane reads the pane's screen,
//! quickly while it changes and backing off while it does not, and sends a frame to every
//! viewer when the screen changed. Frames are whole screens, so a viewer that falls behind
//! skips to the newest one. Viewers start read-only; input is passed on to herdr only
//! after `{ "type": "control", "on": true }`.
//!
//! ```jsonc
//! // server -> client
//! { "type": "frame", "seq": 41, "cols": 120, "rows": 40, "ansi": "<visible screen>" }
//! { "type": "control", "on": true }
//! { "type": "error", "message": "..." }
//! { "type": "closed", "reason": "pane_closed" }   // then the server closes the socket
//! // client -> server
//! { "type": "control", "on": true }
//! { "type": "text", "text": "yes\r" }             // herdr pane.send_text
//! { "type": "keys", "keys": ["esc"] }             // herdr pane.send_keys
//! ```

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, watch};

use super::Services;
use super::rpc::Reply;
use crate::adapters::herdr::Herdr;
use crate::adapters::herdr_events::{Connector, LocalSocket, SshSocket};
use crate::adapters::herdr_panes::{self, PANE_NOT_FOUND, PaneError, Screen};
use crate::commands::events::windows_host;
use crate::commands::types::{TaskId, Timestamp};
use crate::commands::{CommandError, HerdrState, herdr};
use crate::domain::model::{self, Machine};

/// How long a ticket stays valid.
pub const TICKET_LIFETIME: Duration = Duration::from_secs(30);

/// The largest message a viewer may send, e.g. pasted text.
pub const MAX_INPUT: usize = 64 * 1024;

/// How often a changing screen is read, and how far that backs off while it is unchanged.
const FAST_READ: Duration = Duration::from_millis(250);
const SLOW_READ: Duration = Duration::from_secs(2);

/// How long a mirror without viewers keeps reading, for a viewer that reconnects.
const LINGER: Duration = Duration::from_secs(5);

/// Failed reads in a row after which a mirror gives up and closes its viewers.
const MAX_FAILURES: u32 = 8;

pub type SharedConnector = Arc<dyn Connector + Send + Sync>;

/// Opens connections to the herdr server of a machine; faked in tests.
pub trait PaneAccess: Send + Sync {
    fn connector(&self, machine: &Machine) -> Result<SharedConnector, String>;
}

/// herdr's socket, found through `herdr status`: the local socket, or the socket of a
/// saved SSH machine through `ssh -W` sharing one SSH connection.
pub struct HerdrSockets(pub HerdrState);

impl PaneAccess for HerdrSockets {
    fn connector(&self, machine: &Machine) -> Result<SharedConnector, String> {
        let herdr: &Herdr = &self.0;
        let status = match machine {
            Machine::Local => herdr.server_status(),
            Machine::Ssh(host) => herdr.remote_server_status(host),
        }
        .map_err(|error| error.to_string())?;
        let socket = status
            .socket
            .filter(|_| status.running)
            .ok_or_else(|| format!("herdr is not running on {machine}"))?;
        Ok(match machine {
            Machine::Local => Arc::new(LocalSocket::new(&socket)),
            Machine::Ssh(host) => Arc::new(SshSocket::multiplexed(host.clone(), socket)),
        })
    }
}

/// The pane a ticket lets its holder view.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Ticket {
    task: model::TaskId,
    machine: Machine,
    pane: String,
    expires: Instant,
}

type MirrorKey = (Machine, String);

/// The tickets and mirrors of the server.
pub struct Panes {
    access: Arc<dyn PaneAccess>,
    tickets: Mutex<HashMap<String, Ticket>>,
    mirrors: Arc<Mutex<HashMap<MirrorKey, Arc<Mirror>>>>,
}

impl Panes {
    pub fn new(access: Arc<dyn PaneAccess>) -> Self {
        Self {
            access,
            tickets: Mutex::default(),
            mirrors: Arc::default(),
        }
    }

    fn issue(&self, task: model::TaskId, machine: Machine, pane: String) -> Result<String, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
        let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let now = Instant::now();
        let mut tickets = lock(&self.tickets);
        tickets.retain(|_, ticket| ticket.expires > now);
        tickets.insert(
            id.clone(),
            Ticket {
                task,
                machine,
                pane,
                expires: now + TICKET_LIFETIME,
            },
        );
        Ok(id)
    }

    /// The ticket `id`, which can be redeemed once and before it expires.
    fn redeem(&self, id: &str) -> Option<Ticket> {
        lock(&self.tickets)
            .remove(id)
            .filter(|ticket| ticket.expires > Instant::now())
    }

    /// The mirror of `pane` on `machine`, started for its first viewer, and a receiver of
    /// its updates that has not seen the current one yet.
    fn join(&self, machine: &Machine, pane: &str) -> (Arc<Mirror>, watch::Receiver<Update>) {
        let key = (machine.clone(), pane.to_owned());
        // A mirror decides to stop with this lock held, so it cannot stop between being
        // found here and getting its new viewer.
        let mut mirrors = lock(&self.mirrors);
        let mirror = mirrors
            .entry(key.clone())
            .or_insert_with(|| {
                let mirror = Arc::new(Mirror {
                    machine: machine.clone(),
                    pane: pane.to_owned(),
                    access: self.access.clone(),
                    connector: Mutex::default(),
                    updates: watch::channel(Update::Waiting).0,
                    poke: Notify::new(),
                });
                tokio::spawn(mirror.clone().run(self.mirrors.clone(), key));
                mirror
            })
            .clone();
        let mut updates = mirror.updates.subscribe();
        updates.mark_changed();
        (mirror, updates)
    }
}

/// What a mirror last saw of its pane.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Update {
    /// Nothing read yet.
    Waiting,
    Frame {
        seq: u64,
        screen: Arc<Screen>,
    },
    /// The mirror stopped, e.g. because the pane was closed.
    Closed {
        reason: String,
    },
}

/// Reads one pane of a herdr server for its viewers.
struct Mirror {
    machine: Machine,
    pane: String,
    access: Arc<dyn PaneAccess>,
    /// The connector in use, opened on first use and again after a failure.
    connector: Mutex<Option<SharedConnector>>,
    updates: watch::Sender<Update>,
    /// Asks for a read now, e.g. after input.
    poke: Notify,
}

impl Mirror {
    /// Runs `request` with the mirror's connector; blocks.
    fn with_connector<T>(
        &self,
        request: impl FnOnce(&dyn Connector) -> Result<T, PaneError>,
    ) -> Result<T, PaneError> {
        let connector = {
            let mut slot = lock(&self.connector);
            match &*slot {
                Some(connector) => connector.clone(),
                None => {
                    let connector = self
                        .access
                        .connector(&self.machine)
                        .map_err(PaneError::Unexpected)?;
                    *slot = Some(connector.clone());
                    connector
                }
            }
        };
        let result = request(&*connector);
        if matches!(result, Err(PaneError::Io(_))) {
            // The socket may have moved, e.g. herdr restarted: look it up again next time.
            *lock(&self.connector) = None;
        }
        result
    }

    async fn run(
        self: Arc<Self>,
        mirrors: Arc<Mutex<HashMap<MirrorKey, Arc<Mirror>>>>,
        key: MirrorKey,
    ) {
        let mut seq = 0;
        let mut last: Option<Arc<Screen>> = None;
        let mut interval = FAST_READ;
        let mut failures = 0;
        let mut unwatched_since: Option<Instant> = None;
        let stop = |reason: String| {
            lock(&mirrors).remove(&key);
            self.updates.send_replace(Update::Closed { reason });
        };
        loop {
            {
                let mut mirrors = lock(&mirrors);
                if self.updates.receiver_count() == 0 {
                    let since = *unwatched_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= LINGER {
                        mirrors.remove(&key);
                        return;
                    }
                } else {
                    unwatched_since = None;
                }
            }
            let mirror = self.clone();
            let read = tokio::task::spawn_blocking(move || {
                mirror.with_connector(|connector| herdr_panes::read_pane(connector, &mirror.pane))
            })
            .await;
            match read {
                Ok(Ok(screen)) => {
                    failures = 0;
                    if last.as_deref() == Some(&screen) {
                        interval = (interval * 2).min(SLOW_READ);
                    } else {
                        seq += 1;
                        let screen = Arc::new(screen);
                        last = Some(screen.clone());
                        self.updates.send_replace(Update::Frame { seq, screen });
                        interval = FAST_READ;
                    }
                }
                Ok(Err(error)) if error.code() == Some(PANE_NOT_FOUND) => {
                    return stop("pane_closed".to_owned());
                }
                Ok(Err(error)) => {
                    failures += 1;
                    if failures >= MAX_FAILURES {
                        return stop(error.to_string());
                    }
                    interval = SLOW_READ;
                }
                Err(error) => return stop(format!("reading the pane failed: {error}")),
            }
            tokio::select! {
                () = tokio::time::sleep(interval) => {}
                () = self.poke.notified() => interval = FAST_READ,
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketRequest {
    task_id: TaskId,
    pane_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketReply {
    ticket: String,
    expires_at: Timestamp,
}

/// `POST /api/stream-tickets`: a ticket for a pane of a task's herdr workspace.
pub async fn issue_ticket(State(services): State<Arc<Services>>, body: Bytes) -> Response {
    let request: TicketRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return Reply::BadArguments(error.to_string()).into_response(),
    };
    let services_ = services.clone();
    let found = tokio::task::spawn_blocking(move || {
        let found =
            herdr::task_panes(&services_.storage, &services_.herdr, request.task_id.into())?;
        // herdr on Windows serves its API on a named pipe, which `ssh -W` cannot reach.
        if windows_host(&crate::commands::lock(&services_.storage), &found.machine)? {
            return Err(CommandError::rejected(format!(
                "the pane view is not available for the Windows machine {}: herdr there \
                 serves its API on a named pipe, which SSH cannot forward",
                found.machine
            )));
        }
        Ok((found, request))
    })
    .await;
    let (found, request) = match found {
        Ok(Ok(found)) => found,
        Ok(Err(error)) => return Reply::Failed(error).into_response(),
        Err(error) => {
            return Reply::Failed(CommandError::internal(error.to_string())).into_response();
        }
    };
    let task: model::TaskId = request.task_id.into();
    if !found
        .panes
        .iter()
        .any(|pane| pane.pane_id == request.pane_id)
    {
        return Reply::Failed(CommandError::not_found(format!(
            "pane {} is not in the herdr workspace of task {task}",
            request.pane_id
        )))
        .into_response();
    }
    match services.panes.issue(task, found.machine, request.pane_id) {
        Ok(ticket) => Reply::value(TicketReply {
            ticket,
            expires_at: Timestamp(unix_seconds(SystemTime::now() + TICKET_LIFETIME)),
        })
        .into_response(),
        Err(error) => Reply::Failed(CommandError::internal(error)).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct StreamQuery {
    ticket: String,
}

/// `GET /api/panes/stream?ticket=`: the WebSocket of a pane view.
pub async fn stream(
    State(services): State<Arc<Services>>,
    Query(query): Query<StreamQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let Some(ticket) = services.panes.redeem(&query.ticket) else {
        return (StatusCode::UNAUTHORIZED, "unknown, used, or expired ticket").into_response();
    };
    let panes = services.clone();
    upgrade
        .max_message_size(MAX_INPUT)
        .on_upgrade(move |socket| view(panes, ticket, socket))
}

/// Whether a WebSocket request with `headers` comes from this server's own pages or a
/// client that is not a browser (which sends no `Origin`); this keeps
/// other sites from opening the stream with a ticket they got hold of.
fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Some((_, authority)) = origin.split_once("://") else {
        return false;
    };
    // Behind a reverse proxy, the browser's host may only be in `X-Forwarded-Host`.
    [header::HOST.as_str(), "x-forwarded-host"]
        .into_iter()
        .filter_map(|name| headers.get(name)?.to_str().ok())
        .any(|host| host.eq_ignore_ascii_case(authority))
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage<'a> {
    Frame {
        seq: u64,
        cols: u16,
        rows: u16,
        ansi: &'a str,
    },
    Control {
        on: bool,
    },
    Error {
        message: String,
    },
    Closed {
        reason: &'a str,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Control {
        on: bool,
    },
    Text {
        text: String,
    },
    Keys {
        keys: Vec<String>,
    },
    /// Resizing the pane is not supported yet; the view scales the frames instead.
    Resize {},
}

async fn send(socket: &mut WebSocket, message: &ServerMessage<'_>) -> bool {
    match serde_json::to_string(message) {
        Ok(text) => socket.send(Message::Text(text.into())).await.is_ok(),
        Err(_) => false,
    }
}

/// A control session of a viewer, logged once when it ends.
struct Control {
    task: model::TaskId,
    machine: Machine,
    pane: String,
    since: SystemTime,
}

impl Drop for Control {
    fn drop(&mut self) {
        println!(
            "toodo-server: pane {} of task {} on {} was controlled from {} to {} (Unix time)",
            self.pane,
            self.task,
            self.machine,
            unix_seconds(self.since),
            unix_seconds(SystemTime::now())
        );
    }
}

async fn view(services: Arc<Services>, ticket: Ticket, mut socket: WebSocket) {
    let (mirror, mut updates) = services.panes.join(&ticket.machine, &ticket.pane);
    let mut control: Option<Control> = None;
    loop {
        tokio::select! {
            changed = updates.changed() => {
                if changed.is_err() {
                    break;
                }
                let update = updates.borrow_and_update().clone();
                let sent = match &update {
                    Update::Waiting => true,
                    Update::Frame { seq, screen } => {
                        let frame = ServerMessage::Frame {
                            seq: *seq,
                            cols: screen.cols,
                            rows: screen.rows,
                            ansi: &screen.ansi,
                        };
                        send(&mut socket, &frame).await
                    }
                    Update::Closed { reason } => {
                        send(&mut socket, &ServerMessage::Closed { reason }).await;
                        false
                    }
                };
                if !sent {
                    break;
                }
            }
            message = socket.recv() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };
                let reply = match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(message) => handle(&mirror, &ticket, &mut control, message).await,
                    Err(error) => Some(ServerMessage::Error { message: format!("unknown message: {error}") }),
                };
                if let Some(reply) = reply
                    && !send(&mut socket, &reply).await
                {
                    break;
                }
            }
        }
    }
    drop(control);
    let _ = socket.send(Message::Close(None)).await;
}

/// Acts on a viewer's message and returns the reply, if any.
async fn handle(
    mirror: &Arc<Mirror>,
    ticket: &Ticket,
    control: &mut Option<Control>,
    message: ClientMessage,
) -> Option<ServerMessage<'static>> {
    let input = match message {
        ClientMessage::Control { on } => {
            if on && control.is_none() {
                *control = Some(Control {
                    task: ticket.task,
                    machine: ticket.machine.clone(),
                    pane: ticket.pane.clone(),
                    since: SystemTime::now(),
                });
            } else if !on {
                *control = None;
            }
            return Some(ServerMessage::Control { on });
        }
        ClientMessage::Resize {} => return None,
        input => input,
    };
    if control.is_none() {
        return Some(ServerMessage::Error {
            message: "the view is read-only; take control to send input".to_owned(),
        });
    }
    let sender = mirror.clone();
    let sent = tokio::task::spawn_blocking(move || {
        sender.with_connector(|connector| match &input {
            ClientMessage::Text { text } => herdr_panes::send_text(connector, &sender.pane, text),
            ClientMessage::Keys { keys } => herdr_panes::send_keys(connector, &sender.pane, keys),
            ClientMessage::Control { .. } | ClientMessage::Resize {} => Ok(()),
        })
    })
    .await;
    mirror.poke.notify_one();
    match sent {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(ServerMessage::Error {
            message: error.to_string(),
        }),
        Err(error) => Some(ServerMessage::Error {
            message: error.to_string(),
        }),
    }
}

fn unix_seconds(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |duration| {
        i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
    })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

    use super::super::tests::{exchange, serve, services_with};
    use super::*;
    use crate::adapters::git::fake::FakeRunner;
    use crate::adapters::herdr_panes::fake::FakeHerdr;
    use crate::domain::model::{TaskType, WorkspaceLocation};
    use crate::domain::path::{PosixPath, WindowsPath};
    use crate::storage::{NewTask, NewWorkspace};

    struct FakeAccess(FakeHerdr);

    impl PaneAccess for FakeAccess {
        fn connector(&self, _: &Machine) -> Result<SharedConnector, String> {
            Ok(Arc::new(self.0.clone()))
        }
    }

    const PANE_LIST: &str = r#"{"id":"cli:pane:list","result":{"panes":[
        {"agent_status":"working","agent":"claude","pane_id":"w27:p1","workspace_id":"w27"},
        {"agent_status":"unknown","pane_id":"w9:p1","workspace_id":"w9"}]}}"#;

    /// A server whose task 1 has the herdr workspace `w27` with the pane `w27:p1`, which
    /// shows `hello`; herdr lists its panes `tickets` times.
    fn server(tickets: usize) -> (SocketAddr, FakeHerdr, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::new(vec![Ok(PANE_LIST.to_owned()); tickets]));
        let herdr = FakeHerdr::with_pane("w27:p1", "hello");
        herdr.set_screen("w9:p1", "not a task");
        let services = services_with(
            temp.path(),
            Arc::new(Herdr::new(Box::new(runner))),
            Arc::new(FakeAccess(herdr.clone())),
        );
        {
            let mut storage = crate::commands::lock(&services.storage);
            let workspace = storage
                .create_workspace(&NewWorkspace {
                    name: "toodo".to_owned(),
                    location: WorkspaceLocation::Local {
                        path: PosixPath::parse("/srv/toodo").unwrap().into(),
                    },
                    default_base_branch: "main".to_owned(),
                })
                .unwrap();
            let task = storage
                .create_task(&NewTask {
                    workspace_id: workspace.id,
                    task_type: TaskType::Feat,
                    title: "Add login".to_owned(),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: Vec::new(),
                })
                .unwrap();
            storage.set_task_herdr_workspace(task.id, "w27").unwrap();
        }
        (serve(services, None), herdr, temp)
    }

    /// The status line and body of `POST /api/stream-tickets` for `pane` of task 1.
    fn request_ticket(address: SocketAddr, token: &str, pane: &str) -> (String, serde_json::Value) {
        let body = serde_json::json!({ "taskId": 1, "paneId": pane }).to_string();
        let (status, _, body) = exchange(
            address,
            &format!(
                "POST /api/stream-tickets HTTP/1.1\r\nAuthorization: Bearer {token}\r\n\
                 Content-Type: application/json\r\nContent-Length: {}",
                body.len()
            ),
            body.as_bytes(),
        );
        let body = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        (status, body)
    }

    type Socket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn connect(
        address: SocketAddr,
        ticket: &str,
        origin: &str,
    ) -> Result<Socket, tungstenite::Error> {
        let mut request = format!("ws://{address}/api/panes/stream?ticket={ticket}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
        Ok(tokio_tungstenite::connect_async(request).await?.0)
    }

    fn http_status(result: Result<Socket, tungstenite::Error>) -> u16 {
        match result {
            Err(tungstenite::Error::Http(response)) => response.status().as_u16(),
            Err(error) => panic!("{error}"),
            Ok(_) => 101,
        }
    }

    /// The next message from the server, within a few seconds.
    async fn next(socket: &mut Socket) -> serde_json::Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .expect("a message from the server")
                .expect("an open socket")
                .unwrap();
            if let tungstenite::Message::Text(text) = message {
                return serde_json::from_str(&text).unwrap();
            }
        }
    }

    async fn say(socket: &mut Socket, message: serde_json::Value) {
        socket
            .send(tungstenite::Message::Text(message.to_string().into()))
            .await
            .unwrap();
    }

    #[test]
    fn tickets_are_only_issued_for_panes_of_the_task_workspace() {
        let (address, _herdr, _temp) = server(2);
        let (status, body) = request_ticket(address, "web", "w9:p1");
        assert!(status.contains(" 404 "), "{status}");
        assert_eq!(body["kind"], "notFound");
        assert!(
            request_ticket(address, "agent", "w27:p1")
                .0
                .contains(" 401 ")
        );
        let (status, body) = request_ticket(address, "web", "w27:p1");
        assert!(status.contains(" 200 "), "{status}");
        assert_eq!(body["ticket"].as_str().unwrap().len(), 64);
        assert!(body["expiresAt"].as_i64().unwrap() > 0);
    }

    #[test]
    fn windows_machines_get_no_tickets() {
        let temp = tempfile::tempdir().unwrap();
        let machines =
            r#"[{"id":"m3","label":"winpc","target":"winpc","session":"default","enabled":true}]"#;
        let runner = Arc::new(FakeRunner::new(vec![
            Ok(machines.to_owned()),
            Ok(PANE_LIST.to_owned()),
        ]));
        let services = services_with(
            temp.path(),
            Arc::new(Herdr::new(Box::new(runner))),
            Arc::new(FakeAccess(FakeHerdr::with_pane("w27:p1", "hello"))),
        );
        {
            let mut storage = crate::commands::lock(&services.storage);
            let workspace = storage
                .create_workspace(&NewWorkspace {
                    name: "toodo".to_owned(),
                    location: WorkspaceLocation::Ssh {
                        machine: model::MachineLabel::parse("winpc").unwrap(),
                        path: WindowsPath::parse(r"D:\dev\toodo").unwrap().into(),
                    },
                    default_base_branch: "main".to_owned(),
                })
                .unwrap();
            let task = storage
                .create_task(&NewTask {
                    workspace_id: workspace.id,
                    task_type: TaskType::Feat,
                    title: "Add login".to_owned(),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: Vec::new(),
                })
                .unwrap();
            storage.set_task_herdr_workspace(task.id, "w27").unwrap();
        }
        let address = serve(services, None);
        let (status, body) = request_ticket(address, "web", "w27:p1");
        assert!(status.contains(" 409 "), "{status}");
        assert!(
            body["message"]
                .as_str()
                .unwrap()
                .contains("not available for the Windows machine winpc"),
            "{body}"
        );
    }

    #[test]
    fn a_pane_view_mirrors_the_pane_and_sends_input_only_under_control() {
        let (address, herdr, _temp) = server(2);
        let ticket = request_ticket(address, "web", "w27:p1").1["ticket"]
            .as_str()
            .unwrap()
            .to_owned();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // Other sites cannot use the ticket, and trying does not use it up.
            assert_eq!(
                http_status(connect(address, &ticket, "https://evil.example").await),
                403
            );
            let mut socket = connect(address, &ticket, &format!("http://{address}")).await.unwrap();
            let frame = next(&mut socket).await;
            assert_eq!(
                frame,
                serde_json::json!({ "type": "frame", "seq": 1, "cols": 80, "rows": 24, "ansi": "hello" })
            );

            say(&mut socket, serde_json::json!({ "type": "text", "text": "rm -rf\r" })).await;
            assert_eq!(next(&mut socket).await["type"], "error");
            assert!(herdr.input("w27:p1").is_empty());

            say(&mut socket, serde_json::json!({ "type": "control", "on": true })).await;
            assert_eq!(next(&mut socket).await, serde_json::json!({ "type": "control", "on": true }));
            say(&mut socket, serde_json::json!({ "type": "text", "text": "ls\r" })).await;
            say(&mut socket, serde_json::json!({ "type": "keys", "keys": ["esc"] })).await;
            herdr.set_screen("w27:p1", "hello\r\nls");
            // Messages are handled in order: once this is answered, the input was sent.
            say(&mut socket, serde_json::json!({ "type": "control", "on": false })).await;
            let mut frames = Vec::new();
            loop {
                let message = next(&mut socket).await;
                if message["type"] == "control" {
                    assert_eq!(message["on"], false);
                    break;
                }
                frames.push(message);
            }
            assert_eq!(herdr.input("w27:p1"), ["ls\r", "<esc>"]);
            let frame = match frames.pop() {
                Some(frame) => frame,
                None => next(&mut socket).await,
            };
            assert_eq!(frame["seq"], 2);
            assert_eq!(frame["ansi"], "hello\r\nls");

            // A ticket opens one stream only.
            assert_eq!(
                http_status(connect(address, &ticket, &format!("http://{address}")).await),
                401
            );

            herdr.close("w27:p1");
            let closed = next(&mut socket).await;
            assert_eq!(
                closed,
                serde_json::json!({ "type": "closed", "reason": "pane_closed" })
            );
        });
    }

    fn headers(entries: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in entries {
            headers.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        headers
    }

    #[test]
    fn only_the_servers_own_pages_may_open_streams() {
        let host = ("host", "toodo.example:8443");
        assert!(origin_allowed(&headers(&[host])));
        assert!(origin_allowed(&headers(&[
            host,
            ("origin", "https://toodo.example:8443")
        ])));
        assert!(!origin_allowed(&headers(&[
            host,
            ("origin", "http://tauri.localhost")
        ])));
        assert!(origin_allowed(&headers(&[
            ("host", "127.0.0.1:47616"),
            ("x-forwarded-host", "toodo.example"),
            ("origin", "https://toodo.example"),
        ])));
        assert!(!origin_allowed(&headers(&[
            host,
            ("origin", "https://evil.example")
        ])));
        assert!(!origin_allowed(&headers(&[
            host,
            ("origin", "https://toodo.example")
        ])));
        assert!(!origin_allowed(&headers(&[host, ("origin", "null")])));
    }
}
