//! Commands for workspace records.
use super::State;
use super::types::{self, NewWorkspace, Workspace, WorkspaceId};
use super::{CommandResult, StorageState, lock};
use crate::domain::model;
use crate::storage::{self, StorageError};

#[specta::specta]
pub fn list_workspaces(storage: State<'_, StorageState>) -> CommandResult<Vec<Workspace>> {
    Ok(types::map_all(&lock(&storage).list_workspaces()?))
}

#[specta::specta]
pub fn get_workspace(
    storage: State<'_, StorageState>,
    id: WorkspaceId,
) -> CommandResult<Workspace> {
    let workspace = lock(&storage)
        .get_workspace(id.into())?
        .ok_or(StorageError::WorkspaceNotFound(id.into()))?;
    Ok((&workspace).into())
}

/// Removes a workspace from Toodo by archiving it with its tasks: they leave the lists but
/// stay in reviews, and [`restore_workspace`] brings them back. [`purge_workspace`]
/// deletes them for good.
#[specta::specta]
pub fn delete_workspace(storage: State<'_, StorageState>, id: WorkspaceId) -> CommandResult<()> {
    Ok(lock(&storage).archive_workspace(id.into())?)
}

/// Brings an archived workspace back with its tasks.
#[specta::specta]
pub fn restore_workspace(
    storage: State<'_, StorageState>,
    id: WorkspaceId,
) -> CommandResult<Workspace> {
    Ok((&lock(&storage).restore_workspace(id.into())?).into())
}

/// Deletes an archived workspace for good with its tasks, their history, and commit
/// records; a workspace that is not archived is rejected.
#[specta::specta]
pub fn purge_workspace(storage: State<'_, StorageState>, id: WorkspaceId) -> CommandResult<()> {
    Ok(lock(&storage).purge_workspace(id.into())?)
}

/// The workspaces and tasks deleting archived, to restore or purge.
#[specta::specta]
pub fn list_archive(storage: State<'_, StorageState>) -> CommandResult<types::Archive> {
    let storage = lock(&storage);
    Ok(types::Archive {
        workspaces: types::map_all(&storage.archived_workspaces()?),
        tasks: types::map_all(&storage.archived_tasks()?),
    })
}

/// Stores a workspace without inspecting its external location.
#[specta::specta]
pub fn create_workspace(
    storage: State<'_, StorageState>,
    workspace: NewWorkspace,
) -> CommandResult<Workspace> {
    Ok((&create(&storage, workspace.try_into()?)?).into())
}

pub(crate) fn create(
    storage: &StorageState,
    workspace: storage::NewWorkspace,
) -> CommandResult<model::Workspace> {
    Ok(lock(storage).create_workspace(&workspace)?)
}

#[specta::specta]
pub fn update_workspace(
    storage: State<'_, StorageState>,
    workspace: Workspace,
) -> CommandResult<Workspace> {
    Ok((&update(&storage, workspace)?).into())
}

pub(crate) fn update(
    storage: &StorageState,
    workspace: Workspace,
) -> CommandResult<model::Workspace> {
    let mut storage = lock(storage);
    let id = workspace.id.into();
    let stored = storage
        .get_workspace(id)?
        .ok_or(StorageError::WorkspaceNotFound(id))?;
    let workspace = workspace.into_model(&stored)?;
    storage.update_workspace(&workspace)?;
    Ok(workspace)
}
