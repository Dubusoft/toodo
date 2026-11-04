use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::{
    Criterion, CriterionInput, Estimate, TaskId, Timestamp, WorkspaceId, due_date, estimate,
    map_all, required,
};
use crate::commands::{CommandError, CommandResult};
use crate::domain::{activity, criteria, model, review, status, timeline};
use crate::storage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Feat,
    Fix,
    Modify,
    Refactor,
    Docs,
    Test,
    Chore,
    Rnd,
}

impl From<model::TaskType> for TaskType {
    fn from(task_type: model::TaskType) -> Self {
        match task_type {
            model::TaskType::Feat => Self::Feat,
            model::TaskType::Fix => Self::Fix,
            model::TaskType::Modify => Self::Modify,
            model::TaskType::Refactor => Self::Refactor,
            model::TaskType::Docs => Self::Docs,
            model::TaskType::Test => Self::Test,
            model::TaskType::Chore => Self::Chore,
            model::TaskType::Rnd => Self::Rnd,
        }
    }
}

impl From<TaskType> for model::TaskType {
    fn from(task_type: TaskType) -> Self {
        match task_type {
            TaskType::Feat => Self::Feat,
            TaskType::Fix => Self::Fix,
            TaskType::Modify => Self::Modify,
            TaskType::Refactor => Self::Refactor,
            TaskType::Docs => Self::Docs,
            TaskType::Test => Self::Test,
            TaskType::Chore => Self::Chore,
            TaskType::Rnd => Self::Rnd,
        }
    }
}

/// How a `done` task ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskResolution {
    /// Its pull request was merged.
    Merged,
    /// Its criteria were met without a pull request or a merge.
    Completed,
    /// Concluded without merging; the completion note says why. Dependents stay
    /// waiting.
    NotAdopted,
}

impl From<TaskResolution> for model::TaskResolution {
    fn from(resolution: TaskResolution) -> Self {
        match resolution {
            TaskResolution::Merged => Self::Merged,
            TaskResolution::Completed => Self::Completed,
            TaskResolution::NotAdopted => Self::NotAdopted,
        }
    }
}

impl From<model::TaskResolution> for TaskResolution {
    fn from(resolution: model::TaskResolution) -> Self {
        match resolution {
            model::TaskResolution::Merged => Self::Merged,
            model::TaskResolution::Completed => Self::Completed,
            model::TaskResolution::NotAdopted => Self::NotAdopted,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Planned,
    InProgress,
    InReview,
    Done,
}

impl From<status::TaskStatus> for TaskStatus {
    fn from(status: status::TaskStatus) -> Self {
        match status {
            status::TaskStatus::Planned => Self::Planned,
            status::TaskStatus::InProgress => Self::InProgress,
            status::TaskStatus::InReview => Self::InReview,
            status::TaskStatus::Done => Self::Done,
        }
    }
}

impl From<TaskStatus> for status::TaskStatus {
    fn from(status: TaskStatus) -> Self {
        match status {
            TaskStatus::Planned => Self::Planned,
            TaskStatus::InProgress => Self::InProgress,
            TaskStatus::InReview => Self::InReview,
            TaskStatus::Done => Self::Done,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: TaskId,
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    /// How the task ended; set exactly when it is `done`.
    pub resolution: Option<TaskResolution>,
    /// Tasks this task depends on, in ascending ID order.
    pub depends_on: Vec<TaskId>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// An active task has a branch but no checkout; restore it in the Toodo app.
    pub worktree_missing: bool,
    pub herdr_workspace_id: Option<String>,
    pub pull_request_url: Option<String>,
    /// The GitHub issue this task works on; its pull request closes it on merge.
    pub issue: Option<LinkedIssue>,
    /// The expected size of the task, if estimated.
    pub estimate: Option<Estimate>,
    /// The day the task should be done by, as `YYYY-MM-DD` in local time.
    pub due_date: Option<String>,
    /// Merge time of the pull request reported by GitHub.
    pub pull_request_merged_at: Option<Timestamp>,
    /// The pull request as GitHub reported it when its merge completed the task; `null`
    /// for tasks completed before Toodo recorded it.
    pub pull_request: Option<PullRequestSnapshot>,
    /// The merged pull request of another task that shipped this task's work, for a task
    /// `done` as merged without a pull request of its own.
    pub merged_with: Option<MergedWith>,
    /// What the user wrote about the outcome of a `done` task; for a `not_adopted` one,
    /// why it was not adopted.
    pub completion_note: Option<String>,
    /// Status history, oldest event first. Empty for tasks created before Toodo
    /// recorded it.
    pub timeline: Vec<TaskEvent>,
    pub milestones: TaskMilestones,
    /// Notes agents left on the task through the MCP server, oldest first.
    pub notes: Vec<TaskNote>,
    /// What has to hold for the task to be done, in order.
    pub criteria: Vec<Criterion>,
}

/// The merged pull request or the other task that shipped the work of a task; at least
/// one of the two is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergedWith {
    /// The task that shipped the work; `null` once that task is deleted or for a pull
    /// request no task records.
    pub task_id: Option<TaskId>,
    /// The merged pull request; `null` when the task that shipped the work has no
    /// recorded pull request.
    pub pull_request_url: Option<String>,
}

/// What a note left on a task records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    /// Progress made or a decision taken.
    Progress,
    /// Something that stops the work until someone acts on it.
    Blocker,
}

impl From<model::NoteKind> for NoteKind {
    fn from(kind: model::NoteKind) -> Self {
        match kind {
            model::NoteKind::Progress => Self::Progress,
            model::NoteKind::Blocker => Self::Blocker,
        }
    }
}

/// A note an agent left on a task while working on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskNote {
    pub kind: NoteKind,
    /// Markdown.
    pub body: String,
    pub at: Timestamp,
}

impl From<&model::TaskNote> for TaskNote {
    fn from(note: &model::TaskNote) -> Self {
        Self {
            kind: note.kind.into(),
            body: note.body.clone(),
            at: Timestamp(note.at),
        }
    }
}

/// A GitHub issue of the workspace repository linked to a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkedIssue {
    #[specta(type = Number)]
    pub number: i64,
    pub url: String,
}

impl From<&model::LinkedIssue> for LinkedIssue {
    fn from(issue: &model::LinkedIssue) -> Self {
        Self {
            number: issue.number,
            url: issue.url.clone(),
        }
    }
}

/// A merged pull request as GitHub reported it when it completed its task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSnapshot {
    #[specta(type = Number)]
    pub number: i64,
    pub title: String,
    #[specta(type = Number)]
    pub additions: i64,
    #[specta(type = Number)]
    pub deletions: i64,
    #[specta(type = Number)]
    pub changed_files: i64,
    /// The commit the merge put on the base branch.
    pub merge_commit_sha: Option<String>,
    /// Submitted reviews by anyone but the author of the pull request.
    #[specta(type = Number)]
    pub review_count: i64,
    /// Distinct reviewers other than the author of the pull request.
    #[specta(type = Number)]
    pub reviewer_count: i64,
    pub first_reviewed_at: Option<Timestamp>,
}

impl From<&model::PullRequestSnapshot> for PullRequestSnapshot {
    fn from(snapshot: &model::PullRequestSnapshot) -> Self {
        Self {
            number: snapshot.number,
            title: snapshot.title.clone(),
            additions: snapshot.additions,
            deletions: snapshot.deletions,
            changed_files: snapshot.changed_files,
            merge_commit_sha: snapshot.merge_commit_sha.clone(),
            review_count: snapshot.review_count,
            reviewer_count: snapshot.reviewer_count,
            first_reviewed_at: snapshot.first_reviewed_at.map(Timestamp),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub status: TaskStatus,
    pub at: Timestamp,
    /// The change reopened the task: it follows a move to `done`.
    pub reopened: bool,
}

/// Milestones derived from a task's status history (see `docs/architecture.md`, Task
/// Timeline); `null` when not reached or not recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskMilestones {
    pub planned_at: Option<Timestamp>,
    pub started_at: Option<Timestamp>,
    pub review_at: Option<Timestamp>,
    /// The latest completion, unless the task was reopened after it.
    pub completed_at: Option<Timestamp>,
    /// The latest reopening of the task after it was done.
    pub reopened_at: Option<Timestamp>,
    /// The latest pause, unless the task was started again after it.
    pub paused_at: Option<Timestamp>,
    /// The latest move to `in_review`.
    pub last_review_at: Option<Timestamp>,
    /// Seconds spent in progress or in review up to the latest status change, pauses left
    /// out; the current period of an active task is not counted yet.
    #[specta(type = Number)]
    pub active_seconds: i64,
    /// How often the task was paused after work started.
    pub pause_count: u32,
}

impl From<timeline::Milestones> for TaskMilestones {
    fn from(milestones: timeline::Milestones) -> Self {
        Self {
            planned_at: milestones.planned_at.map(Timestamp),
            started_at: milestones.started_at.map(Timestamp),
            review_at: milestones.review_at.map(Timestamp),
            completed_at: milestones.completed_at.map(Timestamp),
            reopened_at: milestones.reopened_at.map(Timestamp),
            paused_at: milestones.paused_at.map(Timestamp),
            last_review_at: milestones.last_review_at.map(Timestamp),
            active_seconds: milestones.active_seconds,
            pause_count: milestones.pause_count,
        }
    }
}

impl From<&model::Task> for Task {
    fn from(task: &model::Task) -> Self {
        Self {
            id: task.id.into(),
            workspace_id: task.workspace_id.into(),
            task_type: task.task_type.into(),
            title: task.title.clone(),
            description: task.description.clone(),
            status: task.status.into(),
            resolution: task.resolution.map(TaskResolution::from),
            depends_on: task.depends_on.iter().copied().map(TaskId::from).collect(),
            branch: task.branch.clone(),
            worktree_path: task.worktree_path.as_ref().map(ToString::to_string),
            worktree_missing: task.branch.is_some()
                && task.worktree_path.is_none()
                && matches!(
                    task.status,
                    status::TaskStatus::InProgress | status::TaskStatus::InReview
                ),
            herdr_workspace_id: task.herdr_workspace_id.clone(),
            pull_request_url: task.pull_request_url.clone(),
            issue: task.issue.as_ref().map(LinkedIssue::from),
            estimate: task.estimate.map(Estimate::from),
            due_date: task.due_date.map(|due| due.to_string()),
            pull_request_merged_at: task.pull_request_merged_at.map(Timestamp),
            pull_request: task.pull_request.as_ref().map(PullRequestSnapshot::from),
            merged_with: task.merged_with.as_ref().map(|merged| MergedWith {
                task_id: merged.task_id.map(TaskId::from),
                pull_request_url: merged.pull_request_url.clone(),
            }),
            completion_note: task.completion_note.clone(),
            timeline: task
                .timeline
                .iter()
                .enumerate()
                .map(|(index, event)| TaskEvent {
                    status: event.status.into(),
                    at: Timestamp(event.at),
                    reopened: index > 0
                        && task.timeline[index - 1].status == status::TaskStatus::Done
                        && event.status != status::TaskStatus::Done,
                })
                .collect(),
            milestones: timeline::milestones(&task.timeline).into(),
            notes: map_all(&task.notes),
            criteria: map_all(&task.criteria),
        }
    }
}

/// What happened to a task during a reviewed period: the most advanced milestone it
/// reached in the period, or `worked_on` when it only got commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewOutcome {
    Completed,
    OpenedForReview,
    Started,
    WorkedOn,
    Planned,
}

impl From<review::Outcome> for ReviewOutcome {
    fn from(outcome: review::Outcome) -> Self {
        match outcome {
            review::Outcome::Completed => Self::Completed,
            review::Outcome::OpenedForReview => Self::OpenedForReview,
            review::Outcome::Started => Self::Started,
            review::Outcome::WorkedOn => Self::WorkedOn,
            review::Outcome::Planned => Self::Planned,
        }
    }
}

/// A task with activity in a reviewed period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEntry {
    pub task: Task,
    pub outcome: ReviewOutcome,
    /// Time of the outcome: the milestone, or the latest commit for `worked_on`.
    pub at: Timestamp,
    /// Commits of the task made in the period, oldest first.
    pub commits: Vec<CommitRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub estimate: Option<Estimate>,
    /// `YYYY-MM-DD`; blank or `null` for none.
    pub due_date: Option<String>,
    /// Completion criteria in order; an `id` is not allowed here.
    pub criteria: Vec<CriterionInput>,
    /// Whether to put the merge criterion first: the task's pull request is merged, or,
    /// in a repository without an `origin` remote, its branch is merged into the base
    /// branch locally. Ignored when `criteria` already has one of those.
    pub merge_criterion: bool,
}

impl TryFrom<NewTask> for storage::NewTask {
    type Error = CommandError;

    fn try_from(new: NewTask) -> CommandResult<Self> {
        Ok(Self {
            workspace_id: new.workspace_id.into(),
            task_type: new.task_type.into(),
            title: required("task title", new.title)?,
            description: new.description,
            estimate: estimate(new.estimate)?,
            due_date: due_date(new.due_date.as_deref())?,
            criteria: new_criteria(&new.criteria)?,
        })
    }
}

/// The criteria of a new task, which cannot refer to existing ones.
pub(super) fn new_criteria(
    inputs: &[CriterionInput],
) -> CommandResult<Vec<criteria::NewCriterion>> {
    inputs
        .iter()
        .map(|input| match input.id {
            Some(id) => Err(CommandError::invalid_input(format!(
                "criterion {} cannot be given by id when creating a task",
                id.0
            ))),
            None => input.parse(),
        })
        .collect()
}

/// The fields of a task the user edits directly. Status, dependencies, and the
/// worktree, herdr, and pull request fields have their own commands or workflow steps.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskEdit {
    pub id: TaskId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    /// `null` clears the estimate.
    pub estimate: Option<Estimate>,
    /// `YYYY-MM-DD`; blank or `null` clears the due date.
    pub due_date: Option<String>,
    /// The new completion criteria in order, which replace the current ones; `null`
    /// keeps them. The criteria of a done task cannot change.
    pub criteria: Option<Vec<CriterionInput>>,
    /// Whether to put the merge criterion of the task's repository first when the task
    /// is left without one (see [`NewTask::merge_criterion`]); false changes nothing.
    #[serde(default)]
    pub merge_criterion: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitRecord {
    pub task_id: TaskId,
    pub sha: String,
    pub message: String,
    pub author: String,
    /// Commit timestamp in seconds since the Unix epoch.
    #[specta(type = Number)]
    pub committed_at: i64,
}

impl From<&model::CommitRecord> for CommitRecord {
    fn from(record: &model::CommitRecord) -> Self {
        Self {
            task_id: record.task_id.into(),
            sha: record.sha.clone(),
            message: record.message.clone(),
            author: record.author.clone(),
            committed_at: record.committed_at,
        }
    }
}

/// What happened in the git history of a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ActivityKind {
    #[serde(rename = "commit")]
    Commit,
    #[serde(rename = "pr_opened")]
    PullRequestOpened,
    #[serde(rename = "checks_passed")]
    ChecksPassed,
    #[serde(rename = "checks_failed")]
    ChecksFailed,
    #[serde(rename = "pr_merged")]
    PullRequestMerged,
}

impl From<activity::ActivityKind> for ActivityKind {
    fn from(kind: activity::ActivityKind) -> Self {
        match kind {
            activity::ActivityKind::Commit => Self::Commit,
            activity::ActivityKind::PullRequestOpened => Self::PullRequestOpened,
            activity::ActivityKind::ChecksPassed => Self::ChecksPassed,
            activity::ActivityKind::ChecksFailed => Self::ChecksFailed,
            activity::ActivityKind::PullRequestMerged => Self::PullRequestMerged,
        }
    }
}

/// Where an activity event was first learned from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ActivitySource {
    #[serde(rename = "git_poll")]
    GitPoll,
    #[serde(rename = "github_poll")]
    GitHubPoll,
}

impl From<activity::ActivitySource> for ActivitySource {
    fn from(source: activity::ActivitySource) -> Self {
        match source {
            activity::ActivitySource::GitPoll => Self::GitPoll,
            activity::ActivitySource::GitHubPoll => Self::GitHubPoll,
        }
    }
}

/// One event of the git activity of a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivity {
    pub kind: ActivityKind,
    pub source: ActivitySource,
    /// The commit SHA of a commit or CI result, or the pull request URL.
    pub external_ref: String,
    pub title: String,
    pub author: Option<String>,
    /// When it happened, in seconds since the Unix epoch.
    #[specta(type = Number)]
    pub occurred_at: i64,
    /// When Toodo first stored it.
    #[specta(type = Number)]
    pub received_at: i64,
    /// The latest time any source reported it.
    #[specta(type = Number)]
    pub confirmed_at: i64,
}

impl From<&activity::RecordedActivity> for TaskActivity {
    fn from(recorded: &activity::RecordedActivity) -> Self {
        let event = &recorded.event;
        Self {
            kind: event.kind.into(),
            source: event.source.into(),
            external_ref: event.external_ref.clone(),
            title: event.title.clone(),
            author: event.author.clone(),
            occurred_at: event.occurred_at,
            received_at: recorded.received_at,
            confirmed_at: recorded.confirmed_at,
        }
    }
}
