//! Commands that drive herdr: the server health check, starting a task in a new
//! worktree, focusing the herdr workspace or agent pane of a started task, restoring the worktree of an
//! active task that lost it, and deleting a task together with its worktree.
//!
//! They run on the async runtime instead of the main thread because herdr calls can take
//! seconds. The database lock is not held while herdr runs.

use super::State;

use super::types::{HerdrStatus, Task, TaskId, TaskPane};
use super::{CommandError, CommandResult, GitState, HerdrState, StorageState};
use crate::adapters::herdr::HerdrError;
pub(super) use crate::adapters::herdr::WORKSPACE_NOT_FOUND;
use crate::domain::model::Runner;
use crate::runtime::RuntimeError;

mod cleanup;
mod prepare;
#[cfg(test)]
mod tests;
mod workspace;

use cleanup::close_workspace;
pub(super) use cleanup::{add_dependencies, delete};
pub(crate) use prepare::{restore, start};
pub(crate) use workspace::task_panes;
use workspace::{ensure_workspace, focus_agent, open};

impl From<RuntimeError> for CommandError {
    fn from(error: RuntimeError) -> Self {
        match error {
            RuntimeError::Storage(error) => error.into(),
            RuntimeError::Workspace(error) => error.into(),
            error @ RuntimeError::Runner(_) => CommandError::external(error.to_string()),
            error @ RuntimeError::WorkspaceNotOpen { .. } => {
                CommandError::rejected(error.to_string())
            }
            error @ RuntimeError::RecordMismatch { .. } => {
                CommandError::internal(error.to_string())
            }
        }
    }
}

#[specta::specta]
pub fn herdr_status(herdr: State<'_, HerdrState>) -> CommandResult<HerdrStatus> {
    Ok((&herdr.server_status()?).into())
}

/// Creates the worktree of a `planned` task whose dependencies are done through herdr
/// and moves the task to `in_progress`. Requires a worktree root for the machine of the
/// task's workspace. An empty repository first gets an initial commit on the workspace's
/// base branch. A new task branch starts from the freshly fetched `origin/<base>` without an
/// upstream; without `origin`, or when the fetch fails (noted on the task), from the local
/// base. A paused task resumes on its branch, in its worktree if it still has one.
#[specta::specta]
pub fn start_task(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&start(&storage, &git, &**herdr, id.into())?).into())
}

/// Makes sure herdr has the workspace of a started task open without focusing it, opening
/// the task's worktree again when herdr no longer has it, and lists the workspace's panes
/// for the pane view.
#[specta::specta]
pub fn ensure_task_workspace(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Vec<TaskPane>> {
    let found = ensure_workspace(&storage, &herdr, id.into())?;
    Ok(found.panes.iter().map(TaskPane::from).collect())
}

#[specta::specta]
pub fn open_task_in_herdr(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<()> {
    open(&storage, &herdr, id.into())
}

/// Focuses the pane of the agent working on a started task, the one that needs the user
/// most when its herdr workspace has several. Without a recognized agent it focuses the
/// workspace like [`open_task_in_herdr`].
#[specta::specta]
pub fn focus_agent_pane(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<()> {
    focus_agent(&storage, &herdr, id.into())
}

/// Closes the herdr workspace of a paused task, e.g. one that an agent paused through
/// MCP by adding a prerequisite, which leaves the workspace open for the user to decide.
/// The worktree is kept. Tasks that are worked on are rejected.
#[specta::specta]
pub fn close_task_workspace(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&close_workspace(&storage, &herdr, id.into())?).into())
}

/// Checks out the branch of an `in_progress` or `in_review` task that lost its worktree,
/// e.g. because it was removed in herdr, into a new worktree opened in herdr. The branch
/// is taken from `origin` when the repository no longer has it.
#[specta::specta]
pub fn restore_task_worktree(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&restore(&storage, &git, &herdr, id.into())?).into())
}

/// Whether git, not herdr, adds and removes the task worktrees of a workspace with
/// `runner`.
fn git_managed(runner: Runner) -> bool {
    matches!(runner, Runner::Plain | Runner::Tmux)
}

/// A task of a workspace with runner tmux has no herdr workspace or panes; its agents
/// run in tmux sessions of their own.
fn reject_tmux(runner: Runner) -> CommandResult<()> {
    if runner == Runner::Tmux {
        return Err(CommandError::rejected(
            "this task belongs to a workspace with runner tmux, which has no herdr workspace \
             or panes; start its agent with start_plain_run and attach to the run with the \
             attach command get_run_log returns",
        ));
    }
    Ok(())
}

pub(super) fn has_code(error: &HerdrError, expected: &str) -> bool {
    error.has_code(expected)
}
