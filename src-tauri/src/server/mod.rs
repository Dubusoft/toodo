//! The headless server (`toodo-server`) for a Linux machine that runs herdr itself: the
//! commands over HTTP for the web app (the PWA), its events as a server-sent event
//! stream, and the MCP server for agents, all on one port. Workspaces on "Local" are on
//! the server, with POSIX paths.
//!
//! - `POST /api/rpc/<command>` runs a command (see [`rpc`]).
//! - `GET /api/events` streams `tasks-changed`, `agent-statuses-changed`, and
//!   `pull-request-statuses-changed` events with JSON data.
//! - `/api/backups/...` moves database files in and out (see [`files`]).
//! - `/api/devices...` registers, lists, and revokes devices (see [`devices`]).
//! - `/api/push...` subscribes the asking device to Web Push notifications and sets which
//!   ones it gets (see [`push`]).
//! - `POST /api/stream-tickets` and `GET /api/panes/stream` mirror a pane of a task's herdr
//!   workspace over a WebSocket (see [`panes`]); the stream takes a ticket instead of the
//!   token.
//! - `/mcp` is the MCP endpoint.
//! - Anything else is served from the web build of the frontend, when one is configured.
//!
//! `/api` requires the shared web access token or a device's token, and `/mcp` the MCP
//! access token, as a bearer token; the shared tokens are created in the data directory on
//! first start.

mod devices;
mod files;
mod panes;
mod push;
mod rpc;

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::middleware;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{any, get, post, put};
use futures_util::Stream;
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};

use crate::adapters::git::{Git, ProcessRunner};
use crate::adapters::github::GitHub;
use crate::adapters::herdr::Herdr;
use crate::adapters::ssh::{Ssh, SshConfigFile};
use crate::adapters::ssh_tunnel::SshForwarder;
use crate::commands::backup::{self, Backups};
use crate::commands::completion::{self, PullRequestStatusState};
use crate::commands::events::{
    self, AgentStatusState, AgentStatusesChanged, Notifier, PullRequestStatusesChanged,
    TasksChanged, WorkspacesChanged, names,
};
use crate::commands::types::{TaskAgentStatus, TaskPullRequestStatus};
use crate::commands::{
    GitHubState, GitState, HerdrState, Runtime, SshConfigState, SshState, StorageState,
};
use crate::domain::model;
use crate::mcp::tunnels::{self, Tunnels, TunnelsState};
use crate::mcp::{self, Backend, ServerStatus};
use crate::storage::Storage;

const DATABASE_FILE: &str = "toodo.sqlite3";

const WEB_TOKEN_FILE: &str = "web-token";

/// The default port. The server forwards it to its SSH machines too, so agents there reach
/// the MCP endpoint on the same port.
pub const DEFAULT_PORT: u16 = 47616;

/// Events kept for subscribers that read slower than they arrive; a subscriber that falls
/// further behind skips the oldest.
const EVENT_BUFFER: usize = 64;

const USAGE: &str = "Usage: toodo-server [--version]
       toodo-server import FILE

Serves Toodo on one port: the web app, its API, and the MCP server for agents.
--version prints the version, which is the version of the Toodo release it came from,
and the commit it was built from.
import adds the workspaces and tasks of the Toodo database FILE (e.g. a copy
of the former Windows app's toodo.sqlite3) to the data in TOODO_DATA_DIR, after a
pre-restore backup; stop the running server first.

Environment:
  TOODO_LISTEN    address to listen on (default 127.0.0.1:47616)
  TOODO_DATA_DIR  database, backups, and access tokens
                  (default $XDG_DATA_HOME/toodo-server or ~/.local/share/toodo-server)
  TOODO_WEB_DIR   web build of the frontend (`npm run build` writes dist-web);
                  without it only the API and MCP are served
  TOODO_PUSH_SUBJECT
                  contact for push services in notifications, a mailto: or https: URL
                  (default https://github.com/dev-bokdong/toodo)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub web_dir: Option<PathBuf>,
    /// The contact push services see in the VAPID token of every notification.
    pub push_subject: String,
}

impl Config {
    /// Reads the configuration from `TOODO_*` environment variables, through `var`.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let listen = match var("TOODO_LISTEN") {
            Some(listen) => listen
                .parse()
                .map_err(|error| format!("TOODO_LISTEN {listen:?} is not an address: {error}"))?,
            None => SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT)),
        };
        let data_dir = match var("TOODO_DATA_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => match (var("XDG_DATA_HOME"), var("HOME")) {
                (Some(data), _) if !data.is_empty() => Path::new(&data).join("toodo-server"),
                (_, Some(home)) => Path::new(&home).join(".local/share/toodo-server"),
                _ => return Err("set TOODO_DATA_DIR or HOME".to_owned()),
            },
        };
        let web_dir = var("TOODO_WEB_DIR").map(PathBuf::from);
        let push_subject = match var("TOODO_PUSH_SUBJECT") {
            Some(subject) if subject.starts_with("mailto:") || subject.starts_with("https://") => {
                subject
            }
            Some(subject) => {
                return Err(format!(
                    "TOODO_PUSH_SUBJECT {subject:?} is not a mailto: or https: URL"
                ));
            }
            None => push::DEFAULT_SUBJECT.to_owned(),
        };
        Ok(Self {
            listen,
            data_dir,
            web_dir,
            push_subject,
        })
    }
}

/// An event for the frontend: its name and JSON data.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerEvent {
    name: &'static str,
    data: String,
}

/// Everything the commands, the MCP server, and the background threads use.
pub struct Services {
    storage: StorageState,
    git: GitState,
    github: GitHubState,
    ssh: SshState,
    ssh_config: SshConfigState,
    herdr: HerdrState,
    agent_statuses: AgentStatusState,
    pull_request_statuses: PullRequestStatusState,
    backups: Backups,
    mcp: ServerStatus,
    tunnels: TunnelsState,
    events: broadcast::Sender<ServerEvent>,
    /// The largest database file `POST /api/backups/restore` accepts, in bytes.
    restore_limit: u64,
    panes: panes::Panes,
    push: push::Push,
}

impl Services {
    fn emit(&self, name: &'static str, payload: &impl serde::Serialize) {
        match serde_json::to_string(payload) {
            // No subscriber is the usual case while no browser is open.
            Ok(data) => drop(self.events.send(ServerEvent { name, data })),
            Err(error) => eprintln!("toodo: failed to encode {name}: {error}"),
        }
    }
}

impl Notifier for Services {
    fn tasks_changed(&self, workspace: model::WorkspaceId) {
        let event = TasksChanged {
            workspace_id: workspace.into(),
        };
        self.emit(names::TASKS_CHANGED, &event);
        self.push.tasks_changed();
    }

    fn workspaces_changed(&self) {
        self.emit(names::WORKSPACES_CHANGED, &WorkspacesChanged);
    }

    fn agent_statuses_changed(&self, statuses: &[TaskAgentStatus]) {
        let event = AgentStatusesChanged {
            statuses: statuses.to_vec(),
        };
        self.emit(names::AGENT_STATUSES_CHANGED, &event);
        self.push.agent_statuses_changed(statuses);
    }

    fn pull_request_statuses_changed(&self, statuses: &[TaskPullRequestStatus]) {
        let event = PullRequestStatusesChanged {
            statuses: statuses.to_vec(),
        };
        self.emit(names::PULL_REQUEST_STATUSES_CHANGED, &event);
        self.push.pull_request_statuses_changed(statuses);
    }
}

impl Backend for Services {
    fn storage(&self) -> &StorageState {
        &self.storage
    }

    fn git(&self) -> &Git {
        &self.git
    }

    fn github(&self) -> &GitHub {
        &self.github
    }

    fn herdr(&self) -> &Herdr {
        &self.herdr
    }

    fn server(&self) -> &ServerStatus {
        &self.mcp
    }
}

impl Runtime for Services {
    fn agent_statuses(&self) -> &AgentStatusState {
        &self.agent_statuses
    }

    fn pull_request_statuses(&self) -> &PullRequestStatusState {
        &self.pull_request_statuses
    }

    fn backups(&self) -> &Backups {
        &self.backups
    }
}

/// `toodo-server <version> (commit <sha>)`: the release version and the commit of the
/// build, which tells a build of a later commit apart from the release it reports.
fn version() -> String {
    with_commit(env!("CARGO_PKG_VERSION"), env!("TOODO_COMMIT"))
}

fn with_commit(version: &str, commit: &str) -> String {
    if commit.is_empty() {
        format!("toodo-server {version}")
    } else {
        format!("toodo-server {version} (commit {commit})")
    }
}

/// Runs the server until it is interrupted (Ctrl+C or SIGTERM).
pub fn main() {
    if std::env::args()
        .skip(1)
        .any(|arg| arg == "-h" || arg == "--help")
    {
        println!("{USAGE}");
        return;
    }
    if std::env::args()
        .skip(1)
        .any(|arg| arg == "-V" || arg == "--version")
    {
        println!("{}", version());
        return;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let source = match args.as_slice() {
        [] => None,
        [command, file] if command == "import" => Some(PathBuf::from(file)),
        _ => {
            eprintln!("toodo-server: unexpected arguments {args:?}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    let config = match Config::from_env(|name| std::env::var(name).ok()) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("toodo-server: {error}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    let result = match source {
        Some(source) => import(&config, &source),
        None => run(config),
    };
    if let Err(error) = result {
        eprintln!("toodo-server: {error}");
        std::process::exit(1);
    }
}

/// Imports the Toodo database at `source` into the data directory, see
/// [`backup::import_file`].
fn import(config: &Config, source: &Path) -> Result<(), Box<dyn std::error::Error>> {
    create_private_dir(&config.data_dir)?;
    let storage = Mutex::new(Storage::open(&config.data_dir.join(DATABASE_FILE))?);
    let backups = Backups::load(&config.data_dir);
    let (safety, summary) = backup::import_file(&storage, &backups, source)?;
    println!(
        "Saved the data before the import as {}",
        safety.path.display()
    );
    println!(
        "Imported {} workspaces and {} tasks from {}.",
        summary.workspaces,
        summary.tasks,
        source.display()
    );
    if summary.task_id_offset > 0 {
        println!(
            "Task #N of the imported database is task #(N + {}) here.",
            summary.task_id_offset
        );
    }
    Ok(())
}

fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    create_private_dir(&config.data_dir)?;
    let storage = Storage::open(&config.data_dir.join(DATABASE_FILE))?;
    let mcp_token_path = config.data_dir.join(mcp::TOKEN_FILE);
    let mcp_token = mcp::load_token(&mcp_token_path)?;
    let web_token_path = config.data_dir.join(WEB_TOKEN_FILE);
    let web_token = mcp::load_token(&web_token_path)?;
    let push = push::Push::load(&config.data_dir, config.push_subject.clone())?;
    let listener = mcp::bind(config.listen)?;
    let port = listener.local_addr()?.port();
    let herdr = Arc::new(Herdr::new(Box::new(ProcessRunner)));
    let services = Arc::new(Services {
        storage: Mutex::new(storage),
        git: Arc::new(Git::new(Box::new(ProcessRunner))),
        github: Arc::new(GitHub::new(Box::new(ProcessRunner))),
        ssh: Arc::new(Ssh::new(Box::new(ProcessRunner))),
        ssh_config: SshConfigFile::in_home(),
        panes: panes::Panes::new(Arc::new(panes::HerdrSockets(herdr.clone()))),
        herdr,
        agent_statuses: Mutex::default(),
        pull_request_statuses: Mutex::default(),
        backups: Backups::load(&config.data_dir),
        mcp: ServerStatus {
            url: mcp::url(port),
            token: Some(mcp_token.clone()),
            token_file: Some(mcp_token_path.clone()),
            instance: mcp::new_instance()?,
            error: None,
            rejections: mcp::Rejections::default(),
        },
        tunnels: Arc::new(Mutex::new(Tunnels::new(Box::new(SshForwarder), port))),
        events: broadcast::channel(EVENT_BUFFER).0,
        restore_limit: files::RESTORE_LIMIT,
        push,
    });
    push::spawn(services.clone())?;
    events::spawn(services.clone())?;
    backup::spawn(services.clone())?;
    completion::spawn(services.clone())?;
    tunnels::spawn(services.clone(), services.tunnels.clone())?;

    let app = router(
        services.clone(),
        web_token,
        mcp_token,
        config.web_dir.as_deref(),
    );
    println!(
        "{}: listening on http://{} (data in {}, web access token in {}, MCP token for \
         agents in {}, instance {})",
        version(),
        config.listen,
        config.data_dir.display(),
        web_token_path.display(),
        mcp_token_path.display(),
        services.mcp.instance
    );
    match &config.web_dir {
        Some(dir) => println!("toodo-server: serving the web app from {}", dir.display()),
        None => println!("toodo-server: TOODO_WEB_DIR is not set; serving the API and MCP only"),
    }
    let served = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async move {
            tokio::select! {
                served = mcp::serve(listener, app) => served,
                () = interrupted() => Ok(()),
            }
        });
    services
        .tunnels
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .shut_down();
    Ok(served?)
}

/// Creates the data directory, which holds the access tokens, so that on Unix only the
/// owner can enter it; an existing one is tightened.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::DirBuilder::new().mode(0o700).create(dir) {
            Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => return Err(error),
            _ => {}
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)
}

/// The routes: the API behind the web token, MCP behind its own token, and the web app.
fn router(
    services: Arc<Services>,
    web_token: String,
    mcp_token: String,
    web_dir: Option<&Path>,
) -> Router {
    // `route_layer` guards the routes only: other paths stay 404 (or the web app) rather
    // than 401, and unknown API paths are 404 behind the token instead of the web app.
    let api = Router::new()
        .route("/api/rpc/{command}", post(rpc::handle))
        .route("/api/events", get(event_stream))
        .route("/api/backups/export", get(files::export))
        // The handler streams the body to disk and enforces its own limit.
        .route(
            "/api/backups/restore",
            post(files::restore).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/backups/{name}", get(files::download))
        .route("/api/devices", get(devices::list).post(devices::register))
        .route("/api/devices/{id}/revoke", post(devices::revoke))
        .route("/api/push", get(push::state))
        .route(
            "/api/push/subscription",
            put(push::subscribe).delete(push::unsubscribe),
        )
        .route("/api/push/settings", put(push::save_settings))
        .route("/api/push/test", post(push::send_test))
        .route("/api/stream-tickets", post(panes::issue_ticket))
        .route("/api/{*path}", any(|| async { StatusCode::NOT_FOUND }))
        .route_layer(middleware::from_fn_with_state(
            devices::Gate {
                services: services.clone(),
                shared_token: Arc::new(web_token.clone()),
                mcp_token: Arc::new(mcp_token.clone()),
            },
            devices::require_access,
        ))
        .with_state(services.clone());
    // Browsers cannot send the token on a WebSocket; the stream checks its ticket instead.
    let streams = Router::new()
        .route("/api/panes/stream", get(panes::stream))
        .with_state(services.clone());
    let app = api
        .merge(streams)
        .merge(mcp::router(services, mcp_token, Some(web_token)));
    match web_dir {
        Some(dir) => app
            .fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")))),
        None => app,
    }
}

async fn event_stream(
    axum::extract::State(services): axum::extract::State<Arc<Services>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    Sse::new(sent_events(services.events.subscribe())).keep_alive(KeepAlive::default())
}

/// The events of `events` as server-sent events. A subscriber that fell behind and missed
/// some gets its stream ended instead, so the client reconnects and refetches everything.
fn sent_events(
    events: broadcast::Receiver<ServerEvent>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    futures_util::stream::unfold(events, |mut events| async {
        match events.recv().await {
            Ok(event) => {
                let sent = Event::default().event(event.name).data(event.data);
                Some((Ok(sent), events))
            }
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                eprintln!("toodo-server: an event stream missed {missed} events; ending it");
                None
            }
            Err(broadcast::error::RecvError::Closed) => None,
        }
    })
}

async fn interrupted() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("toodo-server: cannot listen for Ctrl+C: {error}");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => drop(signal.recv().await),
            Err(error) => {
                eprintln!("toodo-server: cannot listen for SIGTERM: {error}");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    println!("toodo-server: stopping");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_config_listens_on_loopback_and_keeps_data_in_home() {
        let config =
            Config::from_env(|name| (name == "HOME").then(|| "/home/me".to_owned())).unwrap();
        assert_eq!(
            config.listen,
            SocketAddr::from((Ipv4Addr::LOCALHOST, 47616))
        );
        assert_eq!(
            config.data_dir,
            PathBuf::from("/home/me/.local/share/toodo-server")
        );
    }

    #[test]
    fn the_version_names_the_commit_of_the_build() {
        assert_eq!(
            with_commit("1.2.3", "0123456789ab"),
            "toodo-server 1.2.3 (commit 0123456789ab)"
        );
        assert_eq!(with_commit("1.2.3", ""), "toodo-server 1.2.3");
        assert!(version().starts_with(&format!("toodo-server {}", env!("CARGO_PKG_VERSION"))));
    }

    const TEST_RESTORE_LIMIT: u64 = 1024 * 1024;

    fn services(data_dir: &Path) -> Arc<Services> {
        let herdr = Arc::new(Herdr::new(Box::new(ProcessRunner)));
        let access = Arc::new(panes::HerdrSockets(herdr.clone()));
        services_with(data_dir, herdr, access)
    }

    pub(super) fn services_with(
        data_dir: &Path,
        herdr: HerdrState,
        access: Arc<dyn panes::PaneAccess>,
    ) -> Arc<Services> {
        Arc::new(Services {
            storage: Mutex::new(Storage::open_in_memory().unwrap()),
            git: Arc::new(Git::new(Box::new(ProcessRunner))),
            github: Arc::new(GitHub::new(Box::new(ProcessRunner))),
            ssh: Arc::new(Ssh::new(Box::new(ProcessRunner))),
            ssh_config: SshConfigFile::in_home(),
            panes: panes::Panes::new(access),
            herdr,
            agent_statuses: Mutex::default(),
            pull_request_statuses: Mutex::default(),
            backups: Backups::load(data_dir),
            mcp: ServerStatus {
                url: mcp::url(0),
                token: None,
                token_file: None,
                instance: "0123456789ab".to_owned(),
                error: None,
                rejections: mcp::Rejections::default(),
            },
            tunnels: Arc::new(Mutex::new(Tunnels::new(Box::new(SshForwarder), 0))),
            events: broadcast::channel(EVENT_BUFFER).0,
            restore_limit: TEST_RESTORE_LIMIT,
            push: push::tests::push(data_dir, push::tests::FakeTransport::default()),
        })
    }

    /// The status line of a request to `address`.
    fn status(address: SocketAddr, method: &str, path: &str, token: Option<&str>) -> String {
        response(address, method, path, token)
            .lines()
            .next()
            .unwrap_or_default()
            .to_owned()
    }

    /// The whole response to a request to `address`.
    fn response(address: SocketAddr, method: &str, path: &str, token: Option<&str>) -> String {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        let authorization = token
            .map(|token| format!("Authorization: Bearer {token}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{authorization}\
             Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn serve_router(web_dir: Option<&Path>) -> (SocketAddr, tempfile::TempDir) {
        let (address, temp, _) = serve_services(web_dir);
        (address, temp)
    }

    fn serve_services(web_dir: Option<&Path>) -> (SocketAddr, tempfile::TempDir, Arc<Services>) {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path());
        let address = serve(services.clone(), web_dir);
        (address, temp, services)
    }

    /// Serves `services` with the web token `web` and the MCP token `agent`.
    pub(super) fn serve(services: Arc<Services>, web_dir: Option<&Path>) -> SocketAddr {
        let app = router(services, "web".to_owned(), "agent".to_owned(), web_dir);
        let listener = mcp::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(mcp::serve(listener, app))
        });
        address
    }

    #[test]
    fn only_api_routes_need_the_web_token() {
        let (address, _temp) = serve_router(None);
        let rpc = "/api/rpc/list_workspaces";
        assert!(status(address, "POST", rpc, None).contains(" 401 "));
        assert!(status(address, "POST", rpc, Some("agent")).contains(" 401 "));
        assert!(status(address, "POST", rpc, Some("web")).contains(" 200 "));
        assert!(status(address, "GET", "/api/events", None).contains(" 401 "));
        assert!(status(address, "GET", "/api/nothing", None).contains(" 401 "));
        assert!(status(address, "GET", "/api/nothing", Some("web")).contains(" 404 "));
        assert!(status(address, "POST", "/mcp", None).contains(" 401 "));
        assert!(status(address, "POST", "/mcp", Some("web")).contains(" 401 "));
        assert!(!status(address, "POST", "/mcp", Some("agent")).contains(" 401 "));
        // A 401 says why, and which token goes where.
        let body = |path, token| response(address, "POST", path, token);
        assert!(body(rpc, None).contains("Toodo API: the request has no Authorization header"));
        assert!(body(rpc, Some("agent")).contains("this is the MCP token for agents"));
        assert!(body(rpc, Some("nope")).contains("neither the web sign-in token"));
        assert!(body("/mcp", Some("web")).contains("this is the web sign-in token"));
        assert!(body("/mcp", Some("nope")).contains("does not accept the token"));
        // Without a web build, other paths are simply not there.
        assert!(status(address, "GET", "/", None).contains(" 404 "));
        assert!(status(address, "GET", "/tasks", None).contains(" 404 "));
    }

    #[test]
    fn the_web_app_is_served_without_a_token_but_not_for_api_paths() {
        let web = tempfile::tempdir().unwrap();
        std::fs::write(web.path().join("index.html"), "<html></html>").unwrap();
        let (address, _temp) = serve_router(Some(web.path()));
        assert!(status(address, "GET", "/", None).contains(" 200 "));
        assert!(status(address, "GET", "/tasks/1", None).contains(" 200 "));
        assert!(status(address, "GET", "/api/nothing", None).contains(" 401 "));
        assert!(status(address, "GET", "/api/nothing", Some("web")).contains(" 404 "));
    }

    /// Sends `head` (request line and headers, without the blank line) and `body`; returns
    /// the status line, the headers, and the body of the response. A server that answers
    /// before reading the whole body may close the connection while it is being sent.
    pub(super) fn exchange(
        address: SocketAddr,
        head: &str,
        body: &[u8],
    ) -> (String, String, Vec<u8>) {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .write_all(format!("{head}\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes())
            .unwrap();
        drop(stream.write_all(body));
        let mut response = Vec::new();
        drop(stream.read_to_end(&mut response));
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("a response head");
        let head = String::from_utf8(response[..split].to_vec()).unwrap();
        let (status, headers) = head.split_once("\r\n").unwrap_or((&head, ""));
        (
            status.to_owned(),
            headers.to_ascii_lowercase(),
            response[split + 4..].to_vec(),
        )
    }

    fn get(address: SocketAddr, path: &str, token: Option<&str>) -> (String, String, Vec<u8>) {
        let authorization = token
            .map(|token| format!("\r\nAuthorization: Bearer {token}"))
            .unwrap_or_default();
        exchange(address, &format!("GET {path} HTTP/1.1{authorization}"), b"")
    }

    fn upload(address: SocketAddr, token: &str, body: &[u8]) -> (String, String, Vec<u8>) {
        exchange(
            address,
            &format!(
                "POST /api/backups/restore HTTP/1.1\r\nAuthorization: Bearer {token}\r\n\
                 Content-Type: application/octet-stream\r\nContent-Length: {}",
                body.len()
            ),
            body,
        )
    }

    fn add_workspace(services: &Services, name: &str) {
        use crate::domain::model::WorkspaceLocation;
        use crate::domain::path::PosixPath;
        crate::commands::lock(&services.storage)
            .create_workspace(&crate::storage::NewWorkspace {
                name: name.to_owned(),
                location: WorkspaceLocation::Local {
                    path: PosixPath::parse(&format!("/srv/{name}")).unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
            })
            .unwrap();
    }

    fn workspace_names(services: &Services) -> Vec<String> {
        crate::commands::lock(&services.storage)
            .list_workspaces()
            .unwrap()
            .into_iter()
            .map(|workspace| workspace.name)
            .collect()
    }

    const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

    #[test]
    fn database_files_round_trip_over_http() {
        let (address, temp, services) = serve_services(None);
        add_workspace(&services, "before");

        let (status, headers, export) = get(address, "/api/backups/export", Some("web"));
        assert!(status.contains(" 200 "), "{status}");
        assert!(
            headers.contains("content-type: application/vnd.sqlite3"),
            "{headers}"
        );
        assert!(
            headers.contains("content-disposition: attachment; filename=\"toodo-backup-"),
            "{headers}"
        );
        assert!(export.starts_with(SQLITE_MAGIC));

        add_workspace(&services, "after");
        let (status, _, body) = upload(address, "web", &export);
        assert!(status.contains(" 200 "), "{status}");
        let safety: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(safety["kind"], "preRestore");
        assert_eq!(workspace_names(&services), ["before"]);

        // The pre-restore backup downloads by name and brings the newer data back.
        let name = Path::new(safety["path"].as_str().unwrap())
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let (status, headers, saved) = get(address, &format!("/api/backups/{name}"), Some("web"));
        assert!(status.contains(" 200 "), "{status}");
        assert!(
            headers.contains(&format!("filename=\"{name}\"")),
            "{headers}"
        );
        assert!(upload(address, "web", &saved).0.contains(" 200 "));
        assert_eq!(workspace_names(&services), ["before", "after"]);

        // Snapshots and uploads leave nothing behind in the backup directory.
        let leftovers: Vec<String> = std::fs::read_dir(temp.path().join("backups"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn bad_uploads_and_names_change_nothing() {
        let (address, _temp, services) = serve_services(None);
        add_workspace(&services, "toodo");

        let (status, _, body) = upload(address, "web", &b"not a database ".repeat(400));
        assert!(status.contains(" 422 "), "{status}");
        assert!(String::from_utf8_lossy(&body).contains("invalidInput"));

        let declared = exchange(
            address,
            &format!(
                "POST /api/backups/restore HTTP/1.1\r\nAuthorization: Bearer web\r\n\
                 Content-Length: {}",
                TEST_RESTORE_LIMIT + 1
            ),
            b"",
        );
        assert!(declared.0.contains(" 413 "), "{}", declared.0);

        // Without a length up front, the limit applies while the body arrives.
        let chunk = vec![b'x'; 64 * 1024];
        let mut chunked = Vec::new();
        for _ in 0..20 {
            chunked.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            chunked.extend_from_slice(&chunk);
            chunked.extend_from_slice(b"\r\n");
        }
        chunked.extend_from_slice(b"0\r\n\r\n");
        let streamed = exchange(
            address,
            "POST /api/backups/restore HTTP/1.1\r\nAuthorization: Bearer web\r\n\
             Transfer-Encoding: chunked",
            &chunked,
        );
        assert!(streamed.0.contains(" 413 "), "{}", streamed.0);

        for name in [
            "toodo.sqlite3",
            "..%2Ftoodo.sqlite3",
            "toodo-auto-20261014-093005.sqlite3",
        ] {
            let (status, _, _) = get(address, &format!("/api/backups/{name}"), Some("web"));
            assert!(status.contains(" 404 "), "{name}: {status}");
        }
        assert!(
            get(address, "/api/backups/export", None)
                .0
                .contains(" 401 ")
        );
        assert!(upload(address, "agent", b"").0.contains(" 401 "));
        assert_eq!(workspace_names(&services), ["toodo"]);
    }

    fn post_json(
        address: SocketAddr,
        path: &str,
        token: &str,
        body: &serde_json::Value,
    ) -> (String, serde_json::Value) {
        let body = body.to_string();
        let (status, _, reply) = exchange(
            address,
            &format!(
                "POST {path} HTTP/1.1\r\nAuthorization: Bearer {token}\r\n\
                 Content-Type: application/json\r\nContent-Length: {}",
                body.len()
            ),
            body.as_bytes(),
        );
        (status, serde_json::from_slice(&reply).unwrap_or_default())
    }

    fn devices_seen_by(address: SocketAddr, token: &str) -> serde_json::Value {
        let (status, _, body) = get(address, "/api/devices", Some(token));
        assert!(status.contains(" 200 "), "{status}");
        serde_json::from_slice(&body).unwrap()
    }

    #[test]
    fn devices_sign_in_with_the_shared_token_and_are_revoked_alone() {
        let (address, _temp, services) = serve_services(None);
        let label = |name: &str| serde_json::json!({ "label": name });
        let app_info = |token: &str| status(address, "POST", "/api/rpc/app_info", Some(token));

        let (created, phone) = post_json(address, "/api/devices", "web", &label(" Phone "));
        assert!(created.contains(" 201 "), "{created}");
        let phone_token = phone["token"].as_str().unwrap().to_owned();
        assert_eq!(phone_token.len(), 64);
        assert_eq!(phone["device"]["label"], "Phone");
        let (_, laptop) = post_json(address, "/api/devices", "web", &label("Laptop"));
        let laptop_token = laptop["token"].as_str().unwrap().to_owned();

        assert!(app_info(&phone_token).contains(" 200 "));
        let seen = devices_seen_by(address, &phone_token);
        let current: Vec<&str> = seen
            .as_array()
            .unwrap()
            .iter()
            .filter(|device| device["current"] == true)
            .map(|device| device["label"].as_str().unwrap())
            .collect();
        assert_eq!(current, ["Phone"]);
        assert!(
            devices_seen_by(address, "web")
                .as_array()
                .unwrap()
                .iter()
                .all(|device| device["current"] == false)
        );

        // A device token cannot mint more tokens; bad labels are refused.
        let (forbidden, _) = post_json(address, "/api/devices", &phone_token, &label("Spare"));
        assert!(forbidden.contains(" 403 "), "{forbidden}");
        let (blank, _) = post_json(address, "/api/devices", "web", &label("  "));
        assert!(blank.contains(" 422 "), "{blank}");
        assert!(
            post_json(address, "/api/devices", "agent", &label("MCP"))
                .0
                .contains(" 401 ")
        );

        let phone_id = phone["device"]["id"].as_i64().unwrap();
        let revoke = format!("/api/devices/{phone_id}/revoke");
        let (revoked, device) = post_json(address, &revoke, &laptop_token, &serde_json::json!({}));
        assert!(revoked.contains(" 200 "), "{revoked}");
        assert!(device["revokedAt"].is_i64());
        assert!(app_info(&phone_token).contains(" 401 "));
        assert!(app_info(&laptop_token).contains(" 200 "));
        assert!(app_info("web").contains(" 200 "));
        assert!(
            post_json(
                address,
                "/api/devices/99/revoke",
                "web",
                &serde_json::json!({})
            )
            .0
            .contains(" 404 ")
        );
        assert_eq!(
            crate::commands::lock(&services.storage)
                .list_devices()
                .unwrap()
                .len(),
            2
        );
    }

    fn send_json(
        address: SocketAddr,
        method: &str,
        path: &str,
        token: &str,
        body: &serde_json::Value,
    ) -> (String, serde_json::Value) {
        let body = body.to_string();
        let (status, _, reply) = exchange(
            address,
            &format!(
                "{method} {path} HTTP/1.1\r\nAuthorization: Bearer {token}\r\n\
                 Content-Type: application/json\r\nContent-Length: {}",
                body.len()
            ),
            body.as_bytes(),
        );
        (status, serde_json::from_slice(&reply).unwrap_or_default())
    }

    #[test]
    fn devices_subscribe_to_push_notifications_and_get_a_test_one() {
        let temp = tempfile::tempdir().unwrap();
        let transport = push::tests::FakeTransport::default();
        let requests = transport.requests.clone();
        let services = services(temp.path());
        let services = Arc::new(Services {
            push: push::tests::push(temp.path(), transport),
            ..Arc::into_inner(services).unwrap()
        });
        let address = serve(services.clone(), None);
        let (_, phone) = post_json(
            address,
            "/api/devices",
            "web",
            &serde_json::json!({ "label": "Phone" }),
        );
        let token = phone["token"].as_str().unwrap().to_owned();
        let browser = push::tests::Browser::new();
        let subscription = browser.json("https://push.example/send/1");

        let (status, state) =
            send_json(address, "GET", "/api/push", &token, &serde_json::json!({}));
        assert!(status.contains(" 200 "), "{status}");
        let public_key = state["publicKey"].as_str().unwrap();
        assert_eq!(push::crypto::from_base64url(public_key).unwrap().len(), 65);
        assert_eq!(state["subscription"], serde_json::Value::Null);

        let shared = send_json(
            address,
            "PUT",
            "/api/push/subscription",
            "web",
            &subscription,
        );
        assert!(shared.0.contains(" 403 "), "{}", shared.0);
        let mut bad = subscription.clone();
        bad["endpoint"] = "http://push.example/send/1".into();
        let bad = send_json(address, "PUT", "/api/push/subscription", &token, &bad);
        assert!(bad.0.contains(" 422 "), "{}", bad.0);
        let mut off_curve = subscription.clone();
        off_curve["keys"]["p256dh"] = push::crypto::base64url(&[4; 65]).into();
        let off_curve = send_json(address, "PUT", "/api/push/subscription", &token, &off_curve);
        assert!(off_curve.0.contains(" 422 "), "{}", off_curve.0);
        let test = send_json(
            address,
            "POST",
            "/api/push/test",
            &token,
            &serde_json::json!({}),
        );
        assert!(test.0.contains(" 404 "), "{}", test.0);

        let (status, saved) = send_json(
            address,
            "PUT",
            "/api/push/subscription",
            &token,
            &subscription,
        );
        assert!(status.contains(" 200 "), "{status}");
        assert_eq!(
            saved,
            serde_json::json!({
                "endpoint": "https://push.example/send/1",
                "settings": { "agent": true, "pullRequests": true, "completion": true }
            })
        );
        let quiet = serde_json::json!({ "agent": true, "pullRequests": false, "completion": true });
        let (status, saved) = send_json(address, "PUT", "/api/push/settings", &token, &quiet);
        assert!(status.contains(" 200 "), "{status}");
        assert_eq!(saved["settings"], quiet);
        let state = send_json(address, "GET", "/api/push", &token, &serde_json::json!({})).1;
        assert_eq!(state["subscription"]["settings"], quiet);

        let (status, _) = send_json(
            address,
            "POST",
            "/api/push/test",
            &token,
            &serde_json::json!({}),
        );
        assert!(status.contains(" 200 "), "{status}");
        let request = requests.lock().unwrap().remove(0);
        assert_eq!(request.endpoint, "https://push.example/send/1");
        let message = browser.decrypt(&request.body);
        assert_eq!(message["tag"], "test");
        assert_eq!(message["taskId"], serde_json::Value::Null);
        assert!(
            request
                .authorization
                .ends_with(&format!(", k={public_key}"))
        );

        let (status, _) = send_json(
            address,
            "DELETE",
            "/api/push/subscription",
            &token,
            &serde_json::json!({}),
        );
        assert!(status.contains(" 200 "), "{status}");
        assert!(
            crate::commands::lock(&services.storage)
                .active_push_subscriptions()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn commands_that_take_client_paths_are_not_served() {
        let (address, _temp) = serve_router(None);
        for command in ["save_report", "export_database", "restore_database"] {
            let status = status(address, "POST", &format!("/api/rpc/{command}"), Some("web"));
            assert!(status.contains(" 404 "), "{command}: {status}");
        }
    }

    #[test]
    fn an_event_stream_that_fell_behind_ends() {
        use futures_util::StreamExt;
        let (sender, receiver) = broadcast::channel(2);
        let event = |data: &str| ServerEvent {
            name: names::TASKS_CHANGED,
            data: data.to_owned(),
        };
        drop(sender.send(event("1")));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let mut stream = Box::pin(sent_events(receiver));
        assert!(runtime.block_on(stream.next()).is_some());
        for data in ["2", "3", "4"] {
            drop(sender.send(event(data)));
        }
        assert!(runtime.block_on(stream.next()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn only_the_owner_can_enter_the_data_directory() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let temp = tempfile::tempdir().unwrap();
        let created = temp.path().join("share/toodo-server");
        create_private_dir(&created).unwrap();
        assert_eq!(mode(&created), 0o700);

        let existing = temp.path().join("existing");
        std::fs::create_dir(&existing).unwrap();
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o775)).unwrap();
        create_private_dir(&existing).unwrap();
        assert_eq!(mode(&existing), 0o700);
    }
}
