//! How agents of runs are launched: the options a workspace sets for its tasks and the
//! ones a task overrides, kept in the same columns of `workspaces` and `tasks`.

use rusqlite::{OptionalExtension, params};

use super::{Result, Storage, StorageError};
use crate::domain::model::{AgentOptions, PermissionMode, TaskId, WorkspaceId};

#[derive(Clone, Copy)]
enum Owner {
    Workspace(WorkspaceId),
    Task(TaskId),
}

impl Owner {
    fn table_and_id(self) -> (&'static str, i64) {
        match self {
            Self::Workspace(id) => ("workspaces", id.0),
            Self::Task(id) => ("tasks", id.0),
        }
    }

    fn not_found(self) -> StorageError {
        match self {
            Self::Workspace(id) => StorageError::WorkspaceNotFound(id),
            Self::Task(id) => StorageError::TaskNotFound(id),
        }
    }
}

impl Storage {
    /// The launch options workspace `id` sets for the runs of its tasks.
    pub fn workspace_agent_options(&self, id: WorkspaceId) -> Result<AgentOptions> {
        self.agent_options(Owner::Workspace(id))
    }

    /// Replaces the launch options of workspace `id`.
    pub fn set_workspace_agent_options(
        &mut self,
        id: WorkspaceId,
        options: &AgentOptions,
    ) -> Result<()> {
        self.set_agent_options(Owner::Workspace(id), options)
    }

    /// The launch options task `id` overrides; unset values come from its workspace.
    pub fn task_agent_options(&self, id: TaskId) -> Result<AgentOptions> {
        self.agent_options(Owner::Task(id))
    }

    /// Replaces the launch options task `id` overrides.
    pub fn set_task_agent_options(&mut self, id: TaskId, options: &AgentOptions) -> Result<()> {
        self.set_agent_options(Owner::Task(id), options)
    }

    fn agent_options(&self, owner: Owner) -> Result<AgentOptions> {
        let (table, id) = owner.table_and_id();
        let row: Option<(Option<String>, Option<String>, Option<i64>)> = self
            .conn
            .query_row(
                &format!(
                    "SELECT agent_model, agent_permission_mode, run_time_limit_minutes
                     FROM {table} WHERE id = ?1"
                ),
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (model, permission_mode, time_limit) = row.ok_or_else(|| owner.not_found())?;
        let permission_mode = permission_mode
            .map(|stored| {
                PermissionMode::ALL
                    .into_iter()
                    .find(|mode| mode.as_str() == stored)
                    .ok_or_else(|| {
                        StorageError::InvalidData(format!(
                            "{table} row {id} has an unknown agent permission mode {stored:?}"
                        ))
                    })
            })
            .transpose()?;
        let time_limit_minutes = time_limit
            .map(|minutes| {
                u32::try_from(minutes).map_err(|_| {
                    StorageError::InvalidData(format!(
                        "{table} row {id} has an invalid run time limit {minutes}"
                    ))
                })
            })
            .transpose()?;
        Ok(AgentOptions {
            model,
            permission_mode,
            time_limit_minutes,
        })
    }

    fn set_agent_options(&mut self, owner: Owner, options: &AgentOptions) -> Result<()> {
        let (table, id) = owner.table_and_id();
        let changed = self.conn.execute(
            &format!(
                "UPDATE {table}
                 SET agent_model = ?2, agent_permission_mode = ?3, run_time_limit_minutes = ?4
                 WHERE id = ?1"
            ),
            params![
                id,
                options.model,
                options.permission_mode.map(PermissionMode::as_str),
                options.time_limit_minutes
            ],
        )?;
        if changed == 0 {
            return Err(owner.not_found());
        }
        Ok(())
    }
}
