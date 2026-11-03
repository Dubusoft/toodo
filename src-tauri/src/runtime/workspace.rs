//! Opening and removing the runtime workspace of a task: the worktree checkout and the
//! herdr workspace it is open in.
//!
//! The herdr handle is still written to the task (`herdr_workspace_id`, `worktree_path`),
//! and the migration-29 triggers shadow-write it into `runtime_workspaces`. Going through
//! these methods keeps every such write in one place, so the record can become the source
//! of truth without touching the commands again.

use std::sync::Mutex;

use super::{RuntimeError, RuntimeService, lock};
use crate::adapters::herdr::{NewWorktree, WORKSPACE_NOT_FOUND, WORKTREE_NOT_FOUND};
use crate::adapters::task_runtime::TaskWorkspaceRuntime;
use crate::domain::model::{Machine, Task, TaskId};
use crate::domain::naming::TaskCheckout;
use crate::storage::{RuntimeWorkspace, Storage};

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
    /// not locked while `workspaces` runs; when it fails, nothing is recorded.
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
            OpenFor::Start => storage.start_task(task, checkout, &workspace_ref)?,
            OpenFor::Restore => {
                storage.restore_task_worktree(task, &checkout.path, &workspace_ref)?
            }
        };
        let record = storage
            .open_runtime_workspace(task.id)?
            .filter(|record| {
                record.provider_workspace_ref == workspace_ref
                    && record.checkout_path.as_deref() == Some(path.as_str())
            })
            .ok_or_else(|| RuntimeError::RecordMismatch {
                task: task.id,
                workspace_ref,
            })?;
        Ok(OpenedWorkspace { task, record })
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
        Ok(lock(storage).clear_task_worktree(task)?)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::adapters::herdr::HerdrError;
    use crate::domain::model::{CompletionMode, Runner, Source, TaskType, WorkspaceLocation};
    use crate::domain::path::PosixPath;
    use crate::domain::status::TaskStatus;
    use crate::storage::{NewTask, NewWorkspace};

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
