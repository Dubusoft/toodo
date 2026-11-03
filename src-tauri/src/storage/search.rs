//! Finding earlier tasks: full-text search over the `task_search` index, and related
//! links, which connect tasks without making one wait on the other.

use rusqlite::{OptionalExtension, ToSql};

use super::{Result, Storage, StorageError};
use crate::domain::model::{TaskId, WorkspaceId};
use crate::domain::status::TaskStatus;

/// Words shorter than this cannot use the trigram index, so they are matched with
/// `LIKE` instead, e.g. two-character Korean words.
const TRIGRAM: usize = 3;

/// How much a match counts in each column of `task_search`, for bm25: a match in the
/// title says most about a task, then its branch and pull request, then its text.
const BM25_WEIGHTS: &str = "10.0, 2.0, 1.0, 5.0, 5.0";

/// What [`Storage::search_tasks`] looks for. Every word of `query` (split on whitespace)
/// must appear somewhere in a task, as a case-insensitive substring; the words are taken
/// literally, never as search operators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSearch<'a> {
    pub query: &'a str,
    pub workspace: Option<WorkspaceId>,
    pub status: Option<TaskStatus>,
    pub limit: u32,
}

/// `word` as an FTS5 string: double quotes make operators (`AND`, `OR`, `NOT`, `NEAR`),
/// prefixes (`*`), column filters (`:`), and parentheses plain text.
fn fts_string(word: &str) -> String {
    format!("\"{}\"", word.replace('"', "\"\""))
}

/// A `LIKE ... ESCAPE '\'` pattern matching `word` anywhere.
pub(super) fn like_pattern(word: &str) -> String {
    let mut pattern = String::from("%");
    for character in word.chars() {
        if matches!(character, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

const SEARCHED_TEXT: &str = "(task_search.title || char(10) || task_search.description \
    || char(10) || task_search.notes || char(10) || task_search.branch || char(10) \
    || task_search.pull_request)";

impl Storage {
    /// IDs of the tasks matching `search`, best match first, at most `search.limit`.
    /// Words of three or more characters go through the trigram index and rank the
    /// results by bm25; when every word is shorter, tasks whose title matches come first.
    /// Ties go to the newer task. A query without words matches nothing.
    pub fn search_tasks(&self, search: &TaskSearch<'_>) -> Result<Vec<TaskId>> {
        let (indexed, short): (Vec<&str>, Vec<&str>) = search
            .query
            .split_whitespace()
            .partition(|word| word.chars().count() >= TRIGRAM);
        if indexed.is_empty() && short.is_empty() {
            return Ok(Vec::new());
        }

        let mut conditions = Vec::new();
        let mut parameters: Vec<Box<dyn ToSql>> = Vec::new();
        if !indexed.is_empty() {
            conditions.push("task_search MATCH ?".to_owned());
            let words: Vec<String> = indexed.iter().map(|word| fts_string(word)).collect();
            parameters.push(Box::new(words.join(" ")));
        }
        for word in &short {
            conditions.push(format!("{SEARCHED_TEXT} LIKE ? ESCAPE '\\'"));
            parameters.push(Box::new(like_pattern(word)));
        }
        if let Some(workspace) = search.workspace {
            conditions.push("t.workspace_id = ?".to_owned());
            parameters.push(Box::new(workspace.0));
        }
        if let Some(status) = search.status {
            conditions.push("t.status = ?".to_owned());
            parameters.push(Box::new(status.as_str()));
        }
        let order = if indexed.is_empty() {
            parameters.push(Box::new(like_pattern(short[0])));
            "task_search.title LIKE ? ESCAPE '\\' DESC, t.id DESC".to_owned()
        } else {
            format!("bm25(task_search, {BM25_WEIGHTS}), t.id DESC")
        };
        parameters.push(Box::new(search.limit));

        let sql = format!(
            "SELECT t.id FROM task_search JOIN tasks t ON t.id = task_search.rowid
             WHERE {} ORDER BY {order} LIMIT ?",
            conditions.join(" AND ")
        );
        let mut statement = self.conn.prepare(&sql)?;
        let ids = statement
            .query_map(
                rusqlite::params_from_iter(parameters.iter().map(Box::as_ref)),
                |row| row.get(0).map(TaskId),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }

    /// Links `task` and `related`, which may belong to different workspaces. The link
    /// goes both ways, never blocks either task, and is stored once: linking twice, in
    /// either direction, keeps one link. Rejects a link of a task to itself and unknown
    /// tasks.
    pub fn add_related(&mut self, task: TaskId, related: TaskId) -> Result<()> {
        if task == related {
            return Err(StorageError::SelfRelation(task));
        }
        let tx = self.conn.transaction()?;
        for id in [task, related] {
            tx.query_row("SELECT 1 FROM tasks WHERE id = ?1", [id.0], |_| Ok(()))
                .optional()?
                .ok_or(StorageError::TaskNotFound(id))?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO task_relations (task_id, related_id) VALUES (?1, ?2)",
            [task.0.min(related.0), task.0.max(related.0)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Removes the link between `task` and `related`, given in either order; rejects a link
    /// that does not exist.
    pub fn remove_related(&mut self, task: TaskId, related: TaskId) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.query_row("SELECT 1 FROM tasks WHERE id = ?1", [task.0], |_| Ok(()))
            .optional()?
            .ok_or(StorageError::TaskNotFound(task))?;
        let removed = tx.execute(
            "DELETE FROM task_relations WHERE task_id = ?1 AND related_id = ?2",
            [task.0.min(related.0), task.0.max(related.0)],
        )?;
        if removed == 0 {
            return Err(StorageError::RelationNotFound { task, related });
        }
        tx.commit()?;
        Ok(())
    }

    /// Every related link, as pairs of task IDs with the lower ID first.
    pub fn list_relations(&self) -> Result<Vec<(TaskId, TaskId)>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT task_id, related_id FROM task_relations ORDER BY task_id, related_id",
        )?;
        let pairs = statement
            .query_map([], |row| Ok((TaskId(row.get(0)?), TaskId(row.get(1)?))))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(pairs)
    }
}
