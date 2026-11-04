use std::sync::{Arc, Mutex};

use super::cleanup::*;
use super::prepare::*;
use super::workspace::*;
use super::*;
use crate::adapters::git::fake::{FakeRunner, failed};
use crate::adapters::git::{Git, GitError, Invocation};
use crate::adapters::herdr::{Herdr, NewWorktree};
use crate::adapters::task_runtime::TaskWorkspaceRuntime;
use crate::commands::{CommandErrorKind, lock};
use crate::domain::criteria::CheckKind;
use crate::domain::model::{
    self, HostPath, Machine, MachineLabel, MachineSettings, TaskType, WorkspaceLocation,
};
use crate::domain::path::{PosixPath, WindowsPath};
use crate::domain::runtime::{HostRef, OwnerKey, RunRole, RunState};
use crate::domain::status::TaskStatus;
use crate::storage::{NewTask, NewWorkspace, Storage};

mod cleanup;
mod dependencies;
mod restore;
mod runners;
mod start;
mod workspace;

const CREATED: &str =
    r#"{"id":"cli:worktree:create","result":{"workspace":{"workspace_id":"w27"}}}"#;

struct Fixture {
    storage: StorageState,
    task: model::Task,
}

fn fixture(location: WorkspaceLocation, settings: Option<MachineSettings>) -> Fixture {
    fixture_with_runner(location, settings, Runner::Herdr)
}

fn fixture_with_runner(
    location: WorkspaceLocation,
    settings: Option<MachineSettings>,
    runner: Runner,
) -> Fixture {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = storage
        .create_workspace(&NewWorkspace {
            name: "Toodo".to_owned(),
            location,
            default_base_branch: "main".to_owned(),
            source: crate::domain::model::Source::GitHub,
            completion: crate::domain::model::CompletionMode::PullRequestMerge,
            runner,
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
        .unwrap();
    if let Some(settings) = settings {
        storage.save_machine_settings(&settings).unwrap();
    }
    Fixture {
        storage: Mutex::new(storage),
        task,
    }
}

fn local_fixture(root: Option<&str>) -> Fixture {
    fixture(
        WorkspaceLocation::Local {
            path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
        },
        Some(MachineSettings::Local {
            worktree_root: root.map(|root| WindowsPath::parse(root).unwrap().into()),
        }),
    )
}

fn herdr(results: Vec<Result<String, GitError>>) -> (Herdr, Arc<FakeRunner>) {
    let runner = Arc::new(FakeRunner::new(results));
    (Herdr::new(Box::new(runner.clone())), runner)
}

/// Git for a repository without `origin` whose base branch already exists; a new task
/// branch is created from it, and deleted again when herdr fails.
fn existing_base() -> Git {
    Git::new(Box::new(Arc::new(FakeRunner::new(vec![
        Ok("abc\n".to_owned()),
        Ok(String::new()),
        Err(failed()),
        Ok(String::new()),
        Ok(String::new()),
    ]))))
}

fn invocations(runner: &FakeRunner) -> Vec<Invocation> {
    runner.invocations.lock().unwrap().clone()
}

fn stored(fixture: &Fixture) -> model::Task {
    lock(&fixture.storage)
        .get_task(fixture.task.id)
        .unwrap()
        .unwrap()
}

/// The fixture task, started in `w27` and then stripped of its worktree as when it is
/// removed in herdr.
fn lost_worktree() -> Fixture {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, _) = herdr(vec![Ok(CREATED.to_owned())]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    lock(&fixture.storage)
        .clear_task_worktree(fixture.task.id)
        .unwrap();
    fixture
}

const RECREATED: &str =
    r#"{"id":"cli:worktree:create","result":{"workspace":{"workspace_id":"w31"}}}"#;

fn herdr_failed(code: &str) -> Result<String, GitError> {
    Err(GitError::Failed {
        command: "herdr worktree".to_owned(),
        stderr: format!(r#"{{"error":{{"code":"{code}","message":"{code}"}}}}"#),
    })
}

/// A local task started in herdr workspace `w27` and then paused; `results` follow
/// the scripted `herdr worktree create`.
fn paused_task(results: Vec<Result<String, GitError>>) -> (Fixture, Herdr, Arc<FakeRunner>) {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(
        [Ok(CREATED.to_owned())]
            .into_iter()
            .chain(results)
            .collect(),
    );
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    lock(&fixture.storage)
        .set_task_status(fixture.task.id, TaskStatus::Planned)
        .unwrap();
    (fixture, herdr, runner)
}

/// A runtime that records its calls and answers them with `results` in order.
struct FakeRuntime {
    results: Mutex<Vec<Result<String, HerdrError>>>,
    calls: Mutex<Vec<String>>,
}

impl FakeRuntime {
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

impl TaskWorkspaceRuntime for FakeRuntime {
    fn create_worktree(
        &self,
        _machine: &Machine,
        worktree: &NewWorktree<'_>,
    ) -> Result<String, HerdrError> {
        self.answer(format!(
            "create {} {} {} {}",
            worktree.repository, worktree.path, worktree.branch, worktree.base
        ))
    }

    fn open_worktree(
        &self,
        _machine: &Machine,
        repository: &str,
        path: &str,
    ) -> Result<String, HerdrError> {
        self.answer(format!("open {repository} {path}"))
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

    fn close_workspace(&self, _machine: &Machine, workspace_id: &str) -> Result<(), HerdrError> {
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

fn no_git() -> Git {
    Git::new(Box::new(Arc::new(FakeRunner::new(Vec::new()))))
}
