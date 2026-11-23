use super::*;

#[test]
fn search_hits_and_task_details_carry_history_and_links() {
    let (mut storage, workspace) = storage_with_workspace();
    let research = create(&mut storage, workspace, "Research search engines", vec![]).unwrap();
    let schema = create(&mut storage, workspace, "Search schema", vec![]).unwrap();
    let tool = create(&mut storage, workspace, "Search tool", vec![schema.id]).unwrap();
    add_related(
        &mut storage,
        Related {
            task_id: tool.id,
            related_id: research.id,
        },
    )
    .unwrap();
    add_note(
        &mut storage,
        NoteKind::Progress,
        AddNote {
            task_id: research.id,
            note: "Chose FTS5 over tantivy".to_owned(),
        },
    )
    .unwrap();
    storage
        .set_task_status(
            research.id.into(),
            crate::domain::status::TaskStatus::InProgress,
        )
        .unwrap();
    storage
        .conclude_task(research.id.into(), "Too heavy for a desktop app", None)
        .unwrap();

    let hits = search(&storage, "search").unwrap();
    let ids: Vec<_> = hits.iter().map(|hit| hit.id).collect();
    assert_eq!(ids.len(), 3);
    let hit = hits.iter().find(|hit| hit.id == schema.id).unwrap();
    assert_eq!(
        (hit.workspace.as_str(), &hit.dependents, &hit.related),
        ("toodo", &vec![tool.id], &vec![])
    );
    let hit = &search(&storage, "tantivy").unwrap()[0];
    assert_eq!(hit.id, research.id);
    assert_eq!(hit.related, [tool.id]);
    assert_eq!(hit.resolution, Some(TaskResolution::NotAdopted));
    assert_eq!(
        search(&storage, " ").unwrap_err().kind,
        CommandErrorKind::InvalidInput
    );

    let details = task_details(&storage, GetTask { id: research.id }).unwrap();
    assert_eq!(
        details.task.completion_note.as_deref(),
        Some("Too heavy for a desktop app")
    );
    assert_eq!(details.task.notes[0].body, "Chose FTS5 over tantivy");
    let statuses: Vec<_> = details
        .task
        .timeline
        .iter()
        .map(|event| event.status)
        .collect();
    assert_eq!(
        statuses,
        [
            TaskStatus::Planned,
            TaskStatus::InProgress,
            TaskStatus::Done
        ]
    );
    assert_eq!(
        details.related,
        [TaskLink {
            id: tool.id,
            workspace_id: workspace,
            title: "Search tool".to_owned(),
            status: TaskStatus::Planned,
            resolution: None,
        }]
    );
    let details = task_details(&storage, GetTask { id: tool.id }).unwrap();
    let titles = |links: &[TaskLink]| -> Vec<String> {
        links.iter().map(|link| link.title.clone()).collect()
    };
    assert_eq!(titles(&details.depends_on), ["Search schema"]);
    assert!(details.dependents.is_empty());
    assert_eq!(titles(&details.related), ["Research search engines"]);
    let json = serde_json::to_value(&details).unwrap();
    assert_eq!(json["dependsOn"][0]["status"], "planned");
    assert_eq!(json["task"]["id"], serde_json::json!(tool.id));

    let unlinked = remove_related(
        &mut storage,
        Related {
            task_id: research.id,
            related_id: tool.id,
        },
    )
    .unwrap();
    assert!(unlinked.related.is_empty());
    let error = remove_related(
        &mut storage,
        Related {
            task_id: research.id,
            related_id: tool.id,
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
    assert!(
        error.message.ends_with(&format!(
            "get_task {} lists its related tasks",
            research.id.0
        )),
        "{}",
        error.message
    );
    let error = task_details(&storage, GetTask { id: TaskId(99) }).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
    let error = add_related(
        &mut storage,
        Related {
            task_id: tool.id,
            related_id: tool.id,
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
}

#[test]
fn lists_tasks_of_one_workspace_or_all() {
    let (mut storage, workspace) = storage_with_workspace();
    let schema = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    create(&mut storage, workspace, "API", vec![schema.id]).unwrap();
    let all = list_tasks(&storage, ListTasks::default()).unwrap();
    assert_eq!(all.len(), 2);
    assert!(all[0].ready && all[0].blocked_by.is_empty());
    assert!(!all[1].ready);
    assert_eq!(all[1].blocked_by[0].id, schema.id);
    let json = serde_json::to_value(&all[1]).unwrap();
    assert_eq!(json["title"], "API");
    assert_eq!(json["ready"], false);
    assert_eq!(json["blockedBy"][0]["title"], "Schema");
    let error = list_tasks(
        &storage,
        ListTasks {
            workspace_id: Some(WorkspaceId(99)),
            ..ListTasks::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
}

#[test]
fn lists_tasks_narrowed_by_status_readiness_and_limit() {
    let (mut storage, workspace) = storage_with_workspace();
    let schema = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    let api = create(&mut storage, workspace, "API", vec![schema.id]).unwrap();
    let docs = create(&mut storage, workspace, "Docs", vec![]).unwrap();
    let ids = |request: ListTasks| -> Vec<TaskId> {
        list_tasks(&storage, request)
            .unwrap()
            .iter()
            .map(|listed| listed.task.id)
            .collect()
    };
    let ready = |ready: bool, limit: Option<u32>| ListTasks {
        ready: Some(ready),
        limit,
        ..ListTasks::default()
    };
    assert_eq!(ids(ready(true, None)), [schema.id, docs.id]);
    assert_eq!(ids(ready(true, Some(1))), [docs.id]);
    assert_eq!(ids(ready(false, None)), [api.id]);
    let page = |limit, before_id| ListTasks {
        limit: Some(limit),
        before_id,
        ..ListTasks::default()
    };
    assert_eq!(ids(page(2, None)), [api.id, docs.id]);
    assert_eq!(ids(page(2, Some(api.id))), [schema.id]);
    let in_progress = ListTasks {
        status: Some(vec![TaskStatus::InProgress]),
        ..ListTasks::default()
    };
    assert_eq!(ids(in_progress.clone()), Vec::<TaskId>::new());
    assert_eq!(
        ids(ListTasks {
            ready: Some(true),
            ..in_progress
        }),
        Vec::<TaskId>::new()
    );
    // A page still tells what blocks its tasks when the blocker is on another page.
    let listed = list_tasks(&storage, page(1, Some(docs.id))).unwrap();
    assert_eq!(listed[0].task.id, api.id);
    assert_eq!(listed[0].blocked_by[0].id, schema.id);
    assert!(!listed[0].ready);
    let error = list_tasks(&storage, page(0, None)).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
}

#[test]
fn a_task_that_waits_until_a_time_is_ready_only_once_the_wait_ends() {
    let (mut storage, workspace) = storage_with_workspace();
    let schema = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    let docs = create(&mut storage, workspace, "Docs", vec![]).unwrap();
    storage.wait_task(docs.id.into(), i64::MAX, None).unwrap();
    let ready = |storage: &Storage, ready: bool| -> Vec<TaskId> {
        let request = ListTasks {
            ready: Some(ready),
            ..ListTasks::default()
        };
        list_tasks(storage, request)
            .unwrap()
            .iter()
            .map(|listed| listed.task.id)
            .collect()
    };
    assert_eq!(ready(&storage, true), [schema.id]);
    assert_eq!(ready(&storage, false), [docs.id]);
    let details = task_details(&storage, GetTask { id: docs.id }).unwrap();
    assert!(!details.ready);
    assert!(details.blocked_by.is_empty());
    storage.end_task_wait(docs.id.into(), None).unwrap();
    assert_eq!(ready(&storage, true), [schema.id, docs.id]);
    assert!(
        task_details(&storage, GetTask { id: docs.id })
            .unwrap()
            .ready
    );
}

#[test]
fn a_task_number_finds_that_task_first_in_any_workspace() {
    let (mut storage, workspace) = storage_with_workspace();
    let other = storage
        .create_workspace(&NewWorkspace {
            name: "server".to_owned(),
            description: None,
            repository: None,
        })
        .unwrap();
    let numbered = create(&mut storage, other.id.into(), "Deploy server", vec![]).unwrap();
    let number = numbered.id.0;
    let mention = create(
        &mut storage,
        workspace,
        &format!("Follow up on {number}"),
        vec![],
    )
    .unwrap();
    let ids = |query: String, workspace_id, status| -> Vec<TaskId> {
        search_tasks(
            &storage,
            SearchTasks {
                query,
                workspace_id,
                status,
                limit: None,
            },
        )
        .unwrap()
        .iter()
        .map(|hit| hit.id)
        .collect()
    };
    assert_eq!(
        ids(format!("{number}"), None, None),
        [numbered.id, mention.id]
    );
    assert_eq!(
        ids(format!(" #{number} "), Some(workspace), None),
        [numbered.id]
    );
    assert_eq!(
        ids(format!("{number}"), Some(workspace), None),
        [numbered.id, mention.id]
    );
    assert_eq!(
        ids(format!("{number}"), None, Some(TaskStatus::Done)),
        Vec::<TaskId>::new()
    );
    assert_eq!(ids("999".to_owned(), None, None), Vec::<TaskId>::new());
}

#[test]
fn a_search_limit_of_zero_returns_no_tasks() {
    let (mut storage, workspace) = storage_with_workspace();
    create(&mut storage, workspace, "Search schema", vec![]).unwrap();
    let limited = |limit| {
        search_tasks(
            &storage,
            SearchTasks {
                query: "schema".to_owned(),
                workspace_id: None,
                status: None,
                limit,
            },
        )
        .unwrap()
        .len()
    };
    assert_eq!(limited(Some(0)), 0);
    assert_eq!(limited(None), 1);
}

#[test]
fn search_leaves_out_archived_tasks_and_tasks_of_archived_workspaces() {
    let (mut storage, workspace) = storage_with_workspace();
    let live = create(&mut storage, workspace, "Avatar upload", vec![]).unwrap();
    let archived = create(&mut storage, workspace, "Avatar crop", vec![]).unwrap();
    storage
        .add_related(live.id.into(), archived.id.into())
        .unwrap();
    storage.archive_task(archived.id.into()).unwrap();
    let other = storage
        .create_workspace(&NewWorkspace {
            name: "Other".to_owned(),
            description: None,
            repository: None,
        })
        .unwrap();
    create(&mut storage, other.id.into(), "Avatar resize", vec![]).unwrap();
    storage.archive_workspace(other.id).unwrap();

    let hits = search_tasks(
        &storage,
        SearchTasks {
            query: "avatar".to_owned(),
            workspace_id: None,
            status: None,
            limit: None,
        },
    )
    .unwrap();
    assert_eq!(hits.iter().map(|hit| hit.id).collect::<Vec<_>>(), [live.id]);
    assert!(hits[0].related.is_empty());
}
