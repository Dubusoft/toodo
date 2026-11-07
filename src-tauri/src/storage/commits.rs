//! Commit records of a task.

use super::{Result, Storage};
use crate::domain::model::{CommitRecord, PullRequestSnapshot, TaskId};
use crate::domain::review::Period;
use rusqlite::OptionalExtension;

impl Storage {
    /// Reads the historical pull request snapshot without collecting new records.
    pub fn historical_pull_request(&self, task: TaskId) -> Result<Option<PullRequestSnapshot>> {
        Ok(self.conn.query_row("SELECT number, title, additions, deletions, changed_files, merge_commit_sha, review_count, reviewer_count, first_reviewed_at FROM pull_request_snapshots WHERE task_id = ?1", [task.0], |row| Ok(PullRequestSnapshot { number: row.get(0)?, title: row.get(1)?, additions: row.get(2)?, deletions: row.get(3)?, changed_files: row.get(4)?, merge_commit_sha: row.get(5)?, review_count: row.get(6)?, reviewer_count: row.get(7)?, first_reviewed_at: row.get(8)? })).optional()?)
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

    /// Commits of every task committed in `period`, oldest first: its commit records,
    /// and the commits its git activity recorded that are not among them yet, such as
    /// the commits of a task in progress without a pull request. An activity commit
    /// carries the first line of its message.
    pub fn list_commit_records_in(&self, period: Period) -> Result<Vec<CommitRecord>> {
        let mut statement = self.conn.prepare(
            "SELECT task_id, sha, message, author, committed_at, 0 AS origin, position
             FROM commit_records
             WHERE committed_at >= ?1 AND committed_at < ?2
             UNION ALL
             SELECT task_id, external_ref, title, COALESCE(author, ''), occurred_at, 1, id
             FROM task_activity AS activity
             WHERE kind = 'commit' AND occurred_at >= ?1 AND occurred_at < ?2
               AND NOT EXISTS (
                   SELECT 1 FROM commit_records AS record
                   WHERE record.task_id = activity.task_id AND record.sha = activity.external_ref
               )
             ORDER BY committed_at, task_id, origin, position",
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

#[cfg(test)]
impl Storage {
    pub(crate) fn seed_commit_records(
        &mut self,
        task: TaskId,
        records: &[CommitRecord],
    ) -> Result<()> {
        for (position, record) in records.iter().enumerate() {
            self.conn.execute("INSERT INTO commit_records (task_id, position, sha, message, author, committed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", rusqlite::params![task.0, position as i64, record.sha, record.message, record.author, record.committed_at])?;
        }
        Ok(())
    }
}
