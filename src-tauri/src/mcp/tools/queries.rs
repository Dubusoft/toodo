//! Reading tasks: lists, search, details with their links, and the review report.

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use super::requests::{CurrentTask, GetTask, ListTasks, Related, ReviewReportRequest, SearchTasks};
use super::workspaces::task_guidelines;
use crate::commands::types::{
    self, CommitRecord, Task, TaskId, TaskResolution, TaskStatus, TaskType, WorkspaceId,
};
use crate::commands::{CommandError, CommandResult};
use crate::domain::model;
use crate::storage::{self, Storage, StorageError, TaskSearch};

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

/// A task as list_tasks returns it, with whether it can start now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedTask {
    #[serde(flatten)]
    pub task: Task,
    /// Whether the task is planned, does not wait until a time, and every task it depends
    /// on is done and adopted, so start_task (or resume_task for a paused task) can begin
    /// it now.
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

/// Whether `task` can start (or resume) now: it is planned, does not wait until a time,
/// and nothing blocks it. A wait that ends makes it ready again.
fn is_ready(task: &model::Task, blocked_by: &[TaskLink]) -> bool {
    task.status == crate::domain::status::TaskStatus::Planned
        && task.wait.is_none()
        && blocked_by.is_empty()
}

/// `links` as a list such as "#3 (planned), #4 (done as not_adopted)".
pub(super) fn describe_links(links: &[TaskLink]) -> String {
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
pub(super) fn dependency_message(details: &TaskDetails, paused: bool) -> String {
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
            TaskStatus::Planned if task.wait.is_some() => format!(
                "task {id} no longer waits on any task, but waits until a time: it is ready once that wait ends."
            ),
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
    /// Whether the task is planned, does not wait until a time, and every task it depends
    /// on is done and adopted, so start_task (or resume_task for a paused task) can begin
    /// it now.
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
pub(super) struct Links {
    pub(super) tasks: HashMap<model::TaskId, model::Task>,
    workspaces: HashMap<model::WorkspaceId, String>,
    dependents: HashMap<model::TaskId, BTreeSet<model::TaskId>>,
    related: HashMap<model::TaskId, BTreeSet<model::TaskId>>,
}

impl Links {
    pub(super) fn load(storage: &Storage) -> CommandResult<Self> {
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

    pub(super) fn dependents(&self, id: model::TaskId) -> impl Iterator<Item = model::TaskId> + '_ {
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

    pub(super) fn links(&self, ids: impl Iterator<Item = model::TaskId>) -> Vec<TaskLink> {
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
