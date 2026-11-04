use super::*;

#[test]
fn a_branch_merged_locally_completes_a_task_without_origin_or_gh() {
    let fixture = local_criteria_fixture(vec![NewCriterion::merge(false)]);
    set_start(&fixture, SHA_A);
    let mut results = vec![Ok(String::new())];
    results.extend(merged_locally());
    // The commits since the start; `origin/<start>` does not exist.
    results.extend([Err(failed()), log(&[SHA_A, SHA_B])]);
    let git_runner = runner(results);
    let gh_runner = runner(Vec::new());
    let (git, github) = adapters(&git_runner, &gh_runner);
    let (herdr, _) = closing_herdr();

    let done = complete(&fixture.storage, &git, &github, &herdr, fixture.task.id).unwrap();

    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.resolution, Some(model::TaskResolution::Merged));
    assert_eq!(done.criteria[0].state, CriterionState::Met);
    assert_eq!(
        done.criteria[0].evidence.as_deref(),
        Some("feat/add-login-1 merged into main with 2 commits")
    );
    assert_eq!(recorded_shas(&fixture), [SHA_A, SHA_B]);
    assert!(dependent_ready(&fixture));
    assert!(invocations(&gh_runner).is_empty());
    let commands: Vec<String> = invocations(&git_runner)
        .iter()
        .map(|invocation| invocation.args[2..].join(" "))
        .collect();
    assert_eq!(
        commands[1..4],
        [
            "rev-parse --verify --quiet refs/heads/feat/add-login-1".to_owned(),
            "rev-list --count refs/heads/main..refs/heads/feat/add-login-1".to_owned(),
            format!("rev-list --count {SHA_A}..refs/heads/feat/add-login-1"),
        ]
    );
}

#[test]
fn a_branch_ahead_of_its_base_is_not_merged_and_keeps_where_it_started() {
    let fixture = local_criteria_fixture(vec![NewCriterion::merge(false)]);
    let git_runner = runner(vec![
        Ok(String::new()),
        Ok(format!("{SHA_B}\n")),
        Ok("3\n".to_owned()),
        Ok(format!("{SHA_A}\n")),
    ]);
    let gh_runner = runner(Vec::new());
    let (git, github) = adapters(&git_runner, &gh_runner);

    let error = complete(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error
            .message
            .contains("1 of its completion criteria is not met"),
        "{}",
        error.message
    );
    let task = stored(&fixture, &fixture.task);
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(task.criteria[0].target.as_deref(), Some(SHA_A));
}

#[test]
fn a_met_manual_criterion_awaits_confirmation_before_the_task_is_done() {
    let fixture = local_criteria_fixture(vec![NewCriterion::merge(false), manual("Docs reviewed")]);
    set_start(&fixture, SHA_A);
    let reviewed = fixture.task.criteria[1].id;
    lock(&fixture.storage)
        .check_criterion(
            fixture.task.id,
            reviewed,
            true,
            Some("approved"),
            criteria::CheckedBy::User,
        )
        .unwrap();
    let git_runner = checkout_runner(merged_locally());
    let gh_runner = runner(Vec::new());
    let (git, github) = adapters(&git_runner, &gh_runner);
    let recorder = Recorder::default();
    let mut failures = HashMap::new();

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        &recorder,
        &mut failures,
        None,
        &PullRequestStatusState::default(),
    );

    let awaiting = stored(&fixture, &fixture.task);
    assert_eq!(awaiting.status, TaskStatus::InReview);
    assert!(awaiting.criteria.iter().all(|criterion| criterion.is_met()));
    assert_eq!(*recorder.0.lock().unwrap(), [awaiting.workspace_id]);
    assert!(failures.is_empty(), "{failures:?}");
    assert!(!dependent_ready(&fixture));

    // Nothing is left to check, so the next check runs nothing.
    check_pull_requests(
        &fixture.storage,
        &worktree_git(),
        &github,
        &no_herdr(),
        &recorder,
        &mut failures,
        None,
        &PullRequestStatusState::default(),
    );
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);

    let git_runner = runner(vec![Ok(String::new()), Err(failed()), log(&[SHA_B])]);
    let git = Git::new(Box::new(git_runner.clone()));
    let (herdr, _) = closing_herdr();
    let done = complete(&fixture.storage, &git, &github, &herdr, fixture.task.id).unwrap();
    assert_eq!(done.status, TaskStatus::Done);
    assert!(dependent_ready(&fixture));
}

#[test]
fn confirming_is_rejected_while_a_manual_criterion_is_not_met() {
    let fixture = local_criteria_fixture(vec![manual("Docs reviewed")]);
    let gh_runner = runner(Vec::new());
    let github = GhCli::new(Box::new(gh_runner.clone()));

    let error = complete(
        &fixture.storage,
        &Git::new(Box::new(runner(vec![Ok(String::new())]))),
        &github,
        &no_herdr(),
        fixture.task.id,
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error
            .message
            .contains(r#""Docs reviewed" (manual, pending)"#),
        "{}",
        error.message
    );
    assert_eq!(
        stored(&fixture, &fixture.task).status,
        TaskStatus::InProgress
    );
}

#[test]
fn a_task_without_criteria_is_completed_when_confirmed() {
    let fixture = local_criteria_fixture(Vec::new());
    let git_runner = runner(vec![Ok(String::new()), Err(failed()), Ok(String::new())]);
    let git = Git::new(Box::new(git_runner.clone()));
    let gh_runner = runner(Vec::new());
    let github = GhCli::new(Box::new(gh_runner.clone()));
    let (herdr, _) = closing_herdr();

    // The background check never completes it on its own.
    check_pull_requests(
        &fixture.storage,
        &worktree_git(),
        &github,
        &no_herdr(),
        &Recorder::default(),
        &mut HashMap::new(),
        None,
        &PullRequestStatusState::default(),
    );
    assert_eq!(
        stored(&fixture, &fixture.task).status,
        TaskStatus::InProgress
    );

    let done = complete(&fixture.storage, &git, &github, &herdr, fixture.task.id).unwrap();
    assert_eq!(done.status, TaskStatus::Done);
}

#[test]
fn a_command_criterion_runs_once_the_others_are_met_and_reports_its_failure() {
    let command = NewCriterion::parse("Tests pass", CheckKind::Command, Some("npm test")).unwrap();
    let fixture = local_criteria_fixture(vec![manual("Docs reviewed"), command]);
    let gh_runner = runner(Vec::new());
    let github = GhCli::new(Box::new(gh_runner.clone()));
    let mut failures = HashMap::new();
    let check = |git: &Git, failures: &mut HashMap<model::TaskId, String>| {
        check_pull_requests(
            &fixture.storage,
            git,
            &github,
            &no_herdr(),
            &Recorder::default(),
            failures,
            None,
            &PullRequestStatusState::default(),
        );
    };
    // The manual criterion is not met yet, so the command does not run.
    check(&worktree_git(), &mut failures);
    assert_eq!(
        stored(&fixture, &fixture.task).criteria[1].state,
        CriterionState::Pending
    );

    lock(&fixture.storage)
        .check_criterion(
            fixture.task.id,
            fixture.task.criteria[0].id,
            true,
            Some("approved"),
            criteria::CheckedBy::Agent,
        )
        .unwrap();
    let git_runner = checkout_runner(vec![
        worktrees(),
        Err(GitError::Failed {
            command: "cmd".to_owned(),
            stderr: "1 test failed".to_owned(),
        }),
    ]);
    check(&Git::new(Box::new(git_runner.clone())), &mut failures);
    let task = stored(&fixture, &fixture.task);
    assert_eq!(task.criteria[1].state, CriterionState::Failed);
    assert!(
        task.criteria[1]
            .evidence
            .as_deref()
            .is_some_and(|evidence| evidence.contains("1 test failed"))
    );
    assert_eq!(task.status, TaskStatus::InProgress);
    let ran = invocations(&git_runner);
    assert_eq!(ran[2].program, "cmd");
    assert_eq!(
        ran[2].args.last().map(String::as_str),
        Some(r#"cd /d "D:\wt\toodo\feat-add-login-1" && npm test"#)
    );

    let git_runner = checkout_runner(vec![worktrees(), Ok("12 passed\n".to_owned())]);
    check(&Git::new(Box::new(git_runner)), &mut failures);
    let task = stored(&fixture, &fixture.task);
    assert_eq!(task.criteria[1].state, CriterionState::Met);
    assert_eq!(task.status, TaskStatus::InReview);
}
