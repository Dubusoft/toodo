//! Commit records of a task.

use rusqlite::{Connection, OptionalExtension, params};

use super::{Result, Storage, StorageError};
use crate::domain::model::{CommitRecord, TaskId};
use crate::domain::review::Period;

impl Storage {
    /// Replaces the commit records of `task` with `records`, keeping their order. Every
    /// record must belong to `task`.
    pub fn replace_commit_records(&mut self, task: TaskId, records: &[CommitRecord]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.query_row("SELECT 1 FROM tasks WHERE id = ?1", [task.0], |_| Ok(()))
            .optional()?
            .ok_or(StorageError::TaskNotFound(task))?;
        write_commit_records(&tx, task, records)?;
        tx.commit()?;
        Ok(())
    }

    /// Commit records of `task` in the order they were stored.
    pub fn list_commit_records(&self, task: TaskId) -> Result<Vec<CommitRecord>> {
        let mut statement = self.conn.prepare(
            "SELECT sha, message, author, committed_at FROM commit_records
             WHERE task_id = ?1 ORDER BY position",
        )?;
        let records = statement
            .query_map([task.0], |row| {
                Ok(CommitRecord {
                    task_id: task,
                    sha: row.get(0)?,
                    message: row.get(1)?,
                    author: row.get(2)?,
                    committed_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
    }

    /// Commit records of every task committed in `period`, oldest first.
    pub fn list_commit_records_in(&self, period: Period) -> Result<Vec<CommitRecord>> {
        let mut statement = self.conn.prepare(
            "SELECT task_id, sha, message, author, committed_at FROM commit_records
             WHERE committed_at >= ?1 AND committed_at < ?2
             ORDER BY committed_at, task_id, position",
        )?;
        let records = statement
            .query_map([period.start(), period.end()], |row| {
                Ok(CommitRecord {
                    task_id: TaskId(row.get(0)?),
                    sha: row.get(1)?,
                    message: row.get(2)?,
                    author: row.get(3)?,
                    committed_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
    }
}

/// Replaces the commit records of the existing task `task` with `records`, keeping
/// their order. Every record must belong to `task`.
pub(super) fn write_commit_records(
    conn: &Connection,
    task: TaskId,
    records: &[CommitRecord],
) -> Result<()> {
    if let Some(record) = records.iter().find(|record| record.task_id != task) {
        return Err(StorageError::CommitTaskMismatch {
            expected: task,
            found: record.task_id,
        });
    }
    conn.execute("DELETE FROM commit_records WHERE task_id = ?1", [task.0])?;
    let mut insert = conn.prepare(
        "INSERT INTO commit_records (task_id, position, sha, message, author, committed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (position, record) in records.iter().enumerate() {
        insert.execute(params![
            task.0,
            position as i64,
            record.sha,
            record.message,
            record.author,
            record.committed_at
        ])?;
    }
    Ok(())
}
