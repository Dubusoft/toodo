//! Workspaces and per-machine settings.

use rusqlite::{OptionalExtension, Row, params};

use super::{Result, Storage, StorageError, invalid_data};
use crate::domain::model::{
    AgentMerge, CompletionMode, HostPath, Machine, MachineLabel, MachineSettings, Runner, Source,
    TaskId, Workspace, WorkspaceId, WorkspaceLocation,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWorkspace {
    pub name: String,
    pub location: WorkspaceLocation,
    pub default_base_branch: String,
    pub source: Source,
    pub completion: CompletionMode,
    pub runner: Runner,
    /// Whether `source` and `completion` are known; `false` for workspaces whose axes the
    /// server still detects from the repository (see [`Storage::workspaces_to_detect`]).
    pub axes_detected: bool,
}

const WORKSPACE_COLUMNS: &str = "id, name, kind, path, herdr_machine, default_base_branch, \
     agent_merge, source, completion, runner";

/// The value of `wire` among `values`, as a stored column of workspace `id` names it.
fn parse_axis<T: Copy>(
    id: i64,
    column: &str,
    values: &[T],
    as_str: fn(T) -> &'static str,
    wire: &str,
) -> Result<T> {
    values
        .iter()
        .copied()
        .find(|&value| as_str(value) == wire)
        .ok_or_else(|| {
            StorageError::InvalidData(format!("workspace {id} has an unknown {column} {wire:?}"))
        })
}

fn agent_merge_column(agent_merge: AgentMerge) -> &'static str {
    match agent_merge {
        AgentMerge::Never => "never",
        AgentMerge::AfterChecks => "after_checks",
    }
}

/// `(kind, path, herdr_machine)` columns of a workspace location.
fn location_columns(location: &WorkspaceLocation) -> (&'static str, &str, Option<&str>) {
    match location {
        WorkspaceLocation::Local { path } => ("local", path.as_str(), None),
        WorkspaceLocation::Ssh { machine, path } => ("ssh", path.as_str(), Some(machine.as_str())),
    }
}

/// `(kind, label)` key of a machine in `machine_settings`.
fn machine_key(machine: &Machine) -> (&'static str, &str) {
    match machine {
        Machine::Local => ("local", ""),
        Machine::Ssh(label) => ("ssh", label.as_str()),
    }
}

struct WorkspaceRow {
    id: i64,
    name: String,
    kind: String,
    path: String,
    herdr_machine: Option<String>,
    default_base_branch: String,
    agent_merge: String,
    source: String,
    completion: String,
    runner: String,
}

impl WorkspaceRow {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            kind: row.get(2)?,
            path: row.get(3)?,
            herdr_machine: row.get(4)?,
            default_base_branch: row.get(5)?,
            agent_merge: row.get(6)?,
            source: row.get(7)?,
            completion: row.get(8)?,
            runner: row.get(9)?,
        })
    }

    fn into_workspace(self) -> Result<Workspace> {
        let location = match (self.kind.as_str(), self.herdr_machine) {
            ("local", None) => WorkspaceLocation::Local {
                path: HostPath::parse_stored(&self.path).map_err(invalid_data)?,
            },
            ("ssh", Some(machine)) => WorkspaceLocation::Ssh {
                machine: MachineLabel::parse(&machine).map_err(invalid_data)?,
                path: HostPath::parse_stored(&self.path).map_err(invalid_data)?,
            },
            (kind, _) => {
                return Err(StorageError::InvalidData(format!(
                    "workspace {} has an inconsistent location of kind {kind:?}",
                    self.id
                )));
            }
        };
        let agent_merge = match self.agent_merge.as_str() {
            "never" => AgentMerge::Never,
            "after_checks" => AgentMerge::AfterChecks,
            other => {
                return Err(StorageError::InvalidData(format!(
                    "workspace {} has an unknown agent merge policy {other:?}",
                    self.id
                )));
            }
        };
        Ok(Workspace {
            id: WorkspaceId(self.id),
            name: self.name,
            location,
            default_base_branch: self.default_base_branch,
            agent_merge,
            source: parse_axis(
                self.id,
                "source",
                &Source::ALL,
                Source::as_str,
                &self.source,
            )?,
            completion: parse_axis(
                self.id,
                "completion",
                &CompletionMode::ALL,
                CompletionMode::as_str,
                &self.completion,
            )?,
            runner: parse_axis(
                self.id,
                "runner",
                &Runner::ALL,
                Runner::as_str,
                &self.runner,
            )?,
        })
    }
}

impl Storage {
    pub fn create_workspace(&mut self, new: &NewWorkspace) -> Result<Workspace> {
        let (kind, path, herdr_machine) = location_columns(&new.location);
        self.conn.execute(
            "INSERT INTO workspaces (name, kind, path, herdr_machine, default_base_branch,
                 source, completion, runner, axes_detected)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                new.name,
                kind,
                path,
                herdr_machine,
                new.default_base_branch,
                new.source.as_str(),
                new.completion.as_str(),
                new.runner.as_str(),
                new.axes_detected
            ],
        )?;
        Ok(Workspace {
            id: WorkspaceId(self.conn.last_insert_rowid()),
            name: new.name.clone(),
            location: new.location.clone(),
            default_base_branch: new.default_base_branch.clone(),
            agent_merge: AgentMerge::default(),
            source: new.source,
            completion: new.completion,
            runner: new.runner,
        })
    }

    /// Workspaces whose source and completion are not known yet, e.g. ones the schema
    /// migration could not infer from their tasks, to detect from their repository.
    pub fn workspaces_to_detect(&self) -> Result<Vec<Workspace>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE axes_detected = 0 ORDER BY id"
        ))?;
        let rows = statement
            .query_map([], WorkspaceRow::read)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(WorkspaceRow::into_workspace).collect()
    }

    /// Stores the source and completion detected for workspace `id` and marks its axes
    /// known; its runner is kept.
    pub fn save_detected_axes(
        &mut self,
        id: WorkspaceId,
        source: Source,
        completion: CompletionMode,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE workspaces SET source = ?2, completion = ?3, axes_detected = 1
             WHERE id = ?1",
            params![id.0, source.as_str(), completion.as_str()],
        )?;
        if changed == 0 {
            return Err(StorageError::WorkspaceNotFound(id));
        }
        Ok(())
    }

    pub fn get_workspace(&self, id: WorkspaceId) -> Result<Option<Workspace>> {
        self.conn
            .query_row(
                &format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1"),
                [id.0],
                WorkspaceRow::read,
            )
            .optional()?
            .map(WorkspaceRow::into_workspace)
            .transpose()
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {WORKSPACE_COLUMNS} FROM workspaces ORDER BY id"
        ))?;
        let rows = statement
            .query_map([], WorkspaceRow::read)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(WorkspaceRow::into_workspace).collect()
    }

    /// Saves the workspace; its source, completion, and runner are kept as created. Its
    /// base branch cannot change while one of its tasks is in
    /// review: the open pull request targets the current branch. A new location keeps the
    /// tasks; it is rejected while a task has a worktree path of another kind (Windows or
    /// POSIX) than the new repository path, and on another machine the tasks forget their
    /// herdr workspaces, which belong to the old machine.
    pub fn update_workspace(&mut self, workspace: &Workspace) -> Result<()> {
        let (kind, path, herdr_machine) = location_columns(&workspace.location);
        let tx = self.conn.transaction()?;
        let in_review: Option<i64> = tx
            .query_row(
                "SELECT t.id
                 FROM tasks t
                 JOIN workspaces w ON w.id = t.workspace_id
                 WHERE w.id = ?1 AND t.status = 'in_review' AND w.default_base_branch <> ?2
                 ORDER BY t.id
                 LIMIT 1",
                params![workspace.id.0, workspace.default_base_branch],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(task) = in_review {
            return Err(StorageError::BaseBranchInReview {
                workspace: workspace.id,
                task: TaskId(task),
            });
        }
        let path_style = if path.starts_with('/') {
            "posix"
        } else {
            "windows"
        };
        let other_style: Option<i64> = tx
            .query_row(
                "SELECT id FROM tasks
                 WHERE workspace_id = ?1 AND worktree_path IS NOT NULL
                   AND CASE WHEN substr(worktree_path, 1, 1) = '/' THEN 'posix' ELSE 'windows' END
                       <> ?2
                 ORDER BY id
                 LIMIT 1",
                params![workspace.id.0, path_style],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(task) = other_style {
            return Err(StorageError::WorktreePathMismatch(TaskId(task)));
        }
        tx.execute(
            "UPDATE tasks SET herdr_workspace_id = NULL
             WHERE workspace_id = ?1 AND herdr_workspace_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM workspaces w
                           WHERE w.id = ?1 AND (w.kind <> ?2 OR w.herdr_machine IS NOT ?3))",
            params![workspace.id.0, kind, herdr_machine],
        )?;
        let changed = tx.execute(
            "UPDATE workspaces
             SET name = ?2, kind = ?3, path = ?4, herdr_machine = ?5, default_base_branch = ?6,
                 agent_merge = ?7
             WHERE id = ?1",
            params![
                workspace.id.0,
                workspace.name,
                kind,
                path,
                herdr_machine,
                workspace.default_base_branch,
                agent_merge_column(workspace.agent_merge)
            ],
        )?;
        if changed == 0 {
            return Err(StorageError::WorkspaceNotFound(workspace.id));
        }
        tx.commit()?;
        Ok(())
    }

    /// Deletes a workspace together with its tasks, dependencies, and commit records.
    /// Rejected while a `planned` task of another workspace depends on one of its tasks,
    /// which would otherwise silently become ready to start; dependencies of tasks being
    /// worked on or done are dropped with the workspace.
    pub fn delete_workspace(&mut self, id: WorkspaceId) -> Result<()> {
        let tx = self.conn.transaction()?;
        let dependent: Option<(i64, i64)> = tx
            .query_row(
                "SELECT d.task_id, d.depends_on_id
                 FROM task_dependencies d
                 JOIN tasks t ON t.id = d.task_id
                 JOIN tasks p ON p.id = d.depends_on_id
                 WHERE p.workspace_id = ?1 AND t.workspace_id <> ?1
                   AND t.status = 'planned'
                 ORDER BY d.task_id, d.depends_on_id
                 LIMIT 1",
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
        let changed = tx.execute("DELETE FROM workspaces WHERE id = ?1", [id.0])?;
        if changed == 0 {
            return Err(StorageError::WorkspaceNotFound(id));
        }
        tx.commit()?;
        Ok(())
    }

    /// Settings of `machine`; a machine without saved settings has no worktree root.
    pub fn get_machine_settings(&self, machine: &Machine) -> Result<MachineSettings> {
        let (kind, label) = machine_key(machine);
        let worktree_root: Option<String> = self
            .conn
            .query_row(
                "SELECT worktree_root FROM machine_settings WHERE kind = ?1 AND label = ?2",
                [kind, label],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(match machine {
            Machine::Local => MachineSettings::Local {
                worktree_root: worktree_root
                    .map(|root| HostPath::parse_stored(&root))
                    .transpose()
                    .map_err(invalid_data)?,
            },
            Machine::Ssh(label) => MachineSettings::Ssh {
                machine: label.clone(),
                worktree_root: worktree_root
                    .map(|root| HostPath::parse_stored(&root))
                    .transpose()
                    .map_err(invalid_data)?,
            },
        })
    }

    /// SSH machines that have a row in `machine_settings`, by label.
    pub fn ssh_machines_with_settings(&self) -> Result<Vec<MachineLabel>> {
        let mut statement = self
            .conn
            .prepare("SELECT label FROM machine_settings WHERE kind = 'ssh' ORDER BY label")?;
        let labels = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        labels
            .iter()
            .map(|label| MachineLabel::parse(label).map_err(invalid_data))
            .collect()
    }

    pub fn save_machine_settings(&mut self, settings: &MachineSettings) -> Result<()> {
        let machine = settings.machine();
        let (kind, label) = machine_key(&machine);
        let worktree_root = match settings {
            MachineSettings::Local { worktree_root } => worktree_root.as_ref().map(|r| r.as_str()),
            MachineSettings::Ssh { worktree_root, .. } => {
                worktree_root.as_ref().map(|r| r.as_str())
            }
        };
        self.conn.execute(
            "INSERT INTO machine_settings (kind, label, worktree_root) VALUES (?1, ?2, ?3)
             ON CONFLICT (kind, label) DO UPDATE SET worktree_root = excluded.worktree_root",
            params![kind, label, worktree_root],
        )?;
        Ok(())
    }
}
