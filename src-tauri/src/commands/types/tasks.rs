use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::{
    Criterion, CriterionInput, Estimate, TaskId, Timestamp, WorkspaceId, due_date, estimate,
    map_all, required,
};
use crate::commands::{CommandError, CommandResult};
use crate::domain::{criteria, model, review, status, timeline};
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

/// The most tasks one page of a task list holds, and the most task IDs a list may ask for.
pub const MAX_TASK_PAGE: u32 = 500;

/// Which tasks `list_tasks` returns; every condition given must hold. Without a limit,
/// every matching task.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskListFilter {
    /// Only tasks of this workspace.
    #[serde(default)]
    pub workspace_id: Option<WorkspaceId>,
    /// Only tasks with one of these statuses; omitted or empty for any status.
    #[serde(default)]
    pub statuses: Option<Vec<TaskStatus>>,
    /// Only these tasks, at most 500.
    #[serde(default)]
    pub ids: Option<Vec<TaskId>>,
    /// Only tasks with a lower ID: the lowest ID of the previous page, to read the next.
    #[serde(default)]
    pub before: Option<TaskId>,
    /// At most this many tasks (1 to 500), those with the highest IDs; a full page means
    /// older ones may follow.
    #[serde(default)]
    pub limit: Option<u32>,
}

impl TryFrom<TaskListFilter> for storage::TaskQuery {
    type Error = CommandError;

    fn try_from(filter: TaskListFilter) -> CommandResult<Self> {
        if let Some(limit) = filter.limit {
            task_page_limit(limit)?;
        }
        if filter
            .ids
            .as_ref()
            .is_some_and(|ids| ids.len() > MAX_TASK_PAGE as usize)
        {
            return Err(CommandError::invalid_input(format!(
                "ids lists more than {MAX_TASK_PAGE} tasks; split them into lists of at most \
                 {MAX_TASK_PAGE} IDs and list each"
            )));
        }
        Ok(Self {
            workspace: filter.workspace_id.map(Into::into),
            statuses: filter
                .statuses
                .unwrap_or_default()
                .into_iter()
                .map(Into::into)
                .collect(),
            ids: filter
                .ids
                .map(|ids| ids.into_iter().map(Into::into).collect()),
            before: filter.before.map(Into::into),
            limit: filter.limit,
        })
    }
}

/// Checks that `limit` is a page size a task list accepts.
pub(crate) fn task_page_limit(limit: u32) -> CommandResult<()> {
    if (1..=MAX_TASK_PAGE).contains(&limit) {
        Ok(())
    } else {
        Err(CommandError::invalid_input(format!(
            "limit {limit} is out of range; pass a limit from 1 to {MAX_TASK_PAGE}, and pass \
             the lowest task ID of a full page as before to read the next page"
        )))
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
    /// The GitHub issue this task works on; its pull request closes it on merge.
    pub issue: Option<LinkedIssue>,
    /// The expected size of the task, if estimated.
    pub estimate: Option<Estimate>,
    /// The day the task should be done by, as `YYYY-MM-DD` in local time.
    pub due_date: Option<String>,
    /// Labels such as a project or goal, sorted.
    pub labels: Vec<String>,
    /// References to where the work is tracked or discussed, in the order they were added,
    /// e.g. `lane:search-api`, `discord:<thread>`, `pr:<number>`, or a URL. Toodo does not
    /// interpret them.
    pub refs: Vec<String>,
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
    /// The wait the task is paused for: it is `planned` until `until`, then returns to
    /// the status it had when the wait began. `None` when it does not wait.
    pub wait: Option<TaskWait>,
}

/// A wait on a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskWait {
    /// When the wait ends, in seconds since the Unix epoch.
    pub until: Timestamp,
    /// The status the task returns to then: `planned`, `in_progress`, or `in_review`.
    pub status: TaskStatus,
}

impl From<model::TaskWait> for TaskWait {
    fn from(wait: model::TaskWait) -> Self {
        Self {
            until: Timestamp(wait.until),
            status: wait.status.into(),
        }
    }
}

/// What a note left on a task records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    /// Progress made.
    Progress,
    /// Something that stops the work until someone acts on it.
    Blocker,
    /// A decision taken, and why.
    Decision,
}

impl From<model::NoteKind> for NoteKind {
    fn from(kind: model::NoteKind) -> Self {
        match kind {
            model::NoteKind::Progress => Self::Progress,
            model::NoteKind::Blocker => Self::Blocker,
            model::NoteKind::Decision => Self::Decision,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub status: TaskStatus,
    pub at: Timestamp,
    /// The change reopened the task: it follows a move to `done`.
    pub reopened: bool,
    /// Why the change happened: on a move back to `planned`, the reason of a pause, the
    /// prerequisites the task waits on, or why it was reopened; on a start or completion,
    /// the reason or note given with it; `null` when none was recorded.
    pub reason: Option<String>,
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
            issue: task.issue.as_ref().map(LinkedIssue::from),
            estimate: task.estimate.map(Estimate::from),
            due_date: task.due_date.map(|due| due.to_string()),
            labels: task.labels.clone(),
            refs: task.refs.clone(),
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
                    reason: event.reason.clone(),
                })
                .collect(),
            milestones: timeline::milestones(&task.timeline).into(),
            notes: map_all(&task.notes),
            criteria: map_all(&task.criteria),
            wait: task.wait.map(TaskWait::from),
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
    pub pull_request: Option<PullRequestSnapshot>,
    pub task: Task,
    pub outcome: ReviewOutcome,
    /// Time of the outcome: the milestone, or the latest commit for `worked_on`.
    pub at: Timestamp,
    /// Commits of the task made in the period, oldest first.
    pub commits: Vec<CommitRecord>,
    /// Whether the task or its workspace was deleted, which archives it; its work still
    /// counts.
    pub archived: bool,
}

/// What deleting moved to the archive: workspaces, archived with their tasks, and tasks of
/// live workspaces, each ordered by ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    pub workspaces: Vec<super::Workspace>,
    pub tasks: Vec<Task>,
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
    /// Labels such as a project or goal; none when omitted.
    #[serde(default)]
    pub labels: Vec<String>,
    /// Completion criteria in order; an `id` is not allowed here.
    pub criteria: Vec<CriterionInput>,
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

/// The editable task fields. Lifecycle commands handle status changes other than review.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskEdit {
    /// Only in_review is set here; other transitions use lifecycle commands.
    pub status: Option<TaskStatus>,
    pub id: TaskId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    /// `null` clears the estimate.
    pub estimate: Option<Estimate>,
    /// `YYYY-MM-DD`; blank or `null` clears the due date.
    pub due_date: Option<String>,
    /// The new labels, which replace the current ones; `null` or omitted keeps them.
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// The new completion criteria in order, which replace the current ones; `null`
    /// keeps them. The criteria of a done task cannot change.
    pub criteria: Option<Vec<CriterionInput>>,
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
