//! Issue references supplied by callers.
use super::types::{self, Task, TaskId};
use super::{CommandResult, State, StorageState, lock};
use crate::storage::StorageError;

/// Appends an issue reference without querying the issue service.
#[specta::specta]
pub fn link_issue(
    storage: State<'_, StorageState>,
    id: TaskId,
    reference: String,
) -> CommandResult<Task> {
    let mut storage = lock(&storage);
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    let refs = types::merge_refs(&task.refs, &[reference], &[])?;
    Ok((&storage.set_task_refs(task.id, &refs)?).into())
}
