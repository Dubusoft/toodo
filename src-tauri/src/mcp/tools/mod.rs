//! What the MCP tools do, over the same storage as the Tauri commands, so agents follow
//! the rules the UI follows: the dependency DAG stays acyclic and readiness stays in sync.
//! Starting, completing, and concluding tasks run the app's own commands.

mod create;
mod edits;
mod lifecycle;
mod queries;
mod requests;
#[cfg(test)]
mod tests;
mod workspaces;

use crate::commands::CommandResult;
use crate::commands::types::{Task, TaskId};
use crate::storage::{Storage, StorageError};

pub use create::*;
pub use edits::*;
pub use lifecycle::*;
pub use queries::*;
pub use requests::*;
pub use workspaces::*;

pub(super) fn get_task(storage: &Storage, id: TaskId) -> CommandResult<Task> {
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    Ok((&task).into())
}
