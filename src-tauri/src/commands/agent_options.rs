//! Commands for how agents of runs are launched: the model, permission mode, and time
//! limit a workspace sets for the runs of its tasks, and the ones a task overrides.

use super::types::{AgentOptions, TaskAgentOptions, TaskId, WorkspaceId};
use super::{CommandResult, State, StorageState, lock};
use crate::storage::{Storage, StorageError};

/// The launch options a workspace sets for the runs of its tasks.
#[specta::specta]
pub fn get_workspace_agent_options(
    storage: State<'_, StorageState>,
    workspace_id: WorkspaceId,
) -> CommandResult<AgentOptions> {
    Ok((&lock(&storage).workspace_agent_options(workspace_id.into())?).into())
}

/// Replaces the launch options a workspace sets for the runs of its tasks; a `null`
/// value keeps the built-in default. Runs started later use them.
#[specta::specta]
pub fn set_workspace_agent_options(
    storage: State<'_, StorageState>,
    workspace_id: WorkspaceId,
    options: AgentOptions,
) -> CommandResult<AgentOptions> {
    let options = options.parse()?;
    let mut storage = lock(&storage);
    storage.set_workspace_agent_options(workspace_id.into(), &options)?;
    Ok((&storage.workspace_agent_options(workspace_id.into())?).into())
}

/// The launch options a task overrides and the ones its workspace sets.
#[specta::specta]
pub fn get_task_agent_options(
    storage: State<'_, StorageState>,
    task_id: TaskId,
) -> CommandResult<TaskAgentOptions> {
    task_options(&lock(&storage), task_id)
}

/// Replaces the launch options a task overrides; a `null` value takes its workspace's.
/// Runs started later use them.
#[specta::specta]
pub fn set_task_agent_options(
    storage: State<'_, StorageState>,
    task_id: TaskId,
    options: AgentOptions,
) -> CommandResult<TaskAgentOptions> {
    let options = options.parse()?;
    let mut storage = lock(&storage);
    storage.set_task_agent_options(task_id.into(), &options)?;
    task_options(&storage, task_id)
}

fn task_options(storage: &Storage, task_id: TaskId) -> CommandResult<TaskAgentOptions> {
    let id = task_id.into();
    let task = storage
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    Ok(TaskAgentOptions {
        task: (&storage.task_agent_options(id)?).into(),
        workspace: (&storage.workspace_agent_options(task.workspace_id)?).into(),
    })
}
