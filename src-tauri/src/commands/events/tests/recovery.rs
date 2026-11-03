use super::*;
use crate::domain::runtime::{HostRef, OwnerKey};
use crate::runtime::events::HostState;

#[test]
fn lost_open_event_is_recovered_by_the_next_subscription_snapshot() {
    let fixture = fixture();
    let empty_panes = r#"{"result":{"panes":[]}}"#;
    let empty_snapshot = r#"{"result":{"workspaces":[]}}"#;
    let snapshot = serde_json::json!({"result":{"workspaces":[{
        "workspace_id":"w9", "worktree":{"checkout_path":
            fixture.local.worktree_path.as_ref().unwrap().to_string()}
    }]}})
    .to_string();
    let herdr = Herdr::new(Box::new(Arc::new(FakeRunner::new(
        [
            empty_panes,
            empty_snapshot,
            empty_panes,
            empty_panes,
            &snapshot,
            empty_panes,
        ]
        .into_iter()
        .map(|answer| Ok(answer.to_owned()))
        .collect::<Vec<_>>(),
    ))));
    let lost = r#"{"id":"toodo:events","error":{"code":"events_lost","message":"lost"}}"#;
    let connector = FakeConnector::new([
        Ok(format!("{STARTED}\n{lost}\n")),
        Ok(format!("{STARTED}\n")),
    ]);
    let sync = sync(&fixture, &herdr);
    let first = sync.run_once(&connector);
    assert!(matches!(first.error, Some(SyncError::Stream(
        EventStreamError::Rejected { ref code, .. }
    )) if code == "events_lost"));
    assert_eq!(
        task(&fixture, fixture.local.id)
            .herdr_workspace_id
            .as_deref(),
        Some("w1")
    );
    let second = sync.run_once(&connector);
    assert!(second.started);
    assert_eq!(
        task(&fixture, fixture.local.id)
            .herdr_workspace_id
            .as_deref(),
        Some("w9")
    );
    let cursor = lock(&fixture.storage)
        .host_cursor(&OwnerKey::implicit(), &HostRef::Local)
        .unwrap();
    assert_eq!(cursor.last_sequence, 4);
    assert_eq!(cursor.reconciled_sequence, Some(4));
    assert_eq!(cursor.state, HostState::Online);
    assert_eq!(
        *fixture.recorder.tasks_changed.lock().unwrap(),
        [fixture.local.workspace_id]
    );
}

#[test]
fn an_unreadable_workspace_snapshot_keeps_the_subscription() {
    let fixture = fixture();
    let panes = |status: &str| {
        Ok(format!(
            r#"{{"result":{{"panes":[{}]}}}}"#,
            pane("w1:p1", "w1", status)
        ))
    };
    let herdr = Herdr::new(Box::new(Arc::new(FakeRunner::new(vec![
        panes("idle"),
        Err(GitError::Failed {
            command: "herdr workspace list".to_owned(),
            stderr: "unknown command".to_owned(),
        }),
        panes("idle"),
        panes("working"),
    ]))));
    let status = r#"{"data":{"agent":"claude","agent_status":"working","pane_id":"w1:p1","workspace_id":"w1"},"event":"pane.agent_status_changed"}"#;
    let connector = FakeConnector::new([Ok(format!("{STARTED}\n{status}\n"))]);
    let end = sync(&fixture, &herdr).run_once(&connector);
    assert!(end.started);
    assert!(matches!(
        end.error,
        Some(SyncError::Stream(EventStreamError::Closed))
    ));
    assert_eq!(
        list_statuses(&fixture),
        statuses(&[(fixture.local.id, AgentStatus::Working)])
    );
    let cursor = lock(&fixture.storage)
        .host_cursor(&OwnerKey::implicit(), &HostRef::Local)
        .unwrap();
    assert_eq!(cursor.state, HostState::Online);
    assert_eq!(cursor.reconciled_sequence, None);
}
