use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use super::*;
use crate::adapters::git::Runner;
use crate::commands::completion::background::check_pull_requests_on;

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
    let passed = r#"[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS","completedAt":"2026-10-09T12:00:00Z"}]"#;
    let mut view: serde_json::Value =
        serde_json::from_str(&viewed_with("MERGED", "main", passed, "\"\"").unwrap()).unwrap();
    view["headRefOid"] = serde_json::json!(SHA_B);
    let gh_runner = runner(vec![Ok(view.to_string()), merged_details(&[SHA_A, SHA_B])]);
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
    // The activity and the merge come from one read of the pull request.
    let calls = invocations(&gh_runner);
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].args[..3], ["pr", "view", PR].map(str::to_owned));
    assert!(recorder.0.lock().unwrap().contains(&done.workspace_id));
}

/// Starts another task of the fixture's workspace on `branch` and records `url` as its
/// open pull request.
fn another_in_review_task(fixture: &Fixture, branch: &str, url: &str) -> model::Task {
    let mut storage = lock(&fixture.storage);
    let task = storage
        .create_task(&NewTask {
            workspace_id: fixture.task.workspace_id,
            task_type: TaskType::Feat,
            title: "Add logout".to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            criteria: vec![NewCriterion::merge(true)],
        })
        .unwrap();
    let checkout = TaskCheckout {
        path: HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-logout-3").unwrap()),
        branch: branch.to_owned(),
    };
    storage.start_task(task.id, &checkout, "w28").unwrap();
    storage.open_pull_request(task.id, &[], url, None).unwrap()
}

/// `git worktree list` output with the worktrees of both in-review tasks.
fn both_worktrees() -> Result<String, GitError> {
    Ok(concat!(
        "worktree D:/wt/toodo/feat-add-login-1\0HEAD abc\0\0",
        "worktree D:/wt/toodo/feat-add-logout-3\0HEAD abc\0\0"
    )
    .to_owned())
}

#[test]
fn one_call_lists_the_open_pull_requests_of_a_repository_with_several_in_review() {
    // Given two in-review tasks whose pull requests are open in the same repository.
    let fixture = in_review_fixture();
    let other_url = PR.replace("/pull/12", "/pull/13");
    let other = another_in_review_task(&fixture, "feat/add-logout-3", &other_url);
    let running = r#"[{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""}]"#;
    let open = |url: &str, checks: &str| {
        let mut view: serde_json::Value =
            serde_json::from_str(&viewed_with("OPEN", "main", checks, "\"\"").unwrap()).unwrap();
        view["url"] = serde_json::json!(url);
        view
    };
    let gh_runner = runner(vec![Ok(serde_json::json!([
        open(PR, running),
        open(&other_url, "[]")
    ])
    .to_string())]);
    let github = GhCli::new(Box::new(gh_runner.clone()));
    let worktrees = runner(vec![both_worktrees(), both_worktrees()]);
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();

    // When the background check runs.
    check_pull_requests(
        &fixture.storage,
        &Git::new(Box::new(worktrees)),
        &github,
        &no_herdr(),
        &Recorder::default(),
        &mut failures,
        None,
        &statuses,
    );

    // Then one `gh pr list` read both pull requests, and nothing else ran.
    assert!(failures.is_empty(), "{failures:?}");
    let calls = invocations(&gh_runner);
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(
        calls[0].args[..6],
        [
            "pr",
            "list",
            "--repo",
            "github.com/acme/toodo",
            "--state",
            "open"
        ]
        .map(str::to_owned)
    );
    let checks: Vec<_> = list(&statuses)
        .into_iter()
        .map(|status| (status.task_id, status.checks))
        .collect();
    let id = |task: &model::Task| -> types::TaskId { task.id.into() };
    assert_eq!(
        checks,
        [
            (id(&fixture.task), Some(types::ChecksStatus::Pending)),
            (id(&other), None),
        ]
    );
}

#[test]
fn a_pull_request_missing_from_the_open_list_is_read_on_its_own() {
    let fixture = in_review_fixture();
    let other_url = PR.replace("/pull/12", "/pull/13");
    another_in_review_task(&fixture, "feat/add-logout-3", &other_url);
    let mut open: serde_json::Value =
        serde_json::from_str(&viewed("OPEN", "main").unwrap()).unwrap();
    open["url"] = serde_json::json!(other_url);
    let gh_runner = runner(vec![
        Ok(serde_json::json!([open]).to_string()),
        viewed("MERGED", "main"),
        merged_details(&[]),
    ]);
    let github = GhCli::new(Box::new(gh_runner.clone()));
    let (herdr, _) = closing_herdr();
    let mut failures = HashMap::new();

    check_pull_requests(
        &fixture.storage,
        &Git::new(Box::new(runner(vec![both_worktrees(), both_worktrees()]))),
        &github,
        &herdr,
        &Recorder::default(),
        &mut failures,
        None,
        &PullRequestStatusState::default(),
    );

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::Done);
    let calls = invocations(&gh_runner);
    assert_eq!(calls[1].args[..3], ["pr", "view", PR].map(str::to_owned));
    assert_eq!(calls.len(), 3);
}

#[test]
fn a_rate_limited_gh_is_not_called_again_until_the_limit_backs_off() {
    let fixture = in_review_fixture();
    let gh_runner = runner(vec![Err(GitError::Failed {
        command: "gh pr view".to_owned(),
        stderr: "GraphQL: API rate limit exceeded for user ID 1.".to_owned(),
    })]);
    let github = GhCli::new(Box::new(gh_runner.clone()));
    let mut failures = HashMap::new();
    let statuses = PullRequestStatusState::default();

    for _ in 0..3 {
        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &no_herdr(),
            &Recorder::default(),
            &mut failures,
            None,
            &statuses,
        );
    }

    assert_eq!(invocations(&gh_runner).len(), 1);
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
    assert!(
        failures[&fixture.task.id].contains("gh api rate_limit"),
        "{failures:?}"
    );
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

/// Holds every command until `release` is dropped, then fails it; `entered` hears of
/// each command.
struct Stalled {
    entered: Mutex<mpsc::Sender<()>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl Runner for Arc<Stalled> {
    fn run(&self, _: &Invocation) -> Result<String, GitError> {
        let _ = self.entered.lock().unwrap().send(());
        let _ = self.release.lock().unwrap().recv();
        Err(failed())
    }
}

#[test]
fn a_stalled_machine_does_not_hold_up_the_checks_of_another() {
    let fixture = in_review_fixture();
    let remote = {
        let mut storage = lock(&fixture.storage);
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "api".to_owned(),
                location: WorkspaceLocation::Ssh {
                    machine: MachineLabel::parse("devbox").unwrap(),
                    path: PosixPath::parse("/srv/api").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source: model::Source::GitHub,
                completion: model::CompletionMode::PullRequestMerge,
                runner: model::Runner::Herdr,
                axes_detected: true,
            })
            .unwrap();
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: "Add api".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: vec![NewCriterion::merge(true)],
            })
            .unwrap();
        let checkout = TaskCheckout {
            path: PosixPath::parse("/wt/api/feat-add-api-3").unwrap().into(),
            branch: "feat/add-api-3".to_owned(),
        };
        storage.start_task(task.id, &checkout, "w30").unwrap()
    };
    let (entered_sender, entered) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let stalled = Arc::new(Stalled {
        entered: Mutex::new(entered_sender),
        release: Mutex::new(released),
    });
    let devbox = model::Machine::Ssh(MachineLabel::parse("devbox").unwrap());
    let statuses = PullRequestStatusState::default();
    let gh_runner = runner(vec![viewed("MERGED", "main"), merged_details(&[])]);
    let (herdr, _) = closing_herdr();
    let storage = &fixture.storage;
    let statuses = &statuses;

    let local_check = thread::scope(|scope| {
        let remote_check = scope.spawn(|| {
            check_pull_requests_on(
                Some(&devbox),
                storage,
                &Git::new(Box::new(stalled.clone())),
                &GhCli::new(Box::new(stalled.clone())),
                &no_herdr(),
                &Recorder::default(),
                &mut HashMap::new(),
                None,
                statuses,
            );
        });
        entered
            .recv_timeout(Duration::from_secs(10))
            .expect("the check of devbox runs a command there");
        let (finished, local_done) = mpsc::channel();
        scope.spawn(move || {
            check_pull_requests_on(
                Some(&model::Machine::Local),
                storage,
                &worktree_git(),
                &GhCli::new(Box::new(gh_runner.clone())),
                &herdr,
                &Recorder::default(),
                &mut HashMap::new(),
                None,
                statuses,
            );
            let _ = finished.send(());
        });
        // Released before asserting, so a check that waits for the stalled one ends too.
        let local_check = local_done.recv_timeout(Duration::from_secs(10));
        drop(release);
        remote_check.join().unwrap();
        local_check
    });

    assert_eq!(local_check, Ok(()), "the local check waited for devbox");
    assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::Done);
    assert_eq!(stored(&fixture, &remote).status, TaskStatus::InProgress);
}
