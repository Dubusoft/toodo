//! When the agent of each task changed what it was doing, as herdr reported it.

use rusqlite::{OptionalExtension, params};

use super::{Result, Storage, invalid_data};
use crate::domain::model::TaskId;
use crate::domain::runtime::AgentState;

/// What the agent of a task was doing from `at` on; `None` once no agent was seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentStatusTransition {
    pub status: Option<AgentState>,
    pub at: i64,
}

impl Storage {
    /// Stores, at the current time, the status of each task in `statuses` that differs
    /// from the last one stored for it. A task without a stored status counts as having
    /// no agent, so reporting `None` for it stores nothing. Tasks that no longer exist
    /// are skipped. Returns how many transitions were stored.
    pub fn record_agent_statuses(
        &mut self,
        statuses: &[(TaskId, Option<AgentState>)],
    ) -> Result<usize> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let mut stored = 0;
        {
            let mut last = tx.prepare(
                "SELECT status FROM agent_status_transitions WHERE task_id = ?1
                 ORDER BY id DESC LIMIT 1",
            )?;
            let mut exists = tx.prepare("SELECT 1 FROM tasks WHERE id = ?1")?;
            let mut insert = tx.prepare(
                "INSERT INTO agent_status_transitions (task_id, status, at) VALUES (?1, ?2, ?3)",
            )?;
            for (task, status) in statuses {
                let wire = status.map(AgentState::as_wire);
                let previous: Option<Option<String>> =
                    last.query_row([task.0], |row| row.get(0)).optional()?;
                if previous.flatten().as_deref() == wire || !exists.exists([task.0])? {
                    continue;
                }
                insert.execute(params![task.0, wire, at])?;
                stored += 1;
            }
        }
        tx.commit()?;
        Ok(stored)
    }

    /// The agent status transitions of `task`, oldest first.
    pub fn list_agent_status_transitions(
        &self,
        task: TaskId,
    ) -> Result<Vec<AgentStatusTransition>> {
        let mut statement = self.conn.prepare(
            "SELECT status, at FROM agent_status_transitions WHERE task_id = ?1 ORDER BY id",
        )?;
        let rows = statement
            .query_map([task.0], |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(status, at)| {
                Ok(AgentStatusTransition {
                    status: status
                        .map(|status| AgentState::parse(&status).map_err(invalid_data))
                        .transpose()?,
                    at,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::{CompletionMode, Runner, Source, TaskType, WorkspaceLocation};
    use crate::domain::path::PosixPath;
    use crate::storage::{NewTask, NewWorkspace};

    fn task(storage: &mut Storage) -> TaskId {
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: PosixPath::parse("/repo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source: Source::GitHub,
                completion: CompletionMode::PullRequestMerge,
                runner: Runner::Herdr,
                axes_detected: true,
            })
            .unwrap();
        storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: "Work".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap()
            .id
    }

    #[test]
    fn only_changes_of_existing_tasks_are_stored() {
        let mut storage = Storage::open_in_memory().unwrap();
        let id = task(&mut storage);
        let missing = TaskId(id.0 + 1);
        storage.set_clock(|| 10);
        assert_eq!(storage.record_agent_statuses(&[(id, None)]).unwrap(), 0);
        let working = (id, Some(AgentState::Working));
        assert_eq!(
            storage
                .record_agent_statuses(&[working, (missing, Some(AgentState::Idle))])
                .unwrap(),
            1
        );
        storage.set_clock(|| 20);
        assert_eq!(storage.record_agent_statuses(&[working]).unwrap(), 0);
        assert_eq!(storage.record_agent_statuses(&[(id, None)]).unwrap(), 1);
        assert_eq!(
            storage.list_agent_status_transitions(id).unwrap(),
            [
                AgentStatusTransition {
                    status: Some(AgentState::Working),
                    at: 10
                },
                AgentStatusTransition {
                    status: None,
                    at: 20
                },
            ]
        );
        assert_eq!(storage.list_agent_status_transitions(missing).unwrap(), []);
    }
}
