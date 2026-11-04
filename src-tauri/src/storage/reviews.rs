//! The time zone reviews are judged in, kept in `settings`, and saved reviews, kept in
//! `review_snapshots` exactly as they were rendered when saved.

use rusqlite::{OptionalExtension, Row, params};

use super::{Result, Storage};

const REVIEW_TIME_ZONE: &str = "review_time_zone";

/// What describes a saved review, without its contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSnapshotInfo {
    pub id: i64,
    pub title: String,
    /// The kind of period, as the review report names it (`week`, `month`, ...).
    pub period: String,
    /// The first and last day of the period, as `YYYY-MM-DD` in `time_zone`.
    pub from: String,
    pub to: String,
    /// The IANA time zone the period was judged in.
    pub time_zone: String,
    pub workspace_id: Option<i64>,
    pub label: Option<String>,
    /// The period as `[start_at, end_at)` in seconds.
    pub start_at: i64,
    pub end_at: i64,
    pub created_at: i64,
    pub entry_count: i64,
}

/// A saved review: what describes it, the reviewed entries and the names of their
/// workspaces as JSON, and the report as Markdown and CSV.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSnapshot {
    pub info: ReviewSnapshotInfo,
    pub entries: String,
    pub workspaces: String,
    pub markdown: String,
    pub csv: String,
}

const INFO_COLUMNS: &str = "id, title, period, from_day, to_day, time_zone, workspace_id, label,
     start_at, end_at, created_at, entry_count";

fn info(row: &Row<'_>) -> rusqlite::Result<ReviewSnapshotInfo> {
    Ok(ReviewSnapshotInfo {
        id: row.get(0)?,
        title: row.get(1)?,
        period: row.get(2)?,
        from: row.get(3)?,
        to: row.get(4)?,
        time_zone: row.get(5)?,
        workspace_id: row.get(6)?,
        label: row.get(7)?,
        start_at: row.get(8)?,
        end_at: row.get(9)?,
        created_at: row.get(10)?,
        entry_count: row.get(11)?,
    })
}

impl Storage {
    /// The IANA time zone set for reviews, or `None` to use the server's.
    pub fn review_time_zone(&self) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [REVIEW_TIME_ZONE],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Sets the time zone reviews are judged in; `None` goes back to the server's.
    pub fn set_review_time_zone(&mut self, time_zone: Option<&str>) -> Result<()> {
        match time_zone {
            Some(name) => self.conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![REVIEW_TIME_ZONE, name],
            )?,
            None => self
                .conn
                .execute("DELETE FROM settings WHERE key = ?1", [REVIEW_TIME_ZONE])?,
        };
        Ok(())
    }

    /// Saves `snapshot` (its `id` and `created_at` are assigned here) and returns what
    /// describes it.
    pub fn save_review_snapshot(
        &mut self,
        snapshot: &ReviewSnapshot,
    ) -> Result<ReviewSnapshotInfo> {
        let info = &snapshot.info;
        let created_at = self.now();
        self.conn.execute(
            "INSERT INTO review_snapshots (title, period, from_day, to_day, time_zone,
                 workspace_id, label, start_at, end_at, created_at, entry_count, entries,
                 workspaces, markdown, csv)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                info.title,
                info.period,
                info.from,
                info.to,
                info.time_zone,
                info.workspace_id,
                info.label,
                info.start_at,
                info.end_at,
                created_at,
                info.entry_count,
                snapshot.entries,
                snapshot.workspaces,
                snapshot.markdown,
                snapshot.csv,
            ],
        )?;
        Ok(ReviewSnapshotInfo {
            id: self.conn.last_insert_rowid(),
            created_at,
            ..info.clone()
        })
    }

    /// The saved reviews, the most recently saved first.
    pub fn list_review_snapshots(&self) -> Result<Vec<ReviewSnapshotInfo>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {INFO_COLUMNS} FROM review_snapshots ORDER BY created_at DESC, id DESC"
        ))?;
        let rows = statement.query_map([], info)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The saved review `id`, or `None` when there is none.
    pub fn review_snapshot(&self, id: i64) -> Result<Option<ReviewSnapshot>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {INFO_COLUMNS}, entries, workspaces, markdown, csv
                     FROM review_snapshots WHERE id = ?1"
                ),
                [id],
                |row| {
                    Ok(ReviewSnapshot {
                        info: info(row)?,
                        entries: row.get(12)?,
                        workspaces: row.get(13)?,
                        markdown: row.get(14)?,
                        csv: row.get(15)?,
                    })
                },
            )
            .optional()?)
    }

    /// Deletes the saved review `id`; false when there was none.
    pub fn delete_review_snapshot(&mut self, id: i64) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM review_snapshots WHERE id = ?1", [id])?
            > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(title: &str) -> ReviewSnapshot {
        ReviewSnapshot {
            info: ReviewSnapshotInfo {
                id: 0,
                title: title.to_owned(),
                period: "week".to_owned(),
                from: "2026-11-02".to_owned(),
                to: "2026-11-08".to_owned(),
                time_zone: "Asia/Seoul".to_owned(),
                workspace_id: None,
                label: Some("perf".to_owned()),
                start_at: 100,
                end_at: 200,
                created_at: 0,
                entry_count: 1,
            },
            entries: "[{\"id\":1}]".to_owned(),
            workspaces: "[]".to_owned(),
            markdown: "# Week review".to_owned(),
            csv: "id\r\n1\r\n".to_owned(),
        }
    }

    #[test]
    fn the_review_time_zone_is_set_replaced_and_cleared() {
        let mut storage = Storage::open_in_memory().unwrap();
        assert_eq!(storage.review_time_zone().unwrap(), None);
        storage.set_review_time_zone(Some("Asia/Seoul")).unwrap();
        storage.set_review_time_zone(Some("Europe/Berlin")).unwrap();
        assert_eq!(
            storage.review_time_zone().unwrap().as_deref(),
            Some("Europe/Berlin")
        );
        storage.set_review_time_zone(None).unwrap();
        assert_eq!(storage.review_time_zone().unwrap(), None);
    }

    #[test]
    fn snapshots_are_saved_listed_newest_first_read_back_and_deleted() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 1000);
        let first = storage.save_review_snapshot(&snapshot("First")).unwrap();
        storage.set_clock(|| 2000);
        let second = storage.save_review_snapshot(&snapshot("Second")).unwrap();
        assert_eq!((first.created_at, second.created_at), (1000, 2000));

        let titles: Vec<_> = storage
            .list_review_snapshots()
            .unwrap()
            .into_iter()
            .map(|info| info.title)
            .collect();
        assert_eq!(titles, ["Second", "First"]);

        let read = storage.review_snapshot(first.id).unwrap().unwrap();
        assert_eq!(read.info, first);
        assert_eq!(
            ReviewSnapshot {
                info: snapshot("First").info,
                ..read.clone()
            },
            snapshot("First")
        );

        assert!(storage.delete_review_snapshot(first.id).unwrap());
        assert!(!storage.delete_review_snapshot(first.id).unwrap());
        assert_eq!(storage.review_snapshot(first.id).unwrap(), None);
    }
}
