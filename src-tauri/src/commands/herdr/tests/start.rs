use super::*;

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
    let reply = serde_json::to_value(crate::commands::types::Task::from(&started)).unwrap();
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
