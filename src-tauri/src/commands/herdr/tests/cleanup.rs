use super::*;

const REMOVED: &str = r#"{"id":"cli:worktree:remove","result":{"type":"worktree_removed"}}"#;

#[test]
fn a_paused_task_removes_its_worktree_and_keeps_its_branch() {
    let (fixture, herdr, runner) = paused_task(vec![Ok(REMOVED.to_owned())]);

    let task =
        remove_worktree(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap();

    assert_eq!(
        (&task.worktree_path, &task.herdr_workspace_id),
        (&None, &None)
    );
    assert_eq!(task.branch.as_deref(), Some("feat/add-login-1"));
    assert_eq!(task.status, TaskStatus::Planned);
    assert_eq!(stored(&fixture), task);
    assert_eq!(
        invocations(&runner)[1].args,
        ["worktree", "remove", "--workspace", "w27"].map(str::to_owned)
    );
}

#[test]
fn a_dirty_worktree_is_kept_unless_forced() {
    let (fixture, herdr, runner) = paused_task(vec![
        herdr_failed("dirty_worktree_requires_force"),
        Ok(REMOVED.to_owned()),
    ]);
    let before = stored(&fixture);

    let error =
        remove_worktree(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains(r"D:\wt\toodo\feat-add-login-1"));
    assert_eq!(stored(&fixture), before);

    remove_worktree(&fixture.storage, &no_git(), &herdr, fixture.task.id, true).unwrap();
    assert_eq!(
        invocations(&runner)[2].args,
        ["worktree", "remove", "--workspace", "w27", "--force"].map(str::to_owned)
    );
    assert_eq!(stored(&fixture).worktree_path, None);
}

#[test]
fn a_worktree_herdr_no_longer_has_open_is_opened_again_to_remove_it() {
    let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w40"}}}"#;
    let (fixture, herdr, runner) = paused_task(vec![
        herdr_failed("workspace_not_found"),
        Ok(opened.to_owned()),
        Ok(REMOVED.to_owned()),
    ]);

    remove_worktree(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap();

    let invocations = invocations(&runner);
    assert_eq!(
        invocations[2].args,
        [
            "worktree",
            "open",
            "--cwd",
            r"C:\dev\toodo",
            "--path",
            r"D:\wt\toodo\feat-add-login-1",
            "--no-focus",
        ]
        .map(str::to_owned)
    );
    assert_eq!(
        invocations[3].args,
        ["worktree", "remove", "--workspace", "w40"].map(str::to_owned)
    );
    assert_eq!(stored(&fixture).worktree_path, None);
}

#[test]
fn a_worktree_that_is_already_gone_is_only_forgotten() {
    let (fixture, herdr, runner) = paused_task(vec![
        herdr_failed("workspace_not_found"),
        herdr_failed("worktree_not_found"),
    ]);

    let task =
        remove_worktree(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap();

    assert_eq!(
        (&task.worktree_path, &task.herdr_workspace_id),
        (&None, &None)
    );
    assert_eq!(invocations(&runner).len(), 3);
}

#[test]
fn other_herdr_failures_keep_the_worktree() {
    let (fixture, herdr, _) = paused_task(vec![herdr_failed("worktree_remove_failed")]);
    let before = stored(&fixture);

    let error =
        remove_worktree(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::External);
    assert_eq!(stored(&fixture), before);
}

#[test]
fn only_tasks_not_being_worked_on_with_a_worktree_remove_it() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);
    let id = fixture.task.id;

    let error = remove_worktree(&fixture.storage, &no_git(), &herdr, id, false).unwrap_err();
    assert_eq!(error.message, format!("task {id} has no worktree"));

    let fixture = local_fixture(Some(r"D:\wt"));
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    let error =
        remove_worktree(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error
            .message
            .contains("in progress and in review tasks keep")
    );
    assert_eq!(invocations(&runner).len(), 1);
}

#[test]
fn a_paused_task_restarts_in_its_kept_worktree() {
    let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w27"}}}"#;
    let (fixture, herdr, runner) = paused_task(vec![Ok(opened.to_owned())]);
    let mut renamed = stored(&fixture);
    renamed.title = "Add sign-in".to_owned();
    lock(&fixture.storage).update_task(&renamed).unwrap();
    let git = Git::new(Box::new(Arc::new(FakeRunner::new(Vec::new()))));

    let restarted = start(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

    assert_eq!(restarted.status, TaskStatus::InProgress);
    assert_eq!(restarted.branch.as_deref(), Some("feat/add-login-1"));
    assert_eq!(
        restarted.worktree_path,
        Some(HostPath::Windows(
            WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap()
        ))
    );
    assert_eq!(restarted.herdr_workspace_id.as_deref(), Some("w27"));
    assert_eq!(
        invocations(&runner)[1].args,
        [
            "worktree",
            "open",
            "--cwd",
            r"C:\dev\toodo",
            "--path",
            r"D:\wt\toodo\feat-add-login-1",
            "--no-focus",
        ]
        .map(str::to_owned)
    );
}

#[test]
fn a_paused_task_without_its_worktree_checks_its_branch_out_again() {
    let (fixture, herdr, runner) = paused_task(vec![
        herdr_failed("worktree_not_found"),
        Ok(RECREATED.to_owned()),
    ]);

    let restarted = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    assert_eq!(restarted.status, TaskStatus::InProgress);
    assert_eq!(restarted.herdr_workspace_id.as_deref(), Some("w31"));
    assert_eq!(
        invocations(&runner)[2].args[4..],
        [
            "--path",
            r"D:\wt\toodo\feat-add-login-1",
            "--branch",
            "feat/add-login-1",
            "--base",
            "feat/add-login-1",
            "--no-focus",
        ]
        .map(str::to_owned)
    );
}

fn runtime_failure(code: Option<&str>) -> HerdrError {
    HerdrError::Failed {
        command: "herdr worktree".to_owned(),
        code: code.map(str::to_owned),
        message: "failed".to_owned(),
    }
}

#[test]
fn a_runtime_failure_other_than_a_missing_checkout_keeps_a_paused_task_paused() {
    let (fixture, _, _) = paused_task(Vec::new());
    let before = stored(&fixture);
    let runtime = FakeRuntime::new(vec![Err(runtime_failure(Some("workspace_open_failed")))]);
    let git = Git::new(Box::new(Arc::new(FakeRunner::new(Vec::new()))));

    let error = start(&fixture.storage, &git, &runtime, fixture.task.id).unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::External);
    assert_eq!(
        runtime.calls(),
        [r"open C:\dev\toodo D:\wt\toodo\feat-add-login-1"]
    );
    assert_eq!(stored(&fixture), before);
}

#[test]
fn a_runtime_failure_creating_the_worktree_leaves_the_task_planned() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let before = stored(&fixture);
    let runtime = FakeRuntime::new(vec![Err(runtime_failure(None))]);

    let error = start(
        &fixture.storage,
        &existing_base(),
        &runtime,
        fixture.task.id,
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::External);
    assert_eq!(
        runtime.calls(),
        [r"create C:\dev\toodo D:\wt\toodo\feat-add-login-1 feat/add-login-1 main"]
    );
    assert_eq!(stored(&fixture), before);
}

#[test]
fn deleting_a_task_removes_its_worktree_first() {
    let (fixture, herdr, runner) = paused_task(vec![Ok(REMOVED.to_owned())]);

    delete(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap();

    assert_eq!(
        invocations(&runner)[1].args,
        ["worktree", "remove", "--workspace", "w27"].map(str::to_owned)
    );
    assert_eq!(
        lock(&fixture.storage).get_task(fixture.task.id).unwrap(),
        None
    );
}

#[test]
fn a_dirty_worktree_keeps_the_task_unless_the_delete_is_forced() {
    let (fixture, herdr, runner) = paused_task(vec![
        herdr_failed("dirty_worktree_requires_force"),
        Ok(REMOVED.to_owned()),
    ]);
    let before = stored(&fixture);

    let error = delete(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert_eq!(stored(&fixture), before);

    delete(&fixture.storage, &no_git(), &herdr, fixture.task.id, true).unwrap();
    assert_eq!(
        invocations(&runner)[2].args,
        ["worktree", "remove", "--workspace", "w27", "--force"].map(str::to_owned)
    );
    assert_eq!(
        lock(&fixture.storage).get_task(fixture.task.id).unwrap(),
        None
    );
}

#[test]
fn deleting_a_task_without_a_worktree_does_not_run_herdr() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(Vec::new());

    delete(&fixture.storage, &no_git(), &herdr, fixture.task.id, false).unwrap();

    assert!(invocations(&runner).is_empty());
    assert_eq!(
        lock(&fixture.storage).get_task(fixture.task.id).unwrap(),
        None
    );
}
