//! Data steps: changes a migration makes that SQL alone cannot.

use rusqlite::{Transaction, params};

use super::Result;
use crate::domain::criteria::{CheckKind, CheckedBy, CriterionState, done_when_items};

/// Data steps that run right after the SQL of the migration to the given version, for
/// changes SQL alone cannot make.
type DataStep = fn(&Transaction<'_>) -> Result<()>;

pub(super) const DATA_STEPS: &[(i64, DataStep)] = &[(16, import_criteria)];

/// Data steps that run right before the SQL of the migration to the given version, for
/// data that migration drops.
pub(super) const DATA_STEPS_BEFORE: &[(i64, DataStep)] = &[(46, keep_shipped_with_refs)];

/// Keeps what a task shipped with, the task and the pull request it was merged with, as
/// `task:<id>` and `pr:<url>` references before version 46 drops those columns, the
/// references a shipped-with conclusion writes now. References a task has already are
/// not added twice.
fn keep_shipped_with_refs(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "UPDATE tasks SET refs = (SELECT json_group_array(value) FROM (
             SELECT value FROM json_each(tasks.refs)
             UNION ALL SELECT 'task:' || tasks.merged_with_task_id
                 WHERE tasks.merged_with_task_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM json_each(tasks.refs)
                                   WHERE value = 'task:' || tasks.merged_with_task_id)
             UNION ALL SELECT 'pr:' || tasks.merged_with_pull_request_url
                 WHERE tasks.merged_with_pull_request_url IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM json_each(tasks.refs)
                                   WHERE value = 'pr:' || tasks.merged_with_pull_request_url)))
         WHERE merged_with_task_id IS NOT NULL OR merged_with_pull_request_url IS NOT NULL",
    )?;
    Ok(())
}

/// Gives every existing task the criteria it had so far: its pull request is merged
/// (met for tasks done as merged, through their own or another task's pull request),
/// followed by the `- [ ]` and `- [x]` items of the `Done when` section of its
/// description as manual criteria, checked items met. The description stays as it is.
fn import_criteria(tx: &Transaction<'_>) -> Result<()> {
    let tasks = {
        let mut statement = tx.prepare(
            "SELECT t.id, t.description, t.status = 'done' AND t.resolution = 'merged',
                 coalesce(t.merged_with_pull_request_url, t.pull_request_url),
                 (SELECT max(e.at) FROM task_events e
                  WHERE e.task_id = t.id AND e.status = 'done')
             FROM tasks t ORDER BY t.id",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut insert = tx.prepare(
        "INSERT INTO task_criteria (task_id, position, text, kind, state, evidence,
             checked_by, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for (id, description, merged, pull_request_url, done_at) in tasks {
        let (state, evidence, checked_by, checked_at) = if merged {
            (
                CriterionState::Met,
                pull_request_url,
                Some(CheckedBy::Toodo.as_str()),
                done_at,
            )
        } else {
            (CriterionState::Pending, None, None, None)
        };
        insert.execute(params![
            id,
            0,
            "Pull request merged into the base branch",
            "pr_merged",
            state.as_str(),
            evidence,
            checked_by,
            checked_at
        ])?;
        for (position, (text, checked)) in (1_i64..).zip(done_when_items(&description)) {
            let (state, evidence) = if checked {
                (CriterionState::Met, Some("Checked in the task description"))
            } else {
                (CriterionState::Pending, None)
            };
            insert.execute(params![
                id,
                position,
                text,
                CheckKind::Manual.as_str(),
                state.as_str(),
                evidence,
                None::<&str>,
                None::<i64>
            ])?;
        }
    }
    Ok(())
}
