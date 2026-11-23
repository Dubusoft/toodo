use super::*;

#[test]
fn move_task_moves_a_done_task_and_rejects_an_archived_workspace() {
    let (mut storage, workspace) = storage_with_workspace();
    let general: WorkspaceId = storage
        .create_workspace(&NewWorkspace {
            name: "General".to_owned(),
            description: None,
            repository: None,
        })
        .unwrap()
        .id
        .into();
    let old: WorkspaceId = storage
        .create_workspace(&NewWorkspace {
            name: "Old".to_owned(),
            description: None,
            repository: None,
        })
        .unwrap()
        .id
        .into();
    storage.archive_workspace(old.into()).unwrap();
    let task = create(&mut storage, workspace, "Sort mail", vec![]).unwrap();
    storage
        .set_task_status(task.id.into(), DomainStatus::InProgress)
        .unwrap();
    storage
        .conclude_task(task.id.into(), "Not needed", None)
        .unwrap();
    let done = get_task(&storage, task.id).unwrap();
    let request = |workspace_id| MoveTask {
        id: task.id,
        workspace_id,
    };

    let moved = move_task(&mut storage, request(general)).unwrap();
    assert_eq!(moved.from_workspace_id, workspace);
    assert_eq!(moved.task.workspace_id, general);
    assert_eq!(
        moved.task,
        Task {
            workspace_id: general,
            ..done
        }
    );
    assert!(moved.message.contains("\"General\""), "{}", moved.message);

    let again = move_task(&mut storage, request(general)).unwrap();
    assert_eq!(again.task, moved.task);
    assert!(
        again.message.starts_with("Nothing changed"),
        "{}",
        again.message
    );

    let error = move_task(&mut storage, request(old)).unwrap_err();
    assert_eq!(error.code, CommandErrorCode::WorkspaceNotFound);
    assert_eq!(get_task(&storage, task.id).unwrap().workspace_id, general);
}

#[test]
fn delete_task_deletes_a_planned_or_done_task_only_when_confirmed() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
    let dependent = create(&mut storage, workspace, "Use login", vec![task.id]).unwrap();
    let done = create(&mut storage, workspace, "Ship login", vec![]).unwrap();
    storage
        .set_task_status(done.id.into(), DomainStatus::InProgress)
        .unwrap();
    storage
        .conclude_task(done.id.into(), "Not needed", None)
        .unwrap();
    let storage = std::sync::Arc::new(StorageState::new(storage));
    let delete = |id: TaskId, confirm: bool| delete_task(&storage, DeleteTask { id, confirm });

    let preview = delete(task.id, false).unwrap();
    assert!(!preview.confirmed);
    assert!(
        preview.message.contains("\"confirm\": true"),
        "{}",
        preview.message
    );
    assert!(
        preview.message.contains("#2 (planned)"),
        "{}",
        preview.message
    );
    assert!(lock(&storage).get_task(task.id.into()).unwrap().is_some());

    let deleted = delete(task.id, true).unwrap();
    assert!(deleted.confirmed);
    assert_eq!(deleted.task.id, task.id);
    let storage_now = lock(&storage);
    assert!(storage_now.get_task(task.id.into()).unwrap().is_none());
    let dependent = storage_now.get_task(dependent.id.into()).unwrap().unwrap();
    assert!(dependent.depends_on.is_empty());
    drop(storage_now);

    let preview = delete(done.id, false).unwrap();
    assert!(!preview.confirmed);
    assert!(lock(&storage).get_task(done.id.into()).unwrap().is_some());
    let deleted = delete(done.id, true).unwrap();
    assert!(deleted.confirmed);
    assert!(lock(&storage).get_task(done.id.into()).unwrap().is_none());

    let active = create(&mut lock(&storage), workspace, "Fix login", vec![]).unwrap();
    lock(&storage)
        .set_task_status(active.id.into(), DomainStatus::InProgress)
        .unwrap();
    let error = delete(active.id, true).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(error.message.contains("pause_task"), "{}", error.message);
    assert!(lock(&storage).get_task(active.id.into()).unwrap().is_some());
}

#[test]
fn delete_done_tasks_archives_the_done_tasks_of_a_workspace_only_when_confirmed() {
    let (mut storage, workspace) = storage_with_workspace();
    let planned = create(&mut storage, workspace, "Add login", vec![]).unwrap();
    let first = create(&mut storage, workspace, "Ship login", vec![]).unwrap();
    let second = create(&mut storage, workspace, "Drop signup", vec![]).unwrap();
    for task in [&first, &second] {
        storage
            .set_task_status(task.id.into(), DomainStatus::InProgress)
            .unwrap();
        storage
            .conclude_task(task.id.into(), "Not needed", None)
            .unwrap();
    }
    let delete = |storage: &mut Storage, confirm: bool| {
        delete_done_tasks(
            storage,
            DeleteDoneTasks {
                workspace_id: workspace,
                confirm,
            },
        )
    };

    let preview = delete(&mut storage, false).unwrap();
    assert!(!preview.confirmed);
    assert_eq!(preview.task_ids, [first.id, second.id]);
    assert!(
        preview.message.contains("#2 Ship login, #3 Drop signup")
            && preview.message.contains("\"confirm\": true"),
        "{}",
        preview.message
    );
    assert!(storage.get_task(first.id.into()).unwrap().is_some());

    let deleted = delete(&mut storage, true).unwrap();
    assert!(deleted.confirmed);
    assert_eq!(deleted.task_ids, [first.id, second.id]);
    assert!(deleted.message.contains("#2, #3"), "{}", deleted.message);
    assert!(storage.get_task(first.id.into()).unwrap().is_none());
    assert!(storage.get_task(second.id.into()).unwrap().is_none());
    assert!(storage.get_task(planned.id.into()).unwrap().is_some());

    let none = delete(&mut storage, true).unwrap();
    assert!(!none.confirmed);
    assert!(none.task_ids.is_empty());
    assert!(none.message.contains("list_tasks"), "{}", none.message);

    let error = delete_done_tasks(
        &mut storage,
        DeleteDoneTasks {
            workspace_id: WorkspaceId(99),
            confirm: true,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, CommandErrorCode::WorkspaceNotFound);
    assert!(
        error.message.contains("list_workspaces"),
        "{}",
        error.message
    );
}

#[test]
fn reopen_task_reopens_a_done_task_only_when_confirmed() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
    storage
        .set_task_status(task.id.into(), DomainStatus::InProgress)
        .unwrap();
    storage
        .conclude_task(task.id.into(), "Too slow", None)
        .unwrap();
    let reopen = |storage: &mut Storage, reason: &str, confirm: bool| {
        reopen_task(
            storage,
            ReopenTask {
                id: task.id,
                reason: reason.to_owned(),
                confirm,
            },
        )
    };

    let error = reopen(&mut storage, " ", false).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    let preview = reopen(&mut storage, "Faster now", false).unwrap();
    assert!(!preview.confirmed);
    assert_eq!(preview.task.status, TaskStatus::Done);
    assert!(
        preview.message.contains("Reopened: Faster now"),
        "{}",
        preview.message
    );
    assert!(
        preview.message.contains("\"confirm\":true"),
        "{}",
        preview.message
    );
    let stored = storage.get_task(task.id.into()).unwrap().unwrap();
    assert_eq!(stored.status, DomainStatus::Done);

    let reopened = reopen(&mut storage, "Faster now", true).unwrap();
    assert!(reopened.confirmed);
    assert_eq!(reopened.task.status, TaskStatus::Planned);
    assert_eq!(reopened.task.resolution, None);
    assert!(reopen(&mut storage, "Faster now", false).is_err());
}
