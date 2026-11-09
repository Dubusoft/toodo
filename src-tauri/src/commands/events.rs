//! Task and workspace changes announced to connected clients.

use super::types::{TaskId, TaskStatus, Timestamp, WorkspaceId};
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

/// The guidelines of a workspace were added, changed, or deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GuidelinesChanged {
    pub workspace_id: WorkspaceId,
}

/// The status of a task changed, through any surface: the web app or MCP. A newly created task reports `from: null` and `to: "planned"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusChanged {
    pub task_id: TaskId,
    pub workspace_id: WorkspaceId,
    pub from: Option<TaskStatus>,
    pub to: TaskStatus,
    /// When the change was recorded in the task's status history.
    pub at: Timestamp,
}

/// A planned task became ready: the last of its unfinished dependencies, `unblockedBy`,
/// moved to `done`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskReady {
    pub task_id: TaskId,
    pub workspace_id: WorkspaceId,
    pub unblocked_by: TaskId,
    /// When `unblockedBy` moved to `done`.
    pub at: Timestamp,
}

pub mod names {
    pub const TASKS_CHANGED: &str = "tasks-changed";
    pub const WORKSPACES_CHANGED: &str = "workspaces-changed";
    pub const GUIDELINES_CHANGED: &str = "guidelines-changed";
    pub const TASK_STATUS_CHANGED: &str = "task-status-changed";
    pub const TASK_READY: &str = "task-ready";
}

pub trait Notifier {
    fn tasks_changed(&self, workspace: model::WorkspaceId);
    fn workspaces_changed(&self);
    fn guidelines_changed(&self, workspace: model::WorkspaceId);
}
