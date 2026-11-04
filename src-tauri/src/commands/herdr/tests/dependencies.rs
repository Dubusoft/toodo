use super::*;

/// A task of the fixture's workspace that has not started.
fn other_task(fixture: &Fixture, title: &str) -> model::Task {
    lock(&fixture.storage)
        .create_task(&NewTask {
            workspace_id: fixture.task.workspace_id,
            task_type: TaskType::Fix,
            title: title.to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            criteria: Vec::new(),
        })
        .unwrap()
}

#[test]
fn a_blocking_prerequisite_pauses_the_task_and_resuming_reopens_its_worktree() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w41"}}}"#;
    let (herdr, runner) = herdr(vec![
        Ok(CREATED.to_owned()),
        Ok(r#"{"id":"cli:workspace:close","result":{"type":"ok"}}"#.to_owned()),
        Ok(opened.to_owned()),
    ]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    let fix = other_task(&fixture, "Fix login");

    let paused = add_dependencies(&fixture.storage, &herdr, fixture.task.id, &[fix.id]).unwrap();

    assert_eq!(paused.status, TaskStatus::Planned);
    assert_eq!(paused.herdr_workspace_id, None);
    assert_eq!(
        paused.worktree_path.map(|path| path.to_string()).as_deref(),
        Some(r"D:\wt\toodo\feat-add-login-1")
    );
    assert_eq!(
        invocations(&runner)[1].args,
        ["workspace", "close", "w27"].map(str::to_owned)
    );
    let error = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert_eq!(invocations(&runner).len(), 2);

    {
        let mut storage = lock(&fixture.storage);
        for status in [
            TaskStatus::InProgress,
            TaskStatus::InReview,
            TaskStatus::Done,
        ] {
            storage.set_task_status(fix.id, status).unwrap();
        }
    }
    let resumed = start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    assert_eq!(resumed.status, TaskStatus::InProgress);
    assert_eq!(resumed.herdr_workspace_id.as_deref(), Some("w41"));
    assert_eq!(invocations(&runner)[2].args[..2], ["worktree", "open"]);
}

#[test]
fn a_herdr_workspace_that_is_already_closed_still_pauses_the_task() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, _) = herdr(vec![
        Ok(CREATED.to_owned()),
        herdr_failed("workspace_not_found"),
    ]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    let fix = other_task(&fixture, "Fix login");

    let paused = add_dependencies(&fixture.storage, &herdr, fixture.task.id, &[fix.id]).unwrap();

    assert_eq!(paused.status, TaskStatus::Planned);
    assert_eq!(paused.herdr_workspace_id, None);
}

#[test]
fn a_failed_close_keeps_the_task_paused_and_says_so() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, _) = herdr(vec![Ok(CREATED.to_owned()), herdr_failed("server_error")]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    let fix = other_task(&fixture, "Fix login");

    let error = add_dependencies(&fixture.storage, &herdr, fixture.task.id, &[fix.id]).unwrap_err();

    assert!(
        error
            .message
            .contains("was paused, but its herdr workspace was not closed")
    );
    assert_eq!(stored(&fixture).status, TaskStatus::Planned);
    assert_eq!(stored(&fixture).herdr_workspace_id.as_deref(), Some("w27"));
}

#[test]
fn a_prerequisite_of_a_task_that_keeps_going_leaves_herdr_alone() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    let follow_up = other_task(&fixture, "Follow up");

    add_dependencies(&fixture.storage, &herdr, follow_up.id, &[fixture.task.id]).unwrap();

    assert_eq!(stored(&fixture).status, TaskStatus::InProgress);
    assert_eq!(invocations(&runner).len(), 1);
}

/// A started task paused without closing its herdr workspace w27, as MCP leaves it.
fn paused_with_workspace(
    results: Vec<Result<String, GitError>>,
) -> (Fixture, Herdr, Arc<FakeRunner>) {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr([vec![Ok(CREATED.to_owned())], results].concat());
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    lock(&fixture.storage)
        .set_task_status(fixture.task.id, TaskStatus::Planned)
        .unwrap();
    (fixture, herdr, runner)
}

#[test]
fn closing_the_workspace_of_a_paused_task_keeps_its_worktree() {
    let (fixture, herdr, runner) = paused_with_workspace(vec![Ok(
        r#"{"id":"cli:workspace:close","result":{"type":"ok"}}"#.to_owned(),
    )]);

    let closed = close_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap();

    assert_eq!(
        invocations(&runner)[1].args,
        ["workspace", "close", "w27"].map(str::to_owned)
    );
    assert_eq!(closed.status, TaskStatus::Planned);
    assert_eq!(closed.herdr_workspace_id, None);
    assert!(closed.worktree_path.is_some());
    assert_eq!(stored(&fixture), closed);
}

#[test]
fn a_workspace_already_closed_in_herdr_is_forgotten() {
    let (fixture, herdr, _) = paused_with_workspace(vec![herdr_failed("workspace_not_found")]);

    let closed = close_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap();

    assert_eq!(closed.herdr_workspace_id, None);
}

#[test]
fn the_workspace_of_a_task_being_worked_on_is_not_closed() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned())]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    let error = close_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert_eq!(invocations(&runner).len(), 1);
    assert_eq!(stored(&fixture).herdr_workspace_id.as_deref(), Some("w27"));
}
