//! Commands exposed to the frontend. Arguments and results use the serializable shapes in
//! [`types`]; failures are reported as a [`CommandError`].
//!
//! The server (`toodo-server`) serves them over HTTP (`server/rpc.rs`), passing the state
//! they take by reference, see [`State`]. Each is annotated with `#[specta::specta]` so
//! that `bindings.rs` can generate the frontend's typed bindings from its signature.

pub mod backup;
pub mod completion;
pub mod events;
pub mod freshness;
pub mod herdr;
pub mod issues;
pub mod machines;
pub mod mcp;
pub mod review;
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
    fn pull_request_statuses(&self) -> &completion::PullRequestStatusState;
    fn backups(&self) -> &backup::Backups;
}

pub type StorageState = Mutex<Storage>;

pub type GitState = Arc<Git>;

pub type HerdrState = Arc<Herdr>;

pub type GitHubState = Arc<GitHub>;

pub type SshState = Arc<Ssh>;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct CommandError {
    pub kind: CommandErrorKind,
    pub message: String,
}

impl CommandError {
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            kind: CommandErrorKind::InvalidInput,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            kind: CommandErrorKind::NotFound,
            message: message.into(),
        }
    }

    pub fn rejected(message: impl Into<String>) -> Self {
        Self {
            kind: CommandErrorKind::Rejected,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            kind: CommandErrorKind::Internal,
            message: message.into(),
        }
    }

    pub fn external(message: impl Into<String>) -> Self {
        Self {
            kind: CommandErrorKind::External,
            message: message.into(),
        }
    }
}

impl From<GitError> for CommandError {
    fn from(error: GitError) -> Self {
        let kind = match &error {
            GitError::Failed { .. } => CommandErrorKind::External,
            GitError::Spawn { .. } | GitError::UnexpectedOutput { .. } => {
                CommandErrorKind::Internal
            }
        };
        Self {
            kind,
            message: error.to_string(),
        }
    }
}

impl From<HerdrError> for CommandError {
    fn from(error: HerdrError) -> Self {
        let kind = match &error {
            HerdrError::Spawn { .. }
            | HerdrError::Failed { .. }
            | HerdrError::MachineNotSaved { .. }
            | HerdrError::MachineDisabled { .. } => CommandErrorKind::External,
            HerdrError::UnexpectedOutput { .. } => CommandErrorKind::Internal,
        };
        Self {
            kind,
            message: error.to_string(),
        }
    }
}

impl From<SshConfigError> for CommandError {
    fn from(error: SshConfigError) -> Self {
        let kind = match &error {
            SshConfigError::Io { .. } => CommandErrorKind::External,
            SshConfigError::Host(SshHostError::AlreadyExists(_)) => CommandErrorKind::Rejected,
            SshConfigError::Host(_) => CommandErrorKind::InvalidInput,
        };
        Self {
            kind,
            message: error.to_string(),
        }
    }
}

impl From<NamingError> for CommandError {
    fn from(error: NamingError) -> Self {
        let kind = match &error {
            NamingError::WorktreeRootNotSet(_) | NamingError::PathKindMismatch(_) => {
                CommandErrorKind::InvalidInput
            }
            NamingError::TaskNotInWorkspace | NamingError::MachineMismatch { .. } => {
                CommandErrorKind::Internal
            }
        };
        Self {
            kind,
            message: error.to_string(),
        }
    }
}

impl From<StorageError> for CommandError {
    fn from(error: StorageError) -> Self {
        let kind = match &error {
            StorageError::WorkspaceNotFound(_)
            | StorageError::TaskNotFound(_)
            | StorageError::CriterionNotFound { .. }
            | StorageError::DeviceNotFound(_)
            | StorageError::PushSubscriptionNotFound(_)
            | StorageError::DependencyNotFound { .. }
            | StorageError::RelationNotFound { .. }
            | StorageError::Dependency(DependencyError::UnknownTask(_)) => {
                CommandErrorKind::NotFound
            }
            StorageError::Dependency(_)
            | StorageError::WorkspaceHasDependents { .. }
            | StorageError::BaseBranchInReview { .. }
            | StorageError::Transition(_)
            | StorageError::DependenciesNotDone { .. }
            | StorageError::PrerequisiteOfDoneTask { .. }
            | StorageError::CriteriaOfDoneTask(_)
            | StorageError::AutomaticCriterion { .. } => CommandErrorKind::Rejected,
            StorageError::WorktreePathMismatch(_)
            | StorageError::SelfRelation(_)
            | StorageError::CommitTaskMismatch { .. }
            | StorageError::InvalidBackup(_) => CommandErrorKind::InvalidInput,
            StorageError::Io(_) => CommandErrorKind::External,
            StorageError::Sqlite(_)
            | StorageError::UnsupportedSchemaVersion { .. }
            | StorageError::InvalidData(_) => CommandErrorKind::Internal,
        };
        Self {
            kind,
            message: error.to_string(),
        }
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
        version: env!("CARGO_PKG_VERSION").to_owned(),
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
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn storage_errors_map_to_error_kinds() {
        let cases = [
            (
                StorageError::TaskNotFound(TaskId(1)),
                CommandErrorKind::NotFound,
            ),
            (
                StorageError::Dependency(DependencyError::UnknownTask(TaskId(1))),
                CommandErrorKind::NotFound,
            ),
            (
                StorageError::Dependency(DependencyError::Cycle(vec![TaskId(1), TaskId(1)])),
                CommandErrorKind::Rejected,
            ),
            (
                StorageError::Transition(TransitionError {
                    from: TaskStatus::Done,
                    to: TaskStatus::InProgress,
                }),
                CommandErrorKind::Rejected,
            ),
            (
                StorageError::WorktreePathMismatch(TaskId(1)),
                CommandErrorKind::InvalidInput,
            ),
            (
                StorageError::InvalidData("bad".to_owned()),
                CommandErrorKind::Internal,
            ),
        ];
        for (error, kind) in cases {
            let message = error.to_string();
            assert_eq!(CommandError::from(error), CommandError { kind, message });
        }
    }
}
