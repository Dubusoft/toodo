use super::*;
use crate::domain::criteria::{CheckKind, CriterionId, NewCriterion};
use crate::domain::model::TaskType;
use crate::domain::status::TaskStatus;
use crate::storage::{CriterionEdit, NewTask, NewWorkspace, Storage};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;

const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// Sets the task's only criterion to a URL one with `target`, keeping `criterion` if given.
fn set_url(
    storage: &StorageState,
    id: model::TaskId,
    criterion: Option<CriterionId>,
    target: &str,
) -> model::Task {
    lock(storage)
        .set_criteria(
            id,
            &[CriterionEdit {
                id: criterion,
                criterion: NewCriterion::parse("Deployed", CheckKind::Url, Some(target)).unwrap(),
            }],
        )
        .unwrap()
}

/// Accepts one request on `listener` and answers it with `response` after running `during`.
fn answer_once(listener: &TcpListener, response: &str, during: impl FnOnce()) {
    let (mut stream, _) = listener.accept().unwrap();
    let mut request = [0; 2048];
    let length = stream.read(&mut request).unwrap();
    assert!(request[..length].starts_with(b"GET /ready "));
    during();
    stream.write_all(response.as_bytes()).unwrap();
}

fn fixture() -> (StorageState, model::TaskId) {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = storage
        .create_workspace(&NewWorkspace {
            name: "Tasks".into(),
            description: None,
            repository: None,
        })
        .unwrap();
    let task = storage
        .create_task(&NewTask {
            workspace_id: workspace.id,
            task_type: TaskType::Feat,
            title: "Record work".into(),
            description: String::new(),
            estimate: None,
            due_date: None,
            autopilot: false,
            criteria: vec![],
        })
        .unwrap();
    storage
        .start_task(task.id, Some("Ready to work"), &["lane:test".into()])
        .unwrap();
    (Mutex::new(storage), task.id)
}

#[test]
fn complete_records_reason_refs_and_releases_dependents() {
    let (storage, id) = fixture();
    let done = complete(&storage, id, Some("Finished"), &["pr:123".into()]).unwrap();
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
    assert_eq!(done.refs, ["lane:test", "pr:123"]);
    assert_eq!(
        done.timeline.last().unwrap().reason.as_deref(),
        Some("Finished")
    );
    assert!(lock(&storage).list_commit_records(id).unwrap().is_empty());
}

#[test]
fn conclusion_can_record_work_shipped_with_a_completed_task() {
    let (storage, id) = fixture();
    let error = conclude::conclude(
        &storage,
        id,
        "Own work",
        ConcludeOutcome::ShippedWith,
        Some(id),
    )
    .unwrap_err();
    assert_eq!(error.code, crate::commands::CommandErrorCode::InvalidInput);
    assert!(
        error
            .message
            .contains(&format!("complete_task with id {id}"))
    );
    let workspace_id = lock(&storage).get_task(id).unwrap().unwrap().workspace_id;
    let other = lock(&storage).create_task(&NewTask {
        workspace_id,
        task_type: TaskType::Feat,
        title: "Ship work".into(),
        description: String::new(),
        estimate: None,
        due_date: None,
        autopilot: false,
        criteria: vec![],
    });
    let other = other.unwrap();
    lock(&storage).start_task(other.id, None, &[]).unwrap();
    assert!(
        conclude::conclude(
            &storage,
            id,
            "Shipped together",
            ConcludeOutcome::ShippedWith,
            Some(other.id)
        )
        .is_err()
    );
    complete(&storage, other.id, None, &[]).unwrap();
    let done = conclude::conclude(
        &storage,
        id,
        "Shipped together",
        ConcludeOutcome::ShippedWith,
        Some(other.id),
    )
    .unwrap();
    assert!(done.refs.contains(&format!("task:{}", other.id)));
    assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
}

#[test]
fn manual_criteria_must_be_checked_before_completion() {
    use crate::domain::criteria::{CheckKind, CheckedBy, NewCriterion};
    let (storage, id) = fixture();
    lock(&storage)
        .set_criteria(
            id,
            &[crate::storage::CriterionEdit {
                id: None,
                criterion: NewCriterion::parse("Reviewed", CheckKind::Manual, None).unwrap(),
            }],
        )
        .unwrap();
    let error = complete(&storage, id, Some("Finished"), &["lane:done".into()]).unwrap_err();
    assert!(error.message.contains("check_criterion"));
    let task = lock(&storage).get_task(id).unwrap().unwrap();
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(task.refs, ["lane:test"]);
    lock(&storage)
        .check_criterion(
            id,
            task.criteria[0].id,
            true,
            Some("Reviewed"),
            CheckedBy::Agent,
        )
        .unwrap();
    assert_eq!(
        lock(&storage).get_task(id).unwrap().unwrap().status,
        TaskStatus::InProgress
    );
    assert_eq!(
        complete(&storage, id, Some("Finished"), &[])
            .unwrap()
            .status,
        TaskStatus::Done
    );
}

#[test]
fn url_criteria_are_rechecked_with_http_and_do_not_require_execution_tools() {
    use crate::domain::criteria::CriterionState;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let target = format!("http://{}/ready", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for status in ["503 Service Unavailable", "200 OK"] {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let length = stream.read(&mut request).unwrap();
            assert!(request[..length].starts_with(b"GET /ready "));
            stream
                .write_all(
                    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .unwrap();
        }
    });
    let (storage, id) = fixture();
    let task = lock(&storage)
        .set_criteria(
            id,
            &[crate::storage::CriterionEdit {
                id: None,
                criterion: NewCriterion::parse("Deployed", CheckKind::Url, Some(&target)).unwrap(),
            }],
        )
        .unwrap();
    lock(&storage)
        .record_criterion_checks(
            id,
            &[CriterionCheck {
                id: task.criteria[0].id,
                state: CriterionState::Met,
                evidence: Some("Earlier response".into()),
                target: None,
            }],
        )
        .unwrap();
    assert!(
        complete_reaching(&storage, id, None, &[], Outbound::any_address)
            .unwrap_err()
            .message
            .contains("complete_task")
    );
    assert_eq!(
        lock(&storage).get_task(id).unwrap().unwrap().criteria[0].state,
        CriterionState::Failed
    );
    let done = complete_reaching(&storage, id, None, &[], Outbound::any_address).unwrap();
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.criteria[0].state, CriterionState::Met);
    server.join().unwrap();
}

#[test]
fn a_url_check_does_not_count_for_a_target_changed_during_it() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let old = format!("http://{}/ready", listener.local_addr().unwrap());
    let (storage, id) = fixture();
    let criterion = set_url(&storage, id, None, &old).criteria[0].id;
    let error = std::thread::scope(|scope| {
        scope.spawn(|| {
            answer_once(&listener, OK, || {
                set_url(&storage, id, Some(criterion), "https://example.com/new");
            })
        });
        complete_reaching(&storage, id, None, &[], Outbound::any_address).unwrap_err()
    });
    assert!(error.message.contains("fix its URL"), "{}", error.message);
    let task = lock(&storage).get_task(id).unwrap().unwrap();
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(
        task.criteria[0].target.as_deref(),
        Some("https://example.com/new")
    );
    assert_eq!(task.criteria[0].state, CriterionState::Pending);
    assert_eq!(task.criteria[0].evidence, None);
}

#[test]
fn completion_keeps_refs_added_during_the_url_check() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let target = format!("http://{}/ready", listener.local_addr().unwrap());
    let (storage, id) = fixture();
    set_url(&storage, id, None, &target);
    let done = std::thread::scope(|scope| {
        scope.spawn(|| {
            answer_once(&listener, OK, || {
                lock(&storage)
                    .set_task_refs(id, &["lane:test".into(), "lane:added".into()])
                    .unwrap();
            })
        });
        complete_reaching(&storage, id, None, &["pr:1".into()], Outbound::any_address).unwrap()
    });
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.refs, ["lane:test", "lane:added", "pr:1"]);
}

#[test]
fn url_checks_do_not_reach_private_addresses() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let target = format!("http://{}/ready", listener.local_addr().unwrap());
    let (storage, id) = fixture();
    set_url(&storage, id, None, &target);
    complete(&storage, id, None, &[]).unwrap_err();
    let task = lock(&storage).get_task(id).unwrap().unwrap();
    assert_eq!(task.criteria[0].state, CriterionState::Failed);
    let evidence = task.criteria[0].evidence.as_deref().unwrap();
    assert!(evidence.contains("not public"), "{evidence}");
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "no request reached the private address"
    );
}

#[test]
fn url_checks_do_not_follow_redirects() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let target = format!("http://{}/ready", listener.local_addr().unwrap());
    let (storage, id) = fixture();
    set_url(&storage, id, None, &target);
    let redirect = "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    std::thread::scope(|scope| {
        scope.spawn(|| answer_once(&listener, redirect, || {}));
        complete_reaching(&storage, id, None, &[], Outbound::any_address).unwrap_err();
    });
    let task = lock(&storage).get_task(id).unwrap().unwrap();
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(task.criteria[0].state, CriterionState::Failed);
    let evidence = task.criteria[0].evidence.as_deref().unwrap();
    assert!(evidence.contains("302 Found"), "{evidence}");
}

#[test]
fn prerequisites_block_start_until_completed_without_writing_refs() {
    let (storage, prerequisite) = fixture();
    let workspace_id = lock(&storage)
        .get_task(prerequisite)
        .unwrap()
        .unwrap()
        .workspace_id;
    let task = lock(&storage)
        .create_task(&NewTask {
            workspace_id,
            task_type: TaskType::Feat,
            title: "Use work".into(),
            description: String::new(),
            estimate: None,
            due_date: None,
            autopilot: false,
            criteria: vec![],
        })
        .unwrap();
    lock(&storage)
        .add_dependency(task.id, prerequisite)
        .unwrap();
    let error = crate::commands::tasks::start_task(
        State(&storage),
        task.id.into(),
        Some("Ready".into()),
        Some(vec!["lane:dependent".into()]),
    )
    .unwrap_err();
    assert!(error.message.contains(&prerequisite.to_string()));
    assert!(error.message.contains("complete_task"));
    assert!(
        lock(&storage)
            .get_task(task.id)
            .unwrap()
            .unwrap()
            .refs
            .is_empty()
    );
    complete(&storage, prerequisite, None, &[]).unwrap();
    let started = crate::commands::tasks::start_task(
        State(&storage),
        task.id.into(),
        Some("Ready".into()),
        Some(vec!["lane:dependent".into()]),
    )
    .unwrap();
    assert_eq!(
        started.milestones.started_at,
        Some(started.timeline.last().unwrap().at)
    );
    assert_eq!(started.refs, ["lane:dependent"]);
    assert_eq!(started.status, types::TaskStatus::InProgress);
}
