//! MCP server for coding agents, embedded in the app so it shares the database lock and
//! tells the frontend about changes like any command.
//!
//! It serves Streamable HTTP on a fixed loopback port and requires the bearer token kept
//! in the app data directory. Agents can read and add workspaces, read and set the
//! worktree root of each machine, read tasks, search earlier tasks
//! and read their history, create and edit tasks, connect dependencies and related
//! links, leave progress and blocker notes in a task's history, and start, complete, or
//! conclude tasks and restore a lost worktree through the app's own commands; deleting
//! tasks stays
//! in the app. The `toodo` skill, the
//! workflow for working on a task, is served by the `read_toodo_skill` tool rather than
//! as a resource, since not every client can read resources. Agents on SSH machines reach
//! the server through the reverse tunnels of [`tunnels`].

mod tools;
pub mod tunnels;

use std::fs;
use std::io;
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use serde::Serialize;

use crate::adapters::git::Git;
use crate::adapters::github::GitHub;
use crate::adapters::herdr::Herdr;
use crate::commands::events::Notifier;
use crate::commands::tasks as task_commands;
use crate::commands::types::Task;
use crate::commands::{CommandResult, StorageState, lock};
use crate::domain::model;

pub(crate) const TOKEN_FILE: &str = "mcp-token";

const SKILL: &str = include_str!("toodo-skill.md");

const INSTRUCTIONS: &str = "Toodo plans tasks as a dependency DAG across workspaces; \
a task becomes ready only when all tasks it depends on are done.

Before you work on a Toodo task or create tasks, read the toodo skill unless you \
already have it: call the read_toodo_skill tool. It is the workflow from the task description to a pull \
request into the workspace base branch, including when to stop for prerequisite tasks, \
and the format of task descriptions.

How to use these tools:
1. Call current_task with your absolute working directory first. Use its workspaceId \
for new tasks in the same repository and its baseBranch as the base of your pull \
request. If it finds no task and you were asked to work on a Toodo task, tell the \
user and ask for its id, then read it with get_task; to plan new work outside a task, \
pick the workspace with list_workspaces. If its worktree directory is gone \
(worktreeMissing true), call restore_worktree with the task id. Add a \
workspace with create_workspace only when the user asks for a repository that \
list_workspaces does not have yet.
2. Before you plan work or call create_task, call search_tasks with a few distinctive \
words of the work (all workspaces unless the work clearly belongs to one) to find \
earlier tasks about it, and get_task on the relevant ones to read what was decided \
then: description, notes, completion note (why research was not adopted), pull \
request, and commits. Follow their depends_on, dependents, and related links with \
get_task to understand the history. Reuse a matching open task instead of creating a \
duplicate. When a new task builds on earlier context but does not have to wait for it, \
link them with add_related; use add_dependency only for a real prerequisite (rule 3). \
Related links never block starting a task; remove_related drops one.
3. A dependency points from a task to the tasks that must be done before it: task_id is \
the dependent task and depends_on its prerequisites; self and cyclic dependencies are \
rejected. Decide the direction by what has to finish first:
   - Work that builds on your task once it is done (a follow-up feature, the next \
step): create_task with depends_on set to your task's id.
   - Work your task needs before it can be finished (e.g. fixes found while verifying \
it): create those tasks without depending on your task, then call add_dependency with \
task_id = your task and depends_on = all of the new task ids. Never make them depend on \
your task: your task could then never finish.
   Adding a prerequisite that is not done to an in_progress task pauses it. Its herdr \
workspace stays open, and the Toodo app asks the user whether to close it, which ends \
your session; the user resumes the task in the app once its prerequisites are done. So \
create every task first, tell the user what you planned and why, make that \
add_dependency call last, with all prerequisites in one call, and stop working on the \
task after it. Use remove_dependency to drop an edge.
4. Pick task_type by the kind of change (feat, fix, modify, refactor, docs, test, chore, \
rnd), write a short imperative title, and put details in description. Write the \
description in GitHub-flavored Markdown (Toodo renders it and uses it as the GitHub \
issue body) with two sections: `## Purpose` (the outcome and why) and `## Background` \
(context, what prompted it, related tasks, constraints). Put what has to hold for the \
task to be done in criteria, not in the description: one verifiable item each, kind \
manual for what is checked by hand, url or command (with target) or pr_open_ci_green \
for what Toodo checks itself. The merge criterion comes first unless you set \
merge_criterion false for work that ships no code. Use `-` lists, backticks for code, \
paths, and commands, fenced code blocks, and links; no raw HTML. \
When you split work into tasks, set estimate to your expected size of each (hours, \
days, weeks, or months of active work); the user's reviews compare it \
with the time the task actually took. Set due_date (YYYY-MM-DD) only when the user named \
a deadline.
5. Leave a record of your work on your task as you go; it feeds the user's reviews of \
their work. Call add_progress_note when you take a decision worth remembering (the choice \
and why, e.g. a library or approach over its alternatives) or finish a meaningful step, \
and report_blocker when something stops you that needs the user or someone else (missing \
access, an unclear requirement, a failing dependency), saying what you need. Write one \
or two Markdown sentences per note; skip routine steps such as running tests or small \
edits. Neither tool changes the task's status. To stop work on a task for another \
reason than a prerequisite (rule 3), call pause_task with the reason, which pauses it as \
the app's Pause does, and resume_task to continue a paused task once the reason is gone.
6. A tool error says what was rejected; change the arguments instead of retrying them \
unchanged. Arguments a tool does not know are rejected with the ones it accepts.
7. start_task, complete_task, and conclude_task act on other tasks, the way the user \
would in the Toodo app: start a ready task (or resume a paused one) for another agent \
session, complete a task whose completion criteria are met (which confirms one that \
awaits completion), or conclude one that ends without a merge (research not adopted, a \
duplicate, work no longer needed) with the reason. Never start, complete, or conclude \
your own task, the one current_task finds: it was started for you, and meeting its \
criteria completes it. conclude_task \
never closes a pull request, so a task with an open one is rejected; the user concludes \
it in the app. When one pull request ships the work of several tasks, complete each \
extra task with complete_task and merged_with set to the task that owns the pull \
request (or the pull request URL) once it is merged, never with conclude_task: \
not_adopted means the work did not ship. A task already concluded that way can be \
completed with merged_with too. For work shipped without any pull request, call \
complete_task with without_pull_request: true and a non-empty note: the result is \
completed, pr_merged uses that note as evidence, and every other criterion must hold.
8. start_task needs a worktree root, the directory that holds task worktrees, on the \
machine of the task's workspace. list_machine_settings shows it for every machine. Set \
a missing one with set_worktree_root to a directory the user named, or when start_task \
reports it missing and the user tells you where worktrees go. Never change or clear a \
root that is set unless the user asks.
9. A task is done when its completion criteria are met. Toodo checks every kind but \
manual itself, about once a minute: pr_merged and pr_open_ci_green from the task's pull \
request, branch_merged_locally from the repository (for workspaces without an origin \
remote, where the task branch is merged into baseBranch locally and nothing is pushed), \
url by fetching its target, and command by running its target in the task worktree once \
every criterion but the merge criterion is met, so it can check the work before the \
merge. Check a manual criterion of your task with \
check_criterion once it holds, with evidence (a link, a command and its output, or what \
you verified). Once every criterion is met, a task whose criteria are all automatic is \
done at once; one with a manual criterion awaits completion (in_review) until the user \
confirms it, so stop there. Add or delete one criterion with add_criterion or \
remove_criterion when the plan changes, never to make a task pass.

Deleting tasks happens in the Toodo app only, not through these tools. A pull request \
from the task branch into baseBranch moves the task to in_review, and its merge \
completes the task. Toodo notices both at its next pull request check, which runs every \
minute, so right after a merge the task can still read in_review for up to about a \
minute; that is expected, not a miss. Read it again with get_task after a minute instead \
of calling complete_task. Only a task still in_review after that needs a look: for \
another task, complete_task says what blocks it; for your own, call report_blocker. \
Whether you merge it yourself is set per workspace by agentMerge, \
which current_task returns: with never (the default), stop once the pull request is \
open and never merge it. With afterChecks, wait until every check on the pull request \
has finished and passed (`gh pr checks <number> --watch`), fixing and pushing when one \
fails, then merge it into baseBranch (`gh pr merge <number> --merge`, or the merge \
method the repository allows). Even then, never merge while a check is failing or \
pending or when the pull request has no checks, never bypass branch protection (no \
--admin), never merge a pull request into any other branch, and never release, tag, or \
merge baseBranch onward (e.g. into main).";

/// What the app needs to serve the tools: the database, the adapters the app's commands
/// run, and a way to announce changes.
pub trait Backend: Notifier + Send + Sync + 'static {
    fn storage(&self) -> &StorageState;
    fn git(&self) -> &Git;
    fn github(&self) -> &GitHub;
    fn herdr(&self) -> &Herdr;
    /// How agents reach this server.
    fn server(&self) -> &ServerStatus;
}

/// How agents reach the server, shown in the app; `error` tells why it is not running.
#[derive(Debug, Clone)]
pub struct ServerStatus {
    pub url: String,
    pub token: Option<String>,
    /// The file that keeps `token`; `start_task` reads it into the agent command's
    /// environment.
    pub token_file: Option<PathBuf>,
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

pub(crate) async fn serve(listener: TcpListener, app: axum::Router) -> io::Result<()> {
    axum::serve(tokio::net::TcpListener::from_std(listener)?, app).await
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
    let guard = Arc::new(Guard {
        token,
        web_token,
        backend: backend.clone(),
    });
    let service = StreamableHttpService::new(
        move || Ok(ToodoMcp::new(backend.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true),
    );
    axum::Router::new()
        .nest_service("/mcp", service)
        .route_layer(middleware::from_fn_with_state(guard, require_token))
}

struct Guard {
    token: String,
    web_token: Option<String>,
    backend: Arc<dyn Backend>,
}

/// Lets requests through that bear the MCP token; the others get `401` with the reason,
/// which is also kept for the app to show.
async fn require_token(State(guard): State<Arc<Guard>>, request: Request, next: Next) -> Response {
    let rejection = match bearer(request.headers()) {
        Ok(presented) if same_secret(presented, &guard.token) => return next.run(request).await,
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
    let server = guard.backend.server();
    server.rejections.record(rejection);
    unauthorized(Surface::Mcp, rejection, Some(&server.instance))
}

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
             directory (panes Toodo starts agents in have it as TOODO_MCP_TOKEN)."
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
}

#[tool_router]
impl ToodoMcp {
    fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            tool_router: Self::tool_router(),
        }
    }

    /// Runs a tool that changes a task and announces the change to the frontend.
    fn change(
        &self,
        apply: impl FnOnce(&mut crate::storage::Storage) -> CommandResult<Task>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = apply(&mut lock(self.backend.storage()));
        self.announce(result)
    }

    /// Runs `apply` on a blocking thread, since git, gh, and herdr take seconds.
    async fn blocking<T: Send + 'static>(
        &self,
        apply: impl FnOnce(&dyn Backend) -> CommandResult<T> + Send + 'static,
    ) -> Result<CommandResult<T>, ErrorData> {
        let backend = self.backend.clone();
        tokio::task::spawn_blocking(move || apply(backend.as_ref()))
            .await
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))
    }

    /// Tells the frontend that the links of a task changed.
    fn announce_links(&self, result: &CommandResult<tools::TaskDetails>) {
        if let Ok(details) = result {
            self.backend
                .tasks_changed(model::WorkspaceId(details.task.workspace_id.0));
        }
    }

    fn announce(&self, result: CommandResult<Task>) -> Result<CallToolResult, ErrorData> {
        self.announce_with(result, |task| task)
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
        description = "Return the toodo skill (Markdown): the workflow for working on a Toodo task. Read it before you work on a task or create tasks."
    )]
    fn read_toodo_skill(&self) -> Result<CallToolResult, ErrorData> {
        Ok(CallToolResult::success(vec![ContentBlock::text(SKILL)]))
    }

    #[tool(description = "List Toodo workspaces (repositories) with their IDs.")]
    fn list_workspaces(&self) -> Result<CallToolResult, ErrorData> {
        reply(tools::list_workspaces(&lock(self.backend.storage())))
    }

    #[tool(
        description = "Register a repository on the machine Toodo runs on as a new workspace, as Clone or Open in the Toodo app does: clone clone_url into path, or, without clone_url, open the repository already cloned at path; then open it in herdr. Returns the workspace with its id. Call list_workspaces first and reuse a workspace that already has the repository; a path another workspace uses is rejected. Only for repositories the user asked to add to Toodo."
    )]
    async fn create_workspace(
        &self,
        Parameters(request): Parameters<tools::CreateWorkspace>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::create_workspace(backend.storage(), backend.git(), backend.herdr(), request)
            })
            .await?;
        if result.is_ok() {
            self.backend.workspaces_changed();
        }
        reply(result)
    }

    #[tool(
        description = "List the settings of the machine Toodo runs on (machine kind local) and of every known SSH machine (kind ssh with its label, the SSH host): saved in herdr, hosting a workspace, or with saved settings. worktreeRoot is the directory that holds task worktrees there; start_task is rejected for tasks on a machine whose worktreeRoot is null. herdrError tells why herdr's saved machines could not be read."
    )]
    async fn list_machine_settings(&self) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(|backend| tools::list_machine_settings(backend.storage(), backend.herdr()))
            .await?;
        reply(result)
    }

    #[tool(
        description = "Set or clear the worktree root of one machine, as the worktree root setting in the Toodo app does: the absolute directory in which Toodo creates the worktrees of tasks on that machine, as <root>/<workspace>/<type>-<title>-<id>. Omit ssh_host for the machine Toodo runs on. Set it when start_task reports a missing worktree root or the user asks; use the directory the user named, and never change or clear a root that is already set unless the user asks. Only later starts use the new root. Returns the machine's settings."
    )]
    fn set_worktree_root(
        &self,
        Parameters(request): Parameters<tools::SetWorktreeRoot>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(tools::set_worktree_root(
            &mut lock(self.backend.storage()),
            request,
        ))
    }

    #[tool(
        description = "List tasks with status and depends_on, of one workspace or of all workspaces. Each task has ready (planned and nothing blocks it, so start_task or resume_task can begin it now) and blockedBy: the tasks it depends on that are not done yet, or done as not_adopted, which never unblocks it."
    )]
    fn list_tasks(
        &self,
        Parameters(request): Parameters<tools::ListTasks>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(tools::list_tasks(&lock(self.backend.storage()), request))
    }

    #[tool(
        description = "Search tasks of all workspaces (or one) by words in their title, description, notes, completion note, branch, and pull request, best match first. Every word must appear, as a substring in any language; words are literal, not operators. A task number alone (431 or #431) returns that task first, in any workspace. Use it before planning or create_task to find earlier tasks on the same subject, then get_task to read what was decided. Each result lists its depends_on, dependents, and related task IDs."
    )]
    fn search_tasks(
        &self,
        Parameters(request): Parameters<tools::SearchTasks>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(tools::search_tasks(&lock(self.backend.storage()), request))
    }

    #[tool(
        description = "Read one task with its whole history: description, status timeline, progress and blocker notes, completion note (the conclusion of a task done as not_adopted), pull request, commits, and the tasks it depends on, that depend on it, and that are related to it (id, title, status). ready says whether it can start (or resume) now, and blockedBy which of the tasks it depends on keep it from that: not done yet, or done as not_adopted, which never unblocks it. Use it to learn what an earlier task decided, and follow its links with further get_task calls."
    )]
    fn get_task(
        &self,
        Parameters(request): Parameters<tools::GetTask>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(tools::task_details(&lock(self.backend.storage()), request))
    }

    #[tool(
        description = "Link two tasks, from any workspaces, as related: context worth reading together, e.g. an earlier task whose decisions a new one builds on. The link goes both ways and never blocks either task; for work that must be done first, use add_dependency instead. Returns task_id's details."
    )]
    fn add_related(
        &self,
        Parameters(request): Parameters<tools::Related>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = tools::add_related(&mut lock(self.backend.storage()), request);
        self.announce_links(&result);
        reply(result)
    }

    #[tool(
        description = "Remove the related link between two tasks, given in either order. A link that does not exist is rejected. Returns task_id's details."
    )]
    fn remove_related(
        &self,
        Parameters(request): Parameters<tools::Related>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = tools::remove_related(&mut lock(self.backend.storage()), request);
        self.announce_links(&result);
        reply(result)
    }

    #[tool(
        description = "Find the Toodo task whose worktree contains the given directory, with its workspace's baseBranch, agentMerge, and machine. Paths are compared after resolving . and .. by their text. Pass machine (local, or the SSH host of a remote machine) when the same path may exist on several machines; without it, a directory inside worktrees on several machines is rejected, naming them."
    )]
    fn current_task(
        &self,
        Parameters(request): Parameters<tools::CurrentTask>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(tools::current_task(&lock(self.backend.storage()), request))
    }

    #[tool(
        description = "Create a planned task in a workspace with its completion criteria, optionally depending on existing tasks (depends_on) and related to others (related). Without merge_criterion false, its first criterion is the merge: the pull request is merged, or, in a repository without an origin remote, the branch is merged into the base branch locally."
    )]
    async fn create_task(
        &self,
        Parameters(request): Parameters<tools::CreateTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| tools::create_task(backend.storage(), backend.git(), request))
            .await?;
        self.announce(result)
    }

    #[tool(
        description = "Check (met true, the default) or uncheck a manual completion criterion of a task that is not done, with evidence of what shows it holds, e.g. {\"criterion_id\": 2, \"evidence\": \"...\"}. criterion_id (or id) alone finds its task; task_id is optional and must be that task when given. Toodo checks the other kinds itself. Once every criterion of an in_progress task is met, it awaits completion (in_review) until the user, or complete_task, confirms it. Returns the task with its criteria."
    )]
    fn check_criterion(
        &self,
        Parameters(request): Parameters<tools::CheckCriterion>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(|storage| tools::check_criterion(storage, request))
    }

    #[tool(
        description = "Add one completion criterion after the criteria of a task that is not done, which stay as they are, e.g. {\"task_id\": 5, \"text\": \"Tests pass\", \"kind\": \"command\", \"target\": \"npm test\"}. target is the URL of a url criterion or the shell command of a command criterion. Rejects a second merge criterion, pr_merged or pr_open_ci_green in a repository without an origin remote, and branch_merged_locally in one with an origin remote. Returns the task with its criteria."
    )]
    async fn add_criterion(
        &self,
        Parameters(request): Parameters<tools::AddCriterion>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                let input = tools::new_criterion(&request);
                let origin = task_commands::edit_origin(
                    backend.storage(),
                    backend.git(),
                    request.task_id,
                    Some(std::slice::from_ref(&input)),
                    false,
                )?;
                tools::add_criterion(&mut lock(backend.storage()), request, origin)
            })
            .await?;
        self.announce(result)
    }

    #[tool(
        description = "Delete one completion criterion of a task that is not done with its evidence, e.g. {\"criterion_id\": 7}; the other criteria stay as they are. criterion_id (or id) alone finds its task; task_id is optional and must be that task when given. Naming the merge criterion removes it, e.g. for work that ships no code. Returns the task with its criteria."
    )]
    fn remove_criterion(
        &self,
        Parameters(request): Parameters<tools::RemoveCriterion>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(|storage| tools::remove_criterion(storage, request))
    }

    #[tool(
        description = "Change the type, title, description, estimate, due date, or completion criteria of a task; omitted fields stay unchanged. To add or delete one criterion, use add_criterion or remove_criterion instead. criteria replaces the whole list: criteria whose id is left out are deleted with their evidence. Send {\"id\": N} to keep criterion N as it is (add text, kind, or target to change it), and text and kind without id for a new one, e.g. [{\"id\": 1}, {\"text\": \"Docs updated\", \"kind\": \"manual\"}]. Each id appears once and must belong to the task. A list without the merge criterion (pr_merged or branch_merged_locally) is rejected unless remove_merge_criterion is true. A done task is rejected: its record stays as it was finished, so record a correction with add_progress_note, or ask the user to reopen it in the Toodo app."
    )]
    async fn update_task(
        &self,
        Parameters(request): Parameters<tools::UpdateTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                let origin = task_commands::edit_origin(
                    backend.storage(),
                    backend.git(),
                    request.id,
                    request.criteria.as_deref(),
                    false,
                )?;
                tools::update_task(&mut lock(backend.storage()), request, origin)
            })
            .await?;
        self.announce(result)
    }

    #[tool(
        description = "Make task_id depend on every task in depends_on, one task id or an array, e.g. {\"task_id\": 5, \"depends_on\": [3, 4]}. Rejects self and cyclic dependencies and a done task_id (create a follow-up task instead); one rejected prerequisite adds none. If task_id is in_progress and a prerequisite is not done, the task is paused and a blocker note names what it waits on; the user then decides in the Toodo app whether to close its herdr workspace, which ends your session. An in_review task is not paused; call pause_task if it must wait. Returns {task, paused, message}: task is task_id's details with each prerequisite's title and status, and message says what the change means and what to do next."
    )]
    fn add_dependency(
        &self,
        Parameters(request): Parameters<tools::AddDependencies>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = tools::add_dependencies(&mut lock(self.backend.storage()), request);
        self.announce_with(result, |reply| &reply.task.task)
    }

    #[tool(
        description = "Record progress or a decision (what and why) on a task's history, e.g. your current task. Returns the task with its notes."
    )]
    fn add_progress_note(
        &self,
        Parameters(request): Parameters<tools::AddNote>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(|storage| tools::add_note(storage, model::NoteKind::Progress, request))
    }

    #[tool(
        description = "Record on a task's history what blocks the work on it and what is needed to continue. Does not change the task's status. Returns the task with its notes."
    )]
    fn report_blocker(
        &self,
        Parameters(request): Parameters<tools::AddNote>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(|storage| tools::add_note(storage, model::NoteKind::Blocker, request))
    }

    #[tool(
        description = "Pause an in_progress or in_review task, as Pause in the Toodo app does, with a required non-empty reason, e.g. {\"id\": 5, \"reason\": \"Waiting for the API design\"}. The task moves back to planned and shows as paused; it keeps its branch, worktree, herdr workspace, commits, and pull request, and the reason is recorded as a progress note. Your own task may be paused; stop working on it afterwards. To wait for other tasks, use add_dependency instead, which pauses the task until they are done. Returns the task with its notes."
    )]
    fn pause_task(
        &self,
        Parameters(request): Parameters<tools::PauseTask>,
    ) -> Result<CallToolResult, ErrorData> {
        self.change(|storage| tools::pause_task(storage, request))
    }

    #[tool(
        description = "Resume a paused task (planned after it was started) whose prerequisites are all done, as Resume in the Toodo app does: reopen its worktree and herdr workspace and move it back to in_progress. An optional note is recorded as a progress note. Rejected for a task that was never started (call start_task) or is not paused. Returns the task with its notes."
    )]
    async fn resume_task(
        &self,
        Parameters(request): Parameters<tools::ResumeTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::resume_task(backend.storage(), backend.git(), backend.herdr(), request)
            })
            .await?;
        self.announce(result)
    }

    #[tool(
        description = "Start a planned task whose prerequisites are all done, as Start (or Resume for a paused task) in the Toodo app does: create or reopen its worktree and herdr workspace and move it to in_progress. Use it to hand a ready task to a new agent session; never start your own task, the one current_task finds. With agent_command, Toodo then runs that command (e.g. the coding agent) in the first pane of the task's herdr workspace, with TOODO_MCP_URL and TOODO_MCP_TOKEN exported so the agent can reach Toodo. Returns the task with the panes of its herdr workspace, ranIn (the pane agent_command ran in), and paneError when the panes could not be listed or the command did not run. Rejected with the reason when the task is not ready, is not planned, or its machine has no worktree root (set it with set_worktree_root)."
    )]
    async fn start_task(
        &self,
        Parameters(request): Parameters<tools::StartTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::start_task(
                    backend.storage(),
                    backend.git(),
                    backend.herdr(),
                    backend.server(),
                    request,
                )
            })
            .await?;
        if let Ok(started) = &result {
            self.backend
                .tasks_changed(model::WorkspaceId(started.task.workspace_id.0));
        }
        reply(result)
    }

    #[tool(
        description = "Complete an in_progress or in_review task whose criteria are met, including confirmation after manual checks. Toodo checks automatic criteria first and rejects with each unmet criterion and its next step. The task becomes done, its herdr workspace closes, and dependents can start. A merged pull request gives resolution merged; criteria met with nothing merged gives completed. With without_pull_request: true and a required non-empty note, complete work that shipped without any pull request: pr_merged is met with the note as evidence, all other criteria must still hold, branch commits are recorded, and the note becomes the completion note. Rejected if any branch pull request exists, even unrecorded or closed; for a merged PR call complete_task without optional arguments, otherwise wait for merge or conclude abandoned work. without_pull_request and merged_with cannot be combined. With merged_with, complete work shipped by another task's merged pull request: pass its task ID or PR URL; active tasks or ones done as not_adopted become done as merged. Rejected if that PR is not merged or the task has its own open or merged PR. Never complete your own task, the one current_task finds: meeting its criteria completes it."
    )]
    async fn complete_task(
        &self,
        Parameters(request): Parameters<tools::CompleteTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::complete_task(
                    backend.storage(),
                    backend.git(),
                    backend.github(),
                    backend.herdr(),
                    request,
                )
            })
            .await?;
        self.announce(result)
    }

    #[tool(
        description = "Conclude an in_progress or in_review task whose work was not shipped: research not adopted, a duplicate, or work no longer needed. This means concluded, not completed as shipped: the task becomes done (not_adopted) with a required non-empty note as its conclusion, its herdr workspace closes, and dependents stay blocked; the reply lists them as blockedDependents with what to do for each. For work shipped without a pull request, call complete_task with without_pull_request: true and note instead; for work shipped in another task's merged PR use merged_with. Rejected if its branch has a merged PR (call complete_task without optional arguments) or an open PR, even unrecorded, which only the user closes by concluding in the app. Never conclude your own task, the one current_task finds."
    )]
    async fn conclude_task(
        &self,
        Parameters(request): Parameters<tools::ConcludeTask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::conclude_task(
                    backend.storage(),
                    backend.git(),
                    backend.github(),
                    backend.herdr(),
                    request,
                )
            })
            .await?;
        self.announce_with(result, |concluded| &concluded.task)
    }

    #[tool(
        description = "Restore the worktree of an in_progress or in_review task whose worktree directory is gone (worktreeMissing true, or no worktreePath), as Restore worktree in the Toodo app does: check out the task's branch, taken from origin when the repository no longer has it, into a new worktree and open it in herdr. Your own task may be restored too. Rejected with the reason when the worktree still exists, the task is not active, or its branch is gone everywhere. Returns the task with its new worktreePath."
    )]
    async fn restore_worktree(
        &self,
        Parameters(request): Parameters<tools::RestoreWorktree>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = self
            .blocking(move |backend| {
                tools::restore_worktree(backend.storage(), backend.git(), backend.herdr(), request)
            })
            .await?;
        self.announce(result)
    }

    #[tool(
        description = "Remove the dependency of task_id on every task in depends_on, one task id or an array, e.g. {\"task_id\": 5, \"depends_on\": 3}. A dependency that does not exist is rejected, and then none is removed. Returns {task, paused, message} like add_dependency; message says whether the task is now ready, e.g. a paused task that resume_task can resume."
    )]
    fn remove_dependency(
        &self,
        Parameters(request): Parameters<tools::Dependency>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = tools::remove_dependency(&mut lock(self.backend.storage()), request);
        self.announce_with(result, |reply| &reply.task.task)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ToodoMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION")).with_title(
                    format!("Toodo (server instance {})", self.backend.server().instance),
                ),
            )
            .with_instructions(INSTRUCTIONS)
    }
}

/// Tool failures are tool-level errors, so the agent sees the reason, e.g. a cycle.
fn reply<T: Serialize>(result: CommandResult<T>) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(value) => {
            let json = serde_json::to_string_pretty(&value)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
            Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
        }
        Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
            "{:?}: {}",
            error.kind, error.message
        ))])),
    }
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
        storage: StorageState,
        git: Git,
        github: GitHub,
        herdr: Herdr,
        server: ServerStatus,
        changed: std::sync::Mutex<Vec<model::WorkspaceId>>,
        workspaces_changed: std::sync::Mutex<usize>,
    }

    type Scripted = Vec<Result<String, crate::adapters::git::GitError>>;

    impl TestBackend {
        fn new(storage: crate::storage::Storage) -> Self {
            Self::scripted(storage, Vec::new(), Vec::new())
        }

        /// Git and herdr return `git` and `herdr` in order; gh must not run.
        fn scripted(storage: crate::storage::Storage, git: Scripted, herdr: Scripted) -> Self {
            use crate::adapters::git::fake::FakeRunner;
            let runner = |results: Scripted| Box::new(Arc::new(FakeRunner::new(results)));
            Self {
                storage: std::sync::Mutex::new(storage),
                git: Git::new(runner(git)),
                github: GitHub::new(runner(Vec::new())),
                herdr: Herdr::new(runner(herdr)),
                server: ServerStatus {
                    url: url(47617),
                    token: Some("secret".to_owned()),
                    token_file: Some(PathBuf::from("/data/toodo/mcp-token")),
                    instance: "0123456789ab".to_owned(),
                    error: None,
                    rejections: Rejections::default(),
                },
                changed: std::sync::Mutex::default(),
                workspaces_changed: std::sync::Mutex::default(),
            }
        }
    }

    impl Notifier for TestBackend {
        fn tasks_changed(&self, workspace: model::WorkspaceId) {
            self.changed.lock().unwrap().push(workspace);
        }
        fn workspaces_changed(&self) {
            *self.workspaces_changed.lock().unwrap() += 1;
        }
        fn agent_statuses_changed(&self, _: &[crate::commands::types::TaskAgentStatus]) {}
        fn pull_request_statuses_changed(
            &self,
            _: &[crate::commands::types::TaskPullRequestStatus],
        ) {
        }
    }

    impl Backend for TestBackend {
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
            &self.server
        }
    }

    /// A database with one local workspace and one planned task, and the machine's
    /// worktree root if `root` is given.
    fn storage_with_task(root: Option<&str>) -> (crate::storage::Storage, model::Task) {
        use crate::domain::model::{MachineSettings, TaskType, WorkspaceLocation};
        use crate::domain::path::WindowsPath;
        let mut storage = crate::storage::Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&crate::storage::NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
            })
            .unwrap();
        storage
            .save_machine_settings(&MachineSettings::Local {
                worktree_root: root.map(|root| WindowsPath::parse(root).unwrap().into()),
            })
            .unwrap();
        let task = storage
            .create_task(&crate::storage::NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: "Add login".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap();
        (storage, task)
    }

    fn start(server: &ToodoMcp, id: model::TaskId) -> serde_json::Value {
        let request = tools::StartTask {
            id: id.into(),
            agent_command: None,
            request_id: None,
        };
        let result = runtime()
            .block_on(server.start_task(Parameters(request)))
            .unwrap();
        serde_json::to_value(result).unwrap()
    }

    #[test]
    fn starting_a_ready_task_moves_it_in_progress_and_announces_it() {
        let (storage, task) = storage_with_task(Some(r"D:\wt"));
        let created =
            r#"{"id":"cli:worktree:create","result":{"workspace":{"workspace_id":"w27"}}}"#;
        let backend = Arc::new(TestBackend::scripted(
            storage,
            vec![
                Ok("abc\n".to_owned()),
                Ok(String::new()),
                Err(crate::adapters::git::fake::failed()),
                Ok(String::new()),
            ],
            vec![
                Ok(created.to_owned()),
                Ok(r#"{"id":"cli:pane:list","result":{"panes":[]}}"#.to_owned()),
            ],
        ));
        let server = ToodoMcp::new(backend.clone());

        let result = start(&server, task.id);

        assert_ne!(result["isError"], true, "{result}");
        let started: serde_json::Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(started["status"], "in_progress");
        assert_eq!(started["herdrWorkspaceId"], "w27");
        let stored = lock(&backend.storage).get_task(task.id).unwrap().unwrap();
        let statuses: Vec<_> = stored.timeline.iter().map(|event| event.status).collect();
        assert_eq!(
            statuses,
            [
                crate::domain::status::TaskStatus::Planned,
                crate::domain::status::TaskStatus::InProgress
            ]
        );
        assert_eq!(*backend.changed.lock().unwrap(), [task.workspace_id]);
    }

    #[test]
    fn a_rejected_start_returns_the_reason_as_tool_error_text_and_announces_nothing() {
        let (storage, task) = storage_with_task(None);
        let backend = Arc::new(TestBackend::new(storage));
        let server = ToodoMcp::new(backend.clone());

        let result = start(&server, task.id);

        assert_eq!(result["isError"], true);
        assert_eq!(
            result["content"][0]["text"],
            "InvalidInput: worktree root is not set for machine local; ask the user where task \
             worktrees go on that machine, call set_worktree_root with worktree_root set to \
             that absolute directory, then start the task again"
        );
        assert!(backend.changed.lock().unwrap().is_empty());
        let stored = lock(&backend.storage).get_task(task.id).unwrap().unwrap();
        assert_eq!(stored, task);
    }

    fn create_workspace(server: &ToodoMcp, arguments: serde_json::Value) -> serde_json::Value {
        let request = serde_json::from_value(arguments).unwrap();
        let result = runtime()
            .block_on(server.create_workspace(Parameters(request)))
            .unwrap();
        serde_json::to_value(result).unwrap()
    }

    /// The local path for POSIX `posix`: local paths are the server's own.
    fn host(posix: &str) -> String {
        posix.to_owned()
    }

    /// What `git rev-parse --show-toplevel` prints for `posix`.
    fn toplevel(posix: &str) -> Result<String, crate::adapters::git::GitError> {
        Ok(format!("{posix}\n"))
    }

    /// `herdr workspace list` without the repository, then `herdr workspace create`.
    fn herdr_opens_a_new_workspace() -> Scripted {
        vec![
            Ok(r#"{"id":"cli:workspace:list","result":{"workspaces":[]}}"#.to_owned()),
            Ok(
                r#"{"id":"cli:workspace:create","result":{"workspace":{"workspace_id":"w9"}}}"#
                    .to_owned(),
            ),
        ]
    }

    fn created_workspace(result: &serde_json::Value) -> serde_json::Value {
        assert_ne!(result["isError"], true, "{result}");
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    fn error_text(result: &serde_json::Value) -> &str {
        assert_eq!(result["isError"], true, "{result}");
        result["content"][0]["text"].as_str().unwrap()
    }

    /// A server whose database has the workspace "site" at /dev/site, opened through the
    /// tool; git and herdr then return `git` and `herdr`.
    fn server_with_site(git: Scripted, herdr: Scripted) -> (Arc<TestBackend>, ToodoMcp) {
        let (storage, _) = storage_with_task(None);
        let mut git_results = vec![toplevel("/dev/site")];
        git_results.extend(git);
        let mut herdr_results = herdr_opens_a_new_workspace();
        herdr_results.extend(herdr);
        let backend = Arc::new(TestBackend::scripted(storage, git_results, herdr_results));
        let server = ToodoMcp::new(backend.clone());
        let result = create_workspace(
            &server,
            serde_json::json!({
                "name": "site",
                "path": host("/dev/site/src"),
                "default_base_branch": "dev",
            }),
        );
        created_workspace(&result);
        (backend, server)
    }

    fn workspace_count(backend: &TestBackend) -> usize {
        lock(&backend.storage).list_workspaces().unwrap().len()
    }

    #[test]
    fn creating_a_workspace_opens_an_existing_clone_at_its_root() {
        let (storage, _) = storage_with_task(None);
        let backend = Arc::new(TestBackend::scripted(
            storage,
            vec![toplevel("/dev/site")],
            herdr_opens_a_new_workspace(),
        ));
        let server = ToodoMcp::new(backend.clone());

        let result = create_workspace(
            &server,
            serde_json::json!({
                "name": "site",
                "path": host("/dev/site/src"),
                "default_base_branch": "dev",
            }),
        );

        let workspace = created_workspace(&result);
        assert_eq!(workspace["name"], "site");
        assert_eq!(
            workspace["location"],
            serde_json::json!({"kind": "local", "path": host("/dev/site")})
        );
        assert_eq!(workspace["defaultBaseBranch"], "dev");
        let id = model::WorkspaceId(workspace["id"].as_i64().unwrap());
        let stored = lock(&backend.storage).get_workspace(id).unwrap().unwrap();
        assert_eq!(stored.name, "site");
        assert_eq!(*backend.workspaces_changed.lock().unwrap(), 1);
    }

    #[test]
    fn creating_a_workspace_clones_the_url_and_detects_the_base_branch() {
        let (storage, _) = storage_with_task(None);
        let git_runner = Arc::new(crate::adapters::git::fake::FakeRunner::new(vec![
            Ok(String::new()),
            Ok("origin/main\n".to_owned()),
        ]));
        let mut backend = TestBackend::scripted(storage, Vec::new(), herdr_opens_a_new_workspace());
        backend.git = Git::new(Box::new(git_runner.clone()));
        let backend = Arc::new(backend);
        let server = ToodoMcp::new(backend.clone());

        let result = create_workspace(
            &server,
            serde_json::json!({
                "name": "site",
                "path": host("/dev/site"),
                "clone_url": "git@github.com:me/site.git",
            }),
        );

        let workspace = created_workspace(&result);
        assert_eq!(workspace["location"]["path"], host("/dev/site"));
        assert_eq!(workspace["defaultBaseBranch"], "main");
        let invocations = git_runner.invocations.lock().unwrap();
        assert_eq!(invocations[0].args[0], "clone");
        assert!(
            invocations[0]
                .args
                .contains(&"git@github.com:me/site.git".to_owned())
        );
        assert_eq!(*backend.workspaces_changed.lock().unwrap(), 1);
    }

    #[test]
    fn a_path_another_workspace_uses_is_rejected_before_anything_runs() {
        // Neither git nor herdr may run again: their scripts end after the first workspace.
        let (backend, server) = server_with_site(Vec::new(), Vec::new());

        let result = create_workspace(
            &server,
            serde_json::json!({
                "name": "again",
                "path": host("/dev/site"),
                "clone_url": "git@github.com:me/site.git",
            }),
        );

        assert_eq!(
            error_text(&result),
            format!(
                "Rejected: workspace site (2) already uses {}",
                host("/dev/site")
            )
        );
        assert_eq!(workspace_count(&backend), 2);
        assert_eq!(*backend.workspaces_changed.lock().unwrap(), 1);
    }

    #[test]
    fn opening_another_folder_of_a_workspace_repository_is_rejected_before_herdr_runs() {
        let (backend, server) = server_with_site(vec![toplevel("/dev/site")], Vec::new());

        let result = create_workspace(
            &server,
            serde_json::json!({
                "name": "again",
                "path": host("/dev/site/docs"),
                "default_base_branch": "main",
            }),
        );

        assert_eq!(
            error_text(&result),
            format!(
                "Rejected: workspace site (2) already uses {}",
                host("/dev/site")
            )
        );
        assert_eq!(workspace_count(&backend), 2);
    }

    #[test]
    fn an_invalid_path_or_a_folder_outside_a_repository_creates_no_workspace() {
        let (storage, _) = storage_with_task(None);
        let backend = Arc::new(TestBackend::scripted(
            storage,
            vec![Err(crate::adapters::git::GitError::Failed {
                command: format!("git -C {} rev-parse --show-toplevel", host("/dev/notes")),
                stderr: "fatal: not a git repository (or any of the parent directories): .git"
                    .to_owned(),
            })],
            Vec::new(),
        ));
        let server = ToodoMcp::new(backend.clone());

        let relative = create_workspace(
            &server,
            serde_json::json!({"name": "notes", "path": "notes"}),
        );
        assert_eq!(
            error_text(&relative),
            r#"InvalidInput: path is not absolute: "notes""#
        );

        let outside = create_workspace(
            &server,
            serde_json::json!({"name": "notes", "path": host("/dev/notes")}),
        );
        let message = error_text(&outside);
        assert!(message.starts_with("External: "), "{message}");
        assert!(message.contains("not a git repository"), "{message}");

        assert_eq!(workspace_count(&backend), 1);
        assert_eq!(*backend.workspaces_changed.lock().unwrap(), 0);
    }

    /// Adds the workspace "site" on the SSH machine devbox with one planned task.
    fn add_devbox_task(storage: &mut crate::storage::Storage) -> model::Task {
        use crate::domain::model::{MachineLabel, TaskType, WorkspaceLocation};
        use crate::domain::path::PosixPath;
        let workspace = storage
            .create_workspace(&crate::storage::NewWorkspace {
                name: "site".to_owned(),
                location: WorkspaceLocation::Ssh {
                    machine: MachineLabel::parse("devbox").unwrap(),
                    path: PosixPath::parse("/srv/site").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
            })
            .unwrap();
        storage
            .create_task(&crate::storage::NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Fix,
                title: "Fix footer".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap()
    }

    /// `herdr machine list --json` with the given SSH targets.
    fn saved_machines(targets: &[&str]) -> Result<String, crate::adapters::git::GitError> {
        let rows: Vec<_> = targets
            .iter()
            .enumerate()
            .map(|(index, target)| {
                serde_json::json!({"id": format!("m{index}"), "label": target, "target": target,
                    "session": "default", "enabled": true, "selected": false})
            })
            .collect();
        Ok(serde_json::Value::Array(rows).to_string())
    }

    fn list_machine_settings(server: &ToodoMcp) -> serde_json::Value {
        let result = runtime().block_on(server.list_machine_settings()).unwrap();
        created_workspace(&serde_json::to_value(result).unwrap())
    }

    fn set_worktree_root(server: &ToodoMcp, arguments: serde_json::Value) -> serde_json::Value {
        let request = serde_json::from_value(arguments).unwrap();
        serde_json::to_value(server.set_worktree_root(Parameters(request)).unwrap()).unwrap()
    }

    fn local(root: Option<&str>) -> serde_json::Value {
        serde_json::json!({"machine": {"kind": "local"}, "worktreeRoot": root.map(host)})
    }

    fn ssh(label: &str, root: Option<&str>) -> serde_json::Value {
        serde_json::json!({"machine": {"kind": "ssh", "label": label}, "worktreeRoot": root})
    }

    #[test]
    fn worktree_roots_of_local_and_ssh_machines_are_listed_set_and_cleared() {
        let (mut storage, _) = storage_with_task(None);
        add_devbox_task(&mut storage);
        let backend = Arc::new(TestBackend::scripted(
            storage,
            Vec::new(),
            vec![
                saved_machines(&["gpu", "devbox"]),
                saved_machines(&["gpu"]),
                Err(crate::adapters::git::fake::failed()),
            ],
        ));
        let server = ToodoMcp::new(backend.clone());

        assert_eq!(
            list_machine_settings(&server),
            serde_json::json!({"machines": [local(None), ssh("devbox", None), ssh("gpu", None)]})
        );

        let saved = set_worktree_root(&server, serde_json::json!({"worktree_root": host("/wt")}));
        assert_eq!(created_workspace(&saved), local(Some("/wt")));
        let saved = set_worktree_root(
            &server,
            serde_json::json!({"ssh_host": "devbox", "worktree_root": "/srv/wt/"}),
        );
        assert_eq!(created_workspace(&saved), ssh("devbox", Some("/srv/wt")));
        // A machine known only by its saved settings is listed too.
        set_worktree_root(
            &server,
            serde_json::json!({"ssh_host": "lab", "worktree_root": "/lab"}),
        );
        assert_eq!(
            list_machine_settings(&server),
            serde_json::json!({"machines": [
                local(Some("/wt")),
                ssh("devbox", Some("/srv/wt")),
                ssh("gpu", None),
                ssh("lab", Some("/lab")),
            ]})
        );

        let cleared = set_worktree_root(&server, serde_json::json!({}));
        assert_eq!(created_workspace(&cleared), local(None));
        let cleared = set_worktree_root(
            &server,
            serde_json::json!({"ssh_host": "devbox", "worktree_root": null}),
        );
        assert_eq!(created_workspace(&cleared), ssh("devbox", None));
        // Without herdr's saved machines, the others are still listed.
        let listed = list_machine_settings(&server);
        assert!(listed["herdrError"].is_string(), "{listed}");
        assert_eq!(
            listed["machines"],
            serde_json::json!([local(None), ssh("devbox", None), ssh("lab", Some("/lab"))])
        );
    }

    #[test]
    fn invalid_worktree_roots_and_hosts_are_rejected_and_save_nothing() {
        let (mut storage, _) = storage_with_task(None);
        add_devbox_task(&mut storage);
        let backend = Arc::new(TestBackend::scripted(
            storage,
            Vec::new(),
            vec![saved_machines(&[])],
        ));
        let server = ToodoMcp::new(backend.clone());

        for arguments in [
            serde_json::json!({"worktree_root": "worktrees"}),
            serde_json::json!({"worktree_root": ""}),
            serde_json::json!({"ssh_host": "devbox", "worktree_root": r"D:wt"}),
            serde_json::json!({"ssh_host": "devbox", "worktree_root": "srv/wt"}),
            serde_json::json!({"ssh_host": " ", "worktree_root": "/wt"}),
        ] {
            let result = set_worktree_root(&server, arguments.clone());
            let message = error_text(&result);
            assert!(
                message.starts_with("InvalidInput: "),
                "{arguments}: {message}"
            );
        }

        assert_eq!(
            list_machine_settings(&server),
            serde_json::json!({"machines": [local(None), ssh("devbox", None)]})
        );
        assert!(
            lock(&backend.storage)
                .ssh_machines_with_settings()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_start_without_the_worktree_root_of_an_ssh_machine_names_the_host_to_set() {
        let (mut storage, _) = storage_with_task(Some(r"D:\wt"));
        let task = add_devbox_task(&mut storage);
        let backend = Arc::new(TestBackend::new(storage));
        let server = ToodoMcp::new(backend.clone());

        let result = start(&server, task.id);

        assert_eq!(
            error_text(&result),
            "InvalidInput: worktree root is not set for machine devbox; ask the user where \
             task worktrees go on that machine, call set_worktree_root with ssh_host \
             \"devbox\" and worktree_root set to that absolute directory, then start the task \
             again"
        );
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
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        write!(
            stream,
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
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
        std::thread::spawn(move || runtime().block_on(serve(listener, app)));

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
        ] {
            assert!(server.tool_router.has_route(tool), "{tool}");
        }
        for tool in [
            "delete_task",
            "reply_in_chat",
            "ack_chat",
            "mark_chat_handled",
            "take_pending",
            "peek_pending",
            "list_chat",
            "import_chat_message",
            "set_typing",
        ] {
            assert!(!server.tool_router.has_route(tool), "{tool}");
        }
        let result = serde_json::to_value(server.read_toodo_skill().unwrap()).unwrap();
        assert_eq!(result["content"][0]["text"], SKILL);
        // `lines` also drops the `\r` of a CRLF checkout on Windows.
        assert_eq!(
            SKILL.lines().take(2).collect::<Vec<_>>(),
            ["---", "name: toodo"]
        );
        assert_ne!(result["isError"], true);
    }

    #[test]
    fn secrets_match_only_when_equal() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abd", "abc"));
        assert!(!same_secret("ab", "abc"));
    }
}
