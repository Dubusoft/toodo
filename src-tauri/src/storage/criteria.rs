//! Completion criteria of tasks and the status change they cause: a task being worked on
//! whose criteria are all met, one of them manual, awaits completion (`in_review`).
//! Completing a task, which closes its herdr workspace, is up to the caller.

use std::collections::HashMap;

use rusqlite::{Connection, params};

use super::tasks::{find_task, record_event};
use super::{Result, Storage, StorageError, invalid_data};
use crate::domain::criteria::{
    self, CheckKind, CheckedBy, Criterion, CriterionId, CriterionState, Decision, NewCriterion,
};
use crate::domain::model::{Task, TaskId};
use crate::domain::status::TaskStatus;

/// A criterion of the list given to [`Storage::set_criteria`]: an existing one by ID, or
/// a new one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CriterionEdit {
    pub id: Option<CriterionId>,
    pub criterion: NewCriterion,
}

/// The result of an automatic check of one criterion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CriterionCheck {
    pub id: CriterionId,
    pub state: CriterionState,
    pub evidence: Option<String>,
    /// A target the check found, e.g. the commit a branch started from; `None` keeps the
    /// stored one.
    pub target: Option<String>,
}

/// The criteria of the tasks matching `filter` (see `query_tasks`), by task ID, in order.
pub(super) fn load(
    conn: &Connection,
    filter: &str,
    parameter: i64,
) -> Result<HashMap<i64, Vec<Criterion>>> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT c.task_id, c.id, c.text, c.kind, c.target, c.state, c.evidence, c.checked_by,
             c.checked_at
         FROM task_criteria c JOIN tasks t ON t.id = c.task_id
         WHERE {filter} ORDER BY c.task_id, c.position, c.id"
    ))?;
    let rows = statement.query_map([parameter], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<i64>>(8)?,
        ))
    })?;
    let mut criteria: HashMap<i64, Vec<Criterion>> = HashMap::new();
    for row in rows {
        let (task, id, text, kind, target, state, evidence, checked_by, checked_at) = row?;
        criteria.entry(task).or_default().push(Criterion {
            id: CriterionId(id),
            text,
            kind: CheckKind::parse(&kind)
                .ok_or_else(|| invalid_data(format!("unknown criterion kind {kind:?}")))?,
            target,
            state: CriterionState::parse(&state)
                .ok_or_else(|| invalid_data(format!("unknown criterion state {state:?}")))?,
            evidence,
            checked_by: checked_by
                .map(|by| {
                    CheckedBy::parse(&by)
                        .ok_or_else(|| invalid_data(format!("unknown criterion checker {by:?}")))
                })
                .transpose()?,
            checked_at,
        });
    }
    Ok(criteria)
}

/// Appends `criteria` to the criteria of `task`, pending.
pub(super) fn insert(conn: &Connection, task: TaskId, criteria: &[NewCriterion]) -> Result<()> {
    let next: i64 = conn.query_row(
        "SELECT coalesce(max(position) + 1, 0) FROM task_criteria WHERE task_id = ?1",
        [task.0],
        |row| row.get(0),
    )?;
    for (position, criterion) in (next..).zip(criteria) {
        conn.execute(
            "INSERT INTO task_criteria (task_id, position, text, kind, target)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                task.0,
                position,
                criterion.text,
                criterion.kind.as_str(),
                criterion.target
            ],
        )?;
    }
    Ok(())
}

/// The task being changed, which must exist and not be done: the criteria of a done task
/// are its record.
fn open_task(conn: &Connection, id: TaskId) -> Result<Task> {
    let task = find_task(conn, id)?.ok_or(StorageError::TaskNotFound(id))?;
    if task.status == TaskStatus::Done {
        return Err(StorageError::CriteriaOfDoneTask(id));
    }
    Ok(task)
}

/// Moves an `in_progress` task whose criteria are all met, one of them manual, to
/// `in_review`, where it awaits completion. Returns the task as it is afterwards.
fn await_completion(conn: &Connection, id: TaskId, at: i64) -> Result<Task> {
    let task = find_task(conn, id)?.ok_or(StorageError::TaskNotFound(id))?;
    if task.status != TaskStatus::InProgress
        || criteria::decide(&task.criteria) != Decision::AwaitConfirmation
    {
        return Ok(task);
    }
    let status = task.status.transition_to(TaskStatus::InReview)?;
    conn.execute(
        "UPDATE tasks SET status = ?2 WHERE id = ?1",
        params![id.0, status.as_str()],
    )?;
    record_event(conn, id, status, at)?;
    find_task(conn, id)?.ok_or(StorageError::TaskNotFound(id))
}

impl Storage {
    /// The task a criterion belongs to; criterion IDs are unique across tasks. `None`
    /// when no task has it.
    pub fn criterion_task(&self, criterion: CriterionId) -> Result<Option<TaskId>> {
        let mut statement = self
            .conn
            .prepare_cached("SELECT task_id FROM task_criteria WHERE id = ?1")?;
        let mut rows = statement.query_map([criterion.0], |row| row.get::<_, i64>(0))?;
        Ok(rows.next().transpose()?.map(TaskId))
    }

    /// Replaces the criteria of a task that is not done with `edits`, in that order.
    /// Existing criteria keep their state unless their kind or target changes; criteria
    /// left out are deleted; new ones start pending. A `branch_merged_locally` criterion
    /// keeps the start commit Toodo found.
    pub fn set_criteria(&mut self, id: TaskId, edits: &[CriterionEdit]) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = open_task(&tx, id)?;
        for edit in edits {
            if let Some(criterion) = edit.id
                && !task.criteria.iter().any(|known| known.id == criterion)
            {
                return Err(StorageError::CriterionNotFound {
                    task: id,
                    criterion,
                });
            }
        }
        for known in &task.criteria {
            if !edits.iter().any(|edit| edit.id == Some(known.id)) {
                tx.execute("DELETE FROM task_criteria WHERE id = ?1", [known.id.0])?;
            }
        }
        for (position, edit) in (0_i64..).zip(edits) {
            let new = &edit.criterion;
            let Some(known) = edit
                .id
                .and_then(|edited| task.criteria.iter().find(|known| known.id == edited))
            else {
                tx.execute(
                    "INSERT INTO task_criteria (task_id, position, text, kind, target)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id.0, position, new.text, new.kind.as_str(), new.target],
                )?;
                continue;
            };
            let target = if new.kind == CheckKind::BranchMergedLocally {
                known.target.as_ref().filter(|_| known.kind == new.kind)
            } else {
                new.target.as_ref()
            };
            if known.kind == new.kind && known.target.as_ref() == target {
                tx.execute(
                    "UPDATE task_criteria SET position = ?2, text = ?3 WHERE id = ?1",
                    params![known.id.0, position, new.text],
                )?;
            } else {
                tx.execute(
                    "UPDATE task_criteria
                     SET position = ?2, text = ?3, kind = ?4, target = ?5, state = 'pending',
                         evidence = NULL, checked_by = NULL, checked_at = NULL
                     WHERE id = ?1",
                    params![known.id.0, position, new.text, new.kind.as_str(), target],
                )?;
            }
        }
        let task = await_completion(&tx, id, at)?;
        tx.commit()?;
        Ok(task)
    }

    /// Checks (`met`) or unchecks a manual criterion of a task that is not done, with what
    /// shows it; unchecking also forgets who checked it and when. A task in progress whose
    /// criteria are then all met awaits completion.
    pub fn check_criterion(
        &mut self,
        id: TaskId,
        criterion: CriterionId,
        met: bool,
        evidence: Option<&str>,
        by: CheckedBy,
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = open_task(&tx, id)?;
        let known = task
            .criteria
            .iter()
            .find(|known| known.id == criterion)
            .ok_or(StorageError::CriterionNotFound {
                task: id,
                criterion,
            })?;
        if known.kind.is_automatic() {
            return Err(StorageError::AutomaticCriterion {
                task: id,
                criterion,
                kind: known.kind,
            });
        }
        let (state, checked_by, checked_at) = if met {
            (CriterionState::Met, Some(by.as_str()), Some(at))
        } else {
            (CriterionState::Pending, None, None)
        };
        tx.execute(
            "UPDATE task_criteria SET state = ?2, evidence = ?3, checked_by = ?4, checked_at = ?5
             WHERE id = ?1",
            params![
                criterion.0,
                state.as_str(),
                evidence,
                checked_by,
                checked_at
            ],
        )?;
        let task = await_completion(&tx, id, at)?;
        tx.commit()?;
        Ok(task)
    }

    /// Stores what automatic checks of a task's criteria found, as checked by Toodo, and
    /// moves a task in progress whose criteria are then all met, one of them manual, to
    /// `in_review`. A met criterion stays met, results for criteria that no longer exist
    /// or are manual are ignored, and so are all results for a task that is done by now. Returns the task and whether anything changed.
    pub fn record_criterion_checks(
        &mut self,
        id: TaskId,
        checks: &[CriterionCheck],
    ) -> Result<(Task, bool)> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        if task.status == TaskStatus::Done {
            return Ok((task, false));
        }
        let mut changed = false;
        for check in checks {
            let Some(known) = task.criteria.iter().find(|known| known.id == check.id) else {
                continue;
            };
            if !known.kind.is_automatic() || known.is_met() {
                continue;
            }
            let target = check.target.as_ref().or(known.target.as_ref());
            if known.state == check.state
                && known.evidence == check.evidence
                && known.target.as_ref() == target
            {
                continue;
            }
            let checked_at = if known.state == check.state {
                known.checked_at
            } else {
                Some(at)
            };
            tx.execute(
                "UPDATE task_criteria
                 SET state = ?2, evidence = ?3, target = ?4, checked_by = ?5, checked_at = ?6
                 WHERE id = ?1",
                params![
                    check.id.0,
                    check.state.as_str(),
                    check.evidence,
                    target,
                    CheckedBy::Toodo.as_str(),
                    checked_at
                ],
            )?;
            changed = true;
        }
        let before = task.status;
        let task = await_completion(&tx, id, at)?;
        tx.commit()?;
        Ok((task.clone(), changed || task.status != before))
    }

    /// Stores what checking met automatic criteria again before completion found: a
    /// result that is not met replaces the met state, checked by Toodo. Results for
    /// criteria that are not met or manual, and for a task that is done, are ignored.
    pub fn record_criterion_rechecks(
        &mut self,
        id: TaskId,
        checks: &[CriterionCheck],
    ) -> Result<Task> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        if task.status == TaskStatus::Done {
            return Ok(task);
        }
        for check in checks {
            let rechecked = task
                .criteria
                .iter()
                .any(|known| known.id == check.id && known.kind.is_automatic() && known.is_met());
            if !rechecked || check.state == CriterionState::Met {
                continue;
            }
            tx.execute(
                "UPDATE task_criteria
                 SET state = ?2, evidence = ?3, checked_by = ?4, checked_at = ?5
                 WHERE id = ?1",
                params![
                    check.id.0,
                    check.state.as_str(),
                    check.evidence,
                    CheckedBy::Toodo.as_str(),
                    at
                ],
            )?;
        }
        let task = find_task(&tx, id)?.ok_or(StorageError::TaskNotFound(id))?;
        tx.commit()?;
        Ok(task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::{TaskType, WorkspaceLocation};
    use crate::domain::naming::TaskCheckout;
    use crate::domain::path::WindowsPath;
    use crate::storage::{NewTask, NewWorkspace};

    fn manual(text: &str) -> NewCriterion {
        NewCriterion::parse(text, CheckKind::Manual, None).unwrap()
    }

    fn storage_with(criteria: Vec<NewCriterion>) -> (Storage, Task) {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 100);
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
            })
            .unwrap();
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Docs,
                title: "Write the guide".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria,
            })
            .unwrap();
        (storage, task)
    }

    fn start(storage: &mut Storage, task: &Task) -> Task {
        let checkout = TaskCheckout {
            path: WindowsPath::parse(r"C:\wt\toodo\docs-write-the-guide-1")
                .unwrap()
                .into(),
            branch: "docs/write-the-guide-1".to_owned(),
        };
        storage.start_task(task.id, &checkout, "w1").unwrap()
    }

    #[test]
    fn criteria_are_created_in_order_and_pending() {
        let (_, task) = storage_with(vec![NewCriterion::merge(false), manual("Reviewed")]);
        let kinds: Vec<_> = task.criteria.iter().map(|c| (c.kind, c.state)).collect();
        assert_eq!(
            kinds,
            vec![
                (CheckKind::BranchMergedLocally, CriterionState::Pending),
                (CheckKind::Manual, CriterionState::Pending)
            ]
        );
    }

    #[test]
    fn checking_the_last_manual_criterion_moves_a_started_task_to_await_completion() {
        let (mut storage, task) = storage_with(vec![manual("Guide written"), manual("Reviewed")]);
        let [first, second] = [task.criteria[0].id, task.criteria[1].id];
        // A planned task records the check but does not move.
        let planned = storage
            .check_criterion(task.id, first, true, Some("docs/guide.md"), CheckedBy::User)
            .unwrap();
        assert_eq!(planned.status, TaskStatus::Planned);
        assert_eq!(planned.criteria[0].state, CriterionState::Met);
        assert_eq!(
            planned.criteria[0].evidence.as_deref(),
            Some("docs/guide.md")
        );
        assert_eq!(planned.criteria[0].checked_by, Some(CheckedBy::User));
        assert_eq!(planned.criteria[0].checked_at, Some(100));

        start(&mut storage, &task);
        let awaiting = storage
            .check_criterion(task.id, second, true, Some("approved"), CheckedBy::Agent)
            .unwrap();
        assert_eq!(awaiting.status, TaskStatus::InReview);
        assert_eq!(
            awaiting.timeline.last().map(|event| event.status),
            Some(TaskStatus::InReview)
        );
        // Unchecking keeps it awaiting completion; confirming needs every criterion met.
        let unchecked = storage
            .check_criterion(task.id, second, false, None, CheckedBy::User)
            .unwrap();
        assert_eq!(unchecked.status, TaskStatus::InReview);
        assert_eq!(unchecked.criteria[1].state, CriterionState::Pending);
        assert_eq!(unchecked.criteria[1].checked_by, None);
        assert_eq!(unchecked.criteria[1].checked_at, None);
    }

    #[test]
    fn automatic_criteria_and_done_tasks_cannot_be_checked_by_hand() {
        let (mut storage, task) = storage_with(vec![NewCriterion::merge(true), manual("Docs")]);
        let merge = task.criteria[0].id;
        assert!(matches!(
            storage.check_criterion(task.id, merge, true, None, CheckedBy::User),
            Err(StorageError::AutomaticCriterion { .. })
        ));
        assert!(matches!(
            storage.check_criterion(task.id, CriterionId(99), true, None, CheckedBy::User),
            Err(StorageError::CriterionNotFound { .. })
        ));
        start(&mut storage, &task);
        storage.complete_task(task.id, None, None, &[]).unwrap();
        assert!(matches!(
            storage.check_criterion(task.id, task.criteria[1].id, true, None, CheckedBy::User),
            Err(StorageError::CriteriaOfDoneTask(_))
        ));
        assert!(matches!(
            storage.set_criteria(task.id, &[]),
            Err(StorageError::CriteriaOfDoneTask(_))
        ));
    }

    #[test]
    fn automatic_checks_stay_met_and_keep_the_start_commit() {
        let (mut storage, task) = storage_with(vec![NewCriterion::merge(false)]);
        let id = task.criteria[0].id;
        start(&mut storage, &task);
        let check = |state, evidence: Option<&str>, target: Option<&str>| CriterionCheck {
            id,
            state,
            evidence: evidence.map(str::to_owned),
            target: target.map(str::to_owned),
        };
        let (pending, changed) = storage
            .record_criterion_checks(
                task.id,
                &[check(CriterionState::Pending, None, Some("abc"))],
            )
            .unwrap();
        assert!(changed);
        assert_eq!(pending.criteria[0].target.as_deref(), Some("abc"));
        let (_, changed) = storage
            .record_criterion_checks(task.id, &[check(CriterionState::Pending, None, None)])
            .unwrap();
        assert!(!changed, "the same result changes nothing");
        let (met, changed) = storage
            .record_criterion_checks(task.id, &[check(CriterionState::Met, Some("merged"), None)])
            .unwrap();
        assert!(changed);
        assert_eq!(met.criteria[0].state, CriterionState::Met);
        assert_eq!(met.criteria[0].target.as_deref(), Some("abc"));
        assert_eq!(met.criteria[0].checked_by, Some(CheckedBy::Toodo));
        // Only automatic criteria: Toodo completes the task itself, it does not await one.
        assert_eq!(met.status, TaskStatus::InProgress);
        let (still, changed) = storage
            .record_criterion_checks(task.id, &[check(CriterionState::Failed, Some("x"), None)])
            .unwrap();
        assert!(!changed);
        assert_eq!(still.criteria[0].state, CriterionState::Met);
    }

    #[test]
    fn setting_criteria_keeps_unchanged_ones_and_resets_changed_ones() {
        let url = |target: &str| NewCriterion::parse("Live", CheckKind::Url, Some(target)).unwrap();
        let (mut storage, task) = storage_with(vec![manual("Written"), url("https://a.test")]);
        let [written, live] = [task.criteria[0].id, task.criteria[1].id];
        storage
            .check_criterion(task.id, written, true, Some("done"), CheckedBy::User)
            .unwrap();
        storage
            .record_criterion_checks(
                task.id,
                &[CriterionCheck {
                    id: live,
                    state: CriterionState::Met,
                    evidence: None,
                    target: None,
                }],
            )
            .unwrap();
        let edited = storage
            .set_criteria(
                task.id,
                &[
                    CriterionEdit {
                        id: None,
                        criterion: manual("Announced"),
                    },
                    CriterionEdit {
                        id: Some(live),
                        criterion: url("https://b.test"),
                    },
                    CriterionEdit {
                        id: Some(written),
                        criterion: manual("Written well"),
                    },
                ],
            )
            .unwrap();
        let summary: Vec<_> = edited
            .criteria
            .iter()
            .map(|c| (c.text.as_str(), c.state, c.target.as_deref()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("Announced", CriterionState::Pending, None),
                ("Live", CriterionState::Pending, Some("https://b.test")),
                ("Written well", CriterionState::Met, None),
            ]
        );
        let removed = storage
            .set_criteria(
                task.id,
                &[CriterionEdit {
                    id: Some(written),
                    criterion: manual("Written well"),
                }],
            )
            .unwrap();
        assert_eq!(removed.criteria.len(), 1);
        assert!(matches!(
            storage.set_criteria(
                task.id,
                &[CriterionEdit {
                    id: Some(CriterionId(99)),
                    criterion: manual("x"),
                }],
            ),
            Err(StorageError::CriterionNotFound { .. })
        ));
    }

    #[test]
    fn a_criterion_is_found_with_its_task() {
        let (storage, task) = storage_with(vec![manual("Written")]);
        assert_eq!(
            storage.criterion_task(task.criteria[0].id).unwrap(),
            Some(task.id)
        );
        assert_eq!(storage.criterion_task(CriterionId(99)).unwrap(), None);
    }

    #[test]
    fn criteria_go_with_their_task() {
        let (mut storage, task) = storage_with(vec![manual("Written")]);
        storage.delete_task(task.id).unwrap();
        let left: i64 = storage
            .conn
            .query_row("SELECT count(*) FROM task_criteria", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
