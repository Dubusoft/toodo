use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::{TaskId, Timestamp};
use crate::domain::runtime as domain_runtime;
use crate::runtime::plain;
use crate::storage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(transparent)]
pub struct RunId(#[specta(type = Number)] pub i64);

impl From<RunId> for domain_runtime::RunId {
    fn from(id: RunId) -> Self {
        Self(id.0)
    }
}

impl From<domain_runtime::RunId> for RunId {
    fn from(id: domain_runtime::RunId) -> Self {
        Self(id.0)
    }
}

/// The agent CLI a plain run drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentAdapter {
    /// Claude Code in print mode (`claude -p`).
    Claude,
    /// Codex in exec mode (`codex exec`).
    Codex,
}

/// What the server can run tasks with: herdr for herdr workspaces, and the agent CLIs of
/// plain runs, together with the other tools it runs: git, gh, and ssh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunnerHealth {
    pub herdr: HerdrHealth,
    /// tmux for local workspaces with runner tmux.
    pub tmux: TmuxHealth,
    /// Claude, then Codex.
    pub agents: Vec<AgentHealth>,
    /// git, then gh, then ssh.
    pub tools: Vec<ToolHealth>,
}

/// A command-line tool the server runs besides the runners.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    /// git, for local workspaces with a repository.
    Git,
    /// The GitHub CLI, for the pull requests of workspaces with source `github`.
    Gh,
    /// OpenSSH, for workspaces on SSH machines.
    Ssh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolHealth {
    pub tool: Tool,
    /// Whether the tool ran from the server's `PATH`.
    pub installed: bool,
    /// Whether the tool can do its work: installed, and for gh also logged in.
    pub ready: bool,
    /// The version the tool printed, such as `git version 2.43.0`.
    pub version: Option<String>,
    /// Why the tool is not ready and what to do next; `None` when it is ready.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TmuxHealth {
    /// Whether `tmux -V` ran from the server's `PATH`.
    pub installed: bool,
    /// The version `tmux -V` printed, such as `tmux 3.4`.
    pub version: Option<String>,
    /// What to do next when tmux cannot run; `None` when it can.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HerdrHealth {
    /// Whether herdr could be run from the server's `PATH`.
    pub installed: bool,
    /// Whether the herdr server on this machine is running.
    pub running: bool,
    pub version: Option<String>,
    /// Why herdr is not usable and what to do next; `None` while it is running.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealth {
    pub adapter: AgentAdapter,
    /// Whether the adapter's CLI is an executable on the server's `PATH`.
    pub installed: bool,
    /// Absolute path of the CLI found on `PATH`.
    pub path: Option<String>,
    /// What to do next when the CLI is missing; `None` when it is installed.
    pub message: Option<String>,
}

impl From<AgentAdapter> for plain::adapter::AgentAdapter {
    fn from(adapter: AgentAdapter) -> Self {
        match adapter {
            AgentAdapter::Claude => Self::Claude,
            AgentAdapter::Codex => Self::Codex,
        }
    }
}

/// Where a run is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Recorded, not launched yet.
    Reserved,
    /// Launched and not ended.
    Running,
    /// Ended with a successful result.
    Settled,
    /// Ended on its own, or ended after its result without success.
    Exited,
    /// Ended with an error result, without a result, or past its time limit.
    Failed,
    /// Stopped on request.
    Cancelled,
    /// Its end was not observed, e.g. the server restarted while it ran.
    Unknown,
}

impl From<domain_runtime::RunState> for RunState {
    fn from(state: domain_runtime::RunState) -> Self {
        match state {
            domain_runtime::RunState::Reserved => Self::Reserved,
            domain_runtime::RunState::Running => Self::Running,
            domain_runtime::RunState::Settled => Self::Settled,
            domain_runtime::RunState::Exited => Self::Exited,
            domain_runtime::RunState::Failed => Self::Failed,
            domain_runtime::RunState::Cancelled => Self::Cancelled,
            domain_runtime::RunState::Unknown => Self::Unknown,
        }
    }
}

/// A run of a task: an agent launch and its outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: RunId,
    pub task_id: TaskId,
    pub request_key: String,
    /// Increases from 1 per task.
    #[specta(type = Number)]
    pub generation: i64,
    /// `plain`, `tmux`, `herdr`, or `none`.
    pub runner_kind: String,
    /// `writer` or `observer`.
    pub role: String,
    /// The agent CLI of a plain run: `claude` or `codex`.
    pub adapter: Option<String>,
    pub checkout_path: Option<String>,
    pub state: RunState,
    /// The runner's reference of the launch, e.g. `pid:<pid>` for a plain run.
    pub provider_run_ref: Option<String>,
    pub created_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    /// When the agent last wrote output: while a plain run runs, every few seconds of its
    /// output; for a tmux run, once its end was seen.
    pub last_activity_at: Option<Timestamp>,
    /// The tokens the agent reported using, once it reported them.
    pub usage: Option<RunUsage>,
}

/// Tokens an agent reported using in a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    /// Input tokens, including the cached ones.
    #[specta(type = Number)]
    pub input_tokens: i64,
    #[specta(type = Number)]
    pub cached_input_tokens: i64,
    #[specta(type = Number)]
    pub output_tokens: i64,
}

impl From<domain_runtime::RunUsage> for RunUsage {
    fn from(usage: domain_runtime::RunUsage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            cached_input_tokens: usage.cached_input_tokens,
            output_tokens: usage.output_tokens,
        }
    }
}

impl From<&storage::TaskRun> for TaskRun {
    fn from(run: &storage::TaskRun) -> Self {
        Self {
            id: run.id.into(),
            task_id: run.task.into(),
            request_key: run.request_key.clone(),
            generation: run.generation,
            runner_kind: run.runner_kind.as_wire().to_owned(),
            role: run.role.as_wire().to_owned(),
            adapter: run.adapter_profile.clone(),
            checkout_path: run.checkout_path.clone(),
            state: run.state.into(),
            provider_run_ref: run.provider_run_ref.clone(),
            created_at: Timestamp(run.created_at),
            started_at: run.started_at.map(Timestamp),
            ended_at: run.ended_at.map(Timestamp),
            last_activity_at: run.last_activity_at.map(Timestamp),
            usage: run.usage.map(RunUsage::from),
        }
    }
}

/// Something observed about a run, e.g. its result or how it exited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    /// Increases from 1 per run.
    #[specta(type = Number)]
    pub sequence: i64,
    pub kind: String,
    pub payload: Option<String>,
    pub observed_at: Timestamp,
}

impl From<&storage::RunEvent> for RunEvent {
    fn from(event: &storage::RunEvent) -> Self {
        Self {
            sequence: event.sequence,
            kind: event.kind.clone(),
            payload: event.payload.clone(),
            observed_at: Timestamp(event.observed_at),
        }
    }
}

/// A run with its events and the ends of its output, with the MCP token redacted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunLog {
    pub run: TaskRun,
    pub events: Vec<RunEvent>,
    pub stdout: String,
    pub stderr: String,
    /// For an active tmux run, the shell command that attaches a terminal to its session.
    pub attach: Option<String>,
}
