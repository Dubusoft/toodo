//! Append-only observations and cursors scoped to a runtime host.

use rusqlite::{OptionalExtension, params};

use crate::domain::model::TaskId;
use crate::domain::runtime::{HostRef, OwnerKey};
use crate::runtime::events::{HostState, RuntimeEvent, RuntimeEventKind};
use crate::storage::{Result, Storage, invalid_data};

#[cfg(test)]
#[path = "host_events_tests.rs"]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCursor {
    pub last_sequence: i64,
    pub reconciled_sequence: Option<i64>,
    pub state: HostState,
}

impl Storage {
    pub fn host_cursor(&self, owner: &OwnerKey, host: &HostRef) -> Result<HostCursor> {
        let row = self
            .conn
            .query_row(
                "SELECT last_sequence, reconciled_sequence, state FROM runtime_hosts
             WHERE owner_key = ?1 AND host_ref = ?2",
                params![owner.as_str(), host.as_wire()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, String>(2)?)),
            )
            .optional()?;
        let Some((last_sequence, reconciled_sequence, state)) = row else {
            return Ok(HostCursor {
                last_sequence: 0,
                reconciled_sequence: None,
                state: HostState::Unknown,
            });
        };
        let state = match state.as_str() {
            "online" => HostState::Online,
            "offline" => HostState::Offline,
            "unknown" => HostState::Unknown,
            _ => {
                return Err(invalid_data(format!(
                    "unknown runtime host state {state:?}; restore a valid database backup"
                )));
            }
        };
        Ok(HostCursor {
            last_sequence,
            reconciled_sequence,
            state,
        })
    }

    /// Activity is deliberately not persisted. Repeated host states do not advance
    /// the cursor. Journal insertion and cursor updates commit together.
    pub fn append_host_event(&mut self, event: &RuntimeEvent) -> Result<Option<i64>> {
        let (kind, reference, checkout, state, reconciled) = match &event.kind {
            RuntimeEventKind::WorkspaceOpened {
                provider_workspace_ref,
                checkout_path,
            } => (
                "workspace_opened",
                Some(provider_workspace_ref),
                Some(checkout_path),
                None,
                false,
            ),
            RuntimeEventKind::WorkspaceClosed {
                provider_workspace_ref,
                checkout_path,
            } => (
                "workspace_closed",
                Some(provider_workspace_ref),
                Some(checkout_path),
                None,
                false,
            ),
            RuntimeEventKind::ActivityChanged => return Ok(None),
            RuntimeEventKind::HostState(state) => {
                if self.host_cursor(&event.owner_key, &event.host_ref)?.state == *state {
                    return Ok(None);
                }
                (state.as_wire(), None, None, Some(state.as_wire()), false)
            }
            RuntimeEventKind::SnapshotReconciled => ("snapshot_reconciled", None, None, None, true),
        };
        let tx = self.conn.transaction()?;
        let host = event.host_ref.as_wire();
        let owner = event.owner_key.as_str();
        let sequence: i64 = tx.query_row(
            "INSERT INTO runtime_hosts (owner_key, host_ref, last_sequence, updated_at)
             VALUES (?1, ?2, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT (owner_key, host_ref) DO UPDATE SET
                 last_sequence = last_sequence + 1, updated_at = excluded.updated_at
             RETURNING last_sequence",
            params![owner, host],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO runtime_host_events
                (owner_key, host_ref, sequence, kind, provider_workspace_ref,
                 checkout_path, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![owner, host, sequence, kind, reference, checkout],
        )?;
        tx.execute(
            "UPDATE runtime_hosts SET state = coalesce(?3, state),
                 reconciled_sequence = CASE WHEN ?4 THEN last_sequence
                                            ELSE reconciled_sequence END
             WHERE owner_key = ?1 AND host_ref = ?2",
            params![owner, host, state, reconciled],
        )?;
        tx.commit()?;
        Ok(Some(sequence))
    }

    pub fn set_host_state(
        &mut self,
        owner: &OwnerKey,
        host: &HostRef,
        state: HostState,
    ) -> Result<Option<i64>> {
        self.append_host_event(&RuntimeEvent {
            owner_key: owner.clone(),
            host_ref: host.clone(),
            kind: RuntimeEventKind::HostState(state),
        })
    }

    pub fn mark_host_reconciled(
        &mut self,
        owner: &OwnerKey,
        host: &HostRef,
    ) -> Result<Option<i64>> {
        self.append_host_event(&RuntimeEvent {
            owner_key: owner.clone(),
            host_ref: host.clone(),
            kind: RuntimeEventKind::SnapshotReconciled,
        })
    }

    pub fn closed_runtime_workspace_used(
        &self,
        task: TaskId,
        host: &HostRef,
        reference: &str,
    ) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM runtime_workspaces
             WHERE task_id = ?1 AND host_ref = ?2 AND provider_workspace_ref = ?3
               AND state = 'closed')",
            params![task.0, host.as_wire(), reference],
            |row| row.get(0),
        )?)
    }
}
