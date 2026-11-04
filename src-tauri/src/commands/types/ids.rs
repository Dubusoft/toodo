use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use crate::domain::model;

// Database IDs and timestamps stay far below 2^53, so they are exported as `number`
// instead of the `bigint` specta requires for `i64` by default.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(transparent)]
pub struct WorkspaceId(#[specta(type = Number)] pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(transparent)]
pub struct TaskId(#[specta(type = Number)] pub i64);

/// A related link between two tasks, which may belong to different workspaces. The link
/// goes both ways; `task_id` is the lower ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskRelation {
    pub task_id: TaskId,
    pub related_id: TaskId,
}

/// What adding a prerequisite in the app did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DependencyOutcome {
    /// The dependency was added, pausing the task if it blocks it and the pause was
    /// confirmed.
    Added,
    /// The prerequisite would pause the task, which is in progress; nothing was added.
    /// Ask the user, then add it again with the pause confirmed.
    ConfirmPause,
}

/// Seconds since the Unix epoch (UTC).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Timestamp(#[specta(type = Number)] pub i64);

/// An OAuth app with an unrevoked grant and a live token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct OAuthGrantId(#[specta(type = Number)] pub i64);

/// A live app connection shown in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedApp {
    pub grant_id: OAuthGrantId,
    pub client_name: Option<String>,
    pub client_id: String,
    pub scopes: String,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedApps {
    pub public_mcp_url: Option<String>,
    pub apps: Vec<ConnectedApp>,
}

impl From<WorkspaceId> for model::WorkspaceId {
    fn from(id: WorkspaceId) -> Self {
        Self(id.0)
    }
}

impl From<model::WorkspaceId> for WorkspaceId {
    fn from(id: model::WorkspaceId) -> Self {
        Self(id.0)
    }
}

impl From<TaskId> for model::TaskId {
    fn from(id: TaskId) -> Self {
        Self(id.0)
    }
}

impl From<model::TaskId> for TaskId {
    fn from(id: model::TaskId) -> Self {
        Self(id.0)
    }
}
