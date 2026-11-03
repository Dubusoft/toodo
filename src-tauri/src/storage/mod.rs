//! SQLite persistence for workspaces, machine settings, tasks, task dependencies, and
//! commit records.
//!
//! The database lives in a single file in the app data directory. Its schema is
//! versioned with `PRAGMA user_version` and migrated forward when it is opened. Writes
//! that touch the task DAG run in one transaction and keep it valid: dependency edges
//! are checked with [`crate::domain::dag`], and `planned`/`ready` statuses are brought in
//! line with the dependencies after every change.

mod backup;
mod commits;
mod criteria;
mod devices;
mod import;
mod migrations;
mod push;
mod search;
mod tasks;
mod workspaces;

#[cfg(test)]
mod tests;

use std::fmt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::domain::criteria::{CheckKind, CriterionId};
use crate::domain::dag::{BlockingDependency, DependencyError};
use crate::domain::device::DeviceId;
use crate::domain::model::{TaskId, TaskResolution, WorkspaceId};
use crate::domain::status::TransitionError;

pub use backup::{BackupFile, StagedBackup, list_backups, prune_backups, stage_backup};
pub use criteria::{CriterionCheck, CriterionEdit};
pub use import::ImportSummary;
pub use push::NewPushSubscription;
pub use search::TaskSearch;
pub use tasks::{AddedDependencies, DependencyChange, NewTask, PauseRule};
pub use workspaces::NewWorkspace;

pub type Result<T> = std::result::Result<T, StorageError>;

/// Handle to the Toodo database. Readers take `&self`; writers take `&mut self` and run
/// in a transaction.
pub struct Storage {
    conn: Connection,
    /// Current time in seconds since the Unix epoch, used to timestamp task status
    /// changes.
    clock: Box<dyn Fn() -> i64 + Send>,
}

fn system_clock() -> i64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the system clock is set after the Unix epoch");
    i64::try_from(elapsed.as_secs()).expect("seconds since the Unix epoch fit in i64")
}

impl Storage {
    /// Opens (or creates) the database file at `path` and migrates it to the latest
    /// schema.
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    /// Opens a private in-memory database with the latest schema.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        migrations::migrate(&mut conn)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        Ok(Self {
            conn,
            clock: Box::new(system_clock),
        })
    }

    /// Replaces the clock that timestamps task status changes.
    #[cfg(test)]
    pub(crate) fn set_clock(&mut self, clock: impl Fn() -> i64 + Send + 'static) {
        self.clock = Box::new(clock);
    }

    pub(crate) fn now(&self) -> i64 {
        (self.clock)()
    }
}

#[derive(Debug)]
pub enum StorageError {
    Sqlite(rusqlite::Error),
    /// The database was written by a newer version of Toodo.
    UnsupportedSchemaVersion {
        found: i64,
        supported: i64,
    },
    WorkspaceNotFound(WorkspaceId),
    /// A workspace cannot be deleted while a task of another workspace still waits on
    /// one of its tasks: deleting the prerequisite would make the dependent ready.
    WorkspaceHasDependents {
        workspace: WorkspaceId,
        task: TaskId,
        depends_on: TaskId,
    },
    /// The base branch of a workspace cannot change while one of its tasks is in review,
    /// because the task's pull request targets the current branch.
    BaseBranchInReview {
        workspace: WorkspaceId,
        task: TaskId,
    },
    TaskNotFound(TaskId),
    Dependency(DependencyError),
    Transition(TransitionError),
    /// A task cannot start while one of its dependencies is not done or was concluded
    /// without being adopted. `blockers` lists those dependencies.
    DependenciesNotDone {
        task: TaskId,
        blockers: Vec<BlockingDependency>,
    },
    /// A `done` task cannot wait on new prerequisites.
    PrerequisiteOfDoneTask {
        task: TaskId,
        depends_on: Vec<TaskId>,
    },
    /// The dependency to remove does not exist.
    DependencyNotFound {
        task: TaskId,
        depends_on: TaskId,
    },
    /// The related link to remove does not exist.
    RelationNotFound {
        task: TaskId,
        related: TaskId,
    },
    /// A task cannot be related to itself.
    SelfRelation(TaskId),
    CriterionNotFound {
        task: TaskId,
        criterion: CriterionId,
    },
    /// The criteria of a done task are its record and cannot change.
    CriteriaOfDoneTask(TaskId),
    /// Only manual criteria are checked by hand; Toodo checks the others.
    AutomaticCriterion {
        task: TaskId,
        criterion: CriterionId,
        kind: CheckKind,
    },
    DeviceNotFound(DeviceId),
    /// The device has not subscribed to push notifications.
    PushSubscriptionNotFound(DeviceId),
    /// The worktree path is not the kind of path (Windows or POSIX) of the repository path
    /// of the task's workspace.
    WorktreePathMismatch(TaskId),
    CommitTaskMismatch {
        expected: TaskId,
        found: TaskId,
    },
    /// A stored value cannot be converted back into the domain model.
    InvalidData(String),
    /// A file to restore from is not a readable Toodo database.
    InvalidBackup(String),
    Io(std::io::Error),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "database error: {error}"),
            Self::UnsupportedSchemaVersion { found, supported } => write!(
                f,
                "database schema version {found} is newer than the supported version {supported}"
            ),
            Self::WorkspaceNotFound(id) => write!(f, "workspace {} does not exist", id.0),
            Self::WorkspaceHasDependents {
                workspace,
                task,
                depends_on,
            } => write!(
                f,
                "workspace {} cannot be removed: task {task} of another workspace depends on its task {depends_on}",
                workspace.0
            ),
            Self::BaseBranchInReview { workspace, task } => write!(
                f,
                "base branch of workspace {} cannot change while task {task} is in review",
                workspace.0
            ),
            Self::TaskNotFound(id) => write!(f, "task {id} does not exist"),
            Self::Dependency(error) => error.fmt(f),
            Self::Transition(error) => error.fmt(f),
            Self::DependenciesNotDone { task, blockers } => {
                let blockers: Vec<String> = blockers
                    .iter()
                    .map(|blocker| {
                        let id = blocker.id;
                        match blocker.resolution {
                            Some(TaskResolution::NotAdopted) => format!(
                                "#{id} is done as not_adopted (remove_dependency task_id {task} depends_on {id} to unblock, or complete #{id} with merged_with)"
                            ),
                            _ => format!("#{id} is {} (wait for it)", blocker.status),
                        }
                    })
                    .collect();
                write!(f, "task {task} cannot start yet: {}", blockers.join("; "))
            }
            Self::PrerequisiteOfDoneTask { task, depends_on } => {
                let ids: Vec<String> = depends_on.iter().map(TaskId::to_string).collect();
                write!(
                    f,
                    "task {task} is done, so it cannot wait on new prerequisites; for more work that needs them, create a follow-up task with create_task and depends_on [{}]",
                    ids.join(", ")
                )
            }
            Self::DependencyNotFound { task, depends_on } => write!(
                f,
                "task {task} does not depend on {depends_on}; get_task {task} lists the tasks it depends on (dependsOn), and task_id is the task that waits"
            ),
            Self::RelationNotFound { task, related } => write!(
                f,
                "tasks {task} and {related} are not related; get_task {task} lists its related tasks"
            ),
            Self::SelfRelation(id) => write!(f, "task {id} cannot be related to itself"),
            Self::CriterionNotFound { task, criterion } => {
                write!(f, "task {task} has no criterion {criterion}")
            }
            Self::CriteriaOfDoneTask(id) => {
                write!(
                    f,
                    "task {id} is done; its completion criteria cannot change"
                )
            }
            Self::AutomaticCriterion {
                task,
                criterion,
                kind,
            } => write!(
                f,
                "criterion {criterion} of task {task} is a {kind} criterion, which Toodo checks on its own; only manual criteria are checked by hand"
            ),
            Self::DeviceNotFound(id) => write!(f, "device {id} does not exist"),
            Self::PushSubscriptionNotFound(id) => {
                write!(f, "device {id} has not subscribed to push notifications")
            }
            Self::WorktreePathMismatch(id) => write!(
                f,
                "worktree path of task {id} does not match the machine of its workspace"
            ),
            Self::CommitTaskMismatch { expected, found } => write!(
                f,
                "commit record of task {found} cannot be stored for task {expected}"
            ),
            Self::InvalidData(message) => write!(f, "stored data is invalid: {message}"),
            Self::InvalidBackup(message) => write!(f, "invalid backup {message}"),
            Self::Io(error) => write!(f, "file error: {error}"),
        }
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::Dependency(error) => Some(error),
            Self::Transition(error) => Some(error),
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<std::io::Error> for StorageError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<DependencyError> for StorageError {
    fn from(error: DependencyError) -> Self {
        Self::Dependency(error)
    }
}

impl From<TransitionError> for StorageError {
    fn from(error: TransitionError) -> Self {
        Self::Transition(error)
    }
}

fn invalid_data(error: impl fmt::Display) -> StorageError {
    StorageError::InvalidData(error.to_string())
}
