use super::*;

#[test]
fn a_new_pull_request_of_a_task_with_an_issue_closes_it() {
    let fixture = local_fixture();
    link_issue(&fixture);
    let git_runner = checkout_runner(vec![
        log(&[SHA_A]),
        origin("git@github.com:acme/toodo.git"),
        Ok(String::new()),
    ]);
    let gh_runner = runner(vec![Ok("[]".to_owned()), Ok(format!("{PR}\n"))]);
    let (git, github) = adapters(&git_runner, &gh_runner);

    open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

    let create = &invocations(&gh_runner)[1].args;
    assert_eq!(create[1], "create");
    assert_eq!(create.last().unwrap(), "Implement Add login\n\nCloses #12");
    assert_eq!(invocations(&gh_runner).len(), 2);
}

#[test]
fn an_adopted_open_pull_request_gets_a_closing_reference_unless_it_has_one() {
    for (existing, edited) in [
        ("Work by an agent", Some("Work by an agent\n\nCloses #12")),
        ("Work by an agent\n\nfixes #12", None),
    ] {
        let fixture = local_fixture();
        link_issue(&fixture);
        let git_runner = checkout_runner(vec![
            log(&[SHA_A]),
            origin("git@github.com:acme/toodo.git"),
            Ok(String::new()),
        ]);
        let gh_runner = runner(vec![
            listed("OPEN", "main"),
            body(existing),
            Ok(String::new()),
        ]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

        assert_eq!(in_review.status, TaskStatus::InReview);
        let calls = invocations(&gh_runner);
        assert_eq!(
            calls[1].args,
            ["pr", "view", PR, "--json", "body"].map(str::to_owned)
        );
        match edited {
            Some(edited) => assert_eq!(
                calls[2].args,
                ["pr", "edit", PR, "--body", edited].map(str::to_owned)
            ),
            None => assert_eq!(calls.len(), 2),
        }
    }
}

#[test]
fn a_pull_request_opened_by_an_agent_gets_a_closing_reference_in_the_same_check() {
    let fixture = local_fixture();
    link_issue(&fixture);
    let git_runner = checkout_runner(vec![
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
        log(&[SHA_A]),
        worktrees(),
    ]);
    let gh_runner = runner(vec![
        listed("OPEN", "main"),
        viewed_with_body("Work by an agent"),
        Ok(String::new()),
        viewed_with_body("Work by an agent\n\nCloses #12"),
    ]);
    let (git, github) = adapters(&git_runner, &gh_runner);
    let recorder = Recorder::default();
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();

    for _ in 0..2 {
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
    }

    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
    assert!(failures.is_empty());
    let calls = invocations(&gh_runner);
    // The body is read with the rest of the pull request.
    assert_eq!(
        calls[2].args,
        ["pr", "edit", PR, "--body", "Work by an agent\n\nCloses #12"].map(str::to_owned)
    );
    // The second check finds the reference and edits nothing.
    assert_eq!(calls.len(), 4);
}
