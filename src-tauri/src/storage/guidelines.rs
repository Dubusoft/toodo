//! Guidelines of each workspace: rules its owner sets for agents and memories recorded
//! for it.
use super::{Result, Storage, StorageError, invalid_data};
use crate::domain::model::{Guideline, GuidelineId, GuidelineKind, WorkspaceId};
use rusqlite::{OptionalExtension, Row, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewGuideline {
    pub workspace_id: WorkspaceId,
    pub kind: GuidelineKind,
    pub body: String,
}

const GUIDELINE_COLUMNS: &str = "id, workspace_id, kind, body, created_at, updated_at";

/// A stored row, with its kind still as text.
type RawGuideline = (i64, i64, String, String, i64, i64);

fn raw_row(row: &Row<'_>) -> rusqlite::Result<RawGuideline> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
    ))
}

fn guideline(
    (id, workspace_id, kind, body, created_at, updated_at): RawGuideline,
) -> Result<Guideline> {
    let kind = GuidelineKind::ALL
        .into_iter()
        .find(|known| known.as_str() == kind)
        .ok_or_else(|| invalid_data(format!("unknown guideline kind {kind:?}")))?;
    Ok(Guideline {
        id: GuidelineId(id),
        workspace_id: WorkspaceId(workspace_id),
        kind,
        body,
        created_at,
        updated_at,
    })
}

impl Storage {
    /// The guidelines of a live workspace: rules first, then memories, each in the order
    /// they were added.
    pub fn list_guidelines(&self, workspace: WorkspaceId) -> Result<Vec<Guideline>> {
        self.ensure_live_workspace(workspace)?;
        self.conn
            .prepare(&format!(
                "SELECT {GUIDELINE_COLUMNS} FROM workspace_guidelines WHERE workspace_id = ?1
                 ORDER BY kind = 'memory', id"
            ))?
            .query_map([workspace.0], raw_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(guideline)
            .collect()
    }

    pub fn get_guideline(&self, id: GuidelineId) -> Result<Option<Guideline>> {
        self.conn
            .query_row(
                &format!("SELECT {GUIDELINE_COLUMNS} FROM workspace_guidelines WHERE id = ?1"),
                [id.0],
                raw_row,
            )
            .optional()?
            .map(guideline)
            .transpose()
    }

    /// Adds a guideline to a live workspace.
    pub fn add_guideline(&mut self, new: &NewGuideline) -> Result<Guideline> {
        self.ensure_live_workspace(new.workspace_id)?;
        let now = self.now();
        self.conn.execute(
            "INSERT INTO workspace_guidelines (workspace_id, kind, body, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![new.workspace_id.0, new.kind.as_str(), new.body, now],
        )?;
        let id = GuidelineId(self.conn.last_insert_rowid());
        self.get_guideline(id)?
            .ok_or(StorageError::GuidelineNotFound(id))
    }

    /// Replaces the kind and body of a guideline and records the time of the change.
    pub fn update_guideline(
        &mut self,
        id: GuidelineId,
        kind: GuidelineKind,
        body: &str,
    ) -> Result<Guideline> {
        let now = self.now();
        let changed = self.conn.execute(
            "UPDATE workspace_guidelines SET kind = ?2, body = ?3, updated_at = ?4 WHERE id = ?1",
            params![id.0, kind.as_str(), body, now],
        )?;
        if changed == 0 {
            return Err(StorageError::GuidelineNotFound(id));
        }
        self.get_guideline(id)?
            .ok_or(StorageError::GuidelineNotFound(id))
    }

    /// Deletes a guideline and returns it as it was, so the caller knows its workspace.
    pub fn delete_guideline(&mut self, id: GuidelineId) -> Result<Guideline> {
        let tx = self.conn.transaction()?;
        let deleted = tx
            .query_row(
                &format!(
                    "DELETE FROM workspace_guidelines WHERE id = ?1 RETURNING {GUIDELINE_COLUMNS}"
                ),
                [id.0],
                raw_row,
            )
            .optional()?
            .ok_or(StorageError::GuidelineNotFound(id))?;
        tx.commit()?;
        guideline(deleted)
    }

    fn ensure_live_workspace(&self, workspace: WorkspaceId) -> Result<()> {
        match self.get_workspace(workspace)? {
            Some(_) => Ok(()),
            None => Err(StorageError::WorkspaceNotFound(workspace)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::NewWorkspace;
    use GuidelineKind::{Memory, Rule};

    fn add_workspace(storage: &mut Storage, name: &str) -> WorkspaceId {
        storage
            .create_workspace(&NewWorkspace {
                name: name.to_owned(),
                description: None,
                repository: None,
            })
            .unwrap()
            .id
    }

    fn add(
        storage: &mut Storage,
        workspace: WorkspaceId,
        kind: GuidelineKind,
        body: &str,
    ) -> Guideline {
        storage
            .add_guideline(&NewGuideline {
                workspace_id: workspace,
                kind,
                body: body.to_owned(),
            })
            .unwrap()
    }

    fn bodies(storage: &Storage, workspace: WorkspaceId) -> Vec<String> {
        storage
            .list_guidelines(workspace)
            .unwrap()
            .into_iter()
            .map(|guideline| guideline.body)
            .collect()
    }

    #[test]
    fn guidelines_list_rules_before_memories_in_the_order_they_were_added() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 100);
        let toodo = add_workspace(&mut storage, "Toodo");
        let other = add_workspace(&mut storage, "Other");
        let lesson = add(&mut storage, toodo, Memory, "CI runs no tests");
        add(&mut storage, toodo, Rule, "Write English");
        add(&mut storage, other, Rule, "Elsewhere");
        add(&mut storage, toodo, Memory, "Bindings are generated");
        add(&mut storage, toodo, Rule, "Never commit");

        assert_eq!(
            bodies(&storage, toodo),
            [
                "Write English",
                "Never commit",
                "CI runs no tests",
                "Bindings are generated"
            ]
        );
        assert_eq!(
            lesson,
            Guideline {
                id: lesson.id,
                workspace_id: toodo,
                kind: Memory,
                body: "CI runs no tests".to_owned(),
                created_at: 100,
                updated_at: 100,
            }
        );
        assert!(matches!(
            storage.list_guidelines(WorkspaceId(99)),
            Err(StorageError::WorkspaceNotFound(WorkspaceId(99)))
        ));
    }

    #[test]
    fn updating_a_guideline_keeps_its_creation_time() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 100);
        let toodo = add_workspace(&mut storage, "Toodo");
        let lesson = add(&mut storage, toodo, Memory, "Draft");
        storage.set_clock(|| 200);
        let updated = storage
            .update_guideline(lesson.id, Rule, "Run clippy")
            .unwrap();
        assert_eq!(
            (
                updated.kind,
                updated.body.as_str(),
                updated.created_at,
                updated.updated_at
            ),
            (Rule, "Run clippy", 100, 200)
        );
        assert_eq!(storage.get_guideline(lesson.id).unwrap(), Some(updated));
    }

    #[test]
    fn missing_guidelines_and_workspaces_are_reported() {
        let mut storage = Storage::open_in_memory().unwrap();
        let toodo = add_workspace(&mut storage, "Toodo");
        let missing = GuidelineId(42);
        assert_eq!(storage.get_guideline(missing).unwrap(), None);
        assert!(matches!(
            storage.update_guideline(missing, Rule, "x"),
            Err(StorageError::GuidelineNotFound(GuidelineId(42)))
        ));
        assert!(matches!(
            storage.delete_guideline(missing),
            Err(StorageError::GuidelineNotFound(GuidelineId(42)))
        ));
        storage.archive_workspace(toodo).unwrap();
        assert!(matches!(
            storage.add_guideline(&NewGuideline {
                workspace_id: toodo,
                kind: Rule,
                body: "x".to_owned(),
            }),
            Err(StorageError::WorkspaceNotFound(_))
        ));
    }

    #[test]
    fn deleting_returns_the_guideline_and_purging_the_workspace_deletes_the_rest() {
        let mut storage = Storage::open_in_memory().unwrap();
        let toodo = add_workspace(&mut storage, "Toodo");
        let rule = add(&mut storage, toodo, Rule, "Write English");
        add(&mut storage, toodo, Memory, "CI runs no tests");

        assert_eq!(storage.delete_guideline(rule.id).unwrap(), rule);
        assert_eq!(bodies(&storage, toodo), ["CI runs no tests"]);

        storage.archive_workspace(toodo).unwrap();
        storage.purge_workspace(toodo).unwrap();
        let left: i64 = storage
            .conn
            .query_row("SELECT count(*) FROM workspace_guidelines", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(left, 0);
    }
}
