//! MCP access to task records, dependencies, notes, references, and status history.
//! Tools share storage and announce record changes to connected clients.

pub(crate) mod attempts;
mod resources;
mod tools;

use std::fs;
use std::future::Future;
use std::io;
use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    InitializeRequestParams, InitializeResult, JsonObject, ListResourceTemplatesResult,
    ListResourcesResult, ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams,
    ReadResourceResponse, ReadResourceResult, ResourceContents, ServerCapabilities, ServerConfig,
    SubscriptionFilter,
};
use rmcp::service::{RequestContext, SubscriptionContext};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler, tool, tool_handler, tool_router};
use serde::Serialize;
use serde_json::Value;
use tower_http::add_extension::AddExtension;
use tower_http::timeout::RequestBodyTimeout;

use crate::commands::events::Notifier;
use crate::commands::types::Task;
use crate::commands::{CommandError, CommandErrorCode, CommandResult, StorageState, lock};
use crate::domain::model;
use crate::oauth::{self, PublicUrl};

pub(crate) const TOKEN_FILE: &str = "mcp-token";

/// Instruction text that the `initialize` instructions, the chat instructions, and the
/// skill share, kept in one file each so they cannot drift apart: [`render`] puts
/// `shared/<name>.md` where a template says `{{name}}`.
const SHARED: &[(&str, &str)] = &[
    ("completion", include_str!("shared/completion.md")),
    ("other-tasks", include_str!("shared/other-tasks.md")),
    (
        "task-description",
        include_str!("shared/task-description.md"),
    ),
    ("review-timing", include_str!("shared/review-timing.md")),
    ("merge-policy", include_str!("shared/merge-policy.md")),
    ("guidelines", include_str!("shared/guidelines.md")),
];

fn render(template: &str) -> String {
    SHARED
        .iter()
        .fold(template.to_owned(), |text, (name, fragment)| {
            text.replace(&format!("{{{{{name}}}}}"), fragment.trim_end())
        })
}

static SKILL: LazyLock<String> = LazyLock::new(|| render(include_str!("toodo-skill.md")));

static INSTRUCTIONS: LazyLock<String> = LazyLock::new(|| render(INSTRUCTIONS_TEMPLATE));

const INSTRUCTIONS_TEMPLATE: &str = "Toodo records tasks, dependencies, notes, references, and status history. Read read_toodo_skill before managing tasks.\n\n{{guidelines}}\n\nCall current_task with ref to find a task by one of its refs, or get_task with id. Call list_workspaces and search_tasks before creating work; reuse matching records and read related tasks for context.\n\nDependencies point from task_id to the prerequisite ids in depends_on. Reject cycles, complete prerequisites first, and use related links for context that does not block work. Adding an unfinished prerequisite pauses active work; resume_task when it becomes ready.\n\n{{task-description}}\n\n{{other-tasks}}\n\n{{completion}}\n\n{{review-timing}}\n\n{{merge-policy}}";

/// Storage, connection metadata, and change notifications for MCP tools.
pub trait Backend: Notifier + Send + Sync + 'static {
    fn public_url(&self) -> Option<&PublicUrl> {
        None
    }
    fn storage(&self) -> &StorageState;
    fn reader(&self) -> &StorageState {
        self.storage()
    }
    fn server(&self) -> &ServerStatus;
    fn changes(&self) -> tokio::sync::watch::Receiver<()>;
}

/// How agents reach the server, shown in the app; `error` tells why it is not running.
#[derive(Debug, Clone)]
pub struct ServerStatus {
    pub url: String,
    pub token: Option<String>,
    /// Tells this server apart from other Toodo servers, e.g. the one a tunnel or an old
    /// config reached instead; new on every start.
    pub instance: String,
    pub error: Option<String>,
    /// The last request `/mcp` turned away.
    pub rejections: Rejections,
}

/// Why a request was turned away with `401`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// The request has no `Authorization` header.
    NoHeader,
    /// The header is not `Bearer <token>`.
    NotBearer,
    /// The token is not one this surface accepts.
    WrongToken,
    /// The token is the one of the other surface: the web token at `/mcp`, or the MCP
    /// token at `/api`.
    OtherSurfaceToken,
}

/// Where a request was turned away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Surface {
    Mcp,
    Api,
}

/// The last request `/mcp` turned away, and how many it turned away since the start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LastRejection {
    pub reason: Rejection,
    /// Unix seconds.
    pub at: i64,
    pub count: u64,
}

/// Requests `/mcp` turned away, shared between the guard and the app's status.
#[derive(Debug, Clone, Default)]
pub struct Rejections(Arc<Mutex<Option<LastRejection>>>);

impl Rejections {
    fn record(&self, reason: Rejection) {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs() as i64);
        let mut last = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let count = last.map_or(0, |last| last.count) + 1;
        *last = Some(LastRejection { reason, at, count });
    }

    pub fn last(&self) -> Option<LastRejection> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A new [`ServerStatus::instance`].
pub(crate) fn new_instance() -> io::Result<String> {
    Ok(random_token()?[..12].to_owned())
}

/// The URL agents on this machine reach the server at when it listens on `port`.
pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

pub(crate) fn bind(address: SocketAddr) -> io::Result<TcpListener> {
    let listener = TcpListener::bind(address)?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// How long a client may take to send a request's headers, and to send each next piece of a
/// request body. A client that stalls longer is cut off, so a slow one cannot hold a
/// connection, or an upload being stored, open indefinitely.
pub(crate) const READ_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(30)
};

/// How long [`serve`] lets open requests finish once shutdown starts. Event streams never
/// end on their own, so without it one open browser tab would keep the server running.
pub(crate) const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(5);

/// Serves `app` on `listener` over HTTP/1.1 with [`READ_TIMEOUT`], giving handlers the
/// client's address as [`ConnectInfo`]. `axum::serve` gives hyper no timer, which leaves
/// hyper's header timeout off.
///
/// Once `shutdown` completes it stops accepting connections, closes idle ones, and waits
/// up to `deadline` for the requests in flight to be answered before it returns;
/// connections still open then end with the runtime.
pub(crate) async fn serve(
    listener: TcpListener,
    app: axum::Router,
    shutdown: impl Future<Output = ()>,
    deadline: Duration,
) -> io::Result<()> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let mut shutdown = std::pin::pin!(shutdown);
    // Dropping `stop` tells every connection to finish; `open` closes once all have.
    let (stop, stopping) = tokio::sync::watch::channel(());
    let (open, connection_open) = tokio::sync::watch::channel(());
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = &mut shutdown => break,
        };
        let (stream, remote) = match accepted {
            Ok(accepted) => accepted,
            Err(error) => {
                accept_failed(error).await;
                continue;
            }
        };
        let service = TowerToHyperService::new(RequestBodyTimeout::new(
            AddExtension::new(app.clone(), ConnectInfo(remote)),
            READ_TIMEOUT,
        ));
        let mut stopping = stopping.clone();
        let connection_open = connection_open.clone();
        tokio::spawn(async move {
            let connection = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(READ_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            let mut connection = std::pin::pin!(connection);
            // A connection that breaks off or times out only ends; the client sees it closed.
            tokio::select! {
                result = connection.as_mut() => drop(result),
                _ = stopping.changed() => {
                    connection.as_mut().graceful_shutdown();
                    drop(connection.await);
                }
            }
            drop(connection_open);
        });
    }
    drop(listener);
    drop(stop);
    drop(connection_open);
    if tokio::time::timeout(deadline, open.closed()).await.is_err() {
        eprintln!(
            "toodo-server: stopping with connections still open after {}s",
            deadline.as_secs_f32()
        );
    }
    Ok(())
}

/// Waits out an accept failure as `axum::serve` does: a connection that went away before
/// it was accepted is skipped, other errors (such as running out of file descriptors) are
/// logged and retried after a second.
async fn accept_failed(error: io::Error) {
    if matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    ) {
        return;
    }
    eprintln!("toodo-server: cannot accept a connection: {error}");
    tokio::time::sleep(Duration::from_secs(1)).await;
}

/// The token in `path`, created with 32 random bytes on first use. On Unix only the owner
/// may read it: a new file is created that way and an existing one is tightened. Creating
/// one is logged, since clients that kept an earlier token are turned away from then on.
pub(crate) fn load_token(path: &Path) -> io::Result<String> {
    let replaced = match fs::read_to_string(path) {
        Ok(token) if !token.trim().is_empty() => {
            make_private(path)?;
            return Ok(token.trim().to_owned());
        }
        Ok(_) => {
            fs::remove_file(path)?;
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    println!(
        "toodo-server: created a new access token in {}{}; clients that use an earlier \
         token get 401 until they are given this one",
        path.display(),
        if replaced {
            " (the file was empty)"
        } else {
            ""
        }
    );
    let token = random_token()?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    io::Write::write_all(&mut options.open(path)?, token.as_bytes())?;
    Ok(token)
}

/// 32 random bytes, in hex.
pub(crate) fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(unix)]
pub(crate) fn make_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
pub(crate) fn make_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// The MCP endpoint at `/mcp`, open only to requests that bear `token`. A request that
/// bears `web_token` instead is told it sent the web token.
pub(crate) fn router(
    backend: Arc<dyn Backend>,
    token: String,
    web_token: Option<String>,
) -> axum::Router {
    let mut config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true);
    if let Some(issuer) = backend.public_url() {
        let url = reqwest::Url::parse(issuer.as_str()).expect("validated public URL");
        config
            .allowed_hosts
            .push(url.host_str().unwrap().to_owned());
        config
            .allowed_hosts
            .push(issuer.as_str().split_once("://").unwrap().1.to_owned());
    }
    let guard = Arc::new(Guard {
        token,
        web_token,
        backend: backend.clone(),
        attempts: attempts::FailedAttempts::default(),
    });
    let service = StreamableHttpService::new(
        move || Ok(ToodoMcp::new(backend.clone())),
        LocalSessionManager::default().into(),
        config,
    );
    axum::Router::new()
        .nest_service("/mcp", service)
        .route_layer(middleware::from_fn_with_state(guard, require_token))
}

struct Guard {
    token: String,
    web_token: Option<String>,
    backend: Arc<dyn Backend>,
    attempts: attempts::FailedAttempts,
}

/// Lets requests through that bear the MCP token; the others get `401` with the reason,
/// which is also kept for the app to show. An address that sent too many wrong tokens
/// gets `429` until it may try again (see [`attempts`]).
async fn require_token(
    State(guard): State<Arc<Guard>>,
    mut request: Request,
    next: Next,
) -> Response {
    let public_url = guard.backend.public_url();
    if public_url.is_none()
        && !request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .is_some_and(|ConnectInfo(peer)| match peer.ip() {
                std::net::IpAddr::V4(ip) => ip.is_loopback(),
                std::net::IpAddr::V6(ip) => ip
                    .to_ipv4_mapped()
                    .map_or(ip.is_loopback(), |ip| ip.is_loopback()),
            })
    {
        return (
            StatusCode::FORBIDDEN,
            "Connect through loopback or an SSH tunnel, or set TOODO_PUBLIC_URL to enable remote MCP access.",
        )
            .into_response();
    }
    let peer = attempts::peer(request.extensions());
    if let Some(wait) = guard.attempts.locked_out(peer) {
        return attempts::too_many("MCP", wait);
    }
    let rejection = match bearer(request.headers()) {
        Ok(presented) if same_secret(presented, &guard.token) => {
            request.extensions_mut().insert(Access::Static);
            return next.run(request).await;
        }
        Ok(presented) if public_url.is_some() => {
            match oauth::resolve_access_token(guard.backend.storage(), presented) {
                Ok(Some(grant)) => {
                    request.extensions_mut().insert(Access::OAuth(grant));
                    return next.run(request).await;
                }
                Err(error) => {
                    eprintln!("toodo: failed to look up an MCP OAuth access token: {error}");
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Reconnect from the app after the server database is available.",
                    )
                        .into_response();
                }
                Ok(None) => {}
            }
            if guard
                .web_token
                .as_deref()
                .is_some_and(|web| same_secret(presented, web))
            {
                Rejection::OtherSurfaceToken
            } else {
                Rejection::WrongToken
            }
        }
        Ok(presented)
            if guard
                .web_token
                .as_deref()
                .is_some_and(|web| same_secret(presented, web)) =>
        {
            Rejection::OtherSurfaceToken
        }
        Ok(_) => Rejection::WrongToken,
        Err(rejection) => rejection,
    };
    if rejection == Rejection::WrongToken {
        guard.attempts.record(peer);
    }
    let server = guard.backend.server();
    server.rejections.record(rejection);
    let mut response = unauthorized(Surface::Mcp, rejection, Some(&server.instance));
    if let Some(issuer) = public_url {
        let invalid = if bearer(request.headers()).is_ok() {
            ", error=\"invalid_token\""
        } else {
            ""
        };
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            format!("Bearer resource_metadata=\"{issuer}/.well-known/oauth-protected-resource/mcp\"{invalid}")
                .parse().expect("validated public URL header"),
        );
    }
    response
}

/// Authentication carried through rmcp's HTTP request parts on every request.
#[derive(Clone, Debug)]
pub enum Access {
    Static,
    OAuth(oauth::LiveGrant),
}

impl Access {
    fn of(context: &RequestContext<RoleServer>) -> Option<&Self> {
        context
            .extensions
            .get::<axum::http::request::Parts>()?
            .extensions
            .get()
    }

    fn check_tool(&self, name: &str) -> Result<(), String> {
        let Self::OAuth(grant) = self else {
            return Ok(());
        };
        let scopes = grant.scopes;
        let allowed = match name {
            "read_toodo_skill" | "list_workspaces" | "list_tasks" | "search_tasks" | "get_task"
            | "get_guidelines" | "review_report" => scopes.can_read(),
            "create_workspace" | "create_task" | "create_plan" | "update_task" | "move_task"
            | "add_dependency" | "remove_dependency" | "add_related" | "remove_related"
            | "add_criterion" | "remove_criterion" | "check_criterion" | "add_progress_note"
            | "report_blocker" | "pause_task" | "wait_task" | "add_guideline"
            | "update_guideline" | "remove_guideline" => scopes.can_write(),
            _ => {
                return Err(format!(
                    "{name} is local-only; use the Toodo app or a local agent with the MCP token."
                ));
            }
        };
        if allowed {
            Ok(())
        } else {
            Err(format!(
                "{name} requires toodo.write; reconnect from the app and approve that scope."
            ))
        }
    }
}

static CHAT_INSTRUCTIONS: LazyLock<String> = LazyLock::new(|| render(CHAT_TEMPLATE));

const CHAT_TEMPLATE: &str = "Plan tasks and record progress, decisions and blockers in Toodo. Use list_workspaces, search_tasks and get_task before creating records. {{task-description}} {{guidelines}}";

/// The bearer token of a request's `Authorization` header; the scheme is matched without
/// regard to case, as HTTP defines it.
pub(crate) fn bearer(headers: &axum::http::HeaderMap) -> Result<&str, Rejection> {
    let value = headers
        .get(header::AUTHORIZATION)
        .ok_or(Rejection::NoHeader)?
        .to_str()
        .map_err(|_| Rejection::NotBearer)?;
    match value.trim().split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") => {
            let token = token.trim();
            if token.is_empty() {
                Err(Rejection::NotBearer)
            } else {
                Ok(token)
            }
        }
        _ => Err(Rejection::NotBearer),
    }
}

/// `401` with the reason and how to get through, never the token itself; at `/mcp`,
/// with the server's `instance`.
pub(crate) fn unauthorized(
    surface: Surface,
    rejection: Rejection,
    instance: Option<&str>,
) -> Response {
    let mut body = rejection_message(surface, rejection).to_owned();
    if let Some(instance) = instance {
        body.push_str(&format!("\nThis is Toodo server instance {instance}."));
    }
    body.push('\n');
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        body,
    )
        .into_response()
}

fn rejection_message(surface: Surface, rejection: Rejection) -> &'static str {
    match (surface, rejection) {
        (Surface::Mcp, Rejection::NoHeader) => {
            "Toodo MCP: the request has no Authorization header. Send \
             `Authorization: Bearer <MCP token>`: copy the MCP config from Settings > Agent \
             access in the Toodo app, or use the token in `mcp-token` in the server's data \
             directory."
        }
        (Surface::Mcp, Rejection::NotBearer) => {
            "Toodo MCP: the Authorization header is not `Bearer <token>`. Send \
             `Authorization: Bearer <MCP token>` with the token alone, without quotes: copy \
             the MCP config from Settings > Agent access in the Toodo app, or use the token \
             in `mcp-token` in the server's data directory."
        }
        (Surface::Mcp, Rejection::WrongToken) => {
            "Toodo MCP: this server does not accept the token. It is mistyped, from before \
             the token was replaced, or from another Toodo server, so retrying with it fails \
             again. Copy the MCP config again from Settings > Agent access of the Toodo app \
             that shows the instance below, or use the token in `mcp-token` in this \
             server's data directory, then restart the agent session with it."
        }
        (Surface::Mcp, Rejection::OtherSurfaceToken) => {
            "Toodo MCP: this is the web sign-in token (`web-token`), which only the web app \
             uses. Agents send the MCP token: copy the MCP config from Settings > Agent \
             access in the Toodo app, or use the token in `mcp-token` in the server's data \
             directory."
        }
        (Surface::Api, Rejection::NoHeader) => {
            "Toodo API: the request has no Authorization header. Send \
             `Authorization: Bearer <token>` with the web sign-in token (`web-token` in the \
             server's data directory) or a device token; the web app asks for `web-token` \
             when it signs in."
        }
        (Surface::Api, Rejection::NotBearer) => {
            "Toodo API: the Authorization header is not `Bearer <token>`. Send \
             `Authorization: Bearer <token>` with the web sign-in token (`web-token` in the \
             server's data directory) or a device token, alone and without quotes."
        }
        (Surface::Api, Rejection::WrongToken) => {
            "Toodo API: the token is neither the web sign-in token nor the token of an \
             active device; the device may be revoked or the token replaced. Sign in to the \
             web app again with the token in `web-token` in the server's data directory."
        }
        (Surface::Api, Rejection::OtherSurfaceToken) => {
            "Toodo API: this is the MCP token for agents, which only `/mcp` accepts. Send \
             the web sign-in token (`web-token` in the server's data directory) or a device \
             token here, and use the MCP token only in an agent's MCP config."
        }
    }
}

/// Compares without stopping at the first difference, so timing does not leak the token.
pub(crate) fn same_secret(presented: &str, token: &str) -> bool {
    presented.len() == token.len()
        && presented
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

#[derive(Clone)]
struct ToodoMcp {
    backend: Arc<dyn Backend>,
    tool_router: ToolRouter<Self>,
    /// The watch of the `subscriptions/listen` request this instance serves, from its
    /// acceptance until `listen` takes it; each HTTP request gets its own instance.
    watch: Arc<Mutex<Option<resources::Watch>>>,
}

#[tool_router]
impl ToodoMcp {
    fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            tool_router: Self::tool_router(),
            watch: Arc::default(),
        }
    }

    /// Runs a tool that changes a task and announces the change to the frontend.
    async fn change(
        &self,
        apply: impl FnOnce(&mut crate::storage::Storage) -> CommandResult<Task> + Send + 'static,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| apply(&mut lock(backend.storage())))
            .await;
        self.announce(result)
    }

    /// Runs `apply` on the backend off the async threads, since it waits on the database and,
    /// for URL criteria, on an HTTP GET; see [`crate::commands::blocking`]. Every tool that
    /// reads or writes storage goes through here.
    async fn blocking<T: Send + 'static>(
        &self,
        apply: impl FnOnce(&dyn Backend) -> CommandResult<T> + Send + 'static,
    ) -> CommandResult<T> {
        let backend = self.backend.clone();
        crate::commands::blocking(move || apply(backend.as_ref())).await
    }

    /// Tells the frontend that the links of a task changed.
    fn announce_links(&self, result: &CommandResult<tools::TaskDetails>) {
        if let Ok(details) = result {
            self.backend
                .tasks_changed(model::WorkspaceId(details.task.workspace_id.0));
        }
    }

    /// Tells the frontend that the guidelines of a workspace changed.
    fn announce_guideline(
        &self,
        result: CommandResult<crate::commands::types::Guideline>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Ok(guideline) = &result {
            self.backend
                .guidelines_changed(model::WorkspaceId(guideline.workspace_id.0));
        }
        reply(result)
    }

    fn announce(&self, result: CommandResult<Task>) -> Result<CallToolResult, ErrorData> {
        self.announce_with(result, |task| task)
    }

    /// Announces the task of a confirmed change; a call without `confirm` changed nothing.
    fn announce_confirmed(
        &self,
        result: CommandResult<tools::Confirmation>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Ok(change) = &result
            && change.confirmed
        {
            self.backend
                .tasks_changed(model::WorkspaceId(change.task.workspace_id.0));
        }
        reply(result)
    }

    /// [`Self::announce`] for a reply that carries the changed task, which `task` picks.
    fn announce_with<T: Serialize>(
        &self,
        result: CommandResult<T>,
        task: impl FnOnce(&T) -> &Task,
    ) -> Result<CallToolResult, ErrorData> {
        if let Ok(changed) = &result {
            self.backend
                .tasks_changed(model::WorkspaceId(task(changed).workspace_id.0));
        }
        reply(result)
    }

    #[tool(
        description = "Read instructions for managing tasks, notes, dependencies, references, and status."
    )]
    fn read_toodo_skill(&self) -> Result<CallToolResult, ErrorData> {
        Ok(CallToolResult::success(vec![ContentBlock::text(
            SKILL.as_str(),
        )]))
    }

    #[tool(description = "List workspace records.")]
    async fn list_workspaces(&self) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(|backend| tools::list_workspaces(&lock(backend.reader())))
                .await,
        )
    }

    #[tool(
        description = "Create a workspace record using its supplied settings. Call list_workspaces first to reuse an existing workspace."
    )]
    async fn create_workspace(
        &self,
        Parameters(request): Parameters<tools::CreateWorkspace>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::create_workspace(backend.storage(), request))
            .await;
        if result.is_ok() {
            self.backend.workspaces_changed();
        }
        reply(result)
    }

    #[tool(description = "Update supplied workspace settings while keeping omitted values.")]
    async fn update_workspace(
        &self,
        Parameters(request): Parameters<tools::UpdateWorkspace>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::update_workspace(backend.storage(), request))
            .await;
        if result.is_ok() {
            self.backend.workspaces_changed();
        }
        reply(result)
    }

    #[tool(
        description = "Archive a workspace and its tasks with confirm true after inspecting the confirmation response. Finish or pause active tasks first."
    )]
    async fn archive_workspace(
        &self,
        Parameters(request): Parameters<tools::ArchiveWorkspace>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::archive_workspace(&mut lock(backend.storage()), request)
            })
            .await;
        if let Ok(change) = &result
            && change.confirmed
        {
            self.backend.workspaces_changed();
        }
        reply(result)
    }

    #[tool(
        description = "List tasks with status and depends_on, of one workspace or of all workspaces, by ascending ID. Each task has ready (planned, not waiting until a time, and nothing blocks it, so start_task or resume_task can begin it now) and blockedBy: the tasks it depends on that are not done yet, or done as not_adopted, which never unblocks it. Narrow the list to keep it short: status (e.g. [\"planned\", \"in_progress\"]), ready (true for tasks to start now), autopilot (true for tasks marked for autopilot), and limit (the newest matching tasks). When a page holds limit tasks, pass its first ID as before_id to read older ones."
    )]
    async fn list_tasks(
        &self,
        Parameters(request): Parameters<tools::ListTasks>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(move |backend| tools::list_tasks(&lock(backend.reader()), request))
                .await,
        )
    }

    #[tool(
        description = "Search tasks of all workspaces (or one) by words in their title, description, notes, completion note, branch, refs, and pull request, best match first. Every word must appear, as a substring in any language; words are literal, not operators. A task number alone (431 or #431) returns that task first, in any workspace. Use it before planning or create_task to find earlier tasks on the same subject, then get_task to read what was decided. Each result lists its depends_on, dependents, and related task IDs."
    )]
    async fn search_tasks(
        &self,
        Parameters(request): Parameters<tools::SearchTasks>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(move |backend| tools::search_tasks(&lock(backend.reader()), request))
                .await,
        )
    }

    #[tool(
        description = "Read one task with its whole history: description, refs, status timeline with the reasons given for starts, pauses, and completions, progress, decision, and blocker notes, completion note (the conclusion of a task done as not_adopted), pull request, commits, and the tasks it depends on, that depend on it, and that are related to it (id, title, status). ready says whether it can start (or resume) now, and blockedBy which of the tasks it depends on keep it from that: not done yet, or done as not_adopted, which never unblocks it. Use it to learn what an earlier task decided, and follow its links with further get_task calls. guidelines lists the guidelines of the task's workspace: follow its rules and read its memories before working on the task."
    )]
    async fn get_task(
        &self,
        Parameters(request): Parameters<tools::GetTask>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(move |backend| tools::task_details(&lock(backend.reader()), request))
                .await,
        )
    }

    #[tool(
        description = "Read the guidelines of a workspace: rules its owner sets, which you must follow, then memories, durable lessons and facts recorded for it, each by ascending id. Read them before working on a task of the workspace; start_task and get_task already include them. Returns {workspace: {id, name}, guidelines}."
    )]
    async fn get_guidelines(
        &self,
        Parameters(request): Parameters<tools::GetGuidelines>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(move |backend| tools::get_guidelines(&lock(backend.reader()), request))
                .await,
        )
    }

    #[tool(
        description = "Add a guideline to a workspace, e.g. {\"workspace_id\": 1, \"body\": \"Run cargo test with CARGO_BUILD_JOBS=2\"}. Record a durable lesson or fact that later work in the workspace should know as kind memory, the default. Rules are set by the owner: add kind rule only when the user asks for it. Returns the guideline."
    )]
    async fn add_guideline(
        &self,
        Parameters(request): Parameters<tools::AddGuideline>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::add_guideline(backend.storage(), request))
            .await;
        self.announce_guideline(result)
    }

    #[tool(
        description = "Change the supplied kind and body of a guideline, keeping omitted values. Update a memory that became wrong or incomplete; do not rewrite a rule unless the user asks. Returns the guideline."
    )]
    async fn update_guideline(
        &self,
        Parameters(request): Parameters<tools::UpdateGuideline>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::update_guideline(backend.storage(), request))
            .await;
        self.announce_guideline(result)
    }

    #[tool(
        description = "Remove a guideline, e.g. a memory that no longer holds. Do not remove a rule unless the user asks. Returns the guideline as it was."
    )]
    async fn remove_guideline(
        &self,
        Parameters(request): Parameters<tools::RemoveGuideline>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::remove_guideline(backend.storage(), request))
            .await;
        self.announce_guideline(result)
    }

    #[tool(
        description = "Link two tasks, from any workspaces, as related: context worth reading together, e.g. an earlier task whose decisions a new one builds on. The link goes both ways and never blocks either task; for work that must be done first, use add_dependency instead. Returns task_id's details."
    )]
    async fn add_related(
        &self,
        Parameters(request): Parameters<tools::Related>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::add_related(&mut lock(backend.storage()), request))
            .await;
        self.announce_links(&result);
        reply(result)
    }

    #[tool(
        description = "Remove the related link between two tasks, given in either order. A link that does not exist is rejected. Returns task_id's details."
    )]
    async fn remove_related(
        &self,
        Parameters(request): Parameters<tools::Related>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::remove_related(&mut lock(backend.storage()), request))
            .await;
        self.announce_links(&result);
        reply(result)
    }

    #[tool(
        description = "Find a task by ref, a stored reference string. Omit ref only to receive instructions to use ref or get_task with id."
    )]
    async fn current_task(
        &self,
        Parameters(request): Parameters<tools::CurrentTask>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(move |backend| tools::current_task(&lock(backend.reader()), request))
                .await,
        )
    }

    #[tool(
        description = "Create a planned task in a workspace with its completion criteria, optionally depending on existing tasks (depends_on) and related to others (related). Criteria are manual, checked by a person or the executor with evidence, or url, an HTTP GET of the target that passes on a 2xx response; the task gets no other criterion."
    )]
    async fn create_task(
        &self,
        Parameters(request): Parameters<tools::CreateTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::create_task(backend.storage(), request))
            .await;
        self.announce(result)
    }

    #[tool(
        description = "Create a whole plan of tasks in one call, all or nothing: each task takes the fields of create_task plus a key unique in the plan, e.g. \"schema\", and links to other tasks of the plan by key in depends_on_keys and related_keys, to existing tasks by id in depends_on and related. Keys, links, criteria, and labels are checked first; a failure in any task, an unknown key or task, or depends_on_keys that form a cycle creates no task at all. Returns {tasks}: the created tasks in the order given, each with its key."
    )]
    async fn create_plan(
        &self,
        Parameters(request): Parameters<tools::CreatePlan>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::create_plan(backend.storage(), request))
            .await;
        if let Ok(plan) = &result {
            let workspaces: std::collections::BTreeSet<i64> = plan
                .tasks
                .iter()
                .map(|planned| planned.task.workspace_id.0)
                .collect();
            for workspace in workspaces {
                self.backend.tasks_changed(model::WorkspaceId(workspace));
            }
        }
        reply(result)
    }

    #[tool(
        description = "Check (met true, the default) or uncheck a manual completion criterion of a task that is not done, with evidence of what shows it holds, e.g. {\"criterion_id\": 2, \"evidence\": \"...\"}. criterion_id (or id) alone finds its task; task_id is optional and must be that task when given. Toodo checks the other kinds itself. Once every criterion of an in_progress task is met, it awaits completion (in_review) until the user, or complete_task, confirms it. Returns the task with its criteria."
    )]
    async fn check_criterion(
        &self,
        Parameters(request): Parameters<tools::CheckCriterion>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(move |storage| tools::check_criterion(storage, request))
            .await
    }

    #[tool(
        description = "Add a completion criterion to an unfinished task. Use manual or url with target."
    )]
    async fn add_criterion(
        &self,
        Parameters(request): Parameters<tools::AddCriterion>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::add_criterion(&mut lock(backend.storage()), request))
            .await;
        self.announce(result)
    }

    #[tool(
        description = "Remove a criterion from an unfinished task with criterion_id. Read get_task first to inspect its criteria."
    )]
    async fn remove_criterion(
        &self,
        Parameters(request): Parameters<tools::RemoveCriterion>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(move |storage| tools::remove_criterion(storage, request))
            .await
    }

    #[tool(
        description = "Change supplied task fields and append or remove refs. Set status in_review when work awaits review. Use lifecycle tools for other status changes."
    )]
    async fn update_task(
        &self,
        Parameters(request): Parameters<tools::UpdateTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::update_task(&mut lock(backend.storage()), request))
            .await;
        self.announce(result)
    }

    #[tool(
        description = "Move a task, in any status, into another workspace, e.g. {\"id\": 12, \"workspace_id\": 3}. Only its workspace changes: its id, status history, notes, criteria, refs, and dependency and related links stay. Refs such as branch:, lane:, or pr: are kept as recorded; Toodo creates no branch or worktree, so update them with update_task if the executor moves that work. Criteria are manual or url and do not depend on the workspace. The task follows the guidelines of its new workspace: read get_guidelines for it. An archived or unknown workspace is rejected."
    )]
    async fn move_task(
        &self,
        Parameters(request): Parameters<tools::MoveTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::move_task(&mut lock(backend.storage()), request))
            .await;
        if let Ok(moved) = &result {
            self.backend
                .tasks_changed(model::WorkspaceId(moved.from_workspace_id.0));
        }
        self.announce_with(result, |moved| &moved.task)
    }

    #[tool(
        description = "Make task_id depend on depends_on. Cycles are rejected. An unfinished prerequisite pauses an in_progress task; resume_task when ready."
    )]
    async fn add_dependency(
        &self,
        Parameters(request): Parameters<tools::AddDependencies>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::add_dependencies(&mut lock(backend.storage()), request))
            .await;
        self.announce_with(result, |reply| &reply.task.task)
    }

    #[tool(
        description = "Record progress or a decision (what and why) on a task's history, e.g. your current task. Call it at every milestone of your task: when you start (your plan, before your first edit), when you take a decision (kind \"decision\", which the app and reviews list apart as the task's decisions), when you finish a meaningful step, and when you open the pull request (with its URL); use report_blocker for what stops you. task_id is a number, e.g. {\"task_id\": 5, \"note\": \"Plan: ...\"} or {\"task_id\": 5, \"kind\": \"decision\", \"note\": \"Chose SQLite over files: ...\"}; kind is progress when omitted. When the call is rejected, fix the arguments and call it again. Returns the task with its notes."
    )]
    async fn add_progress_note(
        &self,
        Parameters(request): Parameters<tools::AddProgressNote>,
    ) -> Result<CallToolResult, ErrorData> {
        let (kind, note) = request.into_note();
        self.change(move |storage| tools::add_note(storage, kind, note))
            .await
    }

    #[tool(
        description = "Record on a task's history what blocks the work on it and what is needed to continue. Does not change the task's status. Returns the task with its notes."
    )]
    async fn report_blocker(
        &self,
        Parameters(request): Parameters<tools::AddNote>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(move |storage| tools::add_note(storage, model::NoteKind::Blocker, request))
            .await
    }

    #[tool(
        description = "Pause an in_progress or in_review task with a required non-empty reason, e.g. {\"id\": 5, \"reason\": \"Waiting for the API design\"}. The task moves back to planned and shows as paused; the reason is recorded in its status history and notes. To wait for other tasks, use add_dependency, then resume_task when its prerequisites are done. Returns the task with its notes."
    )]
    async fn pause_task(
        &self,
        Parameters(request): Parameters<tools::PauseTask>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(move |storage| tools::pause_task(storage, request))
            .await
    }

    #[tool(
        description = "Make a planned, in_progress, or in_review task wait until a time, e.g. {\"id\": 5, \"until\": \"2026-11-10T09:00:00+09:00\", \"reason\": \"Waiting for the vendor's reply\"}. An active task is paused (planned) until then; when the time passes Toodo returns it to the status it had, also after a server restart. Call again on a waiting task to move the time; call end_wait to return it now. Returns the task; its wait shows until and the status it returns to."
    )]
    async fn wait_task(
        &self,
        Parameters(request): Parameters<tools::WaitTask>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(move |storage| tools::wait_task(storage, request))
            .await
    }

    #[tool(
        description = "End the wait of a waiting task now, e.g. {\"id\": 5}: it returns to the status it had when the wait began, as when the time passes. A task that was in_progress stays paused while a prerequisite is not done. An optional note records why. Returns the task."
    )]
    async fn end_wait(
        &self,
        Parameters(request): Parameters<tools::EndWait>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(move |storage| tools::end_wait(storage, request))
            .await
    }

    #[tool(
        description = "Resume a previously started planned task whose prerequisites are complete. An optional note records why work resumes."
    )]
    async fn resume_task(
        &self,
        Parameters(request): Parameters<tools::ResumeTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::resume_task(backend.storage(), request))
            .await;
        self.announce(result)
    }

    #[tool(
        description = "Archive a planned or done (completed or concluded) task with confirm true after inspecting the confirmation response; history stays in review_report and the user can restore it. Pause active work first."
    )]
    async fn delete_task(
        &self,
        Parameters(request): Parameters<tools::DeleteTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::delete_task(backend.storage(), request))
            .await;
        self.announce_confirmed(result)
    }

    #[tool(
        description = "Archive every done (completed or concluded) task of a workspace, e.g. {\"workspace_id\": 1}. Without confirm nothing changes and the reply lists the tasks it would archive; call again with confirm true to archive them. History stays in review_report and the user can restore them."
    )]
    async fn delete_done_tasks(
        &self,
        Parameters(request): Parameters<tools::DeleteDoneTasks>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::delete_done_tasks(&mut lock(backend.storage()), request)
            })
            .await;
        if let Ok(change) = &result
            && change.confirmed
        {
            self.backend
                .tasks_changed(model::WorkspaceId(change.workspace_id.0));
        }
        reply(result)
    }

    #[tool(
        description = "Reopen a done task with a reason and confirm true. Earlier outcomes remain in its notes."
    )]
    async fn reopen_task(
        &self,
        Parameters(request): Parameters<tools::ReopenTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::reopen_task(&mut lock(backend.storage()), request))
            .await;
        self.announce_confirmed(result)
    }

    #[tool(
        description = "Record the start of a ready planned task: move it to in_progress, record reason in its status history, and append refs. Unfinished prerequisites must be completed with complete_task first. The reply carries guidelines, the guidelines of the task's workspace: follow its rules and read its memories before you work."
    )]
    async fn start_task(
        &self,
        Parameters(request): Parameters<tools::StartTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::start_task(backend.storage(), request))
            .await;
        self.announce_with(result, |started| &started.task)
    }

    #[tool(
        description = "Complete an active task after manual criteria and URL checks succeed. Record an optional note and append refs."
    )]
    async fn complete_task(
        &self,
        Parameters(request): Parameters<tools::CompleteTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::complete_task(backend.storage(), request))
            .await;
        self.announce(result)
    }

    #[tool(
        description = "Record an outcome with a required note, also for a planned task that was never started. Use not_adopted to leave dependents blocked, or shipped_with and a completed task id in shipped_with."
    )]
    async fn conclude_task(
        &self,
        Parameters(request): Parameters<tools::ConcludeTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::conclude_task(backend.storage(), request))
            .await;
        self.announce_with(result, |concluded| &concluded.task)
    }

    #[tool(
        description = "Remove the dependency of task_id on every task in depends_on, one task id or an array, e.g. {\"task_id\": 5, \"depends_on\": 3}. A dependency that does not exist is rejected, and so is a done task_id (reopen_task it first); then none is removed. Returns {task, paused, message} like add_dependency; message says whether the task is now ready, e.g. a paused task that resume_task can resume."
    )]
    async fn remove_dependency(
        &self,
        Parameters(request): Parameters<tools::Dependency>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::remove_dependency(&mut lock(backend.storage()), request)
            })
            .await;
        self.announce_with(result, |reply| &reply.task.task)
    }

    #[tool(
        description = "Render the review of a period across all workspaces (or one workspace or label) as Markdown (the default) or CSV, the same report the Toodo app's Review exports: a summary of outcomes, commits, durations, plan vs actual, late tasks, a Year in review for a year, and each task under its outcome with its pull request, notes, and commits. period is week (from its Monday, or from from), month, quarter, year, or custom (from and to, both included); date (YYYY-MM-DD) picks the period containing that day, today when omitted. Days and times are in time_zone (IANA, e.g. Europe/Berlin), the server's when omitted. e.g. {\"period\": \"week\"} or {\"period\": \"year\", \"date\": \"2026-01-01\", \"format\": \"csv\"}. Returns {fileName, mediaType, from, to, contents}."
    )]
    async fn review_report(
        &self,
        Parameters(request): Parameters<tools::ReviewReportRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(move |backend| tools::review_report(&lock(backend.reader()), request))
                .await,
        )
    }

    #[tool(
        description = "Read the chat messages people sent in the Toodo app that you have not received yet, oldest first, without marking them received; take_pending marks them."
    )]
    async fn peek_pending(&self) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(|backend| tools::pending_chat(&mut lock(backend.storage()), false))
                .await,
        )
    }

    #[tool(
        description = "Take the chat messages people sent in the Toodo app that you have not received yet, oldest first, and mark them received, so the next call returns only newer ones. Then ack_chat them, answer with reply_in_chat (handles marks them handled), or mark_chat_handled them with the task you made. A message not handled within 10 minutes shows overdue."
    )]
    async fn take_pending(&self) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(|backend| tools::pending_chat(&mut lock(backend.storage()), true))
            .await;
        if let Ok(taken) = &result
            && !taken.is_empty()
        {
            self.backend.chat_changed();
        }
        reply(result)
    }

    #[tool(
        description = "Post a message to the people in the Toodo app chat; they get it at once and as a push notification. handles lists the IDs of their messages it answers, which are marked handled by it. Returns the posted message."
    )]
    async fn reply_in_chat(
        &self,
        Parameters(request): Parameters<tools::ReplyInChat>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::reply_in_chat(&mut lock(backend.storage()), request))
            .await;
        if let Ok(message) = &result {
            self.backend.agent_posted(&message.body);
        }
        reply(result)
    }

    #[tool(
        description = "Acknowledge people's chat messages by ID, telling them you read them before you answer; all or none. Acknowledging one again keeps its first receipt."
    )]
    async fn ack_chat(
        &self,
        Parameters(request): Parameters<tools::AckChat>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::ack_chat(&mut lock(backend.storage()), request))
            .await;
        if result.is_ok() {
            self.backend.chat_changed();
        }
        reply(result)
    }

    #[tool(
        description = "Mark a person's chat message handled, with the reply_id of your reply or the task_id of the task you created or updated for it; it is acknowledged too if it was not yet."
    )]
    async fn mark_chat_handled(
        &self,
        Parameters(request): Parameters<tools::MarkChatHandled>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::mark_chat_handled(&mut lock(backend.storage()), request)
            })
            .await;
        if result.is_ok() {
            self.backend.chat_changed();
        }
        reply(result)
    }

    #[tool(
        description = "List the latest chat messages of people, you (author agent) and Toodo (author system), oldest first, with the receipts of people's messages; before pages back."
    )]
    async fn list_chat(
        &self,
        Parameters(request): Parameters<tools::ListChat>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            self.blocking(move |backend| tools::list_chat(&lock(backend.reader()), request))
                .await,
        )
    }

    #[tool(
        description = "Show the people in the Toodo app chat that you are writing a reply (typing true), or stop showing it (false). It lapses after 30 seconds unless you send it again, and posting a reply ends it."
    )]
    async fn set_typing(
        &self,
        Parameters(request): Parameters<tools::SetTyping>,
    ) -> Result<CallToolResult, ErrorData> {
        self.backend.agent_typing(request.typing);
        reply(Ok(tools::Typing {
            typing: request.typing,
        }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ToodoMcp {
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        context.peer.set_peer_info(request.clone());
        let mut result = self.negotiate_initialize(&request)?;
        // Clients that initialize speak a protocol before 2026-07-28, whose notifications
        // need a session; this server keeps none, so they can read resources but not
        // subscribe to them.
        if let Some(resources) = result.capabilities.resources.as_mut() {
            resources.subscribe = None;
            resources.list_changed = None;
        }
        if matches!(Access::of(&context), Some(Access::OAuth(_))) {
            result.instructions = Some(CHAT_INSTRUCTIONS.clone());
        }
        Ok(result)
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let access = Access::of(&context);
        let tools = self
            .tool_router
            .list_all()
            .into_iter()
            .filter(|tool| access.is_none_or(|access| access.check_tool(&tool.name).is_ok()))
            .collect();
        Ok(ListToolsResult {
            tools,
            ..Default::default()
        })
    }

    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        check_read(&context)?;
        let resources = self
            .blocking(|backend| resources::list(&lock(backend.reader())))
            .await
            .map_err(internal)?;
        Ok(ListResourcesResult::with_all_items(resources))
    }

    async fn list_resource_templates(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        check_read(&context)?;
        Ok(ListResourceTemplatesResult::with_all_items(
            resources::templates(),
        ))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        check_read(&context)?;
        let not_found = || ErrorData::resource_not_found(resources::unknown(&request.uri), None);
        let uri = resources::Uri::parse(&request.uri).ok_or_else(not_found)?;
        match self
            .blocking(move |backend| resources::read(&lock(backend.reader()), uri))
            .await
        {
            Ok(text) => Ok(ReadResourceResult::new(vec![
                ResourceContents::text(text, request.uri.clone())
                    .with_mime_type("application/json"),
            ])
            .into()),
            Err(error) if error.code == CommandErrorCode::TaskNotFound => Err(not_found()),
            Err(error) => Err(internal(error)),
        }
    }

    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        let uris = requested
            .resource_subscriptions
            .iter()
            .flatten()
            .filter(|uri| resources::Uri::parse(uri).is_some());
        let mut accepted = SubscriptionFilter::builder().resource_subscriptions(uris);
        if requested.resources_list_changed == Some(true) {
            accepted = accepted.resources_list_changed();
        }
        let accepted = accepted.build();
        // The SDK acknowledges the subscription before it calls `listen`; what the stream
        // compares against is read now, so no change after the acknowledgment is missed.
        // This is the one storage read on an async thread: the SDK calls this synchronously
        // and acknowledges with its result, so it cannot wait for a blocking thread. It reads
        // the watched tasks once per subscription on the reader connection.
        *self.watch.lock().unwrap_or_else(PoisonError::into_inner) =
            Some(resources::Watch::start(self.backend.as_ref(), &accepted));
        Some(accepted)
    }

    /// Reads the watched resources again on every announced change and every
    /// [`resources::POLL`], and reports what changed until the client closes the stream.
    async fn listen(&self, context: SubscriptionContext) -> Result<(), ErrorData> {
        check_read(context.request_context())?;
        let started = self
            .watch
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let mut watch = match started {
            Some(watch) => watch,
            None => {
                let accepted = context.accepted().clone();
                self.blocking(move |backend| Ok(resources::Watch::start(backend, &accepted)))
                    .await
                    .map_err(internal)?
            }
        };
        loop {
            tokio::select! {
                () = context.cancelled() => return Ok(()),
                changed = watch.changes.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                }
                () = tokio::time::sleep(resources::POLL) => {}
            }
            let (next, (updated, list_changed)) = self
                .blocking(move |backend| {
                    let changes = watch.next(backend);
                    Ok((watch, changes))
                })
                .await
                .map_err(internal)?;
            watch = next;
            let sink = context.sink();
            let mut sent = Ok(());
            for uri in updated {
                sent = sent.and(sink.notify_resource_updated(uri).await);
            }
            if list_changed {
                sent = sent.and(sink.notify_resource_list_changed().await);
            }
            if sent.is_err() {
                // The client closed the stream.
                return Ok(());
            }
        }
    }

    fn get_info(&self) -> ServerConfig {
        let capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_resources()
            .enable_resources_subscribe()
            .enable_resources_list_changed()
            .build();
        ServerConfig::new(capabilities)
            .with_server_info(
                Implementation::new(env!("CARGO_PKG_NAME"), env!("TOODO_VERSION")).with_title(
                    format!("Toodo (server instance {})", self.backend.server().instance),
                ),
            )
            .with_instructions(INSTRUCTIONS.as_str())
    }

    async fn call_tool(
        &self,
        mut request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if let Some(access @ Access::OAuth(_)) = Access::of(&context) {
            let rejected = access.check_tool(&request.name).err();
            if let Some(message) = rejected {
                return Ok(
                    tool_error(CommandError::new(CommandErrorCode::NotPermitted, message)).into(),
                );
            }
            if request.name == "read_toodo_skill" {
                return Ok(CallToolResult::success(vec![ContentBlock::text(
                    CHAT_INSTRUCTIONS.as_str(),
                )])
                .into());
            }
        }
        if let (Some(tool), Some(arguments)) = (
            self.tool_router.get(&request.name),
            request.arguments.as_mut(),
        ) && let Err(message) = numbers_from_strings(&tool.input_schema, arguments)
        {
            return Ok(tool_error(CommandError::new(
                CommandErrorCode::InvalidArguments,
                message,
            ))
            .into());
        }
        self.tool_router
            .call(ToolCallContext::new(self, request, context))
            .await
    }
}

/// Agents often send IDs as strings, e.g. `"12"`. Wherever the tool's input schema takes
/// an integer, at the top level or nested in arrays and objects such as `criteria[0].id`,
/// a string of digits becomes the number before the arguments are read, so the first call
/// works; any other string there is rejected with the field and what to send. ID schemas
/// advertise such strings (see [`crate::commands::types::ID_DIGITS`]). An argument sent
/// under a serde alias, which the schema records in its `x-aliases` object as alias to
/// property name, is read with the schema of that property.
fn numbers_from_strings(schema: &JsonObject, arguments: &mut JsonObject) -> Result<(), String> {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Ok(());
    };
    for (name, value) in arguments.iter_mut() {
        let property = properties.get(name).or_else(|| {
            let target = schema.get("x-aliases")?.get(name)?.as_str()?;
            properties.get(target)
        });
        if let Some(property) = property {
            convert(value, &[property], schema, name)?;
        }
    }
    Ok(())
}

/// Converts the strings in `value`, found at `path`, that the alternatives `schemas` take
/// as integers, and those nested in its items and fields.
fn convert(
    value: &mut Value,
    schemas: &[&Value],
    root: &JsonObject,
    path: &str,
) -> Result<(), String> {
    let accepts = Accepts::of(schemas, root);
    match value {
        Value::String(text) if accepts.integer && !accepts.string => {
            *value = number(path, text)?;
        }
        Value::Array(items) if !accepts.items.is_empty() => {
            for (index, item) in items.iter_mut().enumerate() {
                convert(item, &accepts.items, root, &format!("{path}[{index}]"))?;
            }
        }
        Value::Object(fields) if !accepts.properties.is_empty() => {
            for (name, field) in fields.iter_mut() {
                let field_schemas: Vec<&Value> = accepts
                    .properties
                    .iter()
                    .filter_map(|properties| properties.get(name))
                    .collect();
                if !field_schemas.is_empty() {
                    convert(field, &field_schemas, root, &format!("{path}.{name}"))?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// The JSON values a set of alternative schemas takes, as far as [`numbers_from_strings`]
/// cares.
#[derive(Default)]
struct Accepts<'a> {
    integer: bool,
    /// Strings other than the digits of an ID.
    string: bool,
    /// The item schemas of the arrays it takes.
    items: Vec<&'a Value>,
    /// The properties of the objects it takes.
    properties: Vec<&'a JsonObject>,
}

impl<'a> Accepts<'a> {
    /// Follows `anyOf`, `oneOf`, and `$ref`s into the `$defs` of `root`.
    fn of(schemas: &[&'a Value], root: &'a JsonObject) -> Self {
        let mut accepts = Self::default();
        for schema in schemas {
            accepts.add(schema, root);
        }
        accepts
    }

    fn add(&mut self, schema: &'a Value, root: &'a JsonObject) {
        if let Some(name) = schema
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|reference| reference.strip_prefix("#/$defs/"))
            && let Some(definition) = root.get("$defs").and_then(|defs| defs.get(name))
        {
            self.add(definition, root);
        }
        let types = match schema.get("type") {
            Some(Value::Array(types)) => types.iter().filter_map(Value::as_str).collect(),
            Some(Value::String(single)) => vec![single.as_str()],
            _ => Vec::new(),
        };
        for kind in types {
            match kind {
                "integer" => self.integer = true,
                "string" => {
                    self.string |= schema.get("pattern").and_then(Value::as_str)
                        != Some(crate::commands::types::ID_DIGITS);
                }
                "array" => self.items.extend(schema.get("items")),
                "object" => self
                    .properties
                    .extend(schema.get("properties").and_then(Value::as_object)),
                _ => {}
            }
        }
        for branches in ["anyOf", "oneOf"] {
            for branch in schema
                .get(branches)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                self.add(branch, root);
            }
        }
    }
}

/// Reads `text`, a non-negative whole number written with digits only, for the field
/// `name`.
fn number(name: &str, text: &str) -> Result<Value, String> {
    if !text.is_empty()
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(number) = text.parse::<i64>()
    {
        return Ok(Value::from(number));
    }
    let lookup = if name.contains("workspace") {
        "; list_workspaces lists the workspace IDs"
    } else if name.contains("criterion") || name.starts_with("criteria") {
        "; get_task lists a task's criteria with their IDs"
    } else if name.ends_with("id") || name.contains("depends_on") || name.contains("related") {
        "; search_tasks or list_tasks finds the task IDs"
    } else {
        ""
    };
    Err(format!(
        "{name} must be a whole number such as 12 or \"12\", not {text:?}: call the tool \
         again with {name} as a number{lookup}"
    ))
}

/// Rejects a chat app connected over OAuth that may not read tasks.
fn check_read(context: &RequestContext<RoleServer>) -> Result<(), ErrorData> {
    match Access::of(context) {
        Some(access) => access
            .check_tool("get_task")
            .map_err(|message| ErrorData::invalid_request(message, None)),
        None => Ok(()),
    }
}

fn internal(error: CommandError) -> ErrorData {
    ErrorData::internal_error(error.message, None)
}

/// Tool failures are tool-level errors, so the agent sees the reason, e.g. a cycle.
fn reply<T: Serialize>(result: CommandResult<T>) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(value) => {
            let json = serde_json::to_string_pretty(&value)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
        }
        Err(error) => Ok(tool_error(error)),
    }
}

/// A failed tool call: the kind and message as text for the agent to read, and the error
/// with its code (the codes of the RPC endpoint) as structured content `{"error": ...}`.
fn tool_error(error: CommandError) -> CallToolResult {
    let mut result = CallToolResult::error(vec![ContentBlock::text(format!(
        "{:?}: {}",
        error.kind, error.message
    ))]);
    result.structured_content = Some(serde_json::json!({ "error": error }));
    result
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::*;

    #[test]
    fn the_token_is_created_once_and_then_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE);
        let token = load_token(&path).unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(load_token(&path).unwrap(), token);
    }

    /// A router whose one route, `/`, reports on `entered` that a request reached it and
    /// then answers with `respond`.
    fn signalling_router<F, R>(
        entered: tokio::sync::oneshot::Sender<()>,
        respond: F,
    ) -> axum::Router
    where
        F: FnOnce() -> R + Send + 'static,
        R: Future<Output = Response> + Send + 'static,
    {
        let hooks = Arc::new(Mutex::new(Some((entered, respond))));
        axum::Router::new().route(
            "/",
            axum::routing::get(move || {
                let (entered, respond) = hooks.lock().unwrap().take().unwrap();
                entered.send(()).unwrap();
                respond()
            }),
        )
    }

    /// Sends `GET /` to `address` and returns all that comes back until the connection
    /// closes.
    fn get_root(address: SocketAddr) -> String {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        String::from_utf8(response).unwrap()
    }

    // Like `toodo-server`, these tests end the runtime, and with it every connection, as
    // soon as `serve` returns.

    #[test]
    fn a_request_in_flight_when_shutdown_starts_is_answered() {
        let (entered, request_arrived) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let app = signalling_router(entered, || async move {
            released.await.unwrap();
            "finished".into_response()
        });
        let listener = bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || get_root(address));
        // Shutdown starts once the request has reached the handler.
        let (seen, shutdown_started) = tokio::sync::oneshot::channel();
        let shutdown = async move {
            request_arrived.await.unwrap();
            seen.send(()).unwrap();
        };
        runtime().block_on(async move {
            let served = serve(listener, app, shutdown, Duration::from_secs(60));
            let mut served = std::pin::pin!(served);
            // Polled a few more times after shutdown starts, `serve` must still wait for the
            // request it has not answered yet.
            let settled = async {
                shutdown_started.await.unwrap();
                for _ in 0..3 {
                    tokio::task::yield_now().await;
                }
            };
            tokio::select! {
                _ = &mut served => panic!("serve returned before the request in flight was answered"),
                () = settled => {}
            }
            release.send(()).unwrap();
            served.await.unwrap();
        });
        let response = client.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.ends_with("finished"), "{response}");
    }

    #[test]
    fn a_response_that_never_ends_holds_shutdown_only_until_the_deadline() {
        let (entered, request_arrived) = tokio::sync::oneshot::channel();
        // Like an event stream: the headers go out, the body never ends.
        let app = signalling_router(entered, || async {
            axum::body::Body::from_stream(futures_util::stream::pending::<
                io::Result<axum::body::Bytes>,
            >())
            .into_response()
        });
        let listener = bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || get_root(address));
        let shutdown = async move { request_arrived.await.unwrap() };
        runtime().block_on(async move {
            let served = serve(listener, app, shutdown, Duration::from_millis(100));
            tokio::time::timeout(Duration::from_secs(10), served)
                .await
                .expect("serve returns once the deadline has passed")
                .unwrap();
        });
        let response = client.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }

    #[cfg(unix)]
    #[test]
    fn only_the_owner_can_read_the_token() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        let created = dir.path().join(TOKEN_FILE);
        load_token(&created).unwrap();
        assert_eq!(mode(&created), 0o600);

        let existing = dir.path().join("existing");
        fs::write(&existing, "abc").unwrap();
        fs::set_permissions(&existing, fs::Permissions::from_mode(0o664)).unwrap();
        assert_eq!(load_token(&existing).unwrap(), "abc");
        assert_eq!(mode(&existing), 0o600);

        let blank = dir.path().join("blank");
        fs::write(&blank, "\n").unwrap();
        fs::set_permissions(&blank, fs::Permissions::from_mode(0o664)).unwrap();
        assert_eq!(load_token(&blank).unwrap().len(), 64);
        assert_eq!(mode(&blank), 0o600);
    }

    struct TestBackend {
        storage: Arc<StorageState>,
        public_url: Option<PublicUrl>,
        server: ServerStatus,
        changed: std::sync::Mutex<Vec<model::WorkspaceId>>,
        workspaces_changed: std::sync::Mutex<usize>,
        guidelines_changed: std::sync::Mutex<Vec<model::WorkspaceId>>,
        chat: std::sync::Mutex<Vec<String>>,
        changes: tokio::sync::watch::Sender<()>,
    }
    impl TestBackend {
        fn new(storage: crate::storage::Storage) -> Self {
            Self {
                storage: Arc::new(std::sync::Mutex::new(storage)),
                public_url: None,
                server: ServerStatus {
                    url: url(0),
                    token: Some("secret".into()),
                    instance: "0123456789ab".into(),
                    error: None,
                    rejections: Rejections::default(),
                },
                changed: std::sync::Mutex::default(),
                workspaces_changed: std::sync::Mutex::default(),
                guidelines_changed: std::sync::Mutex::default(),
                chat: std::sync::Mutex::default(),
                changes: tokio::sync::watch::Sender::new(()),
            }
        }
    }
    impl Notifier for TestBackend {
        fn tasks_changed(&self, workspace: model::WorkspaceId) {
            self.changed.lock().unwrap().push(workspace);
            self.changes.send_replace(());
        }
        fn workspaces_changed(&self) {
            *self.workspaces_changed.lock().unwrap() += 1;
        }
        fn guidelines_changed(&self, workspace: model::WorkspaceId) {
            self.guidelines_changed.lock().unwrap().push(workspace);
        }
        fn chat_changed(&self) {
            self.chat.lock().unwrap().push("changed".to_owned());
        }
        fn agent_posted(&self, body: &str) {
            self.chat.lock().unwrap().push(format!("posted {body}"));
        }
        fn agent_typing(&self, typing: bool) {
            self.chat.lock().unwrap().push(format!("typing {typing}"));
        }
    }
    impl Backend for TestBackend {
        fn public_url(&self) -> Option<&PublicUrl> {
            self.public_url.as_ref()
        }
        fn storage(&self) -> &StorageState {
            &self.storage
        }
        fn server(&self) -> &ServerStatus {
            &self.server
        }
        fn changes(&self) -> tokio::sync::watch::Receiver<()> {
            self.changes.subscribe()
        }
    }

    fn storage_with_task(_: Option<&str>) -> (crate::storage::Storage, model::Task) {
        let mut storage = crate::storage::Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&crate::storage::NewWorkspace {
                name: "Tasks".into(),
                description: None,
                repository: None,
            })
            .unwrap();
        let task = storage
            .create_task(&crate::storage::NewTask {
                workspace_id: workspace.id,
                task_type: model::TaskType::Feat,
                title: "Add login".into(),
                description: String::new(),
                estimate: None,
                due_date: None,
                autopilot: false,
                criteria: vec![],
            })
            .unwrap();
        (storage, task)
    }

    #[test]
    fn the_tool_list_contains_task_record_and_chat_operations() {
        let server = ToodoMcp::new(Arc::new(TestBackend::new(
            crate::storage::Storage::open_in_memory().unwrap(),
        )));
        let names: std::collections::BTreeSet<_> = server
            .tool_router
            .list_all()
            .iter()
            .map(|tool| tool.name.to_string())
            .collect();
        let expected: std::collections::BTreeSet<_> = [
            "read_toodo_skill",
            "list_workspaces",
            "create_workspace",
            "update_workspace",
            "archive_workspace",
            "list_tasks",
            "search_tasks",
            "get_task",
            "add_related",
            "remove_related",
            "current_task",
            "create_task",
            "create_plan",
            "check_criterion",
            "add_criterion",
            "remove_criterion",
            "update_task",
            "move_task",
            "add_dependency",
            "remove_dependency",
            "add_progress_note",
            "report_blocker",
            "pause_task",
            "wait_task",
            "end_wait",
            "resume_task",
            "delete_task",
            "delete_done_tasks",
            "reopen_task",
            "start_task",
            "complete_task",
            "conclude_task",
            "review_report",
            "get_guidelines",
            "add_guideline",
            "update_guideline",
            "remove_guideline",
            "peek_pending",
            "take_pending",
            "reply_in_chat",
            "ack_chat",
            "mark_chat_handled",
            "list_chat",
            "set_typing",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert_eq!(names, expected);
        let start = server.tool_router.get("start_task").unwrap();
        assert!(
            start.input_schema["properties"]
                .get("agent_command")
                .is_none()
        );
    }

    #[test]
    fn a_ready_start_records_reason_refs_and_announces_without_execution_fields() {
        let (storage, task) = storage_with_task(None);
        let backend = Arc::new(TestBackend::new(storage));
        let server = ToodoMcp::new(backend.clone());
        let result = runtime().block_on(server.start_task(Parameters(serde_json::from_value(serde_json::json!({"id": task.id.0, "reason": "Ready", "refs": ["lane:test"]})).unwrap()))).unwrap();
        let result = serde_json::to_value(result).unwrap();
        assert_ne!(result["isError"], true);
        let task: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(task["status"], "in_progress");
        assert_eq!(task["guidelines"], serde_json::json!([]));
        assert_eq!(task["refs"], serde_json::json!(["lane:test"]));
        assert_eq!(task["timeline"][1]["reason"], "Ready");
        for field in ["panes", "ranIn", "paneError", "worktreePath"] {
            assert!(task.get(field).is_none(), "{field}");
        }
        assert_eq!(
            *backend.changed.lock().unwrap(),
            [model::WorkspaceId(task["workspaceId"].as_i64().unwrap())]
        );
        let found = tools::current_task(
            &lock(backend.storage()),
            tools::CurrentTask {
                r#ref: Some("lane:test".into()),
            },
        )
        .unwrap();
        assert_eq!(found.task.id.0, task["id"].as_i64().unwrap());
        let error =
            tools::current_task(&lock(backend.storage()), tools::CurrentTask { r#ref: None })
                .unwrap_err();
        assert!(error.message.contains("get_task") && error.message.contains("ref"));
    }

    #[test]
    fn update_records_review_status_and_pause_resume_uses_history() {
        let (storage, task) = storage_with_task(None);
        let storage = StorageState::new(storage);
        tools::start_task(
            &storage,
            serde_json::from_value(serde_json::json!({"id": task.id.0})).unwrap(),
        )
        .unwrap();
        let reviewed = tools::update_task(&mut lock(&storage), serde_json::from_value(serde_json::json!({"id": task.id.0, "status": "in_review", "refs": ["review:ready"]})).unwrap()).unwrap();
        assert_eq!(
            reviewed.status,
            crate::commands::types::TaskStatus::InReview
        );
        assert!(reviewed.milestones.review_at.is_some());
        tools::pause_task(
            &mut lock(&storage),
            tools::PauseTask {
                id: task.id.into(),
                reason: "Waiting".into(),
            },
        )
        .unwrap();
        let resumed = tools::resume_task(
            &storage,
            tools::ResumeTask {
                id: task.id.into(),
                note: Some("Ready again".into()),
            },
        )
        .unwrap();
        assert_eq!(
            resumed.status,
            crate::commands::types::TaskStatus::InProgress
        );
        assert_eq!(resumed.refs, ["review:ready"]);
        assert_eq!(resumed.notes.last().unwrap().body, "Resumed: Ready again");
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn post_initialize(address: SocketAddr, authorization: &str) -> String {
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;
        post(address, authorization, body)
    }

    fn post(address: SocketAddr, authorization: &str, body: &str) -> String {
        post_host(address, authorization, body, "127.0.0.1")
    }

    fn post_host(address: SocketAddr, authorization: &str, body: &str, host: &str) -> String {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        write!(
            stream,
            "POST /mcp HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n\
             Accept: application/json, text/event-stream\r\n{authorization}\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        // A server that answers without reading the body closes with a reset, which macOS
        // reports after the answer; the answer read up to then is the response.
        let mut response = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => response.extend_from_slice(&chunk[..read]),
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                Err(error) => panic!("reading the response failed: {error}"),
            }
        }
        String::from_utf8(response).unwrap()
    }

    #[test]
    fn only_requests_with_the_token_reach_the_tools() {
        let listener = bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let address = listener.local_addr().unwrap();
        let storage = crate::storage::Storage::open_in_memory().unwrap();
        let backend = Arc::new(TestBackend::new(storage));
        let app = router(backend.clone(), "secret".to_owned(), Some("web".to_owned()));
        std::thread::spawn(move || {
            runtime().block_on(serve(
                listener,
                app,
                std::future::pending(),
                SHUTDOWN_DEADLINE,
            ))
        });

        let rejected = |authorization: &str, reason: &str| {
            let response = post_initialize(address, authorization);
            assert!(response.starts_with("HTTP/1.1 401"), "{response}");
            assert!(
                response
                    .to_ascii_lowercase()
                    .contains("www-authenticate: bearer"),
                "{response}"
            );
            assert!(response.contains(reason), "{response}");
            assert!(
                response.contains("This is Toodo server instance 0123456789ab."),
                "{response}"
            );
            assert!(!response.contains("secret"), "{response}");
        };
        rejected("", "has no Authorization header");
        rejected("Authorization: secret\r\n", "is not `Bearer <token>`");
        rejected("Authorization: Bearer \r\n", "is not `Bearer <token>`");
        rejected(
            "Authorization: Bearer secreT\r\n",
            "this server does not accept the token",
        );
        rejected("Authorization: Bearer web\r\n", "the web sign-in token");
        let last = backend.server.rejections.last().unwrap();
        assert_eq!((last.reason, last.count), (Rejection::OtherSurfaceToken, 5));

        let accepted = post_initialize(address, "Authorization: Bearer secret\r\n");
        assert!(accepted.starts_with("HTTP/1.1 200"), "{accepted}");
        assert!(accepted.contains(r#""name":"toodo""#), "{accepted}");
        assert!(
            accepted.contains(r#""title":"Toodo (server instance 0123456789ab)""#),
            "{accepted}"
        );
        // The scheme is case-insensitive.
        let lowercase = post_initialize(address, "Authorization: bearer secret\r\n");
        assert!(lowercase.starts_with("HTTP/1.1 200"), "{lowercase}");
        assert_eq!(backend.server.rejections.last().unwrap().count, 5);
    }

    #[test]
    fn the_skill_tool_returns_the_skill_text() {
        let storage = crate::storage::Storage::open_in_memory().unwrap();
        let server = ToodoMcp::new(Arc::new(TestBackend::new(storage)));
        assert!(server.tool_router.has_route("read_toodo_skill"));
        for tool in [
            "pause_task",
            "resume_task",
            "start_task",
            "complete_task",
            "conclude_task",
            "search_tasks",
            "get_task",
            "add_related",
            "remove_related",
            "delete_task",
            "delete_done_tasks",
            "reopen_task",
            "reply_in_chat",
            "ack_chat",
            "mark_chat_handled",
            "take_pending",
            "peek_pending",
            "list_chat",
            "set_typing",
        ] {
            assert!(server.tool_router.has_route(tool), "{tool}");
        }
        assert!(!server.tool_router.has_route("import_chat_message"));
        let result = serde_json::to_value(server.read_toodo_skill().unwrap()).unwrap();
        assert_eq!(result["content"][0]["text"], SKILL.as_str());
        // `lines` also drops the `\r` of a CRLF checkout on Windows.
        assert_eq!(
            SKILL.lines().take(2).collect::<Vec<_>>(),
            ["---", "name: toodo"]
        );
        assert_ne!(result["isError"], true);
    }

    #[test]
    fn the_instructions_and_the_skill_share_each_fragment() {
        for text in [&*SKILL, &*INSTRUCTIONS, &*CHAT_INSTRUCTIONS] {
            assert!(!text.contains("{{"), "{text}");
        }
        for (name, fragment) in SHARED {
            assert!(SKILL.contains(fragment.trim_end()), "{name}");
            assert!(INSTRUCTIONS.contains(fragment.trim_end()), "{name}");
        }
        let (_, description) = SHARED
            .iter()
            .find(|(name, _)| *name == "task-description")
            .unwrap();
        assert!(CHAT_INSTRUCTIONS.contains(description.trim_end()));
        let (_, guidelines) = SHARED
            .iter()
            .find(|(name, _)| *name == "guidelines")
            .unwrap();
        assert!(CHAT_INSTRUCTIONS.contains(guidelines.trim_end()));
    }

    #[test]
    fn guideline_tools_announce_changes_and_start_task_returns_the_guidelines() {
        let (storage, task) = storage_with_task(None);
        let backend = Arc::new(TestBackend::new(storage));
        let server = ToodoMcp::new(backend.clone());
        let workspace = task.workspace_id;
        let text = |result: CallToolResult| -> Value {
            let result = serde_json::to_value(result).unwrap();
            assert_ne!(result["isError"], true, "{result}");
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
        };
        fn args<T: serde::de::DeserializeOwned>(value: Value) -> Parameters<T> {
            Parameters(serde_json::from_value(value).unwrap())
        }
        let rt = runtime();
        let rule = text(rt.block_on(server.add_guideline(args(serde_json::json!({"workspace_id": workspace.0, "kind": "rule", "body": "Write English"})))).unwrap());
        let memory = text(
            rt.block_on(server.add_guideline(args(
                serde_json::json!({"workspace_id": workspace.0, "body": "Tests take a minute"}),
            )))
            .unwrap(),
        );
        assert_eq!(memory["kind"], "memory");
        let updated = text(
            rt.block_on(server.update_guideline(args(
                serde_json::json!({"id": memory["id"], "body": "Tests take two minutes"}),
            )))
            .unwrap(),
        );
        assert_eq!(updated["kind"], "memory");
        let started = text(
            rt.block_on(server.start_task(args(serde_json::json!({"id": task.id.0}))))
                .unwrap(),
        );
        assert_eq!(started["status"], "in_progress");
        assert_eq!(started["guidelines"], serde_json::json!([rule, updated]));
        text(
            rt.block_on(server.remove_guideline(args(serde_json::json!({"id": rule["id"]}))))
                .unwrap(),
        );
        let listed = text(
            rt.block_on(
                server.get_guidelines(args(serde_json::json!({"workspace_id": workspace.0}))),
            )
            .unwrap(),
        );
        assert_eq!(
            listed["workspace"],
            serde_json::json!({"id": workspace.0, "name": "Tasks"})
        );
        assert_eq!(listed["guidelines"], serde_json::json!([updated]));
        assert_eq!(*backend.guidelines_changed.lock().unwrap(), [workspace; 4]);
    }

    #[test]
    fn chat_tools_take_acknowledge_and_answer_messages_and_announce_each_step() {
        let mut storage = crate::storage::Storage::open_in_memory().unwrap();
        let hi = storage.post_user_message("Hi", "c1").unwrap();
        let later = storage.post_user_message("Also", "c2").unwrap();
        let backend = Arc::new(TestBackend::new(storage));
        let server = ToodoMcp::new(backend.clone());
        let text = |result: CallToolResult| -> Value {
            let result = serde_json::to_value(result).unwrap();
            assert_ne!(result["isError"], true, "{result}");
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
        };
        fn args<T: serde::de::DeserializeOwned>(value: Value) -> Parameters<T> {
            Parameters(serde_json::from_value(value).unwrap())
        }
        let rt = runtime();
        let peeked = text(rt.block_on(server.peek_pending()).unwrap());
        assert_eq!(peeked.as_array().unwrap().len(), 2);
        assert_eq!(peeked[0]["deliveredAt"], Value::Null);
        let taken = text(rt.block_on(server.take_pending()).unwrap());
        assert_eq!(taken[0]["id"], hi.id.0);
        assert_ne!(taken[0]["deliveredAt"], Value::Null);
        assert_eq!(
            text(rt.block_on(server.take_pending()).unwrap()),
            serde_json::json!([])
        );
        let acked = text(
            rt.block_on(server.ack_chat(args(serde_json::json!({"ids": [hi.id.0]}))))
                .unwrap(),
        );
        assert_ne!(acked[0]["ackedAt"], Value::Null);
        text(
            rt.block_on(server.set_typing(args(serde_json::json!({"typing": true}))))
                .unwrap(),
        );
        let reply = text(
            rt.block_on(server.reply_in_chat(args(
                serde_json::json!({"body": "Hello", "handles": [hi.id.0]}),
            )))
            .unwrap(),
        );
        assert_eq!(reply["author"], "agent");
        let handled = text(
            rt.block_on(server.mark_chat_handled(args(
                serde_json::json!({"id": later.id.0, "reply_id": reply["id"]}),
            )))
            .unwrap(),
        );
        assert_eq!(handled["handledReplyId"], reply["id"]);
        let listed = text(
            rt.block_on(server.list_chat(args(serde_json::json!({}))))
                .unwrap(),
        );
        assert_eq!(listed[0]["handledReplyId"], reply["id"]);
        assert_eq!(
            *backend.chat.lock().unwrap(),
            [
                "changed",
                "changed",
                "typing true",
                "posted Hello",
                "changed"
            ]
        );
        let refused = serde_json::to_value(
            rt.block_on(server.ack_chat(args(serde_json::json!({"ids": [reply["id"]]}))))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(refused["isError"], true);
        assert_eq!(refused["structuredContent"]["error"]["code"], "rejected");
    }

    #[test]
    fn every_integer_argument_takes_a_numeric_string() {
        let storage = crate::storage::Storage::open_in_memory().unwrap();
        let server = ToodoMcp::new(Arc::new(TestBackend::new(storage)));
        let mut checked = Vec::new();
        for tool in server.tool_router.list_all() {
            let schema = &tool.input_schema;
            let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
                continue;
            };
            for (name, property) in properties {
                let accepts = Accepts::of(&[property], schema);
                let converted = |value: Value| {
                    let mut arguments = JsonObject::from_iter([(name.clone(), value)]);
                    numbers_from_strings(schema, &mut arguments).map(|()| arguments[name].clone())
                };
                let items = Accepts::of(&accepts.items, schema);
                if accepts.integer && !accepts.string {
                    assert_eq!(converted("12".into()), Ok(12.into()), "{name}");
                    assert_eq!(converted(12.into()), Ok(12.into()), "{name}");
                    for given in ["abc", "1.5", "", " 12", "#12", "-1"] {
                        let error = converted(given.into()).unwrap_err();
                        assert!(
                            error.starts_with(&format!("{name} must be a whole number")),
                            "{error}"
                        );
                    }
                } else if items.integer && !items.string {
                    assert_eq!(
                        converted(serde_json::json!(["3", 4])),
                        Ok(serde_json::json!([3, 4])),
                        "{name}"
                    );
                    let error = converted(serde_json::json!([3, "x"])).unwrap_err();
                    assert!(error.starts_with(&format!("{name}[1] must be")), "{error}");
                } else {
                    continue;
                }
                checked.push(format!("{}.{name}", tool.name));
            }
        }
        for argument in [
            "get_task.id",
            "list_tasks.workspace_id",
            "create_task.workspace_id",
            "create_task.depends_on",
            "check_criterion.task_id",
            "check_criterion.criterion_id",
            "add_related.related_id",
            "add_dependency.depends_on",
            "remove_dependency.depends_on",
        ] {
            assert!(
                checked.contains(&argument.to_owned()),
                "{argument}: {checked:?}"
            );
        }
    }

    #[test]
    fn nested_ids_take_numeric_strings() {
        let storage = crate::storage::Storage::open_in_memory().unwrap();
        let server = ToodoMcp::new(Arc::new(TestBackend::new(storage)));
        let convert = |tool: &str, arguments: Value| {
            let schema = &server.tool_router.get(tool).unwrap().input_schema;
            let Value::Object(mut arguments) = arguments else {
                unreachable!()
            };
            numbers_from_strings(schema, &mut arguments).map(|()| Value::Object(arguments))
        };
        assert_eq!(
            convert(
                "update_task",
                serde_json::json!({"id": "7", "criteria": [{"id": "11"}, {"text": "12", "kind": "manual"}]})
            ),
            Ok(
                serde_json::json!({"id": 7, "criteria": [{"id": 11}, {"text": "12", "kind": "manual"}]})
            )
        );
        assert_eq!(
            convert(
                "create_plan",
                serde_json::json!({"tasks": [{"key": "a", "workspace_id": "1", "depends_on": ["3"], "related": ["4"]}]})
            ),
            Ok(
                serde_json::json!({"tasks": [{"key": "a", "workspace_id": 1, "depends_on": [3], "related": [4]}]})
            )
        );
        let error = convert(
            "update_task",
            serde_json::json!({"id": 7, "criteria": [{"id": 11}, {"id": "1.5"}]}),
        )
        .unwrap_err();
        assert!(
            error.starts_with(
                r#"criteria[1].id must be a whole number such as 12 or "12", not "1.5""#
            ),
            "{error}"
        );
    }

    #[test]
    fn aliased_criterion_ids_take_numeric_strings() {
        let storage = crate::storage::Storage::open_in_memory().unwrap();
        let server = ToodoMcp::new(Arc::new(TestBackend::new(storage)));
        let convert = |tool: &str, arguments: Value| {
            let schema = &server.tool_router.get(tool).unwrap().input_schema;
            let Value::Object(mut arguments) = arguments else {
                unreachable!()
            };
            numbers_from_strings(schema, &mut arguments).map(|()| Value::Object(arguments))
        };
        assert_eq!(
            convert("check_criterion", serde_json::json!({"criterion_id": "3"})),
            Ok(serde_json::json!({"criterion_id": 3}))
        );
        assert_eq!(
            convert("check_criterion", serde_json::json!({"id": "3"})),
            Ok(serde_json::json!({"id": 3}))
        );
        assert_eq!(
            convert("remove_criterion", serde_json::json!({"id": "3"})),
            Ok(serde_json::json!({"id": 3}))
        );
        let error = convert("remove_criterion", serde_json::json!({"id": "x"})).unwrap_err();
        assert!(error.starts_with("id must be a whole number"), "{error}");
    }

    #[test]
    fn id_arguments_advertise_numeric_strings() {
        let storage = crate::storage::Storage::open_in_memory().unwrap();
        let server = ToodoMcp::new(Arc::new(TestBackend::new(storage)));
        let property = |tool: &str, name: &str| {
            server.tool_router.get(tool).unwrap().input_schema["properties"][name].clone()
        };
        assert_eq!(
            property("get_task", "id"),
            serde_json::json!({"type": ["integer", "string"], "pattern": "^[0-9]+$", "description": "The task, e.g. one that search_tasks found."})
        );
        assert_eq!(
            property("check_criterion", "task_id")["type"],
            serde_json::json!(["integer", "string", "null"])
        );
    }

    #[test]
    fn a_task_id_sent_as_a_string_reaches_the_tool() {
        let listener = bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let address = listener.local_addr().unwrap();
        let (storage, task) = storage_with_task(None);
        let app = router(
            Arc::new(TestBackend::new(storage)),
            "secret".to_owned(),
            None,
        );
        std::thread::spawn(move || {
            runtime().block_on(serve(
                listener,
                app,
                std::future::pending(),
                SHUTDOWN_DEADLINE,
            ))
        });
        let get_task = |id: &str| {
            let body = format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"get_task","arguments":{{"id":{id}}}}}}}"#
            );
            post(address, "Authorization: Bearer secret\r\n", &body)
        };

        let found = get_task(&format!("\"{}\"", task.id.0));
        assert!(found.contains(r#"\"title\": \"Add login\""#), "{found}");
        let rejected = get_task(r#""login""#);
        assert!(
            rejected.contains(
                r#"InvalidInput: id must be a whole number such as 12 or \"12\", not \"login\""#
            ),
            "{rejected}"
        );
        assert!(rejected.contains(r#""isError":true"#), "{rejected}");
        assert!(
            rejected.contains(r#""code":"invalidArguments""#),
            "{rejected}"
        );
        let missing = get_task("999");
        assert!(missing.contains(r#""code":"taskNotFound""#), "{missing}");
        assert!(missing.contains(r#""kind":"notFound""#), "{missing}");
    }

    #[test]
    fn secrets_match_only_when_equal() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abd", "abc"));
        assert!(!same_secret("ab", "abc"));
    }

    fn oauth_grant(backend: &TestBackend, token: &str, scopes: oauth::Scopes) -> i64 {
        let client = crate::storage::oauth::Client {
            client_id: token.to_owned(),
            secret_hash: None,
            client_name: Some("Test app".to_owned()),
            redirect_uris: vec!["https://client.example/callback".to_owned()],
            auth_method: "none".to_owned(),
            created_at: 1,
        };
        let mut storage = lock(&backend.storage);
        storage.oauth_register_client(&client).unwrap();
        storage
            .oauth_create_grant(
                &oauth::OwnerKey("test-owner".to_owned()),
                &client,
                scopes,
                &oauth::hash(token),
                &oauth::hash(&format!("{token}-refresh")),
            )
            .unwrap()
    }

    /// Runs the HTTP MCP surface with fake process adapters on an ephemeral loopback port.
    fn test_endpoint(backend: Arc<TestBackend>, peer: Option<SocketAddr>) -> SocketAddr {
        let listener = bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let address = listener.local_addr().unwrap();
        let mut app = router(backend, "secret".to_owned(), Some("web".to_owned()));
        if let Some(peer) = peer {
            app = app.layer(axum::Extension(ConnectInfo(peer)));
        }
        std::thread::spawn(move || {
            runtime().block_on(serve(
                listener,
                app,
                std::future::pending(),
                SHUTDOWN_DEADLINE,
            ))
        });
        address
    }

    fn rpc_result(address: SocketAddr, token: &str, method: &str, params: Value) -> Value {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
        });
        let response = post(
            address,
            &format!("Authorization: Bearer {token}\r\n"),
            &body.to_string(),
        );
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let body = response.split_once("\r\n\r\n").unwrap().1;
        let parsed: Value = serde_json::from_str(body).unwrap();
        assert!(parsed.get("error").is_none(), "{parsed}");
        parsed["result"].clone()
    }

    /// The task of [`storage_with_task`] and a task that depends on it, served over HTTP.
    fn endpoint_with_dependent() -> (Arc<TestBackend>, SocketAddr, model::Task, model::Task) {
        let (mut storage, task) = storage_with_task(None);
        let dependent = storage
            .create_task(&crate::storage::NewTask {
                workspace_id: task.workspace_id,
                task_type: model::TaskType::Feat,
                title: "Add logout".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                autopilot: false,
                criteria: Vec::new(),
            })
            .unwrap();
        storage.add_dependency(dependent.id, task.id).unwrap();
        let backend = Arc::new(TestBackend::new(storage));
        let peer = SocketAddr::from((Ipv4Addr::LOCALHOST, 50000));
        let address = test_endpoint(backend.clone(), Some(peer));
        (backend, address, task, dependent)
    }

    #[test]
    fn tasks_and_their_runs_are_resources() {
        let (backend, address, task, dependent) = endpoint_with_dependent();
        let task_uri = format!("toodo://tasks/{}", task.id.0);
        let dependent_uri = format!("toodo://tasks/{}", dependent.id.0);

        let listed = rpc_result(address, "secret", "resources/list", serde_json::json!({}));
        let uris: Vec<&str> = listed["resources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|resource| resource["uri"].as_str().unwrap())
            .collect();
        assert_eq!(uris, [task_uri.as_str(), dependent_uri.as_str()]);
        let templates = rpc_result(
            address,
            "secret",
            "resources/templates/list",
            serde_json::json!({}),
        );
        let templates: Vec<&str> = templates["resourceTemplates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|template| template["uriTemplate"].as_str().unwrap())
            .collect();
        assert_eq!(templates, ["toodo://tasks/{task_id}"]);

        let read = |uri: &str| -> Value {
            let result = rpc_result(
                address,
                "secret",
                "resources/read",
                serde_json::json!({ "uri": uri }),
            );
            assert_eq!(result["contents"][0]["uri"], uri);
            serde_json::from_str(result["contents"][0]["text"].as_str().unwrap()).unwrap()
        };
        let expected = tools::task_details(
            &lock(backend.storage()),
            tools::GetTask {
                id: dependent.id.into(),
            },
        )
        .unwrap();
        assert_eq!(
            read(&dependent_uri),
            serde_json::to_value(expected).unwrap()
        );

        let body = r#"{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"toodo://tasks/999"}}"#;
        let response = post(address, "Authorization: Bearer secret\r\n", body);
        let error: Value =
            serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(error["error"]["code"], -32002, "{error}");
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("search_tasks"),
            "{error}"
        );
    }

    /// Clients that initialize use a protocol whose notifications need a session.
    #[test]
    fn initialize_does_not_offer_resource_subscriptions() {
        let (_, address, _, _) = endpoint_with_dependent();
        let response = post_initialize(address, "Authorization: Bearer secret\r\n");
        let body: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body["result"]["capabilities"]["resources"],
            serde_json::json!({}),
            "{body}"
        );
    }

    #[test]
    fn a_listen_stream_reports_a_completed_dependency() {
        use std::io::{BufRead, BufReader, Write};
        let (backend, address, task, dependent) = endpoint_with_dependent();
        let dependent_uri = format!("toodo://tasks/{}", dependent.id.0);
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 7, "method": "subscriptions/listen",
            "params": {
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": { "name": "test", "version": "1" },
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
                "notifications": {
                    "resourceSubscriptions": [dependent_uri, "https://example.com/elsewhere"],
                    "resourcesListChanged": true,
                },
            },
        })
        .to_string();
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        write!(
            stream,
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
             Accept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2026-07-28\r\n\
             Mcp-Method: subscriptions/listen\r\nAuthorization: Bearer secret\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut lines = BufReader::new(stream).lines();
        let mut next_message = || loop {
            let line = lines
                .next()
                .expect("the stream stays open")
                .expect("a message within the read timeout");
            if let Some(data) = line.strip_prefix("data:")
                && !data.trim().is_empty()
            {
                return serde_json::from_str::<Value>(data.trim()).unwrap();
            }
        };
        let acknowledged = next_message();
        assert_eq!(
            acknowledged["method"], "notifications/subscriptions/acknowledged",
            "{acknowledged}"
        );
        assert_eq!(
            acknowledged["params"]["notifications"],
            serde_json::json!({
                "resourceSubscriptions": [dependent_uri],
                "resourcesListChanged": true,
            })
        );

        {
            let mut storage = lock(backend.storage());
            storage
                .set_task_status(task.id, crate::domain::status::TaskStatus::InProgress)
                .unwrap();
            storage
                .complete_task(task.id, Some("Shipped"), &[])
                .unwrap();
        }
        backend.tasks_changed(task.workspace_id);

        let updated = next_message();
        assert_eq!(updated["method"], "notifications/resources/updated");
        assert_eq!(updated["params"]["uri"], dependent_uri);
        assert_eq!(
            updated["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"],
            7
        );
        let list_changed = next_message();
        assert_eq!(
            list_changed["method"],
            "notifications/resources/list_changed"
        );
    }

    #[test]
    fn default_mcp_rejects_non_loopback_peers_and_accepts_mapped_loopback() {
        let backend = Arc::new(TestBackend::new(
            crate::storage::Storage::open_in_memory().unwrap(),
        ));
        let remote = test_endpoint(backend.clone(), Some("192.0.2.1:1234".parse().unwrap()));
        let response = post_initialize(remote, "Authorization: Bearer secret\r\n");
        assert!(response.starts_with("HTTP/1.1 403"), "{response}");
        assert!(response.contains("TOODO_PUBLIC_URL"), "{response}");
        let mapped = test_endpoint(backend, Some("[::ffff:127.0.0.1]:1234".parse().unwrap()));
        let response = post_initialize(mapped, "Authorization: Bearer secret\r\n");
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }

    #[test]
    fn oauth_mcp_filters_tools_checks_scopes_and_revocation_without_running_adapters() {
        let mut backend = TestBackend::new(crate::storage::Storage::open_in_memory().unwrap());
        backend.public_url = Some(PublicUrl::parse("https://toodo.example:8443").unwrap());
        let backend = Arc::new(backend);
        let read_grant = oauth_grant(&backend, "read-access", oauth::Scopes::READ);
        oauth_grant(
            &backend,
            "write-access",
            oauth::Scopes::parse(Some("toodo.write")).unwrap(),
        );
        let address = test_endpoint(backend.clone(), Some("192.0.2.1:1234".parse().unwrap()));
        for host in [
            "toodo.example",
            "toodo.example:8443",
            "localhost",
            "127.0.0.1",
        ] {
            let response = post_host(
                address,
                "Authorization: Bearer secret\r\n",
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#,
                host,
            );
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        }
        let response = post_host(
            address,
            "Authorization: Bearer secret\r\n",
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#,
            "other.example",
        );
        assert!(response.starts_with("HTTP/1.1 403"), "{response}");
        let response = post_initialize(address, "");
        assert!(response.starts_with("HTTP/1.1 401"), "{response}");
        assert!(response.contains("resource_metadata=\"https://toodo.example:8443/.well-known/oauth-protected-resource/mcp\""), "{response}");
        let response = post_initialize(address, "Authorization: Bearer unknown\r\n");
        assert!(response.contains("error=\"invalid_token\""), "{response}");
        let response = post_initialize(address, "Authorization: Bearer read-access\r\n");
        assert!(response.contains(CHAT_INSTRUCTIONS.as_str()), "{response}");
        assert!(!response.contains("Call current_task"), "{response}");

        let list = |token| rpc_result(address, token, "tools/list", serde_json::json!({}));
        let names = |list: Value| {
            list["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_owned())
                .collect::<std::collections::BTreeSet<_>>()
        };
        let read = names(list("read-access"));
        assert_eq!(
            read,
            [
                "read_toodo_skill",
                "list_workspaces",
                "list_tasks",
                "search_tasks",
                "get_task",
                "get_guidelines",
                "review_report"
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        );
        let all = names(list("secret"));
        let server = ToodoMcp::new(backend.clone());
        assert_eq!(
            all,
            server
                .tool_router
                .list_all()
                .iter()
                .map(|t| t.name.to_string())
                .collect()
        );
        let write = names(list("write-access"));
        assert!(read.is_subset(&write));
        assert_eq!(
            write,
            read.iter()
                .map(String::as_str)
                .chain([
                    "create_workspace",
                    "create_task",
                    "create_plan",
                    "update_task",
                    "move_task",
                    "add_dependency",
                    "remove_dependency",
                    "add_related",
                    "remove_related",
                    "add_criterion",
                    "remove_criterion",
                    "check_criterion",
                    "add_progress_note",
                    "report_blocker",
                    "pause_task",
                    "wait_task",
                    "add_guideline",
                    "update_guideline",
                    "remove_guideline",
                ])
                .map(str::to_owned)
                .collect()
        );
        for name in [
            "current_task",
            "start_task",
            "resume_task",
            "end_wait",
            "update_workspace",
            "archive_workspace",
            "complete_task",
            "conclude_task",
            "delete_task",
            "delete_done_tasks",
            "reopen_task",
        ] {
            assert!(!write.contains(name), "{name}");
            assert!(all.contains(name), "{name}");
            let refused = rpc_result(
                address,
                "write-access",
                "tools/call",
                serde_json::json!({"name":name, "arguments":{}}),
            );
            assert_eq!(refused["isError"], true, "{refused}");
            assert!(
                refused["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("local-only"),
                "{refused}"
            );
        }
        let call = |token, name, arguments| {
            rpc_result(
                address,
                token,
                "tools/call",
                serde_json::json!({"name": name, "arguments": arguments}),
            )
        };
        let refused = call("read-access", "create_task", serde_json::json!({}));
        assert_eq!(refused["isError"], true);
        assert!(
            refused["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("toodo.write")
        );
        for extra in [
            serde_json::json!({"clone_url":"https://example.com/repo"}),
            serde_json::json!({"init":true}),
            serde_json::json!({"source":"github"}),
        ] {
            let mut args = serde_json::json!({"name":"Planning"});
            args.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let refused = call("write-access", "create_workspace", args);
            assert_eq!(refused["isError"], true, "{refused}");
            assert!(
                refused["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("name"),
                "{refused}"
            );
        }
        let created = call(
            "write-access",
            "create_workspace",
            serde_json::json!({
                "name":"Planning",
            }),
        );
        assert_ne!(created["isError"], true, "{created}");
        let workspace: Value =
            serde_json::from_str(created["content"][0]["text"].as_str().unwrap()).unwrap();
        let task = call(
            "write-access",
            "create_task",
            serde_json::json!({
                "workspace_id":workspace["id"], "task_type":"feat", "title":"Plan the feature",
            }),
        );
        assert_ne!(task["isError"], true, "{task}");
        lock(&backend.storage)
            .oauth_revoke_grant(read_grant)
            .unwrap();
        let response = post_initialize(address, "Authorization: Bearer read-access\r\n");
        assert!(response.starts_with("HTTP/1.1 401"), "{response}");
        assert!(response.contains("error=\"invalid_token\""), "{response}");
    }
}
