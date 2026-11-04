use super::*;

#[test]
fn a_merged_pull_request_completes_its_task_automatically() {
    let fixture = in_review_fixture();
    let gh_runner = runner(vec![
        viewed("OPEN", "main"),
        viewed("MERGED", "main"),
        merged_details(&[]),
    ]);
    let github = GhCli::new(Box::new(gh_runner.clone()));
    let (herdr, herdr_runner) = closing_herdr();
    let recorder = Recorder::default();
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();

    check_pull_requests(
        &fixture.storage,
        &worktree_git(),
        &github,
        &herdr,
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
    assert!(recorder.0.lock().unwrap().is_empty());
    assert!(invocations(&herdr_runner).is_empty());

    check_pull_requests(
        &fixture.storage,
        &worktree_git(),
        &github,
        &herdr,
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    let done = stored(&fixture, &fixture.task);
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.pull_request_merged_at, Some(MERGED_AT.1));
    assert!(dependent_ready(&fixture));
    assert_eq!(*recorder.0.lock().unwrap(), [done.workspace_id]);
    assert_eq!(invocations(&herdr_runner).len(), 1);
    assert!(failures.is_empty());

    // A done task is no longer checked.
    check_pull_requests(
        &fixture.storage,
        &worktree_git(),
        &github,
        &herdr,
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    assert_eq!(invocations(&gh_runner).len(), 3);
}

#[test]
fn an_open_pull_request_with_passing_checks_is_reported_ready_and_not_merged() {
    let criterion = NewCriterion::parse(
        "Pull request open with green checks",
        CheckKind::PullRequestOpenChecksPassed,
        None,
    )
    .unwrap();
    let fixture = local_criteria_fixture(vec![criterion]);
    lock(&fixture.storage)
        .open_pull_request(fixture.task.id, &[], PR, None)
        .unwrap();
    let passing = r#"[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]"#;
    let mut view: serde_json::Value =
        serde_json::from_str(&viewed_with("OPEN", "main", passing, "\"\"").unwrap()).unwrap();
    view["headRefOid"] = serde_json::json!(SHA_A);
    let github = GhCli::new(Box::new(runner(vec![Ok(view.to_string())])));
    let git = Git::new(Box::new(checkout_runner(vec![
        Err(failed()),
        log(&[SHA_A]),
    ])));
    let (herdr, _) = closing_herdr();
    let recorder = Recorder::default();

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &herdr,
        &recorder,
        &mut HashMap::new(),
        None,
        &PullRequestStatusState::default(),
    );

    let done = stored(&fixture, &fixture.task);
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.pull_request_merged_at, None);
}

#[test]
fn checks_keep_the_ci_and_review_state_of_open_pull_requests_and_announce_changes() {
    let fixture = in_review_fixture();
    let running = r#"[{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""}]"#;
    let failing = r#"[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]"#;
    let github = GhCli::new(Box::new(runner(vec![
        viewed_with("OPEN", "main", running, "\"\""),
        viewed_with("OPEN", "main", running, "\"\""),
        viewed_with("OPEN", "main", failing, "\"CHANGES_REQUESTED\""),
        Err(failed()),
        viewed("MERGED", "main"),
        merged_details(&[]),
    ])));
    let (herdr, _) = closing_herdr();
    let recorder = Recorder::default();
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();
    let check = |failures: &mut HashMap<_, _>| {
        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &herdr,
            &recorder,
            failures,
            None,
            &statuses,
        );
    };
    let status = |checks, review| types::TaskPullRequestStatus {
        task_id: fixture.task.id.into(),
        checks: Some(checks),
        review,
    };
    let pending = status(types::ChecksStatus::Pending, types::ReviewStatus::Pending);
    let failed = status(
        types::ChecksStatus::Failing,
        types::ReviewStatus::ChangesRequested,
    );

    // An unchanged state is announced once; a failed check keeps the last one.
    for _ in 0..4 {
        check(&mut failures);
    }
    assert_eq!(
        *recorder.1.lock().unwrap(),
        [vec![pending], vec![failed.clone()]]
    );
    assert_eq!(list(&statuses), [failed]);

    // A merged pull request leaves no state behind.
    check(&mut failures);
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::Done);
    assert!(recorder.1.lock().unwrap().last().unwrap().is_empty());
    assert!(list(&statuses).is_empty());
}

#[test]
fn background_checks_record_git_activity_once_and_only_for_tracked_workspaces() {
    // Given an in-review task whose pull request passed CI and was merged.
    let fixture = in_review_fixture();
    let git_runner = checkout_runner(vec![log(&[SHA_A])]);
    let activity_view = format!(
        r#"{{"createdAt":"2026-10-08T10:00:00Z","headRefOid":"{SHA_B}","mergedAt":"{}","number":12,"state":"MERGED","statusCheckRollup":[{{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS","completedAt":"2026-10-09T12:00:00Z"}}],"title":"Add login","url":"{PR}"}}"#,
        MERGED_AT.0
    );
    let gh_runner = runner(vec![
        Ok(activity_view),
        viewed("MERGED", "main"),
        merged_details(&[SHA_A, SHA_B]),
    ]);
    let (git, github) = adapters(&git_runner, &gh_runner);
    let (herdr, _) = closing_herdr();
    let recorder = Recorder::default();
    let mut activity_failures = HashMap::new();

    // When the background check runs.
    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &herdr,
        &recorder,
        &mut HashMap::new(),
        Some(&mut activity_failures),
        &PullRequestStatusState::default(),
    );

    // Then the commits, the opened pull request, its CI result, and its merge are
    // recorded once each, in the order they happened, before the task is done.
    let done = stored(&fixture, &fixture.task);
    assert_eq!(done.status, TaskStatus::Done);
    assert!(activity_failures.is_empty());
    let created_at = 1_791_453_600;
    let recorded: Vec<_> = lock(&fixture.storage)
        .list_activity(fixture.task.id)
        .unwrap()
        .into_iter()
        .map(|recorded| {
            let event = recorded.event;
            (
                event.kind,
                event.external_ref,
                event.title,
                event.occurred_at,
            )
        })
        .collect();
    assert_eq!(
        recorded,
        [
            (
                ActivityKind::Commit,
                SHA_A.to_owned(),
                "Commit 0".to_owned(),
                0
            ),
            (
                ActivityKind::PullRequestOpened,
                PR.to_owned(),
                "Add login".to_owned(),
                created_at
            ),
            (
                ActivityKind::ChecksPassed,
                SHA_B.to_owned(),
                "CI passed on 2222222".to_owned(),
                created_at + 26 * 3_600
            ),
            (
                ActivityKind::PullRequestMerged,
                PR.to_owned(),
                "Add login".to_owned(),
                MERGED_AT.1
            ),
            (
                ActivityKind::Commit,
                SHA_B.to_owned(),
                format!("Commit {SHA_B}"),
                MERGED_AT.1
            ),
        ]
    );
    assert_eq!(
        git_commands(&git_runner),
        ["worktree", "log"],
        "branch commits are read once, before settling"
    );
    assert_eq!(
        invocations(&gh_runner)[0].args[4],
        "number,title,url,createdAt,state,mergedAt,headRefOid,statusCheckRollup"
    );
    assert!(recorder.0.lock().unwrap().contains(&done.workspace_id));
}

#[test]
fn background_checks_read_no_git_activity_of_a_manual_completion_workspace() {
    let fixture = fixture_completed_by(
        WorkspaceLocation::Local {
            path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
        },
        HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap()),
        Vec::new(),
        crate::domain::model::CompletionMode::Manual,
    );
    let git_runner = checkout_runner(Vec::new());
    let gh_runner = runner(Vec::new());
    let (git, github) = adapters(&git_runner, &gh_runner);
    let recorder = Recorder::default();

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        &recorder,
        &mut HashMap::new(),
        Some(&mut HashMap::new()),
        &PullRequestStatusState::default(),
    );

    assert_eq!(git_commands(&git_runner), ["worktree"]);
    assert!(invocations(&gh_runner).is_empty());
    assert!(
        lock(&fixture.storage)
            .list_activity(fixture.task.id)
            .unwrap()
            .is_empty()
    );
    assert!(recorder.0.lock().unwrap().is_empty());
}

#[test]
fn a_failed_check_keeps_the_task_in_review_and_remembers_the_failure() {
    let fixture = in_review_fixture();
    let github = GhCli::new(Box::new(runner(vec![
        Err(failed()),
        viewed("OPEN", "main"),
    ])));
    let recorder = Recorder::default();
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();

    check_pull_requests(
        &fixture.storage,
        &worktree_git(),
        &github,
        &no_herdr(),
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
    assert_eq!(failures.keys().collect::<Vec<_>>(), [&fixture.task.id]);

    check_pull_requests(
        &fixture.storage,
        &worktree_git(),
        &github,
        &no_herdr(),
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    assert!(failures.is_empty());
    assert!(recorder.0.lock().unwrap().is_empty());
}

#[test]
fn a_pull_request_opened_outside_toodo_moves_an_in_progress_task_to_review() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
        worktrees(),
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
        log(&[SHA_A]),
    ]);
    let gh_runner = runner(vec![
        Ok("[]".to_owned()),
        listed("OPEN", "main"),
        viewed("OPEN", "main"),
    ]);
    let (git, github) = adapters(&git_runner, &gh_runner);
    let recorder = Recorder::default();
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    assert_eq!(stored(&fixture, &fixture.task), fixture.task);
    assert!(recorder.0.lock().unwrap().is_empty());

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    let in_review = stored(&fixture, &fixture.task);
    assert_eq!(in_review.status, TaskStatus::InReview);
    assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
    assert_eq!(in_review.pull_request_merged_at, None);
    assert_eq!(recorded_shas(&fixture), [SHA_A]);
    assert_eq!(*recorder.0.lock().unwrap(), [in_review.workspace_id]);
    assert!(!dependent_ready(&fixture));
    assert!(failures.is_empty());
    // Nothing is pushed: the pull request already has the branch.
    assert_eq!(
        git_commands(&git_runner),
        [
            "worktree", "remote", "remote", "worktree", "remote", "remote", "log"
        ]
    );
    assert_eq!(
        invocations(&gh_runner)[1].args[..6],
        [
            "pr",
            "list",
            "--repo",
            "github.com/acme/toodo",
            "--head",
            "feat/add-login-1"
        ]
        .map(str::to_owned)
    );
    // The task is now checked as an in_review task.
    assert_eq!(
        invocations(&gh_runner)[2].args[..2],
        ["pr", "view"].map(str::to_owned)
    );
}

#[test]
fn an_in_progress_task_whose_pull_request_was_merged_is_completed_in_one_check() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
        log(&[]),
    ]);
    let gh_runner = runner(vec![
        listed("MERGED", "main"),
        viewed("MERGED", "main"),
        merged_details(&[]),
    ]);
    let (git, github) = adapters(&git_runner, &gh_runner);
    let (herdr, herdr_runner) = closing_herdr();
    let recorder = Recorder::default();
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &herdr,
        &recorder,
        &mut failures,
        None,
        &statuses,
    );

    let done = stored(&fixture, &fixture.task);
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.pull_request_url.as_deref(), Some(PR));
    assert_eq!(done.pull_request_merged_at, Some(MERGED_AT.1));
    assert!(dependent_ready(&fixture));
    assert_eq!(invocations(&herdr_runner).len(), 1);
    assert_eq!(recorder.0.lock().unwrap().len(), 2);
    assert!(failures.is_empty());
}

#[test]
fn a_closed_pull_request_or_one_into_another_base_keeps_the_task_in_progress() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
        worktrees(),
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
    ]);
    let gh_runner = runner(vec![listed("CLOSED", "main"), listed("OPEN", "develop")]);
    let (git, github) = adapters(&git_runner, &gh_runner);
    let recorder = Recorder::default();
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();

    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    assert!(failures.is_empty());
    check_pull_requests(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        &recorder,
        &mut failures,
        None,
        &statuses,
    );
    assert!(
        failures[&fixture.task.id].contains("merges into develop"),
        "{failures:?}"
    );

    assert_eq!(stored(&fixture, &fixture.task), fixture.task);
    assert!(recorder.0.lock().unwrap().is_empty());
    assert_eq!(
        git_commands(&git_runner),
        [
            "worktree", "remote", "remote", "worktree", "remote", "remote"
        ]
    );
}

#[test]
fn a_herdr_failure_keeps_the_task_in_review() {
    let fixture = in_review_fixture();
    let github = GhCli::new(Box::new(runner(vec![
        viewed("MERGED", "main"),
        merged_details(&[SHA_A]),
    ])));
    let herdr = Herdr::new(Box::new(runner(vec![Err(GitError::Spawn {
        program: "herdr".to_owned(),
        message: "program not found".to_owned(),
    })])));
    let before = stored(&fixture, &fixture.task);

    let error = complete(
        &fixture.storage,
        &no_git(),
        &github,
        &herdr,
        fixture.task.id,
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::External);
    // The merge is recorded on the criterion; everything else stays as it was.
    let mut after = stored(&fixture, &fixture.task);
    assert_eq!(after.criteria[0].state, CriterionState::Met);
    after.criteria = before.criteria.clone();
    assert_eq!(after, before);
    assert!(!dependent_ready(&fixture));
}
