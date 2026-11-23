use super::*;

#[test]
fn a_dependency_that_closes_a_cycle_is_rejected() {
    let (mut storage, workspace) = storage_with_workspace();
    let first = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    let second = create(&mut storage, workspace, "API", vec![first.id]).unwrap();
    let request = AddDependencies {
        task_id: first.id,
        depends_on: vec![second.id],
    };
    let error = add_dependencies(&mut storage, request.clone()).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("cycle"), "{}", error.message);
    assert!(get_task(&storage, first.id).unwrap().depends_on.is_empty());

    let removed = remove_dependency(
        &mut storage,
        Dependency {
            task_id: second.id,
            depends_on: vec![first.id],
        },
    )
    .unwrap();
    assert!(removed.task.task.depends_on.is_empty());
    assert!(removed.task.ready);
    assert_eq!(
        add_dependencies(&mut storage, request)
            .unwrap()
            .task
            .task
            .depends_on,
        vec![second.id]
    );
}

#[test]
fn removing_a_dependency_that_does_not_exist_removes_none() {
    let (mut storage, workspace) = storage_with_workspace();
    let first = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    let other = create(&mut storage, workspace, "Docs", vec![]).unwrap();
    let second = create(&mut storage, workspace, "API", vec![first.id]).unwrap();

    let error = remove_dependency(
        &mut storage,
        Dependency {
            task_id: second.id,
            depends_on: vec![first.id, other.id],
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
    assert!(
        error.message.starts_with(&format!(
            "task {} does not depend on {}; get_task {}",
            second.id.0, other.id.0, second.id.0
        )),
        "{}",
        error.message
    );
    assert_eq!(
        get_task(&storage, second.id).unwrap().depends_on,
        [first.id]
    );
}

#[test]
fn adds_several_prerequisites_at_once_and_needs_at_least_one() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
    let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
    let docs = create(&mut storage, workspace, "Fix docs", vec![]).unwrap();

    let error = add_dependencies(
        &mut storage,
        AddDependencies {
            task_id: task.id,
            depends_on: vec![],
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    let updated = add_dependencies(
        &mut storage,
        AddDependencies {
            task_id: task.id,
            depends_on: vec![fix.id, docs.id],
        },
    )
    .unwrap();
    assert_eq!(updated.task.task.depends_on, vec![fix.id, docs.id]);
    assert!(!updated.paused);
    assert_eq!(
        updated.message,
        format!(
            "task {} waits for #{} (planned), #{} (planned) before it can start.",
            task.id.0, fix.id.0, docs.id.0
        )
    );
}

#[test]
fn a_done_task_gets_no_new_prerequisites() {
    use crate::domain::status::TaskStatus;
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
    let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
    for status in [
        TaskStatus::InProgress,
        TaskStatus::InReview,
        TaskStatus::Done,
    ] {
        storage.set_task_status(task.id.into(), status).unwrap();
    }

    let error = add_dependencies(
        &mut storage,
        AddDependencies {
            task_id: task.id,
            depends_on: vec![fix.id],
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error.message.ends_with(&format!(
            "create a follow-up task with create_task and depends_on [{}]",
            fix.id.0
        )),
        "{}",
        error.message
    );
    assert!(get_task(&storage, task.id).unwrap().depends_on.is_empty());
}

#[test]
fn a_prerequisite_of_a_task_in_review_does_not_pause_it_and_says_so() {
    use crate::domain::status::TaskStatus;
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
    let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
    for status in [TaskStatus::InProgress, TaskStatus::InReview] {
        storage.set_task_status(task.id.into(), status).unwrap();
    }

    let reply = add_dependencies(
        &mut storage,
        AddDependencies {
            task_id: task.id,
            depends_on: vec![fix.id],
        },
    )
    .unwrap();
    assert!(!reply.paused);
    assert_eq!(reply.task.task.status, types::TaskStatus::InReview);
    assert!(
        reply.message.contains("not paused") && reply.message.contains("call pause_task"),
        "{}",
        reply.message
    );
}

#[test]
fn a_blocking_prerequisite_pauses_the_task_and_history_allows_resuming() {
    use crate::domain::status::TaskStatus;
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
    let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
    storage
        .set_task_status(task.id.into(), TaskStatus::InProgress)
        .unwrap();

    let reply = add_dependencies(
        &mut storage,
        AddDependencies {
            task_id: task.id,
            depends_on: vec![fix.id],
        },
    )
    .unwrap();

    let paused = storage.get_task(task.id.into()).unwrap().unwrap();
    assert_eq!(paused.status, TaskStatus::Planned);
    assert!(reply.paused);
    assert!(!reply.task.ready);
    assert_eq!(reply.task.depends_on[0].title, "Fix login");
    assert_eq!(reply.task.blocked_by, reply.task.depends_on);
    assert!(
        reply.message.starts_with(&format!(
            "task {} is paused until #{} (planned) is done",
            task.id.0, fix.id.0
        )),
        "{}",
        reply.message
    );
    let json = serde_json::to_value(&reply).unwrap();
    assert_eq!(json["paused"], true);
    assert_eq!(json["task"]["dependsOn"][0]["title"], "Fix login");
    assert_eq!(json["task"]["blockedBy"][0]["status"], "planned");

    // Removing the last blocker leaves a paused task that resume_task resumes.
    let mut branched = paused;
    branched.description = "Verification work".to_owned();
    storage.update_task(&branched).unwrap();
    let reply = remove_dependency(
        &mut storage,
        Dependency {
            task_id: task.id,
            depends_on: vec![fix.id],
        },
    )
    .unwrap();
    assert!(reply.task.ready);
    assert!(
        reply.message.ends_with("resume_task resumes it."),
        "{}",
        reply.message
    );
}

#[test]
fn depends_on_takes_one_task_id_or_an_array() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Verify", vec![]).unwrap();
    let fix = create(&mut storage, workspace, "Fix login", vec![]).unwrap();
    let docs = create(&mut storage, workspace, "Fix docs", vec![]).unwrap();
    let add = |depends_on: serde_json::Value| -> AddDependencies {
        serde_json::from_value(serde_json::json!({ "task_id": task.id, "depends_on": depends_on }))
            .unwrap()
    };
    let remove = |depends_on: serde_json::Value| -> Dependency {
        serde_json::from_value(serde_json::json!({ "task_id": task.id, "depends_on": depends_on }))
            .unwrap()
    };
    add_dependencies(&mut storage, add(serde_json::json!(fix.id))).unwrap();
    let both = add_dependencies(&mut storage, add(serde_json::json!([docs.id]))).unwrap();
    assert_eq!(both.task.task.depends_on, vec![fix.id, docs.id]);
    let one = remove_dependency(&mut storage, remove(serde_json::json!(fix.id))).unwrap();
    assert_eq!(one.task.task.depends_on, vec![docs.id]);
    add_dependencies(&mut storage, add(serde_json::json!(fix.id))).unwrap();
    let none =
        remove_dependency(&mut storage, remove(serde_json::json!([fix.id, docs.id]))).unwrap();
    assert!(none.task.task.depends_on.is_empty());

    let error = serde_json::from_value::<Dependency>(
        serde_json::json!({ "task_id": 1, "depends_on": "2" }),
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("a task id or an array of task ids"),
        "{error}"
    );
}
