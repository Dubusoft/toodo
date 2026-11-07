use crate::commands::{CommandError, CommandResult, StorageState, lock};
use crate::domain::model;
use crate::storage::StorageError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

/// How work ends without completing its own criteria.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConcludeOutcome {
    #[default]
    NotAdopted,
    ShippedWith,
}

pub(crate) fn conclude(
    storage: &StorageState,
    id: model::TaskId,
    note: &str,
    outcome: ConcludeOutcome,
    shipped_with: Option<model::TaskId>,
) -> CommandResult<model::Task> {
    let note = note.trim();
    if note.is_empty() {
        return Err(CommandError::invalid_input(
            "note is blank; call conclude_task with a note explaining the outcome",
        ));
    }
    if (outcome == ConcludeOutcome::ShippedWith) != shipped_with.is_some() {
        return Err(CommandError::invalid_input(
            "call conclude_task with outcome shipped_with and shipped_with set to the completed task id, or with outcome not_adopted and no shipped_with",
        ));
    }
    let mut storage = lock(storage);
    if let Some(other) = shipped_with {
        if other == id {
            return Err(CommandError::invalid_input(format!(
                "task {id} cannot ship itself; call complete_task with id {id} for its own work, or conclude_task with outcome not_adopted and a note"
            )));
        }
        let target = storage
            .get_task(other)?
            .ok_or(StorageError::TaskNotFound(other))?;
        if target.status != crate::domain::status::TaskStatus::Done
            || target.resolution == Some(model::TaskResolution::NotAdopted)
        {
            return Err(CommandError::rejected(format!(
                "task {other} has not shipped this work; call complete_task for that task first, then conclude_task with outcome shipped_with and shipped_with {other}"
            )));
        }
    }
    Ok(storage.conclude_task(id, note, shipped_with)?)
}
