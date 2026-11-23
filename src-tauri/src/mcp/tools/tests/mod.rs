use std::collections::BTreeSet;

use super::*;
use crate::commands::CommandErrorKind;
use crate::commands::types::{
    self, Estimate, Task, TaskId, TaskResolution, TaskStatus, TaskType, WorkspaceId,
};
use crate::commands::{CommandErrorCode, CommandResult, StorageState, lock};
use crate::domain::model::{self, NoteKind};
use crate::domain::status::TaskStatus as DomainStatus;
use crate::storage::{NewWorkspace, Storage, StorageError};

mod create;
mod dependencies;
mod edits;
mod lifecycle;
mod queries;
mod workspaces;

fn storage_with_workspace() -> (Storage, WorkspaceId) {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = storage
        .create_workspace(&NewWorkspace {
            name: "toodo".to_owned(),
            description: None,
            repository: None,
        })
        .unwrap();
    (storage, workspace.id.into())
}

fn create(
    storage: &mut Storage,
    workspace: WorkspaceId,
    title: &str,
    depends_on: Vec<TaskId>,
) -> CommandResult<Task> {
    insert_task(
        storage,
        CreateTask {
            refs: Vec::new(),
            workspace_id: workspace,
            task_type: TaskType::Feat,
            title: title.to_owned(),
            description: String::new(),
            depends_on,
            related: Vec::new(),
            estimate: None,
            due_date: None,
            autopilot: false,
            labels: Vec::new(),
            criteria: vec![types::CriterionInput {
                id: None,
                text: Some("Reviewed".to_owned()),
                kind: Some(types::CheckKind::Manual),
                target: None,
            }],

            request_id: None,
        },
    )
}

fn plan(tasks: serde_json::Value) -> CreatePlan {
    serde_json::from_value(serde_json::json!({ "tasks": tasks })).unwrap()
}

fn search(storage: &Storage, query: &str) -> CommandResult<Vec<SearchHit>> {
    search_tasks(
        storage,
        SearchTasks {
            query: query.to_owned(),
            workspace_id: None,
            status: None,
            limit: None,
        },
    )
}
