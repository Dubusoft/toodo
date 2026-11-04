use super::*;

#[test]
fn concluding_closes_the_open_pull_request_and_keeps_dependents_waiting() {
    let fixture = in_review_fixture();
    let git_runner = runner(vec![
        log(&[SHA_A, SHA_B]),
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
    ]);
    let gh_runner = runner(vec![listed("OPEN", "main"), Ok(String::new())]);
    let (git, github) = adapters(&git_runner, &gh_runner);
    let (herdr, herdr_runner) = closing_herdr();

    let concluded = conclude(
        &fixture.storage,
        &git,
        &github,
        &herdr,
        fixture.task.id,
        "  Twice as slow as the current cache\n",
        OpenPullRequest::Close,
    )
    .unwrap();

    assert_eq!(concluded.status, TaskStatus::Done);
    assert_eq!(
        concluded.resolution,
        Some(model::TaskResolution::NotAdopted)
    );
    assert_eq!(
        concluded.completion_note.as_deref(),
        Some("Twice as slow as the current cache")
    );
    assert_eq!(
        concluded.timeline.last().map(|event| event.status),
        Some(TaskStatus::Done)
    );
    assert_eq!(concluded.branch.as_deref(), Some("feat/add-login-1"));
    assert_eq!(concluded.worktree_path, fixture.task.worktree_path);
    assert_eq!(concluded.pull_request_url.as_deref(), Some(PR));
    assert_eq!(concluded.herdr_workspace_id, None);
    assert_eq!(stored(&fixture, &fixture.task), concluded);
    assert_eq!(recorded_shas(&fixture), [SHA_A, SHA_B]);
    assert_eq!(git_commands(&git_runner), ["log", "remote", "remote"]);
    assert_eq!(
        invocations(&gh_runner)[0].args[..8],
        [
            "pr",
            "list",
            "--repo",
            "github.com/acme/toodo",
            "--head",
            "feat/add-login-1",
            "--base",
            "main"
        ]
        .map(str::to_owned)
    );
    assert_eq!(
        invocations(&gh_runner)[1].args,
        [
            "pr",
            "close",
            PR,
            "--comment",
            "Twice as slow as the current cache"
        ]
        .map(str::to_owned)
    );
    assert_eq!(
        invocations(&herdr_runner)[0].args,
        ["workspace", "close", "w27"].map(str::to_owned)
    );
    assert!(!dependent_ready(&fixture));
}

#[test]
fn concluding_an_in_progress_task_whose_branch_has_no_pull_request() {
    let fixture = local_fixture();
    let git_runner = runner(vec![
        log(&[]),
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
    ]);
    let gh_runner = runner(vec![Ok("[]\n".to_owned())]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let concluded = conclude(
        &fixture.storage,
        &git,
        &github,
        &closing_herdr().0,
        fixture.task.id,
        "Not worth it",
        OpenPullRequest::Close,
    )
    .unwrap();

    assert_eq!(
        concluded.resolution,
        Some(model::TaskResolution::NotAdopted)
    );
    assert_eq!(concluded.pull_request_url, None);
    assert_eq!(invocations(&gh_runner).len(), 1);
    assert!(recorded_shas(&fixture).is_empty());
    assert!(!dependent_ready(&fixture));

    // A done task cannot be concluded again.
    let error = conclude(
        &fixture.storage,
        &no_git(),
        &github,
        &no_herdr(),
        fixture.task.id,
        "Again",
        OpenPullRequest::Close,
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
}

#[test]
fn concluding_a_task_whose_pull_request_was_closed_does_not_close_it_again() {
    let fixture = in_review_fixture();
    let gh_runner = runner(vec![listed("CLOSED", "main")]);
    let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);

    let concluded = conclude(
        &fixture.storage,
        &git,
        &github,
        &closing_herdr().0,
        fixture.task.id,
        "Superseded",
        OpenPullRequest::Close,
    )
    .unwrap();

    assert_eq!(concluded.status, TaskStatus::Done);
    assert_eq!(invocations(&gh_runner).len(), 1);
}

#[test]
fn concluding_without_closing_rejects_an_open_pull_request_and_changes_nothing() {
    let fixture = in_review_fixture();
    let before = stored(&fixture, &fixture.task);
    let gh_runner = runner(vec![listed("OPEN", "main")]);
    let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);

    let error = conclude(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
        "Not adopted",
        OpenPullRequest::Reject,
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("is still open"), "{}", error.message);
    assert_eq!(invocations(&gh_runner).len(), 1);
    assert_eq!(stored(&fixture, &fixture.task), before);
    assert!(recorded_shas(&fixture).is_empty());
}

#[test]
fn concluding_is_rejected_without_a_note_for_planned_tasks_and_for_merged_pull_requests() {
    let fixture = in_review_fixture();
    let before = stored(&fixture, &fixture.task);

    let error = conclude(
        &fixture.storage,
        &no_git(),
        &GhCli::new(Box::new(runner(Vec::new()))),
        &no_herdr(),
        fixture.task.id,
        " \n",
        OpenPullRequest::Close,
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);

    let error = conclude(
        &fixture.storage,
        &no_git(),
        &GhCli::new(Box::new(runner(Vec::new()))),
        &no_herdr(),
        fixture.dependent.id,
        "Not needed",
        OpenPullRequest::Close,
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error
            .message
            .contains("only an in_progress or in_review task")
    );

    let gh_runner = runner(vec![listed("MERGED", "main")]);
    let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);
    let error = conclude(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
        "Not adopted",
        OpenPullRequest::Close,
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("was merged"), "{}", error.message);
    assert_eq!(invocations(&gh_runner).len(), 1);
    assert_eq!(stored(&fixture, &fixture.task), before);
}

#[test]
fn concluding_finds_an_open_pull_request_that_was_not_recorded_yet() {
    let fixture = local_fixture();
    let before = stored(&fixture, &fixture.task);
    assert_eq!(before.pull_request_url, None);

    // Through MCP the conclusion is rejected and nothing changes.
    let gh_runner = runner(vec![listed("OPEN", "main")]);
    let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);
    let error = conclude(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
        "Not adopted",
        OpenPullRequest::Reject,
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error.message.contains(&format!("{PR} is still open")),
        "{}",
        error.message
    );
    assert_eq!(invocations(&gh_runner).len(), 1);
    assert_eq!(stored(&fixture, &fixture.task), before);
    assert!(recorded_shas(&fixture).is_empty());

    // The app closes it with the conclusion, records it, and concludes.
    let gh_runner = runner(vec![listed("OPEN", "main"), Ok(String::new())]);
    let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);
    let concluded = conclude(
        &fixture.storage,
        &git,
        &github,
        &closing_herdr().0,
        fixture.task.id,
        "Not adopted",
        OpenPullRequest::Close,
    )
    .unwrap();
    assert_eq!(concluded.status, TaskStatus::Done);
    assert_eq!(
        concluded.resolution,
        Some(model::TaskResolution::NotAdopted)
    );
    assert_eq!(concluded.pull_request_url.as_deref(), Some(PR));
    assert_eq!(stored(&fixture, &fixture.task), concluded);
    assert_eq!(
        invocations(&gh_runner)[1].args,
        ["pr", "close", PR, "--comment", "Not adopted"].map(str::to_owned)
    );
}

#[test]
fn concluding_is_rejected_for_a_merged_pull_request_that_was_not_recorded_yet() {
    let fixture = local_fixture();
    let before = stored(&fixture, &fixture.task);
    for open_pull_request in [OpenPullRequest::Reject, OpenPullRequest::Close] {
        let gh_runner = runner(vec![merged_before_closed()]);
        let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);
        let error = conclude(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
            "Not adopted",
            open_pull_request,
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("completes with the merge"),
            "{}",
            error.message
        );
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert_eq!(stored(&fixture, &fixture.task), before);
    }
}

#[test]
fn concluding_skips_gh_for_a_repository_without_origin() {
    let fixture = local_fixture();
    let git_runner = runner(vec![log(&[]), Ok(String::new())]);
    let gh_runner = runner(Vec::new());
    let (git, github) = adapters(&git_runner, &gh_runner);

    let concluded = conclude(
        &fixture.storage,
        &git,
        &github,
        &closing_herdr().0,
        fixture.task.id,
        "Not worth it",
        OpenPullRequest::Reject,
    )
    .unwrap();

    assert_eq!(concluded.status, TaskStatus::Done);
    assert_eq!(git_commands(&git_runner), ["log", "remote"]);
    assert!(invocations(&gh_runner).is_empty());
}

#[test]
fn concluding_fails_and_changes_nothing_when_the_lookup_fails() {
    let fixture = in_review_fixture();
    let before = stored(&fixture, &fixture.task);
    let gh_runner = runner(vec![Err(GitError::Failed {
        command: "gh pr list".to_owned(),
        stderr: "error connecting to api.github.com".to_owned(),
    })]);
    let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);

    let error = conclude(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
        "Not adopted",
        OpenPullRequest::Close,
    )
    .unwrap_err();

    assert!(
        error.message.contains("error connecting to api.github.com"),
        "{}",
        error.message
    );
    assert_eq!(invocations(&gh_runner).len(), 1);
    assert_eq!(stored(&fixture, &fixture.task), before);
    assert!(recorded_shas(&fixture).is_empty());
}
