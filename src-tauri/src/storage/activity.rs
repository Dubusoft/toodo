//! Git activity of a task (see [`crate::domain::activity`]).

use rusqlite::{OptionalExtension, params};

use super::{Result, Storage, StorageError, invalid_data};
use crate::domain::activity::{ActivityEvent, ActivityKind, ActivitySource, RecordedActivity};
use crate::domain::model::TaskId;

impl Storage {
    /// Stores `events` of `task` reported at `now`, reconciling each with the event of the
    /// same dedup key stored before: the first `received_at`, `source`, `title`, and
    /// `author` stay, `occurred_at` becomes the earlier of both, and `confirmed_at`
    /// becomes `now`. Every event must belong to `task`. Returns how many events were not
    /// stored before.
    pub fn record_activity(
        &mut self,
        task: TaskId,
        events: &[ActivityEvent],
        now: i64,
    ) -> Result<usize> {
        if let Some(event) = events.iter().find(|event| event.task_id != task) {
            return Err(StorageError::ActivityTaskMismatch {
                expected: task,
                found: event.task_id,
            });
        }
        let tx = self.conn.transaction()?;
        tx.query_row("SELECT 1 FROM tasks WHERE id = ?1", [task.0], |_| Ok(()))
            .optional()?
            .ok_or(StorageError::TaskNotFound(task))?;
        let mut new = 0;
        {
            let mut exists =
                tx.prepare("SELECT 1 FROM task_activity WHERE task_id = ?1 AND dedup_key = ?2")?;
            let mut upsert = tx.prepare(
                "INSERT INTO task_activity (task_id, dedup_key, kind, source, external_ref,
                     title, author, occurred_at, received_at, confirmed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT (task_id, dedup_key) DO UPDATE SET
                     occurred_at = MIN(occurred_at, excluded.occurred_at),
                     confirmed_at = excluded.confirmed_at",
            )?;
            for event in events {
                let key = event.dedup_key();
                if !exists.exists(params![task.0, key])? {
                    new += 1;
                }
                upsert.execute(params![
                    task.0,
                    key,
                    event.kind.as_str(),
                    event.source.as_str(),
                    event.external_ref,
                    event.title,
                    event.author,
                    event.occurred_at,
                    now
                ])?;
            }
        }
        tx.commit()?;
        Ok(new)
    }

    /// The activity of `task`, by when it happened, then by when it was first stored.
    pub fn list_activity(&self, task: TaskId) -> Result<Vec<RecordedActivity>> {
        let mut statement = self.conn.prepare(
            "SELECT kind, source, external_ref, title, author, occurred_at, received_at,
                    confirmed_at
             FROM task_activity WHERE task_id = ?1 ORDER BY occurred_at, id",
        )?;
        let rows = statement
            .query_map([task.0], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(
                |(
                    kind,
                    source,
                    external_ref,
                    title,
                    author,
                    occurred_at,
                    received_at,
                    confirmed_at,
                )| {
                    Ok(RecordedActivity {
                        event: ActivityEvent {
                            task_id: task,
                            kind: ActivityKind::parse(&kind).ok_or_else(|| {
                                invalid_data(format!("unknown activity kind {kind:?}"))
                            })?,
                            source: ActivitySource::parse(&source).ok_or_else(|| {
                                invalid_data(format!("unknown activity source {source:?}"))
                            })?,
                            external_ref,
                            title,
                            author,
                            occurred_at,
                        },
                        received_at,
                        confirmed_at,
                    })
                },
            )
            .collect()
    }
}
