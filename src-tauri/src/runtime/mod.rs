//! The runtime service: keeps the runtime records in storage consistent with what the
//! runners did. It opens and removes the runtime workspaces of tasks through a
//! [`TaskWorkspaceRuntime`] and starts runs through a [`RunLauncher`]; both are passed
//! per call, so one service serves every runner.
//!
//! A run is reserved in storage before the runner is asked to launch it, and the storage
//! lock is never held across a runner call. A retry with the same request key therefore
//! finds the same run and, if the runner already launched it but the response was lost,
//! adopts that launch instead of launching again.

pub mod events;
mod herdr;
pub mod host;
pub mod plain;
pub mod tmux;
mod workspace;

use std::fmt;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::adapters::herdr::HerdrError;
use crate::domain::model::{TaskId, WorkspaceId};
use crate::domain::runtime::{
    HostRef, OwnerKey, RunId, RunRole, RunState, RunnerKind, RuntimeWorkspaceId,
};
use crate::storage::{NewRun, Storage, StorageError, TaskRun};

pub use workspace::{OpenFor, OpenWorktree, TaskWorktree, end_runs};

/// What one [`reconcile_remote_runs`] pass left.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RemotePass {
    /// The workspaces with a run that the pass settled or observed again.
    pub changed: std::collections::BTreeSet<WorkspaceId>,
    /// Whether a run is still unknown: its host could not be reached, or its agent runs
    /// on without a stream to observe.
    pub pending: bool,
}

/// Reconciles every remote plain or tmux run whose observation was lost, as
/// `reconcile_run` does. The server runs it in the background after startup, so remote
/// runs settle on their own after a restart.
pub fn reconcile_remote_runs(
    storage: &Mutex<Storage>,
    plain: &plain::PlainRunner,
    tmux: &tmux::TmuxRunner,
) -> Result<RemotePass, RuntimeError> {
    let runs = {
        let storage = lock(storage);
        let mut runs = Vec::new();
        for workspace in storage.list_workspaces()? {
            for task in storage.list_tasks(workspace.id)? {
                for run in storage.list_task_runs(task.id)? {
                    if run.state == RunState::Unknown
                        && matches!(run.host, HostRef::Ssh(_))
                        && matches!(run.runner_kind, RunnerKind::Plain | RunnerKind::Tmux)
                    {
                        runs.push((workspace.id, run));
                    }
                }
            }
        }
        runs
    };
    let mut pass = RemotePass::default();
    for (workspace, run) in runs {
        let reconciled = match run.runner_kind {
            RunnerKind::Tmux => tmux.reconcile(run.id),
            _ => plain.reconcile(run.id),
        };
        match reconciled {
            Ok(now) if now.state == RunState::Unknown => pass.pending = true,
            Ok(_) => {
                pass.changed.insert(workspace);
            }
            Err(error) => {
                eprintln!(
                    "toodo-server: could not reconcile run {} ({error}); the server tries \
                     again later, or reconcile it with reconcile_run",
                    run.id
                );
                pass.pending = true;
            }
        }
    }
    Ok(pass)
}

/// A runner failure, with a message that names what to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerError(pub String);

impl fmt::Display for RunnerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RunnerError {}

/// What the runtime service can fail with.
#[derive(Debug)]
pub enum RuntimeError {
    Storage(StorageError),
    Runner(RunnerError),
    /// The tool that hosts the task's workspace failed, e.g. herdr could not create the
    /// worktree.
    Workspace(HerdrError),
    /// A run was requested in a runtime workspace that is not the task's open one.
    WorkspaceNotOpen {
        task: TaskId,
        workspace: RuntimeWorkspaceId,
    },
    /// The task's herdr handle was saved, but no open runtime workspace record matches it.
    RecordMismatch {
        task: TaskId,
        workspace_ref: String,
    },
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(error) => write!(f, "{error}"),
            Self::Runner(error) => write!(
                f,
                "the runner could not launch the run: {error}; fix the cause and start the run \
                 again with a new request key (the failed run keeps its request key)"
            ),
            Self::Workspace(error) => write!(f, "{error}"),
            Self::WorkspaceNotOpen { task, workspace } => write!(
                f,
                "runtime workspace {} is not the open workspace of task {task}; start the run \
                 in the task's open runtime workspace, or open the task's workspace again first",
                workspace.0
            ),
            Self::RecordMismatch {
                task,
                workspace_ref,
            } => write!(
                f,
                "task {task} is open in herdr workspace {workspace_ref}, but no open runtime \
                 workspace record matches it; open the task in herdr again to record it anew"
            ),
        }
    }
}

impl std::error::Error for RuntimeError {}

impl From<StorageError> for RuntimeError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

impl From<RunnerError> for RuntimeError {
    fn from(error: RunnerError) -> Self {
        Self::Runner(error)
    }
}

impl From<HerdrError> for RuntimeError {
    fn from(error: HerdrError) -> Self {
        Self::Workspace(error)
    }
}

/// What a run executes, and where in its runtime workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunCommand {
    /// An agent CLI launched as a managed child of the plain runner.
    Agent(AgentLaunch),
    /// An argument vector, never a shell string, run in a new tab of the runtime
    /// workspace that is labelled after the request key, so a retry can find it again.
    // No command launches runs in new tabs yet, so nothing outside tests builds this.
    #[cfg_attr(not(test), allow(dead_code))]
    NewTab(Vec<String>),
    /// A line typed as is into the shell of an existing pane, e.g. the command an agent
    /// asked to run in the first pane of a task's workspace. Nothing marks the pane, so a
    /// launch whose response was lost cannot be found again.
    InPane { pane: String, line: String },
    /// Nothing to run: the work is done by hand, as in a workspace with runner none.
    ByHand,
}

/// The agent and input of a plain run. The brief is fed on stdin, never in argv.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunch {
    pub adapter: plain::adapter::AgentAdapter,
    pub brief: String,
    pub mcp: bool,
    /// The model and permission mode the agent is launched with.
    pub options: plain::adapter::LaunchOptions,
    pub timeout_secs: u64,
    /// The earlier conversation a follow-up run continues; `None` starts a new one.
    pub resume: Option<AgentResume>,
}

/// The conversation a follow-up run resumes, and the agent session it resumes it from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentResume {
    pub conversation: i64,
    /// The Claude session id or Codex thread id the agent last reported.
    pub session: String,
}

/// What a runner needs to launch one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub run: RunId,
    pub request_key: String,
    pub generation: i64,
    pub task: TaskId,
    pub host: HostRef,
    pub cwd: Option<String>,
    /// The runner's reference of the run's runtime workspace (the herdr workspace ID), or
    /// `None` for a run without one.
    pub workspace_ref: Option<String>,
    pub command: RunCommand,
}

/// The runner's proof of a launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchReceipt {
    pub provider_run_ref: String,
}

/// Launches runs on one kind of runner.
pub trait RunLauncher {
    fn kind(&self) -> RunnerKind;
    /// The launch already made for the request key of `spec`, if the runner has one. Lets
    /// a retry after a lost response adopt it instead of launching again.
    fn find_launch(&self, spec: &LaunchSpec) -> Result<Option<LaunchReceipt>, RunnerError>;
    fn launch(&self, spec: &LaunchSpec) -> Result<LaunchReceipt, RunnerError>;
}

/// The launcher of runs of tasks in workspaces with runner none: nothing is launched, and
/// the run stands for the work done by hand. Its provider reference is the request key.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoRunner;

impl RunLauncher for NoRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::None
    }

    fn find_launch(&self, _spec: &LaunchSpec) -> Result<Option<LaunchReceipt>, RunnerError> {
        Ok(None)
    }

    fn launch(&self, spec: &LaunchSpec) -> Result<LaunchReceipt, RunnerError> {
        if matches!(spec.command, RunCommand::Agent(_)) {
            return Err(RunnerError(
                "start an agent run with runner plain instead of runner none".to_owned(),
            ));
        }
        Ok(LaunchReceipt {
            provider_run_ref: spec.request_key.clone(),
        })
    }
}

/// A request to start a run. The runner kind comes from the launcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRun {
    pub owner: OwnerKey,
    pub task: TaskId,
    pub request_key: String,
    pub role: RunRole,
    pub host: HostRef,
    /// `None` for a run with no checkout, e.g. a workspace with source `none`.
    pub checkout_path: Option<String>,
    /// The task's open runtime workspace the run is launched in, if any.
    pub runtime_workspace: Option<RuntimeWorkspaceId>,
    pub adapter_profile: Option<String>,
    pub command: RunCommand,
}

/// Keeps runtime records in step with the runners it is handed.
#[derive(Debug, Clone, Copy, Default)]
pub struct RuntimeService;

fn lock(storage: &Mutex<Storage>) -> MutexGuard<'_, Storage> {
    storage.lock().unwrap_or_else(PoisonError::into_inner)
}

impl RuntimeService {
    /// Reserves the run, launches it through `launcher` (or adopts a launch the runner
    /// already made for the request key), and records the launch. Repeating a request
    /// returns the same run.
    pub fn start_run(
        &self,
        storage: &Mutex<Storage>,
        launcher: &dyn RunLauncher,
        request: StartRun,
    ) -> Result<TaskRun, RuntimeError> {
        let workspace_ref = match request.runtime_workspace {
            None => None,
            Some(id) => {
                let open = lock(storage).open_runtime_workspace(request.task)?;
                match open {
                    Some(open) if open.id == id => Some(open.provider_workspace_ref),
                    _ => {
                        return Err(RuntimeError::WorkspaceNotOpen {
                            task: request.task,
                            workspace: id,
                        });
                    }
                }
            }
        };
        let new = NewRun {
            owner: request.owner,
            task: request.task,
            request_key: request.request_key,
            runner_kind: launcher.kind(),
            role: request.role,
            host: request.host,
            checkout_path: request.checkout_path,
            runtime_workspace: request.runtime_workspace,
            adapter_profile: request.adapter_profile,
            conversation: match &request.command {
                RunCommand::Agent(AgentLaunch {
                    resume: Some(resume),
                    ..
                }) => Some(resume.conversation),
                _ => None,
            },
        };
        let run = lock(storage).reserve_run(&new)?.into_run();
        if run.state != RunState::Reserved {
            return Ok(run);
        }

        let spec = LaunchSpec {
            run: run.id,
            request_key: run.request_key.clone(),
            generation: run.generation,
            task: run.task,
            host: run.host.clone(),
            cwd: run.checkout_path.clone(),
            workspace_ref,
            command: request.command,
        };
        let receipt = match launcher.find_launch(&spec) {
            Ok(Some(receipt)) => receipt,
            Ok(None) => match launcher.launch(&spec) {
                Ok(receipt) => receipt,
                Err(error) => return Err(Self::fail(storage, run.id, error)),
            },
            Err(error) => return Err(Self::fail(storage, run.id, error)),
        };
        Ok(lock(storage).record_launch(run.id, &receipt.provider_run_ref)?)
    }

    fn fail(storage: &Mutex<Storage>, run: RunId, error: RunnerError) -> RuntimeError {
        match lock(storage).fail_launch(run, &error.0) {
            Ok(_) => RuntimeError::Runner(error),
            Err(storage_error) => RuntimeError::Storage(storage_error),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use super::*;
    use crate::domain::model::{
        CompletionMode, Runner, Source, TaskType, Workspace, WorkspaceLocation,
    };
    use crate::domain::naming::TaskCheckout;
    use crate::domain::path::PosixPath;
    use crate::storage::{NewTask, NewWorkspace};

    #[derive(Default)]
    struct FakeState {
        launches: usize,
        receipts: HashMap<String, LaunchReceipt>,
        fail_with: Option<String>,
        specs: Vec<LaunchSpec>,
    }

    /// Counts launches, remembers receipts by request key, and can fail on demand.
    #[derive(Clone, Default)]
    struct FakeLauncher {
        state: Arc<Mutex<FakeState>>,
    }

    impl FakeLauncher {
        fn launches(&self) -> usize {
            self.state.lock().unwrap().launches
        }

        fn fail_next_launches(&self, message: &str) {
            self.state.lock().unwrap().fail_with = Some(message.to_owned());
        }

        fn succeed_again(&self) {
            self.state.lock().unwrap().fail_with = None;
        }

        fn specs(&self) -> Vec<LaunchSpec> {
            self.state.lock().unwrap().specs.clone()
        }
    }

    impl RunLauncher for FakeLauncher {
        fn kind(&self) -> RunnerKind {
            RunnerKind::Herdr
        }

        fn find_launch(&self, spec: &LaunchSpec) -> Result<Option<LaunchReceipt>, RunnerError> {
            Ok(self
                .state
                .lock()
                .unwrap()
                .receipts
                .get(&spec.request_key)
                .cloned())
        }

        fn launch(&self, spec: &LaunchSpec) -> Result<LaunchReceipt, RunnerError> {
            let mut state = self.state.lock().unwrap();
            if let Some(message) = &state.fail_with {
                return Err(RunnerError(message.clone()));
            }
            state.launches += 1;
            state.specs.push(spec.clone());
            let receipt = LaunchReceipt {
                provider_run_ref: format!("pane-{}", state.launches),
            };
            state
                .receipts
                .insert(spec.request_key.clone(), receipt.clone());
            Ok(receipt)
        }
    }

    fn workspace(
        storage: &mut Storage,
        source: Source,
        completion: CompletionMode,
        runner: Runner,
    ) -> Workspace {
        storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: PosixPath::parse("/srv/toodo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source,
                completion,
                runner,
                axes_detected: true,
            })
            .unwrap()
    }

    fn task_in(storage: &mut Storage, workspace: &Workspace, title: &str) -> TaskId {
        storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: title.to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap()
            .id
    }

    fn setup(count: usize) -> (Mutex<Storage>, Vec<TaskId>) {
        let mut storage = Storage::open_in_memory().unwrap();
        let ws = workspace(
            &mut storage,
            Source::GitHub,
            CompletionMode::PullRequestMerge,
            Runner::Herdr,
        );
        let tasks = (0..count)
            .map(|i| task_in(&mut storage, &ws, &format!("Task {i}")))
            .collect();
        (Mutex::new(storage), tasks)
    }

    fn request(task: TaskId, key: &str, role: RunRole, checkout: Option<&str>) -> StartRun {
        StartRun {
            owner: OwnerKey::implicit(),
            task,
            request_key: key.to_owned(),
            role,
            host: HostRef::Local,
            checkout_path: checkout.map(str::to_owned),
            runtime_workspace: None,
            adapter_profile: None,
            command: RunCommand::NewTab(vec!["agent".to_owned()]),
        }
    }

    fn run_count(storage: &Mutex<Storage>, tasks: &[TaskId]) -> usize {
        let storage = lock(storage);
        tasks
            .iter()
            .map(|task| storage.list_task_runs(*task).unwrap().len())
            .sum()
    }

    #[test]
    fn starting_twice_with_one_request_key_launches_once() {
        let (storage, tasks) = setup(1);
        let launcher = FakeLauncher::default();
        let service = RuntimeService;
        let req = request(tasks[0], "key-1", RunRole::Writer, Some("/w/a"));

        let first = service.start_run(&storage, &launcher, req.clone()).unwrap();
        let second = service.start_run(&storage, &launcher, req).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(second.state, RunState::Running);
        assert_eq!(run_count(&storage, &tasks), 1);
        assert_eq!(launcher.launches(), 1);
    }

    #[test]
    fn a_launch_whose_database_response_was_lost_is_adopted_not_repeated() {
        let (storage, tasks) = setup(1);
        let launcher = FakeLauncher::default();
        let service = RuntimeService;
        let req = request(tasks[0], "key-1", RunRole::Writer, Some("/w/a"));

        // The first attempt reserved the run and launched it, but never recorded the launch.
        let run = lock(&storage)
            .reserve_run(&NewRun {
                owner: req.owner.clone(),
                task: req.task,
                request_key: req.request_key.clone(),
                runner_kind: RunnerKind::Herdr,
                role: req.role,
                host: req.host.clone(),
                checkout_path: req.checkout_path.clone(),
                runtime_workspace: None,
                adapter_profile: None,
                conversation: None,
            })
            .unwrap()
            .into_run();
        let lost = launcher
            .launch(&LaunchSpec {
                run: run.id,
                request_key: run.request_key.clone(),
                generation: run.generation,
                task: run.task,
                host: run.host.clone(),
                cwd: run.checkout_path.clone(),
                workspace_ref: None,
                command: req.command.clone(),
            })
            .unwrap();

        let started = service.start_run(&storage, &launcher, req).unwrap();

        assert_eq!(launcher.launches(), 1);
        assert_eq!(started.id, run.id);
        assert_eq!(started.state, RunState::Running);
        assert_eq!(started.provider_run_ref, Some(lost.provider_run_ref));
    }

    #[test]
    fn a_failed_launch_fails_the_run_and_a_retry_can_start_a_new_one() {
        let (storage, tasks) = setup(1);
        let launcher = FakeLauncher::default();
        let service = RuntimeService;
        launcher.fail_next_launches("herdr is not running");

        let error = service
            .start_run(
                &storage,
                &launcher,
                request(tasks[0], "key-1", RunRole::Writer, Some("/w/a")),
            )
            .unwrap_err();

        assert!(matches!(error, RuntimeError::Runner(_)));
        let runs = lock(&storage).list_task_runs(tasks[0]).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].state, RunState::Failed);

        launcher.succeed_again();
        let repeated = service
            .start_run(
                &storage,
                &launcher,
                request(tasks[0], "key-1", RunRole::Writer, Some("/w/a")),
            )
            .unwrap();
        assert_eq!(repeated.state, RunState::Failed);
        let retried = service
            .start_run(
                &storage,
                &launcher,
                request(tasks[0], "key-2", RunRole::Writer, Some("/w/a")),
            )
            .unwrap();
        assert_eq!(retried.state, RunState::Running);
        assert_eq!(launcher.launches(), 1);
    }

    #[test]
    fn only_one_writer_is_active_per_checkout() {
        let (storage, tasks) = setup(2);
        let launcher = FakeLauncher::default();
        let service = RuntimeService;

        let first = service
            .start_run(
                &storage,
                &launcher,
                request(tasks[0], "a", RunRole::Writer, Some("/w/c")),
            )
            .unwrap();

        for (task, key) in [(tasks[1], "b"), (tasks[0], "c")] {
            let error = service
                .start_run(
                    &storage,
                    &launcher,
                    request(task, key, RunRole::Writer, Some("/w/c")),
                )
                .unwrap_err();
            assert!(
                matches!(
                    error,
                    RuntimeError::Storage(StorageError::CheckoutHasActiveWriter { .. })
                ),
                "{error}"
            );
        }
        assert_eq!(run_count(&storage, &tasks), 1);
        assert_eq!(launcher.launches(), 1);

        service
            .start_run(
                &storage,
                &launcher,
                request(tasks[1], "obs", RunRole::Observer, Some("/w/c")),
            )
            .unwrap();
        service
            .start_run(
                &storage,
                &launcher,
                request(tasks[1], "other", RunRole::Writer, Some("/w/d")),
            )
            .unwrap();
        assert_eq!(launcher.launches(), 3);

        lock(&storage)
            .finish_run(first.id, RunState::Exited)
            .unwrap();
        let next = service
            .start_run(
                &storage,
                &launcher,
                request(tasks[1], "again", RunRole::Writer, Some("/w/c")),
            )
            .unwrap();
        assert_eq!(next.state, RunState::Running);
    }

    #[test]
    fn a_run_in_a_runtime_workspace_launches_in_its_herdr_workspace() {
        let (storage, tasks) = setup(1);
        let checkout = TaskCheckout {
            path: PosixPath::parse("/w/a").unwrap().into(),
            branch: "feat/task-0-1".to_owned(),
        };
        lock(&storage)
            .start_task(tasks[0], &checkout, "w27")
            .unwrap();
        let open = lock(&storage)
            .open_runtime_workspace(tasks[0])
            .unwrap()
            .unwrap();
        let launcher = FakeLauncher::default();
        let in_workspace = |id, key| StartRun {
            runtime_workspace: Some(id),
            ..request(tasks[0], key, RunRole::Writer, Some("/w/a"))
        };

        let run = RuntimeService
            .start_run(&storage, &launcher, in_workspace(open.id, "key-1"))
            .unwrap();
        let error = RuntimeService
            .start_run(
                &storage,
                &launcher,
                in_workspace(RuntimeWorkspaceId(open.id.0 + 1), "key-2"),
            )
            .unwrap_err();

        assert_eq!(run.runtime_workspace, Some(open.id));
        assert_eq!(launcher.specs()[0].workspace_ref.as_deref(), Some("w27"));
        assert!(
            matches!(error, RuntimeError::WorkspaceNotOpen { .. }),
            "{error}"
        );
        assert_eq!(run_count(&storage, &tasks), 1);
        assert_eq!(launcher.launches(), 1);
    }

    #[test]
    fn a_task_of_a_source_less_workspace_gets_a_run_without_checkout_or_branch() {
        let mut raw = Storage::open_in_memory().unwrap();
        let ws = workspace(&mut raw, Source::None, CompletionMode::Manual, Runner::None);
        let task = task_in(&mut raw, &ws, "Write notes");
        let storage = Mutex::new(raw);
        let launcher = FakeLauncher::default();
        let service = RuntimeService;

        let run = service
            .start_run(
                &storage,
                &launcher,
                request(task, "key-1", RunRole::Writer, None),
            )
            .unwrap();

        assert_eq!(run.state, RunState::Running);
        assert_eq!(run.checkout_path, None);
        assert_eq!(run.runtime_workspace, None);
        assert_eq!(launcher.launches(), 1);
        let task = lock(&storage).get_task(task).unwrap().unwrap();
        assert_eq!(task.branch, None);
    }
}
