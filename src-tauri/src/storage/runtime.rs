//! Runtime records: runtime workspaces (the herdr workspaces tasks are open in), task
//! runs, their events, and runner operations.
//!
//! A run is reserved before the runner is asked to launch it, so a retried request finds
//! the same run by its request key instead of launching twice.

mod host_events;
pub use host_events::HostCursor;

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::domain::model::TaskId;
use crate::domain::runtime::{
    HostRef, OperationKind, OperationState, OwnerKey, ResumeKind, RunId, RunRole, RunState,
    RunUsage, RunnerKind, RuntimeWorkspaceId,
};

use super::{Result, Storage, StorageError, invalid_data};

/// A run to reserve with [`Storage::reserve_run`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRun {
    pub owner: OwnerKey,
    pub task: TaskId,
    /// Identifies the request that starts the run; a retry with the same key gets the
    /// same run.
    pub request_key: String,
    pub runner_kind: RunnerKind,
    pub role: RunRole,
    pub host: HostRef,
    /// `None` for a run without a checkout, e.g. in a workspace with source none.
    pub checkout_path: Option<String>,
    pub runtime_workspace: Option<RuntimeWorkspaceId>,
    pub adapter_profile: Option<String>,
    /// The agent conversation a follow-up run continues; `None` for a run that starts a
    /// new one.
    pub conversation: Option<i64>,
}

/// What a queued run starts with once a run slot of its host frees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedStart {
    /// The prompt asked for, or `None` for the task's default brief.
    pub prompt: Option<String>,
    pub mcp: bool,
}

/// A run waiting in its host's queue, with what it starts with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedRun {
    pub run: TaskRun,
    pub start: QueuedStart,
}

/// The run a request key stands for: reserved now, or reserved by an earlier request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reservation {
    New(TaskRun),
    Existing(TaskRun),
}

impl Reservation {
    pub fn run(&self) -> &TaskRun {
        match self {
            Self::New(run) | Self::Existing(run) => run,
        }
    }

    pub fn into_run(self) -> TaskRun {
        match self {
            Self::New(run) | Self::Existing(run) => run,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRun {
    pub id: RunId,
    pub owner: OwnerKey,
    pub task: TaskId,
    pub runtime_workspace: Option<RuntimeWorkspaceId>,
    pub conversation: Option<i64>,
    pub request_key: String,
    /// Increases from 1 per task.
    pub generation: i64,
    pub runner_kind: RunnerKind,
    pub role: RunRole,
    pub host: HostRef,
    pub checkout_path: Option<String>,
    pub adapter_profile: Option<String>,
    pub state: RunState,
    pub provider_run_ref: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    /// When the agent last wrote output, as far as the runner follows it.
    pub last_activity_at: Option<i64>,
    /// The tokens the agent last reported using, if it reported any.
    pub usage: Option<RunUsage>,
    /// The run of the same conversation this run follows up on: the latest earlier run
    /// that shares its conversation.
    pub follows: Option<RunId>,
    /// The agent session of the run's conversation, as the agent last reported it: what a
    /// follow-up run resumes.
    pub session: Option<String>,
}

/// Something observed about a run. `sequence` increases from 1 per run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunEvent {
    pub run: RunId,
    pub sequence: i64,
    pub generation: i64,
    pub kind: String,
    pub payload: Option<String>,
    pub observed_at: i64,
}

/// A request made to the runner for a run, and its outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOperation {
    pub id: i64,
    pub owner: OwnerKey,
    pub run: RunId,
    pub request_key: String,
    pub kind: OperationKind,
    pub state: OperationState,
    /// The provider run reference once applied, the error once failed.
    pub receipt: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The open runner workspace of a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeWorkspace {
    pub id: RuntimeWorkspaceId,
    pub owner: OwnerKey,
    pub task: TaskId,
    pub host: HostRef,
    pub runner_kind: RunnerKind,
    /// `None` until the provider instance is verified.
    pub provider_instance: Option<String>,
    pub provider_workspace_ref: String,
    pub checkout_path: Option<String>,
    pub branch: Option<String>,
    pub generation: i64,
    pub opened_at: i64,
}

const RUN_COLUMNS: &str = "id, owner_key, task_id, runtime_workspace_id, conversation_id,
    request_key, generation, runner_kind, role, host_ref, checkout_path, adapter_profile,
    state, provider_run_ref, created_at, started_at, ended_at, last_activity_at, input_tokens,
    cached_input_tokens, output_tokens,
    (SELECT p.id FROM task_runs p
     WHERE p.conversation_id = task_runs.conversation_id
       AND p.generation < task_runs.generation
     ORDER BY p.generation DESC LIMIT 1),
    (SELECT c.resume_ref FROM agent_conversations c
     WHERE c.id = task_runs.conversation_id)";

/// Reads a run selected with [`RUN_COLUMNS`]. The outer result is the row access, the
/// inner one the conversion of stored values.
fn run_from_row(row: &Row<'_>) -> rusqlite::Result<Result<TaskRun>> {
    let runner_kind: String = row.get(7)?;
    let role: String = row.get(8)?;
    let host: String = row.get(9)?;
    let state: String = row.get(12)?;
    let run = TaskRun {
        id: RunId(row.get(0)?),
        owner: OwnerKey(row.get(1)?),
        task: TaskId(row.get(2)?),
        runtime_workspace: row.get::<_, Option<i64>>(3)?.map(RuntimeWorkspaceId),
        conversation: row.get(4)?,
        request_key: row.get(5)?,
        generation: row.get(6)?,
        runner_kind: match RunnerKind::parse(&runner_kind) {
            Ok(kind) => kind,
            Err(error) => return Ok(Err(invalid_data(error))),
        },
        role: match RunRole::parse(&role) {
            Ok(role) => role,
            Err(error) => return Ok(Err(invalid_data(error))),
        },
        host: match HostRef::parse(&host) {
            Ok(host) => host,
            Err(error) => return Ok(Err(invalid_data(error))),
        },
        checkout_path: row.get(10)?,
        adapter_profile: row.get(11)?,
        state: match RunState::parse(&state) {
            Ok(state) => state,
            Err(error) => return Ok(Err(invalid_data(error))),
        },
        provider_run_ref: row.get(13)?,
        created_at: row.get(14)?,
        started_at: row.get(15)?,
        ended_at: row.get(16)?,
        last_activity_at: row.get(17)?,
        usage: match (row.get(18)?, row.get(19)?, row.get(20)?) {
            (Some(input_tokens), Some(cached_input_tokens), Some(output_tokens)) => {
                Some(RunUsage {
                    input_tokens,
                    cached_input_tokens,
                    output_tokens,
                })
            }
            _ => None,
        },
        follows: row.get::<_, Option<i64>>(21)?.map(RunId),
        session: row.get(22)?,
    };
    Ok(Ok(run))
}

fn find_run(conn: &Connection, id: RunId) -> Result<Option<TaskRun>> {
    conn.query_row(
        &format!("SELECT {RUN_COLUMNS} FROM task_runs WHERE id = ?1"),
        [id.0],
        run_from_row,
    )
    .optional()?
    .transpose()
}

fn existing_run(conn: &Connection, id: RunId) -> Result<TaskRun> {
    find_run(conn, id)?.ok_or(StorageError::RunNotFound(id))
}

fn find_run_by_key(
    conn: &Connection,
    owner: &OwnerKey,
    request_key: &str,
) -> Result<Option<TaskRun>> {
    conn.query_row(
        &format!("SELECT {RUN_COLUMNS} FROM task_runs WHERE owner_key = ?1 AND request_key = ?2"),
        params![owner.as_str(), request_key],
        run_from_row,
    )
    .optional()?
    .transpose()
}

/// Appends an event to `run` with the next sequence number and the run's generation.
fn append_event(
    conn: &Connection,
    run: &TaskRun,
    kind: &str,
    payload: Option<&str>,
    at: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO run_events (run_id, sequence, generation, kind, payload, observed_at)
         SELECT ?1, coalesce(max(sequence), 0) + 1, ?2, ?3, ?4, ?5
         FROM run_events WHERE run_id = ?1",
        params![run.id.0, run.generation, kind, payload, at],
    )?;
    Ok(())
}

fn find_launch_operation(conn: &Connection, run: RunId) -> Result<Option<RunOperation>> {
    let row = conn
        .query_row(
            "SELECT id, owner_key, run_id, request_key, kind, state, receipt, created_at,
                 updated_at
             FROM run_operations WHERE run_id = ?1 AND kind = ?2",
            params![run.0, OperationKind::Launch.as_wire()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(id, owner, run, request_key, kind, state, receipt, created_at, updated_at)| {
            Ok(RunOperation {
                id,
                owner: OwnerKey(owner),
                run: RunId(run),
                request_key,
                kind: OperationKind::parse(&kind).map_err(invalid_data)?,
                state: OperationState::parse(&state).map_err(invalid_data)?,
                receipt,
                created_at,
                updated_at,
            })
        },
    )
    .transpose()
}

/// Adds the pending launch operation of a run about to be launched.
fn insert_launch_operation(
    conn: &Connection,
    owner: &OwnerKey,
    run: RunId,
    request_key: &str,
    at: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO run_operations (owner_key, run_id, request_key, kind, state,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            owner.as_str(),
            run.0,
            request_key,
            OperationKind::Launch.as_wire(),
            OperationState::Pending.as_wire(),
            at
        ],
    )?;
    Ok(())
}

/// Settles the launch operation of `run` as `state` with `receipt`.
fn settle_launch(
    conn: &Connection,
    run: RunId,
    state: OperationState,
    receipt: &str,
    at: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE run_operations SET state = ?3, receipt = ?4, updated_at = ?5
         WHERE run_id = ?1 AND kind = ?2",
        params![
            run.0,
            OperationKind::Launch.as_wire(),
            state.as_wire(),
            receipt,
            at
        ],
    )?;
    Ok(())
}

impl Storage {
    /// Reserves a run for `new.request_key` in one transaction: the run in state
    /// `reserved`, its pending launch operation, and its `reserved` event. A run already
    /// reserved for the key is returned as it is. A writer is rejected while another
    /// writer is active on the same checkout.
    pub fn reserve_run(&mut self, new: &NewRun) -> Result<Reservation> {
        self.insert_run(new, None)
    }

    /// Queues a run for `new.request_key` like [`Self::reserve_run`] reserves one, but in
    /// state `queued`, with no launch operation yet and `start` kept for its launch. A
    /// queued writer holds its checkout as an active one does.
    pub fn queue_run(&mut self, new: &NewRun, start: &QueuedStart) -> Result<Reservation> {
        self.insert_run(new, Some(start))
    }

    fn insert_run(&mut self, new: &NewRun, queued: Option<&QueuedStart>) -> Result<Reservation> {
        let state = if queued.is_some() {
            RunState::Queued
        } else {
            RunState::Reserved
        };
        let at = self.now();
        let tx = self.conn.transaction()?;
        if let Some(run) = find_run_by_key(&tx, &new.owner, &new.request_key)? {
            return Ok(Reservation::Existing(run));
        }
        let task_exists: Option<i64> = tx
            .query_row("SELECT 1 FROM tasks WHERE id = ?1", [new.task.0], |row| {
                row.get(0)
            })
            .optional()?;
        if task_exists.is_none() {
            return Err(StorageError::TaskNotFound(new.task));
        }
        let host = new.host.as_wire();
        if let (RunRole::Writer, Some(checkout)) = (new.role, &new.checkout_path) {
            let writer: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT id, task_id FROM task_runs
                     WHERE owner_key = ?1 AND host_ref = ?2 AND checkout_path = ?3
                       AND role = 'writer'
                       AND state IN ('queued', 'reserved', 'running', 'unknown')
                     ORDER BY id
                     LIMIT 1",
                    params![new.owner.as_str(), host, checkout],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((run, task)) = writer {
                return Err(StorageError::CheckoutHasActiveWriter {
                    checkout: checkout.clone(),
                    run: RunId(run),
                    task: TaskId(task),
                });
            }
        }
        tx.execute(
            "INSERT INTO task_runs (owner_key, task_id, runtime_workspace_id, request_key,
                 generation, runner_kind, role, host_ref, checkout_path, adapter_profile, state,
                 created_at, conversation_id)
             SELECT ?1, ?2, ?3, ?4, coalesce(max(generation), 0) + 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 ?12
             FROM task_runs WHERE task_id = ?2",
            params![
                new.owner.as_str(),
                new.task.0,
                new.runtime_workspace.map(|id| id.0),
                new.request_key,
                new.runner_kind.as_wire(),
                new.role.as_wire(),
                host,
                new.checkout_path,
                new.adapter_profile,
                state.as_wire(),
                at,
                new.conversation
            ],
        )?;
        let id = RunId(tx.last_insert_rowid());
        match queued {
            None => insert_launch_operation(&tx, &new.owner, id, &new.request_key, at)?,
            Some(start) => {
                tx.execute(
                    "INSERT INTO queued_runs (run_id, prompt, mcp) VALUES (?1, ?2, ?3)",
                    params![id.0, start.prompt, start.mcp],
                )?;
            }
        }
        let run = existing_run(&tx, id)?;
        append_event(&tx, &run, state.as_wire(), None, at)?;
        tx.commit()?;
        Ok(Reservation::New(run))
    }

    /// Takes a queued run out of its queue to launch it: the run becomes `reserved` with a
    /// pending launch operation and a `reserved` event, in one transaction, so
    /// [`Self::reserve_run`] with its request key finds it reserved.
    pub fn dequeue_run(&mut self, run: RunId) -> Result<TaskRun> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let current = existing_run(&tx, run)?;
        if current.state != RunState::Queued {
            return Err(StorageError::RunTransition {
                run,
                from: current.state,
                to: RunState::Reserved,
            });
        }
        tx.execute("DELETE FROM queued_runs WHERE run_id = ?1", [run.0])?;
        tx.execute(
            "UPDATE task_runs SET state = ?2 WHERE id = ?1",
            params![run.0, RunState::Reserved.as_wire()],
        )?;
        insert_launch_operation(&tx, &current.owner, run, &current.request_key, at)?;
        append_event(&tx, &current, RunState::Reserved.as_wire(), None, at)?;
        let reserved = existing_run(&tx, run)?;
        tx.commit()?;
        Ok(reserved)
    }

    /// Every queued run, oldest first, with what it starts with.
    pub fn queued_runs(&self) -> Result<Vec<QueuedRun>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {RUN_COLUMNS}, q.prompt, q.mcp FROM task_runs
             JOIN queued_runs q ON q.run_id = task_runs.id
             WHERE task_runs.state = 'queued' ORDER BY task_runs.id"
        ))?;
        let rows = statement
            .query_map([], |row| {
                let run = run_from_row(row)?;
                let start = QueuedStart {
                    prompt: row.get(23)?,
                    mcp: row.get(24)?,
                };
                Ok(run.map(|run| QueuedRun { run, start }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().collect()
    }

    /// How many plain and tmux runs on `host` may be running: reserved, running, or
    /// unknown. These are what a host's run limit counts.
    pub fn active_runs_on_host(&self, host: &HostRef) -> Result<u32> {
        Ok(self.conn.query_row(
            "SELECT count(*) FROM task_runs
             WHERE host_ref = ?1 AND runner_kind IN ('plain', 'tmux')
               AND state IN ('reserved', 'running', 'unknown')",
            [host.as_wire()],
            |row| row.get(0),
        )?)
    }

    /// How many runs on `host` are queued.
    pub fn queued_runs_on_host(&self, host: &HostRef) -> Result<u32> {
        Ok(self.conn.query_row(
            "SELECT count(*) FROM task_runs WHERE host_ref = ?1 AND state = 'queued'",
            [host.as_wire()],
            |row| row.get(0),
        )?)
    }

    /// Where a queued run is in its host's queue, from 1 for the next to start; `None`
    /// for a run that is not queued.
    pub fn queue_position(&self, run: &TaskRun) -> Result<Option<u32>> {
        if run.state != RunState::Queued {
            return Ok(None);
        }
        Ok(Some(self.conn.query_row(
            "SELECT count(*) FROM task_runs
             WHERE host_ref = ?1 AND state = 'queued' AND id <= ?2",
            params![run.host.as_wire(), run.id.0],
            |row| row.get(0),
        )?))
    }

    /// Records that the runner launched a reserved run as `provider_run_ref`: the launch
    /// operation is applied, the run `running`, and a `launched` event appended, in one
    /// transaction. A run that is already running, or whose launch was already recorded
    /// (e.g. by a runner that settled the run before its launcher got here), is returned
    /// unchanged.
    pub fn record_launch(&mut self, run: RunId, provider_run_ref: &str) -> Result<TaskRun> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let current = existing_run(&tx, run)?;
        let launch = find_launch_operation(&tx, run)?;
        match current.state {
            RunState::Reserved => {}
            RunState::Running => return Ok(current),
            _ if launch.is_some_and(|operation| operation.state == OperationState::Applied) => {
                return Ok(current);
            }
            from => {
                return Err(StorageError::RunTransition {
                    run,
                    from,
                    to: RunState::Running,
                });
            }
        }
        settle_launch(&tx, run, OperationState::Applied, provider_run_ref, at)?;
        tx.execute(
            "UPDATE task_runs SET state = ?2, provider_run_ref = ?3, started_at = ?4
             WHERE id = ?1",
            params![run.0, RunState::Running.as_wire(), provider_run_ref, at],
        )?;
        append_event(&tx, &current, "launched", Some(provider_run_ref), at)?;
        let launched = existing_run(&tx, run)?;
        tx.commit()?;
        Ok(launched)
    }

    /// Restores observation only after a tmux runner confirmed that this session is
    /// alive. Ordinary launch recording must never revive an Unknown run.
    pub fn resume_observed_run(&mut self, run: RunId, provider_run_ref: &str) -> Result<TaskRun> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let current = existing_run(&tx, run)?;
        if current.runner_kind != RunnerKind::Tmux
            || current.state != RunState::Unknown
            || current.provider_run_ref.as_deref() != Some(provider_run_ref)
        {
            return Err(StorageError::RunTransition {
                run,
                from: current.state,
                to: RunState::Running,
            });
        }
        tx.execute(
            "UPDATE task_runs SET state = 'running', ended_at = NULL WHERE id = ?1",
            [run.0],
        )?;
        append_event(&tx, &current, "recovered", Some(provider_run_ref), at)?;
        let recovered = existing_run(&tx, run)?;
        tx.commit()?;
        Ok(recovered)
    }

    /// Records that the runner could not launch a reserved run: the launch operation and
    /// the run fail, and a `launch_failed` event carries `error`, in one transaction. A
    /// run whose launch already failed is returned unchanged.
    pub fn fail_launch(&mut self, run: RunId, error: &str) -> Result<TaskRun> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let current = existing_run(&tx, run)?;
        let launch = find_launch_operation(&tx, run)?;
        match current.state {
            RunState::Reserved => {}
            RunState::Failed
                if launch.is_some_and(|operation| operation.state == OperationState::Failed) =>
            {
                return Ok(current);
            }
            from => {
                return Err(StorageError::RunTransition {
                    run,
                    from,
                    to: RunState::Failed,
                });
            }
        }
        settle_launch(&tx, run, OperationState::Failed, error, at)?;
        tx.execute(
            "UPDATE task_runs SET state = ?2, ended_at = ?3 WHERE id = ?1",
            params![run.0, RunState::Failed.as_wire(), at],
        )?;
        append_event(&tx, &current, "launch_failed", Some(error), at)?;
        let failed = existing_run(&tx, run)?;
        tx.commit()?;
        Ok(failed)
    }

    /// Ends an active run as `state` (settled, exited, failed, cancelled, or unknown) and
    /// appends an event named after it, in one transaction. `unknown` keeps the run
    /// active without an end time. A run already in `state` is returned unchanged; a
    /// launch still pending fails with the run.
    pub fn finish_run(&mut self, run: RunId, state: RunState) -> Result<TaskRun> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let current = existing_run(&tx, run)?;
        if current.state == state && !matches!(state, RunState::Reserved | RunState::Running) {
            return Ok(current);
        }
        if matches!(
            state,
            RunState::Reserved | RunState::Running | RunState::Queued
        ) || !current.state.is_open()
            || (current.state == RunState::Queued && state == RunState::Unknown)
        {
            return Err(StorageError::RunTransition {
                run,
                from: current.state,
                to: state,
            });
        }
        tx.execute("DELETE FROM queued_runs WHERE run_id = ?1", [run.0])?;
        let ended_at = (state != RunState::Unknown).then_some(at);
        tx.execute(
            "UPDATE task_runs SET state = ?2, ended_at = ?3 WHERE id = ?1",
            params![run.0, state.as_wire(), ended_at],
        )?;
        if state != RunState::Unknown {
            tx.execute(
                "UPDATE run_operations SET state = ?3, receipt = ?4, updated_at = ?5
                 WHERE run_id = ?1 AND kind = ?2 AND state = 'pending'",
                params![
                    run.0,
                    OperationKind::Launch.as_wire(),
                    OperationState::Failed.as_wire(),
                    format!("run {}", state.as_wire()),
                    at
                ],
            )?;
        }
        append_event(&tx, &current, state.as_wire(), None, at)?;
        let finished = existing_run(&tx, run)?;
        tx.commit()?;
        Ok(finished)
    }

    /// Appends an event `kind` with `payload` to `run`, with the next sequence number and
    /// the run's generation, and returns it. The run's state is unchanged.
    pub fn append_run_event(
        &mut self,
        run: RunId,
        kind: &str,
        payload: Option<&str>,
    ) -> Result<RunEvent> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let current = existing_run(&tx, run)?;
        append_event(&tx, &current, kind, payload, at)?;
        let sequence: i64 = tx.query_row(
            "SELECT max(sequence) FROM run_events WHERE run_id = ?1",
            [run.0],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(RunEvent {
            run,
            sequence,
            generation: current.generation,
            kind: kind.to_owned(),
            payload: payload.map(str::to_owned),
            observed_at: at,
        })
    }

    /// Records that the agent of an active run wrote output now and, with `usage`, how
    /// many tokens it reported using so far. Returns whether the run was active; an ended
    /// run is left as it is.
    pub fn record_run_activity(&mut self, run: RunId, usage: Option<RunUsage>) -> Result<bool> {
        let at = self.now();
        let current = existing_run(&self.conn, run)?;
        if !current.state.is_active() {
            return Ok(false);
        }
        match usage {
            Some(usage) => self.conn.execute(
                "UPDATE task_runs SET last_activity_at = ?2, input_tokens = ?3,
                     cached_input_tokens = ?4, output_tokens = ?5
                 WHERE id = ?1",
                params![
                    run.0,
                    at,
                    usage.input_tokens,
                    usage.cached_input_tokens,
                    usage.output_tokens
                ],
            )?,
            None => self.conn.execute(
                "UPDATE task_runs SET last_activity_at = ?2 WHERE id = ?1",
                params![run.0, at],
            )?,
        };
        Ok(true)
    }

    /// Records `session`, the session id (Claude) or thread id (Codex) the agent of `run`
    /// reported, as what a follow-up run resumes: in the run's conversation, which is
    /// created for a run that has none yet.
    pub fn record_run_session(&mut self, run: RunId, session: &str) -> Result<TaskRun> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let current = existing_run(&tx, run)?;
        match current.conversation {
            Some(conversation) => {
                tx.execute(
                    "UPDATE agent_conversations SET resume_kind = ?2, resume_ref = ?3
                     WHERE id = ?1",
                    params![conversation, ResumeKind::ExactId.as_wire(), session],
                )?;
            }
            None => {
                tx.execute(
                    "INSERT INTO agent_conversations (owner_key, task_id, agent_kind, host_ref,
                         cwd, resume_kind, resume_ref, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        current.owner.as_str(),
                        current.task.0,
                        current.adapter_profile.as_deref().unwrap_or("unknown"),
                        current.host.as_wire(),
                        current.checkout_path,
                        ResumeKind::ExactId.as_wire(),
                        session,
                        at
                    ],
                )?;
                tx.execute(
                    "UPDATE task_runs SET conversation_id = ?2 WHERE id = ?1",
                    params![run.0, tx.last_insert_rowid()],
                )?;
            }
        }
        let recorded = existing_run(&tx, run)?;
        tx.commit()?;
        Ok(recorded)
    }

    pub fn get_run(&self, run: RunId) -> Result<Option<TaskRun>> {
        find_run(&self.conn, run)
    }

    /// The runs of `task`, oldest generation first.
    pub fn list_task_runs(&self, task: TaskId) -> Result<Vec<TaskRun>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM task_runs WHERE task_id = ?1 ORDER BY generation"
        ))?;
        let rows = statement
            .query_map([task.0], run_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().collect()
    }

    /// The plain and tmux runs that ended before `cutoff` (Unix seconds) and still have
    /// their files, i.e. no `kind` event records their removal; oldest first.
    pub fn runs_ended_before(&self, cutoff: i64, kind: &str) -> Result<Vec<TaskRun>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM task_runs
             WHERE runner_kind IN ('plain', 'tmux') AND ended_at IS NOT NULL AND ended_at < ?1
               AND NOT EXISTS (SELECT 1 FROM run_events
                               WHERE run_events.run_id = task_runs.id AND run_events.kind = ?2)
             ORDER BY ended_at, id"
        ))?;
        let rows = statement
            .query_map(params![cutoff, kind], run_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().collect()
    }

    /// The events of `run` in sequence order.
    pub fn run_events(&self, run: RunId) -> Result<Vec<RunEvent>> {
        let mut statement = self.conn.prepare(
            "SELECT run_id, sequence, generation, kind, payload, observed_at
             FROM run_events WHERE run_id = ?1 ORDER BY sequence",
        )?;
        let events = statement
            .query_map([run.0], |row| {
                Ok(RunEvent {
                    run: RunId(row.get(0)?),
                    sequence: row.get(1)?,
                    generation: row.get(2)?,
                    kind: row.get(3)?,
                    payload: row.get(4)?,
                    observed_at: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(events)
    }

    pub fn launch_operation(&self, run: RunId) -> Result<Option<RunOperation>> {
        find_launch_operation(&self.conn, run)
    }

    pub fn open_runtime_workspace(&self, task: TaskId) -> Result<Option<RuntimeWorkspace>> {
        let row = self
            .conn
            .query_row(
                "SELECT id, owner_key, task_id, host_ref, runner_kind, provider_instance,
                     provider_workspace_ref, checkout_path, branch, generation, opened_at
                 FROM runtime_workspaces WHERE task_id = ?1 AND state = 'open'",
                [task.0],
                |row| {
                    Ok((
                        (
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ),
                        (
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, Option<String>>(7)?,
                            row.get::<_, Option<String>>(8)?,
                            row.get::<_, i64>(9)?,
                            row.get::<_, i64>(10)?,
                        ),
                    ))
                },
            )
            .optional()?;
        row.map(
            |(
                (id, owner, task, host, runner_kind),
                (
                    provider_instance,
                    provider_workspace_ref,
                    checkout_path,
                    branch,
                    generation,
                    opened_at,
                ),
            )| {
                Ok(RuntimeWorkspace {
                    id: RuntimeWorkspaceId(id),
                    owner: OwnerKey(owner),
                    task: TaskId(task),
                    host: HostRef::parse(&host).map_err(invalid_data)?,
                    runner_kind: RunnerKind::parse(&runner_kind).map_err(invalid_data)?,
                    provider_instance,
                    provider_workspace_ref,
                    checkout_path,
                    branch,
                    generation,
                    opened_at,
                })
            },
        )
        .transpose()
    }
}

/// Records that `task` is open in the herdr workspace `handle`, or in none, at `at`, with
/// the checkout path and branch the task has now: an open runtime workspace with another
/// reference, or any with no handle, is closed; the open one with this reference takes
/// the checkout path and branch along; otherwise the next generation opens.
pub(super) fn set_herdr_workspace(
    conn: &Connection,
    task: TaskId,
    handle: Option<&str>,
    at: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE runtime_workspaces SET state = 'closed', closed_at = ?3
         WHERE task_id = ?1 AND state = 'open' AND runner_kind = 'herdr'
           AND (?2 IS NULL OR provider_workspace_ref IS NOT ?2)",
        params![task.0, handle, at],
    )?;
    let Some(handle) = handle else {
        return Ok(());
    };
    let updated = conn.execute(
        "UPDATE runtime_workspaces
         SET checkout_path = (SELECT t.worktree_path FROM tasks t WHERE t.id = ?1),
             branch = (SELECT t.branch FROM tasks t WHERE t.id = ?1)
         WHERE task_id = ?1 AND state = 'open' AND provider_workspace_ref = ?2",
        params![task.0, handle],
    )?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO runtime_workspaces (task_id, host_ref, runner_kind,
                 provider_workspace_ref, checkout_path, branch, generation, state, opened_at)
             SELECT t.id,
                 CASE w.kind WHEN 'ssh' THEN 'ssh:' || w.herdr_machine ELSE 'local' END,
                 'herdr', ?2, t.worktree_path, t.branch,
                 (SELECT coalesce(max(r.generation), 0) + 1
                  FROM runtime_workspaces r WHERE r.task_id = t.id),
                 'open', ?3
             FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
             WHERE t.id = ?1",
            params![task.0, handle, at],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::{
        CompletionMode, Runner, Source, TaskType, Workspace, WorkspaceLocation,
    };
    use crate::domain::path::PosixPath;
    use crate::storage::{NewTask, NewWorkspace};

    fn storage_with_tasks(count: usize) -> (Storage, Vec<TaskId>) {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace: Workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: PosixPath::parse("/srv/toodo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source: Source::GitHub,
                completion: CompletionMode::PullRequestMerge,
                runner: Runner::Herdr,
                axes_detected: true,
            })
            .unwrap();
        let tasks = (0..count)
            .map(|index| {
                storage
                    .create_task(&NewTask {
                        workspace_id: workspace.id,
                        task_type: TaskType::Feat,
                        title: format!("Task {index}"),
                        description: String::new(),
                        estimate: None,
                        due_date: None,
                        criteria: Vec::new(),
                    })
                    .unwrap()
                    .id
            })
            .collect();
        (storage, tasks)
    }

    fn writer(task: TaskId, key: &str, checkout: Option<&str>) -> NewRun {
        NewRun {
            owner: OwnerKey::implicit(),
            task,
            request_key: key.to_owned(),
            runner_kind: RunnerKind::Herdr,
            role: RunRole::Writer,
            host: HostRef::Local,
            checkout_path: checkout.map(str::to_owned),
            runtime_workspace: None,
            adapter_profile: None,
            conversation: None,
        }
    }

    fn run_count(storage: &Storage) -> i64 {
        storage
            .conn
            .query_row("SELECT count(*) FROM task_runs", [], |row| row.get(0))
            .unwrap()
    }

    fn event_kinds(storage: &Storage, run: RunId) -> Vec<(i64, String)> {
        storage
            .run_events(run)
            .unwrap()
            .into_iter()
            .map(|event| (event.sequence, event.kind))
            .collect()
    }

    #[test]
    fn reserving_twice_with_one_request_key_keeps_one_run() {
        let (mut storage, tasks) = storage_with_tasks(1);
        storage.set_clock(|| 100);

        let first = storage
            .reserve_run(&writer(tasks[0], "k1", Some("/wt/a")))
            .unwrap();
        let again = storage
            .reserve_run(&writer(tasks[0], "k1", Some("/wt/a")))
            .unwrap();

        let Reservation::New(run) = first else {
            panic!("the first reservation is new");
        };
        assert_eq!(again, Reservation::Existing(run.clone()));
        assert_eq!(run_count(&storage), 1);
        assert_eq!(
            (run.state, run.generation, run.created_at),
            (RunState::Reserved, 1, 100)
        );
        let launch = storage.launch_operation(run.id).unwrap().unwrap();
        assert_eq!(
            (launch.kind, launch.state, launch.request_key.as_str()),
            (OperationKind::Launch, OperationState::Pending, "k1")
        );
        assert_eq!(event_kinds(&storage, run.id), [(1, "reserved".to_owned())]);
    }

    #[test]
    fn reserving_for_a_missing_task_fails() {
        let (mut storage, _) = storage_with_tasks(0);
        assert!(matches!(
            storage.reserve_run(&writer(TaskId(9), "k", None)),
            Err(StorageError::TaskNotFound(TaskId(9)))
        ));
        assert_eq!(run_count(&storage), 0);
    }

    #[test]
    fn one_writer_is_active_per_checkout() {
        let (mut storage, tasks) = storage_with_tasks(2);
        let (a, b) = (tasks[0], tasks[1]);
        let first = storage
            .reserve_run(&writer(a, "a1", Some("/wt/c")))
            .unwrap()
            .into_run();

        let rejected = storage
            .reserve_run(&writer(b, "b1", Some("/wt/c")))
            .unwrap_err();

        match &rejected {
            StorageError::CheckoutHasActiveWriter {
                checkout,
                run,
                task,
            } => assert_eq!((checkout.as_str(), *run, *task), ("/wt/c", first.id, a)),
            other => panic!("unexpected error {other}"),
        }
        assert!(rejected.to_string().contains("observer"), "{rejected}");
        assert_eq!(run_count(&storage), 1);
        let observer = NewRun {
            role: RunRole::Observer,
            ..writer(b, "b2", Some("/wt/c"))
        };
        storage.reserve_run(&observer).unwrap();
        storage
            .reserve_run(&writer(b, "b3", Some("/wt/d")))
            .unwrap();
        let other_host = NewRun {
            host: HostRef::Ssh("devbox".to_owned()),
            ..writer(b, "b4", Some("/wt/c"))
        };
        storage.reserve_run(&other_host).unwrap();
        storage.reserve_run(&writer(b, "b5", None)).unwrap();

        storage.finish_run(first.id, RunState::Unknown).unwrap();
        assert!(matches!(
            storage.reserve_run(&writer(b, "b6", Some("/wt/c"))),
            Err(StorageError::CheckoutHasActiveWriter { .. })
        ));
        storage.finish_run(first.id, RunState::Exited).unwrap();
        let next = storage
            .reserve_run(&writer(b, "b6", Some("/wt/c")))
            .unwrap()
            .into_run();
        assert_eq!((next.task, next.generation), (b, 5));
    }

    #[test]
    fn confirmed_tmux_recovery_requires_unknown_state_and_matching_session() {
        let (mut storage, tasks) = storage_with_tasks(1);
        let mut new = writer(tasks[0], "tmux-recovery", Some("/wt/recovery"));
        new.runner_kind = RunnerKind::Tmux;
        let run = storage.reserve_run(&new).unwrap().into_run();
        let reference = format!("tmux:local:toodo-run-{}", run.id);
        let launched = storage.record_launch(run.id, &reference).unwrap();
        assert!(storage.resume_observed_run(run.id, &reference).is_err());
        storage.finish_run(run.id, RunState::Unknown).unwrap();
        assert!(
            storage
                .resume_observed_run(run.id, "different-session")
                .is_err()
        );
        let recovered = storage.resume_observed_run(run.id, &reference).unwrap();
        assert_eq!(recovered.state, RunState::Running);
        assert_eq!(recovered.started_at, launched.started_at);
        assert_eq!(recovered.ended_at, None);
        assert_eq!(
            storage.run_events(run.id).unwrap().last().unwrap().kind,
            "recovered"
        );
        storage.finish_run(run.id, RunState::Exited).unwrap();
        assert!(storage.resume_observed_run(run.id, &reference).is_err());
        new.request_key = "plain-recovery".into();
        new.runner_kind = RunnerKind::Plain;
        let run = storage.reserve_run(&new).unwrap().into_run();
        storage.record_launch(run.id, "plain").unwrap();
        storage.finish_run(run.id, RunState::Unknown).unwrap();
        assert!(storage.resume_observed_run(run.id, "plain").is_err());
    }

    #[test]
    fn recording_a_launch_runs_the_run_once() {
        let (mut storage, tasks) = storage_with_tasks(1);
        storage.set_clock(|| 100);
        let run = storage
            .reserve_run(&writer(tasks[0], "k", Some("/wt/a")))
            .unwrap()
            .into_run();
        storage.set_clock(|| 200);

        let running = storage.record_launch(run.id, "pane-1").unwrap();
        let again = storage.record_launch(run.id, "pane-2").unwrap();

        assert_eq!(
            (
                running.state,
                running.provider_run_ref.as_deref(),
                running.started_at
            ),
            (RunState::Running, Some("pane-1"), Some(200))
        );
        assert_eq!(again, running);
        let launch = storage.launch_operation(run.id).unwrap().unwrap();
        assert_eq!(
            (launch.state, launch.receipt.as_deref(), launch.updated_at),
            (OperationState::Applied, Some("pane-1"), 200)
        );
        assert_eq!(
            event_kinds(&storage, run.id),
            [(1, "reserved".to_owned()), (2, "launched".to_owned())]
        );
        assert!(
            storage
                .run_events(run.id)
                .unwrap()
                .iter()
                .all(|event| event.generation == 1)
        );

        let settled = storage.finish_run(run.id, RunState::Settled).unwrap();
        assert_eq!(
            (settled.state, settled.ended_at),
            (RunState::Settled, Some(200))
        );
        // A launcher that gets here after the run settled finds it as it is.
        assert_eq!(storage.record_launch(run.id, "pane-3").unwrap(), settled);
        assert_eq!(
            storage
                .launch_operation(run.id)
                .unwrap()
                .unwrap()
                .receipt
                .as_deref(),
            Some("pane-1")
        );
        assert!(matches!(
            storage.finish_run(run.id, RunState::Cancelled),
            Err(StorageError::RunTransition { .. })
        ));
        assert_eq!(storage.list_task_runs(tasks[0]).unwrap(), [settled]);
    }

    #[test]
    fn a_failed_launch_fails_the_run_and_its_operation() {
        let (mut storage, tasks) = storage_with_tasks(1);
        storage.set_clock(|| 300);
        let run = storage
            .reserve_run(&writer(tasks[0], "k", Some("/wt/a")))
            .unwrap()
            .into_run();

        let failed = storage.fail_launch(run.id, "herdr is not running").unwrap();

        assert_eq!(
            (failed.state, failed.ended_at),
            (RunState::Failed, Some(300))
        );
        assert_eq!(storage.fail_launch(run.id, "again").unwrap(), failed);
        let launch = storage.launch_operation(run.id).unwrap().unwrap();
        assert_eq!(
            (launch.state, launch.receipt.as_deref()),
            (OperationState::Failed, Some("herdr is not running"))
        );
        assert_eq!(
            event_kinds(&storage, run.id),
            [(1, "reserved".to_owned()), (2, "launch_failed".to_owned())]
        );
        assert!(matches!(
            storage.record_launch(run.id, "pane"),
            Err(StorageError::RunTransition { .. })
        ));
        assert!(matches!(
            storage.record_launch(RunId(99), "pane"),
            Err(StorageError::RunNotFound(RunId(99)))
        ));
        assert!(matches!(
            storage.finish_run(run.id, RunState::Running),
            Err(StorageError::RunTransition { .. })
        ));
        // The checkout is free again.
        storage
            .reserve_run(&writer(tasks[0], "k2", Some("/wt/a")))
            .unwrap();
    }

    #[test]
    fn a_launch_recorded_by_the_settling_side_is_kept_when_the_launcher_records_it() {
        let (mut storage, tasks) = storage_with_tasks(1);
        let run = storage
            .reserve_run(&writer(tasks[0], "k", Some("/wt/a")))
            .unwrap()
            .into_run();
        storage.record_launch(run.id, "pid:7").unwrap();
        let failed = storage.finish_run(run.id, RunState::Failed).unwrap();

        assert_eq!(storage.record_launch(run.id, "pid:7").unwrap(), failed);
        assert_eq!(
            event_kinds(&storage, run.id),
            [
                (1, "reserved".to_owned()),
                (2, "launched".to_owned()),
                (3, "failed".to_owned())
            ]
        );
    }

    #[test]
    fn appended_events_follow_the_run_sequence_and_leave_its_state() {
        let (mut storage, tasks) = storage_with_tasks(1);
        storage.set_clock(|| 500);
        let run = storage
            .reserve_run(&writer(tasks[0], "k", None))
            .unwrap()
            .into_run();

        let event = storage
            .append_run_event(run.id, "result", Some("done"))
            .unwrap();
        storage.append_run_event(run.id, "exit", None).unwrap();

        assert_eq!(
            event,
            RunEvent {
                run: run.id,
                sequence: 2,
                generation: 1,
                kind: "result".to_owned(),
                payload: Some("done".to_owned()),
                observed_at: 500,
            }
        );
        assert_eq!(storage.run_events(run.id).unwrap()[1], event);
        assert_eq!(
            event_kinds(&storage, run.id),
            [
                (1, "reserved".to_owned()),
                (2, "result".to_owned()),
                (3, "exit".to_owned())
            ]
        );
        assert_eq!(
            storage.get_run(run.id).unwrap().unwrap().state,
            RunState::Reserved
        );
        assert!(matches!(
            storage.append_run_event(RunId(99), "result", None),
            Err(StorageError::RunNotFound(RunId(99)))
        ));
    }

    #[test]
    fn a_follow_up_run_joins_the_conversation_of_the_run_it_resumes() {
        let (mut storage, tasks) = storage_with_tasks(1);
        let first = storage
            .reserve_run(&writer(tasks[0], "first", None))
            .unwrap()
            .into_run();
        assert_eq!((first.conversation, first.session.clone()), (None, None));

        let first = storage.record_run_session(first.id, "sess-1").unwrap();
        let conversation = first.conversation.expect("a conversation for the session");
        assert_eq!(first.session.as_deref(), Some("sess-1"));
        assert_eq!(first.follows, None);
        let unrelated = storage
            .reserve_run(&writer(tasks[0], "unrelated", None))
            .unwrap()
            .into_run();
        storage.finish_run(unrelated.id, RunState::Failed).unwrap();
        let follow_up = storage
            .reserve_run(&NewRun {
                conversation: Some(conversation),
                ..writer(tasks[0], "follow-up", None)
            })
            .unwrap()
            .into_run();
        assert_eq!(follow_up.follows, Some(first.id));
        assert_eq!(follow_up.session.as_deref(), Some("sess-1"));

        // A session the follow-up reports replaces the one the next follow-up resumes,
        // and no new conversation is made for it.
        let follow_up = storage.record_run_session(follow_up.id, "sess-2").unwrap();
        assert_eq!(follow_up.conversation, Some(conversation));
        let runs = storage.list_task_runs(tasks[0]).unwrap();
        let summary: Vec<_> = runs
            .iter()
            .map(|run| (run.id, run.follows, run.session.as_deref()))
            .collect();
        assert_eq!(
            summary,
            [
                (first.id, None, Some("sess-2")),
                (unrelated.id, None, None),
                (follow_up.id, Some(first.id), Some("sess-2")),
            ]
        );
        let conversations: i64 = storage
            .conn
            .query_row("SELECT count(*) FROM agent_conversations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(conversations, 1);
    }

    #[test]
    fn cancelling_a_reserved_run_fails_its_pending_launch() {
        let (mut storage, tasks) = storage_with_tasks(1);
        let run = storage
            .reserve_run(&writer(tasks[0], "k", None))
            .unwrap()
            .into_run();

        let cancelled = storage.finish_run(run.id, RunState::Cancelled).unwrap();

        assert_eq!(cancelled.state, RunState::Cancelled);
        assert_eq!(
            storage.launch_operation(run.id).unwrap().unwrap().state,
            OperationState::Failed
        );
        assert_eq!(
            event_kinds(&storage, run.id),
            [(1, "reserved".to_owned()), (2, "cancelled".to_owned())]
        );
    }
}
