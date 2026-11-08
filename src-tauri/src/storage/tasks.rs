//! Tasks, their dependency edges, and status changes.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};

use super::{Result, Storage, StorageError, invalid_data};
use crate::domain::criteria::NewCriterion;
use crate::domain::dag;
use crate::domain::model::{
    LinkedIssue, NoteKind, Task, TaskId, TaskNote, TaskResolution, TaskType, WorkspaceId,
};
use crate::domain::plan::{DueDate, Estimate, EstimateUnit};
use crate::domain::status::TaskStatus;
use crate::domain::timeline::TaskEvent;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTask {
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub estimate: Option<Estimate>,
    pub due_date: Option<DueDate>,
    /// What has to hold for the task to be done, in order.
    pub criteria: Vec<NewCriterion>,
}

/// Which tasks [`Storage::query_tasks`] lists. Every condition set must hold; the default
/// lists every task.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskQuery {
    /// Only tasks of this workspace.
    pub workspace: Option<WorkspaceId>,
    /// Only tasks with one of these statuses; empty for any status.
    pub statuses: Vec<TaskStatus>,
    /// Only these tasks.
    pub ids: Option<Vec<TaskId>>,
    /// Only tasks with a lower ID, to page back from the oldest task of a previous page.
    pub before: Option<TaskId>,
    /// At most this many tasks: the matching tasks with the highest IDs.
    pub limit: Option<u32>,
}

/// One task of a plan [`Storage::create_tasks`] creates, with its labels and links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPlanTask {
    pub task: NewTask,
    /// Labels [`crate::domain::plan::labels`] checked.
    pub labels: Vec<String>,
    /// References [`crate::domain::plan::merge_refs`] checked.
    pub refs: Vec<String>,
    pub depends_on: Vec<PlanLink>,
    pub related: Vec<PlanLink>,
}

/// A task a task of a plan links to: one that exists, or another task of the plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanLink {
    Existing(TaskId),
    /// The task of the plan at this index.
    New(usize),
}

/// The dependent task after [`Storage::add_dependencies`], and whether the new
/// prerequisites paused it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddedDependencies {
    pub task: Task,
    pub paused: bool,
}

/// Whether adding prerequisites may pause an `in_progress` task that they block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseRule {
    /// Pause the task in the same step.
    Pause,
    /// Add nothing and report [`DependencyChange::NeedsPause`] instead, so the user can
    /// confirm the pause first.
    Ask,
}

/// The outcome of [`Storage::add_dependencies_with`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyChange {
    Added(Box<AddedDependencies>),
    /// The prerequisites would pause the task and [`PauseRule::Ask`] was given; nothing
    /// was written.
    NeedsPause,
}

const TASK_TYPES: [TaskType; 8] = [
    TaskType::Feat,
    TaskType::Fix,
    TaskType::Modify,
    TaskType::Refactor,
    TaskType::Docs,
    TaskType::Test,
    TaskType::Chore,
    TaskType::Rnd,
];

const TASK_STATUSES: [TaskStatus; 4] = [
    TaskStatus::Planned,
    TaskStatus::InProgress,
    TaskStatus::InReview,
    TaskStatus::Done,
];

fn parse_task_type(raw: &str) -> Result<TaskType> {
    TASK_TYPES
        .into_iter()
        .find(|task_type| task_type.as_str() == raw)
        .ok_or_else(|| StorageError::InvalidData(format!("unknown task type {raw:?}")))
}

fn parse_task_resolution(raw: &str) -> Result<TaskResolution> {
    [
        TaskResolution::Merged,
        TaskResolution::Completed,
        TaskResolution::NotAdopted,
    ]
    .into_iter()
    .find(|resolution| resolution.as_str() == raw)
    .ok_or_else(|| StorageError::InvalidData(format!("unknown task resolution {raw:?}")))
}

pub(super) fn parse_task_status(raw: &str) -> Result<TaskStatus> {
    TASK_STATUSES
        .into_iter()
        .find(|status| status.as_str() == raw)
        .ok_or_else(|| StorageError::InvalidData(format!("unknown task status {raw:?}")))
}

fn parse_estimate(unit: Option<String>, amount: Option<f64>) -> Result<Option<Estimate>> {
    let (unit, amount) = match (unit, amount) {
        (None, None) => return Ok(None),
        (Some(unit), Some(amount)) => (unit, amount),
        _ => {
            return Err(StorageError::InvalidData(
                "estimate unit and amount must be set together".to_owned(),
            ));
        }
    };
    let unit = EstimateUnit::ALL
        .into_iter()
        .find(|known| known.as_str() == unit)
        .ok_or_else(|| StorageError::InvalidData(format!("unknown estimate unit {unit:?}")))?;
    Ok(Some(Estimate::new(unit, amount).map_err(invalid_data)?))
}

/// The estimate unit and amount columns of `estimate`.
fn estimate_columns(estimate: Option<Estimate>) -> (Option<&'static str>, Option<f64>) {
    (
        estimate.map(|estimate| estimate.unit().as_str()),
        estimate.map(Estimate::amount),
    )
}

fn parse_note_kind(raw: &str) -> Result<NoteKind> {
    NoteKind::ALL
        .into_iter()
        .find(|kind| kind.as_str() == raw)
        .ok_or_else(|| StorageError::InvalidData(format!("unknown note kind {raw:?}")))
}

const TASK_SELECT: &str = "SELECT t.id, t.workspace_id, t.type, t.title, t.description, t.status, t.completion_note, t.resolution, t.issue_number, t.issue_url, t.estimate_unit, t.estimate_amount, t.due_date, t.refs FROM tasks t JOIN workspaces w ON w.id = t.workspace_id";
struct TaskRow {
    id: i64,
    workspace_id: i64,
    task_type: String,
    title: String,
    description: String,
    status: String,
    completion_note: Option<String>,
    resolution: Option<String>,
    issue_number: Option<i64>,
    issue_url: Option<String>,
    estimate_unit: Option<String>,
    estimate_amount: Option<f64>,
    due_date: Option<String>,
    refs: String,
}
impl TaskRow {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            task_type: row.get(2)?,
            title: row.get(3)?,
            description: row.get(4)?,
            status: row.get(5)?,
            completion_note: row.get(6)?,
            resolution: row.get(7)?,
            issue_number: row.get(8)?,
            issue_url: row.get(9)?,
            estimate_unit: row.get(10)?,
            estimate_amount: row.get(11)?,
            due_date: row.get(12)?,
            refs: row.get(13)?,
        })
    }
    fn into_task(
        self,
        depends_on: BTreeSet<TaskId>,
        timeline: Vec<TaskEvent>,
        notes: Vec<TaskNote>,
        criteria: Vec<crate::domain::criteria::Criterion>,
        labels: Vec<String>,
    ) -> Result<Task> {
        let refs = serde_json::from_str(&self.refs).map_err(|_| {
            StorageError::InvalidData(format!(
                "task {} has refs that are not a JSON array of strings: {}",
                self.id, self.refs
            ))
        })?;
        Ok(Task {
            id: TaskId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            task_type: parse_task_type(&self.task_type)?,
            title: self.title,
            description: self.description,
            status: parse_task_status(&self.status)?,
            resolution: self
                .resolution
                .as_deref()
                .map(parse_task_resolution)
                .transpose()?,
            depends_on,
            completion_note: self.completion_note,
            issue: self.issue_number.map(|number| LinkedIssue {
                number,
                url: self.issue_url.unwrap_or_default(),
            }),
            estimate: parse_estimate(self.estimate_unit, self.estimate_amount)?,
            due_date: self
                .due_date
                .as_deref()
                .map(DueDate::parse)
                .transpose()
                .map_err(invalid_data)?,
            labels,
            refs,
            timeline,
            notes,
            criteria,
        })
    }
}

/// The condition on the `tasks` table aliased `t` that its task is live: neither the task
/// nor its workspace is archived.
pub(super) const LIVE_TASK: &str = "(t.archived_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM workspaces aw WHERE aw.id = t.workspace_id AND aw.archived_at IS NOT NULL))";

/// The condition on `task_dependencies` aliased `d` that its prerequisite is live; an edge
/// to an archived task is kept for a restore but does not hold its dependent back.
const LIVE_PREREQUISITE: &str = "NOT EXISTS (
        SELECT 1 FROM tasks p JOIN workspaces pw ON pw.id = p.workspace_id
        WHERE p.id = d.depends_on_id AND (p.archived_at IS NOT NULL OR pw.archived_at IS NOT NULL))";

/// Which tasks a query reads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// Live tasks with their dependencies on live tasks: what the app and agents work with.
    Live,
    /// Every stored task, archived ones included, with all of its dependencies.
    All,
}

/// Live tasks matching `filter`, a condition on the `tasks` table aliased `t` whose
/// placeholders take `parameters` in order, ordered by ID.
fn query_tasks(conn: &Connection, filter: &str, parameters: &[i64]) -> Result<Vec<Task>> {
    load_tasks(conn, filter, parameters, Scope::Live)
}

/// Tasks of `scope` matching `filter` (see [`query_tasks`]), ordered by ID.
fn load_tasks(
    conn: &Connection,
    filter: &str,
    parameters: &[i64],
    scope: Scope,
) -> Result<Vec<Task>> {
    let (filter, edges) = match scope {
        Scope::Live => (
            format!("({filter}) AND {LIVE_TASK}"),
            format!("AND {LIVE_PREREQUISITE}"),
        ),
        Scope::All => (filter.to_owned(), String::new()),
    };
    let filter = filter.as_str();
    let mut statement =
        conn.prepare_cached(&format!("{TASK_SELECT} WHERE {filter} ORDER BY t.id"))?;
    let rows = statement
        .query_map(params_from_iter(parameters), TaskRow::read)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare_cached(&format!(
        "SELECT d.task_id, d.depends_on_id
         FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
         WHERE {filter} {edges}"
    ))?;
    let mut depends_on: HashMap<i64, BTreeSet<TaskId>> = HashMap::new();
    for edge in statement.query_map(params_from_iter(parameters), |row| {
        Ok((row.get::<_, i64>(0)?, TaskId(row.get(1)?)))
    })? {
        let (task, dependency) = edge?;
        depends_on.entry(task).or_default().insert(dependency);
    }

    let mut statement = conn.prepare_cached(&format!(
        "SELECT e.task_id, e.status, e.at, e.reason
         FROM task_events e JOIN tasks t ON t.id = e.task_id
         WHERE {filter} ORDER BY e.id"
    ))?;
    let mut timelines: HashMap<i64, Vec<TaskEvent>> = HashMap::new();
    for event in statement.query_map(params_from_iter(parameters), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })? {
        let (task, status, at, reason) = event?;
        timelines.entry(task).or_default().push(TaskEvent {
            status: parse_task_status(&status)?,
            at,
            reason,
        });
    }

    let mut statement = conn.prepare_cached(&format!(
        "SELECT n.task_id, n.kind, n.body, n.at
         FROM task_notes n JOIN tasks t ON t.id = n.task_id
         WHERE {filter} ORDER BY n.id"
    ))?;
    let mut notes: HashMap<i64, Vec<TaskNote>> = HashMap::new();
    for note in statement.query_map(params_from_iter(parameters), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })? {
        let (task, kind, body, at) = note?;
        notes.entry(task).or_default().push(TaskNote {
            kind: parse_note_kind(&kind)?,
            body,
            at,
        });
    }

    let mut criteria = super::criteria::load(conn, filter, parameters)?;

    let mut statement = conn.prepare_cached(&format!(
        "SELECT l.task_id, l.label
         FROM task_labels l JOIN tasks t ON t.id = l.task_id
         WHERE {filter} ORDER BY l.label"
    ))?;
    let mut labels: HashMap<i64, Vec<String>> = HashMap::new();
    for label in statement.query_map(params_from_iter(parameters), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })? {
        let (task, label) = label?;
        labels.entry(task).or_default().push(label);
    }

    rows.into_iter()
        .map(|row| {
            let dependencies = depends_on.remove(&row.id).unwrap_or_default();
            let timeline = timelines.remove(&row.id).unwrap_or_default();
            let task_notes = notes.remove(&row.id).unwrap_or_default();
            let task_criteria = criteria.remove(&row.id).unwrap_or_default();
            let task_labels = labels.remove(&row.id).unwrap_or_default();
            row.into_task(
                dependencies,
                timeline,
                task_notes,
                task_criteria,
                task_labels,
            )
        })
        .collect()
}

/// Appends a status change of `task` at `at` to its status history.
pub(super) fn record_event(
    conn: &Connection,
    task: TaskId,
    status: TaskStatus,
    at: i64,
) -> Result<()> {
    record_event_with_reason(conn, task, status, at, None)
}

/// [`record_event`] with `reason`, why the work stopped on a move back to `planned`.
fn record_event_with_reason(
    conn: &Connection,
    task: TaskId,
    status: TaskStatus,
    at: i64,
    reason: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO task_events (task_id, status, at, reason) VALUES (?1, ?2, ?3, ?4)",
        params![task.0, status.as_str(), at, reason],
    )?;
    Ok(())
}

/// Stores `refs` as the references of `task`.
fn write_refs(conn: &Connection, task: TaskId, refs: &[String]) -> Result<()> {
    let json = serde_json::to_string(refs).expect("a list of strings serializes to JSON");
    conn.execute(
        "UPDATE tasks SET refs = ?2 WHERE id = ?1",
        params![task.0, json],
    )?;
    Ok(())
}

/// Appends a note of `kind` to `task` at `at`.
fn add_note(conn: &Connection, task: TaskId, kind: NoteKind, body: &str, at: i64) -> Result<()> {
    let inserted = conn.execute(
        "INSERT INTO task_notes (task_id, kind, body, at)
         SELECT id, ?2, ?3, ?4 FROM tasks WHERE id = ?1",
        params![task.0, kind.as_str(), body, at],
    )?;
    if inserted == 0 {
        return Err(StorageError::TaskNotFound(task));
    }
    Ok(())
}

fn workspace_tasks(conn: &Connection, workspace: WorkspaceId) -> Result<Vec<Task>> {
    query_tasks(conn, "t.workspace_id = ?", &[workspace.0])
}

/// Every task of every workspace: the dependency DAG spans workspaces.
fn all_tasks(conn: &Connection) -> Result<Vec<Task>> {
    query_tasks(conn, "1 = 1", &[])
}

pub(super) fn find_task(conn: &Connection, id: TaskId) -> Result<Option<Task>> {
    Ok(query_tasks(conn, "t.id = ?", &[id.0])?.pop())
}

/// The tasks `query` selects, ordered by ID. With a limit, the matching tasks with the
/// highest IDs are picked first; they are all the matching tasks between the lowest and
/// the highest picked ID, so the details of the tasks load for that range alone.
fn queried_tasks(conn: &Connection, query: &TaskQuery) -> Result<Vec<Task>> {
    let mut conditions = Vec::new();
    let mut parameters = Vec::new();
    if let Some(workspace) = query.workspace {
        conditions.push("t.workspace_id = ?".to_owned());
        parameters.push(workspace.0);
    }
    if !query.statuses.is_empty() {
        // Statuses are fixed names, never user text.
        let names: Vec<String> = query
            .statuses
            .iter()
            .map(|status| format!("'{}'", status.as_str()))
            .collect();
        conditions.push(format!("t.status IN ({})", names.join(", ")));
    }
    if let Some(ids) = &query.ids {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        conditions.push(format!("t.id IN ({})", vec!["?"; ids.len()].join(", ")));
        parameters.extend(ids.iter().map(|id| id.0));
    }
    if let Some(before) = query.before {
        conditions.push("t.id < ?".to_owned());
        parameters.push(before.0);
    }
    if conditions.is_empty() {
        conditions.push("1 = 1".to_owned());
    }
    let mut filter = conditions.join(" AND ");
    if let Some(limit) = query.limit {
        let mut statement = conn.prepare(&format!(
            "SELECT t.id FROM tasks t WHERE {filter} AND {LIVE_TASK}
             ORDER BY t.id DESC LIMIT {limit}"
        ))?;
        let ids = statement
            .query_map(params_from_iter(&parameters), |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let (Some(&highest), Some(&lowest)) = (ids.first(), ids.last()) else {
            return Ok(Vec::new());
        };
        filter.push_str(" AND t.id BETWEEN ? AND ?");
        parameters.extend([lowest, highest]);
    }
    query_tasks(conn, &filter, &parameters)
}

/// The kind of paths on the machine of workspace `w`, told by its repository path: only
/// POSIX paths start with `/`. `windows` for SSH workspaces on Windows hosts and for local
/// ones kept from the desktop app.
/// Rejects live dependencies that loop, e.g. after a restore brought back edges that close
/// a cycle with edges added in the meantime.
pub(super) fn ensure_acyclic(conn: &Connection) -> Result<()> {
    match dag::topological_order(&all_tasks(conn)?) {
        Ok(_) => Ok(()),
        Err(dag::DependencyError::Cycle(path)) => Err(StorageError::RestoreClosesCycle(path)),
        Err(error) => Err(error.into()),
    }
}

/// Rejects starting `task` while one of its dependencies, in any workspace, is not done.
fn ensure_ready(conn: &Connection, task: TaskId) -> Result<()> {
    let blockers = dag::blocking_dependencies(&all_tasks(conn)?, task)?;
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(StorageError::DependenciesNotDone { task, blockers })
    }
}

/// Inserts `new` as a `planned` task without dependencies, recording its creation at `at`
/// as the first event of its history.
fn insert_task(conn: &Connection, new: &NewTask, at: i64) -> Result<TaskId> {
    let status = TaskStatus::Planned;
    let (estimate_unit, estimate_amount) = estimate_columns(new.estimate);
    let inserted = conn.execute(
        "INSERT INTO tasks (workspace_id, type, title, description, status, estimate_unit,
             estimate_amount, due_date)
         SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM workspaces
         WHERE id = ?1 AND archived_at IS NULL",
        params![
            new.workspace_id.0,
            new.task_type.as_str(),
            new.title,
            new.description,
            status.as_str(),
            estimate_unit,
            estimate_amount,
            new.due_date.map(|due| due.to_string())
        ],
    )?;
    if inserted == 0 {
        return Err(StorageError::WorkspaceNotFound(new.workspace_id));
    }
    let id = TaskId(conn.last_insert_rowid());
    record_event(conn, id, status, at)?;
    super::criteria::insert(conn, id, &new.criteria)?;
    Ok(id)
}

impl Storage {
    /// Creates a `planned` task without dependencies and records its creation as the
    /// first event of its history.
    pub fn create_task(&mut self, new: &NewTask) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let id = insert_task(&tx, new, at)?;
        let created = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(created)
    }

    /// Creates every task of `plan` as `planned`, with its labels, dependencies, and
    /// related links, in one transaction: an unknown workspace or task, or a dependency
    /// that would close a cycle, writes nothing. Returns the tasks in the order of `plan`.
    pub fn create_tasks(&mut self, plan: &[NewPlanTask]) -> Result<Vec<Task>> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let mut ids = Vec::with_capacity(plan.len());
        for item in plan {
            let id = insert_task(&tx, &item.task, at)?;
            for label in &item.labels {
                tx.execute(
                    "INSERT OR IGNORE INTO task_labels (task_id, label) VALUES (?1, ?2)",
                    params![id.0, label],
                )?;
            }
            if !item.refs.is_empty() {
                write_refs(&tx, id, &item.refs)?;
            }
            ids.push(id);
        }
        let resolve = |link: &PlanLink| match *link {
            PlanLink::Existing(id) => id,
            PlanLink::New(index) => ids[index],
        };
        for (item, &id) in plan.iter().zip(&ids) {
            for prerequisite in item.depends_on.iter().map(resolve) {
                dag::validate_dependency(&all_tasks(&tx)?, id, prerequisite)?;
                tx.execute(
                    "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?1, ?2)",
                    [id.0, prerequisite.0],
                )?;
            }
            for related in item.related.iter().map(resolve) {
                super::search::link_related(&tx, id, related)?;
            }
        }
        let created = ids
            .iter()
            .map(|&id| find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id)))
            .collect::<Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(created)
    }

    pub fn get_task(&self, id: TaskId) -> Result<Option<Task>> {
        find_task(&self.conn, id)
    }

    /// Tasks of `workspace` ordered by ID, each with its dependencies.
    pub fn list_tasks(&self, workspace: WorkspaceId) -> Result<Vec<Task>> {
        workspace_tasks(&self.conn, workspace)
    }

    /// Tasks of every workspace ordered by ID, each with its dependencies.
    pub fn list_all_tasks(&self) -> Result<Vec<Task>> {
        all_tasks(&self.conn)
    }

    /// The tasks `query` selects, ordered by ID, each with its dependencies; with a
    /// limit, the matching tasks with the highest IDs.
    pub fn query_tasks(&self, query: &TaskQuery) -> Result<Vec<Task>> {
        queried_tasks(&self.conn, query)
    }

    /// Saves the editable task fields; lifecycle and references use their own methods.
    pub fn update_task(&mut self, task: &Task) -> Result<()> {
        let (unit, amount) = estimate_columns(task.estimate);
        if self.conn.execute("UPDATE tasks SET type = ?2, title = ?3, description = ?4, estimate_unit = ?5, estimate_amount = ?6, due_date = ?7 WHERE id = ?1", params![task.id.0, task.task_type.as_str(), task.title, task.description, unit, amount, task.due_date.map(|d| d.to_string())])? == 0 { return Err(StorageError::TaskNotFound(task.id)); }
        Ok(())
    }

    /// Replaces the labels of task `id` with `labels`, which
    /// [`crate::domain::plan::labels`] checked.
    pub fn set_task_labels(&mut self, id: TaskId, labels: &[String]) -> Result<Task> {
        let tx = self.conn.transaction()?;
        find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.execute("DELETE FROM task_labels WHERE task_id = ?1", [id.0])?;
        for label in labels {
            tx.execute(
                "INSERT OR IGNORE INTO task_labels (task_id, label) VALUES (?1, ?2)",
                params![id.0, label],
            )?;
        }
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(task)
    }

    /// Replaces the references of task `id` with `refs`, which
    /// [`crate::domain::plan::merge_refs`] checked.
    pub fn set_task_refs(&mut self, id: TaskId, refs: &[String]) -> Result<Task> {
        let tx = self.conn.transaction()?;
        find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        write_refs(&tx, id, refs)?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(task)
    }

    /// Records `reason` with the latest status change of task `id`, which must be a move to
    /// `status`, e.g. why it was started right after starting it.
    pub fn set_latest_event_reason(
        &mut self,
        id: TaskId,
        status: TaskStatus,
        reason: &str,
    ) -> Result<Task> {
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE task_events SET reason = ?3
             WHERE id = (SELECT max(id) FROM task_events WHERE task_id = ?1) AND status = ?2",
            params![id.0, status.as_str(), reason],
        )?;
        if updated == 0 {
            find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
            return Err(StorageError::InvalidData(format!(
                "the latest status change of task {id} is not a move to {}",
                status.as_str()
            )));
        }
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(task)
    }

    /// Rejects starting a task while one of its dependencies is not done.
    pub fn ensure_ready(&self, id: TaskId) -> Result<()> {
        ensure_ready(&self.conn, id)
    }

    /// Starts a ready task and records its reason and references in one transaction.
    pub fn start_task(
        &mut self,
        id: TaskId,
        reason: Option<&str>,
        refs: &[String],
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        task.status.transition_to(TaskStatus::InProgress)?;
        ensure_ready(&tx, id)?;
        tx.execute(
            "UPDATE tasks SET status = 'in_progress' WHERE id = ?1",
            [id.0],
        )?;
        write_refs(&tx, id, refs)?;
        record_event_with_reason(&tx, id, TaskStatus::InProgress, at, reason)?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(task)
    }

    /// Completes a task without collecting execution records.
    pub fn complete_task(
        &mut self,
        id: TaskId,
        note: Option<&str>,
        refs: &[String],
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        task.status.complete()?;
        tx.execute("UPDATE tasks SET status = 'done', resolution = 'completed', completion_note = COALESCE(?2, completion_note) WHERE id = ?1", params![id.0, note])?;
        write_refs(&tx, id, refs)?;
        record_event_with_reason(&tx, id, TaskStatus::Done, at, note)?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(task)
    }

    /// Records a conclusion, optionally identifying the completed task that shipped it.
    pub fn conclude_task(
        &mut self,
        id: TaskId,
        note: &str,
        shipped_with: Option<TaskId>,
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        let changes_status = task.status != TaskStatus::Done
            || task.resolution != Some(TaskResolution::NotAdopted)
            || shipped_with.is_none();
        if changes_status {
            task.status.conclude()?;
        }
        let resolution = if let Some(other) = shipped_with {
            let target = find_task(&tx, other)?.ok_or(StorageError::TaskNotFound(other))?;
            if other == id
                || (target.status != TaskStatus::Done
                    || target.resolution == Some(TaskResolution::NotAdopted))
            {
                return Err(StorageError::InvalidData(format!(
                    "task {other} has not shipped this work; call complete_task for that task first, then conclude_task with shipped_with {other}"
                )));
            }
            TaskResolution::Completed
        } else {
            TaskResolution::NotAdopted
        };
        tx.execute(
            "UPDATE tasks SET status = 'done', resolution = ?2, completion_note = ?3 WHERE id = ?1",
            params![id.0, resolution.as_str(), note],
        )?;
        if let Some(other) = shipped_with {
            let reference = format!("task:{other}");
            let mut refs = task.refs;
            if !refs.contains(&reference) {
                refs.push(reference);
            }
            write_refs(&tx, id, &refs)?;
        }
        if changes_status {
            record_event_with_reason(&tx, id, TaskStatus::Done, at, Some(note))?;
        }
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(task)
    }

    /// Reopens a `done` task in one transaction (see [`TaskStatus::reopen`]): it becomes
    /// `planned` without a resolution or completion note. The reopening is
    /// recorded in its status history with `reason`, and `note`, which says why and keeps
    /// the earlier outcome, is added as a progress note. References and criteria stay.
    /// Whether its dependents allow it is up to the caller.
    pub fn reopen_task(&mut self, id: TaskId, reason: &str, note: &str) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        let status = task.status.reopen()?;
        tx.execute(
            "UPDATE tasks
             SET status = ?2, resolution = NULL, completion_note = NULL
             WHERE id = ?1",
            params![id.0, status.as_str()],
        )?;
        record_event_with_reason(&tx, id, status, at, Some(reason))?;
        add_note(&tx, id, NoteKind::Progress, note, at)?;
        let reopened = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(reopened)
    }

    /// Corrects how a `done` task ended to `resolution` in one transaction: `completion_note`
    /// becomes its completion note, and `note`, the record of the change, is added as a
    /// progress note. Its status history stays: the task did finish then. Whether the task
    /// and `resolution` allow it is up to the caller.
    pub fn set_task_outcome(
        &mut self,
        id: TaskId,
        resolution: TaskResolution,
        completion_note: &str,
        note: &str,
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        if task.status != TaskStatus::Done {
            return Err(StorageError::InvalidData(format!(
                "task {id} is {}; only a done task has an outcome",
                task.status
            )));
        }
        tx.execute(
            "UPDATE tasks SET resolution = ?2, completion_note = ?3 WHERE id = ?1",
            params![id.0, resolution.as_str(), completion_note],
        )?;
        add_note(&tx, id, NoteKind::Progress, note, at)?;
        let corrected = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(corrected)
    }

    /// Stores what the user wrote about the outcome of a task; `None` clears it. Whether
    /// the task may have a note is up to the caller.
    pub fn set_completion_note(&mut self, id: TaskId, note: Option<&str>) -> Result<Task> {
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE tasks SET completion_note = ?2 WHERE id = ?1",
            params![id.0, note],
        )?;
        if updated == 0 {
            return Err(StorageError::TaskNotFound(id));
        }
        let noted = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(noted)
    }

    /// Appends a note of `kind` to a task, timestamped now. `body` must not be empty;
    /// trimming it is up to the caller.
    pub fn add_task_note(&mut self, id: TaskId, kind: NoteKind, body: &str) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        add_note(&tx, id, kind, body, at)?;
        let noted = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(noted)
    }

    /// Links `issue` to a task; `None` unlinks it. Whether the task may change its issue
    /// is up to the caller.
    pub fn set_task_issue(&mut self, id: TaskId, issue: Option<&LinkedIssue>) -> Result<Task> {
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE tasks SET issue_number = ?2, issue_url = ?3 WHERE id = ?1",
            params![
                id.0,
                issue.map(|issue| issue.number),
                issue.map(|issue| issue.url.as_str())
            ],
        )?;
        if updated == 0 {
            return Err(StorageError::TaskNotFound(id));
        }
        let linked = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(linked)
    }

    /// Moves a task to `status` if its current status allows it, recording the change;
    /// pausing is a move back to `planned`. Starting requires all dependencies to be
    /// done. The pull request checks that guard `in_review` and `done` are up to the
    /// caller; a task moved to `done` here counts as merged.
    pub fn set_task_status(&mut self, id: TaskId, status: TaskStatus) -> Result<Task> {
        self.change_task_status(id, status, None)
    }

    /// Pauses an `in_progress` or `in_review` task with [`Self::set_task_status`],
    /// recording `reason`, why the work stops, with the move back to `planned`.
    pub fn pause_task(&mut self, id: TaskId, reason: Option<&str>) -> Result<Task> {
        self.change_task_status(id, TaskStatus::Planned, reason)
    }

    fn change_task_status(
        &mut self,
        id: TaskId,
        status: TaskStatus,
        reason: Option<&str>,
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        task.status.transition_to(status)?;
        if status == TaskStatus::InProgress {
            ensure_ready(&tx, id)?;
        }
        let resolution = (status == TaskStatus::Done).then_some(TaskResolution::Merged.as_str());
        tx.execute(
            "UPDATE tasks SET status = ?2, resolution = ?3 WHERE id = ?1",
            params![id.0, status.as_str(), resolution],
        )?;
        record_event_with_reason(&tx, id, status, at, reason)?;
        let changed = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(changed)
    }

    /// Archives a live task: it leaves the task lists and the dependency DAG, so the tasks
    /// that depend on it no longer wait on it, but keeps its history, commits, and links for
    /// reviews until [`Self::restore_task`] brings it back or [`Self::purge_task`] deletes it.
    pub fn archive_task(&mut self, id: TaskId) -> Result<()> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.execute(
            "UPDATE tasks SET archived_at = ?2 WHERE id = ?1",
            params![id.0, at],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Brings an archived task of a live workspace back with its dependencies. Rejected
    /// while its workspace is archived, and when its dependencies would close a cycle with
    /// edges added while it was archived.
    pub fn restore_task(&mut self, id: TaskId) -> Result<Task> {
        let tx = self.conn.transaction()?;
        let row: Option<(Option<i64>, i64, Option<i64>)> = tx
            .query_row(
                "SELECT t.archived_at, t.workspace_id, w.archived_at
                 FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?1",
                [id.0],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match row {
            None => return Err(StorageError::TaskNotFound(id)),
            Some((_, workspace, Some(_))) => {
                return Err(StorageError::WorkspaceArchived {
                    workspace: WorkspaceId(workspace),
                    task: id,
                });
            }
            Some((None, _, None)) => return Err(StorageError::TaskNotArchived(id)),
            Some((Some(_), _, None)) => {}
        }
        tx.execute("UPDATE tasks SET archived_at = NULL WHERE id = ?1", [id.0])?;
        ensure_acyclic(&tx)?;
        let restored = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(restored)
    }

    /// Deletes an archived task for good, with its dependency edges, commit records, and
    /// status history; a live task is rejected, so deleting history is always explicit.
    pub fn purge_task(&mut self, id: TaskId) -> Result<()> {
        let tx = self.conn.transaction()?;
        let archived: Option<Option<i64>> = tx
            .query_row(
                "SELECT archived_at FROM tasks WHERE id = ?1",
                [id.0],
                |row| row.get(0),
            )
            .optional()?;
        match archived {
            None => return Err(StorageError::TaskNotFound(id)),
            Some(None) => return Err(StorageError::TaskNotArchived(id)),
            Some(Some(_)) => {}
        }
        tx.execute("DELETE FROM tasks WHERE id = ?1", [id.0])?;
        tx.commit()?;
        Ok(())
    }

    /// Archived tasks of live workspaces ordered by ID; the tasks of an archived workspace
    /// are archived with it.
    pub fn archived_tasks(&self) -> Result<Vec<Task>> {
        load_tasks(
            &self.conn,
            "t.archived_at IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM workspaces aw
                 WHERE aw.id = t.workspace_id AND aw.archived_at IS NOT NULL)",
            &[],
            Scope::All,
        )
    }

    /// Every stored task ordered by ID, archived ones included, for reviews of past work.
    pub fn review_tasks(&self) -> Result<Vec<Task>> {
        load_tasks(&self.conn, "1 = 1", &[], Scope::All)
    }

    /// Deletes a task with its dependency edges, commit records, and status history, live
    /// or archived; used to undo a task that was only just created.
    pub fn delete_task(&mut self, id: TaskId) -> Result<()> {
        let deleted = self
            .conn
            .execute("DELETE FROM tasks WHERE id = ?1", [id.0])?;
        if deleted == 0 {
            return Err(StorageError::TaskNotFound(id));
        }
        Ok(())
    }

    /// Makes `task` depend on `depends_on`, which may belong to another workspace. Rejects
    /// unknown tasks, self dependencies, and edges that would close a cycle anywhere in the
    /// DAG of all workspaces, writing nothing.
    pub fn add_dependency(&mut self, task: TaskId, depends_on: TaskId) -> Result<()> {
        self.add_dependencies(task, &[depends_on]).map(|_| ())
    }

    /// Makes `task` depend on every task of `depends_on` in one transaction, with the
    /// rules of [`Self::add_dependency`]; one rejected edge writes nothing. An
    /// `in_progress` task that is no longer ready afterwards is paused (moved back to
    /// `planned`) until its new prerequisites are done.
    pub fn add_dependencies(
        &mut self,
        task: TaskId,
        depends_on: &[TaskId],
    ) -> Result<AddedDependencies> {
        match self.add_dependencies_with(task, depends_on, PauseRule::Pause)? {
            DependencyChange::Added(added) => Ok(*added),
            DependencyChange::NeedsPause => unreachable!("PauseRule::Pause always adds"),
        }
    }

    /// [`Self::add_dependencies`], where `rule` decides whether a task that the new
    /// prerequisites block may be paused. A `done` task is rejected: its work is finished
    /// and cannot wait anymore. A paused task gets a blocker note naming the prerequisites
    /// it waits on, stamped with the time of the pause.
    pub fn add_dependencies_with(
        &mut self,
        task: TaskId,
        depends_on: &[TaskId],
        rule: PauseRule,
    ) -> Result<DependencyChange> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        for &prerequisite in depends_on {
            dag::validate_dependency(&all_tasks(&tx)?, task, prerequisite)?;
            tx.execute(
                "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?1, ?2)",
                [task.0, prerequisite.0],
            )?;
        }
        let current = find_task(&tx, task)?.ok_or(StorageError::TaskNotFound(task))?;
        if current.status == TaskStatus::Done {
            return Err(StorageError::PrerequisiteOfDoneTask {
                task,
                depends_on: depends_on.to_vec(),
            });
        }
        let tasks = all_tasks(&tx)?;
        let blockers = dag::blocking_dependencies(&tasks, task)?;
        let paused = current.status == TaskStatus::InProgress && !blockers.is_empty();
        if paused {
            if rule == PauseRule::Ask {
                return Ok(DependencyChange::NeedsPause);
            }
            let status = current.status.transition_to(TaskStatus::Planned)?;
            tx.execute(
                "UPDATE tasks SET status = ?2 WHERE id = ?1",
                params![task.0, status.as_str()],
            )?;
            let titles: HashMap<TaskId, &str> = tasks
                .iter()
                .map(|task| (task.id, task.title.as_str()))
                .collect();
            let waiting: Vec<String> = blockers
                .iter()
                .map(|blocker| {
                    let title = titles.get(&blocker.id).copied().unwrap_or_default();
                    format!("#{} {title} ({})", blocker.id, blocker.status)
                })
                .collect();
            let reason = format!("Waiting on {}", waiting.join(", "));
            record_event_with_reason(&tx, task, status, at, Some(&reason))?;
            tx.execute(
                "INSERT INTO task_notes (task_id, kind, body, at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    task.0,
                    NoteKind::Blocker.as_str(),
                    format!("Paused: waiting on {}", waiting.join(", ")),
                    at
                ],
            )?;
        }
        let task = find_task(&tx, task)?.ok_or(StorageError::TaskNotFound(task))?;
        tx.commit()?;
        Ok(DependencyChange::Added(Box::new(AddedDependencies {
            task,
            paused,
        })))
    }

    /// Removes the edge `task -> depends_on`; rejects an edge that does not exist and a
    /// `done` task, whose dependencies stay as they were when it finished.
    pub fn remove_dependency(&mut self, task: TaskId, depends_on: TaskId) -> Result<()> {
        let tx = self.conn.transaction()?;
        let current = find_task(&tx, task)?.ok_or(StorageError::TaskNotFound(task))?;
        if current.status == TaskStatus::Done && current.depends_on.contains(&depends_on) {
            return Err(StorageError::DependencyOfDoneTask { task, depends_on });
        }
        let removed = tx.execute(
            "DELETE FROM task_dependencies WHERE task_id = ?1 AND depends_on_id = ?2",
            [task.0, depends_on.0],
        )?;
        if removed == 0 {
            return Err(StorageError::DependencyNotFound { task, depends_on });
        }
        tx.commit()?;
        Ok(())
    }
}
