//! Core domain types: workspaces, tasks, and commit records.

use std::collections::BTreeSet;
use std::fmt;

use super::criteria::Criterion;
use super::plan::{DueDate, Estimate};
use super::status::TaskStatus;
use super::timeline::TaskEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WorkspaceId(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TaskId(pub i64);

impl fmt::Display for TaskId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub description: Option<String>,
    pub repository: Option<String>,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GuidelineId(pub i64);

impl fmt::Display for GuidelineId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// What a workspace guideline records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GuidelineKind {
    /// A rule the workspace's owner sets, which agents working on its tasks follow.
    Rule,
    /// A durable lesson or fact recorded for the workspace, often by an agent.
    Memory,
}

impl GuidelineKind {
    pub const ALL: [Self; 2] = [Self::Rule, Self::Memory];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rule => "rule",
            Self::Memory => "memory",
        }
    }
}

/// A guideline of a workspace, read before working on one of its tasks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guideline {
    pub id: GuidelineId,
    pub workspace_id: WorkspaceId,
    pub kind: GuidelineKind,
    /// Non-empty Markdown.
    pub body: String,
    /// Seconds since the Unix epoch.
    pub created_at: i64,
    pub updated_at: i64,
}

/// Fixed set of task types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskType {
    Feat,
    Fix,
    Modify,
    Refactor,
    Docs,
    Test,
    Chore,
    /// Research and development: work whose conclusion may be not to adopt it.
    Rnd,
}

impl TaskType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feat => "feat",
            Self::Fix => "fix",
            Self::Modify => "modify",
            Self::Refactor => "refactor",
            Self::Docs => "docs",
            Self::Test => "test",
            Self::Chore => "chore",
            Self::Rnd => "rnd",
        }
    }
}

impl fmt::Display for TaskType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How a `done` task ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskResolution {
    /// Its pull request was merged into the base branch.
    Merged,
    /// Its completion criteria were met without a pull request or a merge.
    Completed,
    /// The work was concluded without merging, e.g. research whose result was not
    /// adopted. Its completion note says why; dependents stay blocked.
    NotAdopted,
}

impl TaskResolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::Completed => "completed",
            Self::NotAdopted => "not_adopted",
        }
    }
}

/// What a note left on a task records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NoteKind {
    /// Progress made while working on the task.
    Progress,
    /// Something that stops the work until someone acts on it.
    Blocker,
    /// A decision taken while working on the task, and why.
    Decision,
}

impl NoteKind {
    pub const ALL: [Self; 3] = [Self::Progress, Self::Blocker, Self::Decision];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Progress => "progress",
            Self::Blocker => "blocker",
            Self::Decision => "decision",
        }
    }
}

/// A note an agent left on a task while working on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskNote {
    pub kind: NoteKind,
    /// Non-empty Markdown.
    pub body: String,
    /// Time the note was left, in seconds since the Unix epoch.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: TaskId,
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    /// How the task ended; `Some` exactly when it is `done`.
    pub resolution: Option<TaskResolution>,
    pub depends_on: BTreeSet<TaskId>,
    /// The GitHub issue of the workspace repository this task works on; its pull request
    /// closes it on merge.
    pub issue: Option<LinkedIssue>,
    /// The expected size of the task, if the user or an agent estimated it.
    pub estimate: Option<Estimate>,
    /// The day the task should be done by, if it has one.
    pub due_date: Option<DueDate>,
    /// Labels such as a project or goal, sorted and unique (see
    /// [`crate::domain::plan::labels`]).
    pub labels: Vec<String>,
    /// References to where the work is tracked or discussed, e.g. `lane:search-api`,
    /// `discord:<thread>`, `pr:<number>`, or a URL, in the order they were added (see
    /// [`crate::domain::plan::merge_refs`]).
    pub refs: Vec<String>,
    /// What the user wrote about the outcome of a `done` task, for later reviews.
    pub completion_note: Option<String>,
    /// Status history, oldest event first.
    pub timeline: Vec<TaskEvent>,
    /// Notes left on the task, oldest first.
    pub notes: Vec<TaskNote>,
    /// What has to hold for the task to be done, in the order its author gave.
    pub criteria: Vec<Criterion>,
}

/// A GitHub issue linked to a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedIssue {
    pub number: i64,
    pub url: String,
}

/// A merged pull request as GitHub reported it when it completed its task, kept so
/// reviews do not depend on GitHub later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestSnapshot {
    pub number: i64,
    pub title: String,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    /// The commit the merge put on the base branch; with a squash merge the branch
    /// commits never reach it.
    pub merge_commit_sha: Option<String>,
    /// Submitted reviews by anyone but the author of the pull request.
    pub review_count: i64,
    /// Distinct reviewers other than the author of the pull request.
    pub reviewer_count: i64,
    /// Submission time of the first of those reviews, in seconds since the Unix epoch.
    pub first_reviewed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRecord {
    pub task_id: TaskId,
    pub sha: String,
    pub message: String,
    pub author: String,
    /// Commit timestamp in seconds since the Unix epoch.
    pub committed_at: i64,
}
