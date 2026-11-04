use super::*;

/// A workspace with source none at a temporary directory, created through the
/// creation command, and a task in it with only manual criteria and, if given, a
/// command criterion running `command`. git and herdr must not run for either.
fn plain_workspace_task(
    dir: &std::path::Path,
    command: Option<&str>,
) -> (StorageState, model::Task) {
    use crate::commands::types;
    let storage: StorageState = Mutex::new(Storage::open_in_memory().unwrap());
    let (git, herdr) = (no_git(), herdr(Vec::new()).0);
    let workspace = crate::commands::workspaces::create(
        &storage,
        &git,
        &herdr,
        types::WorkspaceSetup {
            name: "notes".to_owned(),
            location: WorkspaceLocation::Local {
                path: PosixPath::parse(dir.to_str().unwrap()).unwrap().into(),
            },
            repository: None,
            source: Some(model::Source::None),
            completion: None,
            runner: None,
            default_base_branch: None,
        },
    )
    .unwrap();
    assert_eq!(
        (workspace.source, workspace.completion, workspace.runner),
        (
            model::Source::None,
            model::CompletionMode::Manual,
            Runner::None
        )
    );
    let mut criteria = vec![types::CriterionInput {
        id: None,
        text: Some("Outline written".to_owned()),
        kind: Some(types::CheckKind::Manual),
        target: None,
    }];
    if let Some(command) = command {
        criteria.push(types::CriterionInput {
            id: None,
            text: Some("Outline checked".to_owned()),
            kind: Some(types::CheckKind::Command),
            target: Some(command.to_owned()),
        });
    }
    let task = crate::commands::tasks::create(
        &storage,
        types::NewTask {
            workspace_id: workspace.id.into(),
            task_type: types::TaskType::Docs,
            title: "Write the outline".to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            criteria,
            // Requested, but a workspace completed manually gets no merge criterion.
            merge_criterion: true,
        },
    )
    .unwrap();
    (storage, task)
}

/// A task of a local workspace with runner plain and a worktree root.
fn plain_fixture() -> Fixture {
    fixture_with_runner(
        WorkspaceLocation::Local {
            path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
        },
        Some(MachineSettings::Local {
            worktree_root: Some(WindowsPath::parse(r"D:\wt").unwrap().into()),
        }),
        Runner::Plain,
    )
}

/// Git for a repository without `origin` whose base branch exists: the task branch is
/// created from it, then the worktree is added at a path git does not have yet.
fn plain_start_git() -> Arc<FakeRunner> {
    Arc::new(FakeRunner::new(vec![
        Ok("abc\n".to_owned()),
        Ok(String::new()),
        Err(failed()),
        Ok(String::new()),
        Ok("worktree C:/dev/toodo\0HEAD abc\0\0".to_owned()),
        Ok(String::new()),
        Ok(String::new()),
    ]))
}

#[test]
fn a_task_of_a_plain_workspace_starts_in_a_git_worktree_without_herdr() {
    let fixture = plain_fixture();
    let earlier = {
        let mut storage = lock(&fixture.storage);
        let run = storage
            .reserve_run(&crate::storage::NewRun {
                owner: OwnerKey::implicit(),
                task: fixture.task.id,
                request_key: "earlier".to_owned(),
                runner_kind: crate::domain::runtime::RunnerKind::Plain,
                role: RunRole::Writer,
                host: HostRef::Local,
                checkout_path: None,
                runtime_workspace: None,
                adapter_profile: None,
            })
            .unwrap()
            .into_run();
        storage.record_launch(run.id, "pid:1").unwrap()
    };
    let git_runner = plain_start_git();
    let runtime = FakeRuntime::new(Vec::new());

    let started = start(
        &fixture.storage,
        &Git::new(Box::new(git_runner.clone())),
        &runtime,
        fixture.task.id,
    )
    .unwrap();

    assert!(runtime.calls().is_empty());
    assert_eq!(started.status, TaskStatus::InProgress);
    assert_eq!(started.branch.as_deref(), Some("feat/add-login-1"));
    assert_eq!(
        started.worktree_path,
        Some(HostPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap())
    );
    assert_eq!(started.herdr_workspace_id, None);
    assert_eq!(stored(&fixture), started);
    let git_calls = invocations(&git_runner);
    assert_eq!(git_calls.len(), 7);
    assert_eq!(
        git_calls[6].args,
        [
            "-C",
            r"C:\dev\toodo",
            "worktree",
            "add",
            r"D:\wt\toodo\feat-add-login-1",
            "feat/add-login-1"
        ]
        .map(str::to_owned)
    );
    let storage = lock(&fixture.storage);
    assert_eq!(
        storage.open_runtime_workspace(fixture.task.id).unwrap(),
        None
    );
    assert_eq!(
        storage.get_run(earlier.id).unwrap().unwrap().state,
        RunState::Exited
    );
}

#[test]
fn deleting_a_paused_plain_task_removes_its_worktree_with_git() {
    let fixture = plain_fixture();
    let runtime = FakeRuntime::new(Vec::new());
    start(
        &fixture.storage,
        &Git::new(Box::new(plain_start_git())),
        &runtime,
        fixture.task.id,
    )
    .unwrap();
    lock(&fixture.storage)
        .set_task_status(fixture.task.id, TaskStatus::Planned)
        .unwrap();
    let git_runner = Arc::new(FakeRunner::new(vec![
        Ok("worktree D:/wt/toodo/feat-add-login-1\0HEAD abc\0\0".to_owned()),
        Ok(String::new()),
    ]));
    let (herdr, herdr_runner) = herdr(Vec::new());

    delete(
        &fixture.storage,
        &Git::new(Box::new(git_runner.clone())),
        &herdr,
        fixture.task.id,
        false,
    )
    .unwrap();

    assert!(invocations(&herdr_runner).is_empty());
    assert_eq!(
        invocations(&git_runner)[1].args,
        [
            "-C",
            r"C:\dev\toodo",
            "worktree",
            "remove",
            r"D:\wt\toodo\feat-add-login-1"
        ]
        .map(str::to_owned)
    );
    assert_eq!(
        lock(&fixture.storage).get_task(fixture.task.id).unwrap(),
        None
    );
}

#[test]
fn a_task_with_runner_tmux_on_ssh_starts_in_a_git_worktree_without_herdr() {
    let devbox = MachineLabel::parse("devbox").unwrap();
    let fixture = fixture_with_runner(
        WorkspaceLocation::Ssh {
            machine: devbox.clone(),
            path: PosixPath::parse("/srv/toodo").unwrap().into(),
        },
        Some(MachineSettings::Ssh {
            machine: devbox,
            worktree_root: Some(PosixPath::parse("/wt").unwrap().into()),
        }),
        Runner::Tmux,
    );
    let git_runner = plain_start_git();
    let runtime = FakeRuntime::new(Vec::new());

    let started = start(
        &fixture.storage,
        &Git::new(Box::new(git_runner.clone())),
        &runtime,
        fixture.task.id,
    )
    .unwrap();

    assert!(runtime.calls().is_empty());
    assert_eq!(started.status, TaskStatus::InProgress);
    assert_eq!(
        started.worktree_path,
        Some(HostPath::parse("/wt/toodo/feat-add-login-1").unwrap())
    );
    assert_eq!(started.herdr_workspace_id, None);
    let add = invocations(&git_runner).pop().unwrap();
    assert_eq!(add.program, "ssh");
    let command = add.args.last().unwrap();
    assert!(
        command.contains("'worktree' 'add' '/wt/toodo/feat-add-login-1'"),
        "{command}"
    );

    lock(&fixture.storage)
        .set_task_status(fixture.task.id, TaskStatus::Planned)
        .unwrap();
    let git_runner = Arc::new(FakeRunner::new(vec![
        Ok("worktree /wt/toodo/feat-add-login-1\0HEAD abc\0\0".to_owned()),
        Ok(String::new()),
    ]));
    let (herdr, herdr_runner) = herdr(Vec::new());
    delete(
        &fixture.storage,
        &Git::new(Box::new(git_runner.clone())),
        &herdr,
        fixture.task.id,
        false,
    )
    .unwrap();
    assert!(invocations(&herdr_runner).is_empty());
    let remove = invocations(&git_runner).pop().unwrap();
    assert!(
        remove.args.last().unwrap().contains("'worktree' 'remove'"),
        "{remove:?}"
    );
}

#[test]
fn a_task_with_runner_tmux_has_no_herdr_workspace_to_open() {
    let fixture = fixture_with_runner(
        WorkspaceLocation::Ssh {
            machine: MachineLabel::parse("devbox").unwrap(),
            path: PosixPath::parse("/srv/toodo").unwrap().into(),
        },
        None,
        Runner::Tmux,
    );
    let (herdr, herdr_runner) = herdr(Vec::new());
    let error = open(&fixture.storage, &herdr, fixture.task.id).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("get_run_log"), "{}", error.message);
    assert!(invocations(&herdr_runner).is_empty());
}

#[test]
fn a_task_with_runner_plain_names_start_plain_run_once_started() {
    let fixture = fixture_with_runner(
        WorkspaceLocation::Local {
            path: PosixPath::parse("/srv/toodo").unwrap().into(),
        },
        None,
        Runner::Plain,
    );
    let (herdr, herdr_runner) = herdr(Vec::new());

    let planned = task_panes(&fixture.storage, &herdr, fixture.task.id).unwrap_err();
    assert_eq!(planned.kind, CommandErrorKind::Rejected);
    assert!(
        planned.message.contains("start it first"),
        "{}",
        planned.message
    );

    lock(&fixture.storage)
        .set_task_status(fixture.task.id, TaskStatus::InProgress)
        .unwrap();
    let started = task_panes(&fixture.storage, &herdr, fixture.task.id).unwrap_err();
    assert_eq!(started.kind, CommandErrorKind::Rejected);
    assert!(
        started.message.contains("start_plain_run"),
        "{}",
        started.message
    );
    assert!(
        !started.message.contains("start it first"),
        "{}",
        started.message
    );
    assert!(invocations(&herdr_runner).is_empty());
}

#[test]
fn a_task_of_a_workspace_without_a_runner_starts_without_git_or_herdr() {
    let dir = tempfile::tempdir().unwrap();
    let (storage, task) = plain_workspace_task(dir.path(), None);
    let runtime = FakeRuntime::new(Vec::new());

    let started = start(&storage, &no_git(), &runtime, task.id).unwrap();

    assert!(runtime.calls().is_empty());
    let stored = lock(&storage).get_task(task.id).unwrap().unwrap();
    assert_eq!(stored, started);
    assert_eq!(stored.status, TaskStatus::InProgress);
    assert_eq!(stored.branch, None);
    assert_eq!(stored.worktree_path, None);
    assert_eq!(stored.herdr_workspace_id, None);
    assert_eq!(
        stored.timeline.last().map(|event| event.status),
        Some(TaskStatus::InProgress)
    );
    let runs = lock(&storage).list_task_runs(task.id).unwrap();
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(run.runner_kind, crate::domain::runtime::RunnerKind::None);
    assert_eq!(run.state, RunState::Running);
    assert_eq!(run.checkout_path, None);
    assert_eq!(run.runtime_workspace, None);
    let events = lock(&storage).run_events(run.id).unwrap();
    let kinds: Vec<_> = events.iter().map(|event| event.kind.as_str()).collect();
    assert_eq!(kinds, ["reserved", "launched"]);

    let again = start(&storage, &no_git(), &runtime, task.id).unwrap_err();
    assert_eq!(again.kind, CommandErrorKind::Rejected);
    assert_eq!(lock(&storage).list_task_runs(task.id).unwrap().len(), 1);
}

#[test]
fn branch_and_herdr_commands_name_the_next_step_for_a_task_without_a_runner() {
    let dir = tempfile::tempdir().unwrap();
    let (storage, task) = plain_workspace_task(dir.path(), None);
    start(&storage, &no_git(), &FakeRuntime::new(Vec::new()), task.id).unwrap();
    let (herdr, _) = herdr(Vec::new());

    for error in [
        restore(&storage, &no_git(), &herdr, task.id).unwrap_err(),
        open(&storage, &herdr, task.id).unwrap_err(),
        ensure_workspace(&storage, &herdr, task.id).unwrap_err(),
        focus_agent(&storage, &herdr, task.id).unwrap_err(),
        crate::commands::completion::checkout(&storage, &no_git(), task.id)
            .err()
            .unwrap(),
    ] {
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("runner none"), "{}", error.message);
    }
    // Deleting the task has no worktree to remove.
    delete(&storage, &no_git(), &herdr, task.id, false).unwrap();
}

#[test]
fn a_task_without_a_repository_is_planned_started_checked_and_completed() {
    use crate::adapters::github::GhCli;
    use crate::commands::{completion, tasks, types};
    use crate::domain::criteria::CheckedBy;
    let dir = tempfile::tempdir().unwrap();
    let (storage, task) = plain_workspace_task(dir.path(), None);
    let kinds: Vec<CheckKind> = task.criteria.iter().map(|c| c.kind).collect();
    assert_eq!(kinds, [CheckKind::Manual]);

    let runtime = FakeRuntime::new(Vec::new());
    let started = start(&storage, &no_git(), &runtime, task.id).unwrap();
    assert_eq!(started.status, TaskStatus::InProgress);
    assert!(runtime.calls().is_empty());

    let checked = tasks::check(
        &mut lock(&storage),
        Some(task.id.into()),
        types::CriterionId(task.criteria[0].id.0),
        true,
        Some("Outline in notes/outline.md"),
        CheckedBy::User,
    )
    .unwrap();
    assert!(
        checked
            .criteria
            .iter()
            .all(|criterion| criterion.state == types::CriterionState::Met)
    );

    let (herdr, herdr_runner) = herdr(Vec::new());
    let gh = Arc::new(FakeRunner::new(Vec::new()));
    let git_runner = Arc::new(FakeRunner::new(Vec::new()));
    let done = completion::complete(
        &storage,
        &Git::new(Box::new(git_runner.clone())),
        &GhCli::new(Box::new(gh.clone())),
        &herdr,
        task.id,
    )
    .unwrap();

    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.branch, None);
    assert_eq!(done.pull_request_url, None);
    for runner in [&herdr_runner, &gh, &git_runner] {
        assert!(invocations(runner).is_empty());
    }
}

#[test]
fn a_command_criterion_of_a_task_without_a_worktree_runs_in_the_workspace_location() {
    use crate::adapters::github::GhCli;
    use crate::commands::{completion, tasks, types};
    use crate::domain::criteria::CheckedBy;
    let dir = tempfile::tempdir().unwrap();
    let (storage, task) = plain_workspace_task(dir.path(), Some("test -f outline.md"));
    start(&storage, &no_git(), &FakeRuntime::new(Vec::new()), task.id).unwrap();
    tasks::check(
        &mut lock(&storage),
        Some(task.id.into()),
        types::CriterionId(task.criteria[0].id.0),
        true,
        None,
        CheckedBy::User,
    )
    .unwrap();
    let git_runner = Arc::new(FakeRunner::new(vec![Ok(String::new())]));

    let done = completion::complete(
        &storage,
        &Git::new(Box::new(git_runner.clone())),
        &GhCli::new(Box::new(Arc::new(FakeRunner::new(Vec::new())))),
        &herdr(Vec::new()).0,
        task.id,
    )
    .unwrap();

    assert_eq!(done.status, TaskStatus::Done);
    let ran = invocations(&git_runner);
    assert_eq!(ran.len(), 1);
    assert_eq!(ran[0].program, "sh");
    assert_eq!(
        ran[0].args,
        [
            "-c".to_owned(),
            format!(
                "cd '{}' && test -f outline.md",
                dir.path().to_str().unwrap()
            )
        ]
    );
}
