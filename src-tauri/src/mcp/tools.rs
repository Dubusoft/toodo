//! What the MCP tools do, over the same storage as the Tauri commands, so agents follow
//! the rules the UI follows: the dependency DAG stays acyclic and readiness stays in sync.
//! Starting, completing, and concluding tasks run the app's own commands.

use std::collections::{BTreeSet, HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use crate::commands::completion::{self, ConcludeOutcome};
use crate::commands::tasks::{self as task_commands, edit_task};
use crate::commands::types::{
    self, CommitRecord, Estimate, Task, TaskEdit, TaskId, TaskResolution, TaskStatus, TaskType,
    Workspace, WorkspaceId,
};
use crate::commands::{CommandError, CommandErrorCode, CommandResult, State, StorageState, lock};
use crate::commands::{guidelines, workspaces};
use crate::domain::criteria::CheckedBy;
use crate::domain::model::{self, NoteKind};
use crate::storage::{self, Storage, StorageError, TaskSearch};

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ListTasks {
    /// Only tasks of this workspace; all workspaces when omitted.
    pub workspace_id: Option<WorkspaceId>,
    /// Only tasks with one of these statuses, e.g. `["planned", "in_progress"]`; every
    /// status when omitted or empty.
    #[serde(default)]
    pub status: Option<Vec<TaskStatus>>,
    /// `true`: only tasks start_task or resume_task can begin now; `false`: only the
    /// others. Every task when omitted.
    #[serde(default)]
    pub ready: Option<bool>,
    /// At most this many tasks (1 to 500): the matching tasks with the highest IDs, still
    /// listed by ascending ID. Every matching task when omitted.
    #[serde(default)]
    pub limit: Option<u32>,
    /// Only tasks with a lower ID. When a page has `limit` tasks, pass its first (lowest)
    /// ID here to read the older ones.
    #[serde(default)]
    pub before_id: Option<TaskId>,
    /// `true`: only tasks marked for autopilot; `false`: only the others. Every task when
    /// omitted.
    #[serde(default)]
    pub autopilot: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CreateWorkspace {
    pub name: String,
    pub description: Option<String>,
    pub repository: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct UpdateWorkspace {
    pub id: WorkspaceId,
    pub name: Option<String>,
    /// Unchanged when omitted; null clears it.
    #[serde(default, deserialize_with = "present")]
    #[schemars(with = "Option<String>")]
    pub description: Option<Option<String>>,
    /// Unchanged when omitted; null clears it.
    #[serde(default, deserialize_with = "present")]
    #[schemars(with = "Option<String>")]
    pub repository: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ArchiveWorkspace {
    /// The workspace to archive, as in list_workspaces.
    pub id: WorkspaceId,
    /// true archives the workspace. Without it nothing changes and the reply says what
    /// archiving would do; read it before you confirm.
    #[serde(default)]
    pub confirm: bool,
}

/// The reply of archive_workspace, which changes nothing until it is called again with
/// `confirm: true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfirmation {
    /// Whether the workspace was archived; false for a call without `confirm: true`.
    pub confirmed: bool,
    /// The workspace as it was before it was archived.
    pub workspace: Workspace,
    /// What archiving does, or did, and what to do next.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CurrentTask {
    /// A stored task reference, such as lane:search.
    #[serde(default)]
    pub r#ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CreateTask {
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    /// Details in GitHub-flavored Markdown.
    #[serde(default)]
    pub description: String,
    /// Tasks the new task depends on, from any workspace.
    #[serde(default)]
    pub depends_on: Vec<TaskId>,
    /// Tasks from any workspace to link as related (see add_related); they never block
    /// the new task.
    #[serde(default)]
    pub related: Vec<TaskId>,
    /// Your estimate of the work, in hours, days, weeks, or months of active work.
    #[serde(default)]
    pub estimate: Option<Estimate>,
    /// The day the task should be done by, as YYYY-MM-DD, if the user gave one.
    #[serde(default)]
    pub due_date: Option<String>,
    /// Labels such as a project or goal, e.g. ["search", "q4-goal"], that the user's
    /// reviews filter by; each non-empty, at most 40 characters, without commas.
    #[serde(default)]
    pub labels: Vec<String>,
    /// References to where the work is tracked or discussed, in order, e.g.
    /// ["lane:search-api", "discord:123/456", "https://example.com/spec"]: by convention
    /// `<kind>:<value>` or a URL, each on one line.
    #[serde(default)]
    pub refs: Vec<String>,
    /// true marks the task for autopilot: an executor may take it up on its own once it
    /// is ready. Set it only when the user asked for autopilot on this task; false when
    /// omitted.
    #[serde(default)]
    pub autopilot: bool,
    /// Verifiable completion criteria in order (no `id`). Use `manual` for what a person
    /// or you check with evidence, and `url` for an HTTP GET completion check.
    #[serde(default)]
    pub criteria: Vec<types::CriterionInput>,
    /// Ignored: agents started before the lead was removed may still send it, and other
    /// unknown arguments are rejected.
    #[serde(default)]
    #[schemars(skip)]
    pub request_id: Option<String>,
}

/// The most tasks one `create_plan` call creates.
const MAX_PLAN_TASKS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CreatePlan {
    /// The tasks to create, 1 to 100, in any order.
    pub tasks: Vec<PlanTask>,
}

/// One task of `create_plan`: the fields of `create_task`, plus a key that the other
/// tasks of the plan link to it by.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct PlanTask {
    /// A name for this task within the plan, e.g. "schema", unique among its tasks.
    pub key: String,
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    /// Details in GitHub-flavored Markdown.
    #[serde(default)]
    pub description: String,
    /// Existing tasks, from any workspace, this task depends on.
    #[serde(default)]
    pub depends_on: Vec<TaskId>,
    /// Keys of other tasks of this plan that this task depends on.
    #[serde(default)]
    pub depends_on_keys: Vec<String>,
    /// Existing tasks, from any workspace, to link as related (see add_related).
    #[serde(default)]
    pub related: Vec<TaskId>,
    /// Keys of other tasks of this plan to link as related.
    #[serde(default)]
    pub related_keys: Vec<String>,
    /// Your estimate of the work, in hours, days, weeks, or months of active work.
    #[serde(default)]
    pub estimate: Option<Estimate>,
    /// The day the task should be done by, as YYYY-MM-DD, if the user gave one.
    #[serde(default)]
    pub due_date: Option<String>,
    /// Labels, as in create_task.
    #[serde(default)]
    pub labels: Vec<String>,
    /// References, as in create_task.
    #[serde(default)]
    pub refs: Vec<String>,
    /// Marks the task for autopilot, as in create_task.
    #[serde(default)]
    pub autopilot: bool,
    /// Verifiable completion criteria in order (no `id`), as in create_task.
    #[serde(default)]
    pub criteria: Vec<types::CriterionInput>,
}

/// A task `create_plan` created, with the key the plan gave it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTask {
    pub key: String,
    #[serde(flatten)]
    pub task: Task,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPlan {
    /// The created tasks in the order of the plan.
    pub tasks: Vec<PlannedTask>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[schemars(transform = without_null_defaults)]
pub struct UpdateTask {
    pub id: TaskId,
    /// Unchanged when omitted.
    pub task_type: Option<TaskType>,
    pub status: Option<TaskStatus>,
    /// Unchanged when omitted.
    pub title: Option<String>,
    /// Details in GitHub-flavored Markdown; unchanged when omitted.
    pub description: Option<String>,
    /// Unchanged when omitted; null clears it.
    #[serde(default, deserialize_with = "present")]
    #[schemars(with = "Option<Estimate>")]
    pub estimate: Option<Option<Estimate>>,
    /// YYYY-MM-DD; unchanged when omitted, null clears it.
    #[serde(default, deserialize_with = "present")]
    #[schemars(with = "Option<String>")]
    pub due_date: Option<Option<String>>,
    /// The full new list of labels, replacing the current ones; unchanged when omitted,
    /// [] removes them all.
    pub labels: Option<Vec<String>>,
    /// References to append after the task's references, e.g. ["pr:123"]; one the task
    /// already has is not added again.
    pub refs: Option<Vec<String>>,
    /// References to remove from the task, given as they are listed in its refs; removed
    /// after `refs` is appended.
    pub remove_refs: Option<Vec<String>>,
    /// true marks the task for autopilot (only when the user asked for it), false clears
    /// the mark; unchanged when omitted. Marking a marked task keeps when it was marked.
    pub autopilot: Option<bool>,
    /// The full new list of completion criteria, replacing the current one; unchanged when
    /// omitted. Criteria whose `id` is left out are deleted with their evidence. Keep an
    /// existing criterion by passing `{"id": N}`; given fields change it, omitted ones
    /// keep their stored values, and it keeps its state unless its kind or target
    /// changes. New criteria (no `id`) need `text` and `kind`. A done task cannot change
    /// at all through MCP.
    pub criteria: Option<Vec<types::CriterionInput>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CheckCriterion {
    /// The task of the criterion; found from the criterion when omitted.
    #[serde(default)]
    pub task_id: Option<TaskId>,
    /// A manual criterion; Toodo checks the other kinds itself. `id` is accepted too.
    #[serde(alias = "id")]
    pub criterion_id: types::CriterionId,
    /// True to check it, false to uncheck it; true when omitted.
    #[serde(default)]
    pub met: Option<bool>,
    /// What shows the criterion holds: a link, a command and its output, or what you
    /// verified and how. Required to check it.
    #[serde(default)]
    pub evidence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AddCriterion {
    /// The task that gets the criterion; it must not be done.
    pub task_id: TaskId,
    /// What has to hold, in words, e.g. `The server answers /health`.
    pub text: String,
    pub kind: types::CheckKind,
    /// The http(s) URL of a `url` criterion or the shell command of a `command`
    /// criterion; omit it for other kinds.
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RemoveCriterion {
    /// The task of the criterion; found from the criterion when omitted.
    #[serde(default)]
    pub task_id: Option<TaskId>,
    /// The criterion to delete with its evidence. `id` is accepted too.
    #[serde(alias = "id")]
    pub criterion_id: types::CriterionId,
}

/// Drops the `"default": null` schemars derives from `#[serde(default)]` for the fields
/// of a patch: there an omitted field stays unchanged while an explicit `null` clears it,
/// so a client that fills in advertised defaults would clear what it meant to keep.
pub(super) fn without_null_defaults(schema: &mut schemars::Schema) {
    let Some(properties) = schema
        .get_mut("properties")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    for property in properties.values_mut() {
        if let Some(property) = property.as_object_mut()
            && property.get("default") == Some(&serde_json::Value::Null)
        {
            property.remove("default");
        }
    }
}

/// Tells a field given as `null` (`Some(None)`) from an omitted one (`None`, the default).
pub(super) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

/// One task ID or several, as `depends_on` of the dependency tools accepts them.
#[derive(Deserialize, JsonSchema)]
#[schemars(inline)]
#[serde(
    untagged,
    expecting = "a task id or an array of task ids, e.g. 3 or [3, 4]"
)]
enum TaskIds {
    One(TaskId),
    Many(Vec<TaskId>),
}

/// Reads [`TaskIds`] as a list.
fn one_or_many<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<TaskId>, D::Error> {
    Ok(match TaskIds::deserialize(deserializer)? {
        TaskIds::One(id) => vec![id],
        TaskIds::Many(ids) => ids,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AddDependencies {
    /// The dependent task.
    pub task_id: TaskId,
    /// Its prerequisites, from any workspace, which must all be done before `task_id` is
    /// ready: one task id or an array of them.
    #[serde(deserialize_with = "one_or_many")]
    #[schemars(with = "TaskIds")]
    pub depends_on: Vec<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct Dependency {
    /// The dependent task.
    pub task_id: TaskId,
    /// The prerequisites to remove: one task id or an array of them.
    #[serde(deserialize_with = "one_or_many")]
    #[schemars(with = "TaskIds")]
    pub depends_on: Vec<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AddNote {
    /// The task the note is about, usually your current task.
    pub task_id: TaskId,
    /// What happened, in GitHub-flavored Markdown.
    pub note: String,
}

/// What add_progress_note records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProgressNoteKind {
    /// Progress made, e.g. a finished step or the pull request opened.
    Progress,
    /// A decision taken, e.g. a design choice, and why.
    Decision,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AddProgressNote {
    /// The task the note is about, usually your current task.
    pub task_id: TaskId,
    /// What happened, in GitHub-flavored Markdown.
    pub note: String,
    /// progress when omitted, or decision for a decision and why it was taken.
    #[serde(default)]
    pub kind: Option<ProgressNoteKind>,
}

impl AddProgressNote {
    /// The kind of note and the note to add.
    pub fn into_note(self) -> (NoteKind, AddNote) {
        let request = self;
        let kind = match request.kind {
            None | Some(ProgressNoteKind::Progress) => NoteKind::Progress,
            Some(ProgressNoteKind::Decision) => NoteKind::Decision,
        };
        (
            kind,
            AddNote {
                task_id: request.task_id,
                note: request.note,
            },
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct PauseTask {
    /// The task, e.g. your current task.
    pub id: TaskId,
    /// Why the work stops, in GitHub-flavored Markdown; recorded as a progress note.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct WaitTask {
    /// A planned, in_progress, or in_review task.
    pub id: TaskId,
    /// When the wait ends: an RFC 3339 time with an offset, in the future, e.g.
    /// `2026-11-10T09:00:00+09:00` or `2026-11-10T00:00:00Z`.
    pub until: String,
    /// Why the task waits, in GitHub-flavored Markdown; recorded with the progress note.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct EndWait {
    /// The waiting task.
    pub id: TaskId,
    /// Why the wait ends early, in GitHub-flavored Markdown; recorded with the progress
    /// note.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ResumeTask {
    /// The paused task.
    pub id: TaskId,
    /// Why the work continues, in GitHub-flavored Markdown; recorded as a progress note.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DeleteTask {
    /// The planned or done task to delete, e.g. one you created by mistake or a done task
    /// whose record is no longer wanted.
    pub id: TaskId,
    /// true deletes the task. Without it nothing changes and the reply says what deleting
    /// would remove; read it before you confirm.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DeleteDoneTasks {
    /// The workspace whose done (completed or concluded) tasks to delete, as in
    /// list_workspaces.
    pub workspace_id: WorkspaceId,
    /// true deletes them. Without it nothing changes and the reply lists the tasks deleting
    /// would archive; read it before you confirm.
    #[serde(default)]
    pub confirm: bool,
}

/// The reply of delete_done_tasks, which changes nothing until it is called again with
/// `confirm: true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneTasksConfirmation {
    /// Whether the tasks were archived; false for a call without `confirm: true`.
    pub confirmed: bool,
    pub workspace_id: WorkspaceId,
    /// The done tasks that were archived, or that confirming would archive.
    pub task_ids: Vec<TaskId>,
    /// What the change does, or did, and what to do next.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ReopenTask {
    /// The done task to reopen, e.g. one completed or concluded by mistake.
    pub id: TaskId,
    /// Why the task is reopened, in GitHub-flavored Markdown; recorded as a progress note
    /// with the earlier outcome.
    pub reason: String,
    /// true reopens the task. Without it nothing changes and the reply says what reopening
    /// would do; read it before you confirm.
    #[serde(default)]
    pub confirm: bool,
}

/// The reply of a tool that changes nothing until it is called again with `confirm: true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    /// Whether the change was made; false for a call without `confirm: true`.
    pub confirmed: bool,
    /// The task as it is now, or as it was before it was deleted.
    pub task: Task,
    /// What the change does, or did, and what to do next.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct StartTask {
    /// The task. Never your own task, the one current_task finds.
    pub id: TaskId,
    /// Why the task is started now, e.g. who picked it up and for what; recorded with the
    /// start in its status history.
    #[serde(default)]
    pub reason: Option<String>,
    /// References to append to the task's refs, e.g. the lane or thread that works on it.
    #[serde(default)]
    pub refs: Vec<String>,
    /// Ignored: agents started before the lead was removed may still send it, and other
    /// unknown arguments are rejected.
    #[serde(default)]
    #[schemars(skip)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CompleteTask {
    /// The task. Never your own task, the one current_task finds.
    pub id: TaskId,
    /// What shipped and why the task is complete, recorded with the completion in its
    /// status history; required with without_pull_request, where it also becomes the
    /// completion note.
    pub note: Option<String>,
    /// References to append to the task's refs, e.g. ["pr:123"].
    #[serde(default)]
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct SearchTasks {
    /// Words to look for in any language, e.g. `deploy server`; short words such as
    /// two-character Korean ones work too. Every word must appear in the
    /// task's title, description, notes, completion note, branch, refs, or pull request, as a
    /// case-insensitive substring; words are taken literally, not as operators. Use a few
    /// distinctive words and search again with others to widen the search. A task number
    /// alone, e.g. `431` or `#431`, also finds that task first, in any workspace.
    pub query: String,
    /// Only tasks of this workspace; all workspaces when omitted. A task found by its
    /// number is returned whatever its workspace.
    pub workspace_id: Option<WorkspaceId>,
    /// Only tasks with this status; any status when omitted.
    pub status: Option<TaskStatus>,
    /// At most this many results, best match first: 20 when omitted, at most 100; 0
    /// returns none.
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ReviewReportRequest {
    /// week (seven days from a Monday, or from `from`), month, quarter, year, or custom
    /// (`from` to `to`).
    pub period: types::ReviewPeriodKind,
    /// A day inside the period as `YYYY-MM-DD`, for any period but custom; today when
    /// neither date nor from is given.
    pub date: Option<String>,
    /// The first day as `YYYY-MM-DD`: required for custom, any first day of a week.
    pub from: Option<String>,
    /// The last day of a custom period as `YYYY-MM-DD`, included.
    pub to: Option<String>,
    /// markdown when omitted, or csv.
    pub format: Option<types::ReportFormat>,
    /// An IANA time zone such as `Europe/Berlin` for the days and times; the server's
    /// review time zone when omitted, so every client gets the same period.
    pub time_zone: Option<String>,
    /// Only tasks of this workspace; all workspaces when omitted.
    pub workspace_id: Option<WorkspaceId>,
    /// Only tasks with this label; any label when omitted.
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct GetTask {
    /// The task, e.g. one that search_tasks found.
    pub id: TaskId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct GetGuidelines {
    /// The workspace, e.g. the workspaceId of the task you work on, or one from
    /// list_workspaces.
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AddGuideline {
    /// The workspace, e.g. the workspaceId of the task you work on.
    pub workspace_id: WorkspaceId,
    /// memory (the default) for a durable lesson or fact; rule only when the user asks
    /// for a rule.
    #[serde(default)]
    pub kind: Option<types::GuidelineKind>,
    /// The guideline in Markdown, at most 4000 characters.
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct UpdateGuideline {
    /// The guideline, as in get_guidelines.
    pub id: types::GuidelineId,
    /// The new kind; unchanged when omitted.
    #[serde(default)]
    pub kind: Option<types::GuidelineKind>,
    /// The new Markdown body, at most 4000 characters; unchanged when omitted.
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RemoveGuideline {
    /// The guideline, as in get_guidelines.
    pub id: types::GuidelineId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct Related {
    /// One task of the link, e.g. your current task.
    pub task_id: TaskId,
    /// The other task, from any workspace. The link goes both ways.
    pub related_id: TaskId,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ConcludeTask {
    /// The task. Never your own task, the one current_task finds.
    pub id: TaskId,
    /// The conclusion in GitHub-flavored Markdown: what was tried or found and why the
    /// work ends without a merge. Kept as the task's completion note.
    pub note: String,
    pub outcome: Option<ConcludeOutcome>,
    pub shipped_with: Option<TaskId>,
}

pub fn review_report(
    storage: &Storage,
    request: ReviewReportRequest,
) -> CommandResult<types::ReviewReport> {
    crate::commands::review::render_report(
        storage,
        types::ReviewReportRequest {
            period: request.period,
            date: request.date,
            from: request.from,
            to: request.to,
            format: request.format.unwrap_or(types::ReportFormat::Markdown),
            time_zone: request.time_zone,
            workspace_id: request.workspace_id,
            label: request.label,
        },
    )
}

pub fn list_workspaces(storage: &Storage) -> CommandResult<Vec<Workspace>> {
    Ok(types::map_all(&storage.list_workspaces()?))
}

/// Archives a workspace with its tasks as the app's Remove does (see
/// [`workspaces::delete_workspace`]), but only with `confirm`; without it, nothing changes
/// and the reply says what archiving would do. Rejected while a task of the workspace is
/// `in_progress` or `in_review`, since someone is working on it.
pub fn archive_workspace(
    storage: &mut Storage,
    request: ArchiveWorkspace,
) -> CommandResult<WorkspaceConfirmation> {
    let id = request.id.0;
    let stored = storage.get_workspace(request.id.into())?.ok_or_else(|| {
        CommandError::new(
            CommandErrorCode::WorkspaceNotFound,
            format!(
                "workspace {id} does not exist or is already archived; take a workspace id from list_workspaces"
            ),
        )
    })?;
    let workspace = Workspace::from(&stored);
    let tasks = storage.list_tasks(stored.id)?;
    let active: Vec<(i64, &str)> = tasks
        .iter()
        .filter_map(|task| match task.status {
            crate::domain::status::TaskStatus::InProgress => Some((task.id.0, "in_progress")),
            crate::domain::status::TaskStatus::InReview => Some((task.id.0, "in_review")),
            crate::domain::status::TaskStatus::Planned
            | crate::domain::status::TaskStatus::Done => None,
        })
        .collect();
    if let Some((first, _)) = active.first() {
        let described: Vec<String> = active
            .iter()
            .map(|(task, status)| format!("#{task} ({status})"))
            .collect();
        return Err(CommandError::rejected(format!(
            "workspace {id} \"{}\" still has task(s) being worked on: {}; finish each of them, or call pause_task on each, e.g. {{\"id\": {first}, \"reason\": \"...\"}}, then call archive_workspace again",
            workspace.name,
            described.join(", "),
        )));
    }
    if !request.confirm {
        return Ok(WorkspaceConfirmation {
            confirmed: false,
            message: format!(
                "Nothing changed yet. Archiving workspace {id} \"{}\" removes it and its {} task(s) from list_workspaces and the task lists, while their history, notes, criteria, and commit records stay in review_report; the user can restore it, or delete it for good, under Settings > Archive in the Toodo app. To archive it, call archive_workspace {{\"id\": {id}, \"confirm\": true}}.",
                workspace.name,
                tasks.len()
            ),
            workspace,
        });
    }
    storage.archive_workspace(stored.id)?;
    Ok(WorkspaceConfirmation {
        confirmed: true,
        message: format!(
            "workspace {id} \"{}\" is archived with its {} task(s); they stay in review_report, and the user can restore the workspace in the Toodo app.",
            workspace.name,
            tasks.len()
        ),
        workspace,
    })
}

pub fn create_workspace(
    storage: &StorageState,
    request: CreateWorkspace,
) -> CommandResult<Workspace> {
    let new = types::NewWorkspace {
        name: request.name,
        description: request.description,
        repository: request.repository,
    };
    Ok((&workspaces::create(storage, new.try_into()?)?).into())
}

pub fn update_workspace(
    storage: &StorageState,
    request: UpdateWorkspace,
) -> CommandResult<Workspace> {
    let current = Workspace::from(
        &lock(storage)
            .get_workspace(request.id.into())?
            .ok_or(StorageError::WorkspaceNotFound(request.id.into()))?,
    );
    let workspace = Workspace {
        name: request.name.unwrap_or(current.name),
        description: request.description.unwrap_or(current.description),
        repository: request.repository.unwrap_or(current.repository),
        ..current
    };
    Ok((&workspaces::update(storage, workspace)?).into())
}

/// A workspace as get_guidelines names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidelineWorkspace {
    pub id: WorkspaceId,
    pub name: String,
}

/// The reply of get_guidelines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGuidelines {
    pub workspace: GuidelineWorkspace,
    /// Rules first, then memories, each in the order they were added.
    pub guidelines: Vec<types::Guideline>,
}

fn live_workspace(storage: &Storage, id: WorkspaceId) -> CommandResult<model::Workspace> {
    storage.get_workspace(id.into())?.ok_or_else(|| {
        CommandError::new(
            CommandErrorCode::WorkspaceNotFound,
            format!(
                "workspace {} does not exist or is archived; take a workspace id from list_workspaces, or the workspaceId of a task from get_task",
                id.0
            ),
        )
    })
}

fn stored_guideline(storage: &Storage, id: types::GuidelineId) -> CommandResult<model::Guideline> {
    storage.get_guideline(id.into())?.ok_or_else(|| {
        CommandError::new(
            CommandErrorCode::GuidelineNotFound,
            format!(
                "guideline {} does not exist; call get_guidelines with the workspace_id of your task and take the guideline id from its result",
                id.0
            ),
        )
    })
}

/// The guidelines of a task's workspace; none once the workspace is archived.
fn task_guidelines(
    storage: &Storage,
    workspace: WorkspaceId,
) -> CommandResult<Vec<types::Guideline>> {
    match storage.list_guidelines(workspace.into()) {
        Ok(guidelines) => Ok(types::map_all(&guidelines)),
        Err(StorageError::WorkspaceNotFound(_)) => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

pub fn get_guidelines(
    storage: &Storage,
    request: GetGuidelines,
) -> CommandResult<WorkspaceGuidelines> {
    let workspace = live_workspace(storage, request.workspace_id)?;
    Ok(WorkspaceGuidelines {
        guidelines: types::map_all(&storage.list_guidelines(workspace.id)?),
        workspace: GuidelineWorkspace {
            id: workspace.id.into(),
            name: workspace.name,
        },
    })
}

pub fn add_guideline(
    storage: &StorageState,
    request: AddGuideline,
) -> CommandResult<types::Guideline> {
    live_workspace(&lock(storage), request.workspace_id)?;
    let new = types::NewGuideline {
        workspace_id: request.workspace_id,
        kind: request.kind.unwrap_or(types::GuidelineKind::Memory),
        body: request.body,
    };
    Ok((&guidelines::add(storage, new.try_into()?)?).into())
}

/// Changes the supplied kind and body of a guideline, keeping omitted values.
pub fn update_guideline(
    storage: &StorageState,
    request: UpdateGuideline,
) -> CommandResult<types::Guideline> {
    let current = stored_guideline(&lock(storage), request.id)?;
    let update = types::GuidelineUpdate {
        id: request.id,
        kind: request.kind.unwrap_or(current.kind.into()),
        body: request.body.unwrap_or(current.body),
    };
    Ok((&guidelines::update(storage, update)?).into())
}

pub fn remove_guideline(
    storage: &StorageState,
    request: RemoveGuideline,
) -> CommandResult<types::Guideline> {
    stored_guideline(&lock(storage), request.id)?;
    Ok((&guidelines::delete(storage, request.id.into())?).into())
}

/// A task as list_tasks returns it, with whether it can start now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedTask {
    #[serde(flatten)]
    pub task: Task,
    /// Whether the task is planned and every task it depends on is done and adopted, so
    /// start_task (or resume_task for a paused task) can begin it now.
    pub ready: bool,
    /// The tasks it depends on that keep it from starting: not done yet, or done as
    /// not_adopted, which never unblocks it.
    pub blocked_by: Vec<TaskLink>,
}

pub fn list_tasks(storage: &Storage, request: ListTasks) -> CommandResult<Vec<ListedTask>> {
    if let Some(workspace) = request.workspace_id {
        storage
            .get_workspace(workspace.into())?
            .ok_or(StorageError::WorkspaceNotFound(workspace.into()))?;
    }
    if let Some(limit) = request.limit {
        types::task_page_limit(limit)?;
    }
    let planned = crate::domain::status::TaskStatus::Planned;
    let mut statuses: Vec<crate::domain::status::TaskStatus> = request
        .status
        .unwrap_or_default()
        .into_iter()
        .map(Into::into)
        .collect();
    if request.ready == Some(true) {
        // Only a planned task can be ready.
        if !statuses.is_empty() && !statuses.contains(&planned) {
            return Ok(Vec::new());
        }
        statuses = vec![planned];
    }
    let query = storage::TaskQuery {
        workspace: request.workspace_id.map(Into::into),
        statuses,
        ids: None,
        before: request.before_id.map(Into::into),
        // Readiness is known only once the prerequisites are loaded, so the limit then
        // applies after filtering by it.
        limit: request.limit.filter(|_| request.ready.is_none()),
        autopilot: request.autopilot,
    };
    let tasks = storage.query_tasks(&query)?;
    let prerequisites = prerequisites(storage, &tasks)?;
    let mut listed: Vec<ListedTask> = tasks
        .iter()
        .map(|task| {
            let blocked_by = blocked_by(&prerequisites, task);
            ListedTask {
                task: task.into(),
                ready: is_ready(task, &blocked_by),
                blocked_by,
            }
        })
        .filter(|listed| request.ready.is_none_or(|ready| listed.ready == ready))
        .collect();
    if let Some(limit) = request.limit {
        let older = listed.len().saturating_sub(limit as usize);
        listed.drain(..older);
    }
    Ok(listed)
}

/// `tasks` and the tasks they depend on, by ID.
fn prerequisites(
    storage: &Storage,
    tasks: &[model::Task],
) -> CommandResult<HashMap<model::TaskId, model::Task>> {
    let mut known: HashMap<_, _> = tasks.iter().map(|task| (task.id, task.clone())).collect();
    let missing: BTreeSet<model::TaskId> = tasks
        .iter()
        .flat_map(|task| task.depends_on.iter().copied())
        .filter(|id| !known.contains_key(id))
        .collect();
    if !missing.is_empty() {
        let query = storage::TaskQuery {
            ids: Some(missing.into_iter().collect()),
            ..storage::TaskQuery::default()
        };
        known.extend(
            storage
                .query_tasks(&query)?
                .into_iter()
                .map(|task| (task.id, task)),
        );
    }
    Ok(known)
}

/// The tasks `task` depends on that keep it from starting: not done, or done as not
/// adopted. `tasks` holds them by ID.
fn blocked_by(tasks: &HashMap<model::TaskId, model::Task>, task: &model::Task) -> Vec<TaskLink> {
    task_links(
        tasks,
        task.depends_on.iter().copied().filter(|id| {
            tasks.get(id).is_some_and(|prerequisite| {
                prerequisite.status != crate::domain::status::TaskStatus::Done
                    || prerequisite.resolution == Some(model::TaskResolution::NotAdopted)
            })
        }),
    )
}

/// Links to the tasks `ids` of `tasks`.
fn task_links(
    tasks: &HashMap<model::TaskId, model::Task>,
    ids: impl Iterator<Item = model::TaskId>,
) -> Vec<TaskLink> {
    ids.filter_map(|id| tasks.get(&id))
        .map(|task| TaskLink {
            id: task.id.into(),
            workspace_id: task.workspace_id.into(),
            title: task.title.clone(),
            status: task.status.into(),
            resolution: task.resolution.map(TaskResolution::from),
        })
        .collect()
}

/// Whether `task` can start (or resume) now: it is planned and nothing blocks it.
fn is_ready(task: &model::Task, blocked_by: &[TaskLink]) -> bool {
    task.status == crate::domain::status::TaskStatus::Planned && blocked_by.is_empty()
}

/// `links` as a list such as "#3 (planned), #4 (done as not_adopted)".
fn describe_links(links: &[TaskLink]) -> String {
    let described: Vec<String> = links
        .iter()
        .map(|link| {
            let state = match (link.status, link.resolution) {
                (_, Some(TaskResolution::NotAdopted)) => "done as not_adopted",
                (TaskStatus::Planned, _) => "planned",
                (TaskStatus::InProgress, _) => "in_progress",
                (TaskStatus::InReview, _) => "in_review",
                (TaskStatus::Done, _) => "done",
            };
            format!("#{} ({state})", link.id.0)
        })
        .collect();
    described.join(", ")
}

/// What a dependency change means for `details`' task and what to do next.
fn dependency_message(details: &TaskDetails, paused: bool) -> String {
    let task = &details.task;
    let id = task.id.0;
    let blockers = &details.blocked_by;
    let waiting = describe_links(blockers);
    let mut message = if paused {
        format!(
            "task {id} is paused until {waiting} {} done; call resume_task once its prerequisites are complete.",
            if blockers.len() == 1 { "is" } else { "are" }
        )
    } else {
        match task.status {
            TaskStatus::InProgress => format!(
                "task {id} stays in_progress: every task it depends on is done and adopted."
            ),
            TaskStatus::InReview if blockers.is_empty() => {
                format!("task {id} stays in_review: every task it depends on is done and adopted.")
            }
            TaskStatus::InReview => format!(
                "task {id} is in_review, so it was not paused and can still complete before {waiting}; call pause_task if it must wait for them."
            ),
            TaskStatus::Done => format!("task {id} is done."),
            TaskStatus::Planned if !blockers.is_empty() => {
                format!("task {id} waits for {waiting} before it can start.")
            }
            TaskStatus::Planned if task.milestones.started_at.is_some() => format!(
                "task {id} is paused and no longer waits on any task: resume_task resumes it."
            ),
            TaskStatus::Planned => {
                format!("task {id} is ready: nothing it depends on blocks start_task.")
            }
        }
    };
    for blocker in blockers {
        if blocker.resolution == Some(TaskResolution::NotAdopted) {
            let prerequisite = blocker.id.0;
            message.push_str(&format!(
                " #{prerequisite} was not adopted, so it never unblocks task {id}: call remove_dependency {{\"task_id\": {id}, \"depends_on\": {prerequisite}}} if the work can go ahead without it, or conclude_task {prerequisite} with outcome shipped_with and shipped_with set to the completed task id if another merged pull request shipped it."
            ));
        }
    }
    message
}

/// A task found by a stored reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTaskReply {
    #[serde(flatten)]
    pub task: Task,
}

pub fn current_task(storage: &Storage, request: CurrentTask) -> CommandResult<CurrentTaskReply> {
    let reference = request
        .r#ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CommandError::invalid_input(
                "call current_task with ref set to a task reference, or call get_task with id",
            )
        })?;
    let mut matches: Vec<_> = storage
        .list_all_tasks()?
        .into_iter()
        .filter(|task| task.refs.iter().any(|value| value == reference))
        .collect();
    if matches.len() != 1 {
        let ids = matches
            .iter()
            .map(|task| task.id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(CommandError::rejected(format!(
            "ref {reference:?} matches {} tasks ({ids}); call get_task with the intended id, or current_task with a unique ref",
            matches.len()
        )));
    }
    Ok(CurrentTaskReply {
        task: (&matches.remove(0)).into(),
    })
}

/// Creates a `planned` task with its dependencies. Unknown prerequisites are rejected
/// before anything is written; a new task has no dependents, so its edges cannot close
/// a cycle.
pub fn create_task(storage: &StorageState, request: CreateTask) -> CommandResult<Task> {
    insert_task(&mut lock(storage), request)
}

/// Creates every task of `request` with its dependencies and related links in one
/// transaction. Keys, links, criteria, and labels are checked before anything is
/// written, and a failure names the task of the plan it is about; any failure creates
/// nothing.
pub fn create_plan(storage: &StorageState, request: CreatePlan) -> CommandResult<CreatedPlan> {
    let count = request.tasks.len();
    if count == 0 || count > MAX_PLAN_TASKS {
        return Err(CommandError::invalid_input(format!(
            "create_plan takes 1 to {MAX_PLAN_TASKS} tasks, got {count}; split a larger plan into several create_plan calls and link a later call's tasks to created ones by id in depends_on"
        )));
    }
    let keys = plan_keys(&request.tasks)?;
    let mut depends_on = Vec::with_capacity(count);
    let mut related = Vec::with_capacity(count);
    for (index, item) in request.tasks.iter().enumerate() {
        let existing = |ids: &[TaskId]| {
            ids.iter()
                .map(|&id| storage::PlanLink::Existing(id.into()))
                .collect::<Vec<_>>()
        };
        let mut links = existing(&item.depends_on);
        links.extend(plan_links(
            &keys,
            index,
            item,
            "depends_on",
            &item.depends_on_keys,
        )?);
        depends_on.push(links);
        let mut links = existing(&item.related);
        links.extend(plan_links(
            &keys,
            index,
            item,
            "related",
            &item.related_keys,
        )?);
        related.push(links);
    }
    check_plan_order(&request.tasks, &depends_on)?;
    {
        let storage = lock(storage);
        for item in &request.tasks {
            if storage.get_workspace(item.workspace_id.into())?.is_none() {
                return Err(CommandError::new(
                    CommandErrorCode::WorkspaceNotFound,
                    format!(
                        "task `{}` of the plan is in workspace {}, which does not exist; take a workspace id from list_workspaces",
                        item.key, item.workspace_id.0
                    ),
                ));
            }
            for &id in item.depends_on.iter().chain(&item.related) {
                if storage.get_task(id.into())?.is_none() {
                    return Err(CommandError::not_found(format!(
                        "task `{}` of the plan links to task {}, which does not exist; find the task with search_tasks, or link a task of the plan by its key in depends_on_keys or related_keys",
                        item.key, id.0
                    )));
                }
            }
        }
    }
    let mut plan = Vec::with_capacity(count);
    for ((item, depends_on), related) in request.tasks.iter().zip(depends_on).zip(related) {
        let in_item = |mut error: CommandError| {
            error.message = format!("task `{}` of the plan: {}", item.key, error.message);
            error
        };
        let mut task = plan_task(storage, item).map_err(in_item)?;
        task.depends_on = depends_on;
        task.related = related;
        plan.push(task);
    }
    let mut storage = lock(storage);
    let created = storage.create_tasks(&plan)?;
    let tasks = request
        .tasks
        .into_iter()
        .zip(created)
        .map(|(item, task)| {
            Ok(PlannedTask {
                key: item.key,
                task: get_task(&storage, task.id.into())?,
            })
        })
        .collect::<CommandResult<_>>()?;
    Ok(CreatedPlan { tasks })
}

/// The index of each key of `tasks`, rejecting empty and repeated keys.
fn plan_keys(tasks: &[PlanTask]) -> CommandResult<HashMap<&str, usize>> {
    let mut keys = HashMap::with_capacity(tasks.len());
    for (index, item) in tasks.iter().enumerate() {
        if item.key.trim().is_empty() {
            return Err(CommandError::invalid_input(format!(
                "task {} of the plan (\"{}\") has no key; give every task of the plan its own key, e.g. \"schema\"",
                index + 1,
                item.title
            )));
        }
        if keys.insert(item.key.as_str(), index).is_some() {
            return Err(CommandError::invalid_input(format!(
                "more than one task of the plan has the key `{}`; give each task its own key",
                item.key
            )));
        }
    }
    Ok(keys)
}

/// The links that `names`, the `{field}_keys` of the task at `index`, make to other tasks
/// of the plan.
fn plan_links(
    keys: &HashMap<&str, usize>,
    index: usize,
    item: &PlanTask,
    field: &str,
    names: &[String],
) -> CommandResult<Vec<storage::PlanLink>> {
    names
        .iter()
        .map(|name| match keys.get(name.as_str()) {
            Some(&linked) if linked == index => Err(CommandError::invalid_input(format!(
                "task `{name}` of the plan names itself in {field}_keys; remove `{name}` from them"
            ))),
            Some(&linked) => Ok(storage::PlanLink::New(linked)),
            None => Err(CommandError::invalid_input(format!(
                "task `{}` of the plan names `{name}` in {field}_keys, but no task of the plan has that key; use the key of a task in tasks, or put the id of an existing task in {field}",
                item.key
            ))),
        })
        .collect()
}

/// Rejects dependencies between tasks of the plan that form a cycle, naming its tasks.
/// Existing tasks cannot depend on new ones, so no other cycle is possible.
fn check_plan_order(
    tasks: &[PlanTask],
    depends_on: &[Vec<storage::PlanLink>],
) -> CommandResult<()> {
    let mut waiting: Vec<usize> = depends_on
        .iter()
        .map(|links| {
            links
                .iter()
                .filter(|link| matches!(link, storage::PlanLink::New(_)))
                .count()
        })
        .collect();
    let mut done: Vec<usize> = (0..tasks.len()).filter(|&i| waiting[i] == 0).collect();
    let mut next = 0;
    while let Some(&finished) = done.get(next) {
        next += 1;
        for (index, links) in depends_on.iter().enumerate() {
            let edges = links
                .iter()
                .filter(|&&link| link == storage::PlanLink::New(finished))
                .count();
            if edges > 0 {
                waiting[index] -= edges;
                if waiting[index] == 0 {
                    done.push(index);
                }
            }
        }
    }
    if done.len() == tasks.len() {
        return Ok(());
    }
    let cycle: Vec<String> = (0..tasks.len())
        .filter(|&index| waiting[index] > 0)
        .map(|index| format!("`{}`", tasks[index].key))
        .collect();
    Err(CommandError::rejected(format!(
        "the depends_on_keys of tasks {} of the plan form a cycle, so none of them could ever start; remove a key from one of them so every task has prerequisites that finish first",
        cycle.join(", ")
    )))
}

/// The task `item` of a plan creates, with its merge criterion and labels and without
/// links.
fn plan_task(_storage: &StorageState, item: &PlanTask) -> CommandResult<storage::NewPlanTask> {
    let labels = types::labels(&item.labels)?;
    let refs = types::merge_refs(&[], &item.refs, &[])?;
    let task: storage::NewTask = types::NewTask {
        workspace_id: item.workspace_id,
        task_type: item.task_type,
        title: item.title.clone(),
        description: item.description.clone(),
        estimate: item.estimate,
        due_date: item.due_date.clone(),
        labels: Vec::new(),
        autopilot: item.autopilot,
        criteria: item.criteria.clone(),
    }
    .try_into()?;
    Ok(storage::NewPlanTask {
        task,
        labels,
        refs,
        depends_on: Vec::new(),
        related: Vec::new(),
    })
}

/// Creates the task of `request` with `merge`, its merge criterion if it gets one, in
/// front of its criteria.
fn insert_task(storage: &mut Storage, request: CreateTask) -> CommandResult<Task> {
    for &linked in request.depends_on.iter().chain(&request.related) {
        storage
            .get_task(linked.into())?
            .ok_or(StorageError::TaskNotFound(linked.into()))?;
    }
    let labels = types::labels(&request.labels)?;
    let refs = types::merge_refs(&[], &request.refs, &[])?;
    let new: storage::NewTask = types::NewTask {
        workspace_id: request.workspace_id,
        task_type: request.task_type,
        title: request.title,
        description: request.description,
        estimate: request.estimate,
        due_date: request.due_date,
        labels: Vec::new(),
        autopilot: request.autopilot,
        criteria: request.criteria,
    }
    .try_into()?;
    let task = storage.create_task(&new)?;
    let labelled = if labels.is_empty() {
        Ok(())
    } else {
        storage.set_task_labels(task.id, &labels).map(drop)
    }
    .and_then(|()| {
        if refs.is_empty() {
            Ok(())
        } else {
            storage.set_task_refs(task.id, &refs).map(drop)
        }
    });
    let linked = labelled
        .and_then(|()| {
            request.depends_on.iter().try_for_each(|&prerequisite| {
                storage
                    .add_dependency(task.id, prerequisite.into())
                    .map(drop)
            })
        })
        .and_then(|()| {
            request
                .related
                .iter()
                .try_for_each(|&related| storage.add_related(task.id, related.into()))
        });
    if let Err(error) = linked {
        if let Err(cleanup) = storage.delete_task(task.id) {
            eprintln!(
                "toodo: failed to delete task {} after a failed MCP create: {cleanup}",
                task.id
            );
        }
        return Err(error.into());
    }
    get_task(storage, task.id.into())
}

/// Edits a task as `update_task` does; `completion` is the completion of its workspace
/// (see [`task_commands::edit_completion`]).
pub fn update_task(storage: &mut Storage, request: UpdateTask) -> CommandResult<Task> {
    let current = get_task(storage, request.id)?;
    // A done task is part of the record reviews are built on; agents add to it instead.
    if current.status == types::TaskStatus::Done {
        return Err(CommandError::rejected(format!(
            "task {} is done, so update_task leaves its record as it was finished; record a correction with add_progress_note task_id {}, or call reopen_task to work on it again",
            request.id.0, request.id.0
        )));
    }
    let id = request.id;
    let refs = match (&request.refs, &request.remove_refs) {
        (None, None) => None,
        (add, remove) => Some(types::merge_refs(
            &current.refs,
            add.as_deref().unwrap_or_default(),
            remove.as_deref().unwrap_or_default(),
        )?),
    };
    let edited = edit_task(
        storage,
        TaskEdit {
            status: request.status,
            id: request.id,
            task_type: request.task_type.unwrap_or(current.task_type),
            title: request.title.unwrap_or(current.title),
            description: request.description.unwrap_or(current.description),
            estimate: request.estimate.unwrap_or(current.estimate),
            due_date: request.due_date.unwrap_or(current.due_date),
            labels: request.labels,
            autopilot: request.autopilot,
            criteria: request.criteria,
        },
    )?;
    if let Some(refs) = refs {
        storage.set_task_refs(id.into(), &refs)?;
    } else {
        return Ok(edited);
    }
    get_task(storage, id)
}

/// The criterion `request` adds to the end of its task's criteria, as an edit input.
pub fn new_criterion(request: &AddCriterion) -> types::CriterionInput {
    types::CriterionInput {
        id: None,
        text: Some(request.text.clone()),
        kind: Some(request.kind),
        target: request.target.clone(),
    }
}

/// Adds one criterion, pending, after the task's criteria, which stay as they are;
/// `completion` as for [`update_task`].
pub fn add_criterion(storage: &mut Storage, request: AddCriterion) -> CommandResult<Task> {
    let current = get_task(storage, request.task_id)?;
    let mut criteria: Vec<types::CriterionInput> = current
        .criteria
        .iter()
        .map(|criterion| types::CriterionInput::keep(criterion.id))
        .collect();
    criteria.push(new_criterion(&request));
    update_task(
        storage,
        UpdateTask {
            status: None,
            refs: None,
            remove_refs: None,
            id: request.task_id,
            task_type: None,
            title: None,
            description: None,
            estimate: None,
            due_date: None,
            labels: None,
            autopilot: None,
            criteria: Some(criteria),
        },
    )
}

/// Deletes one criterion of a task that is not done with its evidence, the merge
/// criterion too; the others stay as they are.
pub fn remove_criterion(storage: &mut Storage, request: RemoveCriterion) -> CommandResult<Task> {
    let owner = task_commands::criterion_owner(
        storage,
        request.task_id,
        request.criterion_id,
        "remove_criterion",
    )?;
    let current = get_task(storage, owner.into())?;
    let criteria = current
        .criteria
        .iter()
        .filter(|criterion| criterion.id != request.criterion_id)
        .map(|criterion| types::CriterionInput::keep(criterion.id))
        .collect();
    update_task(
        storage,
        UpdateTask {
            status: None,
            refs: None,
            remove_refs: None,
            id: owner.into(),
            task_type: None,
            title: None,
            description: None,
            estimate: None,
            due_date: None,
            labels: None,
            autopilot: None,
            criteria: Some(criteria),
        },
    )
}

/// Checks or unchecks a manual criterion as the agent; checking needs evidence.
pub fn check_criterion(storage: &mut Storage, request: CheckCriterion) -> CommandResult<Task> {
    let met = request.met.unwrap_or(true);
    let evidence = request.evidence.as_deref().map(str::trim).unwrap_or("");
    if met && evidence.is_empty() {
        return Err(CommandError::invalid_input(
            "evidence must say what shows the criterion holds",
        ));
    }
    task_commands::check(
        storage,
        request.task_id,
        request.criterion_id,
        met,
        Some(evidence),
        CheckedBy::Agent,
    )
}

/// The dependent task after add_dependency or remove_dependency, with what the change
/// means for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReply {
    /// The dependent task with its links; `dependsOn` names each prerequisite's
    /// workspace, title, and status.
    pub task: TaskDetails,
    /// Whether this change paused the task.
    pub paused: bool,
    /// What the change means for the task and what to do next.
    pub message: String,
}

/// Adds the edges in one step and returns the dependent task. Self and cyclic edges and
/// `done` dependent tasks are rejected, and one rejected edge adds none. An `in_progress`
/// task that a prerequisite blocks is paused until the prerequisites are complete.
pub fn add_dependencies(
    storage: &mut Storage,
    request: AddDependencies,
) -> CommandResult<DependencyReply> {
    if request.depends_on.is_empty() {
        return Err(CommandError::invalid_input(
            "depends_on must name at least one task",
        ));
    }
    let depends_on: Vec<_> = request.depends_on.iter().map(|&id| id.into()).collect();
    let added = storage.add_dependencies(request.task_id.into(), &depends_on)?;
    let task = task_details(
        storage,
        GetTask {
            id: request.task_id,
        },
    )?;
    Ok(DependencyReply {
        message: dependency_message(&task, added.paused),
        paused: added.paused,
        task,
    })
}

/// Removes the edges to every task of `depends_on` and returns the dependent task. An
/// edge that does not exist is rejected, and then none is removed.
pub fn remove_dependency(
    storage: &mut Storage,
    request: Dependency,
) -> CommandResult<DependencyReply> {
    if request.depends_on.is_empty() {
        return Err(CommandError::invalid_input(
            "depends_on must name at least one task, e.g. {\"task_id\": 5, \"depends_on\": 3}",
        ));
    }
    let current = get_task(storage, request.task_id)?;
    if let Some(&missing) = request
        .depends_on
        .iter()
        .find(|id| !current.depends_on.contains(id))
    {
        return Err(StorageError::DependencyNotFound {
            task: request.task_id.into(),
            depends_on: missing.into(),
        }
        .into());
    }
    for &prerequisite in &request.depends_on {
        storage.remove_dependency(request.task_id.into(), prerequisite.into())?;
    }
    let task = task_details(
        storage,
        GetTask {
            id: request.task_id,
        },
    )?;
    Ok(DependencyReply {
        message: dependency_message(&task, false),
        paused: false,
        task,
    })
}

/// Appends a note of `kind` to the task's history and returns the task with its notes.
pub fn add_note(storage: &mut Storage, kind: NoteKind, request: AddNote) -> CommandResult<Task> {
    let note = request.note.trim();
    if note.is_empty() {
        return Err(CommandError::invalid_input("note must not be empty"));
    }
    let task = storage.add_task_note(request.task_id.into(), kind, note)?;
    Ok((&task).into())
}

/// Pauses an `in_progress` or `in_review` task as the app's Pause does and records the
/// reason in its status history and as a progress note. References and criteria stay.
pub fn pause_task(storage: &mut Storage, request: PauseTask) -> CommandResult<Task> {
    let reason = request.reason.trim();
    if reason.is_empty() {
        return Err(CommandError::invalid_input(
            "reason must say why the work stops, e.g. {\"id\": 5, \"reason\": \"Waiting for the API design\"}",
        ));
    }
    let task = get_task(storage, request.id)?;
    match task.status {
        TaskStatus::InProgress | TaskStatus::InReview => {}
        TaskStatus::Planned => {
            return Err(CommandError::rejected(format!(
                "task {} is planned, so nobody works on it; call resume_task for a paused task or start_task to start it",
                task.id.0
            )));
        }
        TaskStatus::Done => {
            return Err(CommandError::rejected(format!(
                "task {} is done; create a follow-up task with create_task for more work",
                task.id.0
            )));
        }
    }
    task_commands::pause(storage, request.id, Some(reason))?;
    let task = storage.add_task_note(
        request.id.into(),
        NoteKind::Progress,
        &format!("Paused: {reason}"),
    )?;
    Ok((&task).into())
}

/// Makes a task wait until a time (see [`task_commands::wait_task`]), or moves the time of
/// a task that already waits.
pub fn wait_task(storage: &mut Storage, request: WaitTask) -> CommandResult<Task> {
    let until: jiff::Timestamp = request.until.trim().parse().map_err(|_| {
        CommandError::invalid_input(format!(
            "until {:?} is not an RFC 3339 time with an offset; pass e.g. {{\"id\": {}, \"until\": \"2026-11-10T09:00:00+09:00\"}}",
            request.until, request.id.0
        ))
    })?;
    task_commands::wait(
        storage,
        request.id,
        until.as_second(),
        request.reason.as_deref(),
    )
}

/// Ends the wait of a task now (see [`task_commands::end_wait`]).
pub fn end_wait(storage: &mut Storage, request: EndWait) -> CommandResult<Task> {
    task_commands::end_task_wait(storage, request.id, request.note.as_deref())
}

/// Resumes a previously started, paused task.
pub fn resume_task(storage: &StorageState, request: ResumeTask) -> CommandResult<Task> {
    let task = get_task(&lock(storage), request.id)?;
    if task.status != TaskStatus::Planned || task.milestones.started_at.is_none() {
        return Err(CommandError::rejected(format!(
            "task {} is not paused; call start_task to start a planned task, or pause_task before resuming active work",
            request.id.0
        )));
    }
    let resumed =
        task_commands::start_task(State(storage), request.id, request.note.clone(), None)?;
    if let Some(note) = request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty())
    {
        lock(storage).add_task_note(
            request.id.into(),
            NoteKind::Progress,
            &format!("Resumed: {note}"),
        )?;
        return get_task(&lock(storage), request.id);
    }
    Ok(resumed)
}

/// Deletes (archives) a `planned` or `done` task as the app's Delete does (see
/// [`task_commands::delete_task`]), but only with `confirm`; without it, nothing changes and
/// the reply says what deleting would do. Tasks being worked on (`in_progress` or
/// `in_review`) are rejected.
pub fn delete_task(storage: &StorageState, request: DeleteTask) -> CommandResult<Confirmation> {
    let details = task_details(&lock(storage), GetTask { id: request.id })?;
    let task = details.task;
    let id = task.id.0;
    match task.status {
        TaskStatus::Planned | TaskStatus::Done => {}
        TaskStatus::InProgress | TaskStatus::InReview => {
            let status = if task.status == TaskStatus::InProgress {
                "in_progress"
            } else {
                "in_review"
            };
            return Err(CommandError::rejected(format!(
                "task {id} is {status}, so it is being worked on; call pause_task {{\"id\": {id}, \"reason\": \"...\"}} first if the work should stop, then delete_task"
            )));
        }
    }
    let dependents = describe_links(&details.dependents);
    let wait = if details.dependents.len() == 1 {
        "waits"
    } else {
        "wait"
    };
    if !request.confirm {
        let mut message = format!(
            "Nothing changed yet. Deleting task {id} \"{}\" archives it: it leaves the task lists and no longer holds back its dependents, while its history, notes, criteria, {} recorded commit(s), and {} dependency and related link(s) stay for the reports; the user can restore it, or delete it for good, under Settings > Archive in the Toodo app",
            task.title,
            details.commits.len(),
            details.depends_on.len() + details.dependents.len() + details.related.len(),
        );
        message.push('.');
        if !dependents.is_empty() {
            message.push_str(&format!(" {dependents} no longer {wait} on it."));
        }
        message.push_str(&format!(
            " To delete it, call delete_task {{\"id\": {id}, \"confirm\": true}}."
        ));
        return Ok(Confirmation {
            confirmed: false,
            task,
            message,
        });
    }
    lock(storage).archive_task(request.id.into())?;
    let mut message = format!(
        "task {id} \"{}\" is deleted and kept in the archive, where the user can restore it in the Toodo app.",
        task.title
    );
    if !dependents.is_empty() {
        message.push_str(&format!(" {dependents} no longer {wait} on it."));
    }
    Ok(Confirmation {
        confirmed: true,
        task,
        message,
    })
}

/// Deletes (archives) every `done` task of a workspace as [`delete_task`] does for one (see
/// [`task_commands::delete_done_tasks`]), but only with `confirm`; without it, nothing
/// changes and the reply lists the tasks deleting would archive.
pub fn delete_done_tasks(
    storage: &mut Storage,
    request: DeleteDoneTasks,
) -> CommandResult<DoneTasksConfirmation> {
    let stored = live_workspace(storage, request.workspace_id)?;
    let id = request.workspace_id.0;
    let done: Vec<(TaskId, String)> = storage
        .list_tasks(stored.id)?
        .into_iter()
        .filter(|task| task.status == crate::domain::status::TaskStatus::Done)
        .map(|task| (task.id.into(), task.title))
        .collect();
    if done.is_empty() {
        return Ok(DoneTasksConfirmation {
            confirmed: false,
            workspace_id: request.workspace_id,
            task_ids: Vec::new(),
            message: format!(
                "Nothing changed: workspace {id} \"{}\" has no done task to delete; call list_tasks {{\"workspace_id\": {id}, \"status\": [\"done\"]}} to check.",
                stored.name
            ),
        });
    }
    if !request.confirm {
        let described: Vec<String> = done
            .iter()
            .map(|(task, title)| format!("#{} {title}", task.0))
            .collect();
        return Ok(DoneTasksConfirmation {
            confirmed: false,
            workspace_id: request.workspace_id,
            task_ids: done.iter().map(|(task, _)| *task).collect(),
            message: format!(
                "Nothing changed yet. Deleting the done tasks of workspace {id} \"{}\" archives {} task(s): {}. They leave the task lists, while their history, notes, criteria, and commit records stay in review_report; the user can restore them, or delete them for good, under Settings > Archive in the Toodo app. To delete them, call delete_done_tasks {{\"workspace_id\": {id}, \"confirm\": true}}.",
                stored.name,
                done.len(),
                described.join(", "),
            ),
        });
    }
    let archived: Vec<TaskId> = storage
        .archive_done_tasks(stored.id)?
        .into_iter()
        .map(TaskId::from)
        .collect();
    let listed: Vec<String> = archived.iter().map(|task| format!("#{}", task.0)).collect();
    Ok(DoneTasksConfirmation {
        confirmed: true,
        workspace_id: request.workspace_id,
        message: format!(
            "{} done task(s) of workspace {id} \"{}\" are deleted and kept in the archive, where the user can restore them in the Toodo app: {}.",
            archived.len(),
            stored.name,
            listed.join(", "),
        ),
        task_ids: archived,
    })
}

/// Reopens a `done` task as the app's Reopen does (see [`task_commands::reopen`]), but only
/// with `confirm`; without it, the reopening is checked and the reply says what it would
/// do, and nothing changes.
pub fn reopen_task(storage: &mut Storage, request: ReopenTask) -> CommandResult<Confirmation> {
    let note = task_commands::reopen_note(storage, request.id, &request.reason)?;
    let id = request.id.0;
    if !request.confirm {
        let details = task_details(storage, GetTask { id: request.id })?;
        let task = details.task;
        let paused = if task.milestones.started_at.is_some() {
            " (paused on its branch, since it was started)"
        } else {
            ""
        };
        let mut message = format!(
            "Nothing changed yet. Reopening task {id} \"{}\" makes it planned again{paused}, clears its resolution and completion note, and records this progress note: {note}",
            task.title
        );
        let dependents = describe_links(&details.dependents);
        if !dependents.is_empty() {
            let wait = if details.dependents.len() == 1 {
                "waits"
            } else {
                "wait"
            };
            message.push_str(&format!(
                "\n{dependents} {wait} on it again until it is done."
            ));
        }
        message.push_str(&format!(
            "\nTo reopen it, call reopen_task again with the same reason and \"confirm\": true, e.g. {}.",
            serde_json::json!({"id": id, "reason": request.reason.trim(), "confirm": true})
        ));
        return Ok(Confirmation {
            confirmed: false,
            task,
            message,
        });
    }
    let task = task_commands::reopen(storage, request.id, &request.reason)?;
    let next = if task.milestones.started_at.is_some() {
        "call resume_task to continue it on its branch"
    } else {
        "call start_task to start it"
    };
    let message = format!("task {id} is reopened and planned; {next} once it is ready.");
    Ok(Confirmation {
        confirmed: true,
        task,
        message,
    })
}

/// A started task with the guidelines of its workspace, as start_task returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedTask {
    #[serde(flatten)]
    pub task: Task,
    /// The guidelines of the task's workspace, to read before working on it.
    pub guidelines: Vec<types::Guideline>,
}

/// Records the start of a ready task.
pub fn start_task(storage: &StorageState, request: StartTask) -> CommandResult<StartedTask> {
    let task = task_commands::start_task(
        State(storage),
        request.id,
        request.reason,
        Some(request.refs),
    )?;
    let guidelines = task_guidelines(&lock(storage), task.workspace_id)?;
    Ok(StartedTask { task, guidelines })
}

/// Completes a task after checking its completion criteria.
pub fn complete_task(storage: &StorageState, request: CompleteTask) -> CommandResult<Task> {
    Ok((&completion::complete(
        storage,
        request.id.into(),
        request.note.as_deref(),
        &request.refs,
    )?)
        .into())
}

/// A task concluded without merging, with the tasks that its conclusion leaves blocked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcludedTask {
    #[serde(flatten)]
    pub task: Task,
    /// Tasks that depend on the concluded task and stay blocked by it, since work that
    /// was not adopted is not there to build on.
    pub blocked_dependents: Vec<TaskLink>,
    /// What the conclusion means for those tasks and what to do next.
    pub message: String,
}

/// Records the outcome and completion note of a task.
pub fn conclude_task(
    storage: &StorageState,
    request: ConcludeTask,
) -> CommandResult<ConcludedTask> {
    let concluded = completion::conclude(
        storage,
        request.id.into(),
        &request.note,
        request.outcome.unwrap_or_default(),
        request.shipped_with.map(Into::into),
    )?;
    let links = Links::load(&lock(storage))?;
    let blocked_dependents = if concluded.resolution == Some(model::TaskResolution::NotAdopted) {
        links.links(links.dependents(concluded.id).filter(|id| {
            links
                .tasks
                .get(id)
                .is_some_and(|task| task.status != crate::domain::status::TaskStatus::Done)
        }))
    } else {
        Vec::new()
    };
    let message = if concluded.resolution == Some(model::TaskResolution::NotAdopted) {
        conclusion_message(concluded.id.0, &blocked_dependents)
    } else {
        format!(
            "task {} is done; call get_task to read its outcome and references",
            concluded.id
        )
    };
    Ok(ConcludedTask {
        task: (&concluded).into(),
        blocked_dependents,
        message,
    })
}

/// What concluding task `id` means for `dependents`, the tasks that depend on it.
fn conclusion_message(id: i64, dependents: &[TaskLink]) -> String {
    let Some(first) = dependents.first() else {
        return format!("task {id} is done as not_adopted; no task depends on it.");
    };
    format!(
        "task {id} is done as not_adopted, which blocks every task that depends on it: {}. For each, call remove_dependency (e.g. {{\"task_id\": {}, \"depends_on\": {id}}}) if it can go ahead without this work, or conclude_task {id} with outcome shipped_with and shipped_with set to the completed task id if another merged pull request shipped it.",
        describe_links(dependents),
        first.id.0
    )
}

const DEFAULT_SEARCH_LIMIT: u32 = 20;
const MAX_SEARCH_LIMIT: u32 = 100;

/// A task that search_tasks found, with its links to other tasks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: TaskId,
    pub workspace_id: WorkspaceId,
    /// The name of the task's workspace.
    pub workspace: String,
    pub task_type: TaskType,
    pub title: String,
    pub status: TaskStatus,
    pub resolution: Option<TaskResolution>,
    pub refs: Vec<String>,
    /// Tasks this task waits on.
    pub depends_on: Vec<TaskId>,
    /// Tasks that wait on this task.
    pub dependents: Vec<TaskId>,
    /// Related tasks, which neither wait on this task nor block it.
    pub related: Vec<TaskId>,
}

/// Another task linked to a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLink {
    pub id: TaskId,
    pub workspace_id: WorkspaceId,
    pub title: String,
    pub status: TaskStatus,
    pub resolution: Option<TaskResolution>,
}

/// A task with its whole history and its links, as get_task returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetails {
    /// The task: description, status timeline, notes, completion note (the conclusion
    /// of a task done as not_adopted), and pull request.
    pub task: Task,
    /// The name of the task's workspace.
    pub workspace: String,
    /// The commits recorded for the task, from its branch or its merged pull request.
    pub commits: Vec<CommitRecord>,
    /// Tasks this task waits on.
    pub depends_on: Vec<TaskLink>,
    /// Whether the task is planned and every task it depends on is done and adopted, so
    /// start_task (or resume_task for a paused task) can begin it now.
    pub ready: bool,
    /// The tasks of `dependsOn` that keep it from starting: not done yet, or done as
    /// not_adopted, which never unblocks it.
    pub blocked_by: Vec<TaskLink>,
    /// Tasks that wait on this task.
    pub dependents: Vec<TaskLink>,
    /// Related tasks, which neither wait on this task nor block it.
    pub related: Vec<TaskLink>,
    /// The guidelines of the task's workspace, to read before working on it: rules first,
    /// then memories.
    pub guidelines: Vec<types::Guideline>,
}

/// The links between all tasks: what each task waits on, what waits on it, and what
/// is related to it.
struct Links {
    tasks: HashMap<model::TaskId, model::Task>,
    workspaces: HashMap<model::WorkspaceId, String>,
    dependents: HashMap<model::TaskId, BTreeSet<model::TaskId>>,
    related: HashMap<model::TaskId, BTreeSet<model::TaskId>>,
}

impl Links {
    fn load(storage: &Storage) -> CommandResult<Self> {
        let tasks: HashMap<_, _> = storage
            .list_all_tasks()?
            .into_iter()
            .map(|task| (task.id, task))
            .collect();
        let mut dependents: HashMap<_, BTreeSet<_>> = HashMap::new();
        for task in tasks.values() {
            for &prerequisite in &task.depends_on {
                dependents.entry(prerequisite).or_default().insert(task.id);
            }
        }
        let mut related: HashMap<_, BTreeSet<_>> = HashMap::new();
        for (a, b) in storage.list_relations()? {
            related.entry(a).or_default().insert(b);
            related.entry(b).or_default().insert(a);
        }
        let workspaces = storage
            .list_workspaces()?
            .into_iter()
            .map(|workspace| (workspace.id, workspace.name))
            .collect();
        Ok(Self {
            tasks,
            workspaces,
            dependents,
            related,
        })
    }

    fn task(&self, id: model::TaskId) -> CommandResult<&model::Task> {
        Ok(self.tasks.get(&id).ok_or(StorageError::TaskNotFound(id))?)
    }

    fn workspace(&self, task: &model::Task) -> String {
        self.workspaces
            .get(&task.workspace_id)
            .cloned()
            .unwrap_or_default()
    }

    fn dependents(&self, id: model::TaskId) -> impl Iterator<Item = model::TaskId> + '_ {
        self.dependents.get(&id).into_iter().flatten().copied()
    }

    fn related(&self, id: model::TaskId) -> impl Iterator<Item = model::TaskId> + '_ {
        self.related.get(&id).into_iter().flatten().copied()
    }

    fn hit(&self, id: model::TaskId) -> CommandResult<SearchHit> {
        let task = self.task(id)?;
        Ok(SearchHit {
            id: id.into(),
            workspace_id: task.workspace_id.into(),
            workspace: self.workspace(task),
            task_type: task.task_type.into(),
            title: task.title.clone(),
            status: task.status.into(),
            resolution: task.resolution.map(TaskResolution::from),
            refs: task.refs.clone(),
            depends_on: task.depends_on.iter().copied().map(TaskId::from).collect(),
            dependents: self.dependents(id).map(TaskId::from).collect(),
            related: self.related(id).map(TaskId::from).collect(),
        })
    }

    /// The tasks `task` depends on that keep it from starting: not done, or done as not
    /// adopted.
    fn blocked_by(&self, task: &model::Task) -> Vec<TaskLink> {
        blocked_by(&self.tasks, task)
    }

    fn links(&self, ids: impl Iterator<Item = model::TaskId>) -> Vec<TaskLink> {
        task_links(&self.tasks, ids)
    }
}

/// The task number a query consists of, e.g. `431` or `#431`.
fn task_number(query: &str) -> Option<model::TaskId> {
    let query = query.trim();
    let digits = query.strip_prefix('#').unwrap_or(query);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().map(model::TaskId)
}

/// Tasks matching the query, best match first, each with its links. A query that is a
/// task number puts that task first, in any workspace, ahead of the text matches.
pub fn search_tasks(storage: &Storage, request: SearchTasks) -> CommandResult<Vec<SearchHit>> {
    if request.query.trim().is_empty() {
        return Err(CommandError::invalid_input("query must contain a word"));
    }
    if let Some(workspace) = request.workspace_id {
        storage
            .get_workspace(workspace.into())?
            .ok_or(StorageError::WorkspaceNotFound(workspace.into()))?;
    }
    let status = request.status.map(Into::into);
    let limit = request
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .min(MAX_SEARCH_LIMIT);
    let mut ids = storage.search_tasks(&TaskSearch {
        query: &request.query,
        workspace: request.workspace_id.map(Into::into),
        status,
        limit,
    })?;
    let links = Links::load(storage)?;
    let numbered = task_number(&request.query).filter(|id| {
        links
            .tasks
            .get(id)
            .is_some_and(|task| status.is_none_or(|status| task.status == status))
    });
    if let Some(id) = numbered {
        ids.retain(|other| *other != id);
        ids.insert(0, id);
        ids.truncate(limit as usize);
    }
    ids.into_iter().map(|id| links.hit(id)).collect()
}

/// A task with its history, commits, and the tasks it is linked to.
pub fn task_details(storage: &Storage, request: GetTask) -> CommandResult<TaskDetails> {
    let links = Links::load(storage)?;
    let id = request.id.into();
    let task = links.task(id)?;
    let blocked_by = links.blocked_by(task);
    Ok(TaskDetails {
        task: task.into(),
        workspace: links.workspace(task),
        commits: types::map_all(&storage.list_commit_records(id)?),
        depends_on: links.links(task.depends_on.iter().copied()),
        ready: is_ready(task, &blocked_by),
        blocked_by,
        dependents: links.links(links.dependents(id)),
        related: links.links(links.related(id)),
        guidelines: task_guidelines(storage, task.workspace_id.into())?,
    })
}

/// Links two tasks as related and returns the first with its links.
pub fn add_related(storage: &mut Storage, request: Related) -> CommandResult<TaskDetails> {
    storage.add_related(request.task_id.into(), request.related_id.into())?;
    task_details(
        storage,
        GetTask {
            id: request.task_id,
        },
    )
}

/// Removes the related link between two tasks and returns the first with its links.
pub fn remove_related(storage: &mut Storage, request: Related) -> CommandResult<TaskDetails> {
    storage.remove_related(request.task_id.into(), request.related_id.into())?;
    task_details(
        storage,
        GetTask {
            id: request.task_id,
        },
    )
}

pub(super) fn get_task(storage: &Storage, id: TaskId) -> CommandResult<Task> {
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    Ok((&task).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::CommandErrorKind;
    use crate::domain::model::{self};
    use crate::domain::status::TaskStatus as DomainStatus;
    use crate::storage::NewWorkspace;

    #[test]
    fn workspace_metadata_updates_keep_omitted_fields_and_clear_nulls() {
        let storage = StorageState::new(Storage::open_in_memory().unwrap());
        let created = create_workspace(&storage, serde_json::from_value(serde_json::json!({"name":"Planning", "description":"# Notes", "repository":"discord:tasks"})).unwrap()).unwrap();
        let updated = update_workspace(
            &storage,
            serde_json::from_value(serde_json::json!({"id":created.id,"name":"Renamed"})).unwrap(),
        )
        .unwrap();
        assert_eq!(updated.description.as_deref(), Some("# Notes"));
        assert_eq!(updated.repository.as_deref(), Some("discord:tasks"));
        let cleared = update_workspace(
            &storage,
            serde_json::from_value(
                serde_json::json!({"id":created.id,"description":null,"repository":null}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(cleared.name, "Renamed");
        assert_eq!(cleared.description, None);
        assert_eq!(cleared.repository, None);
        let fields = serde_json::to_value(&cleared)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            fields,
            ["id", "name", "description", "repository", "archivedAt"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
    }

    fn storage_with_workspace() -> (Storage, WorkspaceId) {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                description: None,
                repository: None,
            })
            .unwrap();
        (storage, workspace.id.into())
    }

    /// Agents started before the lead was removed may still send `request_id`; it is
    /// ignored rather than failing the call.
    #[test]
    fn create_and_start_ignore_a_request_id() {
        let create = serde_json::from_value::<CreateTask>(serde_json::json!({
            "workspace_id": 1, "task_type": "feat", "title": "Add login",
            "request_id": "chat-12/create-1"
        }))
        .unwrap();
        assert_eq!(create.title, "Add login");
        let start = serde_json::from_value::<StartTask>(serde_json::json!({
            "id": 7, "request_id": "event-40/start-7"
        }))
        .unwrap();
        assert_eq!(start.id, TaskId(7));
    }

    fn create(
        storage: &mut Storage,
        workspace: WorkspaceId,
        title: &str,
        depends_on: Vec<TaskId>,
    ) -> CommandResult<Task> {
        insert_task(
            storage,
            CreateTask {
                refs: Vec::new(),
                workspace_id: workspace,
                task_type: TaskType::Feat,
                title: title.to_owned(),
                description: String::new(),
                depends_on,
                related: Vec::new(),
                estimate: None,
                due_date: None,
                autopilot: false,
                labels: Vec::new(),
                criteria: vec![types::CriterionInput {
                    id: None,
                    text: Some("Reviewed".to_owned()),
                    kind: Some(types::CheckKind::Manual),
                    target: None,
                }],

                request_id: None,
            },
        )
    }

    #[test]
    fn creates_a_task_with_its_dependencies() {
        let (mut storage, workspace) = storage_with_workspace();
        let first = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        let second = create(&mut storage, workspace, "API", vec![first.id]).unwrap();
        assert_eq!(second.depends_on, vec![first.id]);
        assert_eq!(second.status, types::TaskStatus::Planned);
        let stored = storage.get_task(second.id.into()).unwrap().unwrap();
        assert_eq!(Task::from(&stored), second);
    }

    #[test]
    fn an_unknown_prerequisite_or_empty_title_creates_nothing() {
        let (mut storage, workspace) = storage_with_workspace();
        let error = create(&mut storage, workspace, "API", vec![TaskId(42)]).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        let error = create(&mut storage, workspace, "  ", vec![]).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(storage.list_all_tasks().unwrap().is_empty());
    }

    #[test]
    fn a_dependency_that_closes_a_cycle_is_rejected() {
        let (mut storage, workspace) = storage_with_workspace();
        let first = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        let second = create(&mut storage, workspace, "API", vec![first.id]).unwrap();
        let request = AddDependencies {
            task_id: first.id,
            depends_on: vec![second.id],
        };
        let error = add_dependencies(&mut storage, request.clone()).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("cycle"), "{}", error.message);
        assert!(get_task(&storage, first.id).unwrap().depends_on.is_empty());

        let removed = remove_dependency(
            &mut storage,
            Dependency {
                task_id: second.id,
                depends_on: vec![first.id],
            },
        )
        .unwrap();
        assert!(removed.task.task.depends_on.is_empty());
        assert!(removed.task.ready);
        assert_eq!(
            add_dependencies(&mut storage, request)
                .unwrap()
                .task
                .task
                .depends_on,
            vec![second.id]
        );
    }

    #[test]
    fn removing_a_dependency_that_does_not_exist_removes_none() {
        let (mut storage, workspace) = storage_with_workspace();
        let first = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        let other = create(&mut storage, workspace, "Docs", vec![]).unwrap();
        let second = create(&mut storage, workspace, "API", vec![first.id]).unwrap();

        let error = remove_dependency(
            &mut storage,
            Dependency {
                task_id: second.id,
                depends_on: vec![first.id, other.id],
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        assert!(
            error.message.starts_with(&format!(
                "task {} does not depend on {}; get_task {}",
                second.id.0, other.id.0, second.id.0
            )),
            "{}",
            error.message
        );
        assert_eq!(
            get_task(&storage, second.id).unwrap().depends_on,
            [first.id]
        );
    }

    #[test]
    fn adds_several_prerequisites_at_once_and_needs_at_least_one() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
        let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
        let docs = create(&mut storage, workspace, "Fix docs", vec![]).unwrap();

        let error = add_dependencies(
            &mut storage,
            AddDependencies {
                task_id: task.id,
                depends_on: vec![],
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        let updated = add_dependencies(
            &mut storage,
            AddDependencies {
                task_id: task.id,
                depends_on: vec![fix.id, docs.id],
            },
        )
        .unwrap();
        assert_eq!(updated.task.task.depends_on, vec![fix.id, docs.id]);
        assert!(!updated.paused);
        assert_eq!(
            updated.message,
            format!(
                "task {} waits for #{} (planned), #{} (planned) before it can start.",
                task.id.0, fix.id.0, docs.id.0
            )
        );
    }

    #[test]
    fn a_done_task_gets_no_new_prerequisites() {
        use crate::domain::status::TaskStatus;
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
        let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
        for status in [
            TaskStatus::InProgress,
            TaskStatus::InReview,
            TaskStatus::Done,
        ] {
            storage.set_task_status(task.id.into(), status).unwrap();
        }

        let error = add_dependencies(
            &mut storage,
            AddDependencies {
                task_id: task.id,
                depends_on: vec![fix.id],
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.ends_with(&format!(
                "create a follow-up task with create_task and depends_on [{}]",
                fix.id.0
            )),
            "{}",
            error.message
        );
        assert!(get_task(&storage, task.id).unwrap().depends_on.is_empty());
    }

    #[test]
    fn a_prerequisite_of_a_task_in_review_does_not_pause_it_and_says_so() {
        use crate::domain::status::TaskStatus;
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
        let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
        for status in [TaskStatus::InProgress, TaskStatus::InReview] {
            storage.set_task_status(task.id.into(), status).unwrap();
        }

        let reply = add_dependencies(
            &mut storage,
            AddDependencies {
                task_id: task.id,
                depends_on: vec![fix.id],
            },
        )
        .unwrap();
        assert!(!reply.paused);
        assert_eq!(reply.task.task.status, types::TaskStatus::InReview);
        assert!(
            reply.message.contains("not paused") && reply.message.contains("call pause_task"),
            "{}",
            reply.message
        );
    }

    #[test]
    fn a_blocking_prerequisite_pauses_the_task_and_history_allows_resuming() {
        use crate::domain::status::TaskStatus;
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
        let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
        storage
            .set_task_status(task.id.into(), TaskStatus::InProgress)
            .unwrap();

        let reply = add_dependencies(
            &mut storage,
            AddDependencies {
                task_id: task.id,
                depends_on: vec![fix.id],
            },
        )
        .unwrap();

        let paused = storage.get_task(task.id.into()).unwrap().unwrap();
        assert_eq!(paused.status, TaskStatus::Planned);
        assert!(reply.paused);
        assert!(!reply.task.ready);
        assert_eq!(reply.task.depends_on[0].title, "Fix login");
        assert_eq!(reply.task.blocked_by, reply.task.depends_on);
        assert!(
            reply.message.starts_with(&format!(
                "task {} is paused until #{} (planned) is done",
                task.id.0, fix.id.0
            )),
            "{}",
            reply.message
        );
        let json = serde_json::to_value(&reply).unwrap();
        assert_eq!(json["paused"], true);
        assert_eq!(json["task"]["dependsOn"][0]["title"], "Fix login");
        assert_eq!(json["task"]["blockedBy"][0]["status"], "planned");

        // Removing the last blocker leaves a paused task that resume_task resumes.
        let mut branched = paused;
        branched.description = "Verification work".to_owned();
        storage.update_task(&branched).unwrap();
        let reply = remove_dependency(
            &mut storage,
            Dependency {
                task_id: task.id,
                depends_on: vec![fix.id],
            },
        )
        .unwrap();
        assert!(reply.task.ready);
        assert!(
            reply.message.ends_with("resume_task resumes it."),
            "{}",
            reply.message
        );
    }

    #[test]
    fn update_changes_only_the_given_fields() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        let updated = update_task(
            &mut storage,
            UpdateTask {
                status: None,
                refs: None,
                remove_refs: None,
                id: task.id,
                task_type: None,
                title: None,
                description: Some("Add tables".to_owned()),
                estimate: None,
                due_date: None,
                labels: None,
                autopilot: None,
                criteria: None,
            },
        )
        .unwrap();
        assert_eq!(updated.title, "Schema");
        assert_eq!(updated.task_type, TaskType::Feat);
        assert_eq!(updated.description, "Add tables");
    }

    #[test]
    fn update_leaves_a_done_task_as_it_was_finished() {
        use crate::domain::status::TaskStatus::{Done, InProgress, InReview};
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        for status in [InProgress, InReview, Done] {
            storage.set_task_status(task.id.into(), status).unwrap();
        }
        let done = get_task(&storage, task.id).unwrap();

        let error = update(
            &mut storage,
            serde_json::json!({ "id": task.id, "title": "Renamed", "description": "Other" }),
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("add_progress_note"),
            "{}",
            error.message
        );
        assert_eq!(get_task(&storage, task.id).unwrap(), done);
    }

    fn update(storage: &mut Storage, request: serde_json::Value) -> CommandResult<Task> {
        update_task(storage, serde_json::from_value(request).unwrap())
    }

    #[test]
    fn add_criterion_appends_one_and_keeps_the_others_with_their_evidence() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = task_with_checked_criterion(&mut storage, workspace);
        let added = add_criterion(&mut storage, serde_json::from_value(serde_json::json!({"task_id":task.id,"text":"Deployed", "kind":"url","target":"https://example.com"})).unwrap()).unwrap();
        assert_eq!(added.criteria[..2], task.criteria[..]);
        assert_eq!(added.criteria[2].kind, types::CheckKind::Url);
        assert_eq!(
            added.criteria[2].target.as_deref(),
            Some("https://example.com")
        );
        assert_eq!(added.criteria[2].state, types::CriterionState::Pending);
        for kind in [
            "pr_merged",
            "pr_open_ci_green",
            "branch_merged_locally",
            "command",
        ] {
            assert!(
                serde_json::from_value::<AddCriterion>(
                    serde_json::json!({"task_id":task.id,"text":"Removed", "kind":kind})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn remove_criterion_deletes_only_that_one() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = task_with_checked_criterion(&mut storage, workspace);
        let other = create(&mut storage, workspace, "Other", vec![]).unwrap();
        let remove = |storage: &mut Storage, request: serde_json::Value| {
            remove_criterion(storage, serde_json::from_value(request).unwrap())
        };
        let manual = task.criteria[1].id.0;
        let error = remove(
            &mut storage,
            serde_json::json!({ "task_id": other.id, "criterion_id": manual }),
        )
        .unwrap_err();
        assert!(
            error.message.contains("belongs to task"),
            "{}",
            error.message
        );
        let error = remove(&mut storage, serde_json::json!({ "criterion_id": 999 })).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);

        let removed = remove(&mut storage, serde_json::json!({ "id": manual })).unwrap();
        assert_eq!(removed.criteria, task.criteria[..1]);
        // Naming the merge criterion removes it deliberately.
        let merge = task.criteria[0].id.0;
        let removed = remove(&mut storage, serde_json::json!({ "criterion_id": merge })).unwrap();
        assert!(removed.criteria.is_empty());
        assert_eq!(get_task(&storage, other.id).unwrap().criteria.len(), 1);
    }

    fn check(storage: &mut Storage, request: serde_json::Value) -> CommandResult<Task> {
        check_criterion(storage, serde_json::from_value(request).unwrap())
    }

    /// A task with the merge criterion and a manual one checked with evidence.
    fn task_with_checked_criterion(storage: &mut Storage, workspace: WorkspaceId) -> Task {
        let task = create(storage, workspace, "Schema", vec![]).unwrap();
        let merge = task.criteria[0].id.0;
        let task = update(
            storage,
            serde_json::json!({ "id": task.id, "criteria": [
                { "id": merge }, { "text": "Docs updated", "kind": "manual" }
            ]}),
        )
        .unwrap();
        let manual = task.criteria[1].id.0;
        check(
            storage,
            serde_json::json!({ "id": manual, "evidence": "docs/guide.md" }),
        )
        .unwrap()
    }

    #[test]
    fn criteria_given_by_id_alone_are_kept_with_their_evidence() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = task_with_checked_criterion(&mut storage, workspace);
        let [merge, manual] = [task.criteria[0].id.0, task.criteria[1].id.0];
        let kept = update(
            &mut storage,
            serde_json::json!({ "id": task.id, "criteria": [
                { "id": merge }, { "id": manual }, { "text": "Released", "kind": "manual" }
            ]}),
        )
        .unwrap();
        assert_eq!(kept.criteria[..2], task.criteria[..]);
        assert_eq!(kept.criteria[2].text, "Released");
        let renamed = update(
            &mut storage,
            serde_json::json!({ "id": task.id, "criteria": [
                { "id": merge }, { "id": manual, "text": "Guide updated" }
            ]}),
        )
        .unwrap();
        assert_eq!(renamed.criteria[1].text, "Guide updated");
        assert_eq!(renamed.criteria[1].state, types::CriterionState::Met);
        assert_eq!(
            renamed.criteria[1].evidence.as_deref(),
            Some("docs/guide.md")
        );

        let error = update(
            &mut storage,
            serde_json::json!({ "id": task.id, "criteria": [
                { "id": merge }, { "text": "No kind" }
            ]}),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(
            error.message.contains("needs text and kind"),
            "{}",
            error.message
        );
    }

    #[test]
    fn criteria_with_a_repeated_or_foreign_id_are_rejected() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = task_with_checked_criterion(&mut storage, workspace);
        let other = create(&mut storage, workspace, "API", vec![]).unwrap();
        let merge = task.criteria[0].id.0;
        let error = update(
            &mut storage,
            serde_json::json!({ "id": task.id, "criteria": [{ "id": merge }, { "id": merge }] }),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert_eq!(
            error.message,
            format!("criterion {merge} appears twice; send each criterion once")
        );
        let foreign = other.criteria[0].id.0;
        let error = update(
            &mut storage,
            serde_json::json!({ "id": task.id, "criteria": [{ "id": merge }, { "id": foreign }] }),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(
            error.message.starts_with(&format!(
                "criterion {foreign} belongs to task {}, not task {}; call get_task",
                other.id.0, task.id.0
            )),
            "{}",
            error.message
        );
        assert_eq!(get_task(&storage, task.id).unwrap().criteria, task.criteria);
    }

    #[test]
    fn criteria_can_be_removed_by_omitting_them_from_the_new_list() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = task_with_checked_criterion(&mut storage, workspace);
        let manual = task.criteria[1].id;
        let removed = update(
            &mut storage,
            serde_json::json!({"id": task.id, "criteria": [{"id": manual}]}),
        )
        .unwrap();
        assert_eq!(removed.criteria, task.criteria[1..]);
    }

    #[test]
    fn check_criterion_finds_the_task_of_the_criterion() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = task_with_checked_criterion(&mut storage, workspace);
        let other = create(&mut storage, workspace, "API", vec![]).unwrap();
        let manual = task.criteria[1].id.0;
        assert_eq!(task.criteria[1].state, types::CriterionState::Met);
        assert_eq!(task.criteria[1].evidence.as_deref(), Some("docs/guide.md"));

        let error = check(
            &mut storage,
            serde_json::json!({ "task_id": other.id, "criterion_id": manual, "met": false }),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(
            error.message.starts_with(&format!(
                "criterion {manual} belongs to task {}, not task {}",
                task.id.0, other.id.0
            )),
            "{}",
            error.message
        );
        let unchecked = check(
            &mut storage,
            serde_json::json!({ "task_id": task.id, "criterion_id": manual, "met": false }),
        )
        .unwrap();
        assert_eq!(unchecked.criteria[1].state, types::CriterionState::Pending);
        let error = check(
            &mut storage,
            serde_json::json!({ "id": 999, "evidence": "x" }),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
    }

    #[test]
    fn depends_on_takes_one_task_id_or_an_array() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
        let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
        let docs = create(&mut storage, workspace, "Fix docs", vec![]).unwrap();
        let add = |depends_on: serde_json::Value| -> AddDependencies {
            serde_json::from_value(
                serde_json::json!({ "task_id": task.id, "depends_on": depends_on }),
            )
            .unwrap()
        };
        let remove = |depends_on: serde_json::Value| -> Dependency {
            serde_json::from_value(
                serde_json::json!({ "task_id": task.id, "depends_on": depends_on }),
            )
            .unwrap()
        };
        add_dependencies(&mut storage, add(serde_json::json!(fix.id))).unwrap();
        let both = add_dependencies(&mut storage, add(serde_json::json!([docs.id]))).unwrap();
        assert_eq!(both.task.task.depends_on, vec![fix.id, docs.id]);
        let one = remove_dependency(&mut storage, remove(serde_json::json!(fix.id))).unwrap();
        assert_eq!(one.task.task.depends_on, vec![docs.id]);
        add_dependencies(&mut storage, add(serde_json::json!(fix.id))).unwrap();
        let none =
            remove_dependency(&mut storage, remove(serde_json::json!([fix.id, docs.id]))).unwrap();
        assert!(none.task.task.depends_on.is_empty());

        let error = serde_json::from_value::<Dependency>(
            serde_json::json!({ "task_id": 1, "depends_on": "2" }),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("a task id or an array of task ids"),
            "{error}"
        );
    }

    #[test]
    fn estimates_and_due_dates_are_set_kept_when_omitted_and_cleared_by_null() {
        let (mut storage, workspace) = storage_with_workspace();
        let request: CreateTask = serde_json::from_value(serde_json::json!({
            "workspace_id": workspace,
            "task_type": "feat",
            "title": "Schema",
            "estimate": { "unit": "hours", "amount": 2.5 },
            "due_date": "2026-10-20",
        }))
        .unwrap();
        let task = insert_task(&mut storage, request).unwrap();
        let planned = Some(Estimate {
            unit: types::EstimateUnit::Hours,
            amount: 2.5,
        });
        assert_eq!(task.estimate, planned);
        assert_eq!(task.due_date.as_deref(), Some("2026-10-20"));

        let update = |storage: &mut Storage, fields: serde_json::Value| {
            let mut request = serde_json::json!({ "id": task.id });
            request
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            update_task(storage, serde_json::from_value(request).unwrap())
        };
        let kept = update(&mut storage, serde_json::json!({ "title": "Tables" })).unwrap();
        assert_eq!(
            (kept.estimate, kept.due_date.as_deref()),
            (planned, Some("2026-10-20"))
        );
        let weeks = update(
            &mut storage,
            serde_json::json!({ "estimate": { "unit": "weeks", "amount": 3 }, "due_date": null }),
        )
        .unwrap();
        assert_eq!(
            (weeks.estimate, weeks.due_date),
            (
                Some(Estimate {
                    unit: types::EstimateUnit::Weeks,
                    amount: 3.0
                }),
                None
            )
        );
        let cleared = update(&mut storage, serde_json::json!({ "estimate": null })).unwrap();
        assert_eq!(cleared.estimate, None);
        assert_eq!(
            Task::from(&storage.get_task(task.id.into()).unwrap().unwrap()),
            cleared
        );

        for invalid in [
            serde_json::json!({ "due_date": "2026-02-30" }),
            serde_json::json!({ "estimate": { "unit": "hours", "amount": 0 } }),
        ] {
            let error = update(&mut storage, invalid.clone()).unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::InvalidInput, "{invalid}");
        }
        assert_eq!(
            Task::from(&storage.get_task(task.id.into()).unwrap().unwrap()),
            cleared
        );
    }

    #[test]
    fn autopilot_is_set_on_create_listed_by_filter_kept_when_marked_again_and_cleared() {
        let (mut storage, workspace) = storage_with_workspace();
        let plain = create(&mut storage, workspace, "Plain", vec![]).unwrap();
        assert_eq!((plain.autopilot, plain.autopilot_at), (false, None));
        let request: CreateTask = serde_json::from_value(serde_json::json!({
            "workspace_id": workspace,
            "task_type": "feat",
            "title": "Flagged",
            "autopilot": true,
        }))
        .unwrap();
        let flagged = insert_task(&mut storage, request).unwrap();
        assert!(flagged.autopilot);
        let since = flagged.autopilot_at.expect("a marked task records when");

        let listed = |storage: &Storage, autopilot: Option<bool>| -> Vec<TaskId> {
            let request = ListTasks {
                autopilot,
                ..ListTasks::default()
            };
            list_tasks(storage, request)
                .unwrap()
                .into_iter()
                .map(|listed| listed.task.id)
                .collect()
        };
        assert_eq!(listed(&storage, Some(true)), [flagged.id]);
        assert_eq!(listed(&storage, Some(false)), [plain.id]);
        assert_eq!(listed(&storage, None), [plain.id, flagged.id]);

        let update = |storage: &mut Storage, id: TaskId, fields: serde_json::Value| {
            let mut request = serde_json::json!({ "id": id });
            request
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            update_task(storage, serde_json::from_value(request).unwrap()).unwrap()
        };
        let renamed = update(
            &mut storage,
            flagged.id,
            serde_json::json!({ "title": "Still" }),
        );
        assert_eq!(renamed.autopilot_at, Some(since));
        let again = update(
            &mut storage,
            flagged.id,
            serde_json::json!({ "autopilot": true }),
        );
        assert_eq!(again.autopilot_at, Some(since));
        let cleared = update(
            &mut storage,
            flagged.id,
            serde_json::json!({ "autopilot": false }),
        );
        assert_eq!((cleared.autopilot, cleared.autopilot_at), (false, None));
        let marked = update(
            &mut storage,
            plain.id,
            serde_json::json!({ "autopilot": true }),
        );
        assert!(marked.autopilot && marked.autopilot_at.is_some());
        assert_eq!(listed(&storage, Some(true)), [plain.id]);

        let created = create_plan(
            &StorageState::new(storage),
            plan(serde_json::json!([
                { "key": "a", "workspace_id": workspace, "task_type": "feat", "title": "A", "autopilot": true },
                { "key": "b", "workspace_id": workspace, "task_type": "feat", "title": "B" },
            ])),
        )
        .unwrap();
        let flags: Vec<bool> = created
            .tasks
            .iter()
            .map(|planned| planned.task.autopilot)
            .collect();
        assert_eq!(flags, [true, false]);
    }

    fn plan(tasks: serde_json::Value) -> CreatePlan {
        serde_json::from_value(serde_json::json!({ "tasks": tasks })).unwrap()
    }

    #[test]
    fn delete_task_deletes_a_planned_or_done_task_only_when_confirmed() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
        let dependent = create(&mut storage, workspace, "Use login", vec![task.id]).unwrap();
        let done = create(&mut storage, workspace, "Ship login", vec![]).unwrap();
        storage
            .set_task_status(done.id.into(), DomainStatus::InProgress)
            .unwrap();
        storage
            .conclude_task(done.id.into(), "Not needed", None)
            .unwrap();
        let storage = std::sync::Arc::new(StorageState::new(storage));
        let delete = |id: TaskId, confirm: bool| delete_task(&storage, DeleteTask { id, confirm });

        let preview = delete(task.id, false).unwrap();
        assert!(!preview.confirmed);
        assert!(
            preview.message.contains("\"confirm\": true"),
            "{}",
            preview.message
        );
        assert!(
            preview.message.contains("#2 (planned)"),
            "{}",
            preview.message
        );
        assert!(lock(&storage).get_task(task.id.into()).unwrap().is_some());

        let deleted = delete(task.id, true).unwrap();
        assert!(deleted.confirmed);
        assert_eq!(deleted.task.id, task.id);
        let storage_now = lock(&storage);
        assert!(storage_now.get_task(task.id.into()).unwrap().is_none());
        let dependent = storage_now.get_task(dependent.id.into()).unwrap().unwrap();
        assert!(dependent.depends_on.is_empty());
        drop(storage_now);

        let preview = delete(done.id, false).unwrap();
        assert!(!preview.confirmed);
        assert!(lock(&storage).get_task(done.id.into()).unwrap().is_some());
        let deleted = delete(done.id, true).unwrap();
        assert!(deleted.confirmed);
        assert!(lock(&storage).get_task(done.id.into()).unwrap().is_none());

        let active = create(&mut lock(&storage), workspace, "Fix login", vec![]).unwrap();
        lock(&storage)
            .set_task_status(active.id.into(), DomainStatus::InProgress)
            .unwrap();
        let error = delete(active.id, true).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("pause_task"), "{}", error.message);
        assert!(lock(&storage).get_task(active.id.into()).unwrap().is_some());
    }

    #[test]
    fn delete_done_tasks_archives_the_done_tasks_of_a_workspace_only_when_confirmed() {
        let (mut storage, workspace) = storage_with_workspace();
        let planned = create(&mut storage, workspace, "Add login", vec![]).unwrap();
        let first = create(&mut storage, workspace, "Ship login", vec![]).unwrap();
        let second = create(&mut storage, workspace, "Drop signup", vec![]).unwrap();
        for task in [&first, &second] {
            storage
                .set_task_status(task.id.into(), DomainStatus::InProgress)
                .unwrap();
            storage
                .conclude_task(task.id.into(), "Not needed", None)
                .unwrap();
        }
        let delete = |storage: &mut Storage, confirm: bool| {
            delete_done_tasks(
                storage,
                DeleteDoneTasks {
                    workspace_id: workspace,
                    confirm,
                },
            )
        };

        let preview = delete(&mut storage, false).unwrap();
        assert!(!preview.confirmed);
        assert_eq!(preview.task_ids, [first.id, second.id]);
        assert!(
            preview.message.contains("#2 Ship login, #3 Drop signup")
                && preview.message.contains("\"confirm\": true"),
            "{}",
            preview.message
        );
        assert!(storage.get_task(first.id.into()).unwrap().is_some());

        let deleted = delete(&mut storage, true).unwrap();
        assert!(deleted.confirmed);
        assert_eq!(deleted.task_ids, [first.id, second.id]);
        assert!(deleted.message.contains("#2, #3"), "{}", deleted.message);
        assert!(storage.get_task(first.id.into()).unwrap().is_none());
        assert!(storage.get_task(second.id.into()).unwrap().is_none());
        assert!(storage.get_task(planned.id.into()).unwrap().is_some());

        let none = delete(&mut storage, true).unwrap();
        assert!(!none.confirmed);
        assert!(none.task_ids.is_empty());
        assert!(none.message.contains("list_tasks"), "{}", none.message);

        let error = delete_done_tasks(
            &mut storage,
            DeleteDoneTasks {
                workspace_id: WorkspaceId(99),
                confirm: true,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, CommandErrorCode::WorkspaceNotFound);
        assert!(
            error.message.contains("list_workspaces"),
            "{}",
            error.message
        );
    }

    #[test]
    fn archive_workspace_archives_only_when_confirmed_and_nothing_is_worked_on() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
        storage
            .set_task_status(task.id.into(), DomainStatus::InProgress)
            .unwrap();
        let archive = |storage: &mut Storage, confirm: bool| {
            archive_workspace(
                storage,
                ArchiveWorkspace {
                    id: workspace,
                    confirm,
                },
            )
        };

        let error = archive(&mut storage, true).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("#1 (in_progress)") && error.message.contains("pause_task"),
            "{}",
            error.message
        );
        assert_eq!(list_workspaces(&storage).unwrap().len(), 1);

        storage
            .conclude_task(task.id.into(), "Not needed", None)
            .unwrap();
        let preview = archive(&mut storage, false).unwrap();
        assert!(!preview.confirmed);
        assert!(
            preview.message.contains("\"confirm\": true"),
            "{}",
            preview.message
        );
        assert_eq!(list_workspaces(&storage).unwrap().len(), 1);

        let archived = archive(&mut storage, true).unwrap();
        assert!(archived.confirmed);
        assert_eq!(archived.workspace.id, workspace);
        assert!(list_workspaces(&storage).unwrap().is_empty());
        let kept = storage.archived_workspaces().unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(
            storage
                .review_tasks()
                .unwrap()
                .iter()
                .filter(|stored| stored.id == task.id.into())
                .count(),
            1
        );

        let again = archive(&mut storage, true).unwrap_err();
        assert_eq!(again.code, CommandErrorCode::WorkspaceNotFound);
        assert!(
            again.message.contains("list_workspaces"),
            "{}",
            again.message
        );
    }

    #[test]
    fn reopen_task_reopens_a_done_task_only_when_confirmed() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
        storage
            .set_task_status(task.id.into(), DomainStatus::InProgress)
            .unwrap();
        storage
            .conclude_task(task.id.into(), "Too slow", None)
            .unwrap();
        let reopen = |storage: &mut Storage, reason: &str, confirm: bool| {
            reopen_task(
                storage,
                ReopenTask {
                    id: task.id,
                    reason: reason.to_owned(),
                    confirm,
                },
            )
        };

        let error = reopen(&mut storage, " ", false).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        let preview = reopen(&mut storage, "Faster now", false).unwrap();
        assert!(!preview.confirmed);
        assert_eq!(preview.task.status, TaskStatus::Done);
        assert!(
            preview.message.contains("Reopened: Faster now"),
            "{}",
            preview.message
        );
        assert!(
            preview.message.contains("\"confirm\":true"),
            "{}",
            preview.message
        );
        let stored = storage.get_task(task.id.into()).unwrap().unwrap();
        assert_eq!(stored.status, DomainStatus::Done);

        let reopened = reopen(&mut storage, "Faster now", true).unwrap();
        assert!(reopened.confirmed);
        assert_eq!(reopened.task.status, TaskStatus::Planned);
        assert_eq!(reopened.task.resolution, None);
        assert!(reopen(&mut storage, "Faster now", false).is_err());
    }

    #[test]
    fn create_plan_creates_every_task_with_its_links() {
        let (mut storage, workspace) = storage_with_workspace();
        let existing = storage
            .create_task(&crate::storage::NewTask {
                workspace_id: workspace.into(),
                task_type: model::TaskType::Feat,
                title: "Earlier work".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                autopilot: false,
                criteria: Vec::new(),
            })
            .unwrap()
            .id;
        let storage = StorageState::new(storage);
        let created = create_plan(
            &storage,
            plan(serde_json::json!([
                {"key": "ui", "workspace_id": workspace, "task_type": "feat", "title": "UI",
                 "depends_on_keys": ["api"], "depends_on": [existing.0],
                 "related_keys": ["schema"]},
                {"key": "schema", "workspace_id": workspace, "task_type": "feat",
                 "title": "Schema", "labels": ["search"],
                 "criteria": [{"text": "Migrated", "kind": "manual"}]},
                {"key": "api", "workspace_id": workspace, "task_type": "feat", "title": "API",
                 "depends_on_keys": ["schema"], "related": [existing.0]},
            ])),
        )
        .unwrap();

        let keys: Vec<&str> = created.tasks.iter().map(|t| t.key.as_str()).collect();
        assert_eq!(keys, ["ui", "schema", "api"]);
        let [ui, schema, api] = [0, 1, 2].map(|i| &created.tasks[i].task);
        let mut ui_depends_on = ui.depends_on.clone();
        ui_depends_on.sort_by_key(|id| id.0);
        assert_eq!(ui_depends_on, [TaskId(existing.0), api.id]);
        assert_eq!(api.depends_on, [schema.id]);
        assert!(schema.depends_on.is_empty());
        assert_eq!(schema.labels, ["search"]);
        assert_eq!(schema.criteria.len(), 1);
        assert!(api.criteria.is_empty());
        let mut relations = lock(&storage).list_relations().unwrap();
        relations.sort();
        let pair =
            |a: TaskId, b: TaskId| (model::TaskId(a.0.min(b.0)), model::TaskId(a.0.max(b.0)));
        let mut expected = vec![pair(ui.id, schema.id), pair(api.id, TaskId(existing.0))];
        expected.sort();
        assert_eq!(relations, expected);
    }

    #[test]
    fn create_plan_creates_nothing_when_any_task_fails() {
        let (storage, workspace) = storage_with_workspace();
        let storage = StorageState::new(storage);
        let first = serde_json::json!(
            {"key": "schema", "workspace_id": workspace, "task_type": "feat", "title": "Schema"}
        );
        let last = |fields: serde_json::Value| {
            let mut task = serde_json::json!(
                {"key": "api", "workspace_id": workspace, "task_type": "feat", "title": "API"}
            );
            task.as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            task
        };
        let cases = [
            (
                "unknown task",
                last(serde_json::json!({"depends_on": [999]})),
            ),
            (
                "unknown related task",
                last(serde_json::json!({"related": [999]})),
            ),
            (
                "unknown key",
                last(serde_json::json!({"depends_on_keys": ["ui"]})),
            ),
            (
                "own key",
                last(serde_json::json!({"related_keys": ["api"]})),
            ),
            ("repeated key", last(serde_json::json!({"key": "schema"}))),
            ("empty key", last(serde_json::json!({"key": " "}))),
            (
                "unknown workspace",
                last(serde_json::json!({"workspace_id": 999})),
            ),
            ("bad label", last(serde_json::json!({"labels": ["a,b"]}))),
            (
                "bad due date",
                last(serde_json::json!({"due_date": "tomorrow"})),
            ),
            ("empty title", last(serde_json::json!({"title": " "}))),
        ];
        for (name, task) in cases {
            let error = create_plan(&storage, plan(serde_json::json!([first, task])));
            assert!(error.is_err(), "{name}");
            assert_eq!(lock(&storage).list_all_tasks().unwrap(), [], "{name}");
        }

        let cycle = plan(serde_json::json!([
            first,
            last(serde_json::json!({"depends_on_keys": ["ui"]})),
            {"key": "ui", "workspace_id": workspace, "task_type": "feat", "title": "UI",
             "depends_on_keys": ["api", "schema"]},
        ]));
        let error = create_plan(&storage, cycle).unwrap_err();
        assert!(error.message.contains("`api`, `ui`"), "{}", error.message);
        assert!(create_plan(&storage, plan(serde_json::json!([]))).is_err());
        assert_eq!(lock(&storage).list_all_tasks().unwrap(), []);
    }

    /// The tasks of a plan are written in one transaction: a failure after the first task
    /// is inserted rolls it back.
    #[test]
    fn create_tasks_rolls_back_every_task_on_a_failure() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = |workspace: i64| crate::storage::NewTask {
            workspace_id: model::WorkspaceId(workspace),
            task_type: model::TaskType::Feat,
            title: "Task".to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            autopilot: false,
            criteria: Vec::new(),
        };
        let item = |task, depends_on| crate::storage::NewPlanTask {
            refs: Vec::new(),
            task,
            labels: vec!["search".to_owned()],
            depends_on,
            related: Vec::new(),
        };
        for failing in [
            item(task(999), Vec::new()),
            item(
                task(workspace.0),
                vec![crate::storage::PlanLink::Existing(model::TaskId(999))],
            ),
        ] {
            let plan = [item(task(workspace.0), Vec::new()), failing];
            assert!(storage.create_tasks(&plan).is_err());
            assert_eq!(storage.list_all_tasks().unwrap(), []);
        }
    }

    #[test]
    fn labels_are_set_kept_when_omitted_replaced_and_cleared() {
        let (mut storage, workspace) = storage_with_workspace();
        let request: CreateTask = serde_json::from_value(serde_json::json!({
            "workspace_id": workspace,
            "task_type": "feat",
            "title": "Schema",
            "labels": [" search ", "q4-goal", "search"],
        }))
        .unwrap();
        let task = insert_task(&mut storage, request).unwrap();
        assert_eq!(task.labels, ["q4-goal", "search"]);

        let update = |storage: &mut Storage, fields: serde_json::Value| {
            let mut request = serde_json::json!({ "id": task.id });
            request
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            update_task(storage, serde_json::from_value(request).unwrap())
        };
        let kept = update(&mut storage, serde_json::json!({ "title": "Tables" })).unwrap();
        assert_eq!(kept.labels, ["q4-goal", "search"]);
        let replaced = update(&mut storage, serde_json::json!({ "labels": ["review"] })).unwrap();
        assert_eq!(replaced.labels, ["review"]);

        let error = update(&mut storage, serde_json::json!({ "labels": ["a,b"] })).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(error.message.contains("own list item"), "{error:?}");
        let error = update(
            &mut storage,
            serde_json::json!({ "title": "Renamed", "labels": [""] }),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        let stored = Task::from(&storage.get_task(task.id.into()).unwrap().unwrap());
        assert_eq!(
            (stored.title.as_str(), stored.labels.as_slice()),
            ("Tables", ["review".to_owned()].as_slice())
        );

        let cleared = update(&mut storage, serde_json::json!({ "labels": [] })).unwrap();
        assert!(cleared.labels.is_empty());
    }

    #[test]
    fn refs_are_kept_in_order_appended_removed_and_searched() {
        let (mut storage, workspace) = storage_with_workspace();
        let request: CreateTask = serde_json::from_value(serde_json::json!({
            "workspace_id": workspace,
            "task_type": "feat",
            "title": "Schema",
            "refs": [" lane:schema-lane ", "discord:42", "lane:schema-lane"],
        }))
        .unwrap();
        let task = insert_task(&mut storage, request).unwrap();
        assert_eq!(task.refs, ["lane:schema-lane", "discord:42"]);

        let update = |storage: &mut Storage, fields: serde_json::Value| {
            let mut request = serde_json::json!({ "id": task.id });
            request
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            update_task(storage, serde_json::from_value(request).unwrap())
        };
        let kept = update(&mut storage, serde_json::json!({ "title": "Tables" })).unwrap();
        assert_eq!(kept.refs, ["lane:schema-lane", "discord:42"]);
        let changed = update(
            &mut storage,
            serde_json::json!({ "refs": ["pr:7", "discord:42"], "remove_refs": ["lane:schema-lane"] }),
        )
        .unwrap();
        assert_eq!(changed.refs, ["discord:42", "pr:7"]);
        let error = update(
            &mut storage,
            serde_json::json!({ "title": "Renamed", "refs": ["a\nb"] }),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert_eq!(get_task(&storage, task.id).unwrap(), changed);

        let hits = search(&storage, "pr:7").unwrap();
        assert_eq!(hits.iter().map(|hit| hit.id).collect::<Vec<_>>(), [task.id]);
        update(&mut storage, serde_json::json!({ "remove_refs": ["pr:7"] })).unwrap();
        assert!(search(&storage, "pr:7").unwrap().is_empty());
    }

    #[test]
    fn decision_notes_are_kept_apart_from_progress_notes() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        let mut note = |arguments: serde_json::Value| {
            let request: AddProgressNote = serde_json::from_value(arguments).unwrap();
            let (kind, note) = request.into_note();
            add_note(&mut storage, kind, note).unwrap()
        };

        note(serde_json::json!({ "task_id": task.id, "note": "Drafted tables" }));
        let noted = note(serde_json::json!({
            "task_id": task.id, "kind": "decision", "note": "Chose SQLite over files"
        }));
        let kinds: Vec<_> = noted.notes.iter().map(|note| note.kind).collect();
        assert_eq!(
            kinds,
            [types::NoteKind::Progress, types::NoteKind::Decision]
        );
        assert!(
            serde_json::from_value::<AddProgressNote>(serde_json::json!({
                "task_id": task.id, "kind": "blocker", "note": "x"
            }))
            .is_err()
        );
    }

    #[test]
    fn notes_are_trimmed_and_a_blank_note_or_unknown_task_adds_none() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        let note = |task_id: TaskId, note: &str| AddNote {
            task_id,
            note: note.to_owned(),
        };

        let noted = add_note(
            &mut storage,
            NoteKind::Progress,
            note(task.id, "  Chose SQLite \n"),
        )
        .unwrap();
        let noted = add_note(&mut storage, NoteKind::Blocker, note(noted.id, "No access")).unwrap();
        let notes: Vec<_> = noted
            .notes
            .iter()
            .map(|note| (note.kind, note.body.as_str()))
            .collect();
        assert_eq!(
            notes,
            [
                (types::NoteKind::Progress, "Chose SQLite"),
                (types::NoteKind::Blocker, "No access"),
            ]
        );

        let error = add_note(&mut storage, NoteKind::Blocker, note(task.id, " \n")).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        let error = add_note(&mut storage, NoteKind::Progress, note(TaskId(99), "x")).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        assert_eq!(get_task(&storage, task.id).unwrap().notes.len(), 2);
    }

    fn search(storage: &Storage, query: &str) -> CommandResult<Vec<SearchHit>> {
        search_tasks(
            storage,
            SearchTasks {
                query: query.to_owned(),
                workspace_id: None,
                status: None,
                limit: None,
            },
        )
    }

    #[test]
    fn search_hits_and_task_details_carry_history_and_links() {
        let (mut storage, workspace) = storage_with_workspace();
        let research = create(&mut storage, workspace, "Research search engines", vec![]).unwrap();
        let schema = create(&mut storage, workspace, "Search schema", vec![]).unwrap();
        let tool = create(&mut storage, workspace, "Search tool", vec![schema.id]).unwrap();
        add_related(
            &mut storage,
            Related {
                task_id: tool.id,
                related_id: research.id,
            },
        )
        .unwrap();
        add_note(
            &mut storage,
            NoteKind::Progress,
            AddNote {
                task_id: research.id,
                note: "Chose FTS5 over tantivy".to_owned(),
            },
        )
        .unwrap();
        storage
            .set_task_status(
                research.id.into(),
                crate::domain::status::TaskStatus::InProgress,
            )
            .unwrap();
        storage
            .conclude_task(research.id.into(), "Too heavy for a desktop app", None)
            .unwrap();

        let hits = search(&storage, "search").unwrap();
        let ids: Vec<_> = hits.iter().map(|hit| hit.id).collect();
        assert_eq!(ids.len(), 3);
        let hit = hits.iter().find(|hit| hit.id == schema.id).unwrap();
        assert_eq!(
            (hit.workspace.as_str(), &hit.dependents, &hit.related),
            ("toodo", &vec![tool.id], &vec![])
        );
        let hit = &search(&storage, "tantivy").unwrap()[0];
        assert_eq!(hit.id, research.id);
        assert_eq!(hit.related, [tool.id]);
        assert_eq!(hit.resolution, Some(TaskResolution::NotAdopted));
        assert_eq!(
            search(&storage, " ").unwrap_err().kind,
            CommandErrorKind::InvalidInput
        );

        let details = task_details(&storage, GetTask { id: research.id }).unwrap();
        assert_eq!(
            details.task.completion_note.as_deref(),
            Some("Too heavy for a desktop app")
        );
        assert_eq!(details.task.notes[0].body, "Chose FTS5 over tantivy");
        let statuses: Vec<_> = details
            .task
            .timeline
            .iter()
            .map(|event| event.status)
            .collect();
        assert_eq!(
            statuses,
            [
                TaskStatus::Planned,
                TaskStatus::InProgress,
                TaskStatus::Done
            ]
        );
        assert_eq!(
            details.related,
            [TaskLink {
                id: tool.id,
                workspace_id: workspace,
                title: "Search tool".to_owned(),
                status: TaskStatus::Planned,
                resolution: None,
            }]
        );
        let details = task_details(&storage, GetTask { id: tool.id }).unwrap();
        let titles = |links: &[TaskLink]| -> Vec<String> {
            links.iter().map(|link| link.title.clone()).collect()
        };
        assert_eq!(titles(&details.depends_on), ["Search schema"]);
        assert!(details.dependents.is_empty());
        assert_eq!(titles(&details.related), ["Research search engines"]);
        let json = serde_json::to_value(&details).unwrap();
        assert_eq!(json["dependsOn"][0]["status"], "planned");
        assert_eq!(json["task"]["id"], serde_json::json!(tool.id));

        let unlinked = remove_related(
            &mut storage,
            Related {
                task_id: research.id,
                related_id: tool.id,
            },
        )
        .unwrap();
        assert!(unlinked.related.is_empty());
        let error = remove_related(
            &mut storage,
            Related {
                task_id: research.id,
                related_id: tool.id,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        assert!(
            error.message.ends_with(&format!(
                "get_task {} lists its related tasks",
                research.id.0
            )),
            "{}",
            error.message
        );
        let error = task_details(&storage, GetTask { id: TaskId(99) }).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        let error = add_related(
            &mut storage,
            Related {
                task_id: tool.id,
                related_id: tool.id,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }

    #[test]
    fn lists_tasks_of_one_workspace_or_all() {
        let (mut storage, workspace) = storage_with_workspace();
        let schema = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        create(&mut storage, workspace, "API", vec![schema.id]).unwrap();
        let all = list_tasks(&storage, ListTasks::default()).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all[0].ready && all[0].blocked_by.is_empty());
        assert!(!all[1].ready);
        assert_eq!(all[1].blocked_by[0].id, schema.id);
        let json = serde_json::to_value(&all[1]).unwrap();
        assert_eq!(json["title"], "API");
        assert_eq!(json["ready"], false);
        assert_eq!(json["blockedBy"][0]["title"], "Schema");
        let error = list_tasks(
            &storage,
            ListTasks {
                workspace_id: Some(WorkspaceId(99)),
                ..ListTasks::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
    }

    #[test]
    fn lists_tasks_narrowed_by_status_readiness_and_limit() {
        let (mut storage, workspace) = storage_with_workspace();
        let schema = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        let api = create(&mut storage, workspace, "API", vec![schema.id]).unwrap();
        let docs = create(&mut storage, workspace, "Docs", vec![]).unwrap();
        let ids = |request: ListTasks| -> Vec<TaskId> {
            list_tasks(&storage, request)
                .unwrap()
                .iter()
                .map(|listed| listed.task.id)
                .collect()
        };
        let ready = |ready: bool, limit: Option<u32>| ListTasks {
            ready: Some(ready),
            limit,
            ..ListTasks::default()
        };
        assert_eq!(ids(ready(true, None)), [schema.id, docs.id]);
        assert_eq!(ids(ready(true, Some(1))), [docs.id]);
        assert_eq!(ids(ready(false, None)), [api.id]);
        let page = |limit, before_id| ListTasks {
            limit: Some(limit),
            before_id,
            ..ListTasks::default()
        };
        assert_eq!(ids(page(2, None)), [api.id, docs.id]);
        assert_eq!(ids(page(2, Some(api.id))), [schema.id]);
        let in_progress = ListTasks {
            status: Some(vec![TaskStatus::InProgress]),
            ..ListTasks::default()
        };
        assert_eq!(ids(in_progress.clone()), Vec::<TaskId>::new());
        assert_eq!(
            ids(ListTasks {
                ready: Some(true),
                ..in_progress
            }),
            Vec::<TaskId>::new()
        );
        // A page still tells what blocks its tasks when the blocker is on another page.
        let listed = list_tasks(&storage, page(1, Some(docs.id))).unwrap();
        assert_eq!(listed[0].task.id, api.id);
        assert_eq!(listed[0].blocked_by[0].id, schema.id);
        assert!(!listed[0].ready);
        let error = list_tasks(&storage, page(0, None)).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }

    #[test]
    fn unknown_arguments_are_rejected_with_the_accepted_ones() {
        let error = serde_json::from_value::<UpdateTask>(
            serde_json::json!({"id": 1, "dueDate": "2026-11-01"}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("unknown field `dueDate`"), "{error}");
        assert!(error.contains("`due_date`"), "{error}");
    }

    #[test]
    fn patch_schemas_advertise_no_null_defaults() {
        let schema = schemars::schema_for!(UpdateTask);
        let properties = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .unwrap();
        for (name, property) in properties {
            assert_ne!(
                property.get("default"),
                Some(&serde_json::Value::Null),
                "{name}: {property}"
            );
        }
    }

    #[test]
    fn a_task_number_finds_that_task_first_in_any_workspace() {
        let (mut storage, workspace) = storage_with_workspace();
        let other = storage
            .create_workspace(&NewWorkspace {
                name: "server".to_owned(),
                description: None,
                repository: None,
            })
            .unwrap();
        let numbered = create(&mut storage, other.id.into(), "Deploy server", vec![]).unwrap();
        let number = numbered.id.0;
        let mention = create(
            &mut storage,
            workspace,
            &format!("Follow up on {number}"),
            vec![],
        )
        .unwrap();
        let ids = |query: String, workspace_id, status| -> Vec<TaskId> {
            search_tasks(
                &storage,
                SearchTasks {
                    query,
                    workspace_id,
                    status,
                    limit: None,
                },
            )
            .unwrap()
            .iter()
            .map(|hit| hit.id)
            .collect()
        };
        assert_eq!(
            ids(format!("{number}"), None, None),
            [numbered.id, mention.id]
        );
        assert_eq!(
            ids(format!(" #{number} "), Some(workspace), None),
            [numbered.id]
        );
        assert_eq!(
            ids(format!("{number}"), Some(workspace), None),
            [numbered.id, mention.id]
        );
        assert_eq!(
            ids(format!("{number}"), None, Some(TaskStatus::Done)),
            Vec::<TaskId>::new()
        );
        assert_eq!(ids("999".to_owned(), None, None), Vec::<TaskId>::new());
    }

    #[test]
    fn a_search_limit_of_zero_returns_no_tasks() {
        let (mut storage, workspace) = storage_with_workspace();
        create(&mut storage, workspace, "Search schema", vec![]).unwrap();
        let limited = |limit| {
            search_tasks(
                &storage,
                SearchTasks {
                    query: "schema".to_owned(),
                    workspace_id: None,
                    status: None,
                    limit,
                },
            )
            .unwrap()
            .len()
        };
        assert_eq!(limited(Some(0)), 0);
        assert_eq!(limited(None), 1);
    }

    #[test]
    fn guidelines_round_trip_and_get_task_includes_them() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
        let storage = StorageState::new(storage);
        use serde_json::json;
        let added = add_guideline(
            &storage,
            serde_json::from_value(
                json!({"workspace_id": workspace, "body": "  Ask before migrating "}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(added.kind, types::GuidelineKind::Memory);
        assert_eq!(added.body, "Ask before migrating");
        let rule = add_guideline(
            &storage,
            serde_json::from_value(
                json!({"workspace_id": workspace, "kind": "rule", "body": "Write English"}),
            )
            .unwrap(),
        )
        .unwrap();
        let updated = update_guideline(
            &storage,
            serde_json::from_value(json!({"id": added.id, "kind": "rule"})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            (updated.kind, updated.body.as_str()),
            (types::GuidelineKind::Rule, "Ask before migrating")
        );
        let listed = get_guidelines(
            &lock(&storage),
            GetGuidelines {
                workspace_id: workspace,
            },
        )
        .unwrap();
        assert_eq!(listed.workspace.name, "toodo");
        assert_eq!(listed.guidelines, [updated.clone(), rule.clone()]);
        let details = task_details(&lock(&storage), GetTask { id: task.id }).unwrap();
        assert_eq!(details.guidelines, listed.guidelines);
        assert_eq!(
            remove_guideline(&storage, RemoveGuideline { id: rule.id }).unwrap(),
            rule
        );

        let missing = types::GuidelineId(999);
        for error in [
            update_guideline(
                &storage,
                UpdateGuideline {
                    id: missing,
                    kind: None,
                    body: Some("x".into()),
                },
            )
            .unwrap_err(),
            remove_guideline(&storage, RemoveGuideline { id: missing }).unwrap_err(),
        ] {
            assert_eq!(error.code, CommandErrorCode::GuidelineNotFound);
            assert!(error.message.contains("get_guidelines"), "{error:?}");
        }
        let unknown = WorkspaceId(999);
        let listed = get_guidelines(
            &lock(&storage),
            GetGuidelines {
                workspace_id: unknown,
            },
        );
        for error in [
            listed.unwrap_err(),
            add_guideline(
                &storage,
                serde_json::from_value(json!({"workspace_id": unknown, "body": "x"})).unwrap(),
            )
            .unwrap_err(),
        ] {
            assert_eq!(error.code, CommandErrorCode::WorkspaceNotFound);
            assert!(error.message.contains("list_workspaces"), "{error:?}");
        }
    }
}
