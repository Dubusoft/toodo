use super::*;

#[test]
fn restore_accepts_a_recorded_worktree_that_git_marks_missing() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (starter, _) = herdr(vec![Ok(CREATED.to_owned())]);
    start(
        &fixture.storage,
        &existing_base(),
        &starter,
        fixture.task.id,
    )
    .unwrap();
    let git = Git::new(Box::new(Arc::new(FakeRunner::new(vec![
            Ok("worktree D:/wt/toodo/feat-add-login-1\0HEAD abc\0prunable gitdir file points to non-existent location\0\0".to_owned()),
            Ok("abc\n".to_owned()),
        ]))));
    let (herdr, runner) = herdr(vec![Ok(RECREATED.to_owned())]);

    let task = restore(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

    assert_eq!(task.herdr_workspace_id.as_deref(), Some("w31"));
    assert!(task.worktree_path.is_some());
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(invocations(&runner).len(), 1);
}

#[test]
fn starting_an_active_task_explains_how_to_keep_working_or_restore_it() {
    let fixture = lost_worktree();
    let (herdr, runner) = herdr(Vec::new());

    let error = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap_err();

    assert!(error.message.contains("task 1 is already in progress"));
    assert!(
        error
            .message
            .contains("restore its worktree in the Toodo app")
    );
    assert!(invocations(&runner).is_empty());
}

#[test]
fn restore_checks_out_the_kept_branch_into_a_new_worktree() {
    let fixture = lost_worktree();
    let mut renamed = stored(&fixture);
    renamed.title = "Add sign-in".to_owned();
    lock(&fixture.storage).update_task(&renamed).unwrap();
    let (herdr, runner) = herdr(vec![Ok(RECREATED.to_owned())]);

    let restored = restore(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    assert_eq!(restored.status, TaskStatus::InProgress);
    assert_eq!(restored.branch.as_deref(), Some("feat/add-login-1"));
    assert_eq!(
        restored.worktree_path,
        Some(HostPath::Windows(
            WindowsPath::parse(r"D:\wt\toodo\feat-add-sign-in-1").unwrap()
        ))
    );
    assert_eq!(restored.herdr_workspace_id.as_deref(), Some("w31"));
    assert_eq!(stored(&fixture), restored);
    assert_eq!(
        invocations(&runner)[0].args[4..],
        [
            "--path",
            r"D:\wt\toodo\feat-add-sign-in-1",
            "--branch",
            "feat/add-login-1",
            "--base",
            "feat/add-login-1",
            "--no-focus",
        ]
        .map(str::to_owned)
    );
}

#[test]
fn restore_takes_a_branch_the_repository_lost_from_origin() {
    let fixture = lost_worktree();
    let git = Git::new(Box::new(Arc::new(FakeRunner::new(vec![
        Err(failed()),
        Ok("abc\n".to_owned()),
    ]))));
    let (herdr, runner) = herdr(vec![Ok(RECREATED.to_owned())]);

    restore(&fixture.storage, &git, &herdr, fixture.task.id).unwrap();

    let args = &invocations(&runner)[0].args;
    assert_eq!(args[args.len() - 2], "origin/feat/add-login-1");
}

#[test]
fn restore_is_rejected_without_a_lost_worktree_or_a_branch() {
    let gone = || {
        Git::new(Box::new(Arc::new(FakeRunner::new(vec![
            Err(failed()),
            Err(failed()),
        ]))))
    };
    let (herdr, runner) = herdr(Vec::new());

    let ready = local_fixture(Some(r"D:\wt"));
    let started = local_fixture(Some(r"D:\wt"));
    let (start_herdr, _) = self::herdr(vec![Ok(CREATED.to_owned())]);
    start(
        &started.storage,
        &existing_base(),
        &start_herdr,
        started.task.id,
    )
    .unwrap();
    let lost = lost_worktree();
    let existing = Git::new(Box::new(Arc::new(FakeRunner::new(vec![Ok(
        "worktree D:/wt/toodo/feat-add-login-1\0HEAD abc\0\0".to_owned(),
    )]))));
    for (fixture, git) in [(&ready, gone()), (&started, existing), (&lost, gone())] {
        let error = restore(&fixture.storage, &git, &herdr, fixture.task.id).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected, "{}", error.message);
    }
    assert!(invocations(&runner).is_empty());
    assert_eq!(stored(&lost).worktree_path, None);
}
