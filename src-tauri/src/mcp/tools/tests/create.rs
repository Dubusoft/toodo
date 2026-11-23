use super::*;

/// Agents started before the lead was removed may still send `request_id`; it is
/// ignored rather than failing the call.
#[test]
fn create_and_start_ignore_a_request_id() {
    let create = serde_json::from_value::<CreateTask>(serde_json::json!({
        "workspace_id": 1, "task_type": "feat", "title": "Add login",
        "request_id": "chat-12/create-1"
    }))
    .unwrap();
    assert_eq!(create.title, "Add login");
    let start = serde_json::from_value::<StartTask>(serde_json::json!({
        "id": 7, "request_id": "event-40/start-7"
    }))
    .unwrap();
    assert_eq!(start.id, TaskId(7));
}

#[test]
fn creates_a_task_with_its_dependencies() {
    let (mut storage, workspace) = storage_with_workspace();
    let first = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    let second = create(&mut storage, workspace, "API", vec![first.id]).unwrap();
    assert_eq!(second.depends_on, vec![first.id]);
    assert_eq!(second.status, types::TaskStatus::Planned);
    let stored = storage.get_task(second.id.into()).unwrap().unwrap();
    assert_eq!(Task::from(&stored), second);
}

#[test]
fn an_unknown_prerequisite_or_empty_title_creates_nothing() {
    let (mut storage, workspace) = storage_with_workspace();
    let error = create(&mut storage, workspace, "API", vec![TaskId(42)]).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
    let error = create(&mut storage, workspace, "  ", vec![]).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    assert!(storage.list_all_tasks().unwrap().is_empty());
}

#[test]
fn create_plan_creates_every_task_with_its_links() {
    let (mut storage, workspace) = storage_with_workspace();
    let existing = storage
        .create_task(&crate::storage::NewTask {
            workspace_id: workspace.into(),
            task_type: model::TaskType::Feat,
            title: "Earlier work".to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            autopilot: false,
            criteria: Vec::new(),
        })
        .unwrap()
        .id;
    let storage = StorageState::new(storage);
    let created = create_plan(
        &storage,
        plan(serde_json::json!([
            {"key": "ui", "workspace_id": workspace, "task_type": "feat", "title": "UI",
             "depends_on_keys": ["api"], "depends_on": [existing.0],
             "related_keys": ["schema"]},
            {"key": "schema", "workspace_id": workspace, "task_type": "feat",
             "title": "Schema", "labels": ["search"],
             "criteria": [{"text": "Migrated", "kind": "manual"}]},
            {"key": "api", "workspace_id": workspace, "task_type": "feat", "title": "API",
             "depends_on_keys": ["schema"], "related": [existing.0]},
        ])),
    )
    .unwrap();

    let keys: Vec<&str> = created.tasks.iter().map(|t| t.key.as_str()).collect();
    assert_eq!(keys, ["ui", "schema", "api"]);
    let [ui, schema, api] = [0, 1, 2].map(|i| &created.tasks[i].task);
    let mut ui_depends_on = ui.depends_on.clone();
    ui_depends_on.sort_by_key(|id| id.0);
    assert_eq!(ui_depends_on, [TaskId(existing.0), api.id]);
    assert_eq!(api.depends_on, [schema.id]);
    assert!(schema.depends_on.is_empty());
    assert_eq!(schema.labels, ["search"]);
    assert_eq!(schema.criteria.len(), 1);
    assert!(api.criteria.is_empty());
    let mut relations = lock(&storage).list_relations().unwrap();
    relations.sort();
    let pair = |a: TaskId, b: TaskId| (model::TaskId(a.0.min(b.0)), model::TaskId(a.0.max(b.0)));
    let mut expected = vec![pair(ui.id, schema.id), pair(api.id, TaskId(existing.0))];
    expected.sort();
    assert_eq!(relations, expected);
}

#[test]
fn create_plan_creates_nothing_when_any_task_fails() {
    let (storage, workspace) = storage_with_workspace();
    let storage = StorageState::new(storage);
    let first = serde_json::json!(
        {"key": "schema", "workspace_id": workspace, "task_type": "feat", "title": "Schema"}
    );
    let last = |fields: serde_json::Value| {
        let mut task = serde_json::json!(
            {"key": "api", "workspace_id": workspace, "task_type": "feat", "title": "API"}
        );
        task.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        task
    };
    let cases = [
        (
            "unknown task",
            last(serde_json::json!({"depends_on": [999]})),
        ),
        (
            "unknown related task",
            last(serde_json::json!({"related": [999]})),
        ),
        (
            "unknown key",
            last(serde_json::json!({"depends_on_keys": ["ui"]})),
        ),
        (
            "own key",
            last(serde_json::json!({"related_keys": ["api"]})),
        ),
        ("repeated key", last(serde_json::json!({"key": "schema"}))),
        ("empty key", last(serde_json::json!({"key": " "}))),
        (
            "unknown workspace",
            last(serde_json::json!({"workspace_id": 999})),
        ),
        ("bad label", last(serde_json::json!({"labels": ["a,b"]}))),
        (
            "bad due date",
            last(serde_json::json!({"due_date": "tomorrow"})),
        ),
        ("empty title", last(serde_json::json!({"title": " "}))),
    ];
    for (name, task) in cases {
        let error = create_plan(&storage, plan(serde_json::json!([first, task])));
        assert!(error.is_err(), "{name}");
        assert_eq!(lock(&storage).list_all_tasks().unwrap(), [], "{name}");
    }

    let cycle = plan(serde_json::json!([
        first,
        last(serde_json::json!({"depends_on_keys": ["ui"]})),
        {"key": "ui", "workspace_id": workspace, "task_type": "feat", "title": "UI",
         "depends_on_keys": ["api", "schema"]},
    ]));
    let error = create_plan(&storage, cycle).unwrap_err();
    assert!(error.message.contains("`api`, `ui`"), "{}", error.message);
    assert!(create_plan(&storage, plan(serde_json::json!([]))).is_err());
    assert_eq!(lock(&storage).list_all_tasks().unwrap(), []);
}

/// A plan is checked and written under one lock, and the write itself refuses an
/// archived workspace, so no task of a plan lands in or links to an archived workspace.
#[test]
fn create_plan_creates_nothing_in_or_linked_to_an_archived_workspace() {
    let (mut storage, workspace) = storage_with_workspace();
    let old: WorkspaceId = storage
        .create_workspace(&NewWorkspace {
            name: "Old".to_owned(),
            description: None,
            repository: None,
        })
        .unwrap()
        .id
        .into();
    let old_task = create(&mut storage, old, "Old work", vec![]).unwrap();
    storage.archive_workspace(old.into()).unwrap();
    let new_task = |workspace_id: WorkspaceId| crate::storage::NewPlanTask {
        task: crate::storage::NewTask {
            workspace_id: workspace_id.into(),
            task_type: model::TaskType::Feat,
            title: "Task".to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            autopilot: false,
            criteria: Vec::new(),
        },
        labels: Vec::new(),
        refs: Vec::new(),
        depends_on: Vec::new(),
        related: Vec::new(),
    };
    assert!(matches!(
        storage.create_tasks(&[new_task(workspace), new_task(old)]),
        Err(StorageError::WorkspaceNotFound(_))
    ));
    let storage = StorageState::new(storage);
    let task = |fields: serde_json::Value| {
        let mut task = serde_json::json!(
            {"key": "api", "workspace_id": workspace, "task_type": "feat", "title": "API"}
        );
        task.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        task
    };
    let cases = [
        (
            "archived workspace",
            serde_json::json!({"workspace_id": old}),
            CommandErrorCode::WorkspaceNotFound,
        ),
        (
            "archived prerequisite",
            serde_json::json!({"depends_on": [old_task.id]}),
            CommandErrorCode::NotFound,
        ),
        (
            "archived related task",
            serde_json::json!({"related": [old_task.id]}),
            CommandErrorCode::NotFound,
        ),
    ];
    for (name, fields, code) in cases {
        let error = create_plan(&storage, plan(serde_json::json!([task(fields)]))).unwrap_err();
        assert_eq!(error.code, code, "{name}");
    }

    let mut storage = lock(&storage);
    storage.restore_workspace(old.into()).unwrap();
    let ids: Vec<i64> = storage
        .list_all_tasks()
        .unwrap()
        .iter()
        .map(|t| t.id.0)
        .collect();
    assert_eq!(ids, [old_task.id.0]);
    assert_eq!(storage.list_relations().unwrap(), []);
}

/// The tasks of a plan are written in one transaction: a failure after the first task
/// is inserted rolls it back.
#[test]
fn create_tasks_rolls_back_every_task_on_a_failure() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = |workspace: i64| crate::storage::NewTask {
        workspace_id: model::WorkspaceId(workspace),
        task_type: model::TaskType::Feat,
        title: "Task".to_owned(),
        description: String::new(),
        estimate: None,
        due_date: None,
        autopilot: false,
        criteria: Vec::new(),
    };
    let item = |task, depends_on| crate::storage::NewPlanTask {
        refs: Vec::new(),
        task,
        labels: vec!["search".to_owned()],
        depends_on,
        related: Vec::new(),
    };
    for failing in [
        item(task(999), Vec::new()),
        item(
            task(workspace.0),
            vec![crate::storage::PlanLink::Existing(model::TaskId(999))],
        ),
    ] {
        let plan = [item(task(workspace.0), Vec::new()), failing];
        assert!(storage.create_tasks(&plan).is_err());
        assert_eq!(storage.list_all_tasks().unwrap(), []);
    }
}

#[test]
fn create_task_writes_nothing_when_a_related_link_fails() {
    let (mut storage, workspace) = storage_with_workspace();
    let prerequisite = create(&mut storage, workspace, "Schema", Vec::new()).unwrap();
    let linked = create(&mut storage, workspace, "Search", Vec::new()).unwrap();
    let count = |storage: &Storage, table: &str| -> i64 {
        storage
            .connection()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    };
    let tables = [
        "tasks",
        "task_events",
        "task_labels",
        "task_dependencies",
        "task_relations",
        "task_criteria",
        "task_notes",
    ];
    let before = tables.map(|table| count(&storage, table));
    // The related link fails, and so would deleting a task to undo the create.
    storage
        .connection()
        .execute_batch(
            "CREATE TEMP TRIGGER fail_related BEFORE INSERT ON task_relations
                 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
                 CREATE TEMP TRIGGER keep_tasks BEFORE DELETE ON tasks
                 BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;",
        )
        .unwrap();
    let request: CreateTask = serde_json::from_value(serde_json::json!({
        "workspace_id": workspace,
        "task_type": "feat",
        "title": "API",
        "labels": ["search"],
        "refs": ["lane:api"],
        "depends_on": [prerequisite.id],
        "related": [linked.id],
        "criteria": [{"text": "Deployed", "kind": "manual"}],
    }))
    .unwrap();

    let error = insert_task(&mut storage, request).unwrap_err();
    assert!(error.message.contains("injected failure"), "{error:?}");
    assert_eq!(tables.map(|table| count(&storage, table)), before);
}
