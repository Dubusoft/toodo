//! Workspaces and their guidelines.

use serde::Serialize;

use super::requests::{
    AddGuideline, ArchiveWorkspace, CreateWorkspace, GetGuidelines, RemoveGuideline,
    UpdateGuideline, UpdateWorkspace, WorkspaceConfirmation,
};
use crate::commands::types::{self, Workspace, WorkspaceId};
use crate::commands::{CommandError, CommandErrorCode, CommandResult, StorageState, lock};
use crate::commands::{guidelines, workspaces};
use crate::domain::model;
use crate::storage::{Storage, StorageError};

pub fn list_workspaces(storage: &Storage) -> CommandResult<Vec<Workspace>> {
    Ok(types::map_all(&storage.list_workspaces()?))
}

/// Archives a workspace with its tasks as the app's Remove does (see
/// [`workspaces::delete_workspace`]), but only with `confirm`; without it, nothing changes
/// and the reply says what archiving would do. Rejected while a task of the workspace is
/// `in_progress` or `in_review`, since someone is working on it.
pub fn archive_workspace(
    storage: &mut Storage,
    request: ArchiveWorkspace,
) -> CommandResult<WorkspaceConfirmation> {
    let id = request.id.0;
    let stored = storage.get_workspace(request.id.into())?.ok_or_else(|| {
        CommandError::new(
            CommandErrorCode::WorkspaceNotFound,
            format!(
                "workspace {id} does not exist or is already archived; take a workspace id from list_workspaces"
            ),
        )
    })?;
    let workspace = Workspace::from(&stored);
    let tasks = storage.list_tasks(stored.id)?;
    let active: Vec<(i64, &str)> = tasks
        .iter()
        .filter_map(|task| match task.status {
            crate::domain::status::TaskStatus::InProgress => Some((task.id.0, "in_progress")),
            crate::domain::status::TaskStatus::InReview => Some((task.id.0, "in_review")),
            crate::domain::status::TaskStatus::Planned
            | crate::domain::status::TaskStatus::Done => None,
        })
        .collect();
    if let Some((first, _)) = active.first() {
        let described: Vec<String> = active
            .iter()
            .map(|(task, status)| format!("#{task} ({status})"))
            .collect();
        return Err(CommandError::rejected(format!(
            "workspace {id} \"{}\" still has task(s) being worked on: {}; finish each of them, or call pause_task on each, e.g. {{\"id\": {first}, \"reason\": \"...\"}}, then call archive_workspace again",
            workspace.name,
            described.join(", "),
        )));
    }
    if !request.confirm {
        return Ok(WorkspaceConfirmation {
            confirmed: false,
            message: format!(
                "Nothing changed yet. Archiving workspace {id} \"{}\" removes it and its {} task(s) from list_workspaces and the task lists, while their history, notes, criteria, and commit records stay in review_report; the user can restore it, or delete it for good, under Settings > Archive in the Toodo app. To archive it, call archive_workspace {{\"id\": {id}, \"confirm\": true}}.",
                workspace.name,
                tasks.len()
            ),
            workspace,
        });
    }
    storage.archive_workspace(stored.id)?;
    Ok(WorkspaceConfirmation {
        confirmed: true,
        message: format!(
            "workspace {id} \"{}\" is archived with its {} task(s); they stay in review_report, and the user can restore the workspace in the Toodo app.",
            workspace.name,
            tasks.len()
        ),
        workspace,
    })
}

pub fn create_workspace(
    storage: &StorageState,
    request: CreateWorkspace,
) -> CommandResult<Workspace> {
    let new = types::NewWorkspace {
        name: request.name,
        description: request.description,
        repository: request.repository,
    };
    Ok((&workspaces::create(storage, new.try_into()?)?).into())
}

pub fn update_workspace(
    storage: &StorageState,
    request: UpdateWorkspace,
) -> CommandResult<Workspace> {
    let current = Workspace::from(
        &lock(storage)
            .get_workspace(request.id.into())?
            .ok_or(StorageError::WorkspaceNotFound(request.id.into()))?,
    );
    let workspace = Workspace {
        name: request.name.unwrap_or(current.name),
        description: request.description.unwrap_or(current.description),
        repository: request.repository.unwrap_or(current.repository),
        ..current
    };
    Ok((&workspaces::update(storage, workspace)?).into())
}

/// A workspace as get_guidelines names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidelineWorkspace {
    pub id: WorkspaceId,
    pub name: String,
}

/// The reply of get_guidelines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGuidelines {
    pub workspace: GuidelineWorkspace,
    /// Rules first, then memories, each in the order they were added.
    pub guidelines: Vec<types::Guideline>,
}

pub(super) fn live_workspace(
    storage: &Storage,
    id: WorkspaceId,
) -> CommandResult<model::Workspace> {
    storage.get_workspace(id.into())?.ok_or_else(|| {
        CommandError::new(
            CommandErrorCode::WorkspaceNotFound,
            format!(
                "workspace {} does not exist or is archived; take a workspace id from list_workspaces, or the workspaceId of a task from get_task",
                id.0
            ),
        )
    })
}

fn stored_guideline(storage: &Storage, id: types::GuidelineId) -> CommandResult<model::Guideline> {
    storage.get_guideline(id.into())?.ok_or_else(|| {
        CommandError::new(
            CommandErrorCode::GuidelineNotFound,
            format!(
                "guideline {} does not exist; call get_guidelines with the workspace_id of your task and take the guideline id from its result",
                id.0
            ),
        )
    })
}

/// The guidelines of a task's workspace; none once the workspace is archived.
pub(super) fn task_guidelines(
    storage: &Storage,
    workspace: WorkspaceId,
) -> CommandResult<Vec<types::Guideline>> {
    match storage.list_guidelines(workspace.into()) {
        Ok(guidelines) => Ok(types::map_all(&guidelines)),
        Err(StorageError::WorkspaceNotFound(_)) => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

pub fn get_guidelines(
    storage: &Storage,
    request: GetGuidelines,
) -> CommandResult<WorkspaceGuidelines> {
    let workspace = live_workspace(storage, request.workspace_id)?;
    Ok(WorkspaceGuidelines {
        guidelines: types::map_all(&storage.list_guidelines(workspace.id)?),
        workspace: GuidelineWorkspace {
            id: workspace.id.into(),
            name: workspace.name,
        },
    })
}

pub fn add_guideline(
    storage: &StorageState,
    request: AddGuideline,
) -> CommandResult<types::Guideline> {
    live_workspace(&lock(storage), request.workspace_id)?;
    let new = types::NewGuideline {
        workspace_id: request.workspace_id,
        kind: request.kind.unwrap_or(types::GuidelineKind::Memory),
        body: request.body,
    };
    Ok((&guidelines::add(storage, new.try_into()?)?).into())
}

/// Changes the supplied kind and body of a guideline, keeping omitted values.
pub fn update_guideline(
    storage: &StorageState,
    request: UpdateGuideline,
) -> CommandResult<types::Guideline> {
    let current = stored_guideline(&lock(storage), request.id)?;
    let update = types::GuidelineUpdate {
        id: request.id,
        kind: request.kind.unwrap_or(current.kind.into()),
        body: request.body.unwrap_or(current.body),
    };
    Ok((&guidelines::update(storage, update)?).into())
}

pub fn remove_guideline(
    storage: &StorageState,
    request: RemoveGuideline,
) -> CommandResult<types::Guideline> {
    stored_guideline(&lock(storage), request.id)?;
    Ok((&guidelines::delete(storage, request.id.into())?).into())
}
