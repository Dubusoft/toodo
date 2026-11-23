use super::*;

#[test]
fn workspace_metadata_updates_keep_omitted_fields_and_clear_nulls() {
    let storage = StorageState::new(Storage::open_in_memory().unwrap());
    let created = create_workspace(&storage, serde_json::from_value(serde_json::json!({"name":"Planning", "description":"# Notes", "repository":"discord:tasks"})).unwrap()).unwrap();
    let updated = update_workspace(
        &storage,
        serde_json::from_value(serde_json::json!({"id":created.id,"name":"Renamed"})).unwrap(),
    )
    .unwrap();
    assert_eq!(updated.description.as_deref(), Some("# Notes"));
    assert_eq!(updated.repository.as_deref(), Some("discord:tasks"));
    let cleared = update_workspace(
        &storage,
        serde_json::from_value(
            serde_json::json!({"id":created.id,"description":null,"repository":null}),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(cleared.name, "Renamed");
    assert_eq!(cleared.description, None);
    assert_eq!(cleared.repository, None);
    let fields = serde_json::to_value(&cleared)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    assert_eq!(
        fields,
        ["id", "name", "description", "repository", "archivedAt"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    );
}

#[test]
fn archive_workspace_archives_only_when_confirmed_and_nothing_is_worked_on() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
    storage
        .set_task_status(task.id.into(), DomainStatus::InProgress)
        .unwrap();
    let archive = |storage: &mut Storage, confirm: bool| {
        archive_workspace(
            storage,
            ArchiveWorkspace {
                id: workspace,
                confirm,
            },
        )
    };

    let error = archive(&mut storage, true).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error.message.contains("#1 (in_progress)") && error.message.contains("pause_task"),
        "{}",
        error.message
    );
    assert_eq!(list_workspaces(&storage).unwrap().len(), 1);

    storage
        .conclude_task(task.id.into(), "Not needed", None)
        .unwrap();
    let preview = archive(&mut storage, false).unwrap();
    assert!(!preview.confirmed);
    assert!(
        preview.message.contains("\"confirm\": true"),
        "{}",
        preview.message
    );
    assert_eq!(list_workspaces(&storage).unwrap().len(), 1);

    let archived = archive(&mut storage, true).unwrap();
    assert!(archived.confirmed);
    assert_eq!(archived.workspace.id, workspace);
    assert!(list_workspaces(&storage).unwrap().is_empty());
    let kept = storage.archived_workspaces().unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(
        storage
            .review_tasks()
            .unwrap()
            .iter()
            .filter(|stored| stored.id == task.id.into())
            .count(),
        1
    );

    let again = archive(&mut storage, true).unwrap_err();
    assert_eq!(again.code, CommandErrorCode::WorkspaceNotFound);
    assert!(
        again.message.contains("list_workspaces"),
        "{}",
        again.message
    );
}

#[test]
fn guidelines_round_trip_and_get_task_includes_them() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Add login", vec![]).unwrap();
    let storage = StorageState::new(storage);
    use serde_json::json;
    let added = add_guideline(
        &storage,
        serde_json::from_value(
            json!({"workspace_id": workspace, "body": "  Ask before migrating "}),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(added.kind, types::GuidelineKind::Memory);
    assert_eq!(added.body, "Ask before migrating");
    let rule = add_guideline(
        &storage,
        serde_json::from_value(
            json!({"workspace_id": workspace, "kind": "rule", "body": "Write English"}),
        )
        .unwrap(),
    )
    .unwrap();
    let updated = update_guideline(
        &storage,
        serde_json::from_value(json!({"id": added.id, "kind": "rule"})).unwrap(),
    )
    .unwrap();
    assert_eq!(
        (updated.kind, updated.body.as_str()),
        (types::GuidelineKind::Rule, "Ask before migrating")
    );
    let listed = get_guidelines(
        &lock(&storage),
        GetGuidelines {
            workspace_id: workspace,
        },
    )
    .unwrap();
    assert_eq!(listed.workspace.name, "toodo");
    assert_eq!(listed.guidelines, [updated.clone(), rule.clone()]);
    let details = task_details(&lock(&storage), GetTask { id: task.id }).unwrap();
    assert_eq!(details.guidelines, listed.guidelines);
    assert_eq!(
        remove_guideline(&storage, RemoveGuideline { id: rule.id }).unwrap(),
        rule
    );

    let missing = types::GuidelineId(999);
    for error in [
        update_guideline(
            &storage,
            UpdateGuideline {
                id: missing,
                kind: None,
                body: Some("x".into()),
            },
        )
        .unwrap_err(),
        remove_guideline(&storage, RemoveGuideline { id: missing }).unwrap_err(),
    ] {
        assert_eq!(error.code, CommandErrorCode::GuidelineNotFound);
        assert!(error.message.contains("get_guidelines"), "{error:?}");
    }
    let unknown = WorkspaceId(999);
    let listed = get_guidelines(
        &lock(&storage),
        GetGuidelines {
            workspace_id: unknown,
        },
    );
    for error in [
        listed.unwrap_err(),
        add_guideline(
            &storage,
            serde_json::from_value(json!({"workspace_id": unknown, "body": "x"})).unwrap(),
        )
        .unwrap_err(),
    ] {
        assert_eq!(error.code, CommandErrorCode::WorkspaceNotFound);
        assert!(error.message.contains("list_workspaces"), "{error:?}");
    }
}
