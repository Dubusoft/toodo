//! Commands for the guidelines of a workspace: rules and memories that agents read before
//! working on its tasks.
use super::State;
use super::types::{self, Guideline, GuidelineId, GuidelineUpdate, NewGuideline, WorkspaceId};
use super::{CommandResult, StorageState, lock};
use crate::domain::model;
use crate::storage;

/// The guidelines of a workspace: rules first, then memories, each in the order they were
/// added.
#[specta::specta]
pub fn list_guidelines(
    storage: State<'_, StorageState>,
    workspace_id: WorkspaceId,
) -> CommandResult<Vec<Guideline>> {
    Ok(types::map_all(&list(&storage, workspace_id.into())?))
}

pub(crate) fn list(
    storage: &StorageState,
    workspace: model::WorkspaceId,
) -> CommandResult<Vec<model::Guideline>> {
    Ok(lock(storage).list_guidelines(workspace)?)
}

#[specta::specta]
pub fn add_guideline(
    storage: State<'_, StorageState>,
    guideline: NewGuideline,
) -> CommandResult<Guideline> {
    Ok((&add(&storage, guideline.try_into()?)?).into())
}

pub(crate) fn add(
    storage: &StorageState,
    guideline: storage::NewGuideline,
) -> CommandResult<model::Guideline> {
    Ok(lock(storage).add_guideline(&guideline)?)
}

/// Replaces the kind and body of a guideline.
#[specta::specta]
pub fn update_guideline(
    storage: State<'_, StorageState>,
    guideline: GuidelineUpdate,
) -> CommandResult<Guideline> {
    Ok((&update(&storage, guideline)?).into())
}

pub(crate) fn update(
    storage: &StorageState,
    guideline: GuidelineUpdate,
) -> CommandResult<model::Guideline> {
    let body = types::guideline_body(&guideline.body)?;
    Ok(lock(storage).update_guideline(guideline.id.into(), guideline.kind.into(), &body)?)
}

/// Deletes a guideline and returns it as it was.
#[specta::specta]
pub fn delete_guideline(
    storage: State<'_, StorageState>,
    id: GuidelineId,
) -> CommandResult<Guideline> {
    Ok((&delete(&storage, id.into())?).into())
}

pub(crate) fn delete(
    storage: &StorageState,
    id: model::GuidelineId,
) -> CommandResult<model::Guideline> {
    Ok(lock(storage).delete_guideline(id)?)
}
