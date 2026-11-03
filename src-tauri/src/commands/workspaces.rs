//! Commands for workspaces and per-machine settings.

use super::State;

use super::types::{
    self, BranchList, MachineSettings, NewWorkspace, Workspace, WorkspaceId, WorkspaceSetup,
    WorkspaceSource,
};
use super::{CommandError, CommandResult, GitState, HerdrState, StorageState, lock};
use crate::adapters::git::Git;
use crate::adapters::herdr::Herdr;
use crate::domain::model;
use crate::domain::status::TaskStatus;
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

/// Brings the repository to the workspace location, resolves the base branch, and opens
/// the repository in herdr unless a herdr workspace already has it open. A location one
/// of the `existing` workspaces uses is rejected before git clones into it and, for an
/// opened repository, again once git found its root, before herdr runs.
fn prepare_workspace(
    git: &Git,
    herdr: &Herdr,
    setup: WorkspaceSetup,
    existing: &[model::Workspace],
) -> CommandResult<storage::NewWorkspace> {
    ensure_unused(existing, &setup.location)?;
    let path = location_path(&setup.location).to_owned();
    let location = match setup.source {
        WorkspaceSource::Clone { url } => {
            git.clone_repository(&url, &setup.location)
                .map_err(|error| setup_failed(error, || format!(
                    "could not clone {url} into {path}"
                ), "check the URL and your access to it (SSH key or gh auth), and that the directory does not exist yet or is empty"))?;
            setup.location
        }
        WorkspaceSource::Open => git.repository_root(&setup.location).map_err(|error| {
            setup_failed(
                error,
                || format!("could not open a git repository at {path}"),
                "choose a directory inside an existing clone, clone the repository there instead (clone_url, or Clone in the app), or make it a new repository (init: true, or New repository in the app)",
            )
        })?,
        WorkspaceSource::Init => {
            let branch = setup.default_base_branch.as_deref().unwrap_or("main");
            let failed = |error| {
                setup_failed(
                    error,
                    || format!("could not make a new git repository at {path}"),
                    "check that the parent directory exists and that you can write to it",
                )
            };
            git.init_repository(&setup.location, branch).map_err(failed)?;
            git.repository_root(&setup.location).map_err(failed)?
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
    herdr.open_workspace(&location.machine(), location_path(&location), &setup.name)?;
    Ok(storage::NewWorkspace {
        name: setup.name,
        location,
        default_base_branch,
    })
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

/// Saves the name, default base branch, and agent merge policy of an existing workspace.
/// Its location is kept; [`move_workspace`] changes it.
#[specta::specta]
pub fn update_workspace(
    storage: State<'_, StorageState>,
    workspace: Workspace,
) -> CommandResult<Workspace> {
    let mut storage = lock(&storage);
    let id = workspace.id.into();
    let location = storage
        .get_workspace(id)?
        .ok_or(StorageError::WorkspaceNotFound(id))?
        .location;
    let workspace = workspace.into_model(location)?;
    storage.update_workspace(&workspace)?;
    Ok((&workspace).into())
}

/// Moves a workspace to the repository at `location`, e.g. one kept with a Windows path
/// from the desktop app to the Windows host it lives on, keeping its tasks. The location
/// must hold a git repository that no other workspace uses; it is opened in herdr like a
/// new workspace. Git and herdr may run over `ssh`, so they run on a blocking thread.
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
    let (workspace, others) = {
        let storage = lock(&storage);
        let workspace = storage
            .get_workspace(id)?
            .ok_or(StorageError::WorkspaceNotFound(id))?;
        let others: Vec<_> = storage
            .list_workspaces()?
            .into_iter()
            .filter(|other| other.id != id)
            .collect();
        (workspace, others)
    };
    ensure_unused(&others, &target)?;
    let git = GitState::clone(&git);
    let herdr = HerdrState::clone(&herdr);
    let name = workspace.name.clone();
    let location = tokio::task::spawn_blocking(move || -> CommandResult<_> {
        let root = git.repository_root(&target)?;
        ensure_unused(&others, &root)?;
        herdr.open_workspace(&root.machine(), location_path(&root), &name)?;
        Ok(root)
    })
    .await
    .map_err(|error| CommandError::internal(format!("workspace move panicked: {error}")))??;
    let moved = model::Workspace {
        location,
        ..workspace
    };
    let mut storage = lock(&storage);
    ensure_unused(
        &storage
            .list_workspaces()?
            .into_iter()
            .filter(|other| other.id != id)
            .collect::<Vec<_>>(),
        &moved.location,
    )?;
    storage.update_workspace(&moved)?;
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

    fn setup(source: WorkspaceSource, branch: Option<&str>) -> WorkspaceSetup {
        WorkspaceSetup {
            name: "toodo".to_owned(),
            location: local(r"C:\dev\toodo\src"),
            source,
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
            setup(WorkspaceSource::Open, None),
            vec![
                Ok("C:/dev/toodo\n".to_owned()),
                Ok("origin/main\n".to_owned()),
            ],
            herdr_opens_a_new_workspace(),
        );
        let new = prepared.result.unwrap();
        assert_eq!(new.location, local(r"C:\dev\toodo"));
        assert_eq!(new.default_base_branch, "main");
        assert_eq!(prepared.invocations[1].args[..2], ["-C", r"C:\dev\toodo"]);
        assert_eq!(
            prepared.herdr_invocations[1].args,
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

    fn storage_with_workspace() -> (StorageState, model::WorkspaceId) {
        let mut storage = crate::storage::Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&storage::NewWorkspace {
                name: "toodo".to_owned(),
                location: local(r"C:\dev\toodo"),
                default_base_branch: "main".to_owned(),
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
            setup(WorkspaceSource::Open, None),
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
        let source = WorkspaceSource::Clone {
            url: "git@h:a.git".to_owned(),
        };
        let prepared = prepare(
            setup(source, Some("develop")),
            vec![Ok(String::new())],
            herdr_opens_a_new_workspace(),
        );
        let new = prepared.result.unwrap();
        assert_eq!(new.location, local(r"C:\dev\toodo\src"));
        assert_eq!(new.default_base_branch, "develop");
        assert_eq!(prepared.invocations[0].args[0], "clone");
        assert_eq!(prepared.invocations.len(), 1);
        assert_eq!(prepared.herdr_invocations[1].args[3], r"C:\dev\toodo\src");
    }

    #[test]
    fn a_herdr_failure_does_not_save_the_workspace() {
        let prepared = prepare(
            setup(WorkspaceSource::Open, Some("main")),
            vec![Ok("C:/dev/toodo\n".to_owned())],
            vec![Err(GitError::Spawn {
                program: "herdr".to_owned(),
                message: "program not found".to_owned(),
            })],
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
            setup(WorkspaceSource::Open, None),
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
}
