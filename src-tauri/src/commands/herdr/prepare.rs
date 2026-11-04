//! Starting a task in its worktree and restoring the worktree of an active task.

use super::super::{CommandError, CommandResult, StorageState, lock};
use super::{git_managed, has_code};
use crate::adapters::git::{Git, GitError};
use crate::adapters::herdr::{Herdr, HerdrError, WORKTREE_NOT_FOUND};
use crate::adapters::task_runtime::TaskWorkspaceRuntime;
use crate::domain::criteria::{CheckKind, CriterionState};
use crate::domain::model::{self, Runner, WorkspaceLocation};
use crate::domain::naming::{self, TaskCheckout};
use crate::domain::runtime::{HostRef, OwnerKey, RunRole, RunState};
use crate::domain::status::TaskStatus;
use crate::runtime::{
    NoRunner, OpenFor, OpenWorktree, RunCommand, RuntimeError, RuntimeService, StartRun,
    TaskWorktree, end_runs,
};
use crate::storage::{CriterionCheck, StorageError};

/// Starts a task as [`start_task`] does. A task of a workspace with runner none moves to
/// `in_progress` with a run recorded through [`NoRunner`], which ends its earlier runs: it
/// gets no branch, worktree, or herdr workspace, and neither git nor herdr runs. A task of
/// a workspace with a git-managed runner (plain or tmux), local or on an SSH machine, gets
/// its branch and a git worktree like with herdr, but herdr never runs: git adds the worktree (reusing one already registered at its path),
/// and the task's earlier runs end. Its agents are started as runs of their own.
pub(crate) fn start(
    storage: &StorageState,
    git: &Git,
    runtime: &dyn TaskWorkspaceRuntime,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    let storage_state = storage;
    let (workspace, mut checkout, resumed, kept_worktree, start_unknown) = {
        let mut storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        if task.status == TaskStatus::InProgress {
            return Err(CommandError::rejected(format!(
                "task {id} is already in progress; keep working in its worktree, or restore its worktree in the Toodo app (or with the restore_worktree tool) if the directory is gone"
            )));
        }
        task.status
            .transition_to(TaskStatus::InProgress)
            .map_err(StorageError::from)?;
        storage.ensure_ready(id)?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        if workspace.runner == Runner::None {
            // The status changes under the lock, so a second start is rejected above.
            let started = storage.set_task_status(id, TaskStatus::InProgress)?;
            end_runs(&mut storage, id, None, RunState::Exited)?;
            let request = StartRun {
                owner: OwnerKey::implicit(),
                task: id,
                // Unique per task: a request key never comes back once its run is recorded.
                request_key: format!("start-{id}-{}", storage.list_task_runs(id)?.len() + 1),
                role: RunRole::Writer,
                host: HostRef::from(&workspace.location.machine()),
                checkout_path: None,
                runtime_workspace: None,
                adapter_profile: None,
                command: RunCommand::ByHand,
            };
            drop(storage);
            RuntimeService.start_run(storage_state, &NoRunner, request)?;
            return Ok(started);
        }
        let settings = storage.get_machine_settings(&workspace.location.machine())?;
        let mut checkout = naming::task_checkout(&workspace, &settings, &task)?;
        // A paused task keeps the branch it got when it first started.
        let resumed = task.branch.is_some();
        if let Some(branch) = task.branch {
            checkout.branch = branch;
        }
        // A local merge criterion tells merged work from a branch nobody committed to
        // by the commit the branch started at.
        let start_unknown: Vec<_> = task
            .criteria
            .iter()
            .filter(|criterion| {
                criterion.kind == CheckKind::BranchMergedLocally && criterion.target.is_none()
            })
            .map(|criterion| criterion.id)
            .collect();
        (
            workspace,
            checkout,
            resumed,
            task.worktree_path,
            start_unknown,
        )
    };
    let machine = workspace.location.machine();
    let repository = match &workspace.location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    };
    let target = TaskWorktree {
        task: id,
        machine: &machine,
        repository,
    };
    let plain = git_managed(workspace.runner);
    let kept_worktree = match kept_worktree {
        // git reuses the kept worktree, or checks the branch out there again if it is gone.
        Some(path) if plain => {
            checkout.path = path;
            None
        }
        kept => kept,
    };
    if let Some(path) = kept_worktree {
        let kept = TaskCheckout {
            path,
            branch: checkout.branch.clone(),
        };
        match RuntimeService.open_workspace(
            storage,
            runtime,
            &target,
            &kept,
            OpenWorktree::Existing,
            OpenFor::Start,
        ) {
            Ok(opened) => return Ok(opened.task),
            // The checkout was removed outside Toodo; check the branch out again below.
            Err(RuntimeError::Workspace(error)) if has_code(&error, WORKTREE_NOT_FOUND) => {}
            Err(error) => return Err(error.into()),
        }
    }
    let source = if resumed {
        let source = git.branch_source(&workspace.location, &checkout.branch)?;
        if source.is_none() {
            // Starting over from the base would hide that the earlier commits are gone.
            return Err(CommandError::rejected(format!(
                "branch {branch} of task {id} no longer exists in the repository or on origin, so resuming would start the task over from {base} without its earlier commits; push or recreate the branch and resume again (to start over on purpose: `git branch {branch} {base}` in the repository), or delete the task in the Toodo app",
                branch = checkout.branch,
                base = workspace.default_base_branch,
            )));
        }
        source
    } else {
        None
    };
    // herdr checks out an existing branch as is and ignores the base.
    let mut fetch_failure = None;
    let mut created_branch = false;
    let mut start_checks = Vec::new();
    let base = match source {
        Some(source) => source,
        None => {
            let base = &workspace.default_base_branch;
            git.create_initial_commit(&workspace.location, base)?;
            // A branch missing everywhere starts from the base like a new task; the bare
            // base may not exist locally (a clone with only origin/<base>).
            let start = git.task_branch_start(&workspace.location, base)?;
            created_branch =
                git.create_task_branch(&workspace.location, &checkout.branch, &start.start)?;
            if created_branch && !start_unknown.is_empty() {
                let commit = git
                    .commit_of(&workspace.location, &checkout.branch)
                    .inspect_err(|_| {
                        let _ = git.delete_branch(&workspace.location, &checkout.branch);
                    })?;
                start_checks = start_unknown
                    .iter()
                    .map(|&id| CriterionCheck {
                        id,
                        state: CriterionState::Pending,
                        evidence: None,
                        target: Some(commit.clone()),
                    })
                    .collect();
            }
            fetch_failure = start.fetch_failure;
            start.start
        }
    };
    let path = checkout.path.to_string();
    let mut started = if plain {
        // Only the remote-tracking branch is left: git needs a local one to check out.
        if resumed && base != checkout.branch {
            created_branch =
                git.create_task_branch(&workspace.location, &checkout.branch, &base)?;
        }
        if let Err(error) = git.add_worktree(&workspace.location, &checkout.path, &checkout.branch)
        {
            if created_branch {
                // The git error is what the user needs; a branch left behind is reused by
                // the next attempt.
                let _ = git.delete_branch(&workspace.location, &checkout.branch);
            }
            return Err(plain_worktree_error(error, id, &path));
        }
        let mut storage = lock(storage);
        let started = storage.start_task_plain(id, &checkout)?;
        end_runs(&mut storage, id, None, RunState::Exited)?;
        started
    } else {
        RuntimeService
            .open_workspace(
                storage,
                runtime,
                &target,
                &checkout,
                OpenWorktree::New { base: &base },
                OpenFor::Start,
            )
            .map_err(|error| match error {
                RuntimeError::Workspace(error) => {
                    if created_branch {
                        // The herdr error is what the user needs; a branch left behind is
                        // reused by the next attempt.
                        let _ = git.delete_branch(&workspace.location, &checkout.branch);
                    }
                    worktree_error(error, id, &path)
                }
                error => error.into(),
            })?
            .task
    };
    let mut storage = lock(storage);
    if !start_checks.is_empty() {
        started = storage.record_criterion_checks(id, &start_checks)?.0;
    }
    let Some(failure) = fetch_failure else {
        return Ok(started);
    };
    let note = format!(
        "Started from local {base} ({}) because fetching origin failed: {}",
        failure.commit, failure.error
    );
    Ok(storage.add_task_note(id, model::NoteKind::Progress, &note)?)
}

/// Names the next step when git refused to create a task's worktree because a directory
/// is already at its path; other herdr failures pass through.
fn worktree_error(error: HerdrError, id: model::TaskId, path: &str) -> CommandError {
    match &error {
        HerdrError::Failed { message, .. }
            if message.contains("' already exists") && !message.contains("branch named") =>
        {
            CommandError::rejected(format!(
                "a directory already exists at {path}, where the worktree of task {id} goes; move or remove that directory (or rename the task, which moves the path) and try again"
            ))
        }
        _ => error.into(),
    }
}

/// Names the next step when git refused to add the worktree of a task of a workspace with
/// runner plain because a directory is already at its path; other git failures pass
/// through.
fn plain_worktree_error(error: GitError, id: model::TaskId, path: &str) -> CommandError {
    match &error {
        GitError::Failed { stderr, .. } if stderr.contains("' already exists") => {
            CommandError::rejected(format!(
                "a directory already exists at {path}, where the worktree of task {id} goes; move or remove that directory (or rename the task, which moves the path) and try again"
            ))
        }
        _ => error.into(),
    }
}

pub(crate) fn restore(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    let (task, workspace) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        (task, workspace)
    };
    if workspace.runner == Runner::None && task.branch.is_none() {
        return Err(CommandError::rejected(format!(
            "task {id} belongs to workspace {}, which runs tasks without herdr (runner none), so it has no branch or worktree to restore; work on it in the workspace directory and complete it once its criteria are met",
            workspace.name
        )));
    }
    if matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview) {
        super::super::completion::clear_missing_worktree(storage, git, &task, &workspace)?;
    }
    let (workspace, checkout) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        if !matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview) {
            return Err(CommandError::rejected(format!(
                "task {id} is {}; only in progress or in review tasks can restore their worktree",
                task.status
            )));
        }
        if let Some(path) = &task.worktree_path {
            return Err(CommandError::rejected(format!(
                "task {id} already has its worktree at {path}; keep working in that worktree"
            )));
        }
        let branch = task
            .branch
            .clone()
            .ok_or_else(|| CommandError::rejected(format!("task {id} has no branch")))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        let settings = storage.get_machine_settings(&workspace.location.machine())?;
        // The title may have changed since the task started; the path follows it, the
        // branch keeps its name.
        let mut checkout = naming::task_checkout(&workspace, &settings, &task)?;
        checkout.branch = branch;
        (workspace, checkout)
    };
    let base = git
        .branch_source(&workspace.location, &checkout.branch)?
        .ok_or_else(|| {
            CommandError::rejected(format!(
                "branch {} of task {id} no longer exists in the repository or on origin",
                checkout.branch
            ))
        })?;
    let repository = match &workspace.location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    };
    let path = checkout.path.to_string();
    let machine = workspace.location.machine();
    let target = TaskWorktree {
        task: id,
        machine: &machine,
        repository,
    };
    let opened = RuntimeService
        .open_workspace(
            storage,
            herdr,
            &target,
            &checkout,
            OpenWorktree::New { base: &base },
            OpenFor::Restore,
        )
        .map_err(|error| match error {
            RuntimeError::Workspace(error) => worktree_error(error, id, &path),
            error => error.into(),
        })?;
    Ok(opened.task)
}
