//! Removing the worktree of a task, deleting a task, and closing the herdr workspace of
//! a paused task.

use super::super::{CommandError, CommandResult, StorageState, lock};
use super::{git_managed, has_code};
use crate::adapters::git::{Git, GitError};
use crate::adapters::herdr::{DIRTY_WORKTREE, Herdr};
use crate::domain::model::{self, WorkspaceLocation};
use crate::domain::status::TaskStatus;
use crate::runtime::{RuntimeError, RuntimeService, TaskWorktree};
use crate::storage::StorageError;

/// Deletes a task; a task that still has a worktree first removes it like
/// [`remove_worktree`], so a dirty worktree keeps the task unless `force` is set.
pub(in crate::commands) fn delete(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    id: model::TaskId,
    force: bool,
) -> CommandResult<()> {
    let task = lock(storage)
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    if task.worktree_path.is_some() {
        remove_worktree(storage, git, herdr, id, force)?;
    }
    Ok(lock(storage).delete_task(id)?)
}

/// Removes the worktree of a task that is not in progress or in review (a finished task,
/// or a paused one) through herdr, which also closes
/// its herdr workspace, and forgets both on the task. The branch is kept. Without `force`,
/// a worktree with modified or untracked files is rejected. A task of a workspace with a
/// git-managed runner (plain or tmux) has no herdr workspace: git removes its worktree.
pub(super) fn remove_worktree(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    id: model::TaskId,
    force: bool,
) -> CommandResult<model::Task> {
    let (location, path, runner) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        if matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview) {
            return Err(CommandError::rejected(format!(
                "task {id} is {}; in progress and in review tasks keep their worktree",
                task.status
            )));
        }
        let path = task
            .worktree_path
            .ok_or_else(|| CommandError::rejected(format!("task {id} has no worktree")))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        (workspace.location, path, workspace.runner)
    };
    if git_managed(runner) {
        return remove_plain_worktree(storage, git, id, &location, &path, force);
    }
    let path = path.to_string();
    let machine = location.machine();
    let repository = match &location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    };
    let target = TaskWorktree {
        task: id,
        machine: &machine,
        repository,
    };
    RuntimeService
        .remove_workspace(storage, herdr, &target, &path, force)
        .map_err(|error| match error {
            RuntimeError::Workspace(error) if has_code(&error, DIRTY_WORKTREE) => {
                CommandError::rejected(format!(
                    "the worktree of task {id} at {path} has modified or untracked files; \
                     force the removal to discard them"
                ))
            }
            error => error.into(),
        })
}

/// Removes the git worktree at `path` of a task of a workspace with runner plain or tmux and
/// forgets it on the task; a worktree git no longer has is only forgotten.
fn remove_plain_worktree(
    storage: &StorageState,
    git: &Git,
    id: model::TaskId,
    location: &WorkspaceLocation,
    path: &model::HostPath,
    force: bool,
) -> CommandResult<model::Task> {
    if git.worktree_exists(location, path)? {
        git.remove_worktree(location, path, force)
            .map_err(|error| match &error {
                GitError::Failed { stderr, .. }
                    if stderr.contains("modified or untracked files") =>
                {
                    CommandError::rejected(format!(
                        "the worktree of task {id} at {path} has modified or untracked files; \
                         force the removal to discard them"
                    ))
                }
                _ => error.into(),
            })?;
    }
    Ok(lock(storage).clear_task_worktree(id)?)
}

/// Makes `id` depend on every task of `depends_on` for the app, where the user already
/// confirmed the pause. An `in_progress` task that a new prerequisite blocks is paused and
/// its herdr workspace closed like [`close_workspace`], keeping the worktree, so resuming
/// it opens the worktree again once the prerequisites are done. If closing fails, the
/// task stays paused and the error says so.
pub(in crate::commands) fn add_dependencies(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
    depends_on: &[model::TaskId],
) -> CommandResult<model::Task> {
    let added = lock(storage).add_dependencies(id, depends_on)?;
    if !added.paused || added.task.herdr_workspace_id.is_none() {
        return Ok(added.task);
    }
    close_workspace(storage, herdr, id).map_err(|mut error| {
        error.message = format!(
            "task {id} was paused, but its herdr workspace was not closed: {}",
            error.message
        );
        error
    })
}

/// Closes the herdr workspace of a `planned` (paused) task and forgets it; the worktree
/// is kept, so resuming the task opens it again. A task without a workspace is returned
/// as is.
pub(super) fn close_workspace(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    let location = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        if task.status != TaskStatus::Planned {
            return Err(CommandError::rejected(format!(
                "task {id} is being worked on; pause it before closing its herdr workspace"
            )));
        }
        if task.herdr_workspace_id.is_none() {
            return Ok(task);
        }
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        workspace.location
    };
    Ok(
        RuntimeService.close_workspace(storage, herdr, id, &location.machine(), |storage| {
            storage.clear_task_herdr_workspace(id)
        })?,
    )
}
