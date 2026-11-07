//! Workspace records and their archive.
use super::tasks::LIVE_TASK;
use super::{Result, Storage, StorageError};
use crate::domain::model::{TaskId, Workspace, WorkspaceId};
use rusqlite::{OptionalExtension, Row, params};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWorkspace {
    pub name: String,
    pub description: Option<String>,
    pub repository: Option<String>,
}
const WORKSPACE_COLUMNS: &str = "id, name, description, repository, archived_at";
/// Rejects workspace `id` unless it is stored and archived.
fn ensure_archived(conn: &rusqlite::Connection, id: WorkspaceId) -> Result<()> {
    let archived: Option<Option<i64>> = conn
        .query_row(
            "SELECT archived_at FROM workspaces WHERE id = ?1",
            [id.0],
            |row| row.get(0),
        )
        .optional()?;
    match archived {
        None => Err(StorageError::WorkspaceNotFound(id)),
        Some(None) => Err(StorageError::WorkspaceNotArchived(id)),
        Some(Some(_)) => Ok(()),
    }
}

fn workspace_row(row: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: WorkspaceId(row.get(0)?),
        name: row.get(1)?,
        description: row.get(2)?,
        repository: row.get(3)?,
        archived_at: row.get(4)?,
    })
}
impl Storage {
    pub fn create_workspace(&mut self, new: &NewWorkspace) -> Result<Workspace> {
        self.conn.execute(
            "INSERT INTO workspaces (name, description, repository) VALUES (?1, ?2, ?3)",
            params![new.name, new.description, new.repository],
        )?;
        self.get_workspace(WorkspaceId(self.conn.last_insert_rowid()))?
            .ok_or(StorageError::WorkspaceNotFound(WorkspaceId(
                self.conn.last_insert_rowid(),
            )))
    }
    pub fn get_workspace(&self, id: WorkspaceId) -> Result<Option<Workspace>> {
        Ok(self.conn.query_row(&format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1 AND archived_at IS NULL"), [id.0], workspace_row).optional()?)
    }
    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        self.workspaces_where("archived_at IS NULL")
    }
    pub fn archived_workspaces(&self) -> Result<Vec<Workspace>> {
        self.workspaces_where("archived_at IS NOT NULL")
    }
    fn workspaces_where(&self, filter: &str) -> Result<Vec<Workspace>> {
        Ok(self
            .conn
            .prepare(&format!(
                "SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE {filter} ORDER BY id"
            ))?
            .query_map([], workspace_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn update_workspace(&mut self, w: &Workspace) -> Result<()> {
        if self.conn.execute("UPDATE workspaces SET name = ?2, description = ?3, repository = ?4 WHERE id = ?1 AND archived_at IS NULL", params![w.id.0, w.name, w.description, w.repository])? == 0 { return Err(StorageError::WorkspaceNotFound(w.id)); }
        Ok(())
    }
    /// Archives a live workspace with its tasks: they leave the lists and the dependency
    /// DAG but keep their history for reviews until [`Self::restore_workspace`] brings them
    /// back or [`Self::purge_workspace`] deletes them. Rejected while a `planned` task of
    /// another workspace depends on one of its tasks, which would otherwise silently become
    /// ready to start, and while a run of one of its tasks is queued or active; a run of
    /// runner `none` has no process to stop and does not count. The herdr
    /// workspaces its tasks have open are forgotten; herdr keeps them.
    pub fn archive_workspace(&mut self, id: WorkspaceId) -> Result<()> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let live: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND archived_at IS NULL)",
            [id.0],
            |row| row.get(0),
        )?;
        if !live {
            return Err(StorageError::WorkspaceNotFound(id));
        }
        let dependent: Option<(i64, i64)> = tx
            .query_row(
                &format!(
                    "SELECT d.task_id, d.depends_on_id
                     FROM task_dependencies d
                     JOIN tasks t ON t.id = d.task_id
                     JOIN tasks p ON p.id = d.depends_on_id
                     WHERE p.workspace_id = ?1 AND t.workspace_id <> ?1
                       AND t.status = 'planned' AND p.archived_at IS NULL
                       AND {LIVE_TASK}
                     ORDER BY d.task_id, d.depends_on_id
                     LIMIT 1"
                ),
                [id.0],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((task, depends_on)) = dependent {
            return Err(StorageError::WorkspaceHasDependents {
                workspace: id,
                task: TaskId(task),
                depends_on: TaskId(depends_on),
            });
        }
        tx.execute(
            "UPDATE workspaces SET archived_at = ?2 WHERE id = ?1",
            params![id.0, at],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Brings an archived workspace back with its tasks, except those archived on their
    /// own before. Rejected when their dependencies would close a cycle with edges added
    /// while it was archived.
    pub fn restore_workspace(&mut self, id: WorkspaceId) -> Result<Workspace> {
        let tx = self.conn.transaction()?;
        self::ensure_archived(&tx, id)?;
        tx.execute(
            "UPDATE workspaces SET archived_at = NULL WHERE id = ?1",
            [id.0],
        )?;
        super::tasks::ensure_acyclic(&tx)?;
        tx.commit()?;
        self.get_workspace(id)?
            .ok_or(StorageError::WorkspaceNotFound(id))
    }

    /// Deletes an archived workspace for good, with its tasks, their dependencies, commit
    /// records, and history; a live workspace is rejected, so deleting history is always
    /// explicit.
    pub fn purge_workspace(&mut self, id: WorkspaceId) -> Result<()> {
        let tx = self.conn.transaction()?;
        self::ensure_archived(&tx, id)?;
        tx.execute("DELETE FROM workspaces WHERE id = ?1", [id.0])?;
        tx.commit()?;
        Ok(())
    }
}
