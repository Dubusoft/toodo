use super::*;

#[test]
fn concluding_records_branch_commits_after_the_worktree_directory_is_deleted() {
    let (fixture, dir) = deleted_worktree_fixture(Vec::new());
    let git_runner = runner(vec![log(&[SHA_A]), Ok(String::new())]);
    let (git, github) = adapters(&git_runner, &runner(Vec::new()));

    let done = conclude(
        &fixture.storage,
        &git,
        &github,
        &closing_herdr().0,
        fixture.task.id,
        "The prototype did not improve performance",
        OpenPullRequest::Reject,
    )
    .unwrap();

    assert_eq!(done.resolution, Some(model::TaskResolution::NotAdopted));
    assert_eq!(recorded_shas(&fixture), [SHA_A]);
    for invocation in invocations(&git_runner) {
        assert_eq!(
            invocation.args[1],
            dir.path().join("repo").to_str().unwrap()
        );
    }
}

#[test]
fn completing_records_branch_commits_after_the_worktree_directory_is_deleted() {
    let (fixture, dir) = deleted_worktree_fixture(Vec::new());
    let git_runner = runner(vec![Ok(String::new()), log(&[SHA_A])]);
    let (git, github) = adapters(&git_runner, &runner(Vec::new()));

    let done = complete(
        &fixture.storage,
        &git,
        &github,
        &closing_herdr().0,
        fixture.task.id,
    )
    .unwrap();

    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
    assert_eq!(recorded_shas(&fixture), [SHA_A]);
    for invocation in invocations(&git_runner) {
        assert_eq!(
            invocation.args[1],
            dir.path().join("repo").to_str().unwrap()
        );
    }
}

#[test]
fn a_missing_worktree_keeps_a_command_pending_without_running_the_command() {
    let command = NewCriterion::parse("Tests pass", CheckKind::Command, Some("npm test")).unwrap();
    let (fixture, _dir) = deleted_worktree_fixture(vec![command]);
    let git_runner = runner(vec![Ok(String::new()), Ok(String::new())]);
    let (git, github) = adapters(&git_runner, &runner(Vec::new()));

    complete(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
    )
    .unwrap_err();

    let task = stored(&fixture, &fixture.task);
    assert_eq!(task.criteria[0].state, CriterionState::Pending);
    assert_eq!(
        task.criteria[0].evidence.as_deref(),
        Some("worktree is missing; restore it in the Toodo app or conclude the task")
    );
    assert_eq!(git_commands(&git_runner), ["remote", "worktree"]);
}

#[test]
fn checkout_forgets_a_missing_worktree_and_reads_commits_from_the_repository() {
    let (fixture, dir) = deleted_worktree_fixture(Vec::new());
    let git_runner = runner(vec![Ok(String::new()), log(&[SHA_A])]);
    let git = Git::new(Box::new(git_runner.clone()));

    let records = refresh(&fixture.storage, &git, fixture.task.id).unwrap();

    assert_eq!(records[0].sha, SHA_A);
    let task = stored(&fixture, &fixture.task);
    assert!(task.worktree_path.is_none());
    assert!(task.herdr_workspace_id.is_none());
    assert!(types::Task::from(&task).worktree_missing);
    for invocation in invocations(&git_runner) {
        assert_eq!(
            invocation.args[1],
            dir.path().join("repo").to_str().unwrap()
        );
    }
}

#[test]
fn background_checks_forget_missing_worktrees_even_without_automatic_criteria() {
    let (fixture, _dir) = deleted_worktree_fixture(Vec::new());
    let git = Git::new(Box::new(runner(vec![Ok(String::new())])));
    let github = GhCli::new(Box::new(runner(Vec::new())));
    let recorder = Recorder::default();

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        &recorder,
        &mut HashMap::new(),
        None,
        &PullRequestStatusState::default(),
    );

    let task = stored(&fixture, &fixture.task);
    assert_eq!(task.worktree_path, None);
    assert_eq!(task.herdr_workspace_id, None);
    assert_eq!(task.branch, fixture.task.branch);
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(*recorder.0.lock().unwrap(), [task.workspace_id]);
}

#[test]
fn background_checks_forget_the_missing_worktree_of_a_done_task() {
    let (fixture, _dir) = deleted_worktree_fixture(Vec::new());
    lock(&fixture.storage)
        .complete_task_without_pull_request(fixture.task.id, "Shipped elsewhere", &[])
        .unwrap();
    let git = Git::new(Box::new(runner(vec![Ok(String::new())])));
    let github = GhCli::new(Box::new(runner(Vec::new())));

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        &Recorder::default(),
        &mut HashMap::new(),
        None,
        &PullRequestStatusState::default(),
    );

    let task = stored(&fixture, &fixture.task);
    assert_eq!(task.status, TaskStatus::Done);
    assert_eq!(task.worktree_path, None);
}
