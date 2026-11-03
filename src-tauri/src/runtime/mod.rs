//! The runtime service: starts runs through a [`RunLauncher`] while keeping the run
//! records in storage consistent with what the runner did.
//!
//! A run is reserved in storage before the runner is asked to launch it, and the storage
//! lock is never held across a runner call. A retry with the same request key therefore
//! finds the same run and, if the runner already launched it but the response was lost,
//! adopts that launch instead of launching again.
// The commands move onto this service in a follow-up, so nothing outside tests calls it yet.
#![cfg_attr(not(test), allow(dead_code))]

use std::fmt;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::domain::model::TaskId;
use crate::domain::runtime::{
    HostRef, OwnerKey, RunId, RunRole, RunState, RunnerKind, RuntimeWorkspaceId,
};
use crate::storage::{NewRun, Storage, StorageError, TaskRun};

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

/// What a runner needs to launch one run. The command is an argument vector, never a
/// shell string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub run: RunId,
    pub request_key: String,
    pub generation: i64,
    pub task: TaskId,
    pub host: HostRef,
    pub cwd: Option<String>,
    pub argv: Vec<String>,
}

/// The runner's proof of a launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchReceipt {
    pub provider_run_ref: String,
}

/// Launches runs on one kind of runner.
pub trait RunLauncher {
    fn kind(&self) -> RunnerKind;
    /// The launch already made for `request_key`, if the runner has one. Lets a retry
    /// after a lost response adopt it instead of launching again.
    fn find_launch(&self, request_key: &str) -> Result<Option<LaunchReceipt>, RunnerError>;
    fn launch(&self, spec: &LaunchSpec) -> Result<LaunchReceipt, RunnerError>;
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
    pub runtime_workspace: Option<RuntimeWorkspaceId>,
    pub adapter_profile: Option<String>,
    pub argv: Vec<String>,
}

/// Starts runs and keeps their records in step with the runner.
pub struct RuntimeService<L> {
    launcher: L,
}

fn lock(storage: &Mutex<Storage>) -> MutexGuard<'_, Storage> {
    storage.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<L: RunLauncher> RuntimeService<L> {
    pub fn new(launcher: L) -> Self {
        Self { launcher }
    }

    /// Reserves the run, launches it (or adopts a launch the runner already made for the
    /// request key), and records the launch. Repeating a request returns the same run.
    pub fn start_run(
        &self,
        storage: &Mutex<Storage>,
        request: StartRun,
    ) -> Result<TaskRun, RuntimeError> {
        let new = NewRun {
            owner: request.owner,
            task: request.task,
            request_key: request.request_key,
            runner_kind: self.launcher.kind(),
            role: request.role,
            host: request.host,
            checkout_path: request.checkout_path,
            runtime_workspace: request.runtime_workspace,
            adapter_profile: request.adapter_profile,
        };
        let run = lock(storage).reserve_run(&new)?.into_run();
        if run.state != RunState::Reserved {
            return Ok(run);
        }

        let receipt = match self.launcher.find_launch(&run.request_key) {
            Ok(Some(receipt)) => receipt,
            Ok(None) => {
                let spec = LaunchSpec {
                    run: run.id,
                    request_key: run.request_key.clone(),
                    generation: run.generation,
                    task: run.task,
                    host: run.host.clone(),
                    cwd: run.checkout_path.clone(),
                    argv: request.argv,
                };
                match self.launcher.launch(&spec) {
                    Ok(receipt) => receipt,
                    Err(error) => return Err(self.fail(storage, run.id, error)),
                }
            }
            Err(error) => return Err(self.fail(storage, run.id, error)),
        };
        Ok(lock(storage).record_launch(run.id, &receipt.provider_run_ref)?)
    }

    fn fail(&self, storage: &Mutex<Storage>, run: RunId, error: RunnerError) -> RuntimeError {
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
    use crate::domain::path::PosixPath;
    use crate::storage::{NewTask, NewWorkspace};

    #[derive(Default)]
    struct FakeState {
        launches: usize,
        receipts: HashMap<String, LaunchReceipt>,
        fail_with: Option<String>,
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
    }

    impl RunLauncher for FakeLauncher {
        fn kind(&self) -> RunnerKind {
            RunnerKind::Herdr
        }

        fn find_launch(&self, request_key: &str) -> Result<Option<LaunchReceipt>, RunnerError> {
            Ok(self
                .state
                .lock()
                .unwrap()
                .receipts
                .get(request_key)
                .cloned())
        }

        fn launch(&self, spec: &LaunchSpec) -> Result<LaunchReceipt, RunnerError> {
            let mut state = self.state.lock().unwrap();
            if let Some(message) = &state.fail_with {
                return Err(RunnerError(message.clone()));
            }
            state.launches += 1;
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
            argv: vec!["agent".to_owned()],
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
        let service = RuntimeService::new(launcher.clone());
        let req = request(tasks[0], "key-1", RunRole::Writer, Some("/w/a"));

        let first = service.start_run(&storage, req.clone()).unwrap();
        let second = service.start_run(&storage, req).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(second.state, RunState::Running);
        assert_eq!(run_count(&storage, &tasks), 1);
        assert_eq!(launcher.launches(), 1);
    }

    #[test]
    fn a_launch_whose_database_response_was_lost_is_adopted_not_repeated() {
        let (storage, tasks) = setup(1);
        let launcher = FakeLauncher::default();
        let service = RuntimeService::new(launcher.clone());
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
                argv: req.argv.clone(),
            })
            .unwrap();

        let started = service.start_run(&storage, req).unwrap();

        assert_eq!(launcher.launches(), 1);
        assert_eq!(started.id, run.id);
        assert_eq!(started.state, RunState::Running);
        assert_eq!(started.provider_run_ref, Some(lost.provider_run_ref));
    }

    #[test]
    fn a_failed_launch_fails_the_run_and_a_retry_can_start_a_new_one() {
        let (storage, tasks) = setup(1);
        let launcher = FakeLauncher::default();
        let service = RuntimeService::new(launcher.clone());
        launcher.fail_next_launches("herdr is not running");

        let error = service
            .start_run(
                &storage,
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
                request(tasks[0], "key-1", RunRole::Writer, Some("/w/a")),
            )
            .unwrap();
        assert_eq!(repeated.state, RunState::Failed);
        let retried = service
            .start_run(
                &storage,
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
        let service = RuntimeService::new(launcher.clone());

        let first = service
            .start_run(
                &storage,
                request(tasks[0], "a", RunRole::Writer, Some("/w/c")),
            )
            .unwrap();

        for (task, key) in [(tasks[1], "b"), (tasks[0], "c")] {
            let error = service
                .start_run(&storage, request(task, key, RunRole::Writer, Some("/w/c")))
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
                request(tasks[1], "obs", RunRole::Observer, Some("/w/c")),
            )
            .unwrap();
        service
            .start_run(
                &storage,
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
                request(tasks[1], "again", RunRole::Writer, Some("/w/c")),
            )
            .unwrap();
        assert_eq!(next.state, RunState::Running);
    }

    #[test]
    fn a_task_of_a_source_less_workspace_gets_a_run_without_checkout_or_branch() {
        let mut raw = Storage::open_in_memory().unwrap();
        let ws = workspace(&mut raw, Source::None, CompletionMode::Manual, Runner::None);
        let task = task_in(&mut raw, &ws, "Write notes");
        let storage = Mutex::new(raw);
        let launcher = FakeLauncher::default();
        let service = RuntimeService::new(launcher.clone());

        let run = service
            .start_run(&storage, request(task, "key-1", RunRole::Writer, None))
            .unwrap();

        assert_eq!(run.state, RunState::Running);
        assert_eq!(run.checkout_path, None);
        assert_eq!(run.runtime_workspace, None);
        assert_eq!(launcher.launches(), 1);
        let task = lock(&storage).get_task(task).unwrap().unwrap();
        assert_eq!(task.branch, None);
    }
}
