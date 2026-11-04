//! Commands for workspaces and per-machine settings.

use super::State;

use super::types::{
    self, BranchList, MachineSettings, NewWorkspace, RepositorySetup, Workspace, WorkspaceId,
    WorkspaceSetup,
};
use super::{CommandError, CommandResult, GitState, HerdrState, StorageState, lock};
use crate::adapters::git::Git;
use crate::adapters::herdr::Herdr;
use crate::domain::model;
use crate::domain::status::TaskStatus;
use crate::runtime::RuntimeService;
use crate::storage::{self, StorageError};

#[specta::specta]
pub fn list_workspaces(storage: State<'_, StorageState>) -> CommandResult<Vec<Workspace>> {
    Ok(types::map_all(&lock(&storage).list_workspaces()?))
}

#[specta::specta]
pub fn get_workspace(
    storage: State<'_, StorageState>,
    id: WorkspaceId,
) -> CommandResult<Workspace> {
    let workspace = lock(&storage)
        .get_workspace(id.into())?
        .ok_or(StorageError::WorkspaceNotFound(id.into()))?;
    Ok((&workspace).into())
}

/// Clones the repository or checks the existing one, opens it as a herdr workspace, then
/// saves the workspace. Git and herdr run on a blocking thread because a clone can take
/// minutes.
#[specta::specta]
pub async fn create_workspace(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    herdr: State<'_, HerdrState>,
    workspace: NewWorkspace,
) -> CommandResult<Workspace> {
    let setup: WorkspaceSetup = workspace.try_into()?;
    let existing = lock(&storage).list_workspaces()?;
    let git = GitState::clone(&git);
    let herdr = HerdrState::clone(&herdr);
    let new =
        tokio::task::spawn_blocking(move || prepare_workspace(&git, &herdr, setup, &existing))
            .await
            .map_err(|error| {
                CommandError::internal(format!("workspace setup panicked: {error}"))
            })??;
    Ok((&save_workspace(&mut lock(&storage), &new)?).into())
}

/// Creates a workspace as [`create_workspace`] does, running git and herdr on the calling
/// thread; for callers already off the async runtime, such as the MCP tools.
pub(crate) fn create(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    setup: WorkspaceSetup,
) -> CommandResult<model::Workspace> {
    let existing = lock(storage).list_workspaces()?;
    let new = prepare_workspace(git, herdr, setup, &existing)?;
    save_workspace(&mut lock(storage), &new)
}

/// Saves a prepared workspace unless one added meanwhile already uses its location.
fn save_workspace(
    storage: &mut storage::Storage,
    new: &storage::NewWorkspace,
) -> CommandResult<model::Workspace> {
    ensure_unused(&storage.list_workspaces()?, &new.location)?;
    Ok(storage.create_workspace(new)?)
}

/// Rejects a location that one of `workspaces` already uses.
fn ensure_unused(
    workspaces: &[model::Workspace],
    location: &model::WorkspaceLocation,
) -> CommandResult<()> {
    match workspaces
        .iter()
        .find(|workspace| same_location(&workspace.location, location))
    {
        Some(workspace) => Err(CommandError::rejected(format!(
            "workspace {} ({}) already uses {}",
            workspace.name,
            workspace.id.0,
            location_path(&workspace.location)
        ))),
        None => Ok(()),
    }
}

fn location_path(location: &model::WorkspaceLocation) -> &str {
    match location {
        model::WorkspaceLocation::Local { path } => path.as_str(),
        model::WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    }
}

/// Whether two locations name the same directory; Windows paths are case-insensitive.
fn same_location(a: &model::WorkspaceLocation, b: &model::WorkspaceLocation) -> bool {
    use model::{HostPath, WorkspaceLocation};
    let same_path = |a: &HostPath, b: &HostPath| match (a, b) {
        (HostPath::Windows(a), HostPath::Windows(b)) => {
            a.as_str().to_lowercase() == b.as_str().to_lowercase()
        }
        _ => a == b,
    };
    match (a, b) {
        (WorkspaceLocation::Local { path: a }, WorkspaceLocation::Local { path: b }) => {
            same_path(a, b)
        }
        (
            WorkspaceLocation::Ssh {
                machine: a_machine,
                path: a,
            },
            WorkspaceLocation::Ssh {
                machine: b_machine,
                path: b,
            },
        ) => a_machine == b_machine && same_path(a, b),
        _ => false,
    }
}

/// Brings the repository to the workspace location, resolves the base branch, the
/// source, completion, and runner, and opens the repository in herdr for runner herdr
/// unless a herdr workspace already has it open. A location one of the `existing`
/// workspaces uses is rejected before git clones into it and, for an opened repository,
/// again once git found its root, before herdr runs. A workspace with source none runs
/// neither git nor herdr: its location is kept as given, with no base branch.
fn prepare_workspace(
    git: &Git,
    herdr: &Herdr,
    setup: WorkspaceSetup,
    existing: &[model::Workspace],
) -> CommandResult<storage::NewWorkspace> {
    ensure_unused(existing, &setup.location)?;
    if let Some(runner) = setup.runner {
        model::check_runner_location(runner, &setup.location)
            .map_err(|error| CommandError::invalid_input(error.0))?;
    }
    let Some(repository) = setup.repository else {
        let (source, completion, runner) =
            resolve_axes(model::Source::None, setup.completion, setup.runner)?;
        return Ok(storage::NewWorkspace {
            name: setup.name,
            location: setup.location,
            default_base_branch: String::new(),
            source,
            completion,
            runner,
            axes_detected: true,
        });
    };
    // A source given up front is checked before git clones or creates anything.
    if let Some(source) = setup.source {
        resolve_axes(source, setup.completion, setup.runner)?;
    }
    let path = location_path(&setup.location).to_owned();
    // Whether the repository has an origin remote, where its setup tells.
    let (location, origin) = match repository {
        RepositorySetup::Clone { url } => {
            git.clone_repository(&url, &setup.location)
                .map_err(|error| setup_failed(error, || format!(
                    "could not clone {url} into {path}"
                ), "check the URL and your access to it (SSH key or gh auth), and that the directory does not exist yet or is empty"))?;
            (setup.location, Some(true))
        }
        RepositorySetup::Open => {
            let root = git.repository_root(&setup.location).map_err(|error| {
                setup_failed(
                    error,
                    || format!("could not open a git repository at {path}"),
                    "choose a directory inside an existing clone, clone the repository there instead (clone_url, or Clone in the app), or make it a new repository (init: true, or New repository in the app)",
                )
            })?;
            (root, None)
        }
        RepositorySetup::Init => {
            let branch = setup.default_base_branch.as_deref().unwrap_or("main");
            let failed = |error| {
                setup_failed(
                    error,
                    || format!("could not make a new git repository at {path}"),
                    "check that the parent directory exists and that you can write to it",
                )
            };
            git.init_repository(&setup.location, branch)
                .map_err(failed)?;
            (
                git.repository_root(&setup.location).map_err(failed)?,
                Some(false),
            )
        }
    };
    ensure_unused(existing, &location)?;
    let default_base_branch = match setup.default_base_branch {
        Some(branch) => branch,
        None => git.default_branch(&location)?.ok_or_else(|| {
            CommandError::invalid_input(
                "could not detect the default branch of the repository; enter a base branch",
            )
        })?,
    };
    let has_origin = |origin: Option<bool>| match origin {
        Some(known) => Ok(known),
        None => git.has_origin(&location),
    };
    let source = match setup.source {
        Some(model::Source::GitHub) => {
            if !has_origin(origin)? {
                return Err(CommandError::invalid_input(format!(
                    "the repository at {} has no origin remote for source github; choose \
                     source local_git, or add the GitHub repository as its origin remote \
                     first (git remote add origin <url>)",
                    location_path(&location)
                )));
            }
            model::Source::GitHub
        }
        Some(source) => source,
        None if has_origin(origin)? => model::Source::GitHub,
        None => model::Source::LocalGit,
    };
    // An omitted runner of a local git workspace falls back to plain when herdr cannot
    // run, so a server without herdr still creates workspaces.
    let (source, completion, mut runner) = resolve_axes(source, setup.completion, setup.runner)?;
    if setup.runner.is_none()
        && matches!(location, model::WorkspaceLocation::Local { .. })
        && !herdr.server_status().is_ok_and(|status| status.running)
    {
        runner = model::Runner::Plain;
        model::check_axes(source, completion, runner)
            .map_err(|error| CommandError::invalid_input(error.0))?;
    }
    if runner == model::Runner::Herdr {
        RuntimeService.open_repository(
            herdr,
            &location.machine(),
            location_path(&location),
            &setup.name,
        )?;
    }
    Ok(storage::NewWorkspace {
        name: setup.name,
        location,
        default_base_branch,
        source,
        completion,
        runner,
        axes_detected: true,
    })
}

/// The axes of a new workspace with `source`: the given completion and runner, or the
/// defaults of the source, rejected unless they work together.
fn resolve_axes(
    source: model::Source,
    completion: Option<model::CompletionMode>,
    runner: Option<model::Runner>,
) -> CommandResult<(model::Source, model::CompletionMode, model::Runner)> {
    let completion = completion.unwrap_or_else(|| model::default_completion(source));
    let runner = runner.unwrap_or_else(|| model::default_runner(source));
    model::check_axes(source, completion, runner)
        .map_err(|error| CommandError::invalid_input(error.0))?;
    Ok((source, completion, runner))
}

/// A git failure while setting up a workspace, as what was attempted and the next step,
/// with git's own output last for diagnosis.
fn setup_failed(
    error: crate::adapters::git::GitError,
    attempted: impl FnOnce() -> String,
    next_step: &str,
) -> CommandError {
    let error = CommandError::from(error);
    CommandError {
        kind: error.kind,
        message: format!("{}; {next_step}. git said: {}", attempted(), error.message),
    }
}

/// Saves the name, default base branch, agent merge policy, completion, and runner of an
/// existing workspace. Its location is kept, [`move_workspace`] changes it; its source is
/// kept as created. The runner cannot change while a task is being worked on.
#[specta::specta]
pub fn update_workspace(
    storage: State<'_, StorageState>,
    workspace: Workspace,
) -> CommandResult<Workspace> {
    let mut storage = lock(&storage);
    let id = workspace.id.into();
    let stored = storage
        .get_workspace(id)?
        .ok_or(StorageError::WorkspaceNotFound(id))?;
    let workspace = workspace.into_model(&stored)?;
    ensure_runner_can_change(&storage, &stored, workspace.runner)?;
    storage.update_workspace(&workspace)?;
    Ok((&workspace).into())
}

/// Saves every setting of an existing workspace as [`update_workspace`] does and, with
/// `location`, moves it there first as [`move_workspace`] does; for callers already off
/// the async runtime, such as the MCP tools. Everything is checked before herdr opens the
/// repository or anything is saved: the new location must hold a repository no other
/// workspace uses, and a new base branch, or the base branch at a new location, must
/// exist there. The repository is opened in herdr when the workspace moves or switches to
/// runner herdr.
pub(crate) fn update(
    storage: &StorageState,
    git: &Git,
    herdr: &Herdr,
    workspace: Workspace,
    location: Option<model::WorkspaceLocation>,
) -> CommandResult<model::Workspace> {
    let id = workspace.id.into();
    let (stored, others) = with_others(&lock(storage), id)?;
    let target = match location {
        Some(target) => model::Workspace {
            location: locate(git, stored.source, workspace.runner.into(), &others, target)?,
            ..stored.clone()
        },
        None => stored.clone(),
    };
    let updated = workspace.into_model(&target)?;
    ensure_runner_can_change(&lock(storage), &stored, updated.runner)?;
    let moved = updated.location != stored.location;
    if updated.source != model::Source::None
        && (moved || updated.default_base_branch != stored.default_base_branch)
    {
        ensure_base_branch(git, &updated)?;
    }
    if updated.runner == model::Runner::Herdr && (moved || stored.runner != model::Runner::Herdr) {
        RuntimeService.open_repository(
            herdr,
            &updated.location.machine(),
            location_path(&updated.location),
            &updated.name,
        )?;
    }
    let mut storage = lock(storage);
    let (_, others) = with_others(&storage, id)?;
    ensure_unused(&others, &updated.location)?;
    ensure_runner_can_change(&storage, &stored, updated.runner)?;
    if moved {
        RuntimeService.move_workspace(&mut storage, &updated)?;
    } else {
        storage.update_workspace(&updated)?;
    }
    Ok(updated)
}

/// Workspace `id` and every other workspace.
fn with_others(
    storage: &storage::Storage,
    id: model::WorkspaceId,
) -> CommandResult<(model::Workspace, Vec<model::Workspace>)> {
    let workspace = storage
        .get_workspace(id)?
        .ok_or(StorageError::WorkspaceNotFound(id))?;
    let others = storage
        .list_workspaces()?
        .into_iter()
        .filter(|other| other.id != id)
        .collect();
    Ok((workspace, others))
}

/// Rejects switching `stored` to `runner` while one of its tasks is in progress or in
/// review or still has an open runtime workspace: its worktree and agents belong to the
/// current runner.
fn ensure_runner_can_change(
    storage: &storage::Storage,
    stored: &model::Workspace,
    runner: model::Runner,
) -> CommandResult<()> {
    if runner == stored.runner {
        return Ok(());
    }
    for task in storage.list_tasks(stored.id)? {
        let active = matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview);
        if active || storage.open_runtime_workspace(task.id)?.is_some() {
            return Err(CommandError::rejected(format!(
                "the runner of workspace {} cannot change from {} to {runner} while task {} \
                 is being worked on with it; complete or conclude that task first, or keep \
                 runner {} and change the other settings",
                stored.id.0, stored.runner, task.id.0, stored.runner
            )));
        }
    }
    Ok(())
}

/// Rejects a default base branch that the repository of `workspace` has neither as a
/// local branch nor as an `origin` remote-tracking branch.
fn ensure_base_branch(git: &Git, workspace: &model::Workspace) -> CommandResult<()> {
    let branch = &workspace.default_base_branch;
    if git.branch_source(&workspace.location, branch)?.is_some() {
        return Ok(());
    }
    Err(CommandError::invalid_input(format!(
        "branch {branch} does not exist in the repository at {}, neither locally nor as \
         origin/{branch}; set default_base_branch to a branch that exists there, such as the \
         repository's default branch, or push {branch} first",
        location_path(&workspace.location)
    )))
}

/// The repository root at `target` for a workspace with `source` and `runner`, or
/// `target` itself for source none. Rejected when one of `others` uses it, when the
/// runner cannot run there, or when `target` is not inside a git repository.
fn locate(
    git: &Git,
    source: model::Source,
    runner: model::Runner,
    others: &[model::Workspace],
    target: model::WorkspaceLocation,
) -> CommandResult<model::WorkspaceLocation> {
    ensure_unused(others, &target)?;
    model::check_runner_location(runner, &target)
        .map_err(|error| CommandError::invalid_input(error.0))?;
    if source == model::Source::None {
        return Ok(target);
    }
    let root = git.repository_root(&target).map_err(|error| {
        setup_failed(
            error,
            || {
                format!(
                    "could not open a git repository at {}",
                    location_path(&target)
                )
            },
            "choose the directory of the workspace's repository clone",
        )
    })?;
    ensure_unused(others, &root)?;
    Ok(root)
}

/// Moves a workspace to the repository at `location`, e.g. one kept with a Windows path
/// from the desktop app to the Windows host it lives on, keeping its tasks. The location
/// must hold a git repository that no other workspace uses; it is opened in herdr like a
/// new workspace. A workspace with source none moves to the directory as given, and one
/// with runner none is not opened in herdr. Git and herdr may run over `ssh`, so they run
/// on a blocking thread.
#[specta::specta]
pub async fn move_workspace(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    herdr: State<'_, HerdrState>,
    id: WorkspaceId,
    location: types::WorkspaceLocation,
) -> CommandResult<Workspace> {
    let id = id.into();
    let target: model::WorkspaceLocation = location.try_into()?;
    let (workspace, others) = with_others(&lock(&storage), id)?;
    let git = GitState::clone(&git);
    let herdr = HerdrState::clone(&herdr);
    let name = workspace.name.clone();
    let (source, runner) = (workspace.source, workspace.runner);
    let location = tokio::task::spawn_blocking(move || -> CommandResult<_> {
        let root = locate(&git, source, runner, &others, target)?;
        if runner == model::Runner::Herdr {
            RuntimeService.open_repository(
                &*herdr,
                &root.machine(),
                location_path(&root),
                &name,
            )?;
        }
        Ok(root)
    })
    .await
    .map_err(|error| CommandError::internal(format!("workspace move panicked: {error}")))??;
    let moved = model::Workspace {
        location,
        ..workspace
    };
    let mut storage = lock(&storage);
    ensure_unused(&with_others(&storage, id)?.1, &moved.location)?;
    RuntimeService.move_workspace(&mut storage, &moved)?;
    Ok((&moved).into())
}

/// Branches of the workspace repository to pick a base branch from: local and `origin`
/// branches after fetching `origin`. Git may run over `ssh`, so this runs off the main
/// thread.
#[specta::specta]
pub fn list_workspace_branches(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    id: WorkspaceId,
) -> CommandResult<BranchList> {
    let id = id.into();
    let location = lock(&storage)
        .get_workspace(id)?
        .ok_or(StorageError::WorkspaceNotFound(id))?
        .location;
    Ok(git.list_branches(&location)?.into())
}

/// Creates branch `name` from the existing branch `from` in the workspace repository,
/// pushes it to `origin`, and makes it the default base branch of the workspace.
#[specta::specta]
pub fn create_workspace_base_branch(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    id: WorkspaceId,
    name: String,
    from: String,
) -> CommandResult<Workspace> {
    let workspace = create_base_branch(&storage, &git, id.into(), name.trim(), from.trim())?;
    Ok((&workspace).into())
}

fn create_base_branch(
    storage: &StorageState,
    git: &Git,
    id: model::WorkspaceId,
    name: &str,
    from: &str,
) -> CommandResult<model::Workspace> {
    let workspace = {
        let storage = lock(storage);
        let workspace = storage
            .get_workspace(id)?
            .ok_or(StorageError::WorkspaceNotFound(id))?;
        // Checked before git runs so a locked workspace gets no stray branch.
        if let Some(task) = storage
            .list_tasks(id)?
            .into_iter()
            .filter(|task| task.status == TaskStatus::InReview)
            .min_by_key(|task| task.id.0)
        {
            return Err(StorageError::BaseBranchInReview {
                workspace: id,
                task: task.id,
            }
            .into());
        }
        workspace
    };
    let repo = &workspace.location;
    if !git.is_valid_branch_name(repo, name)? {
        return Err(CommandError::invalid_input(format!(
            "{name:?} is not a valid branch name"
        )));
    }
    if git.branch_source(repo, name)?.is_some() {
        return Err(CommandError::rejected(format!(
            "branch {name} already exists; pick it from the list"
        )));
    }
    let start = git
        .branch_source(repo, from)?
        .ok_or_else(|| CommandError::rejected(format!("branch {from} does not exist")))?;
    git.create_branch(repo, name, &start)?;
    let workspace = model::Workspace {
        default_base_branch: name.to_owned(),
        ..workspace
    };
    lock(storage).update_workspace(&workspace)?;
    Ok(workspace)
}

/// Deletes a workspace together with its tasks, dependencies, and commit records.
#[specta::specta]
pub fn delete_workspace(storage: State<'_, StorageState>, id: WorkspaceId) -> CommandResult<()> {
    Ok(lock(&storage).delete_workspace(id.into())?)
}

#[specta::specta]
pub fn get_machine_settings(
    storage: State<'_, StorageState>,
    machine: types::Machine,
) -> CommandResult<MachineSettings> {
    machine_settings(&lock(&storage), machine)
}

/// The settings of `machine`, shared by the app command and the MCP tools.
pub(crate) fn machine_settings(
    storage: &storage::Storage,
    machine: types::Machine,
) -> CommandResult<MachineSettings> {
    let machine = machine.try_into()?;
    Ok((&storage.get_machine_settings(&machine)?).into())
}

#[specta::specta]
pub fn save_machine_settings(
    storage: State<'_, StorageState>,
    settings: MachineSettings,
) -> CommandResult<MachineSettings> {
    save_settings(&mut lock(&storage), settings)
}

/// Validates the worktree root for its machine (a local path of the build, or a POSIX
/// path on an SSH machine) and saves it; shared by the app command and the MCP tools.
pub(crate) fn save_settings(
    storage: &mut storage::Storage,
    settings: MachineSettings,
) -> CommandResult<MachineSettings> {
    let settings: model::MachineSettings = settings.try_into()?;
    storage.save_machine_settings(&settings)?;
    Ok((&settings).into())
}

/// Detects the source and completion of each workspace whose axes are not known yet
/// (`axes_detected = 0`, e.g. after the migration that added them found nothing to infer
/// them from): github + pr_merge when its repository has an `origin` remote, else
/// local_git + local_merge. A detected pair the workspace runner rules out (see
/// [`model::check_axes`]) keeps the stored axes. A git failure leaves the workspace for
/// the next start. Git runs without the database lock. Returns how many workspaces were
/// detected.
pub fn detect_axes(storage: &StorageState, git: &Git) -> usize {
    let workspaces = match lock(storage).workspaces_to_detect() {
        Ok(workspaces) => workspaces,
        Err(error) => {
            eprintln!("toodo: failed to list workspaces to detect: {error}");
            return 0;
        }
    };
    let mut detected = 0;
    for workspace in workspaces {
        let origin = match git.has_origin(&workspace.location) {
            Ok(origin) => origin,
            Err(error) => {
                eprintln!(
                    "toodo: workspace {}: source and completion stay as stored until the next start, since git failed: {error}",
                    workspace.id.0
                );
                continue;
            }
        };
        let (source, completion) = if origin {
            (
                model::Source::GitHub,
                model::CompletionMode::PullRequestMerge,
            )
        } else {
            (model::Source::LocalGit, model::CompletionMode::LocalMerge)
        };
        let (source, completion) = match model::check_axes(source, completion, workspace.runner) {
            Ok(()) => (source, completion),
            Err(_) => (workspace.source, workspace.completion),
        };
        match lock(storage).save_detected_axes(workspace.id, source, completion) {
            Ok(()) => detected += 1,
            Err(error) => eprintln!(
                "toodo: workspace {}: failed to save its detected source and completion: {error}",
                workspace.id.0
            ),
        }
    }
    detected
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::adapters::git::fake::{FakeRunner, failed};
    use crate::adapters::git::{GitError, Invocation};
    use crate::commands::CommandErrorKind;
    use crate::domain::path::WindowsPath;

    fn local(path: &str) -> model::WorkspaceLocation {
        model::WorkspaceLocation::Local {
            path: WindowsPath::parse(path).unwrap().into(),
        }
    }

    fn setup(repository: RepositorySetup, branch: Option<&str>) -> WorkspaceSetup {
        WorkspaceSetup {
            name: "toodo".to_owned(),
            location: local(r"C:\dev\toodo\src"),
            repository: Some(repository),
            source: None,
            completion: None,
            runner: None,
            default_base_branch: branch.map(str::to_owned),
        }
    }

    /// `herdr workspace list` output without the repository, then `herdr workspace create`.
    fn herdr_opens_a_new_workspace() -> Vec<Result<String, GitError>> {
        vec![
            Ok(r#"{"id":"cli:workspace:list","result":{"workspaces":[]}}"#.to_owned()),
            Ok(
                r#"{"id":"cli:workspace:create","result":{"workspace":{"workspace_id":"w9"}}}"#
                    .to_owned(),
            ),
        ]
    }

    /// `herdr status --json` of a running server, which a local workspace with an omitted
    /// runner asks for, then the replies of [`herdr_opens_a_new_workspace`].
    fn herdr_runs_and_opens_a_new_workspace() -> Vec<Result<String, GitError>> {
        std::iter::once(Ok(r#"{"server":{"running":true}}"#.to_owned()))
            .chain(herdr_opens_a_new_workspace())
            .collect()
    }

    struct Prepared {
        result: CommandResult<storage::NewWorkspace>,
        invocations: Vec<Invocation>,
        herdr_invocations: Vec<Invocation>,
    }

    fn prepare(
        setup: WorkspaceSetup,
        results: Vec<Result<String, GitError>>,
        herdr_results: Vec<Result<String, GitError>>,
    ) -> Prepared {
        let runner = Arc::new(FakeRunner::new(results));
        let herdr_runner = Arc::new(FakeRunner::new(herdr_results));
        let result = prepare_workspace(
            &Git::new(Box::new(runner.clone())),
            &Herdr::new(Box::new(herdr_runner.clone())),
            setup,
            &[],
        );
        Prepared {
            result,
            invocations: runner.invocations.lock().unwrap().clone(),
            herdr_invocations: herdr_runner.invocations.lock().unwrap().clone(),
        }
    }

    #[test]
    fn open_uses_the_repository_root_and_detects_the_base_branch() {
        let prepared = prepare(
            setup(RepositorySetup::Open, None),
            vec![
                Ok("C:/dev/toodo\n".to_owned()),
                Ok("origin/main\n".to_owned()),
                Ok("origin\n".to_owned()),
            ],
            herdr_runs_and_opens_a_new_workspace(),
        );
        let new = prepared.result.unwrap();
        assert_eq!(new.location, local(r"C:\dev\toodo"));
        assert_eq!(new.default_base_branch, "main");
        assert_eq!(
            (new.source, new.completion, new.runner),
            (
                model::Source::GitHub,
                model::CompletionMode::PullRequestMerge,
                model::Runner::Herdr
            )
        );
        assert_eq!(
            prepared.invocations[2].args[2..],
            ["remote"].map(str::to_owned)
        );
        assert_eq!(prepared.invocations[1].args[..2], ["-C", r"C:\dev\toodo"]);
        assert_eq!(
            prepared.herdr_invocations[2].args,
            [
                "workspace",
                "create",
                "--cwd",
                r"C:\dev\toodo",
                "--label",
                "toodo",
                "--no-focus",
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn a_windows_ssh_workspace_with_runner_tmux_is_rejected_before_git_or_herdr_runs() {
        let prepared = prepare(
            WorkspaceSetup {
                location: model::WorkspaceLocation::Ssh {
                    machine: model::MachineLabel::parse("devbox").unwrap(),
                    path: crate::domain::path::WindowsPath::parse(r"C:\toodo")
                        .unwrap()
                        .into(),
                },
                runner: Some(model::Runner::Tmux),
                ..setup(RepositorySetup::Open, None)
            },
            Vec::new(),
            Vec::new(),
        );

        let error = prepared.result.unwrap_err();
        assert!(
            error.message.contains("choose runner plain or herdr"),
            "{error:?}"
        );
        assert!(prepared.invocations.is_empty());
        assert!(prepared.herdr_invocations.is_empty());
    }

    #[test]
    fn a_local_workspace_with_runner_plain_is_not_opened_in_herdr() {
        let prepared = prepare(
            WorkspaceSetup {
                runner: Some(model::Runner::Plain),
                ..setup(RepositorySetup::Open, None)
            },
            vec![
                Ok("C:/dev/toodo\n".to_owned()),
                Ok("origin/main\n".to_owned()),
                Ok("origin\n".to_owned()),
            ],
            Vec::new(),
        );

        let new = prepared.result.unwrap();
        assert_eq!(
            (new.source, new.completion, new.runner),
            (
                model::Source::GitHub,
                model::CompletionMode::PullRequestMerge,
                model::Runner::Plain
            )
        );
        assert!(prepared.herdr_invocations.is_empty());
    }

    #[test]
    fn an_omitted_runner_defaults_to_plain_when_herdr_cannot_be_run() {
        let prepared = prepare(
            setup(RepositorySetup::Open, None),
            vec![
                Ok("C:/dev/toodo\n".to_owned()),
                Ok("origin/main\n".to_owned()),
                Ok("origin\n".to_owned()),
            ],
            vec![Err(GitError::Spawn {
                program: "herdr".to_owned(),
                message: "No such file or directory (os error 2)".to_owned(),
            })],
        );

        assert_eq!(prepared.result.unwrap().runner, model::Runner::Plain);
        assert_eq!(prepared.herdr_invocations.len(), 1);
        assert_eq!(
            prepared.herdr_invocations[0].args,
            ["status", "--json"].map(str::to_owned)
        );
    }

    #[test]
    fn an_omitted_runner_defaults_to_herdr_when_herdr_is_running() {
        let prepared = prepare(
            setup(RepositorySetup::Open, None),
            vec![
                Ok("C:/dev/toodo\n".to_owned()),
                Ok("origin/main\n".to_owned()),
                Ok("origin\n".to_owned()),
            ],
            herdr_runs_and_opens_a_new_workspace(),
        );

        assert_eq!(prepared.result.unwrap().runner, model::Runner::Herdr);
        assert_eq!(prepared.herdr_invocations.len(), 3);
    }

    fn storage_with_workspace() -> (StorageState, model::WorkspaceId) {
        let mut storage = crate::storage::Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&storage::NewWorkspace {
                name: "toodo".to_owned(),
                location: local(r"C:\dev\toodo"),
                default_base_branch: "main".to_owned(),
                source: model::Source::GitHub,
                completion: model::CompletionMode::PullRequestMerge,
                runner: model::Runner::Herdr,
                axes_detected: true,
            })
            .unwrap();
        (std::sync::Mutex::new(storage), workspace.id)
    }

    fn create(
        storage: &StorageState,
        id: model::WorkspaceId,
        name: &str,
        results: Vec<Result<String, GitError>>,
    ) -> (CommandResult<model::Workspace>, Vec<Invocation>) {
        let runner = Arc::new(FakeRunner::new(results));
        let result = create_base_branch(
            storage,
            &Git::new(Box::new(runner.clone())),
            id,
            name,
            "main",
        );
        let invocations = runner.invocations.lock().unwrap().clone();
        (result, invocations)
    }

    fn base_branch(storage: &StorageState, id: model::WorkspaceId) -> String {
        lock(storage)
            .get_workspace(id)
            .unwrap()
            .unwrap()
            .default_base_branch
    }

    #[test]
    fn a_new_base_branch_starts_from_the_given_branch_and_becomes_the_base() {
        let (storage, id) = storage_with_workspace();
        let (result, invocations) = create(
            &storage,
            id,
            "release",
            vec![
                Ok("release\n".to_owned()),
                Err(failed()),
                Err(failed()),
                Err(failed()),
                Ok("abc\n".to_owned()),
                Ok(String::new()),
                Ok("origin\n".to_owned()),
                Ok(String::new()),
            ],
        );
        assert_eq!(result.unwrap().default_base_branch, "release");
        assert_eq!(base_branch(&storage, id), "release");
        assert_eq!(
            invocations[5].args[2..],
            ["branch", "--no-track", "release", "origin/main"].map(str::to_owned)
        );
    }

    #[test]
    fn an_invalid_or_existing_branch_name_creates_nothing() {
        let (storage, id) = storage_with_workspace();
        let (result, invocations) = create(&storage, id, "bad..name", vec![Err(failed())]);
        assert_eq!(result.unwrap_err().kind, CommandErrorKind::InvalidInput);
        assert_eq!(invocations.len(), 1);

        let (result, invocations) = create(
            &storage,
            id,
            "dev",
            vec![
                Ok("dev\n".to_owned()),
                Err(failed()),
                Ok("abc\n".to_owned()),
            ],
        );
        assert_eq!(result.unwrap_err().kind, CommandErrorKind::Rejected);
        assert_eq!(invocations.len(), 3);
        assert_eq!(base_branch(&storage, id), "main");
    }

    #[test]
    fn a_missing_start_branch_is_rejected() {
        let (storage, id) = storage_with_workspace();
        let (result, invocations) = create(
            &storage,
            id,
            "release",
            vec![
                Ok("release\n".to_owned()),
                Err(failed()),
                Err(failed()),
                Err(failed()),
                Err(failed()),
            ],
        );
        assert_eq!(result.unwrap_err().kind, CommandErrorKind::Rejected);
        assert_eq!(invocations.len(), 5);
    }

    #[test]
    fn a_task_in_review_locks_the_base_branch_before_git_runs() {
        let (storage, id) = storage_with_workspace();
        {
            let mut storage = lock(&storage);
            let task = storage
                .create_task(&storage::NewTask {
                    workspace_id: id,
                    task_type: model::TaskType::Feat,
                    title: "Login".to_owned(),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: Vec::new(),
                })
                .unwrap();
            storage
                .set_task_status(task.id, TaskStatus::InProgress)
                .unwrap();
            storage
                .open_pull_request(task.id, &[], "https://github.com/a/b/pull/1", None)
                .unwrap();
        }
        let (result, invocations) = create(&storage, id, "release", Vec::new());
        assert_eq!(result.unwrap_err().kind, CommandErrorKind::Rejected);
        assert!(invocations.is_empty());
    }

    #[test]
    fn a_location_another_workspace_uses_is_rejected_regardless_of_windows_case() {
        let existing = [model::Workspace {
            id: model::WorkspaceId(3),
            name: "toodo".to_owned(),
            location: local(r"C:\dev\toodo"),
            default_base_branch: "main".to_owned(),
            agent_merge: model::AgentMerge::Never,
            source: model::Source::GitHub,
            completion: model::CompletionMode::PullRequestMerge,
            runner: model::Runner::Herdr,
        }];
        let error = ensure_unused(&existing, &local(r"c:\DEV\Toodo")).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert_eq!(
            error.message,
            r"workspace toodo (3) already uses C:\dev\toodo"
        );
        assert!(ensure_unused(&existing, &local(r"C:\dev\toodo2")).is_ok());

        let posix = |path: &str| model::WorkspaceLocation::Local {
            path: crate::domain::path::PosixPath::parse(path).unwrap().into(),
        };
        let existing = [model::Workspace {
            location: posix("/srv/toodo"),
            ..existing[0].clone()
        }];
        assert!(ensure_unused(&existing, &posix("/srv/toodo")).is_err());
        assert!(ensure_unused(&existing, &posix("/srv/Toodo")).is_ok());
    }

    #[test]
    fn open_rejects_a_path_outside_a_repository() {
        let prepared = prepare(
            setup(RepositorySetup::Open, None),
            vec![Err(failed())],
            Vec::new(),
        );
        assert_eq!(
            prepared.result.unwrap_err().kind,
            CommandErrorKind::External
        );
        assert_eq!(prepared.invocations.len(), 1);
        assert!(prepared.herdr_invocations.is_empty());
    }

    #[test]
    fn clone_keeps_the_given_location_and_base_branch() {
        let source = RepositorySetup::Clone {
            url: "git@h:a.git".to_owned(),
        };
        let prepared = prepare(
            setup(source, Some("develop")),
            vec![Ok(String::new())],
            herdr_runs_and_opens_a_new_workspace(),
        );
        let new = prepared.result.unwrap();
        assert_eq!(new.location, local(r"C:\dev\toodo\src"));
        assert_eq!(new.default_base_branch, "develop");
        assert_eq!(prepared.invocations[0].args[0], "clone");
        assert_eq!(prepared.invocations.len(), 1);
        assert_eq!(prepared.herdr_invocations[2].args[3], r"C:\dev\toodo\src");
    }

    #[test]
    fn a_herdr_failure_does_not_save_the_workspace() {
        let prepared = prepare(
            setup(RepositorySetup::Open, Some("main")),
            vec![Ok("C:/dev/toodo\n".to_owned()), Ok("origin\n".to_owned())],
            vec![
                Ok(r#"{"server":{"running":true}}"#.to_owned()),
                Err(GitError::Spawn {
                    program: "herdr".to_owned(),
                    message: "program not found".to_owned(),
                }),
            ],
        );
        assert_eq!(
            prepared.result.unwrap_err().kind,
            CommandErrorKind::External
        );
    }

    #[test]
    fn update_keeps_the_stored_location_even_a_windows_one() {
        let (storage, id) = storage_with_workspace();
        let mut workspace = Workspace::from(&lock(&storage).get_workspace(id).unwrap().unwrap());
        workspace.default_base_branch = "dev".to_owned();
        workspace.location = types::WorkspaceLocation::Local {
            path: "/elsewhere".to_owned(),
        };
        let updated = update_workspace(State(&storage), workspace).unwrap();
        assert_eq!(updated.default_base_branch, "dev");
        let stored = lock(&storage).get_workspace(id).unwrap().unwrap();
        assert_eq!(stored.location, local(r"C:\dev\toodo"));
        assert_eq!(stored.default_base_branch, "dev");
    }

    fn move_to(
        storage: &StorageState,
        id: model::WorkspaceId,
        location: types::WorkspaceLocation,
        results: Vec<Result<String, GitError>>,
        herdr_results: Vec<Result<String, GitError>>,
    ) -> (CommandResult<Workspace>, Vec<Invocation>, Vec<Invocation>) {
        let runner = Arc::new(FakeRunner::new(results));
        let herdr_runner = Arc::new(FakeRunner::new(herdr_results));
        let git: GitState = Arc::new(Git::new(Box::new(runner.clone())));
        let herdr: HerdrState = Arc::new(Herdr::new(Box::new(herdr_runner.clone())));
        let result = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(move_workspace(
                State(storage),
                State(&git),
                State(&herdr),
                id.into(),
                location,
            ));
        let invocations = runner.invocations.lock().unwrap().clone();
        let herdr_invocations = herdr_runner.invocations.lock().unwrap().clone();
        (result, invocations, herdr_invocations)
    }

    fn winpc(path: &str) -> types::WorkspaceLocation {
        types::WorkspaceLocation::Ssh {
            machine: "winpc".to_owned(),
            path: path.to_owned(),
        }
    }

    #[test]
    fn a_workspace_moves_to_its_repository_on_a_windows_host_with_its_tasks() {
        let (storage, id) = storage_with_workspace();
        let task = lock(&storage)
            .create_task(&storage::NewTask {
                workspace_id: id,
                task_type: model::TaskType::Feat,
                title: "Login".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap();
        let machine_list = r#"[{"id":"m1","label":"winpc","target":"winpc","session":"default",
            "enabled":true,"selected":false}]"#;
        let (result, invocations, herdr_invocations) = move_to(
            &storage,
            id,
            winpc(r"C:/dev/toodo/"),
            vec![Ok("C:/dev/toodo\r\n".to_owned())],
            std::iter::once(Ok(machine_list.to_owned()))
                .chain(herdr_opens_a_new_workspace())
                .collect(),
        );
        let moved = result.unwrap();
        assert_eq!(moved.location, winpc(r"C:\dev\toodo"));
        assert_eq!(moved.path_problem, None);
        assert_eq!(invocations.len(), 1);
        assert_eq!(invocations[0].args[3], "winpc");
        assert!(invocations[0].args[4].starts_with("powershell "));
        assert_eq!(
            herdr_invocations[2].args[..5],
            ["--machine", "m1", "workspace", "create", "--cwd"].map(str::to_owned)
        );
        assert_eq!(herdr_invocations[2].args[5], r"C:\dev\toodo");
        let storage = lock(&storage);
        assert_eq!(
            storage.get_workspace(id).unwrap().unwrap().location,
            moved.location.try_into().unwrap()
        );
        assert_eq!(storage.list_tasks(id).unwrap(), [task]);
    }

    #[test]
    fn a_move_needs_a_repository_and_a_location_no_other_workspace_uses() {
        let (storage, id) = storage_with_workspace();
        lock(&storage)
            .create_workspace(&storage::NewWorkspace {
                name: "other".to_owned(),
                location: winpc(r"D:\other").try_into().unwrap(),
                default_base_branch: "main".to_owned(),
                source: model::Source::GitHub,
                completion: model::CompletionMode::PullRequestMerge,
                runner: model::Runner::Herdr,
                axes_detected: true,
            })
            .unwrap();

        let (result, invocations, _) =
            move_to(&storage, id, winpc(r"d:\OTHER"), Vec::new(), Vec::new());
        assert_eq!(result.unwrap_err().kind, CommandErrorKind::Rejected);
        assert!(invocations.is_empty());

        let (result, _, herdr_invocations) = move_to(
            &storage,
            id,
            winpc(r"D:\none"),
            vec![Err(failed())],
            Vec::new(),
        );
        assert_eq!(result.unwrap_err().kind, CommandErrorKind::External);
        assert!(herdr_invocations.is_empty());

        let (result, invocations, _) = move_to(
            &storage,
            id,
            types::WorkspaceLocation::Local {
                path: r"D:\dev\toodo".to_owned(),
            },
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(result.unwrap_err().kind, CommandErrorKind::InvalidInput);
        assert!(invocations.is_empty());
        assert_eq!(
            lock(&storage).get_workspace(id).unwrap().unwrap().location,
            local(r"C:\dev\toodo")
        );
    }

    #[test]
    fn undetectable_base_branch_asks_for_one() {
        let prepared = prepare(
            setup(RepositorySetup::Open, None),
            vec![
                Ok("C:/dev/toodo\n".to_owned()),
                Err(failed()),
                Err(failed()),
            ],
            Vec::new(),
        );
        assert_eq!(
            prepared.result.unwrap_err().kind,
            CommandErrorKind::InvalidInput
        );
        assert!(prepared.herdr_invocations.is_empty());
    }

    fn with_axes(
        setup: WorkspaceSetup,
        source: Option<model::Source>,
        completion: Option<model::CompletionMode>,
        runner: Option<model::Runner>,
    ) -> WorkspaceSetup {
        WorkspaceSetup {
            source,
            completion,
            runner,
            ..setup
        }
    }

    #[test]
    fn source_none_keeps_the_location_without_git_or_herdr() {
        let plain = WorkspaceSetup {
            repository: None,
            ..setup(RepositorySetup::Open, Some("main"))
        };
        let prepared = prepare(
            with_axes(plain, Some(model::Source::None), None, None),
            Vec::new(),
            Vec::new(),
        );
        let new = prepared.result.unwrap();
        assert_eq!(new.location, local(r"C:\dev\toodo\src"));
        assert_eq!(new.default_base_branch, "");
        assert_eq!(
            (new.source, new.completion, new.runner),
            (
                model::Source::None,
                model::CompletionMode::Manual,
                model::Runner::None
            )
        );
        assert!(prepared.invocations.is_empty());
        assert!(prepared.herdr_invocations.is_empty());
    }

    #[test]
    fn an_opened_repository_without_origin_defaults_to_local_git() {
        let prepared = prepare(
            setup(RepositorySetup::Open, Some("main")),
            vec![Ok("C:/dev/toodo\n".to_owned()), Ok("upstream\n".to_owned())],
            herdr_runs_and_opens_a_new_workspace(),
        );
        let new = prepared.result.unwrap();
        assert_eq!(
            (new.source, new.completion, new.runner),
            (
                model::Source::LocalGit,
                model::CompletionMode::LocalMerge,
                model::Runner::Herdr
            )
        );
    }

    #[test]
    fn source_github_needs_an_origin_remote() {
        let prepared = prepare(
            with_axes(
                setup(RepositorySetup::Open, Some("main")),
                Some(model::Source::GitHub),
                None,
                None,
            ),
            vec![Ok("C:/dev/toodo\n".to_owned()), Ok(String::new())],
            Vec::new(),
        );
        let error = prepared.result.unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert_eq!(
            error.message,
            r"the repository at C:\dev\toodo has no origin remote for source github; choose source local_git, or add the GitHub repository as its origin remote first (git remote add origin <url>)"
        );
        assert!(prepared.herdr_invocations.is_empty());
    }

    #[test]
    fn runner_none_skips_herdr_and_a_known_source_skips_the_remote_check() {
        let prepared = prepare(
            with_axes(
                setup(RepositorySetup::Open, Some("main")),
                Some(model::Source::LocalGit),
                Some(model::CompletionMode::Manual),
                Some(model::Runner::None),
            ),
            vec![Ok("C:/dev/toodo\n".to_owned())],
            Vec::new(),
        );
        let new = prepared.result.unwrap();
        assert_eq!(
            (new.source, new.completion, new.runner),
            (
                model::Source::LocalGit,
                model::CompletionMode::Manual,
                model::Runner::None
            )
        );
        assert_eq!(prepared.invocations.len(), 1);
        assert!(prepared.herdr_invocations.is_empty());
    }

    #[test]
    fn axes_that_do_not_work_together_are_rejected_before_git_runs() {
        let prepared = prepare(
            with_axes(
                setup(RepositorySetup::Open, Some("main")),
                Some(model::Source::LocalGit),
                Some(model::CompletionMode::PullRequestMerge),
                None,
            ),
            Vec::new(),
            Vec::new(),
        );
        let error = prepared.result.unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(
            error
                .message
                .starts_with("source local_git has no pull requests")
        );
        assert!(prepared.invocations.is_empty());
    }

    #[test]
    fn an_omitted_source_resolved_from_the_remotes_is_checked_too() {
        let prepared = prepare(
            with_axes(
                setup(RepositorySetup::Open, Some("main")),
                None,
                Some(model::CompletionMode::LocalMerge),
                None,
            ),
            vec![Ok("C:/dev/toodo\n".to_owned()), Ok("origin\n".to_owned())],
            Vec::new(),
        );
        let error = prepared.result.unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(error.message.starts_with("source github completes tasks"));
        assert!(prepared.herdr_invocations.is_empty());
    }

    #[test]
    fn a_workspace_without_a_repository_moves_without_git_or_herdr() {
        let mut storage = crate::storage::Storage::open_in_memory().unwrap();
        let id = storage
            .create_workspace(&storage::NewWorkspace {
                name: "notes".to_owned(),
                location: local(r"C:\notes"),
                default_base_branch: String::new(),
                source: model::Source::None,
                completion: model::CompletionMode::Manual,
                runner: model::Runner::None,
                axes_detected: true,
            })
            .unwrap()
            .id;
        let storage = std::sync::Mutex::new(storage);
        let (result, invocations, herdr_invocations) =
            move_to(&storage, id, winpc(r"D:\notes"), Vec::new(), Vec::new());
        assert_eq!(result.unwrap().location, winpc(r"D:\notes"));
        assert!(invocations.is_empty());
        assert!(herdr_invocations.is_empty());

        let mut workspace = Workspace::from(&lock(&storage).get_workspace(id).unwrap().unwrap());
        workspace.source = types::Source::GitHub;
        let updated = update_workspace(State(&storage), workspace).unwrap();
        assert_eq!(updated.source, types::Source::None);
        assert_eq!(updated.default_base_branch, "");
    }

    fn undetected_workspace(storage: &mut storage::Storage, name: &str) -> model::WorkspaceId {
        storage
            .create_workspace(&storage::NewWorkspace {
                name: name.to_owned(),
                location: local(&format!(r"C:\dev\{name}")),
                default_base_branch: "main".to_owned(),
                source: model::Source::GitHub,
                completion: model::CompletionMode::PullRequestMerge,
                runner: model::Runner::Herdr,
                axes_detected: false,
            })
            .unwrap()
            .id
    }

    #[test]
    fn startup_detection_stores_the_axes_git_finds_and_retries_a_failure_later() {
        let mut stored = storage::Storage::open_in_memory().unwrap();
        let with_origin = undetected_workspace(&mut stored, "site");
        let without_origin = undetected_workspace(&mut stored, "notes");
        let unreachable = undetected_workspace(&mut stored, "gone");
        let storage = StorageState::new(stored);
        let runner = Arc::new(FakeRunner::new(vec![
            Ok("origin\n".to_owned()),
            Ok("upstream\n".to_owned()),
            Err(failed()),
        ]));
        let git = Git::new(Box::new(runner.clone()));

        assert_eq!(detect_axes(&storage, &git), 2);

        assert_eq!(runner.invocations.lock().unwrap().len(), 3);
        let stored = lock(&storage);
        let axes = |id| {
            let workspace = stored.get_workspace(id).unwrap().unwrap();
            (workspace.source, workspace.completion, workspace.runner)
        };
        assert_eq!(
            axes(with_origin),
            (
                model::Source::GitHub,
                model::CompletionMode::PullRequestMerge,
                model::Runner::Herdr
            )
        );
        assert_eq!(
            axes(without_origin),
            (
                model::Source::LocalGit,
                model::CompletionMode::LocalMerge,
                model::Runner::Herdr
            )
        );
        let left: Vec<_> = stored
            .workspaces_to_detect()
            .unwrap()
            .into_iter()
            .map(|workspace| workspace.id)
            .collect();
        assert_eq!(left, [unreachable]);
    }
}
