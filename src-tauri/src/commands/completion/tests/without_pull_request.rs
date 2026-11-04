use super::*;

#[test]
fn completing_without_a_pull_request_records_the_note_commits_and_readiness() {
    for status in [TaskStatus::InProgress, TaskStatus::InReview] {
        let fixture = local_fixture();
        if status == TaskStatus::InReview {
            lock(&fixture.storage)
                .set_task_status(fixture.task.id, status)
                .unwrap();
        }
        let git_runner = runner(vec![
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
            log(&[SHA_A, SHA_B]),
        ]);
        let (git, github) = adapters(&git_runner, &runner(vec![Ok("[]".to_owned())]));

        let done = complete_without_pull_request(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
            "  Deployed the configuration directly  ",
        )
        .unwrap();

        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
        assert_eq!(done.pull_request_url, None);
        assert_eq!(done.pull_request_merged_at, None);
        assert_eq!(done.merged_with, None);
        assert_eq!(
            done.completion_note.as_deref(),
            Some("Deployed the configuration directly")
        );
        assert!(done.criteria[0].is_met());
        assert_eq!(done.criteria[0].evidence, done.completion_note);
        assert_eq!(recorded_shas(&fixture), [SHA_A, SHA_B]);
        assert!(dependent_ready(&fixture));
        assert_eq!(stored(&fixture, &fixture.task), done);
        lock(&fixture.storage)
            .ensure_ready(fixture.dependent.id)
            .unwrap();
    }
}

#[test]
fn completing_without_a_pull_request_requires_a_non_empty_note() {
    let fixture = local_fixture();
    for note in ["", " \n\t "] {
        let error = complete_without_pull_request(
            &fixture.storage,
            &no_git(),
            &GhCli::new(Box::new(runner(vec![]))),
            &no_herdr(),
            fixture.task.id,
            note,
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(error.message.contains("note"));
        assert_eq!(stored(&fixture, &fixture.task), fixture.task);
    }
}

#[test]
fn completing_without_a_pull_request_rejects_every_existing_pr_state() {
    for state in ["MERGED", "OPEN", "CLOSED"] {
        for recorded in [false, true] {
            let fixture = local_fixture();
            if recorded {
                lock(&fixture.storage)
                    .open_pull_request(fixture.task.id, &[], PR, None)
                    .unwrap();
            }
            let before = stored(&fixture, &fixture.task);
            let git_runner = runner(vec![
                Ok("origin\n".to_owned()),
                origin("git@github.com:acme/toodo.git"),
            ]);
            let (git, github) = adapters(&git_runner, &runner(vec![listed(state, "main")]));

            let error = complete_without_pull_request(
                &fixture.storage,
                &git,
                &github,
                &no_herdr(),
                fixture.task.id,
                "Shipped",
            )
            .unwrap_err();

            assert_eq!(error.kind, CommandErrorKind::Rejected);
            assert!(error.message.contains(PR), "{}", error.message);
            assert!(
                error.message.contains(if state == "MERGED" {
                    "call complete_task"
                } else {
                    "wait for"
                }),
                "{}",
                error.message
            );
            assert_eq!(stored(&fixture, &fixture.task), before);
            assert!(!dependent_ready(&fixture));
        }
    }
}

#[test]
fn completing_without_a_pull_request_keeps_other_criteria_required() {
    let fixture = local_criteria_fixture(vec![
        NewCriterion::merge(true),
        manual("Verify deployment"),
        NewCriterion::parse("CI passes", CheckKind::PullRequestOpenChecksPassed, None).unwrap(),
        NewCriterion::parse("Health check", CheckKind::Url, Some("https://example.com")).unwrap(),
        NewCriterion::parse("Tests", CheckKind::Command, Some("npm test")).unwrap(),
    ]);
    lock(&fixture.storage)
        .clear_task_worktree(fixture.task.id)
        .unwrap();
    let (git, github) = adapters(
        &runner(vec![Ok(String::new()), Err(failed())]),
        &runner(vec![]),
    );

    let error = complete_without_pull_request(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
        "Deployed",
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error.message.contains("4 of its completion criteria"),
        "{}",
        error.message
    );
    for next in ["check_criterion", "fix its CI", "make URL", "make command"] {
        assert!(error.message.contains(next), "{}", error.message);
    }
    let after = stored(&fixture, &fixture.task);
    assert!(
        !after.criteria[0].is_met(),
        "a failed attempt must not persist the waiver"
    );
    assert_eq!(after.completion_note, None);
    assert!(!dependent_ready(&fixture));
}

#[test]
fn completing_without_a_pull_request_keeps_met_manual_evidence() {
    let fixture = local_criteria_fixture(vec![NewCriterion::merge(true), manual("Verified")]);
    lock(&fixture.storage)
        .check_criterion(
            fixture.task.id,
            fixture.task.criteria[1].id,
            true,
            Some("Verified on the deployed system"),
            criteria::CheckedBy::Agent,
        )
        .unwrap();
    let (git, github) = adapters(
        &runner(vec![Ok(String::new()), log(&[SHA_A])]),
        &runner(vec![]),
    );

    let done = complete_without_pull_request(
        &fixture.storage,
        &git,
        &github,
        &closing_herdr().0,
        fixture.task.id,
        "Deployed without a pull request",
    )
    .unwrap();

    assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
    assert_eq!(
        done.criteria[1].evidence.as_deref(),
        Some("Verified on the deployed system")
    );
    assert!(dependent_ready(&fixture));
}

#[test]
fn a_failed_no_pr_completion_does_not_persist_the_merge_waiver() {
    let fixture = local_fixture();
    let (git, github) = adapters(
        &runner(vec![Ok(String::new()), log(&[SHA_A])]),
        &runner(vec![]),
    );
    let herdr = Herdr::new(Box::new(runner(vec![Err(failed())])));

    let error = complete_without_pull_request(
        &fixture.storage,
        &git,
        &github,
        &herdr,
        fixture.task.id,
        "Deployed",
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::External);
    assert_eq!(stored(&fixture, &fixture.task), fixture.task);
    assert!(!dependent_ready(&fixture));
}

#[test]
fn no_pr_completion_rejects_a_recorded_pr_missing_from_the_branch_lookup() {
    let fixture = local_fixture();
    lock(&fixture.storage)
        .open_pull_request(fixture.task.id, &[], PR, None)
        .unwrap();
    let before = stored(&fixture, &fixture.task);
    let (git, github) = adapters(
        &runner(vec![Ok(String::new())]),
        &runner(vec![viewed("MERGED", "main")]),
    );

    let error = complete_without_pull_request(
        &fixture.storage,
        &git,
        &github,
        &no_herdr(),
        fixture.task.id,
        "Deployed",
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("call complete_task"));
    assert_eq!(stored(&fixture, &fixture.task), before);
}

#[test]
fn a_task_without_criteria_or_a_branch_completes_as_completed() {
    let fixture = local_fixture();
    let task = {
        let mut storage = lock(&fixture.storage);
        let task = storage
            .create_task(&NewTask {
                workspace_id: fixture.task.workspace_id,
                task_type: TaskType::Chore,
                title: "Configure deployment".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: vec![],
            })
            .unwrap();
        storage
            .set_task_status(task.id, TaskStatus::InProgress)
            .unwrap()
    };
    let github = GhCli::new(Box::new(runner(vec![])));

    let done = complete(&fixture.storage, &no_git(), &github, &no_herdr(), task.id).unwrap();

    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
    assert_eq!(
        lock(&fixture.storage).get_task(task.id).unwrap(),
        Some(done)
    );
}
