//! What the MCP tools do, over the same storage as the Tauri commands, so agents follow
//! the rules the UI follows: the dependency DAG stays acyclic and readiness stays in sync.
//! Starting, completing, and concluding tasks run the app's own commands.

use std::collections::{BTreeSet, HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use crate::adapters::git::{Git, shell_quote};
use crate::adapters::github::GitHub;
use crate::adapters::herdr::Herdr;
use crate::commands::completion::{self, OpenPullRequest};
use crate::commands::herdr as herdr_commands;
use crate::commands::runs as run_commands;
use crate::commands::tasks::{self as task_commands, edit_task};
use crate::commands::types::{
    self, CommitRecord, Estimate, Task, TaskEdit, TaskId, TaskResolution, TaskStatus, TaskType,
    Workspace, WorkspaceId,
};
use crate::commands::workspaces;
use crate::commands::{
    CommandError, CommandErrorCode, CommandErrorKind, CommandResult, PlainRunState, State,
    StorageState, TmuxRunState, lock,
};
use crate::domain::criteria::{CheckedBy, NewCriterion};
use crate::domain::model::{self, NoteKind};
use crate::domain::runtime::{HostRef, OwnerKey, RunRole};
use crate::mcp::ServerStatus;
use crate::runtime::{RunCommand, RuntimeError, RuntimeService, StartRun};
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
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CreateWorkspace {
    /// Name shown in Toodo, e.g. the repository name.
    pub name: String,
    /// Absolute path of the repository on the machine Toodo runs on: a Windows path such
    /// as `C:\dev\toodo` in the desktop app, a POSIX path such as `/home/me/toodo` on
    /// toodo-server. With `clone_url` it must not exist yet or be an empty directory;
    /// without it, it must be inside an existing clone, whose root becomes the workspace.
    pub path: String,
    /// Clone this repository URL into `path`; omit it to open the repository already
    /// cloned there.
    pub clone_url: Option<String>,
    /// The branch task pull requests go into, e.g. `dev`; detected from the repository's
    /// `origin` default branch when omitted. With `init`, the first branch of the new
    /// repository (`main` when omitted).
    pub default_base_branch: Option<String>,
    /// Make `path`, a plain folder or one that does not exist yet, a new git repository
    /// without a remote; tasks then merge into the base branch locally. Not with
    /// `clone_url`.
    #[serde(default)]
    pub init: bool,
    /// What `path` holds: `github` (a repository with a GitHub `origin` remote),
    /// `local_git` (a repository merged locally), or `none` (a plain directory: no git,
    /// no herdr, no `clone_url` or `init`). Omitted: `github` when the repository has an
    /// `origin` remote, else `local_git`.
    pub source: Option<types::Source>,
    /// How its tasks get done: `pr_merge` (github), `local_merge` (local_git), or
    /// `manual` (any source). Omitted: the default of the source.
    pub completion: Option<types::CompletionMode>,
    /// What runs started tasks: `herdr` (git sources) or `none` (only with completion
    /// `manual`). Omitted: `herdr` for git sources, `none` for source `none`.
    pub runner: Option<types::Runner>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct UpdateWorkspace {
    /// The workspace, as in list_workspaces.
    pub id: WorkspaceId,
    /// Name shown in Toodo; kept when omitted.
    pub name: Option<String>,
    /// New absolute path of the repository on the workspace's machine, e.g. after the
    /// repository moved or when list_workspaces reports a `pathProblem`. It must be inside
    /// a git repository that no other workspace uses, whose root becomes the workspace
    /// path (any directory for source `none`); the tasks stay with the workspace. Kept
    /// when omitted.
    pub path: Option<String>,
    /// The branch task pull requests go into, e.g. `main`; it must exist in the
    /// repository, locally or as `origin/<branch>`. Cannot change while a task is in
    /// review. Kept when omitted.
    pub default_base_branch: Option<String>,
    /// Whether agents merge their own task pull request: `never` or `afterChecks`. Kept
    /// when omitted.
    pub agent_merge: Option<types::AgentMerge>,
    /// How its tasks get done: `pr_merge` (github), `local_merge` (local_git), or
    /// `manual` (any source). Kept when omitted.
    pub completion: Option<types::CompletionMode>,
    /// What runs started tasks: `herdr`, `plain`, `tmux` (git sources), or `none` (only
    /// with completion `manual`). Cannot change while a task is in progress or in review.
    /// Kept when omitted.
    pub runner: Option<types::Runner>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CurrentTask {
    /// Absolute path of the agent's working directory, e.g. the worktree of its task.
    pub cwd: String,
    /// The machine the agent runs on: `local` for the machine Toodo runs on, or the SSH
    /// host of a remote machine, as in a workspace's `location.machine`. Omit it to
    /// search every machine; a path inside worktrees on several machines is then
    /// rejected, naming them.
    #[serde(default)]
    pub machine: Option<String>,
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
    /// Verifiable completion criteria in order (no `id`). Use `manual` for what a person
    /// or you check with evidence, and `url`, `command`, `pr_open_ci_green` for what
    /// Toodo can check itself.
    #[serde(default)]
    pub criteria: Vec<types::CriterionInput>,
    /// Put the merge criterion first (the pull request is merged, or the branch is merged
    /// into the base branch locally in a repository without `origin`); true when
    /// omitted. Set false for work that ships nothing, e.g. research or an errand.
    #[serde(default)]
    pub merge_criterion: Option<bool>,
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
    /// Verifiable completion criteria in order (no `id`), as in create_task.
    #[serde(default)]
    pub criteria: Vec<types::CriterionInput>,
    /// Put the merge criterion first, as in create_task; true when omitted.
    #[serde(default)]
    pub merge_criterion: Option<bool>,
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
    /// The full new list of completion criteria, replacing the current one; unchanged when
    /// omitted. Criteria whose `id` is left out are deleted with their evidence. Keep an
    /// existing criterion by passing `{"id": N}`; given fields change it, omitted ones
    /// keep their stored values, and it keeps its state unless its kind or target
    /// changes. New criteria (no `id`) need `text` and `kind`. A done task cannot change
    /// at all through MCP.
    pub criteria: Option<Vec<types::CriterionInput>>,
    /// True to let `criteria` leave out the merge criterion (`pr_merged` or
    /// `branch_merged_locally`) and so remove it, e.g. for work that ships no code;
    /// without it, such a list is rejected.
    #[serde(default)]
    pub remove_merge_criterion: bool,
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
    /// The planned task to delete, e.g. one you created by mistake.
    pub id: TaskId,
    /// true deletes the task. Without it nothing changes and the reply says what deleting
    /// would remove; read it before you confirm.
    #[serde(default)]
    pub confirm: bool,
    /// true removes a worktree with modified or untracked files too, discarding them.
    #[serde(default)]
    pub force: bool,
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
    /// A command to run in the shell pane of the task's new herdr workspace once it is
    /// started, e.g. the coding agent that works on the task. Only for tasks of
    /// workspaces on the machine Toodo runs on.
    #[serde(default)]
    pub agent_command: Option<String>,
    /// Ignored: agents started before the lead was removed may still send it, and other
    /// unknown arguments are rejected.
    #[serde(default)]
    #[schemars(skip)]
    pub request_id: Option<String>,
}

/// A started task with the panes of its herdr workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStart {
    #[serde(flatten)]
    pub task: Task,
    pub panes: Vec<types::TaskPane>,
    /// The pane `agent_command` ran in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ran_in: Option<String>,
    /// Why the panes could not be listed or `agent_command` did not run; the task is
    /// started all the same.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CompleteTask {
    /// The task. Never your own task, the one current_task finds.
    pub id: TaskId,
    /// Only for a task whose work shipped with the merged pull request of another task,
    /// e.g. one pull request that fixed several tasks: that task's ID (`178` or `"#178"`),
    /// which must be done as merged, or the pull request URL. Omit it to complete the
    /// task with its own pull request.
    pub merged_with: Option<MergedWithRef>,
    /// Complete work that shipped without any pull request. Requires a non-empty note;
    /// cannot be combined with merged_with.
    #[serde(default)]
    pub without_pull_request: bool,
    /// What shipped without a pull request, required with without_pull_request.
    pub note: Option<String>,
}

/// A task ID or a pull request URL.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MergedWithRef {
    Task(i64),
    Text(String),
}

impl MergedWithRef {
    fn target(self) -> CommandResult<completion::MergedWithTarget> {
        let text = match self {
            Self::Task(id) => return Ok(completion::MergedWithTarget::Task(model::TaskId(id))),
            Self::Text(text) => text,
        };
        let text = text.trim();
        if let Ok(id) = text.strip_prefix('#').unwrap_or(text).parse::<i64>() {
            return Ok(completion::MergedWithTarget::Task(model::TaskId(id)));
        }
        if text.starts_with("https://") {
            return Ok(completion::MergedWithTarget::PullRequest(text.to_owned()));
        }
        Err(CommandError::invalid_input(format!(
            "merged_with must be a task ID such as 178 or a pull request URL, not {text:?}"
        )))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct SearchTasks {
    /// Words to look for in any language, e.g. `deploy server`; short words such as
    /// two-character Korean ones work too. Every word must appear in the
    /// task's title, description, notes, completion note, branch, or pull request, as a
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RestoreWorktree {
    /// An in_progress or in_review task whose worktree directory is gone, e.g. yours
    /// when current_task returns it with worktreeMissing true.
    pub id: TaskId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct GetTask {
    /// The task, e.g. one that search_tasks found.
    pub id: TaskId,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct SetWorktreeRoot {
    /// SSH host of a remote machine, as in `machine.label` of list_machine_settings or a
    /// workspace's `location.machine`; omit it for the machine Toodo runs on.
    pub ssh_host: Option<String>,
    /// Absolute directory on that machine that holds the task worktrees, e.g.
    /// `/home/me/worktrees`: a POSIX path, or on an SSH machine that is a Windows host a
    /// Windows path such as `D:\worktrees`, the same kind as its workspace paths. Null or
    /// omitted clears it, so tasks on the machine cannot start until it is set again.
    pub worktree_root: Option<String>,
}

/// Settings of the machine Toodo runs on and of every known SSH machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSettingsList {
    pub machines: Vec<types::MachineSettings>,
    /// Why the machines saved in herdr could not be read; the list then lacks those
    /// without a workspace or saved settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub herdr_error: Option<String>,
}

/// The local machine first, then the SSH machines saved in herdr, hosting a workspace, or
/// with saved settings, by label.
pub fn list_machine_settings(
    storage: &StorageState,
    herdr: &Herdr,
) -> CommandResult<MachineSettingsList> {
    let (saved, herdr_error) = match herdr.list_machines() {
        Ok(saved) => (saved, None),
        Err(error) => (Vec::new(), Some(CommandError::from(error).message)),
    };
    let storage = lock(storage);
    let mut hosts: BTreeSet<String> = saved
        .into_iter()
        .map(|machine| machine.target.trim().to_owned())
        .collect();
    for workspace in storage.list_workspaces()? {
        if let model::Machine::Ssh(label) = workspace.location.machine() {
            hosts.insert(label.as_str().to_owned());
        }
    }
    for label in storage.ssh_machines_with_settings()? {
        hosts.insert(label.as_str().to_owned());
    }
    let machines = std::iter::once(types::Machine::Local)
        .chain(hosts.into_iter().map(|label| types::Machine::Ssh { label }))
        .map(|machine| workspaces::machine_settings(&storage, machine))
        .collect::<CommandResult<_>>()?;
    Ok(MachineSettingsList {
        machines,
        herdr_error,
    })
}

/// Saves the worktree root of one machine through the app's own validation.
pub fn set_worktree_root(
    storage: &mut Storage,
    request: SetWorktreeRoot,
) -> CommandResult<types::MachineSettings> {
    let machine = match request.ssh_host {
        Some(label) => types::Machine::Ssh { label },
        None => types::Machine::Local,
    };
    workspaces::save_settings(
        storage,
        types::MachineSettings {
            machine,
            worktree_root: request.worktree_root,
        },
    )
}

pub fn list_workspaces(storage: &Storage) -> CommandResult<Vec<Workspace>> {
    Ok(types::map_all(&storage.list_workspaces()?))
}

/// Creates a local workspace through the app's own setup: clone or check the repository,
/// open it in herdr for runner herdr, and save it unless a workspace already uses its
/// location. With source none the directory is saved as given.
pub fn create_workspace(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    request: CreateWorkspace,
) -> CommandResult<Workspace> {
    if request.init && request.clone_url.is_some() {
        return Err(CommandError::invalid_input(
            "init makes a new repository; it cannot be combined with clone_url",
        ));
    }
    let repository = if request.source == Some(types::Source::None) {
        if request.init || request.clone_url.is_some() {
            return Err(CommandError::invalid_input(
                "source none is a plain directory without a repository; omit clone_url and \
                 init, or choose source local_git or github to clone or init one",
            ));
        }
        None
    } else {
        Some(match request.clone_url {
            Some(url) => types::RepositorySetup::Clone { url },
            None if request.init => types::RepositorySetup::Init,
            None => types::RepositorySetup::Open,
        })
    };
    let setup = types::NewWorkspace {
        name: request.name,
        location: types::WorkspaceLocation::Local { path: request.path },
        repository,
        source: request.source,
        completion: request.completion,
        runner: request.runner,
        default_base_branch: request.default_base_branch,
    }
    .try_into()?;
    Ok((&workspaces::create(storage, git, herdr, setup)?).into())
}

/// Changes the settings of a workspace and, with `path`, moves it to another directory on
/// its machine, through the app's own checks; omitted settings are kept.
pub fn update_workspace(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    request: UpdateWorkspace,
) -> CommandResult<Workspace> {
    let id = request.id.into();
    let stored = lock(storage)
        .get_workspace(id)?
        .ok_or(StorageError::WorkspaceNotFound(id))?;
    let location = match request.path {
        Some(path) => Some(
            match &stored.location {
                model::WorkspaceLocation::Local { .. } => types::WorkspaceLocation::Local { path },
                model::WorkspaceLocation::Ssh { machine, .. } => types::WorkspaceLocation::Ssh {
                    machine: machine.as_str().to_owned(),
                    path,
                },
            }
            .try_into()?,
        ),
        None => None,
    };
    let current = Workspace::from(&stored);
    let workspace = Workspace {
        name: request.name.unwrap_or(current.name),
        default_base_branch: request
            .default_base_branch
            .unwrap_or(current.default_base_branch),
        agent_merge: request.agent_merge.unwrap_or(current.agent_merge),
        completion: request.completion.unwrap_or(current.completion),
        runner: request.runner.unwrap_or(current.runner),
        ..current
    };
    Ok((&workspaces::update(storage, git, herdr, workspace, location)?).into())
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
            "task {id} is paused until {waiting} {} done; it keeps its branch, worktree, and herdr workspace. The user decides in the Toodo app whether to close the workspace, which ends the session there. Stop working on task {id}; resume_task resumes it once it is ready.",
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
            TaskStatus::Planned if task.branch.is_some() => format!(
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
                " #{prerequisite} was not adopted, so it never unblocks task {id}: call remove_dependency {{\"task_id\": {id}, \"depends_on\": {prerequisite}}} if the work can go ahead without it, or complete_task {prerequisite} with merged_with if another merged pull request shipped it."
            ));
        }
    }
    message
}

/// The current task, with the base branch its pull request goes into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTaskReply {
    #[serde(flatten)]
    pub task: Task,
    /// The default base branch of the task's workspace.
    pub base_branch: String,
    /// Whether you merge the task's pull request yourself: `never`, or `afterChecks`
    /// (into `base_branch` only, once every check on it passed).
    pub agent_merge: types::AgentMerge,
    /// The machine of the task's workspace, where its worktree is.
    pub machine: types::Machine,
}

/// What to tell an agent that current_task found no task for; the server instructions
/// and the skill give the same next step.
const NO_CURRENT_TASK: &str = "if you were asked to work on a Toodo task, tell the user \
    and ask for its id, then read it with get_task; to plan new work outside a task, \
    pick the workspace with list_workspaces";

fn machine_of(machine: &model::Machine) -> types::Machine {
    match machine {
        model::Machine::Local => types::Machine::Local,
        model::Machine::Ssh(label) => types::Machine::Ssh {
            label: label.as_str().to_owned(),
        },
    }
}

fn machine_name(machine: &model::Machine) -> &str {
    match machine {
        model::Machine::Local => "local",
        model::Machine::Ssh(label) => label.as_str(),
    }
}

/// The task whose worktree contains `cwd` on the requested machine; the innermost one if
/// worktrees are nested. Paths are compared after resolving `.` and `..` by their text,
/// since a remote path cannot be resolved on this machine.
pub fn current_task(storage: &Storage, request: CurrentTask) -> CommandResult<CurrentTaskReply> {
    let wanted = request
        .machine
        .as_deref()
        .map(str::trim)
        .filter(|machine| !machine.is_empty());
    let cwd = comparable_path(&request.cwd);
    let workspaces: HashMap<_, _> = storage
        .list_workspaces()?
        .into_iter()
        .map(|workspace| (workspace.id, workspace))
        .collect();
    let matches: Vec<_> = storage
        .list_all_tasks()?
        .into_iter()
        .filter_map(|task| {
            let workspace = workspaces.get(&task.workspace_id)?;
            let machine = workspace.location.machine();
            let on_machine = match wanted {
                None => true,
                Some(wanted) => match &machine {
                    model::Machine::Local => wanted.eq_ignore_ascii_case("local"),
                    model::Machine::Ssh(label) => label.as_str() == wanted,
                },
            };
            let worktree = comparable_path(&task.worktree_path.as_ref()?.to_string());
            let inside = cwd == worktree
                || cwd
                    .strip_prefix(&worktree)
                    .is_some_and(|rest| rest.starts_with('/') || worktree.ends_with('/'));
            (on_machine && inside).then_some((worktree.len(), task, workspace))
        })
        .collect();
    let innermost = matches.iter().map(|(length, ..)| *length).max();
    let innermost: Vec<_> = matches
        .into_iter()
        .filter(|(length, ..)| Some(*length) == innermost)
        .collect();
    let (task, workspace) = match innermost.as_slice() {
        [] => {
            let scope = wanted.map_or(String::new(), |machine| format!(" on machine {machine}"));
            return Err(CommandError::not_found(format!(
                "no Toodo task has a worktree containing {}{scope}; {NO_CURRENT_TASK}",
                request.cwd
            )));
        }
        [(_, task, workspace)] => (task, *workspace),
        several => {
            let found = several
                .iter()
                .map(|(_, task, workspace)| {
                    format!(
                        "#{} on {}",
                        task.id,
                        machine_name(&workspace.location.machine())
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(CommandError::rejected(format!(
                "{} is inside the worktrees of several tasks: {found}; call current_task again with machine set to the machine you run on (`local` or its SSH host)",
                request.cwd
            )));
        }
    };
    Ok(CurrentTaskReply {
        task: Task::from(task),
        base_branch: workspace.default_base_branch.clone(),
        agent_merge: workspace.agent_merge.into(),
        machine: machine_of(&workspace.location.machine()),
    })
}

/// A path with `/` separators, `.` and `..` resolved by their text, and no repeated or
/// trailing separator; Windows paths, which are case-insensitive, are also lowercased.
fn comparable_path(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 2 && bytes[1] == b':';
    let windows = path.starts_with("//") || drive;
    // The part `..` never climbs above: `/`, `//` of a UNC path, or a drive such as `c:/`.
    let (root, rest) = if let Some(rest) = path.strip_prefix("//") {
        ("//".to_owned(), rest)
    } else if drive {
        (format!("{}/", &path[..2]), &path[2..])
    } else if let Some(rest) = path.strip_prefix('/') {
        ("/".to_owned(), rest)
    } else {
        (String::new(), path.as_str())
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." if !root.is_empty() => {}
            part => parts.push(part),
        }
    }
    let path = root + &parts.join("/");
    if windows { path.to_lowercase() } else { path }
}

/// Checks out the branch of an active task that lost its worktree into a new one, as
/// Restore worktree in the Toodo app does.
pub fn restore_worktree(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    request: RestoreWorktree,
) -> CommandResult<Task> {
    Ok((&herdr_commands::restore(storage, git, herdr, request.id.into())?).into())
}

/// Creates a `planned` task with its dependencies. Unknown prerequisites are rejected
/// before anything is written; a new task has no dependents, so its edges cannot close
/// a cycle.
pub fn create_task(storage: &StorageState, request: CreateTask) -> CommandResult<Task> {
    let criteria = request
        .criteria
        .iter()
        .map(types::CriterionInput::parse)
        .collect::<CommandResult<Vec<_>>>()?;
    let merge = task_commands::merge_criterion(
        storage,
        request.workspace_id.into(),
        &criteria,
        request.merge_criterion.unwrap_or(true),
    )?;
    insert_task(&mut lock(storage), request, merge)
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
fn plan_task(storage: &StorageState, item: &PlanTask) -> CommandResult<storage::NewPlanTask> {
    let criteria = item
        .criteria
        .iter()
        .map(types::CriterionInput::parse)
        .collect::<CommandResult<Vec<_>>>()?;
    let merge = task_commands::merge_criterion(
        storage,
        item.workspace_id.into(),
        &criteria,
        item.merge_criterion.unwrap_or(true),
    )?;
    let labels = types::labels(&item.labels)?;
    let mut task: storage::NewTask = types::NewTask {
        workspace_id: item.workspace_id,
        task_type: item.task_type,
        title: item.title.clone(),
        description: item.description.clone(),
        estimate: item.estimate,
        due_date: item.due_date.clone(),
        labels: Vec::new(),
        criteria: item.criteria.clone(),
        merge_criterion: false,
    }
    .try_into()?;
    if let Some(merge) = merge {
        task.criteria.insert(0, merge);
    }
    Ok(storage::NewPlanTask {
        task,
        labels,
        depends_on: Vec::new(),
        related: Vec::new(),
    })
}

/// Creates the task of `request` with `merge`, its merge criterion if it gets one, in
/// front of its criteria.
fn insert_task(
    storage: &mut Storage,
    request: CreateTask,
    merge: Option<NewCriterion>,
) -> CommandResult<Task> {
    for &linked in request.depends_on.iter().chain(&request.related) {
        storage
            .get_task(linked.into())?
            .ok_or(StorageError::TaskNotFound(linked.into()))?;
    }
    let labels = types::labels(&request.labels)?;
    let mut new: storage::NewTask = types::NewTask {
        workspace_id: request.workspace_id,
        task_type: request.task_type,
        title: request.title,
        description: request.description,
        estimate: request.estimate,
        due_date: request.due_date,
        labels: Vec::new(),
        criteria: request.criteria,
        merge_criterion: false,
    }
    .try_into()?;
    if let Some(merge) = merge {
        new.criteria.insert(0, merge);
    }
    let task = storage.create_task(&new)?;
    let labelled = if labels.is_empty() {
        Ok(())
    } else {
        storage.set_task_labels(task.id, &labels).map(drop)
    };
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
pub fn update_task(
    storage: &mut Storage,
    request: UpdateTask,
    completion: Option<model::CompletionMode>,
) -> CommandResult<Task> {
    let current = get_task(storage, request.id)?;
    // A done task is part of the record reviews are built on; agents add to it instead.
    if current.status == types::TaskStatus::Done {
        return Err(CommandError::rejected(format!(
            "task {} is done, so update_task leaves its record as it was finished; record a correction with add_progress_note task_id {}, or call reopen_task to work on it again",
            request.id.0, request.id.0
        )));
    }
    edit_task(
        storage,
        TaskEdit {
            id: request.id,
            task_type: request.task_type.unwrap_or(current.task_type),
            title: request.title.unwrap_or(current.title),
            description: request.description.unwrap_or(current.description),
            estimate: request.estimate.unwrap_or(current.estimate),
            due_date: request.due_date.unwrap_or(current.due_date),
            labels: request.labels,
            criteria: request.criteria,
            merge_criterion: false,
        },
        request.remove_merge_criterion,
        completion,
    )
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
pub fn add_criterion(
    storage: &mut Storage,
    request: AddCriterion,
    completion: Option<model::CompletionMode>,
) -> CommandResult<Task> {
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
            id: request.task_id,
            task_type: None,
            title: None,
            description: None,
            estimate: None,
            due_date: None,
            labels: None,
            criteria: Some(criteria),
            remove_merge_criterion: false,
        },
        completion,
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
            id: owner.into(),
            task_type: None,
            title: None,
            description: None,
            estimate: None,
            due_date: None,
            labels: None,
            criteria: Some(criteria),
            remove_merge_criterion: true,
        },
        None,
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
/// task that a prerequisite blocks is paused; its herdr workspace stays open, and the app
/// asks the user whether to close it, since that ends the agent's session.
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
/// reason as a progress note. The task keeps its branch, worktree, herdr workspace, commit
/// records, and pull request.
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
    task_commands::pause(storage, request.id)?;
    let task = storage.add_task_note(
        request.id.into(),
        NoteKind::Progress,
        &format!("Paused: {reason}"),
    )?;
    Ok((&task).into())
}

/// Resumes a paused task (`planned` with a branch) as the app's Resume does: reopens its
/// worktree and herdr workspace and moves it to `in_progress`. A given note is recorded as
/// a progress note.
pub fn resume_task(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    request: ResumeTask,
) -> CommandResult<Task> {
    let note = request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty());
    let task = get_task(&lock(storage), request.id)?;
    if task.status != TaskStatus::Planned || task.branch.is_none() {
        let next = match task.status {
            TaskStatus::Planned => "it was never started; call start_task to start it",
            TaskStatus::InProgress | TaskStatus::InReview => {
                "it is being worked on, not paused; keep working on it, or call pause_task to pause it"
            }
            TaskStatus::Done => "it is done; create a follow-up task with create_task",
        };
        return Err(CommandError::rejected(format!(
            "task {} cannot be resumed: {next}",
            task.id.0
        )));
    }
    let id = request.id.into();
    let resumed = match herdr_commands::start(storage, git, herdr, id) {
        Ok(task) => task,
        Err(error) => return Err(with_worktree_root_hint(&lock(storage), id, error)),
    };
    let Some(note) = note else {
        return Ok((&resumed).into());
    };
    let task = lock(storage).add_task_note(id, NoteKind::Progress, &format!("Resumed: {note}"))?;
    Ok((&task).into())
}

/// Deletes (archives) a `planned` task as the app's Delete does (see
/// [`task_commands::delete_task`]), but only with `confirm`; without it, nothing changes and
/// the reply says what deleting would do. Tasks being worked on and `done` tasks, which reviews are built on, are
/// rejected.
pub fn delete_task(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    plain: &PlainRunState,
    tmux: &TmuxRunState,
    request: DeleteTask,
) -> CommandResult<Confirmation> {
    let details = task_details(&lock(storage), GetTask { id: request.id })?;
    let task = details.task;
    let id = task.id.0;
    match task.status {
        TaskStatus::Planned => {}
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
        TaskStatus::Done => {
            return Err(CommandError::rejected(format!(
                "task {id} is done and part of the record reviews are built on, so delete_task keeps it; call reopen_task to work on it again, or ask the user to delete it in the Toodo app"
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
        if let Some(path) = &task.worktree_path {
            message.push_str(&format!(
                ". It removes its worktree at {path} with its herdr workspace and running agents, which a restore does not bring back; the branch {} is kept. A worktree with modified or untracked files keeps the task unless force is true",
                task.branch.as_deref().unwrap_or("of the task")
            ));
        }
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
    task_commands::delete(
        storage,
        git,
        herdr,
        plain,
        tmux,
        request.id.into(),
        request.force,
    )?;
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

/// Reopens a `done` task as the app's Reopen does (see [`task_commands::reopen`]), but only
/// with `confirm`; without it, the reopening is checked and the reply says what it would
/// do, and nothing changes.
pub fn reopen_task(storage: &mut Storage, request: ReopenTask) -> CommandResult<Confirmation> {
    let note = task_commands::reopen_note(storage, request.id, &request.reason)?;
    let id = request.id.0;
    if !request.confirm {
        let details = task_details(storage, GetTask { id: request.id })?;
        let task = details.task;
        let paused = if task.branch.is_some() {
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
    let next = if task.branch.is_some() {
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

/// Starts or resumes a ready `planned` task as the app's Start does, then runs
/// `agent_command` in the first pane of its herdr workspace, with the MCP server's URL and
/// token in its environment (see [`with_mcp_env`]), as a writer run of the task (see
/// [`run_agent`]).
pub fn start_task(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    server: &ServerStatus,
    request: StartTask,
) -> CommandResult<TaskStart> {
    let id = request.id.into();
    let command = match request.agent_command.as_deref().map(str::trim) {
        Some("") => return Err(CommandError::invalid_input("agent_command is empty")),
        Some(command) if command.contains(['\n', '\r']) => {
            return Err(CommandError::invalid_input(
                "agent_command must be one line",
            ));
        }
        command => command,
    };
    if command.is_some() {
        let task = get_task(&lock(storage), request.id)?;
        let workspace = lock(storage)
            .get_workspace(task.workspace_id.into())?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id.into()))?;
        if workspace.location.machine() != model::Machine::Local {
            return Err(CommandError::invalid_input(
                "agent_command runs only for tasks of workspaces on the machine Toodo runs \
                 on; start the task without it and run the agent in its pane with herdr on \
                 that machine",
            ));
        }
    }
    let task: Task = match herdr_commands::start(storage, git, herdr, id) {
        Ok(task) => (&task).into(),
        Err(error) => return Err(with_worktree_root_hint(&lock(storage), id, error)),
    };
    let mut started = TaskStart {
        task,
        panes: Vec::new(),
        ran_in: None,
        pane_error: None,
    };
    let panes = match herdr_commands::task_panes(storage, herdr, id) {
        Ok(found) => found.panes,
        Err(error) => {
            started.pane_error = Some(error.message);
            return Ok(started);
        }
    };
    started.panes = panes.iter().map(types::TaskPane::from).collect();
    if let Some(command) = command {
        match panes.first() {
            None => started.pane_error = Some("herdr lists no pane of the task's workspace".into()),
            Some(pane) => {
                let line = with_mcp_env(server, command);
                match run_agent(storage, herdr, id, &pane.pane_id, line) {
                    Ok(pane) => started.ran_in = Some(pane),
                    Err(error) => started.pane_error = Some(error),
                }
            }
        }
    }
    Ok(started)
}

/// Types `line` into `pane` of the task's open runtime workspace through
/// [`RuntimeService::start_run`], which records it as a writer run of the task in that
/// workspace. Returns the pane the line ran in, or why it did not run.
fn run_agent(
    storage: &StorageState,
    herdr: &Herdr,
    task: model::TaskId,
    pane: &str,
    line: String,
) -> Result<String, String> {
    let request = {
        let storage = lock(storage);
        let read = || -> Result<StartRun, StorageError> {
            let open = storage.open_runtime_workspace(task)?;
            let worktree = storage
                .get_task(task)?
                .ok_or(StorageError::TaskNotFound(task))?
                .worktree_path;
            // Unique per task, and a request key never comes back once its run is recorded.
            let request_key = format!(
                "mcp-agent-{task}-{}",
                storage.list_task_runs(task)?.len() + 1
            );
            Ok(StartRun {
                owner: OwnerKey::implicit(),
                task,
                request_key,
                role: RunRole::Writer,
                host: open
                    .as_ref()
                    .map_or(HostRef::Local, |open| open.host.clone()),
                checkout_path: open
                    .as_ref()
                    .and_then(|open| open.checkout_path.clone())
                    .or_else(|| worktree.map(|path| path.to_string())),
                runtime_workspace: open.as_ref().map(|open| open.id),
                adapter_profile: None,
                command: RunCommand::InPane {
                    pane: pane.to_owned(),
                    line,
                },
            })
        };
        read().map_err(|error| error.to_string())?
    };
    match RuntimeService.start_run(storage, herdr, request) {
        Ok(run) => Ok(run.provider_run_ref.unwrap_or_else(|| pane.to_owned())),
        // What herdr said, as before runs were recorded.
        Err(RuntimeError::Runner(error)) => Err(error.0),
        Err(error) => Err(error.to_string()),
    }
}

/// `command` after exporting `TOODO_MCP_URL` and `TOODO_MCP_TOKEN`, so the agent it starts
/// can reach this server. The token is read from its file when the line runs, so it is
/// never typed into the pane or its shell history.
pub fn with_mcp_env(server: &ServerStatus, command: &str) -> String {
    let Some(token_file) = &server.token_file else {
        return command.to_owned();
    };
    format!(
        "export TOODO_MCP_URL={}; export TOODO_MCP_TOKEN=\"$(cat {})\"; {command}",
        shell_quote(&server.url),
        shell_quote(&token_file.to_string_lossy()),
    )
}

/// Tells the agent how to fix a start rejected because the task's machine has no worktree
/// root; any other error is returned as it is.
fn with_worktree_root_hint(
    storage: &Storage,
    id: model::TaskId,
    mut error: CommandError,
) -> CommandError {
    if error.kind != CommandErrorKind::InvalidInput {
        return error;
    }
    let Ok(Some(task)) = storage.get_task(id) else {
        return error;
    };
    let Ok(Some(workspace)) = storage.get_workspace(task.workspace_id) else {
        return error;
    };
    let machine = workspace.location.machine();
    let root_missing = match storage.get_machine_settings(&machine) {
        Ok(model::MachineSettings::Local { worktree_root }) => worktree_root.is_none(),
        Ok(model::MachineSettings::Ssh { worktree_root, .. }) => worktree_root.is_none(),
        Err(_) => false,
    };
    if !root_missing {
        return error;
    }
    let host = match &machine {
        model::Machine::Local => String::new(),
        model::Machine::Ssh(label) => format!("ssh_host \"{label}\" and "),
    };
    error.message.push_str(&format!(
        "; ask the user where task worktrees go on that machine, call set_worktree_root \
         with {host}worktree_root set to that absolute directory, then start the task again"
    ));
    error
}

/// Completes (or confirms) a task whose completion criteria are met, as the app does, or with
/// `merged_with`, a task whose work shipped with another task's merged pull request.
pub fn complete_task(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    herdr: &Herdr,
    request: CompleteTask,
) -> CommandResult<Task> {
    let id = request.id.into();
    if request.without_pull_request {
        if request.merged_with.is_some() {
            return Err(CommandError::invalid_input(
                "without_pull_request cannot be combined with merged_with; call complete_task with merged_with only for a merged PR, or with without_pull_request: true and note when no PR exists",
            ));
        }
        return Ok((&completion::complete_without_pull_request(
            storage,
            git,
            github,
            herdr,
            id,
            request.note.as_deref().unwrap_or(""),
        )?)
            .into());
    }
    if request.note.is_some() {
        return Err(CommandError::invalid_input(
            "note requires without_pull_request: true; call complete_task with both arguments for work shipped without a pull request",
        ));
    }
    let task = match request.merged_with {
        None => completion::complete(storage, git, github, herdr, id)?,
        Some(merged_with) => completion::complete_merged_with(
            storage,
            git,
            github,
            herdr,
            id,
            merged_with.target()?,
        )?,
    };
    Ok((&task).into())
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

/// Concludes a task without merging as the app does, except that a task whose pull
/// request is still open is rejected instead of closing it.
pub fn conclude_task(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    herdr: &Herdr,
    request: ConcludeTask,
) -> CommandResult<ConcludedTask> {
    let concluded = completion::conclude(
        storage,
        git,
        github,
        herdr,
        request.id.into(),
        &request.note,
        OpenPullRequest::Reject,
    )?;
    let links = Links::load(&lock(storage))?;
    let blocked_dependents = links.links(links.dependents(concluded.id).filter(|id| {
        links
            .tasks
            .get(id)
            .is_some_and(|task| task.status != crate::domain::status::TaskStatus::Done)
    }));
    Ok(ConcludedTask {
        task: (&concluded).into(),
        message: conclusion_message(concluded.id.0, &blocked_dependents),
        blocked_dependents,
    })
}

/// What concluding task `id` means for `dependents`, the tasks that depend on it.
fn conclusion_message(id: i64, dependents: &[TaskLink]) -> String {
    let Some(first) = dependents.first() else {
        return format!("task {id} is done as not_adopted; no task depends on it.");
    };
    format!(
        "task {id} is done as not_adopted, which blocks every task that depends on it: {}. For each, call remove_dependency (e.g. {{\"task_id\": {}, \"depends_on\": {id}}}) if it can go ahead without this work, or complete_task {id} with merged_with if another merged pull request shipped it.",
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
    pub pull_request_url: Option<String>,
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
            pull_request_url: task.pull_request_url.clone(),
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct StartAgentRun {
    /// An in_progress task of a workspace with runner plain or tmux, e.g. one start_task
    /// started.
    pub task_id: TaskId,
    /// The agent CLI to run: `claude` or `codex`.
    pub adapter: types::AgentAdapter,
    /// What the agent is told to do, on its stdin. Omitted or blank: the task's title,
    /// description, and criteria.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Whether the agent gets this server's MCP endpoint and token in its environment, so
    /// it can call current_task; `true` when omitted.
    #[serde(default)]
    pub mcp: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunStatusRequest {
    /// One run, e.g. the id start_run returned. Pass run_id or task_id, not both.
    #[serde(default)]
    pub run_id: Option<types::RunId>,
    /// Every run of this task, oldest first.
    #[serde(default)]
    pub task_id: Option<TaskId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunLogRequest {
    /// The run, e.g. the id start_run returned or one run_status lists.
    pub run_id: types::RunId,
    /// How much of the end of stdout and of stderr to return, in bytes (1 to 4194304);
    /// the last 65536 bytes of each when omitted.
    #[serde(default)]
    pub tail_bytes: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunRef {
    /// A plain or tmux run, e.g. the id start_run returned or one run_status lists.
    pub run_id: types::RunId,
}

/// A run with whether it may still be running and what to do next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    #[serde(flatten)]
    pub run: types::TaskRun,
    /// Whether the run may still be running: `reserved`, `running`, or `unknown` (its
    /// end was not observed).
    pub active: bool,
    /// What to do next with the run.
    pub next: String,
}

/// One run for `run_id`, or the runs of a task for `task_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RunStatusReply {
    Run(Box<RunStatus>),
    Runs { runs: Vec<RunStatus> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct PullRequestStatusRequest {
    /// The task whose pull request to read; every pull request Toodo watches when
    /// omitted.
    #[serde(default)]
    pub task_id: Option<TaskId>,
}

/// One CI check of a pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    pub name: String,
    pub state: types::ChecksStatus,
    /// How it ended as GitHub reports it (e.g. `failure`, `skipped`); `null` while it runs.
    pub conclusion: Option<String>,
    /// The page with its details or log.
    pub url: Option<String>,
}

/// The latest review of one reviewer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReview {
    pub author: Option<String>,
    /// e.g. `approved`, `changes_requested`, `commented`.
    pub state: String,
}

/// The pull request of an `in_review` task as Toodo's last check read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolledPullRequestStatus {
    pub task_id: TaskId,
    pub url: String,
    /// `open`: Toodo keeps the state of open pull requests only.
    pub state: &'static str,
    pub base: String,
    pub head_sha: Option<String>,
    /// All checks combined: `failing` if any failed, else `pending` if any runs, else
    /// `passing`; `null` without checks.
    pub checks: Option<types::ChecksStatus>,
    pub review: types::ReviewStatus,
    pub check_runs: Vec<PullRequestCheck>,
    pub reviews: Vec<PullRequestReview>,
    /// When Toodo read it, in seconds since the Unix epoch.
    pub checked_at: i64,
    /// What to do next with it.
    pub next: String,
}

/// One pull request for `task_id`, or every one Toodo watches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PullRequestStatusReply {
    One(Box<PolledPullRequestStatus>),
    #[serde(rename_all = "camelCase")]
    All {
        pull_requests: Vec<PolledPullRequestStatus>,
    },
}

/// The pull request state the background check keeps in `polled`, without running `gh`:
/// the one of `task_id`, or all of them ordered by task ID.
pub fn pull_request_status(
    storage: &Storage,
    polled: &HashMap<model::TaskId, completion::PolledPullRequest>,
    request: PullRequestStatusRequest,
) -> CommandResult<PullRequestStatusReply> {
    let Some(id) = request.task_id else {
        let mut all: Vec<_> = polled
            .iter()
            .map(|(&id, polled)| polled_status(id, polled))
            .collect();
        all.sort_by_key(|status| status.task_id.0);
        return Ok(PullRequestStatusReply::All { pull_requests: all });
    };
    let task_id = id.into();
    if let Some(found) = polled.get(&task_id) {
        return Ok(PullRequestStatusReply::One(Box::new(polled_status(
            task_id, found,
        ))));
    }
    let task = storage
        .get_task(task_id)?
        .ok_or(StorageError::TaskNotFound(task_id))?;
    let id = task.id;
    Err(CommandError::rejected(
        match (&task.pull_request_url, task.status) {
            (_, crate::domain::status::TaskStatus::Done) => format!(
                "task {id} is done, and Toodo keeps the state of open pull requests only; read its \
             pull request and completion with get_task {{\"task_id\": {id}}}"
            ),
            (None, _) => format!(
                "task {id} has no pull request yet; push its branch and open one into the \
             workspace base branch (gh pr create --base <baseBranch> --head <branch>), then \
             call pull_request_status again after a minute, when Toodo has read it"
            ),
            (Some(url), status) => format!(
                "Toodo has not read pull request {url} of task {id} yet: it reads the open pull \
             requests of in_review tasks every minute, and this task is {status}; call \
             pull_request_status again after a minute, or get_task {{\"task_id\": {id}}} \
             for the task's status"
            ),
        },
    ))
}

fn polled_status(
    task: model::TaskId,
    polled: &completion::PolledPullRequest,
) -> PolledPullRequestStatus {
    use crate::adapters::github::{ChecksState, PullRequestState, ReviewState};
    let viewed = &polled.viewed;
    let status = viewed.status;
    let next = match (status.checks, status.review) {
        (Some(ChecksState::Failing), _) => {
            "a check failed; read the failing checks at their url, fix them, and push; Toodo \
             reads the pull request again every minute"
        }
        (_, ReviewState::ChangesRequested) => "a reviewer requested changes; address them and push",
        (Some(ChecksState::Pending), _) => {
            "checks are still running; call pull_request_status again after a minute"
        }
        (Some(ChecksState::Passing), _) => {
            "every check passed; merge only as the workspace's agentMerge allows (current_task \
             returns it), otherwise wait for the user"
        }
        (None, _) => "the pull request has no checks; wait for the user to review and merge it",
    };
    PolledPullRequestStatus {
        task_id: task.into(),
        url: viewed.pull_request.url.clone(),
        state: match viewed.pull_request.state {
            PullRequestState::Open => "open",
            PullRequestState::Closed => "closed",
            PullRequestState::Merged => "merged",
        },
        base: viewed.pull_request.base.clone(),
        head_sha: viewed.head_sha.clone(),
        checks: status.checks.map(Into::into),
        review: status.review.into(),
        check_runs: viewed
            .check_runs
            .iter()
            .map(|run| PullRequestCheck {
                name: run.name.clone(),
                state: run.state.into(),
                conclusion: run.conclusion.clone(),
                url: run.url.clone(),
            })
            .collect(),
        reviews: viewed
            .reviews
            .iter()
            .map(|review| PullRequestReview {
                author: review.author.clone(),
                state: review.state.clone(),
            })
            .collect(),
        checked_at: polled.checked_at,
        next: next.to_owned(),
    }
}

/// Starts an agent CLI for an `in_progress` task of a workspace with runner plain or
/// tmux, as the app's Start run does; `mcp` defaults to `true`.
pub fn start_run(
    storage: &StorageState,
    plain: &PlainRunState,
    tmux: &TmuxRunState,
    request: StartAgentRun,
) -> CommandResult<types::TaskRun> {
    run_commands::start_plain_run(
        State(storage),
        State(plain),
        State(tmux),
        request.task_id,
        request.adapter,
        request.prompt,
        request.mcp.unwrap_or(true),
    )
}

/// The run `run_id`, or every run of `task_id`, each with what to do next.
pub fn run_status(storage: &Storage, request: RunStatusRequest) -> CommandResult<RunStatusReply> {
    match (request.run_id, request.task_id) {
        (Some(id), None) => {
            let id = id.into();
            let run = storage.get_run(id)?.ok_or(StorageError::RunNotFound(id))?;
            Ok(RunStatusReply::Run(Box::new(run_status_of(&run))))
        }
        (None, Some(task)) => {
            let task = task.into();
            storage
                .get_task(task)?
                .ok_or(StorageError::TaskNotFound(task))?;
            let runs = storage.list_task_runs(task)?;
            Ok(RunStatusReply::Runs {
                runs: runs.iter().map(run_status_of).collect(),
            })
        }
        _ => Err(CommandError::invalid_input(
            "pass exactly one of run_id (one run, e.g. {\"run_id\": 12}) or task_id (every run \
             of a task, e.g. {\"task_id\": 5})",
        )),
    }
}

fn run_status_of(run: &storage::TaskRun) -> RunStatus {
    use crate::domain::runtime::{RunState, RunnerKind};
    let id = run.id;
    let managed = matches!(run.runner_kind, RunnerKind::Plain | RunnerKind::Tmux);
    let next = match (run.state, managed) {
        (RunState::Queued, true) => format!(
            "it waits in the queue of its machine, which runs no more runs at once than its \
             limit; it starts on its own when a run there ends, so call run_status again \
             later, or stop_run with run_id {id} to leave the queue"
        ),
        (RunState::Reserved | RunState::Running, true) => format!(
            "it is running; call run_status again later, run_log with run_id {id} for its \
             output so far, or stop_run to stop it"
        ),
        (RunState::Unknown, true)
            if run.runner_kind == RunnerKind::Plain && run.host == HostRef::Local =>
        {
            format!(
                "its end was not observed, since the server restarted while it ran; a local \
                 plain run cannot be settled from its host, so call stop_run with run_id {id} \
                 to end it"
            )
        }
        (RunState::Unknown, true) => format!(
            "its end was not observed, e.g. after a server restart or an SSH disconnect; call \
             reconcile_run with run_id {id} to settle it from what its host recorded, or \
             stop_run to stop it"
        ),
        (_, true) => {
            format!("it has ended; call run_log with run_id {id} to read its result and output")
        }
        (state, false) if state.is_active() => format!(
            "it is a {} run, which Toodo does not run itself; follow it where it runs, e.g. \
             in the task's herdr pane",
            run.runner_kind
        ),
        (_, false) => "it has ended".to_owned(),
    };
    RunStatus {
        run: run.into(),
        active: run.state.is_open(),
        next,
    }
}

/// A plain or tmux run with its events and the ends of its stdout and stderr.
pub fn run_log(
    storage: &StorageState,
    plain: &PlainRunState,
    tmux: &TmuxRunState,
    request: RunLogRequest,
) -> CommandResult<types::RunLog> {
    run_commands::get_run_log(
        State(storage),
        State(plain),
        State(tmux),
        request.run_id,
        request.tail_bytes,
    )
}

/// Stops a plain or tmux run, which ends as `cancelled`.
pub fn stop_run(
    storage: &StorageState,
    plain: &PlainRunState,
    tmux: &TmuxRunState,
    request: RunRef,
) -> CommandResult<types::TaskRun> {
    run_commands::stop_run(State(storage), State(plain), State(tmux), request.run_id)
}

/// Settles a plain or tmux run whose end was not observed from what its host recorded.
pub fn reconcile_run(
    storage: &StorageState,
    plain: &PlainRunState,
    tmux: &TmuxRunState,
    request: RunRef,
) -> CommandResult<types::TaskRun> {
    run_commands::reconcile_run(State(storage), State(plain), State(tmux), request.run_id)
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
    use crate::adapters::github::GhCli;
    use crate::commands::CommandErrorKind;
    use crate::domain::model::{self, HostPath, WorkspaceLocation};
    use crate::domain::path::{PosixPath, WindowsPath};
    use crate::domain::status::TaskStatus as DomainStatus;
    use crate::storage::NewWorkspace;

    fn storage_with_workspace() -> (Storage, WorkspaceId) {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source: crate::domain::model::Source::GitHub,
                completion: crate::domain::model::CompletionMode::PullRequestMerge,
                runner: crate::domain::model::Runner::Herdr,
                axes_detected: true,
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
                workspace_id: workspace,
                task_type: TaskType::Feat,
                title: title.to_owned(),
                description: String::new(),
                depends_on,
                related: Vec::new(),
                estimate: None,
                due_date: None,
                labels: Vec::new(),
                criteria: Vec::new(),
                merge_criterion: None,
                request_id: None,
            },
            Some(NewCriterion::merge(true)),
        )
    }

    fn set_worktree(storage: &mut Storage, id: TaskId, path: HostPath) {
        let mut task = storage.get_task(id.into()).unwrap().unwrap();
        task.worktree_path = Some(path);
        storage.update_task(&task).unwrap();
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
    fn a_blocking_prerequisite_pauses_the_task_but_leaves_its_herdr_workspace_open() {
        use crate::domain::status::TaskStatus;
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
        let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
        storage
            .set_task_status(task.id.into(), TaskStatus::InProgress)
            .unwrap();
        storage
            .set_task_herdr_workspace(task.id.into(), "w1")
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
        assert_eq!(paused.herdr_workspace_id.as_deref(), Some("w1"));
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
        branched.branch = Some("feat/verify-1".to_owned());
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
                id: task.id,
                task_type: None,
                title: None,
                description: Some("Add tables".to_owned()),
                estimate: None,
                due_date: None,
                labels: None,
                criteria: None,
                remove_merge_criterion: false,
            },
            None,
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
        update_task(storage, serde_json::from_value(request).unwrap(), None)
    }

    #[test]
    fn add_criterion_appends_one_and_keeps_the_others_with_their_evidence() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = task_with_checked_criterion(&mut storage, workspace);
        let add = |storage: &mut Storage, request: serde_json::Value| {
            add_criterion(storage, serde_json::from_value(request).unwrap(), None)
        };
        let added = add(
            &mut storage,
            serde_json::json!({ "task_id": task.id, "text": "Tests pass", "kind": "command", "target": "npm test" }),
        )
        .unwrap();
        assert_eq!(added.criteria.len(), 3);
        assert_eq!(added.criteria[..2], task.criteria[..]);
        assert_eq!(added.criteria[2].text, "Tests pass");
        assert_eq!(added.criteria[2].target.as_deref(), Some("npm test"));
        assert_eq!(added.criteria[2].state, types::CriterionState::Pending);

        let error = add(
            &mut storage,
            serde_json::json!({ "task_id": task.id, "text": "Merged", "kind": "branch_merged_locally" }),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(
            error.message.contains("one merge criterion"),
            "{}",
            error.message
        );
        assert_eq!(get_task(&storage, task.id).unwrap().criteria.len(), 3);
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
    fn dropping_the_merge_criterion_needs_remove_merge_criterion() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = task_with_checked_criterion(&mut storage, workspace);
        let [merge, manual] = [task.criteria[0].id.0, task.criteria[1].id.0];
        let error = update(
            &mut storage,
            serde_json::json!({ "id": task.id, "criteria": [{ "id": manual }] }),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains(&format!("adding {{\"id\": {merge}}} to criteria"))
                && error.message.contains("remove_merge_criterion: true"),
            "{}",
            error.message
        );
        assert_eq!(get_task(&storage, task.id).unwrap().criteria, task.criteria);

        let removed = update(
            &mut storage,
            serde_json::json!({
                "id": task.id, "criteria": [{ "id": manual }], "remove_merge_criterion": true
            }),
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
        let task = insert_task(&mut storage, request, None).unwrap();
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
            update_task(storage, serde_json::from_value(request).unwrap(), None)
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

    fn plan(tasks: serde_json::Value) -> CreatePlan {
        serde_json::from_value(serde_json::json!({ "tasks": tasks })).unwrap()
    }

    #[test]
    fn delete_task_deletes_a_planned_task_only_when_confirmed() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
        let dependent = create(&mut storage, workspace, "Use login", vec![task.id]).unwrap();
        let done = create(&mut storage, workspace, "Ship login", vec![]).unwrap();
        storage
            .set_task_status(done.id.into(), DomainStatus::InProgress)
            .unwrap();
        storage
            .conclude_task(done.id.into(), "Not needed", &[], None)
            .unwrap();
        let storage = std::sync::Arc::new(StorageState::new(storage));
        let runs = tempfile::tempdir().unwrap();
        let plain = PlainRunState::new(storage.clone(), runs.path(), "0123456789ab");
        let tmux = TmuxRunState::new(storage.clone(), runs.path(), "0123456789ab");
        let (git, _) = fake(Git::new, vec![]);
        let (herdr, _) = fake(Herdr::new, vec![]);
        let delete = |id: TaskId, confirm: bool| {
            delete_task(
                &storage,
                &git,
                &herdr,
                &plain,
                &tmux,
                DeleteTask {
                    id,
                    confirm,
                    force: false,
                },
            )
        };

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

        let error = delete(done.id, true).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("reopen_task"), "{}", error.message);
        assert!(lock(&storage).get_task(done.id.into()).unwrap().is_some());
    }

    #[test]
    fn reopen_task_reopens_a_done_task_only_when_confirmed() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
        storage
            .set_task_status(task.id.into(), DomainStatus::InProgress)
            .unwrap();
        storage
            .conclude_task(task.id.into(), "Too slow", &[], None)
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
                 "title": "Schema", "labels": ["search"], "merge_criterion": false,
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
        assert_eq!(api.criteria[0].kind, types::CheckKind::PrMerged);
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
            criteria: Vec::new(),
        };
        let item = |task, depends_on| crate::storage::NewPlanTask {
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
        let task = insert_task(&mut storage, request, None).unwrap();
        assert_eq!(task.labels, ["q4-goal", "search"]);

        let update = |storage: &mut Storage, fields: serde_json::Value| {
            let mut request = serde_json::json!({ "id": task.id });
            request
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            update_task(storage, serde_json::from_value(request).unwrap(), None)
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
            .conclude_task(research.id.into(), "Too heavy for a desktop app", &[], None)
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
    fn the_current_task_is_the_one_whose_worktree_contains_the_cwd() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        create(&mut storage, workspace, "Other", vec![]).unwrap();
        set_worktree(
            &mut storage,
            task.id,
            HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-schema-1").unwrap()),
        );
        let find = |cwd: &str| {
            current_task(
                &storage,
                CurrentTask {
                    cwd: cwd.to_owned(),
                    machine: None,
                },
            )
        };

        let found = find(r"D:\wt\toodo\feat-schema-1").unwrap();
        assert_eq!(found.task.id, task.id);
        assert_eq!(found.base_branch, "main");
        let json = serde_json::to_value(&found).unwrap();
        assert_eq!(json["baseBranch"], "main");
        assert_eq!(json["id"], serde_json::json!(task.id));
        assert_eq!(
            find("d:/WT/toodo/feat-schema-1/src/").unwrap().task.id,
            task.id
        );
        let error = find(r"D:\wt\toodo\feat-schema-10").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        assert!(find(r"D:\wt\toodo").is_err());
    }

    #[test]
    fn the_current_task_tells_whether_the_agent_merges_its_pull_request() {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
        set_worktree(
            &mut storage,
            task.id,
            HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-schema-1").unwrap()),
        );
        let agent_merge = |storage: &Storage| {
            let found = current_task(
                storage,
                CurrentTask {
                    cwd: r"D:\wt\toodo\feat-schema-1".to_owned(),
                    machine: None,
                },
            )
            .unwrap();
            serde_json::to_value(&found).unwrap()["agentMerge"].clone()
        };
        assert_eq!(agent_merge(&storage), "never");

        let mut saved = storage.get_workspace(workspace.into()).unwrap().unwrap();
        saved.agent_merge = model::AgentMerge::AfterChecks;
        storage.update_workspace(&saved).unwrap();
        assert_eq!(agent_merge(&storage), "afterChecks");
    }

    #[test]
    fn posix_worktrees_are_matched_case_sensitively() {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "server".to_owned(),
                location: WorkspaceLocation::Ssh {
                    machine: model::MachineLabel::parse("devbox").unwrap(),
                    path: PosixPath::parse("/srv/app").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source: crate::domain::model::Source::GitHub,
                completion: crate::domain::model::CompletionMode::PullRequestMerge,
                runner: crate::domain::model::Runner::Herdr,
                axes_detected: true,
            })
            .unwrap();
        let task = create(&mut storage, workspace.id.into(), "Remote", vec![]).unwrap();
        set_worktree(
            &mut storage,
            task.id,
            HostPath::Posix(PosixPath::parse("/wt/app/feat-remote-1").unwrap()),
        );
        let find = |cwd: &str| {
            current_task(
                &storage,
                CurrentTask {
                    cwd: cwd.to_owned(),
                    machine: None,
                },
            )
        };
        assert_eq!(find("/wt/app/feat-remote-1/src").unwrap().task.id, task.id);
        assert!(find("/WT/app/feat-remote-1").is_err());
        assert_eq!(
            find("/wt/app/other/../feat-remote-1/./src")
                .unwrap()
                .task
                .id,
            task.id
        );
        assert!(find("/wt/app/feat-remote-1/../outside").is_err());
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
                location: WorkspaceLocation::Ssh {
                    machine: model::MachineLabel::parse("devbox").unwrap(),
                    path: WindowsPath::parse(r"C:\srv\app").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source: crate::domain::model::Source::GitHub,
                completion: crate::domain::model::CompletionMode::PullRequestMerge,
                runner: crate::domain::model::Runner::Herdr,
                axes_detected: true,
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
    fn the_current_task_is_scoped_to_the_machine_the_agent_runs_on() {
        let (mut storage, local) = storage_with_workspace();
        let remote = storage
            .create_workspace(&NewWorkspace {
                name: "server".to_owned(),
                location: WorkspaceLocation::Ssh {
                    machine: model::MachineLabel::parse("devbox").unwrap(),
                    path: WindowsPath::parse(r"C:\srv\app").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source: crate::domain::model::Source::GitHub,
                completion: crate::domain::model::CompletionMode::PullRequestMerge,
                runner: crate::domain::model::Runner::Herdr,
                axes_detected: true,
            })
            .unwrap();
        let here = create(&mut storage, local, "Here", vec![]).unwrap();
        let there = create(&mut storage, remote.id.into(), "There", vec![]).unwrap();
        for id in [here.id, there.id] {
            set_worktree(
                &mut storage,
                id,
                HostPath::Windows(WindowsPath::parse(r"D:\wt\shared").unwrap()),
            );
        }
        let find = |machine: Option<&str>| {
            current_task(
                &storage,
                CurrentTask {
                    cwd: r"D:\wt\shared\src".to_owned(),
                    machine: machine.map(str::to_owned),
                },
            )
        };

        let error = find(None).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("on devbox"), "{}", error.message);
        assert_eq!(find(Some("local")).unwrap().task.id, here.id);
        let found = find(Some("devbox")).unwrap();
        assert_eq!(found.task.id, there.id);
        assert_eq!(
            serde_json::to_value(&found).unwrap()["machine"]["label"],
            "devbox"
        );
        assert_eq!(
            find(Some("gpu")).unwrap_err().kind,
            CommandErrorKind::NotFound
        );
    }

    type Scripted = Vec<Result<String, crate::adapters::git::GitError>>;

    /// An adapter whose runner returns `results` in order, and the runner.
    fn fake<T>(
        new: impl FnOnce(Box<dyn crate::adapters::git::Runner>) -> T,
        results: Scripted,
    ) -> (T, std::sync::Arc<crate::adapters::git::fake::FakeRunner>) {
        let runner = std::sync::Arc::new(crate::adapters::git::fake::FakeRunner::new(results));
        (new(Box::new(runner.clone())), runner)
    }

    const PR: &str = "https://github.com/acme/toodo/pull/12";

    /// `gh pr view` output for the pull request in `state`.
    fn viewed(state: &str) -> Result<String, crate::adapters::git::GitError> {
        let merged_at = if state == "MERGED" {
            r#""2026-10-09T14:47:45Z""#
        } else {
            "null"
        };
        Ok(format!(
            r#"{{"baseRefName":"main","mergedAt":{merged_at},"state":"{state}","url":"{PR}","statusCheckRollup":[],"reviewDecision":"","latestReviews":[]}}"#
        ))
    }

    /// `gh pr list` output with the pull request in `state`.
    fn listed(state: &str) -> Result<String, crate::adapters::git::GitError> {
        let merged_at = if state == "MERGED" {
            r#""2026-10-09T14:47:45Z""#
        } else {
            "null"
        };
        Ok(format!(
            r#"[{{"baseRefName":"main","mergedAt":{merged_at},"state":"{state}","url":"{PR}"}}]"#
        ))
    }

    /// Git output for a branch log with no commits and an `origin` on GitHub.
    fn github_checkout() -> Scripted {
        vec![
            Ok(String::new()),
            Ok("origin\n".to_owned()),
            Ok("git@github.com:acme/toodo.git\n".to_owned()),
        ]
    }

    const MERGED_DETAILS: &str = r#"{"additions":1,"author":{"login":"ada"},"changedFiles":1,"commits":[],"deletions":0,"mergeCommit":{"oid":"2222222222222222222222222222222222222222"},"number":12,"reviews":[],"title":"Add login"}"#;

    const CLOSED: &str = r#"{"id":"cli:workspace:close","result":{"type":"ok"}}"#;

    /// A task started in herdr workspace `w27`, in review with a pull request if
    /// `in_review`, and a planned task that depends on it.
    fn started(in_review: bool) -> (StorageState, Task, Task) {
        let (mut storage, workspace) = storage_with_workspace();
        let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
        let dependent = create(&mut storage, workspace, "Use login", vec![task.id]).unwrap();
        let checkout = crate::domain::naming::TaskCheckout {
            path: HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap()),
            branch: "feat/add-login-1".to_owned(),
        };
        let mut started = storage
            .start_task(task.id.into(), &checkout, "w27")
            .unwrap();
        if in_review {
            started = storage
                .open_pull_request(task.id.into(), &[], PR, None)
                .unwrap();
        }
        (std::sync::Mutex::new(storage), (&started).into(), dependent)
    }

    fn stored(storage: &StorageState, id: TaskId) -> Task {
        get_task(&crate::commands::lock(storage), id).unwrap()
    }

    fn last_status(task: &Task) -> Option<types::TaskStatus> {
        task.timeline.last().map(|event| event.status)
    }

    fn server_status() -> ServerStatus {
        ServerStatus {
            url: crate::mcp::url(47617),
            token: Some("secret".to_owned()),
            token_file: Some("/home/me/toodo data/mcp-token".into()),
            instance: "0123456789ab".to_owned(),
            error: None,
            rejections: Default::default(),
        }
    }

    #[test]
    fn agent_commands_get_the_mcp_url_and_token_without_the_token_typed() {
        let mut server = server_status();
        assert_eq!(
            with_mcp_env(&server, "claude"),
            "export TOODO_MCP_URL='http://127.0.0.1:47617/mcp'; \
             export TOODO_MCP_TOKEN=\"$(cat '/home/me/toodo data/mcp-token')\"; claude"
        );
        assert!(!with_mcp_env(&server, "claude").contains("secret"));
        server.token_file = None;
        assert_eq!(with_mcp_env(&server, "claude"), "claude");
    }

    #[test]
    fn an_agent_command_is_typed_into_its_pane_as_a_writer_run_of_the_task() {
        let (storage, task, _) = started(false);
        let (herdr, herdr_runner) = fake(
            Herdr::new,
            vec![
                Err(crate::adapters::git::GitError::Failed {
                    command: "herdr pane run".to_owned(),
                    stderr: r#"{"error":{"code":"pane_not_found","message":"no pane"}}"#.to_owned(),
                }),
                Ok(String::new()),
            ],
        );
        let id = task.id.into();

        let error = run_agent(&storage, &herdr, id, "w27:p1", "claude".to_owned()).unwrap_err();
        let ran_in = run_agent(&storage, &herdr, id, "w27:p1", "claude".to_owned()).unwrap();

        assert!(error.contains("no pane"), "{error}");
        assert_eq!(ran_in, "w27:p1");
        let storage = crate::commands::lock(&storage);
        let open = storage.open_runtime_workspace(id).unwrap().unwrap();
        let runs = storage.list_task_runs(id).unwrap();
        use crate::domain::runtime::RunState;
        assert_eq!(
            runs.iter()
                .map(|run| (run.request_key.as_str(), run.state, run.role))
                .collect::<Vec<_>>(),
            [
                ("mcp-agent-1-1", RunState::Failed, RunRole::Writer),
                ("mcp-agent-1-2", RunState::Running, RunRole::Writer),
            ]
        );
        assert_eq!(runs[1].runtime_workspace, Some(open.id));
        assert_eq!(runs[1].checkout_path, open.checkout_path);
        assert_eq!(runs[1].provider_run_ref.as_deref(), Some("w27:p1"));
        let invocations = herdr_runner.invocations.lock().unwrap();
        assert_eq!(invocations[1].args, ["pane", "run", "w27:p1", "claude"]);
    }

    #[test]
    fn start_is_rejected_for_a_task_that_is_not_ready_or_not_planned() {
        let (storage, task, dependent) = started(false);
        let (git, git_runner) = fake(Git::new, vec![]);
        let (herdr, herdr_runner) = fake(Herdr::new, vec![]);

        let error = start_task(
            &storage,
            &git,
            &herdr,
            &server_status(),
            StartTask {
                id: dependent.id,
                agent_command: None,
                request_id: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("cannot start yet"),
            "{}",
            error.message
        );
        let error = start_task(
            &storage,
            &git,
            &herdr,
            &server_status(),
            StartTask {
                id: task.id,
                agent_command: None,
                request_id: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);

        assert!(git_runner.invocations.lock().unwrap().is_empty());
        assert!(herdr_runner.invocations.lock().unwrap().is_empty());
        assert_eq!(stored(&storage, dependent.id), dependent);
    }

    #[test]
    fn pause_keeps_the_work_and_records_the_reason() {
        let (storage, task, _) = started(false);
        let pause = |id, reason: &str| {
            pause_task(
                &mut crate::commands::lock(&storage),
                PauseTask {
                    id,
                    reason: reason.to_owned(),
                },
            )
        };

        let error = pause(task.id, "  ").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert_eq!(stored(&storage, task.id), task);

        let paused = pause(task.id, " Waiting for the API design ").unwrap();
        assert_eq!(paused.status, TaskStatus::Planned);
        assert_eq!(paused.branch.as_deref(), Some("feat/add-login-1"));
        assert_eq!(paused.herdr_workspace_id.as_deref(), Some("w27"));
        assert!(paused.milestones.paused_at.is_some());
        let note = paused.notes.last().unwrap();
        assert_eq!(note.kind, types::NoteKind::Progress);
        assert_eq!(note.body, "Paused: Waiting for the API design");

        let error = pause(task.id, "Again").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("resume_task"), "{}", error.message);
    }

    #[test]
    fn resume_is_rejected_for_a_task_that_is_not_paused() {
        let (storage, task, dependent) = started(false);
        let (git, git_runner) = fake(Git::new, vec![]);
        let (herdr, herdr_runner) = fake(Herdr::new, vec![]);
        let resume = |id| {
            resume_task(
                &storage,
                &git,
                &herdr,
                ResumeTask {
                    id,
                    note: Some("Continue".to_owned()),
                },
            )
            .unwrap_err()
        };

        let error = resume(dependent.id);
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("start_task"), "{}", error.message);
        let error = resume(task.id);
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("pause_task"), "{}", error.message);

        assert!(git_runner.invocations.lock().unwrap().is_empty());
        assert!(herdr_runner.invocations.lock().unwrap().is_empty());
        assert_eq!(stored(&storage, task.id), task);
        assert_eq!(stored(&storage, dependent.id), dependent);
    }

    #[test]
    fn complete_finishes_a_task_whose_pull_request_is_merged_and_only_that() {
        let (storage, task, _) = started(true);
        let (no_git, _) = fake(Git::new, vec![]);
        let (open, _) = fake(GhCli::new, vec![viewed("OPEN")]);
        let (no_herdr, _) = fake(Herdr::new, vec![]);

        let error = complete_task(&storage, &no_git, &open, &no_herdr, own(task.id)).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("is not merged yet"),
            "{}",
            error.message
        );
        assert_eq!(stored(&storage, task.id), task);

        let (merged, _) = fake(
            GhCli::new,
            vec![viewed("MERGED"), Ok(MERGED_DETAILS.to_owned())],
        );
        let (herdr, herdr_runner) = fake(Herdr::new, vec![Ok(CLOSED.to_owned())]);
        let done = complete_task(&storage, &no_git, &merged, &herdr, own(task.id)).unwrap();
        assert_eq!(done.status, types::TaskStatus::Done);
        assert_eq!(done.resolution, Some(types::TaskResolution::Merged));
        assert_eq!(last_status(&done), Some(types::TaskStatus::Done));
        assert_eq!(done.herdr_workspace_id, None);
        assert_eq!(stored(&storage, task.id), done);
        assert_eq!(
            herdr_runner.invocations.lock().unwrap()[0].args,
            ["workspace", "close", "w27"]
        );
    }

    #[test]
    fn complete_is_rejected_when_the_branch_has_no_pull_request() {
        let (storage, task, _) = started(false);
        let (git, _) = fake(Git::new, vec![Ok(String::new())]);
        let (github, gh_runner) = fake(GhCli::new, vec![]);
        let (herdr, _) = fake(Herdr::new, vec![]);

        let error = complete_task(&storage, &git, &github, &herdr, own(task.id)).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("the task has no pull request yet"),
            "{}",
            error.message
        );
        assert!(gh_runner.invocations.lock().unwrap().is_empty());
        assert_eq!(stored(&storage, task.id), task);
    }

    fn own(id: TaskId) -> CompleteTask {
        CompleteTask {
            id,
            merged_with: None,
            without_pull_request: false,
            note: None,
        }
    }

    #[test]
    fn complete_accepts_without_pull_request_and_a_note() {
        let (storage, task, dependent) = started(false);
        let (git, _) = fake(Git::new, vec![Ok(String::new()), Ok(String::new())]);
        let (github, _) = fake(GhCli::new, vec![]);
        let (herdr, _) = fake(Herdr::new, vec![Ok(CLOSED.to_owned())]);
        let request = serde_json::from_value(serde_json::json!({
            "id": task.id, "without_pull_request": true, "note": "Deployed directly"
        }))
        .unwrap();

        let done = complete_task(&storage, &git, &github, &herdr, request).unwrap();

        assert_eq!(done.resolution, Some(types::TaskResolution::Completed));
        assert_eq!(done.completion_note.as_deref(), Some("Deployed directly"));
        assert_eq!(done.criteria[0].evidence, done.completion_note);
        crate::commands::lock(&storage)
            .ensure_ready(dependent.id.into())
            .unwrap();
    }

    #[test]
    fn complete_rejects_missing_notes_and_conflicting_modes_before_external_calls() {
        let (storage, task, _) = started(false);
        let (git, _) = fake(Git::new, vec![]);
        let (github, _) = fake(GhCli::new, vec![]);
        let (herdr, _) = fake(Herdr::new, vec![]);
        for arguments in [
            serde_json::json!({"id": task.id, "without_pull_request": true}),
            serde_json::json!({"id": task.id, "without_pull_request": true, "note": "  "}),
            serde_json::json!({"id": task.id, "without_pull_request": true, "note": "Shipped", "merged_with": 2}),
            serde_json::json!({"id": task.id, "note": "Shipped"}),
        ] {
            let request = serde_json::from_value(arguments).unwrap();

            let error = complete_task(&storage, &git, &github, &herdr, request).unwrap_err();

            assert_eq!(error.kind, CommandErrorKind::InvalidInput);
            assert_eq!(stored(&storage, task.id), task);
        }
    }

    fn merged_with(id: TaskId, target: MergedWithRef) -> CompleteTask {
        CompleteTask {
            id,
            merged_with: Some(target),
            without_pull_request: false,
            note: None,
        }
    }

    /// `started(true)` with its task completed by the merge of its pull request, and an
    /// extra task of the same workspace started in herdr workspace `w28` whose work that
    /// pull request shipped too.
    fn shipped() -> (StorageState, Task, Task) {
        let (storage, task, _) = started(true);
        let extra = {
            let mut storage = crate::commands::lock(&storage);
            storage
                .complete_task(task.id.into(), Some(1_760_021_265), None, &[])
                .unwrap();
            let extra = create(&mut storage, task.workspace_id, "Fix typo", vec![]).unwrap();
            let checkout = crate::domain::naming::TaskCheckout {
                path: HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\fix-typo-3").unwrap()),
                branch: "fix/typo-3".to_owned(),
            };
            (&storage
                .start_task(extra.id.into(), &checkout, "w28")
                .unwrap())
                .into()
        };
        let task = stored(&storage, task.id);
        (storage, task, extra)
    }

    #[test]
    fn complete_with_merged_with_ships_a_task_through_another_tasks_pull_request() {
        let (storage, task, extra) = shipped();
        let (git, _) = fake(Git::new, github_checkout());
        let (github, gh_runner) = fake(GhCli::new, vec![Ok("[]".to_owned())]);
        let (herdr, herdr_runner) = fake(Herdr::new, vec![Ok(CLOSED.to_owned())]);

        let done = complete_task(
            &storage,
            &git,
            &github,
            &herdr,
            merged_with(extra.id, MergedWithRef::Text(format!(" #{} ", task.id.0))),
        )
        .unwrap();

        assert_eq!(done.status, types::TaskStatus::Done);
        assert_eq!(done.resolution, Some(types::TaskResolution::Merged));
        assert_eq!(
            done.merged_with,
            Some(types::MergedWith {
                task_id: Some(task.id),
                pull_request_url: Some(PR.to_owned()),
            })
        );
        assert_eq!(done.pull_request_merged_at, task.pull_request_merged_at);
        assert_eq!(done.pull_request_url, None);
        assert_eq!(last_status(&done), Some(types::TaskStatus::Done));
        assert_eq!(done.herdr_workspace_id, None);
        assert_eq!(stored(&storage, extra.id), done);
        // Only the pull requests of its own branch were looked up.
        assert_eq!(gh_runner.invocations.lock().unwrap().len(), 1);
        assert_eq!(
            herdr_runner.invocations.lock().unwrap()[0].args,
            ["workspace", "close", "w28"]
        );
    }

    #[test]
    fn complete_with_merged_with_ships_through_a_task_done_without_a_pull_request() {
        for (resolution, expected) in [
            (
                model::TaskResolution::Completed,
                types::TaskResolution::Completed,
            ),
            (model::TaskResolution::Merged, types::TaskResolution::Merged),
        ] {
            let (storage, _, extra) = shipped();
            let target = {
                let mut storage = crate::commands::lock(&storage);
                let target =
                    create(&mut storage, extra.workspace_id, "Deploy config", vec![]).unwrap();
                let id = target.id.into();
                storage
                    .set_task_status(id, crate::domain::status::TaskStatus::InProgress)
                    .unwrap();
                match resolution {
                    model::TaskResolution::Completed => {
                        storage
                            .complete_task_without_pull_request(id, "Deployed", &[])
                            .unwrap();
                    }
                    _ => {
                        // A recorded merge without a pull request URL.
                        storage.complete_task(id, Some(1_000), None, &[]).unwrap();
                    }
                }
                target.id
            };
            assert_eq!(
                stored(&storage, target).resolution,
                Some(expected),
                "target done as {expected:?}"
            );
            let (git, _) = fake(Git::new, github_checkout());
            let (github, _) = fake(GhCli::new, vec![Ok("[]".to_owned())]);
            let (herdr, _) = fake(Herdr::new, vec![Ok(CLOSED.to_owned())]);

            let done = complete_task(
                &storage,
                &git,
                &github,
                &herdr,
                merged_with(extra.id, MergedWithRef::Task(target.0)),
            )
            .unwrap();

            assert_eq!(done.resolution, Some(expected));
            assert_eq!(
                done.merged_with,
                Some(types::MergedWith {
                    task_id: Some(target),
                    pull_request_url: None,
                })
            );
            assert_eq!(stored(&storage, extra.id), done);
        }
    }

    #[test]
    fn complete_with_merged_with_changes_a_task_concluded_as_not_adopted() {
        let (storage, task, extra) = shipped();
        let concluded: Task = (&crate::commands::lock(&storage)
            .conclude_task(
                extra.id.into(),
                "Fixed by the login pull request",
                &[],
                None,
            )
            .unwrap())
            .into();
        let (no_git, git_runner) = fake(Git::new, vec![]);
        let (github, _) = fake(GhCli::new, vec![viewed("MERGED")]);
        let (no_herdr, herdr_runner) = fake(Herdr::new, vec![]);

        let done = complete_task(
            &storage,
            &no_git,
            &github,
            &no_herdr,
            merged_with(extra.id, MergedWithRef::Text(PR.to_owned())),
        )
        .unwrap();

        assert_eq!(done.resolution, Some(types::TaskResolution::Merged));
        // The pull request URL finds the task that owns it.
        assert_eq!(
            done.merged_with,
            Some(types::MergedWith {
                task_id: Some(task.id),
                pull_request_url: Some(PR.to_owned()),
            })
        );
        assert_eq!(done.timeline, concluded.timeline);
        assert_eq!(done.completion_note, concluded.completion_note);
        assert_eq!(stored(&storage, extra.id), done);
        assert!(git_runner.invocations.lock().unwrap().is_empty());
        assert!(herdr_runner.invocations.lock().unwrap().is_empty());

        // Completing it again, either way, has nothing left to do.
        let (no_github, _) = fake(GhCli::new, vec![]);
        let error = complete_task(
            &storage,
            &no_git,
            &no_github,
            &no_herdr,
            merged_with(extra.id, MergedWithRef::Task(task.id.0)),
        )
        .unwrap_err();
        assert!(
            error.message.contains("already done as merged"),
            "{}",
            error.message
        );
    }

    #[test]
    fn complete_of_a_not_adopted_task_without_merged_with_suggests_it() {
        let (storage, _, extra) = shipped();
        crate::commands::lock(&storage)
            .conclude_task(extra.id.into(), "Fixed elsewhere", &[], None)
            .unwrap();
        let (git, _) = fake(Git::new, vec![]);
        let (github, _) = fake(GhCli::new, vec![]);
        let (herdr, _) = fake(Herdr::new, vec![]);

        let error = complete_task(&storage, &git, &github, &herdr, own(extra.id)).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("merged_with"), "{}", error.message);
    }

    #[test]
    fn complete_with_merged_with_is_rejected_until_the_work_shipped() {
        let (storage, in_review, dependent) = started(true);
        let (extra, not_adopted) = {
            let mut storage = crate::commands::lock(&storage);
            let workspace = in_review.workspace_id;
            let extra = create(&mut storage, workspace, "Fix typo", vec![]).unwrap();
            let other = create(&mut storage, workspace, "Try a cache", vec![]).unwrap();
            let checkout = crate::domain::naming::TaskCheckout {
                path: HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\rnd-cache-4").unwrap()),
                branch: "rnd/cache-4".to_owned(),
            };
            storage
                .start_task(other.id.into(), &checkout, "w29")
                .unwrap();
            storage
                .conclude_task(other.id.into(), "Too slow", &[], None)
                .unwrap();
            let checkout = crate::domain::naming::TaskCheckout {
                path: HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\fix-typo-3").unwrap()),
                branch: "fix/typo-3".to_owned(),
            };
            let extra: Task = (&storage
                .start_task(extra.id.into(), &checkout, "w28")
                .unwrap())
                .into();
            (extra, other)
        };
        let (no_git, _) = fake(Git::new, vec![]);
        let (no_herdr, herdr_runner) = fake(Herdr::new, vec![]);
        let reject = |id: TaskId, target: MergedWithRef, github: Scripted, reason: &str| {
            let (github, _) = fake(GhCli::new, github);
            let error = complete_task(
                &storage,
                &no_git,
                &github,
                &no_herdr,
                merged_with(id, target),
            )
            .unwrap_err();
            assert!(
                error.message.contains(reason),
                "{reason}: {}",
                error.message
            );
        };

        reject(extra.id, MergedWithRef::Task(extra.id.0), vec![], "itself");
        reject(
            extra.id,
            MergedWithRef::Task(in_review.id.0),
            vec![],
            "is in_review",
        );
        reject(
            extra.id,
            MergedWithRef::Task(not_adopted.id.0),
            vec![],
            "not adopted",
        );
        reject(
            extra.id,
            MergedWithRef::Task(dependent.id.0),
            vec![],
            "is planned",
        );
        reject(extra.id, MergedWithRef::Task(999), vec![], "999");
        reject(
            extra.id,
            MergedWithRef::Text("soon".to_owned()),
            vec![],
            "task ID",
        );
        reject(
            extra.id,
            MergedWithRef::Text(PR.to_owned()),
            vec![viewed("OPEN")],
            "not merged yet",
        );
        reject(
            extra.id,
            MergedWithRef::Text(PR.to_owned()),
            vec![viewed("CLOSED")],
            "shipped nothing",
        );
        reject(
            in_review.id,
            MergedWithRef::Text(PR.to_owned()),
            vec![],
            "task's own",
        );
        reject(
            dependent.id,
            MergedWithRef::Task(in_review.id.0),
            vec![],
            "only an in_progress",
        );

        assert!(herdr_runner.invocations.lock().unwrap().is_empty());
        assert_eq!(stored(&storage, extra.id), extra);
        assert_eq!(stored(&storage, in_review.id), in_review);
    }

    #[test]
    fn complete_with_merged_with_is_rejected_while_its_own_branch_has_a_pull_request() {
        let (storage, task, extra) = shipped();
        for (state, reason) in [("OPEN", "is still open"), ("MERGED", "was merged")] {
            let (git, _) = fake(Git::new, github_checkout());
            let (github, _) = fake(GhCli::new, vec![listed(state)]);
            let (herdr, herdr_runner) = fake(Herdr::new, vec![]);

            let error = complete_task(
                &storage,
                &git,
                &github,
                &herdr,
                merged_with(extra.id, MergedWithRef::Task(task.id.0)),
            )
            .unwrap_err();

            assert_eq!(error.kind, CommandErrorKind::Rejected);
            assert!(error.message.contains(reason), "{}", error.message);
            assert!(herdr_runner.invocations.lock().unwrap().is_empty());
            assert_eq!(stored(&storage, extra.id), extra);
        }
    }

    fn conclusion(id: TaskId, note: &str) -> ConcludeTask {
        ConcludeTask {
            id,
            note: note.to_owned(),
        }
    }

    #[test]
    fn conclude_finishes_a_task_without_a_pull_request_as_not_adopted() {
        let (storage, task, dependent) = started(false);
        let (git, _) = fake(Git::new, github_checkout());
        let (github, gh_runner) = fake(GhCli::new, vec![Ok("[]".to_owned())]);
        let (herdr, herdr_runner) = fake(Herdr::new, vec![Ok(CLOSED.to_owned())]);

        let done = conclude_task(
            &storage,
            &git,
            &github,
            &herdr,
            conclusion(task.id, " Duplicate of #7 "),
        )
        .unwrap();

        assert_eq!(done.blocked_dependents[0].id, dependent.id);
        assert!(
            done.message.contains(&format!(
                "call remove_dependency (e.g. {{\"task_id\": {}, \"depends_on\": {}}})",
                dependent.id.0, task.id.0
            )),
            "{}",
            done.message
        );
        let done = done.task;
        assert_eq!(done.status, types::TaskStatus::Done);
        assert_eq!(done.resolution, Some(types::TaskResolution::NotAdopted));
        assert_eq!(done.completion_note.as_deref(), Some("Duplicate of #7"));
        assert_eq!(last_status(&done), Some(types::TaskStatus::Done));
        assert_eq!(stored(&storage, task.id), done);
        assert_eq!(done.pull_request_url, None);
        assert_eq!(gh_runner.invocations.lock().unwrap().len(), 1);
        assert_eq!(herdr_runner.invocations.lock().unwrap().len(), 1);
        assert_eq!(
            stored(&storage, dependent.id).status,
            types::TaskStatus::Planned
        );
    }

    #[test]
    fn conclude_is_rejected_without_a_note_and_while_a_pull_request_is_open() {
        let (storage, task, _) = started(true);
        let (no_git, _) = fake(Git::new, vec![]);
        let (no_github, _) = fake(GhCli::new, vec![]);
        let (herdr, herdr_runner) = fake(Herdr::new, vec![]);

        let error = conclude_task(
            &storage,
            &no_git,
            &no_github,
            &herdr,
            conclusion(task.id, " \n"),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);

        let (git, _) = fake(Git::new, github_checkout());
        let (github, gh_runner) = fake(GhCli::new, vec![listed("OPEN")]);
        let error = conclude_task(
            &storage,
            &git,
            &github,
            &herdr,
            conclusion(task.id, "Not adopted"),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("is still open"), "{}", error.message);
        // Only the state was read; the pull request was not closed.
        assert_eq!(gh_runner.invocations.lock().unwrap().len(), 1);
        assert!(herdr_runner.invocations.lock().unwrap().is_empty());
        assert_eq!(stored(&storage, task.id), task);
    }

    #[test]
    fn conclude_is_rejected_for_a_pull_request_toodo_has_not_recorded_yet() {
        // In progress: the background check has not adopted the pull request yet.
        let (storage, task, _) = started(false);
        assert_eq!(task.pull_request_url, None);
        for (state, reason) in [
            ("OPEN", "is still open"),
            ("MERGED", "completes with the merge"),
        ] {
            let (git, _) = fake(Git::new, github_checkout());
            let (github, gh_runner) = fake(GhCli::new, vec![listed(state)]);
            let (herdr, herdr_runner) = fake(Herdr::new, vec![]);

            let error = conclude_task(
                &storage,
                &git,
                &github,
                &herdr,
                conclusion(task.id, "Not adopted"),
            )
            .unwrap_err();

            assert_eq!(error.kind, CommandErrorKind::Rejected);
            assert!(error.message.contains(reason), "{}", error.message);
            assert_eq!(gh_runner.invocations.lock().unwrap().len(), 1);
            assert!(herdr_runner.invocations.lock().unwrap().is_empty());
            assert_eq!(stored(&storage, task.id), task);
        }
    }
}
