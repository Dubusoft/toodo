use super::{Timestamp, WorkspaceId, required};
use crate::commands::{CommandError, CommandResult};
use crate::{domain::model, storage};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub description: Option<String>,
    pub repository: Option<String>,
    pub archived_at: Option<Timestamp>,
}
impl From<&model::Workspace> for Workspace {
    fn from(w: &model::Workspace) -> Self {
        Self {
            id: w.id.into(),
            name: w.name.clone(),
            description: w.description.clone(),
            repository: w.repository.clone(),
            archived_at: w.archived_at.map(Timestamp),
        }
    }
}
impl Workspace {
    pub(crate) fn into_model(self, stored: &model::Workspace) -> CommandResult<model::Workspace> {
        Ok(model::Workspace {
            id: self.id.into(),
            name: required("workspace name", self.name)?,
            description: self.description,
            repository: self.repository,
            archived_at: stored.archived_at,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewWorkspace {
    pub name: String,
    pub description: Option<String>,
    pub repository: Option<String>,
}
impl TryFrom<NewWorkspace> for storage::NewWorkspace {
    type Error = CommandError;
    fn try_from(w: NewWorkspace) -> CommandResult<Self> {
        Ok(Self {
            name: required("workspace name", w.name)?,
            description: w.description,
            repository: w.repository,
        })
    }
}
