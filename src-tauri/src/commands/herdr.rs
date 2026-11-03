//! Commands that drive herdr: the server health check, starting a task in a new
//! worktree, focusing the herdr workspace or agent pane of a started task, restoring the worktree of an
//! active task that lost it, and deleting a task together with its worktree.
//!
//! They run on the async runtime instead of the main thread because herdr calls can take
//! seconds. The database lock is not held while herdr runs.

use super::State;

use super::types::{HerdrStatus, Task, TaskId, TaskPane};
use super::{CommandError, CommandResult, GitState, HerdrState, StorageState, lock};
use crate::adapters::git::Git;
use crate::adapters::herdr::{AgentStatus, Herdr, HerdrError, NewWorktree, PaneAgent};
use crate::domain::criteria::{CheckKind, CriterionState};
use crate::domain::model::{self, Machine, WorkspaceLocation};
use crate::domain::naming;
use crate::domain::status::TaskStatus;
use crate::storage::{CriterionCheck, StorageError};

#[specta::specta]
pub fn herdr_status(herdr: State<'_, HerdrState>) -> CommandResult<HerdrStatus> {
    Ok((&herdr.server_status()?).into())
}

/// Creates the worktree of a `planned` task whose dependencies are done through herdr
/// and moves the task to `in_progress`. Requires a worktree root for the machine of the
/// task's workspace. An empty repository first gets an initial commit on the workspace's
/// base branch. A new task branch starts from the freshly fetched `origin/<base>` without an
/// upstream; without `origin`, or when the fetch fails (noted on the task), from the local
/// base. A paused task resumes on its branch, in its worktree if it still has one.
#[specta::specta]
pub fn start_task(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&start(&storage, &git, &herdr, id.into())?).into())
}

/// Makes sure herdr has the workspace of a started task open without focusing it, opening
/// the task's worktree again when herdr no longer has it, and lists the workspace's panes
/// for the pane view.
#[specta::specta]
pub fn ensure_task_workspace(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Vec<TaskPane>> {
    let found = ensure_workspace(&storage, &herdr, id.into())?;
    Ok(found.panes.iter().map(TaskPane::from).collect())
}

#[specta::specta]
pub fn open_task_in_herdr(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<()> {
    open(&storage, &herdr, id.into())
}

/// Focuses the pane of the agent working on a started task, the one that needs the user
/// most when its herdr workspace has several. Without a recognized agent it focuses the
/// workspace like [`open_task_in_herdr`].
#[specta::specta]
pub fn focus_agent_pane(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<()> {
    focus_agent(&storage, &herdr, id.into())
}

/// Closes the herdr workspace of a paused task, e.g. one that an agent paused through
/// MCP by adding a prerequisite, which leaves the workspace open for the user to decide.
/// The worktree is kept. Tasks that are worked on are rejected.
#[specta::specta]
pub fn close_task_workspace(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&close_workspace(&storage, &herdr, id.into())?).into())
}

/// Checks out the branch of an `in_progress` or `in_review` task that lost its worktree,
/// e.g. because it was removed in herdr, into a new worktree opened in herdr. The branch
/// is taken from `origin` when the repository no longer has it.
#[specta::specta]
pub fn restore_task_worktree(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&restore(&storage, &git, &herdr, id.into())?).into())
}

pub(crate) fn start(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    let (workspace, mut checkout, resumed, kept_worktree, start_unknown) = {
        let storage = lock(storage);
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
    if let Some(path) = kept_worktree {
        match herdr.open_worktree(&machine, repository, &path.to_string()) {
            Ok(herdr_workspace_id) => {
                checkout.path = path;
                return Ok(lock(storage).start_task(id, &checkout, &herdr_workspace_id)?);
            }
            // The checkout was removed outside Toodo; check the branch out again below.
            Err(error) if has_code(&error, WORKTREE_NOT_FOUND) => {}
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
    let herdr_workspace_id = herdr
        .create_worktree(
            &machine,
            &NewWorktree {
                repository,
                path: &path,
                branch: &checkout.branch,
                base: &base,
            },
        )
        .inspect_err(|_| {
            if created_branch {
                // The herdr error is what the user needs; a branch left behind is reused
                // by the next attempt.
                let _ = git.delete_branch(&workspace.location, &checkout.branch);
            }
        })
        .map_err(|error| worktree_error(error, id, &path))?;
    let mut storage = lock(storage);
    let mut started = storage.start_task(id, &checkout, &herdr_workspace_id)?;
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
    if matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview) {
        super::completion::clear_missing_worktree(storage, git, &task, &workspace)?;
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
    let herdr_workspace_id = herdr
        .create_worktree(
            &workspace.location.machine(),
            &NewWorktree {
                repository,
                path: &path,
                branch: &checkout.branch,
                base: &base,
            },
        )
        .map_err(|error| worktree_error(error, id, &path))?;
    Ok(lock(storage).restore_task_worktree(id, &checkout.path, &herdr_workspace_id)?)
}

/// Where the herdr workspace of a started task is.
struct TaskWorkspace {
    location: WorkspaceLocation,
    worktree_path: Option<model::HostPath>,
    herdr_workspace_id: String,
}

fn task_workspace(storage: &StorageState, id: model::TaskId) -> CommandResult<TaskWorkspace> {
    let storage = lock(storage);
    let task = storage
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    let herdr_workspace_id = task.herdr_workspace_id.ok_or_else(|| {
        CommandError::rejected(format!("task {id} has no herdr workspace; start it first"))
    })?;
    let workspace = storage
        .get_workspace(task.workspace_id)?
        .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
    Ok(TaskWorkspace {
        location: workspace.location,
        worktree_path: task.worktree_path,
        herdr_workspace_id,
    })
}

/// Opens the worktree of a task whose herdr workspace herdr no longer has, e.g. because
/// the user closed it, without focusing it, and remembers the new workspace. `missing` is
/// the error to report for a task without a worktree.
fn reopen(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
    target: &TaskWorkspace,
    missing: impl FnOnce() -> CommandError,
) -> CommandResult<String> {
    let Some(path) = &target.worktree_path else {
        return Err(missing());
    };
    let repository = match &target.location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    };
    let machine = target.location.machine();
    let reopened = herdr.open_worktree(&machine, repository, &path.to_string())?;
    lock(storage).set_task_herdr_workspace(id, &reopened)?;
    Ok(reopened)
}

/// Focuses the herdr workspace of a started task. When herdr no longer has it, the task's
/// worktree is opened again like [`ensure_workspace`] and then focused.
fn open(storage: &StorageState, herdr: &Herdr, id: model::TaskId) -> CommandResult<()> {
    let target = task_workspace(storage, id)?;
    let machine: Machine = target.location.machine();
    match herdr.focus_workspace(&machine, &target.herdr_workspace_id) {
        Err(error) if has_code(&error, WORKSPACE_NOT_FOUND) => {
            let reopened = reopen(storage, herdr, id, &target, || error.into())?;
            Ok(herdr.focus_workspace(&machine, &reopened)?)
        }
        result => Ok(result?),
    }
}

/// The herdr workspace of a started task with its panes.
#[derive(Debug)]
pub(crate) struct WorkspacePanes {
    pub machine: Machine,
    pub panes: Vec<PaneAgent>,
}

/// The panes of the herdr workspace of a started task, as herdr lists them now; none
/// when herdr no longer has the workspace.
pub(crate) fn task_panes(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<WorkspacePanes> {
    let target = task_workspace(storage, id)?;
    let machine = target.location.machine();
    let panes = workspace_panes(herdr, &machine, &target.herdr_workspace_id)?;
    Ok(WorkspacePanes { machine, panes })
}

fn workspace_panes(
    herdr: &Herdr,
    machine: &Machine,
    workspace_id: &str,
) -> Result<Vec<PaneAgent>, HerdrError> {
    Ok(herdr
        .list_panes(machine)?
        .into_iter()
        .filter(|pane| pane.workspace_id == workspace_id)
        .collect())
}

/// Makes sure herdr has the workspace of a started task open, without focusing it: a
/// workspace herdr no longer has (it lists none of its panes) is opened again from the
/// task's worktree. Returns the workspace's panes.
fn ensure_workspace(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<WorkspacePanes> {
    let found = task_panes(storage, herdr, id)?;
    if !found.panes.is_empty() {
        return Ok(found);
    }
    let target = task_workspace(storage, id)?;
    let reopened = reopen(storage, herdr, id, &target, || {
        CommandError::rejected(format!(
            "herdr no longer has the workspace of task {id}, and the task has no worktree to \
             open again"
        ))
    })?;
    let panes = workspace_panes(herdr, &found.machine, &reopened)?;
    Ok(WorkspacePanes {
        machine: found.machine,
        panes,
    })
}

fn focus_agent(storage: &StorageState, herdr: &Herdr, id: model::TaskId) -> CommandResult<()> {
    let (machine, herdr_workspace_id) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        let herdr_workspace_id = task.herdr_workspace_id.ok_or_else(|| {
            CommandError::rejected(format!("task {id} has no herdr workspace; start it first"))
        })?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        (workspace.location.machine(), herdr_workspace_id)
    };
    let pane = herdr
        .list_panes(&machine)?
        .into_iter()
        .filter(|pane| {
            pane.workspace_id == herdr_workspace_id && pane.status != AgentStatus::Unknown
        })
        // The first of the panes whose agent needs the user most.
        .rev()
        .max_by_key(|pane| pane.status);
    let Some(pane) = pane else {
        return open(storage, herdr, id);
    };
    match herdr.focus_agent(&machine, &pane.pane_id) {
        // The agent left the pane since it was listed.
        Err(error) if has_code(&error, AGENT_NOT_FOUND) => open(storage, herdr, id),
        result => Ok(result?),
    }
}

/// Deletes a task; a task that still has a worktree first removes it like
/// [`remove_worktree`], so a dirty worktree keeps the task unless `force` is set.
pub(super) fn delete(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
    force: bool,
) -> CommandResult<()> {
    let task = lock(storage)
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    if task.worktree_path.is_some() {
        remove_worktree(storage, herdr, id, force)?;
    }
    Ok(lock(storage).delete_task(id)?)
}

/// Removes the worktree of a task that is not in progress or in review (a finished task,
/// or a paused one) through herdr, which also closes
/// its herdr workspace, and forgets both on the task. The branch is kept. Without `force`,
/// a worktree with modified or untracked files is rejected.
fn remove_worktree(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
    force: bool,
) -> CommandResult<model::Task> {
    let (location, path, herdr_workspace_id) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        if matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview) {
            return Err(CommandError::rejected(format!(
                "task {id} is {}; in progress and in review tasks keep their worktree",
                task.status
            )));
        }
        let path = task
            .worktree_path
            .ok_or_else(|| CommandError::rejected(format!("task {id} has no worktree")))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        (
            workspace.location,
            path.to_string(),
            task.herdr_workspace_id,
        )
    };
    let machine = location.machine();
    let dirty = |error: HerdrError| {
        if has_code(&error, DIRTY_WORKTREE) {
            CommandError::rejected(format!(
                "the worktree of task {id} at {path} has modified or untracked files; \
                 force the removal to discard them"
            ))
        } else {
            error.into()
        }
    };
    let removed = match &herdr_workspace_id {
        Some(workspace_id) => match herdr.remove_worktree(&machine, workspace_id, force) {
            Ok(()) => true,
            Err(error) if has_code(&error, WORKSPACE_NOT_FOUND) => false,
            Err(error) => return Err(dirty(error)),
        },
        None => false,
    };
    // herdr no longer has the workspace, e.g. the user closed it or herdr lost its session,
    // but the checkout may still exist: open it again to remove it.
    if !removed {
        let repository = match &location {
            WorkspaceLocation::Local { path } => path.as_str(),
            WorkspaceLocation::Ssh { path, .. } => path.as_str(),
        };
        match herdr.open_worktree(&machine, repository, &path) {
            Ok(workspace_id) => herdr
                .remove_worktree(&machine, &workspace_id, force)
                .map_err(dirty)?,
            // The checkout is already gone.
            Err(error) if has_code(&error, WORKTREE_NOT_FOUND) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(lock(storage).clear_task_worktree(id)?)
}

/// Makes `id` depend on every task of `depends_on` for the app, where the user already
/// confirmed the pause. An `in_progress` task that a new prerequisite blocks is paused and
/// its herdr workspace closed like [`close_workspace`], keeping the worktree, so resuming
/// it opens the worktree again once the prerequisites are done. If closing fails, the
/// task stays paused and the error says so.
pub(super) fn add_dependencies(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
    depends_on: &[model::TaskId],
) -> CommandResult<model::Task> {
    let added = lock(storage).add_dependencies(id, depends_on)?;
    if !added.paused || added.task.herdr_workspace_id.is_none() {
        return Ok(added.task);
    }
    close_workspace(storage, herdr, id).map_err(|mut error| {
        error.message = format!(
            "task {id} was paused, but its herdr workspace was not closed: {}",
            error.message
        );
        error
    })
}

/// Closes the herdr workspace of a `planned` (paused) task and forgets it; the worktree
/// is kept, so resuming the task opens it again. A task without a workspace is returned
/// as is.
fn close_workspace(
    storage: &StorageState,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    let (location, workspace_id) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        if task.status != TaskStatus::Planned {
            return Err(CommandError::rejected(format!(
                "task {id} is being worked on; pause it before closing its herdr workspace"
            )));
        }
        let Some(workspace_id) = task.herdr_workspace_id else {
            return Ok(task);
        };
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        (workspace.location, workspace_id)
    };
    match herdr.close_workspace(&location.machine(), &workspace_id) {
        Ok(()) => {}
        // Already closed, e.g. by the user.
        Err(error) if has_code(&error, WORKSPACE_NOT_FOUND) => {}
        Err(error) => return Err(error.into()),
    }
    Ok(lock(storage).clear_task_herdr_workspace(id)?)
}

/// herdr API error codes that commands handle.
const DIRTY_WORKTREE: &str = "dirty_worktree_requires_force";
pub(super) const WORKSPACE_NOT_FOUND: &str = "workspace_not_found";
const WORKTREE_NOT_FOUND: &str = "worktree_not_found";
const AGENT_NOT_FOUND: &str = "agent_not_found";

pub(super) fn has_code(error: &HerdrError, expected: &str) -> bool {
    matches!(error, HerdrError::Failed { code: Some(code), .. } if code == expected)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::adapters::git::fake::{FakeRunner, failed};
    use crate::adapters::git::{GitError, Invocation};
    use crate::commands::CommandErrorKind;
    use crate::domain::model::{HostPath, MachineLabel, MachineSettings, TaskType};
    use crate::domain::path::{PosixPath, WindowsPath};
    use crate::storage::{NewTask, NewWorkspace, Storage};

    const CREATED: &str =
        r#"{"id":"cli:worktree:create","result":{"workspace":{"workspace_id":"w27"}}}"#;

    struct Fixture {
        storage: StorageState,
        task: model::Task,
    }

    fn fixture(location: WorkspaceLocation, settings: Option<MachineSettings>) -> Fixture {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "Toodo".to_owned(),
                location,
                default_base_branch: "main".to_owned(),
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

    #[test]
    fn restore_accepts_a_recorded_worktree_that_git_marks_missing() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (starter, _) = herdr(vec![Ok(CREATED.to_owned())]);
        start(
            &fixture.storage,
            &existing_base(),
            &starter,
            fixture.task.id,
        )
        .unwrap();
        let git = Git::new(Box::new(Arc::new(FakeRunner::new(vec![
            Ok("worktree D:/wt/toodo/feat-add-login-1\0HEAD abc\0prunable gitdir file points to non-existent location\0\0".to_owned()),
            Ok("abc\n".to_owned()),
        ]))));
        let (herdr, runner) = herdr(vec![Ok(RECREATED.to_owned())]);

        let task = restore(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        assert_eq!(task.herdr_workspace_id.as_deref(), Some("w31"));
        assert!(task.worktree_path.is_some());
        assert_eq!(task.status, TaskStatus::InProgress);
        assert_eq!(invocations(&runner).len(), 1);
    }

    #[test]
    fn starting_an_active_task_explains_how_to_keep_working_or_restore_it() {
        let fixture = lost_worktree();
        let (herdr, runner) = herdr(Vec::new());

        let error = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap_err();

        assert!(error.message.contains("task 1 is already in progress"));
        assert!(
            error
                .message
                .contains("restore its worktree in the Toodo app")
        );
        assert!(invocations(&runner).is_empty());
    }

    #[test]
    fn restore_checks_out_the_kept_branch_into_a_new_worktree() {
        let fixture = lost_worktree();
        let mut renamed = stored(&fixture);
        renamed.title = "Add sign-in".to_owned();
        lock(&fixture.storage).update_task(&renamed).unwrap();
        let (herdr, runner) = herdr(vec![Ok(RECREATED.to_owned())]);

        let restored =
            restore(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        assert_eq!(restored.status, TaskStatus::InProgress);
        assert_eq!(restored.branch.as_deref(), Some("feat/add-login-1"));
        assert_eq!(
            restored.worktree_path,
            Some(HostPath::Windows(
                WindowsPath::parse(r"D:\wt\toodo\feat-add-sign-in-1").unwrap()
            ))
        );
        assert_eq!(restored.herdr_workspace_id.as_deref(), Some("w31"));
        assert_eq!(stored(&fixture), restored);
        assert_eq!(
            invocations(&runner)[0].args[4..],
            [
                "--path",
                r"D:\wt\toodo\feat-add-sign-in-1",
                "--branch",
                "feat/add-login-1",
                "--base",
                "feat/add-login-1",
                "--no-focus",
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn restore_takes_a_branch_the_repository_lost_from_origin() {
        let fixture = lost_worktree();
        let git = Git::new(Box::new(Arc::new(FakeRunner::new(vec![
            Err(failed()),
            Ok("abc\n".to_owned()),
        ]))));
        let (herdr, runner) = herdr(vec![Ok(RECREATED.to_owned())]);

        restore(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        let args = &invocations(&runner)[0].args;
        assert_eq!(args[args.len() - 2], "origin/feat/add-login-1");
    }

    #[test]
    fn restore_is_rejected_without_a_lost_worktree_or_a_branch() {
        let gone = || {
            Git::new(Box::new(Arc::new(FakeRunner::new(vec![
                Err(failed()),
                Err(failed()),
            ]))))
        };
        let (herdr, runner) = herdr(Vec::new());

        let ready = local_fixture(Some(r"D:\wt"));
        let started = local_fixture(Some(r"D:\wt"));
        let (start_herdr, _) = self::herdr(vec![Ok(CREATED.to_owned())]);
        start(
            &started.storage,
            &existing_base(),
            &start_herdr,
            started.task.id,
        )
        .unwrap();
        let lost = lost_worktree();
        let existing = Git::new(Box::new(Arc::new(FakeRunner::new(vec![Ok(
            "worktree D:/wt/toodo/feat-add-login-1\0HEAD abc\0\0".to_owned(),
        )]))));
        for (fixture, git) in [(&ready, gone()), (&started, existing), (&lost, gone())] {
            let error = restore(&fixture.storage, &git, &herdr, fixture.task.id).unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::Rejected, "{}", error.message);
        }
        assert!(invocations(&runner).is_empty());
        assert_eq!(stored(&lost).worktree_path, None);
    }

    #[test]
    fn a_ready_task_starts_in_a_new_herdr_worktree() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        let started = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        assert_eq!(started.status, TaskStatus::InProgress);
        assert_eq!(started.branch.as_deref(), Some("feat/add-login-1"));
        assert_eq!(
            started.worktree_path,
            Some(HostPath::Windows(
                WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap()
            ))
        );
        assert_eq!(started.herdr_workspace_id.as_deref(), Some("w27"));
        assert_eq!(stored(&fixture), started);
        assert_eq!(
            invocations(&runner)[0].args,
            [
                "worktree",
                "create",
                "--cwd",
                r"C:\dev\toodo",
                "--path",
                r"D:\wt\toodo\feat-add-login-1",
                "--branch",
                "feat/add-login-1",
                "--base",
                "main",
                "--no-focus",
            ]
            .map(str::to_owned)
        );
    }

    /// The server's "Local" machine has POSIX paths: the worktree goes under a POSIX root
    /// and is stored and read back as one.
    #[test]
    fn a_task_of_a_posix_local_workspace_starts_under_the_posix_worktree_root() {
        let fixture = fixture(
            WorkspaceLocation::Local {
                path: PosixPath::parse("/home/me/dev/toodo").unwrap().into(),
            },
            Some(MachineSettings::Local {
                worktree_root: Some(PosixPath::parse("/home/me/wt").unwrap().into()),
            }),
        );
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        let started = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        assert_eq!(started.status, TaskStatus::InProgress);
        assert_eq!(
            started.worktree_path,
            Some(HostPath::Posix(
                PosixPath::parse("/home/me/wt/toodo/feat-add-login-1").unwrap()
            ))
        );
        assert_eq!(stored(&fixture), started);
        assert_eq!(
            invocations(&runner)[0].args[2..6],
            [
                "--cwd",
                "/home/me/dev/toodo",
                "--path",
                "/home/me/wt/toodo/feat-add-login-1",
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn an_empty_repository_gets_an_initial_commit_before_the_worktree() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let git_runner = Arc::new(FakeRunner::new(vec![
            Err(failed()),
            Err(failed()),
            Ok("origin\n".to_owned()),
            Ok(String::new()),
            Ok(String::new()),
            Ok(String::new()),
            Ok("origin\n".to_owned()),
            Ok(String::new()),
            Ok("def\n".to_owned()),
            Err(failed()),
            Ok(String::new()),
        ]));
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        let started = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        assert_eq!(started.status, TaskStatus::InProgress);
        let git_commands: Vec<String> = invocations(&git_runner)
            .iter()
            .map(|invocation| invocation.args[2..].join(" "))
            .collect();
        assert_eq!(
            git_commands[4],
            "commit --allow-empty --only -m Initial commit"
        );
        assert_eq!(git_commands[5], "push --set-upstream origin main");
        assert_eq!(invocations(&runner)[0].args[..2], ["worktree", "create"]);
    }

    #[test]
    fn a_failed_initial_commit_leaves_the_task_ready_without_running_herdr() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let git = Git::new(Box::new(Arc::new(FakeRunner::new(vec![
            Err(failed()),
            Err(failed()),
            Ok(String::new()),
            Ok(String::new()),
            Err(failed()),
        ]))));
        let (herdr, runner) = herdr(Vec::new());

        let error = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::External);
        assert_eq!(stored(&fixture), fixture.task);
        assert!(invocations(&runner).is_empty());
    }

    #[test]
    fn a_task_waiting_for_its_dependencies_does_not_start() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);
        {
            let mut storage = lock(&fixture.storage);
            let prerequisite = storage
                .create_task(&NewTask {
                    workspace_id: fixture.task.workspace_id,
                    task_type: TaskType::Feat,
                    title: "Add accounts".to_owned(),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: Vec::new(),
                })
                .unwrap();
            storage
                .add_dependency(fixture.task.id, prerequisite.id)
                .unwrap();
        }
        let before = stored(&fixture);

        let error = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("cannot start yet"));
        assert!(invocations(&runner).is_empty());
        assert_eq!(stored(&fixture), before);
    }

    #[test]
    fn ssh_tasks_start_on_their_machine() {
        let devbox = MachineLabel::parse("devbox").unwrap();
        let fixture = fixture(
            WorkspaceLocation::Ssh {
                machine: devbox.clone(),
                path: PosixPath::parse("/srv/toodo").unwrap().into(),
            },
            Some(MachineSettings::Ssh {
                machine: devbox,
                worktree_root: Some(PosixPath::parse("/wt").unwrap().into()),
            }),
        );
        let (herdr, runner) = herdr(vec![
            Ok(
                r#"[{"id":"m7","label":"devbox","target":"devbox","session":"default",
                "enabled":true,"selected":false}]"#
                    .to_owned(),
            ),
            Ok(CREATED.to_owned()),
        ]);

        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        assert_eq!(
            invocations(&runner)[1].args[..7],
            [
                "--machine",
                "m7",
                "worktree",
                "create",
                "--cwd",
                "/srv/toodo",
                "--path"
            ]
        );
        assert_eq!(
            invocations(&runner)[1].args[7],
            "/wt/toodo/feat-add-login-1"
        );
    }

    #[test]
    fn a_missing_worktree_root_is_reported_before_herdr_runs() {
        let fixture = local_fixture(None);
        let (herdr, runner) = herdr(Vec::new());

        let error = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert_eq!(error.message, "worktree root is not set for machine local");
        assert!(invocations(&runner).is_empty());
    }

    #[test]
    fn a_task_that_is_not_ready_is_rejected_before_herdr_runs() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        let error = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert_eq!(invocations(&runner).len(), 1);
    }

    #[test]
    fn a_herdr_failure_leaves_the_task_ready() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, _) = herdr(vec![Err(GitError::Failed {
            command: "herdr worktree create".to_owned(),
            stderr: r#"{"error":{"code":"worktree_create_failed","message":"fatal: invalid reference: main"}}"#.to_owned(),
        })]);

        let error = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::External);
        assert!(error.message.ends_with("fatal: invalid reference: main"));
        assert_eq!(stored(&fixture), fixture.task);
    }

    fn git_commands(runner: &FakeRunner) -> Vec<String> {
        invocations(runner)
            .iter()
            .map(|invocation| invocation.args[2..].join(" "))
            .collect()
    }

    fn herdr_base(runner: &FakeRunner) -> String {
        let args = invocations(runner).pop().unwrap().args;
        args[args.len() - 2].clone()
    }

    #[test]
    fn a_new_branch_starts_from_the_fetched_origin_base_without_an_upstream() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let git_runner = Arc::new(FakeRunner::new(vec![
            Ok("abc\n".to_owned()),
            Ok("origin\n".to_owned()),
            Ok(String::new()),
            Ok("def\n".to_owned()),
            Err(failed()),
            Ok(String::new()),
        ]));
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        let started = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        assert_eq!(
            git_commands(&git_runner),
            [
                "rev-parse --verify --quiet refs/heads/main",
                "remote",
                "fetch --quiet origin main",
                "rev-parse --verify --quiet refs/remotes/origin/main",
                "rev-parse --verify --quiet refs/heads/feat/add-login-1",
                "branch --no-track feat/add-login-1 origin/main",
            ]
        );
        assert_eq!(herdr_base(&runner), "origin/main");
        assert!(started.notes.is_empty());
    }

    #[test]
    fn a_repository_without_origin_starts_from_the_local_base() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let git_runner = Arc::new(FakeRunner::new(vec![
            Ok("abc\n".to_owned()),
            Ok("upstream\n".to_owned()),
            Err(failed()),
            Ok(String::new()),
        ]));
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        let started = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        let commands = git_commands(&git_runner);
        assert!(!commands.iter().any(|command| command.starts_with("fetch")));
        assert_eq!(commands[3], "branch --no-track feat/add-login-1 main");
        assert_eq!(herdr_base(&runner), "main");
        assert!(started.notes.is_empty());
    }

    #[test]
    fn a_base_that_origin_does_not_have_starts_from_the_local_base_without_a_note() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let git_runner = Arc::new(FakeRunner::new(vec![
            Ok("abc\n".to_owned()),
            Ok("origin\n".to_owned()),
            Err(failed()),
            Ok(String::new()),
            Err(failed()),
            Ok(String::new()),
        ]));
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        let started = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        assert_eq!(
            git_commands(&git_runner)[3],
            "ls-remote --heads origin refs/heads/main"
        );
        assert_eq!(herdr_base(&runner), "main");
        assert!(started.notes.is_empty());
    }

    #[test]
    fn a_failed_fetch_starts_from_the_local_base_and_notes_why() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let offline = || GitError::Failed {
            command: "git fetch --quiet origin main".to_owned(),
            stderr: "Could not resolve host: github.com".to_owned(),
        };
        let git_runner = Arc::new(FakeRunner::new(vec![
            Ok("abc\n".to_owned()),
            Ok("origin\n".to_owned()),
            Err(offline()),
            Err(offline()),
            Ok("e00697a\n".to_owned()),
            Err(failed()),
            Ok(String::new()),
        ]));
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        let started = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        assert_eq!(
            git_commands(&git_runner)[6],
            "branch --no-track feat/add-login-1 main"
        );
        assert_eq!(herdr_base(&runner), "main");
        assert_eq!(started.status, TaskStatus::InProgress);
        let notes: Vec<_> = started
            .notes
            .iter()
            .map(|note| (note.kind, note.body.as_str()))
            .collect();
        assert_eq!(
            notes,
            [(
                model::NoteKind::Progress,
                "Started from local main (e00697a) because fetching origin failed: \
                 `git fetch --quiet origin main` failed: Could not resolve host: github.com"
            )]
        );
        assert_eq!(stored(&fixture), started);
        // MCP start_task replies with the same task, note included.
        let reply = serde_json::to_value(super::super::types::Task::from(&started)).unwrap();
        assert_eq!(
            reply["notes"][0]["body"],
            "Started from local main (e00697a) because fetching origin failed: \
             `git fetch --quiet origin main` failed: Could not resolve host: github.com"
        );
    }

    #[test]
    fn a_herdr_failure_deletes_the_branch_it_created() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let git_runner = Arc::new(FakeRunner::new(vec![
            Ok("abc\n".to_owned()),
            Ok(String::new()),
            Err(failed()),
            Ok(String::new()),
            Ok(String::new()),
        ]));
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, _) = herdr(vec![herdr_failed("worktree_create_failed")]);

        start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap_err();

        assert_eq!(
            git_commands(&git_runner).last().unwrap(),
            "branch -D feat/add-login-1"
        );
        assert_eq!(stored(&fixture), fixture.task);
    }

    #[test]
    fn an_existing_branch_is_checked_out_as_is() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let git_runner = Arc::new(FakeRunner::new(vec![
            Ok("abc\n".to_owned()),
            Ok(String::new()),
            Ok("fed\n".to_owned()),
        ]));
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, _) = herdr(vec![herdr_failed("worktree_create_failed")]);

        start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap_err();

        // Neither created nor deleted: the branch is not Toodo's to remove.
        assert!(
            !git_commands(&git_runner)
                .iter()
                .any(|command| command.starts_with("branch"))
        );
    }

    #[test]
    fn a_resumed_task_neither_fetches_nor_moves_its_branch() {
        let (fixture, _, _) = paused_task(Vec::new());
        lock(&fixture.storage)
            .clear_task_worktree(fixture.task.id)
            .unwrap();
        let git_runner = Arc::new(FakeRunner::new(vec![Ok("abc\n".to_owned())]));
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, runner) = herdr(vec![Ok(RECREATED.to_owned())]);

        let resumed = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        assert_eq!(resumed.status, TaskStatus::InProgress);
        assert_eq!(
            git_commands(&git_runner),
            ["rev-parse --verify --quiet refs/heads/feat/add-login-1"]
        );
        assert_eq!(herdr_base(&runner), "feat/add-login-1");
    }

    #[test]
    fn resuming_a_task_whose_branch_is_gone_everywhere_is_rejected() {
        let (fixture, _, _) = paused_task(Vec::new());
        lock(&fixture.storage)
            .clear_task_worktree(fixture.task.id)
            .unwrap();
        let git = Git::new(Box::new(Arc::new(FakeRunner::new(vec![
            Err(failed()),
            Err(failed()),
        ]))));
        let (herdr, runner) = herdr(Vec::new());

        let error = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("git branch feat/add-login-1"),
            "{}",
            error.message
        );
        assert!(invocations(&runner).is_empty());
        let task = lock(&fixture.storage)
            .get_task(fixture.task.id)
            .unwrap()
            .unwrap();
        assert_eq!(task.status, TaskStatus::Planned);
    }

    #[test]
    fn a_directory_in_the_way_of_a_worktree_names_the_next_step() {
        let fixture = lost_worktree();
        let git = Git::new(Box::new(Arc::new(FakeRunner::new(vec![Ok(
            "abc\n".to_owned()
        )]))));
        let (herdr, _) = herdr(vec![Err(GitError::Failed {
            command: "herdr worktree create".to_owned(),
            stderr: "fatal: '/wt/feat-add-login-1' already exists".to_owned(),
        })]);

        let error = restore(&fixture.storage, &git, &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("move or remove that directory"),
            "{}",
            error.message
        );
    }

    /// Runs real git with the placeholder workspace path replaced by a real directory, so a
    /// Windows workspace path works on every platform.
    struct MappedRunner {
        placeholder: &'static str,
        dir: String,
    }

    impl crate::adapters::git::Runner for MappedRunner {
        fn run(&self, invocation: &Invocation) -> Result<String, GitError> {
            crate::adapters::git::ProcessRunner.run(&Invocation {
                program: invocation.program,
                args: invocation
                    .args
                    .iter()
                    .map(|arg| arg.replace(self.placeholder, &self.dir))
                    .collect(),
            })
        }
    }

    fn real_git(dir: &std::path::Path, args: &[&str]) -> Result<String, String> {
        let output = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=Toodo Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).into_owned())
        }
    }

    #[test]
    fn a_new_branch_contains_what_was_merged_into_origin_since_the_last_pull() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let origin = root.join("origin.git");
        let origin_url = origin.to_str().unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| real_git(dir, args).unwrap();
        git(
            root,
            &["init", "--bare", "--initial-branch=main", origin_url],
        );
        let seed = root.join("seed");
        git(root, &["clone", "--quiet", origin_url, "seed"]);
        git(&seed, &["commit", "--allow-empty", "-m", "First"]);
        git(&seed, &["push", "--quiet", "origin", "HEAD:main"]);
        git(root, &["clone", "--quiet", origin_url, "workspace"]);
        git(root, &["clone", "--quiet", origin_url, "other"]);
        let workspace = root.join("workspace");
        let other = root.join("other");
        git(
            &other,
            &["commit", "--allow-empty", "-m", "Merged elsewhere"],
        );
        git(&other, &["push", "--quiet", "origin", "main"]);
        let merged = git(&other, &["rev-parse", "HEAD"]);
        let local_main = git(&workspace, &["rev-parse", "refs/heads/main"]);

        let fixture = local_fixture(Some(r"D:\wt"));
        let git_adapter = Git::new(Box::new(MappedRunner {
            placeholder: r"C:\dev\toodo",
            dir: workspace.to_str().unwrap().to_owned(),
        }));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        let started = start(&fixture.storage, &git_adapter, &herdr, fixture.task.id).unwrap();

        assert!(started.notes.is_empty(), "{:?}", started.notes);
        assert_eq!(herdr_base(&runner), "origin/main");
        let branch = "feat/add-login-1";
        git(
            &workspace,
            &["merge-base", "--is-ancestor", &merged, branch],
        );
        let upstream = format!("{branch}@{{upstream}}");
        assert!(real_git(&workspace, &["rev-parse", "--abbrev-ref", &upstream]).is_err());
        assert_eq!(
            git(&workspace, &["rev-parse", "refs/heads/main"]),
            local_main
        );
        assert_eq!(
            git(&workspace, &["symbolic-ref", "--short", "HEAD"]),
            "main"
        );
        assert_eq!(git(&workspace, &["status", "--porcelain"]), "");
    }

    #[test]
    fn a_clone_without_a_local_base_branch_starts_and_reads_commits_from_origin() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let origin = root.join("origin.git");
        let origin_url = origin.to_str().unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| real_git(dir, args).unwrap();
        git(
            root,
            &["init", "--bare", "--initial-branch=main", origin_url],
        );
        let seed = root.join("seed");
        git(root, &["clone", "--quiet", origin_url, "seed"]);
        git(&seed, &["commit", "--allow-empty", "-m", "First"]);
        git(&seed, &["push", "--quiet", "origin", "HEAD:main"]);
        git(root, &["clone", "--quiet", origin_url, "workspace"]);
        let workspace = root.join("workspace");
        // Leave only origin/main, as in a clone whose local base branch was never created.
        git(&workspace, &["checkout", "--quiet", "--detach"]);
        git(&workspace, &["branch", "-D", "main"]);
        assert!(real_git(&workspace, &["rev-parse", "--verify", "refs/heads/main"]).is_err());

        let fixture = local_fixture(Some(r"D:\wt"));
        let git_adapter = Git::new(Box::new(MappedRunner {
            placeholder: r"C:\dev\toodo",
            dir: workspace.to_str().unwrap().to_owned(),
        }));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);

        start(&fixture.storage, &git_adapter, &herdr, fixture.task.id).unwrap();

        assert_eq!(herdr_base(&runner), "origin/main");
        let branch = "feat/add-login-1";
        git(&workspace, &["checkout", "--quiet", branch]);
        git(&workspace, &["commit", "--allow-empty", "-m", "Work"]);
        let location = WorkspaceLocation::Local {
            path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
        };
        let commits = git_adapter
            .commits_between(&location, r"C:\dev\toodo", "main", branch)
            .unwrap();
        assert_eq!(
            commits
                .iter()
                .map(|c| c.message.as_str())
                .collect::<Vec<_>>(),
            ["Work"]
        );
    }

    const REMOVED: &str = r#"{"id":"cli:worktree:remove","result":{"type":"worktree_removed"}}"#;

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

    #[test]
    fn a_paused_task_removes_its_worktree_and_keeps_its_branch() {
        let (fixture, herdr, runner) = paused_task(vec![Ok(REMOVED.to_owned())]);

        let task = remove_worktree(&fixture.storage, &herdr, fixture.task.id, false).unwrap();

        assert_eq!(
            (&task.worktree_path, &task.herdr_workspace_id),
            (&None, &None)
        );
        assert_eq!(task.branch.as_deref(), Some("feat/add-login-1"));
        assert_eq!(task.status, TaskStatus::Planned);
        assert_eq!(stored(&fixture), task);
        assert_eq!(
            invocations(&runner)[1].args,
            ["worktree", "remove", "--workspace", "w27"].map(str::to_owned)
        );
    }

    #[test]
    fn a_dirty_worktree_is_kept_unless_forced() {
        let (fixture, herdr, runner) = paused_task(vec![
            herdr_failed("dirty_worktree_requires_force"),
            Ok(REMOVED.to_owned()),
        ]);
        let before = stored(&fixture);

        let error = remove_worktree(&fixture.storage, &herdr, fixture.task.id, false).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains(r"D:\wt\toodo\feat-add-login-1"));
        assert_eq!(stored(&fixture), before);

        remove_worktree(&fixture.storage, &herdr, fixture.task.id, true).unwrap();
        assert_eq!(
            invocations(&runner)[2].args,
            ["worktree", "remove", "--workspace", "w27", "--force"].map(str::to_owned)
        );
        assert_eq!(stored(&fixture).worktree_path, None);
    }

    #[test]
    fn a_worktree_herdr_no_longer_has_open_is_opened_again_to_remove_it() {
        let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w40"}}}"#;
        let (fixture, herdr, runner) = paused_task(vec![
            herdr_failed("workspace_not_found"),
            Ok(opened.to_owned()),
            Ok(REMOVED.to_owned()),
        ]);

        remove_worktree(&fixture.storage, &herdr, fixture.task.id, false).unwrap();

        let invocations = invocations(&runner);
        assert_eq!(
            invocations[2].args,
            [
                "worktree",
                "open",
                "--cwd",
                r"C:\dev\toodo",
                "--path",
                r"D:\wt\toodo\feat-add-login-1",
                "--no-focus",
            ]
            .map(str::to_owned)
        );
        assert_eq!(
            invocations[3].args,
            ["worktree", "remove", "--workspace", "w40"].map(str::to_owned)
        );
        assert_eq!(stored(&fixture).worktree_path, None);
    }

    #[test]
    fn a_worktree_that_is_already_gone_is_only_forgotten() {
        let (fixture, herdr, runner) = paused_task(vec![
            herdr_failed("workspace_not_found"),
            herdr_failed("worktree_not_found"),
        ]);

        let task = remove_worktree(&fixture.storage, &herdr, fixture.task.id, false).unwrap();

        assert_eq!(
            (&task.worktree_path, &task.herdr_workspace_id),
            (&None, &None)
        );
        assert_eq!(invocations(&runner).len(), 3);
    }

    #[test]
    fn other_herdr_failures_keep_the_worktree() {
        let (fixture, herdr, _) = paused_task(vec![herdr_failed("worktree_remove_failed")]);
        let before = stored(&fixture);

        let error = remove_worktree(&fixture.storage, &herdr, fixture.task.id, false).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::External);
        assert_eq!(stored(&fixture), before);
    }

    #[test]
    fn only_tasks_not_being_worked_on_with_a_worktree_remove_it() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);
        let id = fixture.task.id;

        let error = remove_worktree(&fixture.storage, &herdr, id, false).unwrap_err();
        assert_eq!(error.message, format!("task {id} has no worktree"));

        let fixture = local_fixture(Some(r"D:\wt"));
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
        let error = remove_worktree(&fixture.storage, &herdr, fixture.task.id, false).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains("in progress and in review tasks keep")
        );
        assert_eq!(invocations(&runner).len(), 1);
    }

    #[test]
    fn a_paused_task_restarts_in_its_kept_worktree() {
        let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w27"}}}"#;
        let (fixture, herdr, runner) = paused_task(vec![Ok(opened.to_owned())]);
        let mut renamed = stored(&fixture);
        renamed.title = "Add sign-in".to_owned();
        lock(&fixture.storage).update_task(&renamed).unwrap();
        let git = Git::new(Box::new(Arc::new(FakeRunner::new(Vec::new()))));

        let restarted = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

        assert_eq!(restarted.status, TaskStatus::InProgress);
        assert_eq!(restarted.branch.as_deref(), Some("feat/add-login-1"));
        assert_eq!(
            restarted.worktree_path,
            Some(HostPath::Windows(
                WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap()
            ))
        );
        assert_eq!(restarted.herdr_workspace_id.as_deref(), Some("w27"));
        assert_eq!(
            invocations(&runner)[1].args,
            [
                "worktree",
                "open",
                "--cwd",
                r"C:\dev\toodo",
                "--path",
                r"D:\wt\toodo\feat-add-login-1",
                "--no-focus",
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn a_paused_task_without_its_worktree_checks_its_branch_out_again() {
        let (fixture, herdr, runner) = paused_task(vec![
            herdr_failed("worktree_not_found"),
            Ok(RECREATED.to_owned()),
        ]);

        let restarted = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        assert_eq!(restarted.status, TaskStatus::InProgress);
        assert_eq!(restarted.herdr_workspace_id.as_deref(), Some("w31"));
        assert_eq!(
            invocations(&runner)[2].args[4..],
            [
                "--path",
                r"D:\wt\toodo\feat-add-login-1",
                "--branch",
                "feat/add-login-1",
                "--base",
                "feat/add-login-1",
                "--no-focus",
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn deleting_a_task_removes_its_worktree_first() {
        let (fixture, herdr, runner) = paused_task(vec![Ok(REMOVED.to_owned())]);

        delete(&fixture.storage, &herdr, fixture.task.id, false).unwrap();

        assert_eq!(
            invocations(&runner)[1].args,
            ["worktree", "remove", "--workspace", "w27"].map(str::to_owned)
        );
        assert_eq!(
            lock(&fixture.storage).get_task(fixture.task.id).unwrap(),
            None
        );
    }

    #[test]
    fn a_dirty_worktree_keeps_the_task_unless_the_delete_is_forced() {
        let (fixture, herdr, runner) = paused_task(vec![
            herdr_failed("dirty_worktree_requires_force"),
            Ok(REMOVED.to_owned()),
        ]);
        let before = stored(&fixture);

        let error = delete(&fixture.storage, &herdr, fixture.task.id, false).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert_eq!(stored(&fixture), before);

        delete(&fixture.storage, &herdr, fixture.task.id, true).unwrap();
        assert_eq!(
            invocations(&runner)[2].args,
            ["worktree", "remove", "--workspace", "w27", "--force"].map(str::to_owned)
        );
        assert_eq!(
            lock(&fixture.storage).get_task(fixture.task.id).unwrap(),
            None
        );
    }

    #[test]
    fn deleting_a_task_without_a_worktree_does_not_run_herdr() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(Vec::new());

        delete(&fixture.storage, &herdr, fixture.task.id, false).unwrap();

        assert!(invocations(&runner).is_empty());
        assert_eq!(
            lock(&fixture.storage).get_task(fixture.task.id).unwrap(),
            None
        );
    }

    #[test]
    fn open_focuses_the_herdr_workspace_of_a_started_task() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned()), Ok(String::new())]);

        let error = open(&fixture.storage, &herdr, fixture.task.id).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);

        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
        open(&fixture.storage, &herdr, fixture.task.id).unwrap();
        assert_eq!(
            invocations(&runner)[1].args,
            ["workspace", "focus", "w27"].map(str::to_owned)
        );
    }

    #[test]
    fn open_reopens_a_worktree_whose_herdr_workspace_is_gone() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w40"}}}"#;
        let (herdr, runner) = herdr(vec![
            Ok(CREATED.to_owned()),
            herdr_failed("workspace_not_found"),
            Ok(opened.to_owned()),
            Ok(String::new()),
        ]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        open(&fixture.storage, &herdr, fixture.task.id).unwrap();

        let invocations = invocations(&runner);
        assert_eq!(invocations[2].args[..2], ["worktree", "open"]);
        assert_eq!(
            invocations[3].args,
            ["workspace", "focus", "w40"].map(str::to_owned)
        );
        assert_eq!(stored(&fixture).herdr_workspace_id.as_deref(), Some("w40"));
    }

    fn pane_list(panes: &[(&str, &str, &str)]) -> Result<String, GitError> {
        let rows: Vec<String> = panes
            .iter()
            .map(|(pane_id, workspace_id, status)| {
                format!(
                    r#"{{"agent_status":"{status}","pane_id":"{pane_id}","workspace_id":"{workspace_id}"}}"#
                )
            })
            .collect();
        Ok(format!(
            r#"{{"id":"cli:pane:list","result":{{"panes":[{}]}}}}"#,
            rows.join(",")
        ))
    }

    #[test]
    fn ensure_lists_the_panes_of_an_open_workspace_without_focusing_it() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![
            Ok(CREATED.to_owned()),
            pane_list(&[
                ("w9:p1", "w9", "blocked"),
                ("w27:p1", "w27", "working"),
                ("w27:p2", "w27", "unknown"),
            ]),
        ]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        let found = ensure_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap();

        let panes: Vec<&str> = found
            .panes
            .iter()
            .map(|pane| pane.pane_id.as_str())
            .collect();
        assert_eq!(panes, ["w27:p1", "w27:p2"]);
        assert_eq!(found.machine, Machine::Local);
        assert_eq!(invocations(&runner).len(), 2);
    }

    #[test]
    fn ensure_reopens_a_workspace_herdr_no_longer_has_without_focusing_it() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w40"}}}"#;
        let (herdr, runner) = herdr(vec![
            Ok(CREATED.to_owned()),
            pane_list(&[("w9:p1", "w9", "idle")]),
            Ok(opened.to_owned()),
            pane_list(&[("w9:p1", "w9", "idle"), ("w40:p1", "w40", "unknown")]),
        ]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        let found = ensure_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap();

        let panes: Vec<&str> = found
            .panes
            .iter()
            .map(|pane| pane.pane_id.as_str())
            .collect();
        assert_eq!(panes, ["w40:p1"]);
        let invocations = invocations(&runner);
        assert_eq!(invocations[2].args[..2], ["worktree", "open"]);
        assert!(invocations[2].args.contains(&"--no-focus".to_owned()));
        assert!(
            !invocations
                .iter()
                .any(|invocation| invocation.args.contains(&"focus".to_owned()))
        );
        assert_eq!(stored(&fixture).herdr_workspace_id.as_deref(), Some("w40"));
    }

    #[test]
    fn ensure_rejects_a_task_without_a_workspace() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(Vec::new());
        let error = ensure_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(invocations(&runner).is_empty());
    }

    #[test]
    fn focus_agent_focuses_the_pane_whose_agent_needs_the_user_most() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![
            Ok(CREATED.to_owned()),
            pane_list(&[
                ("w9:p1", "w9", "blocked"),
                ("w27:p1", "w27", "working"),
                ("w27:p2", "w27", "blocked"),
                ("w27:p3", "w27", "blocked"),
                ("w27:p4", "w27", "unknown"),
            ]),
            Ok(String::new()),
        ]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        focus_agent(&fixture.storage, &herdr, fixture.task.id).unwrap();

        let invocations = invocations(&runner);
        assert_eq!(invocations[1].args, ["pane", "list"].map(str::to_owned));
        assert_eq!(
            invocations[2].args,
            ["agent", "focus", "w27:p2"].map(str::to_owned)
        );
    }

    #[test]
    fn focus_agent_focuses_the_workspace_without_an_agent_pane() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![
            Ok(CREATED.to_owned()),
            pane_list(&[("w27:p1", "w27", "unknown")]),
            Ok(String::new()),
            pane_list(&[("w27:p1", "w27", "idle")]),
            herdr_failed("agent_not_found"),
            Ok(String::new()),
        ]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        focus_agent(&fixture.storage, &herdr, fixture.task.id).unwrap();
        focus_agent(&fixture.storage, &herdr, fixture.task.id).unwrap();

        let invocations = invocations(&runner);
        let focus_workspace = ["workspace", "focus", "w27"].map(str::to_owned);
        assert_eq!(invocations[2].args, focus_workspace);
        assert_eq!(
            invocations[4].args,
            ["agent", "focus", "w27:p1"].map(str::to_owned)
        );
        assert_eq!(invocations[5].args, focus_workspace);
    }

    #[test]
    fn focus_agent_rejects_a_task_without_a_herdr_workspace() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(Vec::new());

        let error = focus_agent(&fixture.storage, &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(invocations(&runner).is_empty());
    }

    /// A task of the fixture's workspace that has not started.
    fn other_task(fixture: &Fixture, title: &str) -> model::Task {
        lock(&fixture.storage)
            .create_task(&NewTask {
                workspace_id: fixture.task.workspace_id,
                task_type: TaskType::Fix,
                title: title.to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap()
    }

    #[test]
    fn a_blocking_prerequisite_pauses_the_task_and_resuming_reopens_its_worktree() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w41"}}}"#;
        let (herdr, runner) = herdr(vec![
            Ok(CREATED.to_owned()),
            Ok(r#"{"id":"cli:workspace:close","result":{"type":"ok"}}"#.to_owned()),
            Ok(opened.to_owned()),
        ]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
        let fix = other_task(&fixture, "Fix login");

        let paused =
            add_dependencies(&fixture.storage, &herdr, fixture.task.id, &[fix.id]).unwrap();

        assert_eq!(paused.status, TaskStatus::Planned);
        assert_eq!(paused.herdr_workspace_id, None);
        assert_eq!(
            paused.worktree_path.map(|path| path.to_string()).as_deref(),
            Some(r"D:\wt\toodo\feat-add-login-1")
        );
        assert_eq!(
            invocations(&runner)[1].args,
            ["workspace", "close", "w27"].map(str::to_owned)
        );
        let error = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert_eq!(invocations(&runner).len(), 2);

        {
            let mut storage = lock(&fixture.storage);
            for status in [
                TaskStatus::InProgress,
                TaskStatus::InReview,
                TaskStatus::Done,
            ] {
                storage.set_task_status(fix.id, status).unwrap();
            }
        }
        let resumed = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        assert_eq!(resumed.status, TaskStatus::InProgress);
        assert_eq!(resumed.herdr_workspace_id.as_deref(), Some("w41"));
        assert_eq!(invocations(&runner)[2].args[..2], ["worktree", "open"]);
    }

    #[test]
    fn a_herdr_workspace_that_is_already_closed_still_pauses_the_task() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, _) = herdr(vec![
            Ok(CREATED.to_owned()),
            herdr_failed("workspace_not_found"),
        ]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
        let fix = other_task(&fixture, "Fix login");

        let paused =
            add_dependencies(&fixture.storage, &herdr, fixture.task.id, &[fix.id]).unwrap();

        assert_eq!(paused.status, TaskStatus::Planned);
        assert_eq!(paused.herdr_workspace_id, None);
    }

    #[test]
    fn a_failed_close_keeps_the_task_paused_and_says_so() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, _) = herdr(vec![Ok(CREATED.to_owned()), herdr_failed("server_error")]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
        let fix = other_task(&fixture, "Fix login");

        let error =
            add_dependencies(&fixture.storage, &herdr, fixture.task.id, &[fix.id]).unwrap_err();

        assert!(
            error
                .message
                .contains("was paused, but its herdr workspace was not closed")
        );
        assert_eq!(stored(&fixture).status, TaskStatus::Planned);
        assert_eq!(stored(&fixture).herdr_workspace_id.as_deref(), Some("w27"));
    }

    #[test]
    fn a_prerequisite_of_a_task_that_keeps_going_leaves_herdr_alone() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
        let follow_up = other_task(&fixture, "Follow up");

        add_dependencies(&fixture.storage, &herdr, follow_up.id, &[fixture.task.id]).unwrap();

        assert_eq!(stored(&fixture).status, TaskStatus::InProgress);
        assert_eq!(invocations(&runner).len(), 1);
    }

    /// A started task paused without closing its herdr workspace w27, as MCP leaves it.
    fn paused_with_workspace(
        results: Vec<Result<String, GitError>>,
    ) -> (Fixture, Herdr, Arc<FakeRunner>) {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr([vec![Ok(CREATED.to_owned())], results].concat());
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
        lock(&fixture.storage)
            .set_task_status(fixture.task.id, TaskStatus::Planned)
            .unwrap();
        (fixture, herdr, runner)
    }

    #[test]
    fn closing_the_workspace_of_a_paused_task_keeps_its_worktree() {
        let (fixture, herdr, runner) = paused_with_workspace(vec![Ok(
            r#"{"id":"cli:workspace:close","result":{"type":"ok"}}"#.to_owned(),
        )]);

        let closed = close_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap();

        assert_eq!(
            invocations(&runner)[1].args,
            ["workspace", "close", "w27"].map(str::to_owned)
        );
        assert_eq!(closed.status, TaskStatus::Planned);
        assert_eq!(closed.herdr_workspace_id, None);
        assert!(closed.worktree_path.is_some());
        assert_eq!(stored(&fixture), closed);
    }

    #[test]
    fn a_workspace_already_closed_in_herdr_is_forgotten() {
        let (fixture, herdr, _) = paused_with_workspace(vec![herdr_failed("workspace_not_found")]);

        let closed = close_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap();

        assert_eq!(closed.herdr_workspace_id, None);
    }

    #[test]
    fn the_workspace_of_a_task_being_worked_on_is_not_closed() {
        let fixture = local_fixture(Some(r"D:\wt"));
        let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);
        start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

        let error = close_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert_eq!(invocations(&runner).len(), 1);
        assert_eq!(stored(&fixture).herdr_workspace_id.as_deref(), Some("w27"));
    }
}
