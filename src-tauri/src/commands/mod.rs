//! Commands exposed to the frontend. Arguments and results use the serializable shapes in
//! [`types`]; failures are reported as a [`CommandError`].
//!
//! The server (`toodo-server`) serves them over HTTP (`server/rpc.rs`), passing the state
//! they take by reference, see [`State`]. Each is annotated with `#[specta::specta]` so
//! that `bindings.rs` can generate the frontend's typed bindings from its signature.

pub mod agent_options;
pub mod backup;
pub mod completion;
pub mod events;
pub mod freshness;
pub mod herdr;
pub mod issues;
pub mod machines;
pub mod mcp;
pub mod pull_request_options;
pub mod report;
pub mod review;
pub mod run_logs;
pub mod runners;
pub mod runs;
pub mod tasks;
pub mod types;
pub mod workspaces;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use specta::Type;

use crate::adapters::git::{Git, GitError};
use crate::adapters::github::GitHub;
use crate::adapters::herdr::{Herdr, HerdrError};
use crate::adapters::ssh::{Ssh, SshConfigError, SshConfigFile};
use crate::domain::dag::DependencyError;
use crate::domain::naming::NamingError;
use crate::domain::ssh_config::SshHostError;
use crate::storage::{Storage, StorageError};

/// State a command takes: a reference to state the server owns. It dereferences to the
/// state and is left out of the generated bindings.
#[derive(Debug)]
pub struct State<'a, T>(pub &'a T);

impl<T> specta::function::FunctionArg for State<'_, T> {
    fn to_datatype(_: &mut specta::Types) -> Option<specta::datatype::DataType> {
        None
    }
}

impl<T> std::ops::Deref for State<'_, T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.0
    }
}

/// What the background threads use besides what the MCP server does: the state the
/// server keeps in memory.
pub trait Runtime: crate::mcp::Backend {
    fn agent_statuses(&self) -> &events::AgentStatusState;
    fn backups(&self) -> &backup::Backups;
}

pub type StorageState = Mutex<Storage>;

pub type GitState = Arc<Git>;

pub type HerdrState = Arc<Herdr>;

pub type GitHubState = Arc<dyn GitHub>;

pub type SshState = Arc<Ssh>;

/// The plain runner, which runs agent CLIs for tasks of workspaces with runner plain.
pub type PlainRunState = crate::runtime::plain::PlainRunner;

/// The tmux runner, which runs agent CLIs in detached tmux sessions for tasks of
/// workspaces with runner tmux.
pub type TmuxRunState = crate::runtime::tmux::TmuxRunner;

/// `None` when the home directory, and so the SSH config, cannot be found.
pub type SshConfigState = Option<SshConfigFile>;

pub type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CommandErrorKind {
    /// An argument is malformed, e.g. a relative path or an empty title.
    InvalidInput,
    /// A referenced workspace or task does not exist.
    NotFound,
    /// An external tool reported an error, e.g. git could not clone a repository or the
    /// path is not inside a git repository.
    External,
    /// The request is well-formed but breaks a rule, e.g. a dependency cycle or a
    /// forbidden status transition.
    Rejected,
    /// The database failed or holds data the app cannot read.
    Internal,
}

/// What went wrong, as a stable machine-readable code. The RPC endpoint and the MCP tools
/// return the same codes, so the web app and agents can react to a code instead of the
/// message text. Each code belongs to one [`CommandErrorKind`]; the generic codes named
/// after a kind cover failures without a more specific code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CommandErrorCode {
    /// An argument is malformed.
    InvalidInput,
    /// The request body does not match the command's parameters, e.g. after the server
    /// was updated and the web app was not reloaded.
    InvalidArguments,
    /// A referenced object does not exist.
    NotFound,
    /// No command or tool has this name.
    UnknownCommand,
    WorkspaceNotFound,
    TaskNotFound,
    CriterionNotFound,
    DependencyNotFound,
    RelationNotFound,
    RunNotFound,
    /// The request breaks a rule.
    Rejected,
    /// The dependency would make the task DAG cyclic or make a task depend on itself.
    DependencyCycle,
    /// The task cannot move to the requested status from its current one.
    InvalidTransition,
    /// A prerequisite of the task is not done yet.
    DependenciesNotDone,
    /// The caller may not use this tool, e.g. a chat app connected over OAuth.
    NotPermitted,
    /// An external tool failed.
    External,
    /// git reported an error.
    GitFailed,
    /// herdr reported an error or is not running.
    HerdrFailed,
    /// gh has no valid login, or the login may not open pull requests in the repository.
    GitHubAuthFailed,
    /// GitHub refused the draft setting, a reviewer, or a label of the workspace's pull
    /// request options.
    PullRequestOptionInvalid,
    /// GitHub refused to open the pull request for another reason.
    PullRequestFailed,
    /// The server failed.
    Internal,
    /// The database failed or holds data the server cannot read.
    StorageFailed,
    /// The command stopped unexpectedly on the server; the details are in the server log.
    CommandPanicked,
}

impl CommandErrorCode {
    pub fn kind(self) -> CommandErrorKind {
        match self {
            Self::InvalidInput | Self::InvalidArguments => CommandErrorKind::InvalidInput,
            Self::NotFound
            | Self::UnknownCommand
            | Self::WorkspaceNotFound
            | Self::TaskNotFound
            | Self::CriterionNotFound
            | Self::DependencyNotFound
            | Self::RelationNotFound
            | Self::RunNotFound => CommandErrorKind::NotFound,
            Self::Rejected
            | Self::DependencyCycle
            | Self::InvalidTransition
            | Self::DependenciesNotDone
            | Self::NotPermitted
            | Self::PullRequestOptionInvalid => CommandErrorKind::Rejected,
            Self::External
            | Self::GitFailed
            | Self::HerdrFailed
            | Self::GitHubAuthFailed
            | Self::PullRequestFailed => CommandErrorKind::External,
            Self::Internal | Self::StorageFailed | Self::CommandPanicked => {
                CommandErrorKind::Internal
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct CommandError {
    pub kind: CommandErrorKind,
    pub code: CommandErrorCode,
    pub message: String,
}

impl CommandError {
    pub fn new(code: CommandErrorCode, message: impl Into<String>) -> Self {
        Self {
            kind: code.kind(),
            code,
            message: message.into(),
        }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::InvalidInput, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::NotFound, message)
    }

    pub fn rejected(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Rejected, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::Internal, message)
    }

    pub fn external(message: impl Into<String>) -> Self {
        Self::new(CommandErrorCode::External, message)
    }

    /// A command that panicked. The panic text stays in the server log: it describes the
    /// server's internals, not what the caller can do about it.
    pub fn panicked(error: impl std::fmt::Display) -> Self {
        eprintln!("toodo-server: a command panicked: {error}");
        Self::new(
            CommandErrorCode::CommandPanicked,
            "the command stopped unexpectedly on the server; retry it, and if it fails \
             again, look for \"a command panicked\" in the toodo-server log",
        )
    }
}

impl From<GitError> for CommandError {
    fn from(error: GitError) -> Self {
        let code = match &error {
            GitError::Failed { .. } => CommandErrorCode::GitFailed,
            GitError::Spawn { .. } | GitError::UnexpectedOutput { .. } => {
                CommandErrorCode::Internal
            }
        };
        Self::new(code, error.to_string())
    }
}

impl From<HerdrError> for CommandError {
    fn from(error: HerdrError) -> Self {
        let code = match &error {
            HerdrError::Spawn { .. }
            | HerdrError::Failed { .. }
            | HerdrError::MachineNotSaved { .. }
            | HerdrError::MachineDisabled { .. } => CommandErrorCode::HerdrFailed,
            HerdrError::UnexpectedOutput { .. } => CommandErrorCode::Internal,
        };
        Self::new(code, error.to_string())
    }
}

impl From<SshConfigError> for CommandError {
    fn from(error: SshConfigError) -> Self {
        let code = match &error {
            SshConfigError::Io { .. } => CommandErrorCode::External,
            SshConfigError::Host(SshHostError::AlreadyExists(_)) => CommandErrorCode::Rejected,
            SshConfigError::Host(_) => CommandErrorCode::InvalidInput,
        };
        Self::new(code, error.to_string())
    }
}

impl From<NamingError> for CommandError {
    fn from(error: NamingError) -> Self {
        let code = match &error {
            NamingError::WorktreeRootNotSet(_) | NamingError::PathKindMismatch(_) => {
                CommandErrorCode::InvalidInput
            }
            NamingError::TaskNotInWorkspace | NamingError::MachineMismatch { .. } => {
                CommandErrorCode::Internal
            }
        };
        Self::new(code, error.to_string())
    }
}

impl From<StorageError> for CommandError {
    fn from(error: StorageError) -> Self {
        let code = match &error {
            StorageError::WorkspaceNotFound(_) => CommandErrorCode::WorkspaceNotFound,
            StorageError::TaskNotFound(_)
            | StorageError::Dependency(DependencyError::UnknownTask(_)) => {
                CommandErrorCode::TaskNotFound
            }
            StorageError::CriterionNotFound { .. } => CommandErrorCode::CriterionNotFound,
            StorageError::DependencyNotFound { .. } => CommandErrorCode::DependencyNotFound,
            StorageError::RelationNotFound { .. } => CommandErrorCode::RelationNotFound,
            StorageError::RunNotFound(_) => CommandErrorCode::RunNotFound,
            StorageError::DeviceNotFound(_) | StorageError::PushSubscriptionNotFound(_) => {
                CommandErrorCode::NotFound
            }
            StorageError::Dependency(
                DependencyError::Cycle(_) | DependencyError::SelfDependency(_),
            ) => CommandErrorCode::DependencyCycle,
            StorageError::Transition(_) => CommandErrorCode::InvalidTransition,
            StorageError::DependenciesNotDone { .. } => CommandErrorCode::DependenciesNotDone,
            StorageError::WorkspaceHasDependents { .. }
            | StorageError::TaskNotArchived(_)
            | StorageError::WorkspaceNotArchived(_)
            | StorageError::WorkspaceArchived { .. }
            | StorageError::WorkspaceHasActiveRun { .. }
            | StorageError::RestoreClosesCycle(_)
            | StorageError::BaseBranchInReview { .. }
            | StorageError::PrerequisiteOfDoneTask { .. }
            | StorageError::DependencyOfDoneTask { .. }
            | StorageError::CriteriaOfDoneTask(_)
            | StorageError::AutomaticCriterion { .. }
            | StorageError::CheckoutHasActiveWriter { .. }
            | StorageError::RunTransition { .. } => CommandErrorCode::Rejected,
            StorageError::WorktreePathMismatch(_)
            | StorageError::SelfRelation(_)
            | StorageError::CommitTaskMismatch { .. }
            | StorageError::ActivityTaskMismatch { .. }
            | StorageError::InvalidBackup(_) => CommandErrorCode::InvalidInput,
            StorageError::Io(_) => CommandErrorCode::External,
            StorageError::Sqlite(_)
            | StorageError::BackupCheckFailed(_)
            | StorageError::UnsupportedSchemaVersion { .. }
            | StorageError::InvalidData(_) => CommandErrorCode::StorageFailed,
        };
        Self::new(code, error.to_string())
    }
}

/// Locks the database. Every storage write runs in a transaction that rolls back when
/// dropped, so a panic in another command cannot leave partial writes behind and a
/// poisoned lock is safe to reuse.
pub(crate) fn lock(storage: &StorageState) -> MutexGuard<'_, Storage> {
    storage.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

#[specta::specta]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME").to_owned(),
        version: env!("TOODO_VERSION").to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::TaskId;
    use crate::domain::status::{TaskStatus, TransitionError};

    #[test]
    fn app_info_reports_crate_metadata() {
        let info = app_info();
        assert_eq!(info.name, "toodo");
        assert_eq!(info.version, env!("TOODO_VERSION"));
    }

    #[test]
    fn storage_errors_map_to_error_codes() {
        let cases = [
            (
                StorageError::TaskNotFound(TaskId(1)),
                CommandErrorKind::NotFound,
                CommandErrorCode::TaskNotFound,
            ),
            (
                StorageError::Dependency(DependencyError::UnknownTask(TaskId(1))),
                CommandErrorKind::NotFound,
                CommandErrorCode::TaskNotFound,
            ),
            (
                StorageError::Dependency(DependencyError::Cycle(vec![TaskId(1), TaskId(1)])),
                CommandErrorKind::Rejected,
                CommandErrorCode::DependencyCycle,
            ),
            (
                StorageError::Transition(TransitionError {
                    from: TaskStatus::Done,
                    to: TaskStatus::InProgress,
                }),
                CommandErrorKind::Rejected,
                CommandErrorCode::InvalidTransition,
            ),
            (
                StorageError::WorktreePathMismatch(TaskId(1)),
                CommandErrorKind::InvalidInput,
                CommandErrorCode::InvalidInput,
            ),
            (
                StorageError::InvalidData("bad".to_owned()),
                CommandErrorKind::Internal,
                CommandErrorCode::StorageFailed,
            ),
        ];
        for (error, kind, code) in cases {
            let message = error.to_string();
            assert_eq!(
                CommandError::from(error),
                CommandError {
                    kind,
                    code,
                    message
                }
            );
        }
    }

    #[test]
    fn a_panic_does_not_reach_the_caller() {
        let error = CommandError::panicked("index out of bounds: the len is 0");
        assert_eq!(error.code, CommandErrorCode::CommandPanicked);
        assert_eq!(error.kind, CommandErrorKind::Internal);
        assert!(!error.message.contains("index out of bounds"), "{error:?}");
    }
}
