use super::*;

#[test]
fn opening_a_pull_request_records_commits_pushes_and_puts_the_task_in_review() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![
        log(&[SHA_A, SHA_B]),
        origin("git@github.com:acme/toodo.git"),
        Ok(String::new()),
    ]);
    let gh_runner = runner(vec![Ok("[]".to_owned()), Ok(format!("{PR}\n"))]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

    assert_eq!(in_review.status, TaskStatus::InReview);
    assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
    assert_eq!(stored(&fixture, &fixture.task), in_review);
    let records = lock(&fixture.storage)
        .list_commit_records(fixture.task.id)
        .unwrap();
    assert_eq!(
        records
            .iter()
            .map(|record| record.sha.as_str())
            .collect::<Vec<_>>(),
        [SHA_A, SHA_B]
    );
    assert!(!dependent_ready(&fixture));
    assert_eq!(
        git_commands(&git_runner),
        ["worktree", "log", "remote", "push"]
    );
    assert_eq!(
        invocations(&git_runner)[1].args[..2],
        ["-C", r"C:\dev\toodo"].map(str::to_owned)
    );
    assert_eq!(
        invocations(&gh_runner)[1].args,
        [
            "pr",
            "create",
            "--repo",
            "github.com/acme/toodo",
            "--head",
            "feat/add-login-1",
            "--base",
            "main",
            "--title",
            "Add login",
            "--body",
            "Implement Add login",
        ]
        .map(str::to_owned)
    );
}

#[test]
fn ssh_tasks_run_git_on_their_machine_and_gh_locally() {
    let devbox = MachineLabel::parse("devbox").unwrap();
    let fixture = fixture(
        WorkspaceLocation::Ssh {
            machine: devbox,
            path: PosixPath::parse("/srv/toodo").unwrap().into(),
        },
        HostPath::Posix(PosixPath::parse("/wt/toodo/feat-add-login-1").unwrap()),
    );
    let git_runner = checkout_runner(vec![
        log(&[SHA_A]),
        origin("https://github.com/acme/toodo.git"),
        Ok(String::new()),
    ]);
    let gh_runner = runner(vec![Ok("[]".to_owned()), Ok(format!("{PR}\n"))]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

    let push = &invocations(&git_runner)[3];
    assert_eq!(push.program, "ssh");
    assert_eq!(
        push.args.last().unwrap(),
        "git '-C' '/srv/toodo' 'push' '--set-upstream' 'origin' 'feat/add-login-1'"
    );
    assert_eq!(invocations(&gh_runner)[1].program, "gh");
}

#[test]
fn a_branch_without_commits_is_rejected_before_anything_is_pushed() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![log(&[]), origin("git@github.com:acme/toodo.git")]);
    let gh_runner = runner(vec![Ok("[]".to_owned())]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let error = open(&fixture.storage, &git, &github, fixture.task.id).unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error
            .message
            .contains("has no commits that are not on main")
    );
    assert_eq!(git_commands(&git_runner), ["worktree", "log", "remote"]);
    assert_eq!(invocations(&gh_runner).len(), 1);
    assert_eq!(stored(&fixture, &fixture.task), fixture.task);
}

#[test]
fn a_non_github_origin_is_rejected_before_anything_is_pushed() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![log(&[SHA_A]), origin("/srv/git/toodo.git")]);
    let gh_runner = runner(Vec::new());
    let (git, github) = adapters(&git_runner, &gh_runner);

    let error = open(&fixture.storage, &git, &github, fixture.task.id).unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("is not a GitHub repository"));
    assert_eq!(git_commands(&git_runner), ["worktree", "log", "remote"]);
    assert!(invocations(&gh_runner).is_empty());
}

#[test]
fn a_failed_pull_request_keeps_the_task_in_progress_and_a_retry_reuses_the_open_one() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![
        log(&[SHA_A]),
        origin("git@github.com:acme/toodo.git"),
        Ok(String::new()),
        worktrees(),
        log(&[SHA_A, SHA_B]),
        origin("git@github.com:acme/toodo.git"),
        Ok(String::new()),
    ]);
    let gh_runner = runner(vec![
        Ok("[]".to_owned()),
        Err(failed()),
        listed("OPEN", "main"),
    ]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let error = open(&fixture.storage, &git, &github, fixture.task.id).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::External);
    assert_eq!(stored(&fixture, &fixture.task), fixture.task);
    assert_eq!(
        lock(&fixture.storage)
            .list_commit_records(fixture.task.id)
            .unwrap(),
        []
    );

    let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();
    assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
    assert_eq!(invocations(&gh_runner).len(), 3);
    assert_eq!(invocations(&gh_runner)[2].args[1], "list");
}

#[test]
fn refresh_stores_the_commits_of_an_in_progress_task_only() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![log(&[SHA_A]), worktrees(), log(&[SHA_A, SHA_B])]);
    let git = Git::new(Box::new(git_runner.clone()));

    assert_eq!(
        refresh(&fixture.storage, &git, fixture.task.id)
            .unwrap()
            .len(),
        1
    );
    let records = refresh(&fixture.storage, &git, fixture.task.id).unwrap();
    assert_eq!(
        lock(&fixture.storage)
            .list_commit_records(fixture.task.id)
            .unwrap(),
        records
    );
    assert_eq!(records.len(), 2);

    let error = refresh(&fixture.storage, &git, fixture.dependent.id).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    let error = refresh(&fixture.storage, &git, model::TaskId(999)).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
    assert_eq!(invocations(&git_runner).len(), 4);
}

#[test]
fn an_in_progress_task_without_a_branch_is_rejected() {
    let fixture = local_fixture();
    for status in [TaskStatus::InReview, TaskStatus::Done] {
        lock(&fixture.storage)
            .set_task_status(fixture.task.id, status)
            .unwrap();
    }
    let ready = fixture.dependent.id;
    lock(&fixture.storage)
        .set_task_status(ready, TaskStatus::InProgress)
        .unwrap();
    let git_runner = runner(Vec::new());
    let gh_runner = runner(Vec::new());
    let (git, github) = adapters(&git_runner, &gh_runner);

    let error = open(&fixture.storage, &git, &github, ready).unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("has no branch"));
    assert!(invocations(&git_runner).is_empty());
}
