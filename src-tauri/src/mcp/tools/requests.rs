//! The arguments and replies of the tools, as their JSON schemas advertise them.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use crate::commands::completion::ConcludeOutcome;
use crate::commands::types::{
    self, Estimate, Task, TaskId, TaskStatus, TaskType, Workspace, WorkspaceId,
};
use crate::domain::model::NoteKind;

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
pub(super) const MAX_PLAN_TASKS: usize = 100;

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
#[schemars(extend("x-aliases" = {"id": "criterion_id"}))]
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
#[schemars(extend("x-aliases" = {"id": "criterion_id"}))]
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
pub struct MoveTask {
    /// The task to move, in any status.
    pub id: TaskId,
    /// The live workspace it moves into, as in list_workspaces; archived ones are rejected.
    pub workspace_id: WorkspaceId,
}

/// The reply of move_task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedTask {
    /// The task in its new workspace.
    pub task: Task,
    /// The workspace the task was in before the move.
    pub from_workspace_id: WorkspaceId,
    /// What the move kept and what to do next.
    pub message: String,
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
