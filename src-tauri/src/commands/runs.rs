//! Commands for the runs of tasks: starting an agent CLI for a task of a workspace with
//! runner plain, listing the runs of a task, reading the log of a run, and stopping one.

use std::fmt::Write;

use super::types::{self, AgentAdapter, RunId, RunLog, TaskId, TaskRun};
use super::{CommandError, CommandResult, PlainRunState, State, StorageState, lock};
use crate::domain::model::{self, Runner, WorkspaceLocation};
use crate::domain::runtime::{self as domain_runtime, HostRef, OwnerKey, RunRole, RunnerKind};
use crate::domain::status::TaskStatus;
use crate::runtime::plain::adapter;
use crate::runtime::{AgentLaunch, RunCommand, RuntimeService, StartRun};
use crate::storage::{self, StorageError};

/// How long a plain run may take before it is stopped and fails.
const RUN_TIMEOUT_SECS: u64 = 4 * 60 * 60;
/// How much of the end of each log `get_run_log` returns by default.
const DEFAULT_TAIL_BYTES: u32 = 64 * 1024;
/// The most of the end of each log one `get_run_log` returns.
const MAX_TAIL_BYTES: u32 = 4 * 1024 * 1024;

/// Starts `adapter` (Claude or Codex) as a writer run in the worktree of an `in_progress`
/// task of a local workspace with runner plain. The prompt goes to the agent on stdin;
/// without one (or a blank one) it is the task's title, description, and criteria, and
/// with `mcp` it also tells the agent to call the Toodo MCP `current_task` tool. With
/// `mcp` the agent gets the server's MCP endpoint and token in its environment only.
/// Returns the run as recorded right after the launch.
#[specta::specta]
pub fn start_plain_run(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
    task_id: TaskId,
    adapter: AgentAdapter,
    prompt: Option<String>,
    mcp: bool,
) -> CommandResult<TaskRun> {
    Ok((&start(&storage, &runs, task_id.into(), adapter, prompt, mcp)?).into())
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
    Ok(types::map_all(&storage.list_task_runs(id)?))
}

/// A run with its events and the last `tail_bytes` (default 64 KiB, at most 4 MiB) of its
/// stdout and stderr logs, with the MCP token redacted.
#[specta::specta]
pub fn get_run_log(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
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
    let events = {
        let storage = lock(&storage);
        storage.get_run(id)?.ok_or(StorageError::RunNotFound(id))?;
        storage.run_events(id)?
    };
    let log = runs.log(id, tail as usize)?;
    // Read after the log, so the state is at least as new as the output.
    let run = lock(&storage)
        .get_run(id)?
        .ok_or(StorageError::RunNotFound(id))?;
    Ok(RunLog {
        run: (&run).into(),
        events: types::map_all(&events),
        stdout: log.stdout,
        stderr: log.stderr,
    })
}

/// Stops a plain run: its process group is terminated (killed after a grace period) and
/// the run ends as `cancelled`. A run that already ended is returned as it is.
#[specta::specta]
pub fn stop_run(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
    run_id: RunId,
) -> CommandResult<TaskRun> {
    let id = run_id.into();
    let run = lock(&storage)
        .get_run(id)?
        .ok_or(StorageError::RunNotFound(id))?;
    if run.runner_kind != RunnerKind::Plain {
        return Err(CommandError::rejected(format!(
            "run {id} is a {} run, and stop_run stops only plain runs; stop it where it runs, \
             e.g. in its herdr pane",
            run.runner_kind
        )));
    }
    Ok((&runs.stop(id)?).into())
}

/// Stops the plain runs of `task` that may still have a process, before the task is
/// deleted or completed.
pub(crate) fn stop_live_runs(
    storage: &StorageState,
    runs: &PlainRunState,
    task: model::TaskId,
) -> CommandResult<()> {
    let live: Vec<_> = lock(storage)
        .list_task_runs(task)?
        .into_iter()
        .filter(|run| {
            run.runner_kind == RunnerKind::Plain
                && matches!(
                    run.state,
                    domain_runtime::RunState::Reserved | domain_runtime::RunState::Running
                )
        })
        .map(|run| run.id)
        .collect();
    for run in live {
        runs.stop(run)?;
    }
    Ok(())
}

pub(crate) fn stop_live_runs_after<T>(
    result: CommandResult<T>,
    storage: &StorageState,
    runs: &PlainRunState,
    task: model::TaskId,
) -> CommandResult<T> {
    if result.is_ok()
        && let Err(error) = stop_live_runs(storage, runs, task)
    {
        eprintln!(
            "could not stop plain runs for task {task}: {error:?}; stop_run is the next step"
        );
    }
    result
}

fn start(
    storage: &StorageState,
    runs: &PlainRunState,
    id: model::TaskId,
    agent: AgentAdapter,
    prompt: Option<String>,
    mcp: bool,
) -> CommandResult<storage::TaskRun> {
    let (task, worktree, generation) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        match workspace.runner {
            Runner::Plain => {}
            Runner::Tmux => {
                return Err(CommandError::rejected(
                    "runner tmux launch is not wired yet, and a workspace keeps the runner \
                     it was created with; delete this workspace, add the repository again \
                     at a local path with runner plain, then start a plain run",
                ));
            }
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
                     agents; work on it by hand, or plan it in a local workspace with runner \
                     plain",
                    workspace.name
                )));
            }
        }
        if !matches!(workspace.location, WorkspaceLocation::Local { .. }) {
            return Err(CommandError::rejected(format!(
                "workspace {:?} of task {id} is on an SSH machine, and plain runs run only on \
                 the server; move the workspace to a local path, or use runner herdr",
                workspace.name
            )));
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
        let generation = storage
            .list_task_runs(id)?
            .last()
            .map_or(1, |run| run.generation + 1);
        let worktree = worktree.to_string();
        (task, worktree, generation)
    };
    let brief = match prompt.filter(|prompt| !prompt.trim().is_empty()) {
        Some(prompt) => prompt,
        None => default_brief(&task, &worktree, mcp),
    };
    let agent = adapter::AgentAdapter::from(agent);
    let request = StartRun {
        owner: OwnerKey::implicit(),
        task: id,
        request_key: format!("plain-{id}-{generation}"),
        role: RunRole::Writer,
        host: HostRef::Local,
        checkout_path: Some(worktree),
        runtime_workspace: None,
        adapter_profile: Some(agent.as_wire().to_owned()),
        command: RunCommand::Agent(AgentLaunch {
            adapter: agent,
            brief,
            mcp,
            timeout_secs: RUN_TIMEOUT_SECS,
        }),
    };
    Ok(RuntimeService.start_run(storage, runs, request)?)
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
    use crate::domain::naming::TaskCheckout;
    use crate::domain::path::PosixPath;
    use crate::runtime::plain::PlainRunner;
    use crate::storage::{NewTask, NewWorkspace, Storage};

    const WAIT: Duration = Duration::from_secs(15);
    const RESULT: &str =
        r#"printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'"#;

    struct Fixture {
        storage: Arc<StorageState>,
        runs: PlainRunState,
        task: model::TaskId,
        worktree: HostPath,
        _dir: tempfile::TempDir,
    }

    /// A planned task of a local workspace with `runner`, and a plain runner whose Claude
    /// and Codex CLIs are the shell script `script`.
    fn fixture(runner: Runner, script: &str) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("agent");
        fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let worktree = dir.path().join("worktree");
        fs::create_dir(&worktree).unwrap();
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: PosixPath::parse(dir.path().to_str().unwrap())
                        .unwrap()
                        .into(),
                },
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
        let runs = PlainRunner::new(storage.clone(), dir.path().join("runs"))
            .with_programs(&program, &program);
        Fixture {
            storage,
            runs,
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
                self.task.into(),
                AgentAdapter::Claude,
                prompt.map(str::to_owned),
                false,
            )
        }

        fn end(&self, run: &TaskRun) -> types::RunState {
            self.runs
                .wait_for_end(run.id.into(), WAIT)
                .map(|run| run.state.into())
                .expect("the run ends")
        }
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
            first.id,
            Some(0),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
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
        let stopped = stop_run(State(&fixture.storage), State(&fixture.runs), run.id).unwrap();
        assert_eq!(stopped.state, types::RunState::Cancelled);
        let log = get_run_log(State(&fixture.storage), State(&fixture.runs), run.id, None).unwrap();
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
            stop_live_runs_after(Ok(()), &fixture.storage, &fixture.runs, fixture.task).is_ok()
        );
        assert_eq!(fixture.end(&rejected), types::RunState::Cancelled);
    }
}
