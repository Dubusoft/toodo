use super::*;
use crate::domain::model::TaskType;
use crate::domain::status::TaskStatus;
use crate::storage::{NewTask, NewWorkspace, Storage};
use std::sync::Mutex;

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
    use crate::domain::criteria::{CheckKind, CriterionState, NewCriterion};
    use std::io::{Read, Write};
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
        complete(&storage, id, None, &[])
            .unwrap_err()
            .message
            .contains("complete_task")
    );
    assert_eq!(
        lock(&storage).get_task(id).unwrap().unwrap().criteria[0].state,
        CriterionState::Failed
    );
    let done = complete(&storage, id, None, &[]).unwrap();
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.criteria[0].state, CriterionState::Met);
    server.join().unwrap();
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
