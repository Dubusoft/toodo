use super::*;

#[test]
fn completing_a_task_with_a_merged_pull_request_finishes_it_and_releases_dependents() {
    let fixture = in_review_fixture();
    lock(&fixture.storage)
        .replace_commit_records(
            fixture.task.id,
            &[model::CommitRecord {
                task_id: fixture.task.id,
                sha: SHA_A.to_owned(),
                message: "Add login".to_owned(),
                author: "Ada <ada@example.com>".to_owned(),
                committed_at: 1,
            }],
        )
        .unwrap();
    let gh_runner = runner(vec![
        viewed("MERGED", "main"),
        merged_details(&[SHA_A, SHA_B]),
    ]);
    let github = GhCli::new(Box::new(gh_runner.clone()));
    let (herdr, herdr_runner) = closing_herdr();

    let completed = complete(
        &fixture.storage,
        &no_git(),
        &github,
        &herdr,
        fixture.task.id,
    )
    .unwrap();

    assert_eq!(
        completed.pull_request,
        Some(model::PullRequestSnapshot {
            number: 12,
            title: "Add login".to_owned(),
            additions: 10,
            deletions: 3,
            changed_files: 2,
            merge_commit_sha: Some(SHA_B.to_owned()),
            review_count: 1,
            reviewer_count: 1,
            first_reviewed_at: Some(MERGED_AT.1),
        })
    );
    // The commits pushed after the pull request was opened are recorded too.
    assert_eq!(recorded_shas(&fixture), [SHA_A, SHA_B]);
    assert_eq!(completed.completion_note, None);

    assert_eq!(completed.status, TaskStatus::Done);
    assert_eq!(completed.pull_request_url.as_deref(), Some(PR));
    assert_eq!(completed.pull_request_merged_at, Some(MERGED_AT.1));
    assert_eq!(
        completed.timeline.last().map(|event| event.status),
        Some(TaskStatus::Done)
    );
    assert_eq!(completed.herdr_workspace_id, None);
    assert_eq!(completed.worktree_path, fixture.task.worktree_path);
    assert_eq!(stored(&fixture, &fixture.task), completed);
    assert_eq!(
        invocations(&herdr_runner)[0].args,
        ["workspace", "close", "w27"].map(str::to_owned)
    );
    assert!(dependent_ready(&fixture));
    assert_eq!(
            invocations(&gh_runner)[0].args,
            [
                "pr",
                "view",
                PR,
                "--json",
                "url,state,baseRefName,mergedAt,statusCheckRollup,reviewDecision,latestReviews,headRefOid"
            ]
            .map(str::to_owned)
        );
    assert_eq!(invocations(&gh_runner)[1].args[..3], ["pr", "view", PR]);
}

#[test]
fn a_failure_to_read_the_merged_pull_request_keeps_the_task_in_review() {
    let fixture = in_review_fixture();
    let github = GhCli::new(Box::new(runner(vec![
        viewed("MERGED", "main"),
        Err(failed()),
    ])));
    let before = stored(&fixture, &fixture.task);

    complete(
        &fixture.storage,
        &no_git(),
        &github,
        &no_herdr(),
        fixture.task.id,
    )
    .unwrap_err();

    // The merge is recorded on the criterion; everything else stays as it was.
    let mut after = stored(&fixture, &fixture.task);
    assert_eq!(after.criteria[0].state, CriterionState::Met);
    after.criteria = before.criteria.clone();
    assert_eq!(after, before);
    assert!(!dependent_ready(&fixture));
}

#[test]
fn a_pull_request_that_is_not_merged_keeps_the_task_in_review() {
    let fixture = in_review_fixture();
    let github = GhCli::new(Box::new(runner(vec![
        viewed("OPEN", "main"),
        viewed("CLOSED", "main"),
    ])));

    for expected in [
        "is not merged yet",
        "was closed without merging; reopen the pull request, ask the user to pause the task in the Toodo app, or conclude_task if the work is abandoned",
    ] {
        let error = complete(
            &fixture.storage,
            &no_git(),
            &github,
            &no_herdr(),
            fixture.task.id,
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains(expected), "{}", error.message);
    }
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
    assert!(!dependent_ready(&fixture));
}

#[test]
fn only_an_in_review_task_can_be_completed() {
    let fixture = local_fixture();
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
        error.message.contains("the task has no pull request yet"),
        "{}",
        error.message
    );
    assert!(invocations(&gh_runner).is_empty());
    let error = complete(
        &fixture.storage,
        &no_git(),
        &github,
        &no_herdr(),
        model::TaskId(999),
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
}

#[test]
fn a_herdr_workspace_that_is_already_closed_does_not_block_completion() {
    let fixture = in_review_fixture();
    let github = GhCli::new(Box::new(runner(vec![
        viewed("MERGED", "main"),
        merged_details(&[]),
    ])));
    let herdr = Herdr::new(Box::new(runner(vec![Err(GitError::Failed {
        command: "herdr workspace close".to_owned(),
        stderr: r#"{"error":{"code":"workspace_not_found","message":"workspace w27 not found"}}"#
            .to_owned(),
    })])));

    let completed = complete(
        &fixture.storage,
        &no_git(),
        &github,
        &herdr,
        fixture.task.id,
    )
    .unwrap();

    assert_eq!(completed.status, TaskStatus::Done);
    assert_eq!(completed.herdr_workspace_id, None);
}

#[test]
fn completing_a_done_task_says_how_it_was_done() {
    let fixture = local_fixture();
    let git_runner = runner(vec![log(&[]), Ok(String::new())]);
    let (git, github) = adapters(&git_runner, &runner(Vec::new()));
    conclude(
        &fixture.storage,
        &git,
        &github,
        &closing_herdr().0,
        fixture.task.id,
        "Not worth it",
        OpenPullRequest::Close,
    )
    .unwrap();

    let error = complete(
        &fixture.storage,
        &no_git(),
        &github,
        &no_herdr(),
        fixture.task.id,
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error.message.contains("is already done as not_adopted"),
        "{}",
        error.message
    );
}
