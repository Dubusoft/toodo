//! Task and workspace changes announced to connected clients.

use super::types::WorkspaceId;
use crate::domain::model;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TasksChanged {
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorkspacesChanged;

pub mod names {
    pub const TASKS_CHANGED: &str = "tasks-changed";
    pub const WORKSPACES_CHANGED: &str = "workspaces-changed";
}

pub trait Notifier {
    fn tasks_changed(&self, workspace: model::WorkspaceId);
    fn workspaces_changed(&self);
}
