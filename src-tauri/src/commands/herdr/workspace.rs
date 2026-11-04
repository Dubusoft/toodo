//! The herdr workspace of a started task: opening, focusing, and listing its panes.

use super::super::{CommandError, CommandResult, StorageState, lock};
use super::{WORKSPACE_NOT_FOUND, has_code, reject_tmux};
use crate::adapters::herdr::{AGENT_NOT_FOUND, AgentStatus, Herdr, HerdrError, PaneAgent};
use crate::domain::model::{self, Machine, Runner, WorkspaceLocation};
use crate::domain::status::TaskStatus;
use crate::runtime::{RuntimeService, TaskWorktree};
use crate::storage::StorageError;

/// Where the herdr workspace of a started task is.
struct TaskWorkspace {
    location: WorkspaceLocation,
    worktree_path: Option<model::HostPath>,
    herdr_workspace_id: String,
}

/// The herdr workspace of the task's open runtime workspace.
fn task_workspace(storage: &StorageState, id: model::TaskId) -> CommandResult<TaskWorkspace> {
    let storage = lock(storage);
    let task = storage
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    let workspace = storage
        .get_workspace(task.workspace_id)?
        .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
    reject_tmux(workspace.runner)?;
    let herdr_workspace_id = storage
        .open_runtime_workspace(id)?
        .map(|record| record.provider_workspace_ref)
        .ok_or_else(|| no_herdr_workspace(&task, &workspace))?;
    Ok(TaskWorkspace {
        location: workspace.location,
        worktree_path: task.worktree_path,
        herdr_workspace_id,
    })
}

/// Why `task` of `workspace` has no herdr workspace to open, with the next step.
fn no_herdr_workspace(task: &model::Task, workspace: &model::Workspace) -> CommandError {
    let id = task.id;
    if workspace.runner == Runner::None {
        return CommandError::rejected(format!(
            "task {id} belongs to workspace {}, which runs tasks without herdr (runner none), so it has no herdr workspace or panes; work on it in the workspace directory and complete it once its criteria are met",
            workspace.name
        ));
    }
    if workspace.runner == Runner::Plain && task.status != TaskStatus::Planned {
        return CommandError::rejected(format!(
            "task {id} belongs to workspace {}, which runs agents without herdr (runner plain), so it has no herdr workspace or panes; start its agent with start_plain_run and follow the run with get_run_log",
            workspace.name
        ));
    }
    CommandError::rejected(format!("task {id} has no herdr workspace; start it first"))
}

/// Opens the worktree of a task whose herdr workspace herdr no longer has, e.g. because
/// the user closed it, without focusing it, and remembers the new workspace. `missing` is
/// the error to report for a task without a worktree.
fn reopen(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
    target: &TaskWorkspace,
    missing: impl FnOnce() -> CommandError,
) -> CommandResult<String> {
    let Some(path) = &target.worktree_path else {
        return Err(missing());
    };
    let repository = match &target.location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    };
    let machine = target.location.machine();
    let worktree = TaskWorktree {
        task: id,
        machine: &machine,
        repository,
    };
    let reopened = RuntimeService.reopen_workspace(storage, herdr, &worktree, &path.to_string())?;
    Ok(reopened.record.provider_workspace_ref)
}

/// Focuses the herdr workspace of a started task. When herdr no longer has it, the task's
/// worktree is opened again like [`ensure_workspace`] and then focused.
pub(super) fn open(storage: &StorageState, herdr: &Herdr, id: model::TaskId) -> CommandResult<()> {
    let target = task_workspace(storage, id)?;
    let machine: Machine = target.location.machine();
    match herdr.focus_workspace(&machine, &target.herdr_workspace_id) {
        Err(error) if has_code(&error, WORKSPACE_NOT_FOUND) => {
            let reopened = reopen(storage, herdr, id, &target, || error.into())?;
            Ok(herdr.focus_workspace(&machine, &reopened)?)
        }
        result => Ok(result?),
    }
}

/// The herdr workspace of a started task with its panes.
#[derive(Debug)]
pub(crate) struct WorkspacePanes {
    pub machine: Machine,
    pub panes: Vec<PaneAgent>,
}

/// The panes of the herdr workspace of a started task, as herdr lists them now; none
/// when herdr no longer has the workspace.
pub(crate) fn task_panes(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<WorkspacePanes> {
    let target = task_workspace(storage, id)?;
    let machine = target.location.machine();
    let panes = workspace_panes(herdr, &machine, &target.herdr_workspace_id)?;
    Ok(WorkspacePanes { machine, panes })
}

fn workspace_panes(
    herdr: &Herdr,
    machine: &Machine,
    workspace_id: &str,
) -> Result<Vec<PaneAgent>, HerdrError> {
    Ok(herdr
        .list_panes(machine)?
        .into_iter()
        .filter(|pane| pane.workspace_id == workspace_id)
        .collect())
}

/// Makes sure herdr has the workspace of a started task open, without focusing it: a
/// workspace herdr no longer has (it lists none of its panes) is opened again from the
/// task's worktree. Returns the workspace's panes.
pub(super) fn ensure_workspace(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<WorkspacePanes> {
    let found = task_panes(storage, herdr, id)?;
    if !found.panes.is_empty() {
        return Ok(found);
    }
    let target = task_workspace(storage, id)?;
    let reopened = reopen(storage, herdr, id, &target, || {
        CommandError::rejected(format!(
            "herdr no longer has the workspace of task {id}, and the task has no worktree to \
             open again"
        ))
    })?;
    let panes = workspace_panes(herdr, &found.machine, &reopened)?;
    Ok(WorkspacePanes {
        machine: found.machine,
        panes,
    })
}

pub(super) fn focus_agent(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<()> {
    let target = task_workspace(storage, id)?;
    let (machine, herdr_workspace_id) = (target.location.machine(), target.herdr_workspace_id);
    let pane = herdr
        .list_panes(&machine)?
        .into_iter()
        .filter(|pane| {
            pane.workspace_id == herdr_workspace_id && pane.status != AgentStatus::Unknown
        })
        // The first of the panes whose agent needs the user most.
        .rev()
        .max_by_key(|pane| pane.status);
    let Some(pane) = pane else {
        return open(storage, herdr, id);
    };
    match herdr.focus_agent(&machine, &pane.pane_id) {
        // The agent left the pane since it was listed.
        Err(error) if has_code(&error, AGENT_NOT_FOUND) => open(storage, herdr, id),
        result => Ok(result?),
    }
}
