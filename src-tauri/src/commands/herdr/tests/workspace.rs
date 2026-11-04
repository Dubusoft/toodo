use super::*;

#[test]
fn open_focuses_the_herdr_workspace_of_a_started_task() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(vec![Ok(CREATED.to_owned()), Ok(String::new())]);

    let error = open(&fixture.storage, &herdr, fixture.task.id).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);

    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();
    open(&fixture.storage, &herdr, fixture.task.id).unwrap();
    assert_eq!(
        invocations(&runner)[1].args,
        ["workspace", "focus", "w27"].map(str::to_owned)
    );
}

#[test]
fn open_reopens_a_worktree_whose_herdr_workspace_is_gone() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w40"}}}"#;
    let (herdr, runner) = herdr(vec![
        Ok(CREATED.to_owned()),
        herdr_failed("workspace_not_found"),
        Ok(opened.to_owned()),
        Ok(String::new()),
    ]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    open(&fixture.storage, &herdr, fixture.task.id).unwrap();

    let invocations = invocations(&runner);
    assert_eq!(invocations[2].args[..2], ["worktree", "open"]);
    assert_eq!(
        invocations[3].args,
        ["workspace", "focus", "w40"].map(str::to_owned)
    );
    assert_eq!(stored(&fixture).herdr_workspace_id.as_deref(), Some("w40"));
}

fn pane_list(panes: &[(&str, &str, &str)]) -> Result<String, GitError> {
    let rows: Vec<String> = panes
            .iter()
            .map(|(pane_id, workspace_id, status)| {
                format!(
                    r#"{{"agent_status":"{status}","pane_id":"{pane_id}","workspace_id":"{workspace_id}"}}"#
                )
            })
            .collect();
    Ok(format!(
        r#"{{"id":"cli:pane:list","result":{{"panes":[{}]}}}}"#,
        rows.join(",")
    ))
}

#[test]
fn ensure_lists_the_panes_of_an_open_workspace_without_focusing_it() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(vec![
        Ok(CREATED.to_owned()),
        pane_list(&[
            ("w9:p1", "w9", "blocked"),
            ("w27:p1", "w27", "working"),
            ("w27:p2", "w27", "unknown"),
        ]),
    ]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    let found = ensure_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap();

    let panes: Vec<&str> = found
        .panes
        .iter()
        .map(|pane| pane.pane_id.as_str())
        .collect();
    assert_eq!(panes, ["w27:p1", "w27:p2"]);
    assert_eq!(found.machine, Machine::Local);
    assert_eq!(invocations(&runner).len(), 2);
}

#[test]
fn ensure_reopens_a_workspace_herdr_no_longer_has_without_focusing_it() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let opened = r#"{"id":"cli:worktree:open","result":{"workspace":{"workspace_id":"w40"}}}"#;
    let (herdr, runner) = herdr(vec![
        Ok(CREATED.to_owned()),
        pane_list(&[("w9:p1", "w9", "idle")]),
        Ok(opened.to_owned()),
        pane_list(&[("w9:p1", "w9", "idle"), ("w40:p1", "w40", "unknown")]),
    ]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    let found = ensure_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap();

    let panes: Vec<&str> = found
        .panes
        .iter()
        .map(|pane| pane.pane_id.as_str())
        .collect();
    assert_eq!(panes, ["w40:p1"]);
    let invocations = invocations(&runner);
    assert_eq!(invocations[2].args[..2], ["worktree", "open"]);
    assert!(invocations[2].args.contains(&"--no-focus".to_owned()));
    assert!(
        !invocations
            .iter()
            .any(|invocation| invocation.args.contains(&"focus".to_owned()))
    );
    assert_eq!(stored(&fixture).herdr_workspace_id.as_deref(), Some("w40"));
}

#[test]
fn ensure_rejects_a_task_without_a_workspace() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(Vec::new());
    let error = ensure_workspace(&fixture.storage, &herdr, fixture.task.id).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(invocations(&runner).is_empty());
}

#[test]
fn focus_agent_focuses_the_pane_whose_agent_needs_the_user_most() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(vec![
        Ok(CREATED.to_owned()),
        pane_list(&[
            ("w9:p1", "w9", "blocked"),
            ("w27:p1", "w27", "working"),
            ("w27:p2", "w27", "blocked"),
            ("w27:p3", "w27", "blocked"),
            ("w27:p4", "w27", "unknown"),
        ]),
        Ok(String::new()),
    ]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    focus_agent(&fixture.storage, &herdr, fixture.task.id).unwrap();

    let invocations = invocations(&runner);
    assert_eq!(invocations[1].args, ["pane", "list"].map(str::to_owned));
    assert_eq!(
        invocations[2].args,
        ["agent", "focus", "w27:p2"].map(str::to_owned)
    );
}

#[test]
fn focus_agent_focuses_the_workspace_without_an_agent_pane() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(vec![
        Ok(CREATED.to_owned()),
        pane_list(&[("w27:p1", "w27", "unknown")]),
        Ok(String::new()),
        pane_list(&[("w27:p1", "w27", "idle")]),
        herdr_failed("agent_not_found"),
        Ok(String::new()),
    ]);
    start(&fixture.storage, &existing_base(), &herdr, fixture.task.id).unwrap();

    focus_agent(&fixture.storage, &herdr, fixture.task.id).unwrap();
    focus_agent(&fixture.storage, &herdr, fixture.task.id).unwrap();

    let invocations = invocations(&runner);
    let focus_workspace = ["workspace", "focus", "w27"].map(str::to_owned);
    assert_eq!(invocations[2].args, focus_workspace);
    assert_eq!(
        invocations[4].args,
        ["agent", "focus", "w27:p1"].map(str::to_owned)
    );
    assert_eq!(invocations[5].args, focus_workspace);
}

#[test]
fn focus_agent_rejects_a_task_without_a_herdr_workspace() {
    let fixture = local_fixture(Some(r"D:\wt"));
    let (herdr, runner) = herdr(Vec::new());

    let error = focus_agent(&fixture.storage, &herdr, fixture.task.id).unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(invocations(&runner).is_empty());
}
