//! Commands for the runs of tasks: starting an agent CLI for a task of a workspace with
//! runner plain or tmux, listing the runs of a task, reading the log of a run, settling a
//! run whose observation was lost, and stopping one.

use std::fmt::Write;

use super::types::{self, AgentAdapter, RunId, RunLog, TaskId, TaskRun};
use super::{CommandError, CommandResult, PlainRunState, State, StorageState, TmuxRunState, lock};
use crate::domain::model::{self, Runner};
use crate::domain::runtime::{self as domain_runtime, HostRef, OwnerKey, RunRole, RunnerKind};
use crate::domain::status::TaskStatus;
use crate::runtime::plain::adapter;
use crate::runtime::{AgentLaunch, RunCommand, RunLauncher, RuntimeService, StartRun};
use crate::storage::{self, StorageError};

/// How much of the end of each log `get_run_log` returns by default.
const DEFAULT_TAIL_BYTES: u32 = 64 * 1024;
/// The most of the end of each log one `get_run_log` returns.
const MAX_TAIL_BYTES: u32 = 4 * 1024 * 1024;

/// Starts `adapter` (Claude or Codex) as a writer run in the worktree of an `in_progress`
/// task of a workspace with runner plain or tmux, on the server or on the workspace's SSH
/// machine. Runner plain runs the agent as a child process (over `ssh` for an SSH
/// workspace); runner tmux runs it in a detached tmux session that `get_run_log` tells how
/// to attach to. The prompt goes to the agent on stdin; without one (or a blank one) it is
/// the task's title, description, and criteria, and with `mcp` it also tells the agent to
/// call the Toodo MCP `current_task` tool. With `mcp` the agent gets the server's MCP
/// endpoint and token in its environment only; on an SSH machine it reaches the server
/// through the machine's MCP tunnel, which must be open. Returns the run as recorded right
/// after the launch. The agent runs with the model, permission mode, and time limit the
/// task sets, or else its workspace (see `get_task_agent_options`).
#[specta::specta]
pub fn start_plain_run(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
    tmux: State<'_, TmuxRunState>,
    task_id: TaskId,
    adapter: AgentAdapter,
    prompt: Option<String>,
    mcp: bool,
) -> CommandResult<TaskRun> {
    Ok((&start(&storage, &runs, &tmux, task_id.into(), adapter, prompt, mcp)?).into())
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

/// The run `id`, rejected with the next step unless it is a plain or tmux run.
fn managed_run(
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
    let log = match kind {
        RunnerKind::Tmux => tmux.log(id, tail as usize)?,
        _ => runs.log(id, tail as usize)?,
    };
    // Read after the log, so the state is at least as new as the output.
    let run = lock(&storage)
        .get_run(id)?
        .ok_or(StorageError::RunNotFound(id))?;
    let attach = if kind == RunnerKind::Tmux && run.state.is_active() {
        tmux.attach_command(id)
    } else {
        None
    };
    Ok(RunLog {
        run: (&run).into(),
        events: types::map_all(&events),
        stdout: log.stdout,
        stderr: log.stderr,
        attach,
    })
}

/// Stops a plain or tmux run: a plain run's process group is terminated (killed after a
/// grace period), a tmux run's session is killed, and the run ends as `cancelled`. A run
/// that already ended is returned as it is.
#[specta::specta]
pub fn stop_run(
    storage: State<'_, StorageState>,
    runs: State<'_, PlainRunState>,
    tmux: State<'_, TmuxRunState>,
    run_id: RunId,
) -> CommandResult<TaskRun> {
    let id = run_id.into();
    let run = managed_run(&storage, id, "stop_run")?;
    Ok((&stop(&runs, &tmux, &run)?).into())
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
    runs: &PlainRunState,
    tmux: &TmuxRunState,
    run: &storage::TaskRun,
) -> CommandResult<storage::TaskRun> {
    Ok(match run.runner_kind {
        RunnerKind::Tmux => tmux.stop(run.id)?,
        _ => runs.stop(run.id)?,
    })
}

/// Stops the plain and tmux runs of `task` that may still have a process, before the task
/// is deleted or completed.
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
                    domain_runtime::RunState::Reserved | domain_runtime::RunState::Running
                )
        })
        .collect();
    for run in live {
        stop(runs, tmux, &run)?;
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

fn start(
    storage: &StorageState,
    runs: &PlainRunState,
    tmux: &TmuxRunState,
    id: model::TaskId,
    agent: AgentAdapter,
    prompt: Option<String>,
    mcp: bool,
) -> CommandResult<storage::TaskRun> {
    let (task, worktree, generation, host, runner, options) = {
        let storage = lock(storage);
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
        let generation = storage
            .list_task_runs(id)?
            .last()
            .map_or(1, |run| run.generation + 1);
        // The worktree path keeps its style, which tells the runner the host's OS.
        let worktree = worktree.to_string();
        let host = HostRef::from(&workspace.location.machine());
        let options = storage
            .task_agent_options(id)?
            .over(&storage.workspace_agent_options(workspace.id)?);
        (task, worktree, generation, host, workspace.runner, options)
    };
    let brief = match prompt.filter(|prompt| !prompt.trim().is_empty()) {
        Some(prompt) => prompt,
        None => default_brief(&task, &worktree, mcp),
    };
    let agent = adapter::AgentAdapter::from(agent);
    let (launcher, prefix): (&dyn RunLauncher, _) = match runner {
        Runner::Tmux => (tmux, "tmux"),
        _ => (runs, "plain"),
    };
    let request = StartRun {
        owner: OwnerKey::implicit(),
        task: id,
        // Unique per task: the generation grows with every run of the task.
        request_key: format!("{prefix}-{id}-{generation}"),
        role: RunRole::Writer,
        host,
        checkout_path: Some(worktree),
        runtime_workspace: None,
        adapter_profile: Some(agent.as_wire().to_owned()),
        command: RunCommand::Agent(AgentLaunch {
            adapter: agent,
            brief,
            mcp,
            timeout_secs: options.time_limit_secs(),
            options: adapter::LaunchOptions {
                model: options.model,
                permission_mode: options.permission_mode,
            },
        }),
    };
    Ok(RuntimeService.start_run(storage, launcher, request)?)
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
}
