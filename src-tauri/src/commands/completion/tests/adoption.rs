use super::*;

#[test]
fn completing_discovers_a_merged_pull_request_before_a_newer_closed_one() {
    for status in [TaskStatus::InProgress, TaskStatus::InReview] {
        for worktree in [true, false] {
            let fixture = local_fixture();
            if status == TaskStatus::InReview {
                lock(&fixture.storage)
                    .set_task_status(fixture.task.id, status)
                    .unwrap();
            }
            if !worktree {
                lock(&fixture.storage)
                    .clear_task_worktree(fixture.task.id)
                    .unwrap();
            }
            let mut git_results = vec![
                Ok("origin\n".to_owned()),
                origin("git@github.com:acme/toodo.git"),
            ];
            if worktree {
                git_results.push(log(&[]));
            }
            let gh_runner = runner(vec![
                merged_before_closed(),
                viewed("MERGED", "main").map(|value| value.replace("/pull/12", "/pull/11")),
                merged_details(&[SHA_A])
                    .map(|value| value.replace("\"number\":12", "\"number\":11")),
            ]);
            let (git, github) = adapters(&runner(git_results), &gh_runner);

            let done = complete(
                &fixture.storage,
                &git,
                &github,
                &closing_herdr().0,
                fixture.task.id,
            )
            .unwrap();

            assert_eq!(done.status, TaskStatus::Done);
            assert_eq!(done.resolution, Some(model::TaskResolution::Merged));
            assert_eq!(
                done.pull_request_url.as_deref(),
                Some("https://github.com/acme/toodo/pull/11")
            );
            assert_eq!(done.pull_request_merged_at, Some(MERGED_AT.1));
            assert_eq!(done.pull_request.as_ref().unwrap().number, 11);
            assert_eq!(recorded_shas(&fixture), [SHA_A]);
            assert!(dependent_ready(&fixture));
            assert_eq!(stored(&fixture, &fixture.task), done);
        }
    }
}

#[test]
fn background_checks_discover_merged_pull_requests_without_a_worktree() {
    for status in [TaskStatus::InProgress, TaskStatus::InReview] {
        let fixture = local_fixture();
        if status == TaskStatus::InReview {
            lock(&fixture.storage)
                .set_task_status(fixture.task.id, status)
                .unwrap();
        }
        lock(&fixture.storage)
            .clear_task_worktree(fixture.task.id)
            .unwrap();
        let git_runner = runner(vec![
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
        ]);
        let gh_runner = runner(vec![
            merged_before_closed(),
            viewed("MERGED", "main").map(|value| value.replace("/pull/12", "/pull/11")),
            merged_details(&[SHA_A]).map(|value| value.replace("\"number\":12", "\"number\":11")),
        ]);
        let (git, github) = adapters(&git_runner, &gh_runner);
        let mut failures = HashMap::new();

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            &Recorder::default(),
            &mut failures,
            None,
            &PullRequestStatusState::default(),
        );

        let done = stored(&fixture, &fixture.task);
        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.resolution, Some(model::TaskResolution::Merged));
        assert_eq!(
            done.pull_request_url.as_deref(),
            Some("https://github.com/acme/toodo/pull/11")
        );
        assert_eq!(done.pull_request_merged_at, Some(MERGED_AT.1));
        assert_eq!(done.pull_request.as_ref().unwrap().number, 11);
        assert!(failures.is_empty(), "{failures:?}");
        assert!(dependent_ready(&fixture));
    }
}

#[test]
fn adopting_an_open_pull_request_without_a_worktree_keeps_recorded_commits() {
    for status in [TaskStatus::InProgress, TaskStatus::InReview] {
        let fixture = local_fixture();
        if status == TaskStatus::InReview {
            lock(&fixture.storage)
                .set_task_status(fixture.task.id, status)
                .unwrap();
        }
        lock(&fixture.storage)
            .clear_task_worktree(fixture.task.id)
            .unwrap();
        let records = vec![model::CommitRecord {
            task_id: fixture.task.id,
            sha: SHA_A.to_owned(),
            message: "Add login".to_owned(),
            author: "Ada <ada@example.com>".to_owned(),
            committed_at: 1,
        }];
        lock(&fixture.storage)
            .replace_commit_records(fixture.task.id, &records)
            .unwrap();
        let git_runner = runner(vec![
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
        ]);
        let gh_runner = runner(vec![Ok(format!(
            "[{},{}]",
            pull_request_json("CLOSED", "main"),
            pull_request_json("OPEN", "main").replace("/pull/12", "/pull/11"),
        ))]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let adopted = adopt_pull_request(&fixture.storage, &git, &github, fixture.task.id)
            .unwrap()
            .unwrap();

        assert_eq!(adopted.status, TaskStatus::InReview);
        assert_eq!(
            adopted.pull_request_url.as_deref(),
            Some("https://github.com/acme/toodo/pull/11")
        );
        assert_eq!(adopted.pull_request_merged_at, None);
        assert_eq!(recorded_shas(&fixture), [SHA_A]);
        assert_eq!(git_commands(&git_runner), ["remote", "remote"]);
    }
}

#[test]
fn merged_with_rejects_an_own_merged_pull_request_before_a_newer_closed_one() {
    let fixture = local_fixture();
    lock(&fixture.storage)
        .clear_task_worktree(fixture.task.id)
        .unwrap();
    let git_runner = runner(vec![
        log(&[]),
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
    ]);
    let gh_runner = runner(vec![
        viewed("MERGED", "main").map(|value| value.replace("/pull/12", "/pull/13")),
        merged_before_closed(),
    ]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let error = complete_merged_with(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
        MergedWithTarget::PullRequest("https://github.com/acme/toodo/pull/13".to_owned()),
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error
            .message
            .contains("https://github.com/acme/toodo/pull/11")
    );
    assert_eq!(
        stored(&fixture, &fixture.task).status,
        TaskStatus::InProgress
    );
}

#[test]
fn an_open_pull_request_opened_outside_toodo_is_adopted_and_pushed() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![
        log(&[SHA_A]),
        origin("git@github.com:acme/toodo.git"),
        Ok(String::new()),
    ]);
    let gh_runner = runner(vec![listed("OPEN", "main")]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

    assert_eq!(in_review.status, TaskStatus::InReview);
    assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
    assert_eq!(
        git_commands(&git_runner),
        ["worktree", "log", "remote", "push"]
    );
    assert_eq!(invocations(&gh_runner).len(), 1);
    assert_eq!(recorded_shas(&fixture), [SHA_A]);
}

#[test]
fn a_merged_pull_request_is_adopted_without_pushing_and_can_be_completed() {
    let fixture = local_fixture();
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
    let git_runner = checkout_runner(vec![log(&[]), origin("git@github.com:acme/toodo.git")]);
    let gh_runner = runner(vec![
        listed("MERGED", "main"),
        viewed("MERGED", "main"),
        merged_details(&[]),
    ]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

    assert_eq!(in_review.status, TaskStatus::InReview);
    assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
    assert_eq!(in_review.pull_request_merged_at, Some(MERGED_AT.1));
    assert_eq!(git_commands(&git_runner), ["worktree", "log", "remote"]);
    assert_eq!(invocations(&gh_runner).len(), 1);
    assert_eq!(recorded_shas(&fixture), [SHA_A]);
    assert!(!dependent_ready(&fixture));

    let completed = complete(
        &fixture.storage,
        &no_git(),
        &github,
        &closing_herdr().0,
        fixture.task.id,
    )
    .unwrap();
    assert_eq!(completed.status, TaskStatus::Done);
    assert!(dependent_ready(&fixture));
    // A pull request without commits keeps the commits recorded before.
    assert_eq!(recorded_shas(&fixture), [SHA_A]);
}

#[test]
fn a_closed_pull_request_is_replaced_by_a_new_one() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![
        log(&[SHA_A]),
        origin("git@github.com:acme/toodo.git"),
        Ok(String::new()),
    ]);
    let new_pr = "https://github.com/acme/toodo/pull/13";
    let gh_runner = runner(vec![listed("CLOSED", "develop"), Ok(format!("{new_pr}\n"))]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

    assert_eq!(in_review.pull_request_url.as_deref(), Some(new_pr));
    assert_eq!(
        git_commands(&git_runner),
        ["worktree", "log", "remote", "push"]
    );
    assert_eq!(invocations(&gh_runner)[1].args[..2], ["pr", "create"]);
}

#[test]
fn a_pull_request_into_another_base_is_rejected_when_opening() {
    let fixture = local_fixture();
    let git_runner = checkout_runner(vec![log(&[SHA_A]), origin("git@github.com:acme/toodo.git")]);
    let gh_runner = runner(vec![listed("OPEN", "develop")]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    let error = open(&fixture.storage, &git, &github, fixture.task.id).unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error
            .message
            .contains("merges into develop, not the workspace base branch main"),
        "{}",
        error.message
    );
    assert_eq!(git_commands(&git_runner), ["worktree", "log", "remote"]);
    assert_eq!(stored(&fixture, &fixture.task), fixture.task);
    assert!(recorded_shas(&fixture).is_empty());
}

#[test]
fn a_pull_request_into_another_base_is_rejected_when_completing() {
    let fixture = in_review_fixture();
    let github = GhCli::new(Box::new(runner(vec![viewed("MERGED", "develop")])));

    let error = complete(
        &fixture.storage,
        &no_git(),
        &github,
        &no_herdr(),
        fixture.task.id,
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("merges into develop"));
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
    assert!(!dependent_ready(&fixture));
}
