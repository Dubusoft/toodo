use serde::{Deserialize, Serialize};
use specta::Type;

use super::{TaskId, Timestamp};
use crate::adapters::{github, herdr};
use crate::domain::model;
use crate::domain::runtime::AgentState;
use crate::storage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HerdrStatus {
    /// Whether the herdr server on this machine is running.
    pub running: bool,
    pub version: Option<String>,
}

impl From<&herdr::ServerStatus> for HerdrStatus {
    fn from(status: &herdr::ServerStatus) -> Self {
        Self {
            running: status.running,
            version: status.version.clone(),
        }
    }
}

/// What the agent working on a task in herdr is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
}

impl AgentStatus {
    /// `None` for panes without a recognized agent.
    pub fn from_herdr(status: herdr::AgentStatus) -> Option<Self> {
        match status {
            herdr::AgentStatus::Unknown => None,
            herdr::AgentStatus::Idle => Some(Self::Idle),
            herdr::AgentStatus::Done => Some(Self::Done),
            herdr::AgentStatus::Working => Some(Self::Working),
            herdr::AgentStatus::Blocked => Some(Self::Blocked),
        }
    }
}

impl From<AgentStatus> for AgentState {
    fn from(status: AgentStatus) -> Self {
        match status {
            AgentStatus::Idle => Self::Idle,
            AgentStatus::Working => Self::Working,
            AgentStatus::Blocked => Self::Blocked,
            AgentStatus::Done => Self::Done,
        }
    }
}

impl From<AgentState> for AgentStatus {
    fn from(state: AgentState) -> Self {
        match state {
            AgentState::Idle => Self::Idle,
            AgentState::Working => Self::Working,
            AgentState::Blocked => Self::Blocked,
            AgentState::Done => Self::Done,
        }
    }
}

/// A change of what the agent in a task's herdr workspace was doing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusTransition {
    /// What the agent did from `at` on; `null` once no agent was seen in the workspace,
    /// e.g. its pane closed or herdr stopped.
    pub status: Option<AgentStatus>,
    pub at: Timestamp,
}

impl From<&storage::AgentStatusTransition> for AgentStatusTransition {
    fn from(transition: &storage::AgentStatusTransition) -> Self {
        Self {
            status: transition.status.map(AgentStatus::from),
            at: Timestamp(transition.at),
        }
    }
}

/// A pane of a task's herdr workspace, for the pane view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskPane {
    pub pane_id: String,
    /// The agent herdr recognized in the pane, e.g. `claude`.
    pub agent: Option<String>,
    pub agent_status: Option<AgentStatus>,
    /// The pane's label, or else its terminal title.
    pub title: Option<String>,
}

impl From<&herdr::PaneAgent> for TaskPane {
    fn from(pane: &herdr::PaneAgent) -> Self {
        Self {
            pane_id: pane.pane_id.clone(),
            agent: pane.agent.clone(),
            agent_status: AgentStatus::from_herdr(pane.status),
            title: pane.title.clone(),
        }
    }
}

/// The agent status of a task whose herdr workspace has an agent, summarized over the
/// workspace's panes: blocked over working over done over idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgentStatus {
    pub task_id: TaskId,
    pub status: AgentStatus,
}

/// Combined result of the CI checks of a pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChecksStatus {
    Passing,
    Failing,
    Pending,
}

impl From<github::ChecksState> for ChecksStatus {
    fn from(state: github::ChecksState) -> Self {
        match state {
            github::ChecksState::Passing => Self::Passing,
            github::ChecksState::Failing => Self::Failing,
            github::ChecksState::Pending => Self::Pending,
        }
    }
}

/// Where the reviews of a pull request stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Approved,
    ChangesRequested,
    Pending,
}

impl From<github::ReviewState> for ReviewStatus {
    fn from(state: github::ReviewState) -> Self {
        match state {
            github::ReviewState::Approved => Self::Approved,
            github::ReviewState::ChangesRequested => Self::ChangesRequested,
            github::ReviewState::Pending => Self::Pending,
        }
    }
}

/// CI and review state of the open pull request of an `in_review` task, as of the last
/// background check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskPullRequestStatus {
    pub task_id: TaskId,
    /// `null` when the pull request has no checks.
    pub checks: Option<ChecksStatus>,
    pub review: ReviewStatus,
}

impl TaskPullRequestStatus {
    pub fn new(task: model::TaskId, status: github::PullRequestStatus) -> Self {
        Self {
            task_id: task.into(),
            checks: status.checks.map(Into::into),
            review: status.review.into(),
        }
    }
}
