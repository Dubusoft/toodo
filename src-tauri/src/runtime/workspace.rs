//! Opening, closing, and removing the runtime workspace of a task: the worktree checkout
//! and the herdr workspace it is open in. Also the herdr side of creating and moving a
//! Toodo workspace, which opens its repository and closes the runtime workspaces a move
//! leaves behind.
//!
//! The herdr workspace is recorded in `runtime_workspaces`, which tasks read their herdr
//! workspace from; the checkout path stays on the task. Going through these methods keeps
//! every such write in one place.

use std::sync::Mutex;

use super::{RuntimeError, RuntimeService, lock};
use crate::adapters::herdr::{NewWorktree, WORKSPACE_NOT_FOUND, WORKTREE_NOT_FOUND};
use crate::adapters::task_runtime::TaskWorkspaceRuntime;
use crate::domain::model::{Machine, Task, TaskId, Workspace};
use crate::domain::naming::TaskCheckout;
use crate::domain::runtime::{RunState, RuntimeWorkspaceId};
use crate::storage::{RuntimeWorkspace, Storage, StorageError};

/// How the checkout of a task's runtime workspace comes to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenWorktree<'a> {
    /// The checkout already exists, e.g. the worktree a paused task kept.
    Existing,
    /// herdr creates the worktree, checking the branch out from `base` (an existing
    /// branch is checked out as is).
    New { base: &'a str },
}

/// What a runtime workspace is opened for, which decides how the task records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenFor {
    /// Starting or resuming a task: it moves to `in_progress` on the checkout's branch.
    Start,
    /// Restoring the lost worktree of an active task: only the checkout and handle change.
    Restore,
}

/// The task whose worktree a runtime workspace holds, and the repository it belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskWorktree<'a> {
    pub task: TaskId,
    pub machine: &'a Machine,
    pub repository: &'a str,
}

/// A task with the runtime workspace it was just opened in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedWorkspace {
    pub task: Task,
    pub record: RuntimeWorkspace,
}

impl RuntimeService {
    /// Opens `checkout` of the target's repository as the runtime workspace of its task,
    /// records it, and returns the task with its open runtime workspace record. Storage is
    /// not locked while `workspaces` runs; when it fails, nothing is recorded. Starting a
    /// task ends the runs still active from before it was paused as exited: its work starts
    /// anew, and its checkout gets a new writer.
    pub fn open_workspace(
        &self,
        storage: &Mutex<Storage>,
        workspaces: &dyn TaskWorkspaceRuntime,
        target: &TaskWorktree<'_>,
        checkout: &TaskCheckout,
        open: OpenWorktree<'_>,
        purpose: OpenFor,
    ) -> Result<OpenedWorkspace, RuntimeError> {
        let TaskWorktree {
            task,
            machine,
            repository,
        } = *target;
        let path = checkout.path.to_string();
        let workspace_ref = match open {
            OpenWorktree::Existing => workspaces.open_worktree(machine, repository, &path)?,
            OpenWorktree::New { base } => workspaces.create_worktree(
                machine,
                &NewWorktree {
                    repository,
                    path: &path,
                    branch: &checkout.branch,
                    base,
                },
            )?,
        };
        let mut storage = lock(storage);
        let task = match purpose {
            OpenFor::Start => {
                let started = storage.start_task(task, checkout, &workspace_ref)?;
                end_runs(&mut storage, task, None, RunState::Exited)?;
                started
            }
            OpenFor::Restore => {
                storage.restore_task_worktree(task, &checkout.path, &workspace_ref)?
            }
        };
        let record = recorded(&storage, task.id, workspace_ref, &path)?;
        Ok(OpenedWorkspace { task, record })
    }

    /// Opens the kept checkout at `path` of the target's task in a new herdr workspace,
    /// e.g. after the user closed the one it had, and records the new handle; the task keeps
    /// its status and checkout. Returns the task with its open runtime workspace record.
    pub fn reopen_workspace(
        &self,
        storage: &Mutex<Storage>,
        workspaces: &dyn TaskWorkspaceRuntime,
        target: &TaskWorktree<'_>,
        path: &str,
    ) -> Result<OpenedWorkspace, RuntimeError> {
        let workspace_ref = workspaces.open_worktree(target.machine, target.repository, path)?;
        let mut storage = lock(storage);
        storage.set_task_herdr_workspace(target.task, &workspace_ref)?;
        let task = storage
            .get_task(target.task)?
            .ok_or(StorageError::TaskNotFound(target.task))?;
        let record = recorded(&storage, task.id, workspace_ref, path)?;
        Ok(OpenedWorkspace { task, record })
    }

    /// Closes the herdr workspace of the task's open runtime workspace, then runs `record`
    /// under the storage lock to forget it on the task (e.g. by pausing or completing the
    /// task). The checkout stays on disk. A workspace herdr no longer has counts as closed;
    /// when herdr fails, `record` does not run. Active runs in a runtime workspace that
    /// `record` closed end as exited, since closing the herdr workspace ends its panes.
    pub fn close_workspace<T>(
        &self,
        storage: &Mutex<Storage>,
        workspaces: &dyn TaskWorkspaceRuntime,
        task: TaskId,
        machine: &Machine,
        record: impl FnOnce(&mut Storage) -> Result<T, StorageError>,
    ) -> Result<T, RuntimeError> {
        let open = lock(storage).open_runtime_workspace(task)?;
        if let Some(open) = &open {
            match workspaces.close_workspace(machine, &open.provider_workspace_ref) {
                Ok(()) => {}
                Err(error) if error.has_code(WORKSPACE_NOT_FOUND) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let mut storage = lock(storage);
        let recorded = record(&mut storage)?;
        if let Some(open) = open {
            end_runs_if_closed(&mut storage, &open, RunState::Exited)?;
        }
        Ok(recorded)
    }

    /// Opens the repository checkout at `path` on `machine` in herdr as a workspace
    /// labelled `label`, for a Toodo workspace that is created or moved there.
    pub fn open_repository(
        &self,
        workspaces: &dyn TaskWorkspaceRuntime,
        machine: &Machine,
        path: &str,
        label: &str,
    ) -> Result<String, RuntimeError> {
        Ok(workspaces.open_repository(machine, path, label)?)
    }

    /// Saves `moved`, a Toodo workspace at a new location. Moving it to another host makes
    /// its tasks forget their herdr workspaces, which belong to the old host's herdr, and so
    /// closes their runtime workspaces; their active runs become unknown, since Toodo no
    /// longer sees that herdr. Takes the locked storage so the caller can check the new
    /// location in the same lock.
    pub fn move_workspace(
        &self,
        storage: &mut Storage,
        moved: &Workspace,
    ) -> Result<(), RuntimeError> {
        let open = storage
            .list_tasks(moved.id)?
            .into_iter()
            .map(|task| storage.open_runtime_workspace(task.id))
            .filter_map(Result::transpose)
            .collect::<Result<Vec<_>, _>>()?;
        storage.update_workspace(moved)?;
        for record in &open {
            end_runs_if_closed(storage, record, RunState::Unknown)?;
        }
        Ok(())
    }

    /// Removes the worktree checkout at `path` of the target's repository through its
    /// task's open runtime workspace, which closes it, and forgets both on the task. The
    /// branch is kept. A runtime workspace herdr no longer has is opened again from the
    /// checkout to remove it; a checkout that is already gone is only forgotten. Without
    /// `force`, a checkout with modified or untracked files is refused and kept.
    pub fn remove_workspace(
        &self,
        storage: &Mutex<Storage>,
        workspaces: &dyn TaskWorkspaceRuntime,
        target: &TaskWorktree<'_>,
        path: &str,
        force: bool,
    ) -> Result<Task, RuntimeError> {
        let TaskWorktree {
            task,
            machine,
            repository,
        } = *target;
        let open = lock(storage).open_runtime_workspace(task)?;
        let removed = match &open {
            Some(record) => {
                match workspaces.remove_worktree(machine, &record.provider_workspace_ref, force) {
                    Ok(()) => true,
                    Err(error) if error.has_code(WORKSPACE_NOT_FOUND) => false,
                    Err(error) => return Err(error.into()),
                }
            }
            None => false,
        };
        // herdr no longer has the workspace, e.g. the user closed it or herdr lost its
        // session, but the checkout may still exist: open it again to remove it.
        if !removed {
            match workspaces.open_worktree(machine, repository, path) {
                Ok(workspace_ref) => workspaces.remove_worktree(machine, &workspace_ref, force)?,
                // The checkout is already gone.
                Err(error) if error.has_code(WORKTREE_NOT_FOUND) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let mut storage = lock(storage);
        let cleared = storage.clear_task_worktree(task)?;
        if let Some(record) = &open {
            end_runs_if_closed(&mut storage, record, RunState::Exited)?;
        }
        Ok(cleared)
    }
}

/// The task's open runtime workspace record, which must match the herdr handle and
/// checkout just saved on the task.
fn recorded(
    storage: &Storage,
    task: TaskId,
    workspace_ref: String,
    path: &str,
) -> Result<RuntimeWorkspace, RuntimeError> {
    storage
        .open_runtime_workspace(task)?
        .filter(|record| {
            record.provider_workspace_ref == workspace_ref
                && record.checkout_path.as_deref() == Some(path)
        })
        .ok_or(RuntimeError::RecordMismatch {
            task,
            workspace_ref,
        })
}

/// Ends the active runs in `record` as `state`, unless the record is still the task's open
/// runtime workspace.
fn end_runs_if_closed(
    storage: &mut Storage,
    record: &RuntimeWorkspace,
    state: RunState,
) -> Result<(), StorageError> {
    let still_open = storage
        .open_runtime_workspace(record.task)?
        .is_some_and(|open| open.id == record.id);
    if still_open {
        return Ok(());
    }
    end_runs(storage, record.task, Some(record.id), state)
}

/// Ends the task's active runs as `state`: those in the runtime workspace `workspace`, or
/// all of them for `None`.
pub fn end_runs(
    storage: &mut Storage,
    task: TaskId,
    workspace: Option<RuntimeWorkspaceId>,
    state: RunState,
) -> Result<(), StorageError> {
    for run in storage.list_task_runs(task)? {
        let in_workspace = workspace.is_none_or(|id| run.runtime_workspace == Some(id));
        if in_workspace && run.state.is_active() && run.state != state {
            storage.finish_run(run.id, state)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::adapters::herdr::HerdrError;
    use crate::domain::model::{
        CompletionMode, MachineLabel, Runner, Source, TaskType, WorkspaceLocation,
    };
    use crate::domain::path::PosixPath;
    use crate::domain::runtime::{OwnerKey, RunId, RunRole, RunnerKind};
    use crate::domain::status::TaskStatus;
    use crate::storage::{NewRun, NewTask, NewWorkspace};

    /// Records its calls and answers them with `results` in order.
    struct FakeWorkspaces {
        results: Mutex<Vec<Result<String, HerdrError>>>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeWorkspaces {
        fn new(results: Vec<Result<String, HerdrError>>) -> Self {
            Self {
                results: Mutex::new(results),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn answer(&self, call: String) -> Result<String, HerdrError> {
            self.calls.lock().unwrap().push(call);
            self.results.lock().unwrap().remove(0)
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl TaskWorkspaceRuntime for FakeWorkspaces {
        fn create_worktree(
            &self,
            _machine: &Machine,
            worktree: &NewWorktree<'_>,
        ) -> Result<String, HerdrError> {
            self.answer(format!("create {} {}", worktree.path, worktree.base))
        }

        fn open_worktree(
            &self,
            _machine: &Machine,
            _repository: &str,
            path: &str,
        ) -> Result<String, HerdrError> {
            self.answer(format!("open {path}"))
        }

        fn remove_worktree(
            &self,
            _machine: &Machine,
            workspace_id: &str,
            force: bool,
        ) -> Result<(), HerdrError> {
            self.answer(format!("remove {workspace_id} {force}"))
                .map(drop)
        }

        fn close_workspace(
            &self,
            _machine: &Machine,
            workspace_id: &str,
        ) -> Result<(), HerdrError> {
            self.answer(format!("close {workspace_id}")).map(drop)
        }

        fn open_repository(
            &self,
            _machine: &Machine,
            path: &str,
            label: &str,
        ) -> Result<String, HerdrError> {
            self.answer(format!("open repository {path} {label}"))
        }
    }

    fn failure(code: &str) -> HerdrError {
        HerdrError::Failed {
            command: "herdr worktree".to_owned(),
            code: Some(code.to_owned()),
            message: "failed".to_owned(),
        }
    }

    fn setup() -> (Mutex<Storage>, TaskId) {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
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
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: "Add login".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap()
            .id;
        (Mutex::new(storage), task)
    }

    fn checkout(path: &str) -> TaskCheckout {
        TaskCheckout {
            path: PosixPath::parse(path).unwrap().into(),
            branch: "feat/add-login-1".to_owned(),
        }
    }

    fn target(task: TaskId) -> TaskWorktree<'static> {
        TaskWorktree {
            task,
            machine: &Machine::Local,
            repository: "/srv/toodo",
        }
    }

    #[test]
    fn an_opened_workspace_is_recorded_as_the_tasks_open_runtime_workspace() {
        let (storage, task) = setup();
        let workspaces = FakeWorkspaces::new(vec![Ok("w27".to_owned()), Ok("w31".to_owned())]);

        let started = RuntimeService
            .open_workspace(
                &storage,
                &workspaces,
                &target(task),
                &checkout("/wt/a"),
                OpenWorktree::New { base: "main" },
                OpenFor::Start,
            )
            .unwrap();
        lock(&storage).clear_task_worktree(task).unwrap();
        let restored = RuntimeService
            .open_workspace(
                &storage,
                &workspaces,
                &target(task),
                &checkout("/wt/b"),
                OpenWorktree::New {
                    base: "feat/add-login-1",
                },
                OpenFor::Restore,
            )
            .unwrap();

        assert_eq!(started.task.status, TaskStatus::InProgress);
        assert_eq!(
            (
                started.record.provider_workspace_ref.as_str(),
                started.record.checkout_path.as_deref(),
                started.record.branch.as_deref(),
                started.record.generation,
            ),
            ("w27", Some("/wt/a"), Some("feat/add-login-1"), 1)
        );
        assert_eq!(
            (
                restored.record.provider_workspace_ref.as_str(),
                restored.record.checkout_path.as_deref(),
                restored.record.generation,
            ),
            ("w31", Some("/wt/b"), 2)
        );
        assert_eq!(
            lock(&storage).open_runtime_workspace(task).unwrap(),
            Some(restored.record)
        );
        assert_eq!(
            workspaces.calls(),
            ["create /wt/a main", "create /wt/b feat/add-login-1"]
        );
    }

    fn start(storage: &Mutex<Storage>, workspaces: &FakeWorkspaces, task: TaskId) {
        RuntimeService
            .open_workspace(
                storage,
                workspaces,
                &target(task),
                &checkout("/wt/a"),
                OpenWorktree::New { base: "main" },
                OpenFor::Start,
            )
            .unwrap();
    }

    /// A launched writer run in the task's open runtime workspace.
    fn running_run(storage: &Mutex<Storage>, task: TaskId, key: &str) -> RunId {
        let mut storage = lock(storage);
        let open = storage.open_runtime_workspace(task).unwrap().unwrap();
        let run = storage
            .reserve_run(&NewRun {
                owner: OwnerKey::implicit(),
                task,
                request_key: key.to_owned(),
                runner_kind: RunnerKind::Herdr,
                role: RunRole::Writer,
                host: open.host,
                checkout_path: open.checkout_path,
                runtime_workspace: Some(open.id),
                adapter_profile: None,
                conversation: None,
            })
            .unwrap()
            .into_run();
        storage.record_launch(run.id, "w27:p1").unwrap();
        run.id
    }

    fn run_state(storage: &Mutex<Storage>, run: RunId) -> RunState {
        lock(storage).get_run(run).unwrap().unwrap().state
    }

    #[test]
    fn a_reopened_workspace_records_its_new_herdr_workspace() {
        let (storage, task) = setup();
        let workspaces = FakeWorkspaces::new(vec![Ok("w27".to_owned()), Ok("w31".to_owned())]);
        start(&storage, &workspaces, task);

        let reopened = RuntimeService
            .reopen_workspace(&storage, &workspaces, &target(task), "/wt/a")
            .unwrap();

        assert_eq!(reopened.task.status, TaskStatus::InProgress);
        assert_eq!(reopened.task.herdr_workspace_id.as_deref(), Some("w31"));
        assert_eq!(
            (
                reopened.record.provider_workspace_ref.as_str(),
                reopened.record.checkout_path.as_deref(),
                reopened.record.generation,
            ),
            ("w31", Some("/wt/a"), 2)
        );
        assert_eq!(workspaces.calls()[1], "open /wt/a");
    }

    #[test]
    fn closing_a_workspace_closes_it_in_herdr_before_recording_it_and_ends_its_runs() {
        let (storage, task) = setup();
        let workspaces = FakeWorkspaces::new(vec![
            Ok("w27".to_owned()),
            Err(failure("server_unavailable")),
            Ok(String::new()),
        ]);
        start(&storage, &workspaces, task);
        let run = running_run(&storage, task, "key-1");
        let forget = |storage: &mut Storage| storage.clear_task_herdr_workspace(task);

        let error = RuntimeService
            .close_workspace(&storage, &workspaces, task, &Machine::Local, forget)
            .unwrap_err();
        assert!(matches!(error, RuntimeError::Workspace(_)), "{error}");
        assert!(
            lock(&storage)
                .open_runtime_workspace(task)
                .unwrap()
                .is_some()
        );
        assert_eq!(run_state(&storage, run), RunState::Running);

        let closed = RuntimeService
            .close_workspace(&storage, &workspaces, task, &Machine::Local, forget)
            .unwrap();

        assert_eq!(closed.herdr_workspace_id, None);
        assert_eq!(
            closed.worktree_path.map(|path| path.to_string()).as_deref(),
            Some("/wt/a")
        );
        assert_eq!(lock(&storage).open_runtime_workspace(task).unwrap(), None);
        assert_eq!(run_state(&storage, run), RunState::Exited);
        assert_eq!(workspaces.calls()[1..], ["close w27", "close w27"]);
    }

    #[test]
    fn starting_a_task_again_ends_the_runs_left_from_before() {
        let (storage, task) = setup();
        let workspaces = FakeWorkspaces::new(vec![Ok("w27".to_owned()), Ok("w27".to_owned())]);
        start(&storage, &workspaces, task);
        let run = running_run(&storage, task, "key-1");
        lock(&storage)
            .set_task_status(task, TaskStatus::Planned)
            .unwrap();

        RuntimeService
            .open_workspace(
                &storage,
                &workspaces,
                &target(task),
                &checkout("/wt/a"),
                OpenWorktree::Existing,
                OpenFor::Start,
            )
            .unwrap();

        assert_eq!(run_state(&storage, run), RunState::Exited);
    }

    #[test]
    fn moving_a_workspace_to_another_host_closes_its_runtime_workspaces() {
        let (storage, task) = setup();
        let workspaces = FakeWorkspaces::new(vec![Ok("w27".to_owned())]);
        start(&storage, &workspaces, task);
        let run = running_run(&storage, task, "key-1");
        let mut storage = lock(&storage);
        let workspace_id = storage.get_task(task).unwrap().unwrap().workspace_id;
        let workspace = storage.get_workspace(workspace_id).unwrap().unwrap();
        let state = |storage: &Storage| storage.get_run(run).unwrap().unwrap().state;

        let same_host = Workspace {
            location: WorkspaceLocation::Local {
                path: PosixPath::parse("/srv/moved").unwrap().into(),
            },
            ..workspace.clone()
        };
        RuntimeService
            .move_workspace(&mut storage, &same_host)
            .unwrap();
        assert!(storage.open_runtime_workspace(task).unwrap().is_some());
        assert_eq!(state(&storage), RunState::Running);

        let other_host = Workspace {
            location: WorkspaceLocation::Ssh {
                machine: MachineLabel::parse("devbox").unwrap(),
                path: PosixPath::parse("/srv/toodo").unwrap().into(),
            },
            ..workspace
        };
        RuntimeService
            .move_workspace(&mut storage, &other_host)
            .unwrap();

        assert_eq!(storage.open_runtime_workspace(task).unwrap(), None);
        assert_eq!(state(&storage), RunState::Unknown);
        let moved = storage.get_task(task).unwrap().unwrap();
        assert_eq!(moved.herdr_workspace_id, None);
        assert!(moved.worktree_path.is_some());
    }

    #[test]
    fn a_failed_open_records_nothing() {
        let (storage, task) = setup();
        let before = lock(&storage).get_task(task).unwrap();
        let workspaces = FakeWorkspaces::new(vec![Err(failure("worktree_not_found"))]);

        let error = RuntimeService
            .open_workspace(
                &storage,
                &workspaces,
                &target(task),
                &checkout("/wt/a"),
                OpenWorktree::Existing,
                OpenFor::Start,
            )
            .unwrap_err();

        assert!(
            matches!(&error, RuntimeError::Workspace(error) if error.has_code("worktree_not_found")),
            "{error}"
        );
        assert_eq!(lock(&storage).get_task(task).unwrap(), before);
        assert_eq!(lock(&storage).open_runtime_workspace(task).unwrap(), None);
        assert_eq!(workspaces.calls(), ["open /wt/a"]);
    }

    #[test]
    fn a_workspace_is_removed_through_its_open_runtime_record_and_closed() {
        let (storage, task) = setup();
        let workspaces = FakeWorkspaces::new(vec![
            Ok("w27".to_owned()),
            Err(failure("dirty_worktree_requires_force")),
            Ok(String::new()),
        ]);
        RuntimeService
            .open_workspace(
                &storage,
                &workspaces,
                &target(task),
                &checkout("/wt/a"),
                OpenWorktree::New { base: "main" },
                OpenFor::Start,
            )
            .unwrap();

        let error = RuntimeService
            .remove_workspace(&storage, &workspaces, &target(task), "/wt/a", false)
            .unwrap_err();
        assert!(matches!(error, RuntimeError::Workspace(_)), "{error}");
        assert!(
            lock(&storage)
                .open_runtime_workspace(task)
                .unwrap()
                .is_some()
        );

        let removed = RuntimeService
            .remove_workspace(&storage, &workspaces, &target(task), "/wt/a", true)
            .unwrap();

        assert_eq!(
            (removed.worktree_path, removed.herdr_workspace_id),
            (None, None)
        );
        assert_eq!(lock(&storage).open_runtime_workspace(task).unwrap(), None);
        assert_eq!(
            workspaces.calls()[1..],
            ["remove w27 false", "remove w27 true"]
        );
    }

    #[test]
    fn a_checkout_without_an_open_runtime_workspace_is_opened_again_to_remove_it() {
        let (storage, task) = setup();
        let workspaces = FakeWorkspaces::new(vec![
            Ok("w40".to_owned()),
            Ok(String::new()),
            Err(failure("worktree_not_found")),
        ]);

        RuntimeService
            .remove_workspace(&storage, &workspaces, &target(task), "/wt/a", false)
            .unwrap();
        RuntimeService
            .remove_workspace(&storage, &workspaces, &target(task), "/wt/a", false)
            .unwrap();

        assert_eq!(
            workspaces.calls(),
            ["open /wt/a", "remove w40 false", "open /wt/a"]
        );
    }
}
