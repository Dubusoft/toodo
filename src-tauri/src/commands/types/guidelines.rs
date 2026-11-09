use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::{Timestamp, WorkspaceId};
use crate::commands::{CommandError, CommandResult};
use crate::{domain::model, storage};

/// The most characters a guideline body may have, after trimming.
pub const GUIDELINE_BODY_LIMIT: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(transparent)]
pub struct GuidelineId(#[specta(type = Number)] pub i64);

impl From<GuidelineId> for model::GuidelineId {
    fn from(id: GuidelineId) -> Self {
        Self(id.0)
    }
}

impl From<model::GuidelineId> for GuidelineId {
    fn from(id: model::GuidelineId) -> Self {
        Self(id.0)
    }
}

/// What a workspace guideline records: a `rule` the owner sets for agents to follow, or
/// a `memory`, a durable lesson or fact recorded for the workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GuidelineKind {
    Rule,
    Memory,
}

impl From<GuidelineKind> for model::GuidelineKind {
    fn from(kind: GuidelineKind) -> Self {
        match kind {
            GuidelineKind::Rule => Self::Rule,
            GuidelineKind::Memory => Self::Memory,
        }
    }
}

impl From<model::GuidelineKind> for GuidelineKind {
    fn from(kind: model::GuidelineKind) -> Self {
        match kind {
            model::GuidelineKind::Rule => Self::Rule,
            model::GuidelineKind::Memory => Self::Memory,
        }
    }
}

/// A guideline of a workspace, read before working on one of its tasks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Guideline {
    pub id: GuidelineId,
    pub workspace_id: WorkspaceId,
    pub kind: GuidelineKind,
    /// Markdown.
    pub body: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl From<&model::Guideline> for Guideline {
    fn from(g: &model::Guideline) -> Self {
        Self {
            id: g.id.into(),
            workspace_id: g.workspace_id.into(),
            kind: g.kind.into(),
            body: g.body.clone(),
            created_at: Timestamp(g.created_at),
            updated_at: Timestamp(g.updated_at),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewGuideline {
    pub workspace_id: WorkspaceId,
    pub kind: GuidelineKind,
    /// Markdown, at most 4000 characters after trimming.
    pub body: String,
}

impl TryFrom<NewGuideline> for storage::NewGuideline {
    type Error = CommandError;
    fn try_from(g: NewGuideline) -> CommandResult<Self> {
        Ok(Self {
            workspace_id: g.workspace_id.into(),
            kind: g.kind.into(),
            body: guideline_body(&g.body)?,
        })
    }
}

/// The new kind and body of a stored guideline.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuidelineUpdate {
    pub id: GuidelineId,
    pub kind: GuidelineKind,
    /// Markdown, at most 4000 characters after trimming.
    pub body: String,
}

/// A guideline body, trimmed: non-empty and at most [`GUIDELINE_BODY_LIMIT`] characters.
pub(crate) fn guideline_body(body: &str) -> CommandResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(CommandError::invalid_input(
            "guideline body must not be empty; send the rule or memory as Markdown text in body",
        ));
    }
    let length = body.chars().count();
    if length > GUIDELINE_BODY_LIMIT {
        return Err(CommandError::invalid_input(format!(
            "guideline body has {length} characters, more than the limit of \
             {GUIDELINE_BODY_LIMIT}; shorten it, or split it into several guidelines and add \
             each with its own add_guideline call"
        )));
    }
    Ok(body.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guideline_bodies_are_trimmed_and_limited() {
        assert_eq!(
            guideline_body("  Write English \n").unwrap(),
            "Write English"
        );
        assert!(
            guideline_body(" \n ")
                .unwrap_err()
                .message
                .contains("in body")
        );
        let longest = "é".repeat(GUIDELINE_BODY_LIMIT);
        assert_eq!(guideline_body(&longest).unwrap(), longest);
        let error = guideline_body(&format!("{longest}x")).unwrap_err();
        assert_eq!(error.code, crate::commands::CommandErrorCode::InvalidInput);
        assert!(error.message.contains("add_guideline"), "{error:?}");
    }

    #[test]
    fn guidelines_use_camel_case_keys_and_snake_case_kinds() {
        let new: NewGuideline = serde_json::from_value(
            serde_json::json!({ "workspaceId": 3, "kind": "memory", "body": " Lesson " }),
        )
        .unwrap();
        let new = storage::NewGuideline::try_from(new).unwrap();
        assert_eq!(
            (new.workspace_id, new.kind, new.body.as_str()),
            (
                model::WorkspaceId(3),
                model::GuidelineKind::Memory,
                "Lesson"
            )
        );
        let stored = model::Guideline {
            id: model::GuidelineId(7),
            workspace_id: model::WorkspaceId(3),
            kind: model::GuidelineKind::Rule,
            body: "Rule".to_owned(),
            created_at: 1,
            updated_at: 2,
        };
        assert_eq!(
            serde_json::to_value(Guideline::from(&stored)).unwrap(),
            serde_json::json!({
                "id": 7, "workspaceId": 3, "kind": "rule", "body": "Rule",
                "createdAt": 1, "updatedAt": 2
            })
        );
    }
}
