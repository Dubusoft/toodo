use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::Timestamp;
use crate::commands::{CommandError, CommandResult};
use crate::domain::criteria;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(transparent)]
pub struct CriterionId(#[specta(type = Number)] pub i64);

impl From<CriterionId> for criteria::CriterionId {
    fn from(id: CriterionId) -> Self {
        Self(id.0)
    }
}

/// How a completion criterion is checked: by hand (`manual`) or by Toodo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    /// Checked by the user or an agent, with evidence.
    Manual,
    /// The task's pull request is merged into the workspace base branch.
    PrMerged,
    /// The task's pull request is open and all its checks passed.
    PrOpenCiGreen,
    /// The task branch is merged into the base branch in the repository itself, for
    /// workspaces without an `origin` remote.
    BranchMergedLocally,
    /// A GET of `target`, an http(s) URL, succeeds.
    Url,
    /// `target`, a shell command, exits with status 0 in the task worktree.
    Command,
}

impl From<CheckKind> for criteria::CheckKind {
    fn from(kind: CheckKind) -> Self {
        match kind {
            CheckKind::Manual => Self::Manual,
            CheckKind::PrMerged => Self::PullRequestMerged,
            CheckKind::PrOpenCiGreen => Self::PullRequestOpenChecksPassed,
            CheckKind::BranchMergedLocally => Self::BranchMergedLocally,
            CheckKind::Url => Self::Url,
            CheckKind::Command => Self::Command,
        }
    }
}

impl From<criteria::CheckKind> for CheckKind {
    fn from(kind: criteria::CheckKind) -> Self {
        match kind {
            criteria::CheckKind::Manual => Self::Manual,
            criteria::CheckKind::PullRequestMerged => Self::PrMerged,
            criteria::CheckKind::PullRequestOpenChecksPassed => Self::PrOpenCiGreen,
            criteria::CheckKind::BranchMergedLocally => Self::BranchMergedLocally,
            criteria::CheckKind::Url => Self::Url,
            criteria::CheckKind::Command => Self::Command,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CriterionState {
    Pending,
    Met,
    /// The last automatic check failed, e.g. a command exited with an error; Toodo checks
    /// it again.
    Failed,
}

impl From<criteria::CriterionState> for CriterionState {
    fn from(state: criteria::CriterionState) -> Self {
        match state {
            criteria::CriterionState::Pending => Self::Pending,
            criteria::CriterionState::Met => Self::Met,
            criteria::CriterionState::Failed => Self::Failed,
        }
    }
}

/// Who checked a criterion last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CheckedBy {
    User,
    Agent,
    Toodo,
}

impl From<criteria::CheckedBy> for CheckedBy {
    fn from(by: criteria::CheckedBy) -> Self {
        match by {
            criteria::CheckedBy::User => Self::User,
            criteria::CheckedBy::Agent => Self::Agent,
            criteria::CheckedBy::Toodo => Self::Toodo,
        }
    }
}

/// A completion criterion of a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub id: CriterionId,
    pub text: String,
    pub kind: CheckKind,
    /// The URL or command to check; for `branch_merged_locally`, the commit the branch
    /// started from once Toodo knows it.
    pub target: Option<String>,
    pub state: CriterionState,
    /// What showed the last check's result, or why it failed.
    pub evidence: Option<String>,
    pub checked_by: Option<CheckedBy>,
    pub checked_at: Option<Timestamp>,
}

impl From<&criteria::Criterion> for Criterion {
    fn from(criterion: &criteria::Criterion) -> Self {
        Self {
            id: CriterionId(criterion.id.0),
            text: criterion.text.clone(),
            kind: criterion.kind.into(),
            target: criterion.target.clone(),
            state: criterion.state.into(),
            evidence: criterion.evidence.clone(),
            checked_by: criterion.checked_by.map(CheckedBy::from),
            checked_at: criterion.checked_at.map(Timestamp),
        }
    }
}

/// A completion criterion given when creating or editing a task: an existing one by `id`
/// (only when editing), or a new one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CriterionInput {
    /// An existing criterion of the task, which keeps its state unless its kind or
    /// target changes; omit it for a new criterion. `{"id": N}` alone keeps criterion N
    /// as it is.
    #[serde(default)]
    pub id: Option<CriterionId>,
    /// What has to hold, in words, e.g. `The server answers /health`. Required for a new
    /// criterion; the stored text when omitted with `id`.
    #[serde(default)]
    pub text: Option<String>,
    /// Required for a new criterion; the stored kind when omitted with `id`.
    #[serde(default)]
    pub kind: Option<CheckKind>,
    /// The http(s) URL of a `url` criterion or the shell command of a `command`
    /// criterion; omit it for other kinds. With `id`, the stored target when omitted and
    /// the kind stays the same.
    #[serde(default)]
    pub target: Option<String>,
}

impl CriterionInput {
    /// Keeps the existing criterion `id` as it is.
    pub fn keep(id: CriterionId) -> Self {
        Self {
            id: Some(id),
            text: None,
            kind: None,
            target: None,
        }
    }

    /// A new criterion, which needs its text and kind.
    pub fn parse(&self) -> CommandResult<criteria::NewCriterion> {
        let (Some(text), Some(kind)) = (&self.text, self.kind) else {
            return Err(CommandError::invalid_input(
                "a new criterion needs text and kind, e.g. {\"text\": \"Docs updated\", \"kind\": \"manual\"}; give an existing one by its id instead",
            ));
        };
        criteria::NewCriterion::parse(text, kind.into(), self.target.as_deref())
            .map_err(|error| CommandError::invalid_input(error.to_string()))
    }

    /// The criterion an edit of `known` asks for: omitted fields keep the stored values,
    /// and the stored target stays only while the kind does.
    pub fn parse_over(&self, known: &criteria::Criterion) -> CommandResult<criteria::NewCriterion> {
        let kind = self.kind.map_or(known.kind, Into::into);
        let text = self.text.as_deref().unwrap_or(&known.text);
        let target = match &self.target {
            Some(target) => Some(target.as_str()),
            None if kind == known.kind && kind.takes_target() => known.target.as_deref(),
            None => None,
        };
        criteria::NewCriterion::parse(text, kind, target)
            .map_err(|error| CommandError::invalid_input(error.to_string()))
    }
}
