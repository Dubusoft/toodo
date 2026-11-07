//! Commands for the runs of tasks: starting an agent CLI for a task of a workspace with
//! runner plain or tmux, listing the runs of a task, reading the log of a run, settling a
//! run whose observation was lost, and stopping one.
//!
//! A machine may limit how many plain and tmux runs it runs at once. A run started while
//! its machine is at the limit, or while earlier runs wait for it, is queued; queued runs
//! start oldest first as runs end ([`start_queued_runs`]).

use std::collections::{BTreeSet, HashMap};
use std::fmt::Write;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use super::types::{self, AgentAdapter, MachineRuns, RunId, RunLog, TaskId, TaskRun};
use super::{CommandError, CommandResult, PlainRunState, State, StorageState, TmuxRunState, lock};
use crate::domain::model::{self, Runner};
use crate::domain::runtime::{self as domain_runtime, HostRef, OwnerKey, RunRole, RunnerKind};
use crate::domain::status::TaskStatus;
use crate::runtime::plain::adapter;
use crate::runtime::{AgentLaunch, AgentResume, RunCommand, RunLauncher, RuntimeService, StartRun};
use crate::storage::{self, StorageError};

/// How much of the end of each log `get_run_log` returns by default.
const DEFAULT_TAIL_BYTES: u32 = 64 * 1024;
/// The most of the end of each log one `get_run_log` returns.
const MAX_TAIL_BYTES: u32 = 4 * 1024 * 1024;

/// Held while deciding whether a run starts or queues, and while queued runs start, so a
/// machine never runs more runs than its limit.
static ADMISSION: Mutex<()> = Mutex::new(());

/// Set when a queued run may be able to start, e.g. after a run stopped or a limit was
/// raised; [`wait_for_queue_change`] waits for it.
static QUEUE_CHANGED: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn admission() -> MutexGuard<'static, ()> {
    ADMISSION.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Wakes [`wait_for_queue_change`].
pub(crate) fn queue_changed() {
    let (changed, wake) = &QUEUE_CHANGED;
    *changed.lock().unwrap_or_else(PoisonError::into_inner) = true;
    wake.notify_all();
}

/// Waits until [`queue_changed`] is called or `timeout` passes. Runs that end on their own
/// do not call it, so the caller starts queued runs again after each wait.
pub(crate) fn wait_for_queue_change(timeout: Duration) {
    let (changed, wake) = &QUEUE_CHANGED;
    let guard = changed.lock().unwrap_or_else(PoisonError::into_inner);
    let (mut guard, _) = wake
        .wait_timeout_while(guard, timeout, |changed| !*changed)
        .unwrap_or_else(PoisonError::into_inner);
    *guard = false;
}

/// `run` as the frontend sees it, with its place in its host's queue.
fn task_run(storage: &storage::Storage, run: &storage::TaskRun) -> CommandResult<TaskRun> {
    let mut wire = TaskRun::from(run);
    wire.queue_position = storage.queue_position(run)?;
    Ok(wire)
}

/// Starts `adapter` (an agent CLI, see `docs/runners.md`) as a writer run in the worktree of an `in_progress`
/// task of a workspace with runner plain or tmux, on the server or on the workspace's SSH
/// machine. Runner plain runs the agent as a child process (over `ssh` for an SSH
/// workspace); runner tmux runs it in a detached tmux session that `get_run_log` tells how
/// to attach to. The prompt goes to the agent on stdin; without one (or a blank one) it is
/// the task's title, description, and criteria, and with `mcp` it also tells the agent to
/// call the Toodo MCP `current_task` tool. With `mcp` the agent gets the server's MCP
/// endpoint and token in its environment only; on an SSH machine it reaches the server
/// through the machine's MCP tunnel, which must be open. With `follow_up_of`, an ended run
/// of the task, the agent resumes that run's session with `prompt` (required then)
/// instead of starting a new one, and the new run joins the run's conversation. Returns
/// the run as recorded right after the launch. The agent runs with the model, permission
/// mode, and time limit the task sets, or else its workspace (see
/// `get_task_agent_options`). While the machine runs as many runs as its limit allows (see
/// `set_machine_run_limit`), or earlier runs wait for it, the run is returned `queued`
/// with its place in the queue, and starts on its own once a run slot frees; a queued
/// follow-up then resumes the latest session of its conversation.
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn start_plain_run(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
    tmux: State<'_, TmuxRunState>,
    task_id: TaskId,
    adapter: AgentAdapter,
    prompt: Option<String>,
    mcp: bool,
    follow_up_of: Option<RunId>,
) -> CommandResult<TaskRun> {
    let request = Request {
        task: task_id.into(),
        agent: adapter,
        prompt,
        mcp,
        follow_up_of: follow_up_of.map(Into::into),
    };
    let run = start(&storage, &runs, &tmux, request)?;
    task_run(&lock(&storage), &run)
}

/// How many plain and tmux runs `machine` runs at once, and how many run or wait there.
#[specta::specta]
pub fn get_machine_runs(
    storage: State<'_, StorageState>,
    machine: types::Machine,
) -> CommandResult<MachineRuns> {
    machine_runs(&lock(&storage), machine)
}

/// Sets how many plain and tmux runs `machine` runs at once; `None` (null) for no limit.
/// Further runs wait in the machine's queue. Raising or removing the limit starts queued
/// runs right away; lowering it stops no run.
#[specta::specta]
pub fn set_machine_run_limit(
    storage: State<'_, StorageState>,
    machine: types::Machine,
    max_concurrent_runs: Option<u32>,
) -> CommandResult<MachineRuns> {
    if max_concurrent_runs == Some(0) {
        return Err(CommandError::invalid_input(
            "max_concurrent_runs must be at least 1; pass null for no limit",
        ));
    }
    let model: model::Machine = machine.clone().try_into()?;
    let runs = {
        let mut storage = lock(&storage);
        storage.set_machine_run_limit(&model, max_concurrent_runs)?;
        machine_runs(&storage, machine)?
    };
    queue_changed();
    Ok(runs)
}

fn machine_runs(storage: &storage::Storage, machine: types::Machine) -> CommandResult<MachineRuns> {
    let model: model::Machine = machine.clone().try_into()?;
    let host = HostRef::from(&model);
    Ok(MachineRuns {
        machine,
        max_concurrent_runs: storage.host_run_limit(&host)?,
        active_runs: storage.active_runs_on_host(&host)?,
        queued_runs: storage.queued_runs_on_host(&host)?,
    })
}

/// The runs of a task, oldest first.
#[specta::specta]
pub fn list_task_runs(
    storage: State<'_, StorageState>,
    task_id: TaskId,
) -> CommandResult<Vec<TaskRun>> {
    let storage = lock(&storage);
    let id = task_id.into();
    storage
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    storage
        .list_task_runs(id)?
        .iter()
        .map(|run| task_run(&storage, run))
        .collect()
}

/// The run `id`, rejected with the next step unless it is a plain or tmux run.
pub(super) fn managed_run(
    storage: &StorageState,
    id: domain_runtime::RunId,
    command: &str,
) -> CommandResult<storage::TaskRun> {
    let run = lock(storage)
        .get_run(id)?
        .ok_or(StorageError::RunNotFound(id))?;
    if !matches!(run.runner_kind, RunnerKind::Plain | RunnerKind::Tmux) {
        return Err(CommandError::rejected(format!(
            "run {id} is a {} run, and {command} handles only plain and tmux runs; manage it \
             where it runs, e.g. in its herdr pane",
            run.runner_kind
        )));
    }
    Ok(run)
}

/// A run with its events and the last `tail_bytes` (default 64 KiB, at most 4 MiB) of its
/// stdout and stderr logs, with the MCP token redacted. For an active tmux run, `attach`
/// is the shell command that opens its terminal session (a view of the run, not a way
/// to control it).
#[specta::specta]
pub fn get_run_log(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
    tmux: State<'_, TmuxRunState>,
    run_id: RunId,
    tail_bytes: Option<u32>,
) -> CommandResult<RunLog> {
    let tail = tail_bytes.unwrap_or(DEFAULT_TAIL_BYTES);
    if tail == 0 || tail > MAX_TAIL_BYTES {
        return Err(CommandError::invalid_input(format!(
            "tail_bytes must be between 1 and {MAX_TAIL_BYTES}; leave it out to get the last \
             {DEFAULT_TAIL_BYTES} bytes of each log"
        )));
    }
    let id = run_id.into();
    let (kind, events) = {
        let storage = lock(&storage);
        let run = storage.get_run(id)?.ok_or(StorageError::RunNotFound(id))?;
        (run.runner_kind, storage.run_events(id)?)
    };
    // A tmux run's host may be gone by the time its files are removed.
    let log = if events
        .iter()
        .any(|event| event.kind == super::run_logs::FILES_REMOVED)
    {
        crate::runtime::plain::RunLog {
            stdout: String::new(),
            stderr: String::new(),
        }
    } else {
        match kind {
            RunnerKind::Tmux => tmux.log(id, tail as usize)?,
            _ => runs.log(id, tail as usize)?,
        }
    };
    // Read after the log, so the state is at least as new as the output.
    let (run, wire) = {
        let storage = lock(&storage);
        let run = storage.get_run(id)?.ok_or(StorageError::RunNotFound(id))?;
        let wire = task_run(&storage, &run)?;
        (run, wire)
    };
    let attach = if kind == RunnerKind::Tmux && run.state.is_active() {
        tmux.attach_command(id)
    } else {
        None
    };
    Ok(RunLog {
        run: wire,
        events: types::map_all(&events),
        stdout: log.stdout,
        stderr: log.stderr,
        attach,
    })
}

/// Stops a plain or tmux run: a plain run's process group is terminated (killed after a
/// grace period), a tmux run's session is killed, and the run ends as `cancelled`. A
/// queued run leaves its queue as `cancelled` without starting. A run that already ended
/// is returned as it is.
#[specta::specta]
pub fn stop_run(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
    tmux: State<'_, TmuxRunState>,
    run_id: RunId,
) -> CommandResult<TaskRun> {
    let id = run_id.into();
    let run = managed_run(&storage, id, "stop_run")?;
    Ok((&stop(&storage, &runs, &tmux, &run)?).into())
}

/// Settles a plain or tmux run whose observation was lost (state `unknown`, e.g. after a
/// server restart or an SSH disconnect) from what its host recorded: its exit, a session
/// or process that still runs, or neither. It never starts the agent again. A run that is
/// observed or already ended is returned as it is.
#[specta::specta]
pub fn reconcile_run(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
    tmux: State<'_, TmuxRunState>,
    run_id: RunId,
) -> CommandResult<TaskRun> {
    let id = run_id.into();
    let run = managed_run(&storage, id, "reconcile_run")?;
    let settled = match run.runner_kind {
        RunnerKind::Tmux => tmux.reconcile(id)?,
        _ => runs.reconcile(id)?,
    };
    Ok((&settled).into())
}

fn stop(
    storage: &StorageState,
    runs: &PlainRunState,
    tmux: &TmuxRunState,
    run: &storage::TaskRun,
) -> CommandResult<storage::TaskRun> {
    if run.state == domain_runtime::RunState::Queued {
        // Held so the run cannot start between the check and the cancel.
        let _admission = admission();
        let mut storage = lock(storage);
        let current = storage
            .get_run(run.id)?
            .ok_or(StorageError::RunNotFound(run.id))?;
        if current.state == domain_runtime::RunState::Queued {
            storage.append_run_event(run.id, "stop_requested", None)?;
            let cancelled = storage.finish_run(run.id, domain_runtime::RunState::Cancelled)?;
            drop(storage);
            queue_changed();
            return Ok(cancelled);
        }
    }
    let stopped = match run.runner_kind {
        RunnerKind::Tmux => tmux.stop(run.id)?,
        _ => runs.stop(run.id)?,
    };
    queue_changed();
    Ok(stopped)
}

/// Stops the plain and tmux runs of `task` that may still have a process, and cancels its
/// queued ones, before the task is deleted or completed.
pub(crate) fn stop_live_runs(
    storage: &StorageState,
    runs: &PlainRunState,
    tmux: &TmuxRunState,
    task: model::TaskId,
) -> CommandResult<()> {
    let live: Vec<_> = lock(storage)
        .list_task_runs(task)?
        .into_iter()
        .filter(|run| {
            matches!(run.runner_kind, RunnerKind::Plain | RunnerKind::Tmux)
                && matches!(
                    run.state,
                    domain_runtime::RunState::Queued
                        | domain_runtime::RunState::Reserved
                        | domain_runtime::RunState::Running
                )
        })
        .collect();
    for run in live {
        stop(storage, runs, tmux, &run)?;
    }
    Ok(())
}

pub(crate) fn stop_live_runs_after<T>(
    result: CommandResult<T>,
    storage: &StorageState,
    runs: &PlainRunState,
    tmux: &TmuxRunState,
    task: model::TaskId,
) -> CommandResult<T> {
    if result.is_ok()
        && let Err(error) = stop_live_runs(storage, runs, tmux, task)
    {
        eprintln!(
            "could not stop plain or tmux runs for task {task}: {error:?}; stop_run is the \
             next step"
        );
    }
    result
}

/// What `start_plain_run` was asked to start.
struct Request {
    task: model::TaskId,
    agent: AgentAdapter,
    prompt: Option<String>,
    mcp: bool,
    follow_up_of: Option<domain_runtime::RunId>,
}

/// The conversation of `previous` that a follow-up run of task `id` with `agent` in
/// `worktree` on `host` resumes, rejected with the next step unless the run can be
/// resumed there.
fn follow_up(
    previous: &storage::TaskRun,
    id: model::TaskId,
    agent: adapter::AgentAdapter,
    host: &HostRef,
    worktree: &str,
) -> CommandResult<AgentResume> {
    let run = previous.id;
    if previous.task != id {
        return Err(CommandError::rejected(format!(
            "run {run} belongs to task {}, not task {id}; pass a run of task {id} as \
             follow_up_of (list_task_runs lists them)",
            previous.task
        )));
    }
    if previous.state.is_active() {
        return Err(CommandError::rejected(format!(
            "run {run} is still {}; wait for it to end, or stop it (stop_run), then start the \
             follow-up",
            previous.state
        )));
    }
    if previous.adapter_profile.as_deref() != Some(agent.as_wire()) {
        let ran = previous.adapter_profile.as_deref().unwrap_or("no agent");
        return Err(CommandError::rejected(format!(
            "run {run} ran {ran}, and a {} run cannot resume its session; start the follow-up \
             with adapter {ran}, or leave follow_up_of out to start a new session",
            agent.as_wire()
        )));
    }
    let (Some(conversation), Some(session)) = (previous.conversation, &previous.session) else {
        return Err(CommandError::rejected(format!(
            "run {run} recorded no agent session to resume, since its agent ended before \
             reporting one; leave follow_up_of out to start a new session"
        )));
    };
    if &previous.host != host || previous.checkout_path.as_deref() != Some(worktree) {
        return Err(CommandError::rejected(format!(
            "run {run} ran in {} on {}, but task {id} now works in {worktree} on {host}, \
             where the agent cannot find the session; leave follow_up_of out to start a new \
             session",
            previous.checkout_path.as_deref().unwrap_or("no worktree"),
            previous.host
        )));
    }
    // The session id goes into the agent's command line.
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':');
    if session.is_empty() || !session.chars().all(plain) {
        return Err(CommandError::rejected(format!(
            "run {run} recorded an agent session id Toodo cannot pass to the agent; leave \
             follow_up_of out to start a new session"
        )));
    }
    Ok(AgentResume {
        conversation,
        session: session.clone(),
    })
}

/// What a run of a task starts with, read and checked under one storage lock.
struct Prepared {
    task: model::Task,
    worktree: String,
    host: HostRef,
    runner: Runner,
    options: model::AgentOptions,
}

impl Prepared {
    fn runner_kind(&self) -> RunnerKind {
        match self.runner {
            Runner::Tmux => RunnerKind::Tmux,
            _ => RunnerKind::Plain,
        }
    }
}

/// Checks that task `id` can start a plain or tmux run, and reads what the run starts
/// with.
fn prepare(storage: &storage::Storage, id: model::TaskId) -> CommandResult<Prepared> {
    let task = storage
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    let workspace = storage
        .get_workspace(task.workspace_id)?
        .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
    match workspace.runner {
        Runner::Plain | Runner::Tmux => {}
        Runner::Herdr => {
            return Err(CommandError::rejected(format!(
                "task {id} belongs to workspace {:?} with runner herdr; start the task's \
                 agent in herdr (open_task_in_herdr) instead of a plain run",
                workspace.name
            )));
        }
        Runner::None => {
            return Err(CommandError::rejected(format!(
                "task {id} belongs to workspace {:?} with runner none, which runs no \
                 agents; work on it by hand, or plan it in a workspace with runner plain \
                 or tmux",
                workspace.name
            )));
        }
    }
    if task.status != TaskStatus::InProgress {
        return Err(CommandError::rejected(format!(
            "task {id} is {}; start the task first (start_task), then start a plain run",
            task.status
        )));
    }
    let worktree = task.worktree_path.as_ref().ok_or_else(|| {
        CommandError::rejected(format!(
            "task {id} has no worktree; pause the task and start it again (start_task) to \
             add its worktree, then start a plain run"
        ))
    })?;
    // The worktree path keeps its style, which tells the runner the host's OS.
    let worktree = worktree.to_string();
    let host = HostRef::from(&workspace.location.machine());
    let options = storage
        .task_agent_options(id)?
        .over(&storage.workspace_agent_options(workspace.id)?);
    Ok(Prepared {
        task,
        worktree,
        host,
        runner: workspace.runner,
        options,
    })
}

fn start(
    storage: &StorageState,
    runs: &PlainRunState,
    tmux: &TmuxRunState,
    request: Request,
) -> CommandResult<storage::TaskRun> {
    let Request {
        task: id,
        agent,
        prompt,
        mcp,
        follow_up_of,
    } = request;
    let prompt = prompt.filter(|prompt| !prompt.trim().is_empty());
    if let (Some(run), None) = (follow_up_of, &prompt) {
        return Err(CommandError::invalid_input(format!(
            "a follow-up run needs a prompt: what to tell the agent of run {run}, such as \
             review feedback; pass prompt, or leave follow_up_of out to start a new session \
             with the task's brief"
        )));
    }
    let agent = adapter::AgentAdapter::from(agent);
    let admission = admission();
    let (prepared, request_key, limited, queue, resume) = {
        let storage = lock(storage);
        let prepared = prepare(&storage, id)?;
        let generation = storage
            .list_task_runs(id)?
            .last()
            .map_or(1, |run| run.generation + 1);
        let resume = match follow_up_of {
            None => None,
            Some(run) => {
                let previous = storage
                    .get_run(run)?
                    .ok_or(StorageError::RunNotFound(run))?;
                Some(follow_up(
                    &previous,
                    id,
                    agent,
                    &prepared.host,
                    &prepared.worktree,
                )?)
            }
        };
        let prefix = match prepared.runner_kind() {
            RunnerKind::Tmux => "tmux",
            _ => "plain",
        };
        // Unique per task: the generation grows with every run of the task.
        let request_key = format!("{prefix}-{id}-{generation}");
        let limit = storage.host_run_limit(&prepared.host)?;
        let queue = match limit {
            None => false,
            Some(limit) => {
                storage.active_runs_on_host(&prepared.host)? >= limit
                    || storage.queued_runs_on_host(&prepared.host)? > 0
            }
        };
        (prepared, request_key, limit.is_some(), queue, resume)
    };
    supported(agent, mcp, resume.is_some(), &prepared.options)?;
    if queue {
        let conversation = resume.as_ref().map(|resume| resume.conversation);
        let new = new_run(&prepared, request_key, agent, conversation);
        let start = storage::QueuedStart { prompt, mcp };
        let run = lock(storage).queue_run(&new, &start)?.into_run();
        drop(admission);
        queue_changed();
        return Ok(run);
    }
    // Only a run that counts against a limit keeps others from starting while it launches.
    let admission = limited.then_some(admission);
    let launched = launch(
        storage,
        runs,
        tmux,
        prepared,
        request_key,
        agent,
        prompt,
        mcp,
        resume,
    );
    drop(admission);
    launched
}

/// Rejects a run that needs what `agent` does not support (see
/// [`adapter::AgentAdapter::capabilities`]): the Toodo MCP server, resuming a session, the
/// permission mode, or a model.
fn supported(
    agent: adapter::AgentAdapter,
    mcp: bool,
    resuming: bool,
    options: &model::AgentOptions,
) -> CommandResult<()> {
    let name = agent.as_wire();
    let can = agent.capabilities();
    if mcp && !can.mcp {
        return Err(CommandError::invalid_input(format!(
            "the {name} adapter cannot be handed the Toodo MCP server for a run; start the run \
             with mcp false, or with adapter {}",
            adapter::AgentAdapter::names_with(|can| can.mcp)
        )));
    }
    if resuming && !can.resume {
        return Err(CommandError::invalid_input(format!(
            "the {name} adapter cannot resume a session; leave follow_up_of out to start a new \
             session"
        )));
    }
    let mode = options
        .permission_mode
        .unwrap_or_else(|| agent.default_permission_mode());
    if !can.permission_modes.contains(&mode) {
        let modes: Vec<&str> = can.permission_modes.iter().map(|m| m.as_str()).collect();
        return Err(CommandError::invalid_input(format!(
            "the {name} adapter cannot run with permission mode {}; set permission_mode to {} \
             (set_task_agent_options, or set_workspace_agent_options), or start the run with \
             adapter {}",
            mode.as_str(),
            modes.join(" or "),
            adapter::AgentAdapter::names_with(|can| can.permission_modes.contains(&mode))
        )));
    }
    if options.model.is_some() && !can.model {
        return Err(CommandError::invalid_input(format!(
            "the {name} adapter cannot be given a model; clear the model of the task and its \
             workspace (set_task_agent_options, set_workspace_agent_options), or start the run \
             with adapter {}",
            adapter::AgentAdapter::names_with(|can| can.model)
        )));
    }
    Ok(())
}

/// The record of a writer run of `prepared` for `request_key`.
fn new_run(
    prepared: &Prepared,
    request_key: String,
    agent: adapter::AgentAdapter,
    conversation: Option<i64>,
) -> storage::NewRun {
    storage::NewRun {
        owner: OwnerKey::implicit(),
        task: prepared.task.id,
        request_key,
        runner_kind: prepared.runner_kind(),
        role: RunRole::Writer,
        host: prepared.host.clone(),
        checkout_path: Some(prepared.worktree.clone()),
        runtime_workspace: None,
        adapter_profile: Some(agent.as_wire().to_owned()),
        conversation,
    }
}

/// Launches the run of `prepared` for `request_key`, or adopts the run already reserved
/// for it.
#[allow(clippy::too_many_arguments)]
fn launch(
    storage: &StorageState,
    runs: &PlainRunState,
    tmux: &TmuxRunState,
    prepared: Prepared,
    request_key: String,
    agent: adapter::AgentAdapter,
    prompt: Option<String>,
    mcp: bool,
    resume: Option<AgentResume>,
) -> CommandResult<storage::TaskRun> {
    // A queued run is checked again: the task's agent options may have changed meanwhile.
    supported(agent, mcp, resume.is_some(), &prepared.options)?;
    let brief = match prompt.filter(|prompt| !prompt.trim().is_empty()) {
        Some(prompt) => prompt,
        None => default_brief(&prepared.task, &prepared.worktree, mcp),
    };
    let launcher: &dyn RunLauncher = match prepared.runner {
        Runner::Tmux => tmux,
        _ => runs,
    };
    let request = StartRun {
        owner: OwnerKey::implicit(),
        task: prepared.task.id,
        request_key,
        role: RunRole::Writer,
        host: prepared.host,
        checkout_path: Some(prepared.worktree),
        runtime_workspace: None,
        adapter_profile: Some(agent.as_wire().to_owned()),
        command: RunCommand::Agent(AgentLaunch {
            adapter: agent,
            brief,
            mcp,
            timeout_secs: prepared.options.time_limit_secs(),
            options: adapter::LaunchOptions {
                model: prepared.options.model,
                permission_mode: prepared.options.permission_mode,
            },
            resume,
        }),
    };
    Ok(RuntimeService.start_run(storage, launcher, request)?)
}

/// Starts queued runs, oldest first, while their machines run fewer runs than their
/// limits; a machine without a limit starts all of its queued runs. A queued run that can
/// no longer start, e.g. because its task was paused, fails with a `launch_failed` event
/// that says why. Returns the workspaces whose runs changed.
pub(crate) fn start_queued_runs(
    storage: &StorageState,
    runs: &PlainRunState,
    tmux: &TmuxRunState,
) -> CommandResult<BTreeSet<model::WorkspaceId>> {
    let _admission = admission();
    let queued = lock(storage).queued_runs()?;
    // The run slots left on each host seen so far; `None` for a host without a limit.
    let mut free: HashMap<HostRef, Option<u32>> = HashMap::new();
    let mut changed = BTreeSet::new();
    for queued in queued {
        let host = queued.run.host.clone();
        if !free.contains_key(&host) {
            let storage = lock(storage);
            let limit = storage.host_run_limit(&host)?;
            let active = storage.active_runs_on_host(&host)?;
            free.insert(
                host.clone(),
                limit.map(|limit| limit.saturating_sub(active)),
            );
        }
        let Some(slots) = free.get_mut(&host) else {
            continue;
        };
        if *slots == Some(0) {
            continue;
        }
        let started = match start_queued(storage, runs, tmux, &queued) {
            Ok(run) => run.state.is_active(),
            Err(error) => {
                give_up(storage, queued.run.id, &error.message);
                false
            }
        };
        if started && let Some(slots) = slots {
            *slots -= 1;
        }
        if let Some(task) = lock(storage).get_task(queued.run.task)? {
            changed.insert(task.workspace_id);
        }
    }
    Ok(changed)
}

/// Takes `queued` out of its queue and launches it as it was asked for.
fn start_queued(
    storage: &StorageState,
    runs: &PlainRunState,
    tmux: &TmuxRunState,
    queued: &storage::QueuedRun,
) -> CommandResult<storage::TaskRun> {
    let run = &queued.run;
    let agent = run
        .adapter_profile
        .as_deref()
        .and_then(|agent| adapter::AgentAdapter::parse(agent).ok())
        .ok_or_else(|| {
            CommandError::rejected(format!(
                "queued run {} names no agent Toodo knows; start a new run (start_plain_run) \
                 with adapter {}",
                run.id,
                adapter::AgentAdapter::names_with(|_| true)
            ))
        })?;
    let prepared = {
        let mut storage = lock(storage);
        let prepared = prepare(&storage, run.task)?;
        if prepared.runner_kind() != run.runner_kind
            || prepared.host != run.host
            || run.checkout_path.as_deref() != Some(prepared.worktree.as_str())
        {
            return Err(CommandError::rejected(format!(
                "the runner or worktree of task {} changed while run {} was queued; start a \
                 new run (start_plain_run)",
                run.task, run.id
            )));
        }
        storage.dequeue_run(run.id)?;
        prepared
    };
    // A queued follow-up resumes its conversation's session as it is now.
    let resume = match (run.conversation, &run.session) {
        (Some(conversation), Some(session)) => Some(AgentResume {
            conversation,
            session: session.clone(),
        }),
        _ => None,
    };
    launch(
        storage,
        runs,
        tmux,
        prepared,
        run.request_key.clone(),
        agent,
        queued.start.prompt.clone(),
        queued.start.mcp,
        resume,
    )
}

/// Fails a queued run that could not start, with a `launch_failed` event saying why. A run
/// whose launch already failed keeps its own record of it.
fn give_up(storage: &StorageState, run: domain_runtime::RunId, reason: &str) {
    let mut storage = lock(storage);
    let queued = storage
        .get_run(run)
        .ok()
        .flatten()
        .is_some_and(|run| run.state == domain_runtime::RunState::Queued);
    if !queued {
        return;
    }
    let failed = storage
        .append_run_event(run, "launch_failed", Some(reason))
        .and_then(|_| storage.finish_run(run, domain_runtime::RunState::Failed));
    if let Err(error) = failed {
        eprintln!("toodo-server: could not fail queued run {run} ({error}); stop it with stop_run");
    }
}

/// The prompt of a run started without one: the task's title, description, and criteria,
/// and with `mcp`, to read the task through the Toodo MCP server first.
fn default_brief(task: &model::Task, worktree: &str, mcp: bool) -> String {
    let mut brief = format!("# {}\n\nThis is Toodo task {}.\n", task.title, task.id);
    let description = task.description.trim();
    if !description.is_empty() {
        let _ = write!(brief, "\n## Description\n\n{description}\n");
    }
    if !task.criteria.is_empty() {
        brief.push_str("\n## Criteria\n\n");
        for criterion in &task.criteria {
            let _ = writeln!(brief, "- {}", criterion.text);
        }
    }
    if mcp {
        let _ = write!(
            brief,
            "\nBefore you start, call the `current_task` tool of the Toodo MCP server with the \
             working directory `{worktree}`, and follow the workflow it describes.\n"
        );
    }
    brief
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::*;
    use crate::adapters::git::{Git, ProcessRunner};
    use crate::adapters::herdr::Herdr;
    use crate::commands::{CommandErrorKind, tasks};
    use crate::domain::model::{CompletionMode, HostPath, Source, TaskType};
    use crate::domain::model::{MachineLabel, WorkspaceLocation};
    use crate::domain::naming::TaskCheckout;
    use crate::domain::path::PosixPath;
    use crate::runtime::plain::PlainRunner;
    use crate::runtime::tmux::TmuxRunner;
    use crate::storage::{NewRun, NewTask, NewWorkspace, Storage};

    const WAIT: Duration = Duration::from_secs(15);
    /// Runs the remote command of `ssh -o BatchMode=yes -- test-host <command>` locally,
    /// with its own directory as home, and records the arguments.
    const FAKE_SSH: &str = r#"#!/bin/sh
HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export HOME
printf '%s\n' "$@" >> "$HOME/ssh-argv"
while [ "$1" != "--" ]; do shift; done
shift
test "$1" = test-host || exit 254
shift
exec sh -c "$1"
"#;
    const RESULT: &str =
        r#"printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'"#;

    struct Fixture {
        storage: Arc<StorageState>,
        runs: PlainRunState,
        tmux: TmuxRunState,
        task: model::TaskId,
        worktree: HostPath,
        _dir: tempfile::TempDir,
    }

    /// A planned task of a local workspace with `runner`, and plain and tmux runners whose
    /// Claude and Codex CLIs are the shell script `script`.
    fn fixture(runner: Runner, script: &str) -> Fixture {
        fixture_at(runner, script, false)
    }

    /// Like [`fixture`]; with `ssh` the workspace is on the SSH machine `test-host`, which
    /// a fake `ssh` reaches by running the remote command locally with the temporary
    /// directory as its home.
    fn fixture_at(runner: Runner, script: &str, ssh: bool) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("agent");
        fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let worktree = dir.path().join("worktree");
        fs::create_dir(&worktree).unwrap();
        let mut storage = Storage::open_in_memory().unwrap();
        let path = PosixPath::parse(dir.path().to_str().unwrap()).unwrap();
        let location = if ssh {
            WorkspaceLocation::Ssh {
                machine: MachineLabel::parse("test-host").unwrap(),
                path: path.into(),
            }
        } else {
            WorkspaceLocation::Local { path: path.into() }
        };
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location,
                default_base_branch: "main".to_owned(),
                source: Source::LocalGit,
                completion: CompletionMode::LocalMerge,
                runner,
                axes_detected: true,
            })
            .unwrap();
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: "Add login".to_owned(),
                description: "Users sign in with a password.".to_owned(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap()
            .id;
        let storage = Arc::new(Mutex::new(storage));
        let ssh = dir.path().join("ssh");
        fs::write(&ssh, FAKE_SSH).unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
        let runs = PlainRunner::new(storage.clone(), dir.path().join("runs"), "0123456789ab")
            .with_programs(&program, &program)
            .with_ssh_program(&ssh);
        let tmux = TmuxRunner::new(storage.clone(), dir.path().join("runs"), "0123456789ab")
            .with_programs(&program, &program)
            .with_ssh_program(&ssh)
            .with_tmux_program(std::env::var_os("TOODO_TEST_TMUX").unwrap_or_else(|| "tmux".into()))
            .with_socket(format!(
                "toodo-test-{}",
                dir.path().file_name().unwrap().to_string_lossy()
            ));
        Fixture {
            storage,
            runs,
            tmux,
            task,
            worktree: PosixPath::parse(worktree.to_str().unwrap()).unwrap().into(),
            _dir: dir,
        }
    }

    impl Fixture {
        fn start_task(&self) {
            lock(&self.storage)
                .start_task_plain(
                    self.task,
                    &TaskCheckout {
                        path: self.worktree.clone(),
                        branch: "feat/add-login-1".to_owned(),
                    },
                )
                .unwrap();
        }

        fn run(&self, prompt: Option<&str>) -> CommandResult<TaskRun> {
            start_plain_run(
                State(&self.storage),
                State(&self.runs),
                State(&self.tmux),
                self.task.into(),
                AgentAdapter::Claude,
                prompt.map(str::to_owned),
                false,
                None,
            )
        }

        fn follow_up(
            &self,
            adapter: AgentAdapter,
            prompt: Option<&str>,
            of: &TaskRun,
        ) -> CommandResult<TaskRun> {
            start_plain_run(
                State(&self.storage),
                State(&self.runs),
                State(&self.tmux),
                self.task.into(),
                adapter,
                prompt.map(str::to_owned),
                false,
                Some(of.id),
            )
        }

        fn end(&self, run: &TaskRun) -> types::RunState {
            let ended = if run.runner_kind == "tmux" {
                self.tmux.wait_for_end(run.id.into(), WAIT)
            } else {
                self.runs.wait_for_end(run.id.into(), WAIT)
            };
            ended.map(|run| run.state.into()).expect("the run ends")
        }

        fn log(&self, run: &TaskRun) -> RunLog {
            get_run_log(
                State(&self.storage),
                State(&self.runs),
                State(&self.tmux),
                run.id,
                None,
            )
            .unwrap()
        }

        /// Whether the tmux of the tests runs; tests that need it skip without it.
        fn has_tmux(&self) -> bool {
            let program = std::env::var_os("TOODO_TEST_TMUX").unwrap_or_else(|| "tmux".into());
            let works = std::process::Command::new(program)
                .arg("-V")
                .output()
                .is_ok_and(|output| output.status.success());
            if !works {
                eprintln!(
                    "SKIP real tmux test: install tmux or set TOODO_TEST_TMUX to a working binary"
                );
            }
            works
        }
    }

    #[test]
    fn a_run_uses_the_task_options_over_the_workspace_options() {
        use crate::commands::agent_options::{set_task_agent_options, set_workspace_agent_options};
        use crate::commands::types::{AgentOptions, PermissionMode};

        let fixture = fixture(Runner::Plain, &format!("printf '%s\\n' \"$@\"\n{RESULT}"));
        fixture.start_task();
        let workspace = lock(&fixture.storage)
            .get_task(fixture.task)
            .unwrap()
            .unwrap()
            .workspace_id;
        set_workspace_agent_options(
            State(&fixture.storage),
            workspace.into(),
            AgentOptions {
                model: Some("sonnet".to_owned()),
                permission_mode: Some(PermissionMode::Edit),
                time_limit_minutes: Some(30),
            },
        )
        .unwrap();
        let options = set_task_agent_options(
            State(&fixture.storage),
            fixture.task.into(),
            AgentOptions {
                model: Some(" opus ".to_owned()),
                ..AgentOptions::default()
            },
        )
        .unwrap();
        assert_eq!(options.task.model.as_deref(), Some("opus"));
        assert_eq!(options.workspace.time_limit_minutes, Some(30));

        let run = fixture.run(None).unwrap();
        assert_eq!(fixture.end(&run), types::RunState::Settled);
        let argv = fixture.log(&run).stdout;
        assert!(
            argv.contains("--permission-mode\nacceptEdits\n--model\nopus\n"),
            "{argv}"
        );
    }

    #[test]
    fn agent_options_out_of_range_are_rejected_with_the_next_step() {
        use crate::commands::agent_options::set_task_agent_options;
        use crate::commands::types::AgentOptions;

        let fixture = fixture(Runner::Plain, RESULT);
        for options in [
            AgentOptions {
                model: Some("opus; rm -rf /".to_owned()),
                ..AgentOptions::default()
            },
            AgentOptions {
                time_limit_minutes: Some(0),
                ..AgentOptions::default()
            },
            AgentOptions {
                time_limit_minutes: Some(model::MAX_RUN_TIME_LIMIT_MINUTES + 1),
                ..AgentOptions::default()
            },
        ] {
            let error =
                set_task_agent_options(State(&fixture.storage), fixture.task.into(), options)
                    .unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::InvalidInput, "{error:?}");
        }
        let stored = lock(&fixture.storage)
            .task_agent_options(fixture.task)
            .unwrap();
        assert_eq!(stored, model::AgentOptions::default());
    }

    #[test]
    fn a_plain_run_gets_the_default_prompt_and_its_log_reads_back() {
        let fixture = fixture(
            Runner::Plain,
            &format!("IFS= read -r title\nprintf '%s\\n' \"$title\"\n{RESULT}"),
        );
        fixture.start_task();

        let first = fixture.run(None).unwrap();
        assert_eq!(first.request_key, format!("plain-{}-1", fixture.task));
        assert_eq!(first.adapter.as_deref(), Some("claude"));
        assert_eq!(first.runner_kind, "plain");
        assert_eq!(
            first.checkout_path.as_deref(),
            Some(fixture.worktree.to_string().as_str())
        );
        assert_eq!(fixture.end(&first), types::RunState::Settled);

        let log = get_run_log(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            first.id,
            None,
        )
        .unwrap();
        assert_eq!(log.run.state, types::RunState::Settled);
        assert!(log.stdout.contains("# Add login"), "{}", log.stdout);
        let kinds: Vec<_> = log.events.iter().map(|event| event.kind.as_str()).collect();
        assert_eq!(kinds, ["reserved", "launched", "result", "settled"]);

        let second = fixture.run(Some("Only fix the typo")).unwrap();
        assert_eq!(second.request_key, format!("plain-{}-2", fixture.task));
        assert_eq!(fixture.end(&second), types::RunState::Settled);
        let log = get_run_log(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            second.id,
            Some(4096),
        )
        .unwrap();
        assert_eq!(log.stdout.lines().next(), Some("Only fix the typo"));

        let listed = list_task_runs(State(&fixture.storage), fixture.task.into()).unwrap();
        let ids: Vec<_> = listed.iter().map(|run| run.id).collect();
        assert_eq!(ids, [first.id, second.id]);
        let error = get_run_log(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            first.id,
            Some(0),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }

    /// Reads the whole stdout of an ended run in pieces of at most `max` bytes.
    fn read_stdout(fixture: &Fixture, run: &TaskRun, max: usize) -> Vec<String> {
        use crate::runtime::log::LogStream;
        let source =
            super::super::run_logs::log_source(&fixture.storage, &fixture.tmux, run.id.into())
                .unwrap();
        let (mut pieces, mut offset) = (Vec::new(), 0);
        loop {
            let piece = source
                .read(
                    &fixture.runs,
                    &fixture.tmux,
                    LogStream::Stdout,
                    offset,
                    max,
                    true,
                )
                .unwrap();
            pieces.push(piece.text);
            if piece.at_end {
                return pieces;
            }
            offset = piece.next;
        }
    }

    /// Moves the clock of the storage `days` days past the end of `run`.
    fn after(fixture: &Fixture, run: &TaskRun, days: i64) {
        let ended = lock(&fixture.storage)
            .get_run(run.id.into())
            .unwrap()
            .unwrap()
            .ended_at
            .unwrap();
        lock(&fixture.storage).set_clock(move || ended + days * 24 * 60 * 60);
    }

    #[test]
    fn a_plain_log_reads_in_whole_lines_and_its_directories_go_after_the_retention_period() {
        use super::super::run_logs::{FILES_REMOVED, remove_old_run_files};
        for ssh in [false, true] {
            let fixture = fixture_at(
                Runner::Plain,
                &format!("printf 'one\\ntwo\\n'\n{RESULT}"),
                ssh,
            );
            fixture.start_task();
            let run = fixture.run(None).unwrap();
            assert_eq!(fixture.end(&run), types::RunState::Settled);

            let pieces = read_stdout(&fixture, &run, 6);
            assert_eq!(pieces[..2], ["one\n", "two\n"], "ssh {ssh}");
            assert_eq!(pieces.concat(), fixture.log(&run).stdout);

            let local = fixture._dir.path().join("runs").join(run.id.0.to_string());
            let remote = fixture
                ._dir
                .path()
                .join(format!(".toodo/runs/0123456789ab/{}", run.id.0));
            assert!(local.exists());
            assert_eq!(remote.exists(), ssh);
            after(&fixture, &run, 29);
            let removed =
                remove_old_run_files(&fixture.storage, &fixture.runs, &fixture.tmux, 30).unwrap();
            assert_eq!(removed, 0);
            after(&fixture, &run, 31);
            let removed =
                remove_old_run_files(&fixture.storage, &fixture.runs, &fixture.tmux, 30).unwrap();
            assert_eq!(removed, 1);
            assert!(!local.exists() && !remote.exists(), "ssh {ssh}");

            let log = fixture.log(&run);
            assert_eq!(log.events.last().unwrap().kind, FILES_REMOVED);
            assert_eq!((log.stdout.as_str(), log.stderr.as_str()), ("", ""));
            let removed =
                remove_old_run_files(&fixture.storage, &fixture.runs, &fixture.tmux, 30).unwrap();
            assert_eq!(removed, 0, "a run loses its files once");
        }
    }

    #[test]
    fn a_tmux_log_on_an_ssh_machine_reads_from_an_offset_and_goes_after_the_retention_period() {
        use super::super::run_logs::remove_old_run_files;
        use crate::runtime::log::LogStream;
        let fixture = fixture_at(
            Runner::Tmux,
            &format!("printf 'first line\\nsecond line\\n'\n{RESULT}"),
            true,
        );
        if !fixture.has_tmux() {
            return;
        }
        fixture.start_task();
        let run = fixture.run(None).unwrap();
        assert_eq!(fixture.end(&run), types::RunState::Settled);

        let pieces = read_stdout(&fixture, &run, 16);
        assert_eq!(pieces[..2], ["first line\n", "second line\n"]);
        let source =
            super::super::run_logs::log_source(&fixture.storage, &fixture.tmux, run.id.into())
                .unwrap();
        let size = pieces.concat().len() as u64;
        let start = source
            .tail_start(&fixture.runs, &fixture.tmux, LogStream::Stdout, size - 3)
            .unwrap();
        assert_eq!(
            start,
            "first line\n".len() as u64,
            "the tail starts at a whole line"
        );

        let remote = fixture
            ._dir
            .path()
            .join(format!(".toodo/runs/0123456789ab/{}", run.id.0));
        assert!(remote.exists());
        after(&fixture, &run, 31);
        let removed =
            remove_old_run_files(&fixture.storage, &fixture.runs, &fixture.tmux, 30).unwrap();
        assert_eq!(removed, 1);
        assert!(!remote.exists());
        assert_eq!(fixture.log(&run).stdout, "");
    }

    #[test]
    fn a_follow_up_run_resumes_the_session_of_an_ended_run_with_a_new_prompt() {
        let fixture = fixture(
            Runner::Plain,
            &format!(
                "printf 'argv:%s\\n' \"$*\"\nIFS= read -r line\nprintf 'prompt:%s\\n' \"$line\"\n\
                 printf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-1\"}}'\n\
                 {RESULT}"
            ),
        );
        fixture.start_task();
        let first = fixture.run(None).unwrap();
        assert_eq!(fixture.end(&first), types::RunState::Settled);

        for blank in [None, Some("  ")] {
            let error = fixture
                .follow_up(AgentAdapter::Claude, blank, &first)
                .unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::InvalidInput, "{error:?}");
            assert!(error.message.contains("pass prompt"), "{error:?}");
        }
        let error = fixture
            .follow_up(AgentAdapter::Codex, Some("Fix it"), &first)
            .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("adapter claude"), "{error:?}");

        let follow_up = fixture
            .follow_up(AgentAdapter::Claude, Some("Address the review"), &first)
            .unwrap();
        assert_eq!(follow_up.follow_up_of, Some(first.id));
        assert_eq!(fixture.end(&follow_up), types::RunState::Settled);
        let stdout = fixture.log(&follow_up).stdout;
        assert!(
            stdout.contains("--permission-mode bypassPermissions --resume sess-1\n"),
            "{stdout}"
        );
        assert!(stdout.contains("prompt:Address the review\n"), "{stdout}");
        let first_stdout = fixture.log(&first).stdout;
        assert!(!first_stdout.contains("--resume"), "{first_stdout}");

        let listed = list_task_runs(State(&fixture.storage), fixture.task.into()).unwrap();
        let links: Vec<_> = listed
            .iter()
            .map(|run| (run.id, run.follow_up_of, run.agent_session.as_deref()))
            .collect();
        assert_eq!(
            links,
            [
                (first.id, None, Some("sess-1")),
                (follow_up.id, Some(first.id), Some("sess-1")),
            ]
        );
    }

    #[test]
    fn a_follow_up_is_rejected_with_the_next_step_unless_the_run_can_be_resumed() {
        let fixture = fixture(
            Runner::Plain,
            &format!("test -f started && exec sleep 600\n: > started\n{RESULT}"),
        );
        fixture.start_task();
        let silent = fixture.run(None).unwrap();
        assert_eq!(fixture.end(&silent), types::RunState::Settled);
        let error = fixture
            .follow_up(AgentAdapter::Claude, Some("Fix it"), &silent)
            .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("no agent session"), "{error:?}");

        let live = fixture.run(None).unwrap();
        let error = fixture
            .follow_up(AgentAdapter::Claude, Some("Fix it"), &live)
            .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("stop_run"), "{error:?}");
        stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            live.id,
        )
        .unwrap();
        let runs = list_task_runs(State(&fixture.storage), fixture.task.into()).unwrap();
        assert_eq!(runs.len(), 2, "a rejected follow-up records no run");
    }

    #[test]
    fn a_plain_run_is_rejected_with_the_next_step_before_anything_runs() {
        let herdr = fixture(Runner::Herdr, "touch launched");
        herdr.start_task();
        let error = herdr.run(None).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("open_task_in_herdr"), "{error:?}");

        let planned = fixture(Runner::Plain, "touch launched");
        let error = planned.run(None).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("start_task"), "{error:?}");

        for fixture in [&herdr, &planned] {
            assert!(
                list_task_runs(State(&fixture.storage), fixture.task.into())
                    .unwrap()
                    .is_empty()
            );
        }
        assert!(!herdr._dir.path().join("worktree/launched").exists());
        assert!(!planned._dir.path().join("worktree/launched").exists());
    }

    #[test]
    fn stopping_a_run_cancels_it_and_deleting_its_task_stops_it_first() {
        let fixture = fixture(Runner::Plain, "exec sleep 600");
        fixture.start_task();

        let run = fixture.run(None).unwrap();
        let stopped = stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            run.id,
        )
        .unwrap();
        assert_eq!(stopped.state, types::RunState::Cancelled);
        let log = get_run_log(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            run.id,
            None,
        )
        .unwrap();
        assert!(
            log.events
                .iter()
                .any(|event| event.kind == "stop_requested"),
            "{:?}",
            log.events
        );

        let live = fixture.run(None).unwrap();
        {
            let mut storage = lock(&fixture.storage);
            storage
                .set_task_status(fixture.task, TaskStatus::Planned)
                .unwrap();
            storage.clear_task_worktree(fixture.task).unwrap();
        }
        // The task has no worktree any more, so neither git nor herdr runs.
        tasks::delete_task(
            State(&fixture.storage),
            State(&Arc::new(Git::new(Box::new(ProcessRunner)))),
            State(&Arc::new(Herdr::new(Box::new(ProcessRunner)))),
            State(&fixture.runs),
            State(&fixture.tmux),
            fixture.task.into(),
            false,
        )
        .unwrap();
        assert_eq!(fixture.end(&live), types::RunState::Cancelled);
        assert_eq!(lock(&fixture.storage).get_task(fixture.task).unwrap(), None);
    }

    #[test]
    fn completion_result_controls_stopping_live_plain_runs() {
        let fixture = fixture(Runner::Plain, "exec sleep 600");
        fixture.start_task();

        let rejected = fixture.run(None).unwrap();
        let error = CommandError::rejected("criteria are unmet; check the criterion first");
        assert!(
            stop_live_runs_after(
                Err::<(), _>(error),
                &fixture.storage,
                &fixture.runs,
                &fixture.tmux,
                fixture.task
            )
            .is_err()
        );
        assert_eq!(
            lock(&fixture.storage)
                .get_run(rejected.id.into())
                .unwrap()
                .unwrap()
                .state,
            domain_runtime::RunState::Running
        );

        assert!(
            stop_live_runs_after(
                Ok(()),
                &fixture.storage,
                &fixture.runs,
                &fixture.tmux,
                fixture.task
            )
            .is_ok()
        );
        assert_eq!(fixture.end(&rejected), types::RunState::Cancelled);
    }

    #[test]
    fn a_tmux_workspace_runs_its_agent_in_a_tmux_session() {
        let fixture = fixture(
            Runner::Tmux,
            &format!("test -f started && exec sleep 600\n: > started\n{RESULT}"),
        );
        if !fixture.has_tmux() {
            return;
        }
        fixture.start_task();

        let first = fixture.run(None).unwrap();
        assert_eq!(first.runner_kind, "tmux");
        assert_eq!(first.request_key, format!("tmux-{}-1", fixture.task));
        assert_eq!(
            first.provider_run_ref,
            Some(format!("tmux:local:toodo-0123456789ab-run-{}", first.id.0))
        );
        assert_eq!(fixture.end(&first), types::RunState::Settled);
        let log = fixture.log(&first);
        assert!(log.stdout.contains(r#""result":"done""#), "{}", log.stdout);
        assert_eq!(log.attach, None, "an ended run has no session to attach to");

        let live = fixture.run(None).unwrap();
        assert_eq!(live.request_key, format!("tmux-{}-2", fixture.task));
        let attach = fixture.log(&live).attach.expect("an active tmux run");
        assert!(
            attach.contains("attach -t")
                && attach.contains(&format!("toodo-0123456789ab-run-{}", live.id.0)),
            "{attach}"
        );
        let reconciled = reconcile_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            live.id,
        )
        .unwrap();
        assert_eq!(reconciled.state, types::RunState::Running);
        let stopped = stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            live.id,
        )
        .unwrap();
        assert_eq!(stopped.state, types::RunState::Cancelled);
    }

    #[test]
    fn a_plain_run_of_an_ssh_workspace_runs_over_ssh() {
        let fixture = fixture_at(
            Runner::Plain,
            &format!("IFS= read -r title\nprintf '%s\\n' \"$title\"\n{RESULT}"),
            true,
        );
        fixture.start_task();

        let run = fixture.run(None).unwrap();
        assert_eq!(run.runner_kind, "plain");
        assert_eq!(
            lock(&fixture.storage)
                .get_run(run.id.into())
                .unwrap()
                .unwrap()
                .host,
            HostRef::Ssh("test-host".to_owned())
        );
        assert_eq!(
            run.provider_run_ref,
            Some(format!("ssh:test-host:{}", run.id.0))
        );
        assert_eq!(fixture.end(&run), types::RunState::Settled);
        let log = fixture.log(&run);
        assert!(log.stdout.contains("# Add login"), "{}", log.stdout);
        assert_eq!(log.attach, None);
        let argv = fs::read_to_string(fixture._dir.path().join("ssh-argv")).unwrap();
        assert!(
            argv.contains("test-host") && argv.contains("setsid --wait"),
            "{argv}"
        );
        let reconciled = reconcile_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            run.id,
        )
        .unwrap();
        assert_eq!(reconciled.state, types::RunState::Settled);
    }

    #[test]
    fn an_ssh_herdr_workspace_still_starts_its_agents_in_herdr() {
        let fixture = fixture_at(Runner::Herdr, "touch launched", true);
        fixture.start_task();
        let error = fixture.run(None).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("open_task_in_herdr"), "{error:?}");
        assert!(!fixture._dir.path().join("ssh-argv").exists());
        assert!(
            list_task_runs(State(&fixture.storage), fixture.task.into())
                .unwrap()
                .is_empty()
        );
    }

    /// A second in-progress task of the fixture's workspace, in its own worktree.
    fn second_task(fixture: &Fixture) -> model::TaskId {
        let worktree = fixture._dir.path().join("worktree-2");
        fs::create_dir(&worktree).unwrap();
        let mut storage = lock(&fixture.storage);
        let workspace = storage
            .get_task(fixture.task)
            .unwrap()
            .unwrap()
            .workspace_id;
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace,
                task_type: TaskType::Feat,
                title: "Add logout".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap()
            .id;
        storage
            .start_task_plain(
                task,
                &TaskCheckout {
                    path: PosixPath::parse(worktree.to_str().unwrap()).unwrap().into(),
                    branch: "feat/add-logout-2".to_owned(),
                },
            )
            .unwrap();
        task
    }

    fn run_of(fixture: &Fixture, task: model::TaskId) -> TaskRun {
        start_plain_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            task.into(),
            AgentAdapter::Claude,
            None,
            false,
            None,
        )
        .unwrap()
    }

    fn state_of(fixture: &Fixture, run: &TaskRun) -> domain_runtime::RunState {
        lock(&fixture.storage)
            .get_run(run.id.into())
            .unwrap()
            .unwrap()
            .state
    }

    #[test]
    fn runs_beyond_the_machine_limit_queue_and_start_when_a_slot_frees() {
        let fixture = fixture(Runner::Plain, "exec sleep 600");
        fixture.start_task();
        let other = second_task(&fixture);
        let limited =
            set_machine_run_limit(State(&fixture.storage), types::Machine::Local, Some(1)).unwrap();
        assert_eq!(limited.max_concurrent_runs, Some(1));

        let first = run_of(&fixture, fixture.task);
        assert_eq!(first.state, types::RunState::Running);
        let queued = run_of(&fixture, other);
        assert_eq!(queued.state, types::RunState::Queued);
        assert_eq!(queued.queue_position, Some(1));
        assert!(
            !fixture
                ._dir
                .path()
                .join("runs")
                .join(queued.id.0.to_string())
                .exists()
        );
        let runs = get_machine_runs(State(&fixture.storage), types::Machine::Local).unwrap();
        assert_eq!((runs.active_runs, runs.queued_runs), (1, 1));

        // The machine is full, so a pass over the queue starts nothing.
        start_queued_runs(&fixture.storage, &fixture.runs, &fixture.tmux).unwrap();
        assert_eq!(
            state_of(&fixture, &queued),
            domain_runtime::RunState::Queued
        );

        stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            first.id,
        )
        .unwrap();
        let changed = start_queued_runs(&fixture.storage, &fixture.runs, &fixture.tmux).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(
            state_of(&fixture, &queued),
            domain_runtime::RunState::Running
        );
        let kinds: Vec<_> = fixture
            .log(&queued)
            .events
            .into_iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(kinds, ["queued", "reserved", "launched"]);

        let stopped = stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            queued.id,
        )
        .unwrap();
        assert_eq!(stopped.state, types::RunState::Cancelled);
    }

    #[test]
    fn a_queued_follow_up_resumes_the_session_once_a_slot_frees() {
        let fixture = fixture(
            Runner::Plain,
            &format!(
                "case \"$PWD\" in */worktree-2) exec sleep 600;; esac\n\
                 printf 'argv:%s\\n' \"$*\"\n\
                 printf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-1\"}}'\n\
                 {RESULT}"
            ),
        );
        fixture.start_task();
        let first = fixture.run(None).unwrap();
        assert_eq!(fixture.end(&first), types::RunState::Settled);
        let other = second_task(&fixture);
        set_machine_run_limit(State(&fixture.storage), types::Machine::Local, Some(1)).unwrap();
        let holder = run_of(&fixture, other);
        assert_eq!(holder.state, types::RunState::Running);

        let follow_up = fixture
            .follow_up(AgentAdapter::Claude, Some("Address the review"), &first)
            .unwrap();
        assert_eq!(follow_up.state, types::RunState::Queued);
        assert_eq!(follow_up.follow_up_of, Some(first.id));

        stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            holder.id,
        )
        .unwrap();
        start_queued_runs(&fixture.storage, &fixture.runs, &fixture.tmux).unwrap();
        assert_eq!(fixture.end(&follow_up), types::RunState::Settled);
        let stdout = fixture.log(&follow_up).stdout;
        assert!(stdout.contains("--resume sess-1\n"), "{stdout}");
    }

    #[test]
    fn a_stopped_queued_run_never_starts_and_a_zero_limit_is_rejected() {
        let fixture = fixture(Runner::Plain, "exec sleep 600");
        fixture.start_task();
        let other = second_task(&fixture);
        let error = set_machine_run_limit(State(&fixture.storage), types::Machine::Local, Some(0))
            .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(error.message.contains("null for no limit"), "{error:?}");
        set_machine_run_limit(State(&fixture.storage), types::Machine::Local, Some(1)).unwrap();

        let first = run_of(&fixture, fixture.task);
        let queued = run_of(&fixture, other);
        let cancelled = stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            queued.id,
        )
        .unwrap();
        assert_eq!(cancelled.state, types::RunState::Cancelled);
        stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            first.id,
        )
        .unwrap();
        start_queued_runs(&fixture.storage, &fixture.runs, &fixture.tmux).unwrap();
        assert_eq!(
            state_of(&fixture, &queued),
            domain_runtime::RunState::Cancelled
        );
        assert!(
            !fixture
                ._dir
                .path()
                .join("runs")
                .join(queued.id.0.to_string())
                .exists()
        );

        // Without a limit, runs start at once again.
        set_machine_run_limit(State(&fixture.storage), types::Machine::Local, None).unwrap();
        let unlimited = run_of(&fixture, other);
        assert_eq!(unlimited.state, types::RunState::Running);
        stop_live_runs(&fixture.storage, &fixture.runs, &fixture.tmux, other).unwrap();
    }

    #[test]
    fn a_queued_run_of_a_paused_task_fails_with_the_reason() {
        let fixture = fixture(Runner::Plain, "exec sleep 600");
        fixture.start_task();
        let other = second_task(&fixture);
        set_machine_run_limit(State(&fixture.storage), types::Machine::Local, Some(1)).unwrap();
        let first = run_of(&fixture, fixture.task);
        let queued = run_of(&fixture, other);
        lock(&fixture.storage)
            .set_task_status(other, TaskStatus::Planned)
            .unwrap();
        stop_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            first.id,
        )
        .unwrap();
        start_queued_runs(&fixture.storage, &fixture.runs, &fixture.tmux).unwrap();
        assert_eq!(
            state_of(&fixture, &queued),
            domain_runtime::RunState::Failed
        );
        let log = fixture.log(&queued);
        let failure = log
            .events
            .iter()
            .find(|event| event.kind == "launch_failed")
            .expect("a launch_failed event");
        assert!(
            failure.payload.as_deref().unwrap().contains("start_task"),
            "{failure:?}"
        );
    }

    #[test]
    fn reconciling_a_herdr_run_is_rejected_with_the_next_step() {
        let fixture = fixture(Runner::Herdr, "touch launched");
        let run = lock(&fixture.storage)
            .reserve_run(&NewRun {
                owner: OwnerKey::implicit(),
                task: fixture.task,
                request_key: "herdr".to_owned(),
                runner_kind: RunnerKind::Herdr,
                role: RunRole::Writer,
                host: HostRef::Local,
                checkout_path: None,
                runtime_workspace: None,
                adapter_profile: None,
                conversation: None,
            })
            .unwrap()
            .into_run();
        let error = reconcile_run(
            State(&fixture.storage),
            State(&fixture.runs),
            State(&fixture.tmux),
            run.id.into(),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("herdr pane"), "{error:?}");
        assert!(error.message.contains("reconcile_run"), "{error:?}");
    }

    #[test]
    fn a_run_needing_what_its_agent_lacks_is_rejected_with_the_next_step() {
        use adapter::AgentAdapter::{Claude, Gemini, Omo, OpenCode, Pi};
        let none = model::AgentOptions::default();
        let with = |model: Option<&str>, mode: Option<model::PermissionMode>| model::AgentOptions {
            model: model.map(str::to_owned),
            permission_mode: mode,
            time_limit_minutes: None,
        };
        assert!(supported(Claude, true, true, &none).is_ok());
        assert!(supported(OpenCode, true, true, &none).is_ok());
        assert!(supported(Pi, false, true, &with(Some("openai/gpt-5"), None)).is_ok());

        let mcp = supported(Pi, true, false, &none).unwrap_err();
        assert_eq!(mcp.kind, CommandErrorKind::InvalidInput);
        assert!(mcp.message.contains("mcp false"), "{mcp:?}");
        assert!(
            mcp.message.contains("claude, codex, or opencode"),
            "{mcp:?}"
        );
        assert!(supported(Gemini, true, false, &none).is_err());

        let edit = supported(
            Pi,
            false,
            false,
            &with(None, Some(model::PermissionMode::Edit)),
        )
        .unwrap_err();
        assert!(edit.message.contains("read_only or bypass"), "{edit:?}");
        assert!(edit.message.contains("set_task_agent_options"), "{edit:?}");

        let model = supported(Omo, false, false, &with(Some("sonnet"), None)).unwrap_err();
        assert!(model.message.contains("clear the model"), "{model:?}");
        assert!(supported(Omo, false, true, &none).is_ok());
    }
}
