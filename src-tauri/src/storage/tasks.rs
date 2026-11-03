//! Tasks, their dependency edges, and status changes.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{Result, Storage, StorageError, invalid_data};
use crate::domain::criteria::NewCriterion;
use crate::domain::dag;
use crate::domain::model::{
    CommitRecord, HostPath, LinkedIssue, MergedWith, NoteKind, PullRequestSnapshot, Task, TaskId,
    TaskNote, TaskResolution, TaskType, WorkspaceId,
};
use crate::domain::naming::TaskCheckout;
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

const TASK_SELECT: &str = "SELECT t.id, t.workspace_id, t.type, t.title, t.description, t.status,
        t.branch, t.worktree_path, t.herdr_workspace_id, t.pull_request_url,
        t.pull_request_merged_at, t.completion_note, s.number, s.title, s.additions,
        s.deletions, s.changed_files, s.merge_commit_sha, s.review_count, s.reviewer_count,
        s.first_reviewed_at, t.resolution, t.issue_number, t.issue_url, t.estimate_unit,
        t.estimate_amount, t.due_date, t.merged_with_pull_request_url, t.merged_with_task_id
    FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
        LEFT JOIN pull_request_snapshots s ON s.task_id = t.id";

struct TaskRow {
    id: i64,
    workspace_id: i64,
    task_type: String,
    title: String,
    description: String,
    status: String,
    branch: Option<String>,
    worktree_path: Option<String>,
    herdr_workspace_id: Option<String>,
    pull_request_url: Option<String>,
    pull_request_merged_at: Option<i64>,
    completion_note: Option<String>,
    pull_request: Option<PullRequestSnapshot>,
    resolution: Option<String>,
    issue: Option<LinkedIssue>,
    estimate_unit: Option<String>,
    estimate_amount: Option<f64>,
    due_date: Option<String>,
    merged_with: Option<MergedWith>,
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
            branch: row.get(6)?,
            worktree_path: row.get(7)?,
            herdr_workspace_id: row.get(8)?,
            pull_request_url: row.get(9)?,
            pull_request_merged_at: row.get(10)?,
            completion_note: row.get(11)?,
            pull_request: match row.get::<_, Option<i64>>(12)? {
                None => None,
                Some(number) => Some(PullRequestSnapshot {
                    number,
                    title: row.get(13)?,
                    additions: row.get(14)?,
                    deletions: row.get(15)?,
                    changed_files: row.get(16)?,
                    merge_commit_sha: row.get(17)?,
                    review_count: row.get(18)?,
                    reviewer_count: row.get(19)?,
                    first_reviewed_at: row.get(20)?,
                }),
            },
            resolution: row.get(21)?,
            issue: match row.get::<_, Option<i64>>(22)? {
                None => None,
                Some(number) => Some(LinkedIssue {
                    number,
                    url: row.get(23)?,
                }),
            },
            estimate_unit: row.get(24)?,
            estimate_amount: row.get(25)?,
            due_date: row.get(26)?,
            merged_with: match (
                row.get::<_, Option<String>>(27)?,
                row.get::<_, Option<i64>>(28)?,
            ) {
                (None, None) => None,
                (pull_request_url, task_id) => Some(MergedWith {
                    task_id: task_id.map(TaskId),
                    pull_request_url,
                }),
            },
        })
    }

    fn into_task(
        self,
        depends_on: BTreeSet<TaskId>,
        timeline: Vec<TaskEvent>,
        notes: Vec<TaskNote>,
        criteria: Vec<crate::domain::criteria::Criterion>,
    ) -> Result<Task> {
        let worktree_path = self
            .worktree_path
            .map(|raw| HostPath::parse_stored(&raw))
            .transpose()
            .map_err(invalid_data)?;
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
            branch: self.branch,
            worktree_path,
            herdr_workspace_id: self.herdr_workspace_id,
            pull_request_url: self.pull_request_url,
            pull_request_merged_at: self.pull_request_merged_at,
            pull_request: self.pull_request,
            merged_with: self.merged_with,
            completion_note: self.completion_note,
            issue: self.issue,
            estimate: parse_estimate(self.estimate_unit, self.estimate_amount)?,
            due_date: self
                .due_date
                .as_deref()
                .map(DueDate::parse)
                .transpose()
                .map_err(invalid_data)?,
            timeline,
            notes,
            criteria,
        })
    }
}

/// Tasks matching `filter`, a condition on the `tasks` table aliased `t` that takes the
/// single parameter `?1`.
fn query_tasks(conn: &Connection, filter: &str, parameter: i64) -> Result<Vec<Task>> {
    let mut statement =
        conn.prepare_cached(&format!("{TASK_SELECT} WHERE {filter} ORDER BY t.id"))?;
    let rows = statement
        .query_map([parameter], TaskRow::read)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare_cached(&format!(
        "SELECT d.task_id, d.depends_on_id
         FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
         WHERE {filter}"
    ))?;
    let mut depends_on: HashMap<i64, BTreeSet<TaskId>> = HashMap::new();
    for edge in statement.query_map([parameter], |row| {
        Ok((row.get::<_, i64>(0)?, TaskId(row.get(1)?)))
    })? {
        let (task, dependency) = edge?;
        depends_on.entry(task).or_default().insert(dependency);
    }

    let mut statement = conn.prepare_cached(&format!(
        "SELECT e.task_id, e.status, e.at
         FROM task_events e JOIN tasks t ON t.id = e.task_id
         WHERE {filter} ORDER BY e.id"
    ))?;
    let mut timelines: HashMap<i64, Vec<TaskEvent>> = HashMap::new();
    for event in statement.query_map([parameter], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })? {
        let (task, status, at) = event?;
        timelines.entry(task).or_default().push(TaskEvent {
            status: parse_task_status(&status)?,
            at,
        });
    }

    let mut statement = conn.prepare_cached(&format!(
        "SELECT n.task_id, n.kind, n.body, n.at
         FROM task_notes n JOIN tasks t ON t.id = n.task_id
         WHERE {filter} ORDER BY n.id"
    ))?;
    let mut notes: HashMap<i64, Vec<TaskNote>> = HashMap::new();
    for note in statement.query_map([parameter], |row| {
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

    let mut criteria = super::criteria::load(conn, filter, parameter)?;

    rows.into_iter()
        .map(|row| {
            let dependencies = depends_on.remove(&row.id).unwrap_or_default();
            let timeline = timelines.remove(&row.id).unwrap_or_default();
            let task_notes = notes.remove(&row.id).unwrap_or_default();
            let task_criteria = criteria.remove(&row.id).unwrap_or_default();
            row.into_task(dependencies, timeline, task_notes, task_criteria)
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
    conn.execute(
        "INSERT INTO task_events (task_id, status, at) VALUES (?1, ?2, ?3)",
        params![task.0, status.as_str(), at],
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
    query_tasks(conn, "t.workspace_id = ?1", workspace.0)
}

/// Every task of every workspace: the dependency DAG spans workspaces.
fn all_tasks(conn: &Connection) -> Result<Vec<Task>> {
    query_tasks(conn, "?1 = 1", 1)
}

pub(super) fn find_task(conn: &Connection, id: TaskId) -> Result<Option<Task>> {
    Ok(query_tasks(conn, "t.id = ?1", id.0)?.pop())
}

fn task_workspace(conn: &Connection, id: TaskId) -> Result<Option<WorkspaceId>> {
    Ok(conn
        .query_row(
            "SELECT workspace_id FROM tasks WHERE id = ?1",
            [id.0],
            |row| row.get(0).map(WorkspaceId),
        )
        .optional()?)
}

/// The kind of paths on the machine of workspace `w`, told by its repository path: only
/// POSIX paths start with `/`. `windows` for SSH workspaces on Windows hosts and for local
/// ones kept from the desktop app.
const WORKSPACE_PATH_STYLE: &str =
    "CASE WHEN substr(w.path, 1, 1) = '/' THEN 'posix' ELSE 'windows' END";

/// The stored form of a worktree path, which must be of the path kind of the machine of
/// the task's workspace (see [`WORKSPACE_PATH_STYLE`]).
fn stored_worktree_path<'a>(
    task: TaskId,
    path_style: &str,
    path: Option<&'a HostPath>,
) -> Result<Option<&'a str>> {
    match (path, path_style) {
        (None, _) => Ok(None),
        (Some(HostPath::Windows(path)), "windows") => Ok(Some(path.as_str())),
        (Some(HostPath::Posix(path)), "posix") => Ok(Some(path.as_str())),
        (Some(_), _) => Err(StorageError::WorktreePathMismatch(task)),
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

impl Storage {
    /// Creates a `planned` task without dependencies and records its creation as the
    /// first event of its history.
    pub fn create_task(&mut self, new: &NewTask) -> Result<Task> {
        let status = TaskStatus::Planned;
        let at = self.now();
        let tx = self.conn.transaction()?;
        let (estimate_unit, estimate_amount) = estimate_columns(new.estimate);
        let inserted = tx.execute(
            "INSERT INTO tasks (workspace_id, type, title, description, status, estimate_unit,
                 estimate_amount, due_date)
             SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM workspaces WHERE id = ?1",
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
        let id = TaskId(tx.last_insert_rowid());
        record_event(&tx, id, status, at)?;
        super::criteria::insert(&tx, id, &new.criteria)?;
        let created = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
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

    /// Saves the editable fields of `task`: type, title, description, estimate, due date,
    /// branch, worktree path, herdr workspace, and pull request URL. Status, dependencies, and workspace
    /// are changed through their own methods and are ignored here.
    pub fn update_task(&mut self, task: &Task) -> Result<()> {
        let tx = self.conn.transaction()?;
        let path_style: String = tx
            .query_row(
                &format!(
                    "SELECT {WORKSPACE_PATH_STYLE} FROM tasks t
                     JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?1"
                ),
                [task.id.0],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StorageError::TaskNotFound(task.id))?;
        let worktree_path =
            stored_worktree_path(task.id, &path_style, task.worktree_path.as_ref())?;
        let (estimate_unit, estimate_amount) = estimate_columns(task.estimate);
        tx.execute(
            "UPDATE tasks
             SET type = ?2, title = ?3, description = ?4, branch = ?5, worktree_path = ?6,
                 herdr_workspace_id = ?7, pull_request_url = ?8, estimate_unit = ?9,
                 estimate_amount = ?10, due_date = ?11
             WHERE id = ?1",
            params![
                task.id.0,
                task.task_type.as_str(),
                task.title,
                task.description,
                task.branch,
                worktree_path,
                task.herdr_workspace_id,
                task.pull_request_url,
                estimate_unit,
                estimate_amount,
                task.due_date.map(|due| due.to_string())
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Rejects starting a task while one of its dependencies is not done; check this
    /// before preparing its worktree.
    pub fn ensure_ready(&self, id: TaskId) -> Result<()> {
        ensure_ready(&self.conn, id)
    }

    /// Records the worktree of a `planned` task whose dependencies are done and moves it
    /// to `in_progress` in one transaction, so a task is never in progress without its
    /// worktree.
    pub fn start_task(
        &mut self,
        id: TaskId,
        checkout: &TaskCheckout,
        herdr_workspace_id: &str,
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        let status = task.status.transition_to(TaskStatus::InProgress)?;
        ensure_ready(&tx, id)?;
        let path_style: String = tx.query_row(
            &format!("SELECT {WORKSPACE_PATH_STYLE} FROM workspaces w WHERE w.id = ?1"),
            [task.workspace_id.0],
            |row| row.get(0),
        )?;
        let worktree_path = stored_worktree_path(id, &path_style, Some(&checkout.path))?;
        tx.execute(
            "UPDATE tasks
             SET status = ?2, branch = ?3, worktree_path = ?4, herdr_workspace_id = ?5
             WHERE id = ?1",
            params![
                id.0,
                status.as_str(),
                checkout.branch,
                worktree_path,
                herdr_workspace_id
            ],
        )?;
        record_event(&tx, id, status, at)?;
        let started = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(started)
    }

    /// Moves an `in_progress` or `in_review` task whose criteria are met to `done` as
    /// merged, or completed when nothing merged (see [`TaskStatus::complete`]), stores
    /// the merge time and PR snapshot, and forgets its closed herdr workspace in one
    /// transaction. Non-empty `commits` (those of the merged pull request) replace its
    /// commit records. The worktree path stays: the checkout is kept on disk until its
    /// worktree is removed. Dependents whose other dependencies are done can then start.
    pub fn complete_task(
        &mut self,
        id: TaskId,
        merged_at: Option<i64>,
        pull_request: Option<&PullRequestSnapshot>,
        commits: &[CommitRecord],
    ) -> Result<Task> {
        self.finish_task(id, merged_at, pull_request, commits, None)
    }

    /// Completes shipped work without a pull request, keeping its explanation and commits.
    /// The command layer first verifies PR absence and all completion criteria.
    pub fn complete_task_without_pull_request(
        &mut self,
        id: TaskId,
        note: &str,
        commits: &[CommitRecord],
    ) -> Result<Task> {
        self.finish_task(id, None, None, commits, Some(note))
    }

    fn finish_task(
        &mut self,
        id: TaskId,
        merged_at: Option<i64>,
        pull_request: Option<&PullRequestSnapshot>,
        commits: &[CommitRecord],
        note: Option<&str>,
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        let status = task.status.complete()?;
        let merged = task.pull_request_url.is_some()
            || task.merged_with.is_some()
            || merged_at.is_some()
            || pull_request.is_some()
            || task.criteria.iter().any(|criterion| {
                criterion.kind == crate::domain::criteria::CheckKind::BranchMergedLocally
                    && criterion.is_met()
            });
        let resolution = if note.is_none() && merged {
            TaskResolution::Merged
        } else {
            TaskResolution::Completed
        };
        if let Some(note) = note {
            tx.execute(
                "UPDATE task_criteria
                 SET state = 'met', evidence = ?2, checked_by = 'toodo', checked_at = ?3
                 WHERE task_id = ?1 AND kind = 'pr_merged'",
                params![id.0, note, at],
            )?;
        }
        tx.execute(
            "UPDATE tasks
             SET status = ?2, resolution = ?3, herdr_workspace_id = NULL,
                 pull_request_merged_at = coalesce(?4, pull_request_merged_at),
                 completion_note = coalesce(?5, completion_note)
             WHERE id = ?1",
            params![id.0, status.as_str(), resolution.as_str(), merged_at, note],
        )?;
        if let Some(snapshot) = pull_request {
            tx.execute(
                "INSERT OR REPLACE INTO pull_request_snapshots (task_id, number, title,
                     additions, deletions, changed_files, merge_commit_sha, review_count,
                     reviewer_count, first_reviewed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id.0,
                    snapshot.number,
                    snapshot.title,
                    snapshot.additions,
                    snapshot.deletions,
                    snapshot.changed_files,
                    snapshot.merge_commit_sha,
                    snapshot.review_count,
                    snapshot.reviewer_count,
                    snapshot.first_reviewed_at
                ],
            )?;
        }
        if !commits.is_empty() {
            super::commits::write_commit_records(&tx, id, commits)?;
        }
        record_event(&tx, id, status, at)?;
        let done = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(done)
    }

    /// Moves an `in_progress` or `in_review` task to `done` without merging, as
    /// `not_adopted`, in one transaction: stores `note`, the conclusion, as its completion
    /// note and forgets its herdr workspace, which was closed. Non-empty `commits` replace
    /// its commit records, and `pull_request_url`, a pull request closed with the
    /// conclusion, replaces its pull request URL. The branch and worktree path stay, and
    /// its dependents keep waiting: work that was not adopted is not there to build on.
    pub fn conclude_task(
        &mut self,
        id: TaskId,
        note: &str,
        commits: &[CommitRecord],
        pull_request_url: Option<&str>,
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        let status = task.status.conclude()?;
        tx.execute(
            "UPDATE tasks
             SET status = ?2, resolution = ?3, completion_note = ?4, herdr_workspace_id = NULL,
                 pull_request_url = COALESCE(?5, pull_request_url)
             WHERE id = ?1",
            params![
                id.0,
                status.as_str(),
                TaskResolution::NotAdopted.as_str(),
                note,
                pull_request_url
            ],
        )?;
        if !commits.is_empty() {
            super::commits::write_commit_records(&tx, id, commits)?;
        }
        record_event(&tx, id, status, at)?;
        let concluded = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(concluded)
    }

    /// Moves an `in_progress` or `in_review` task to `done` as `resolution` (merged, or
    /// completed for work shipped by a task completed without a pull request) through
    /// another task or its pull request, `merged_with`, merged at `merged_at`, and forgets
    /// its herdr workspace, which was closed. A task `done` as `not_adopted` keeps its
    /// status history and only changes its resolution: the work did ship. Non-empty
    /// `commits` replace its commit records. Its dependents can then start.
    pub fn complete_task_merged_with(
        &mut self,
        id: TaskId,
        merged_with: &MergedWith,
        resolution: TaskResolution,
        merged_at: Option<i64>,
        commits: &[CommitRecord],
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        let changes_status = match (task.status, task.resolution) {
            (TaskStatus::Done, Some(TaskResolution::NotAdopted)) => false,
            (status, _) => {
                status.conclude()?;
                true
            }
        };
        tx.execute(
            "UPDATE tasks
             SET status = ?2, resolution = ?3, herdr_workspace_id = NULL,
                 pull_request_merged_at = ?4, merged_with_pull_request_url = ?5,
                 merged_with_task_id = ?6
             WHERE id = ?1",
            params![
                id.0,
                TaskStatus::Done.as_str(),
                resolution.as_str(),
                merged_at,
                merged_with.pull_request_url,
                merged_with.task_id.map(|task| task.0)
            ],
        )?;
        if !commits.is_empty() {
            super::commits::write_commit_records(&tx, id, commits)?;
        }
        if changes_status {
            record_event(&tx, id, TaskStatus::Done, at)?;
        }
        let done = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(done)
    }

    /// Reopens a `done` task in one transaction (see [`TaskStatus::reopen`]): it becomes
    /// `planned` without a resolution, completion note, or `merged_with`, the reopening is
    /// recorded in its status history, and `note`, which says why and keeps the earlier
    /// outcome, is added as a progress note. Branch, worktree path, commit records, pull
    /// request, and criteria stay. Whether its dependents allow it is up to the caller.
    pub fn reopen_task(&mut self, id: TaskId, note: &str) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        let status = task.status.reopen()?;
        tx.execute(
            "UPDATE tasks
             SET status = ?2, resolution = NULL, completion_note = NULL,
                 merged_with_pull_request_url = NULL, merged_with_task_id = NULL
             WHERE id = ?1",
            params![id.0, status.as_str()],
        )?;
        record_event(&tx, id, status, at)?;
        add_note(&tx, id, NoteKind::Progress, note, at)?;
        let reopened = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(reopened)
    }

    /// Corrects how a `done` task ended to `resolution` in one transaction: `completion_note`
    /// becomes its completion note, and `note`, the record of the change, is added as a
    /// progress note. Its status history stays: the task did finish then. Any other
    /// resolution than merged or completed forgets `merged_with`. Whether the task and
    /// `resolution` allow it is up to the caller.
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
        let keeps_merged_with = matches!(
            resolution,
            TaskResolution::Merged | TaskResolution::Completed
        );
        tx.execute(
            "UPDATE tasks
             SET resolution = ?2, completion_note = ?3,
                 merged_with_pull_request_url = CASE WHEN ?4 AND ?2 = 'merged'
                     THEN merged_with_pull_request_url END,
                 merged_with_task_id = CASE WHEN ?4 THEN merged_with_task_id END
             WHERE id = ?1",
            params![
                id.0,
                resolution.as_str(),
                completion_note,
                keeps_merged_with
            ],
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

    /// Forgets the worktree and herdr workspace of a task after its worktree was removed.
    /// The branch, status, commit records, and pull request stay.
    pub fn clear_task_worktree(&mut self, id: TaskId) -> Result<Task> {
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE tasks SET worktree_path = NULL, herdr_workspace_id = NULL WHERE id = ?1",
            [id.0],
        )?;
        if updated == 0 {
            return Err(StorageError::TaskNotFound(id));
        }
        let cleared = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(cleared)
    }

    /// Records the worktree a task got back after its previous one was removed, and the
    /// herdr workspace it is open in. Status, branch, and history are unchanged.
    pub fn restore_task_worktree(
        &mut self,
        id: TaskId,
        path: &HostPath,
        herdr_workspace_id: &str,
    ) -> Result<Task> {
        let tx = self.conn.transaction()?;
        let path_style: String = tx
            .query_row(
                &format!(
                    "SELECT {WORKSPACE_PATH_STYLE} FROM tasks t
                     JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?1"
                ),
                [id.0],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StorageError::TaskNotFound(id))?;
        let worktree_path = stored_worktree_path(id, &path_style, Some(path))?;
        tx.execute(
            "UPDATE tasks SET worktree_path = ?2, herdr_workspace_id = ?3 WHERE id = ?1",
            params![id.0, worktree_path, herdr_workspace_id],
        )?;
        let restored = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(restored)
    }

    /// Records the herdr workspace a task's worktree was opened again in.
    pub fn set_task_herdr_workspace(&mut self, id: TaskId, herdr_workspace_id: &str) -> Result<()> {
        let updated = self.conn.execute(
            "UPDATE tasks SET herdr_workspace_id = ?2 WHERE id = ?1",
            params![id.0, herdr_workspace_id],
        )?;
        if updated == 0 {
            return Err(StorageError::TaskNotFound(id));
        }
        Ok(())
    }

    /// Records the pull request of an `in_progress` or `in_review` task in one
    /// transaction: replaces its commit records, stores the pull request URL and its
    /// merge time (`None` until merged), and moves it to (or keeps it in) `in_review`.
    /// Dependents stay waiting until it is `done`.
    pub fn open_pull_request(
        &mut self,
        id: TaskId,
        records: &[CommitRecord],
        pull_request_url: &str,
        merged_at: Option<i64>,
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        let moved = task.status != TaskStatus::InReview;
        if moved {
            task.status.transition_to(TaskStatus::InReview)?;
        }
        super::commits::write_commit_records(&tx, id, records)?;
        tx.execute(
            "UPDATE tasks SET status = ?2, pull_request_url = ?3, pull_request_merged_at = ?4
             WHERE id = ?1",
            params![
                id.0,
                TaskStatus::InReview.as_str(),
                pull_request_url,
                merged_at
            ],
        )?;
        if moved {
            record_event(&tx, id, TaskStatus::InReview, at)?;
        }
        let in_review = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(in_review)
    }

    /// Moves a task to `status` if its current status allows it, recording the change;
    /// pausing is a move back to `planned`. Starting requires all dependencies to be
    /// done. The pull request checks that guard `in_review` and `done` are up to the
    /// caller; a task moved to `done` here counts as merged.
    pub fn set_task_status(&mut self, id: TaskId, status: TaskStatus) -> Result<Task> {
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
        record_event(&tx, id, status, at)?;
        let changed = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(changed)
    }

    /// Deletes a task with its dependency edges, commit records, and status history.
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
    /// `planned`, keeping its branch and worktree) until its new prerequisites are done.
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
            record_event(&tx, task, status, at)?;
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

    /// Forgets the herdr workspace of a task after it was closed; the worktree stays.
    pub fn clear_task_herdr_workspace(&mut self, id: TaskId) -> Result<Task> {
        let updated = self.conn.execute(
            "UPDATE tasks SET herdr_workspace_id = NULL WHERE id = ?1",
            [id.0],
        )?;
        if updated == 0 {
            return Err(StorageError::TaskNotFound(id));
        }
        find_task(&self.conn, id)?.ok_or(StorageError::TaskNotFound(id))
    }

    /// Removes the edge `task -> depends_on`; rejects an edge that does not exist.
    pub fn remove_dependency(&mut self, task: TaskId, depends_on: TaskId) -> Result<()> {
        let tx = self.conn.transaction()?;
        task_workspace(&tx, task)?.ok_or(StorageError::TaskNotFound(task))?;
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
