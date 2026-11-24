use super::*;

#[test]
fn update_changes_only_the_given_fields() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    let updated = update_task(
        &mut storage,
        UpdateTask {
            status: None,
            refs: None,
            remove_refs: None,
            id: task.id,
            task_type: None,
            title: None,
            description: Some("Add tables".to_owned()),
            estimate: None,
            due_date: None,
            labels: None,
            autopilot: None,
            criteria: None,
        },
    )
    .unwrap();
    assert_eq!(updated.title, "Schema");
    assert_eq!(updated.task_type, TaskType::Feat);
    assert_eq!(updated.description, "Add tables");
}

#[test]
fn update_leaves_a_done_task_as_it_was_finished() {
    use crate::domain::status::TaskStatus::{Done, InProgress, InReview};
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    for status in [InProgress, InReview, Done] {
        storage.set_task_status(task.id.into(), status).unwrap();
    }
    let done = get_task(&storage, task.id).unwrap();

    let error = update(
        &mut storage,
        serde_json::json!({ "id": task.id, "title": "Renamed", "description": "Other" }),
    )
    .unwrap_err();

    assert_eq!(error.kind, CommandErrorKind::Rejected);
    assert!(
        error.message.contains("add_progress_note"),
        "{}",
        error.message
    );
    assert_eq!(get_task(&storage, task.id).unwrap(), done);
}

fn update(storage: &mut Storage, request: serde_json::Value) -> CommandResult<Task> {
    update_task(storage, serde_json::from_value(request).unwrap())
}

#[test]
fn add_criterion_appends_one_and_keeps_the_others_with_their_evidence() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = task_with_checked_criterion(&mut storage, workspace);
    let added = add_criterion(&mut storage, serde_json::from_value(serde_json::json!({"task_id":task.id,"text":"Deployed", "kind":"url","target":"https://example.com"})).unwrap()).unwrap();
    assert_eq!(added.criteria[..2], task.criteria[..]);
    assert_eq!(added.criteria[2].kind, types::CheckKind::Url);
    assert_eq!(
        added.criteria[2].target.as_deref(),
        Some("https://example.com")
    );
    assert_eq!(added.criteria[2].state, types::CriterionState::Pending);
    for kind in [
        "pr_merged",
        "pr_open_ci_green",
        "branch_merged_locally",
        "command",
    ] {
        assert!(
            serde_json::from_value::<AddCriterion>(
                serde_json::json!({"task_id":task.id,"text":"Removed", "kind":kind})
            )
            .is_err()
        );
    }
}

#[test]
fn remove_criterion_deletes_only_that_one() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = task_with_checked_criterion(&mut storage, workspace);
    let other = create(&mut storage, workspace, "Other", vec![]).unwrap();
    let remove = |storage: &mut Storage, request: serde_json::Value| {
        remove_criterion(storage, serde_json::from_value(request).unwrap())
    };
    let manual = task.criteria[1].id.0;
    let error = remove(
        &mut storage,
        serde_json::json!({ "task_id": other.id, "criterion_id": manual }),
    )
    .unwrap_err();
    assert!(
        error.message.contains("belongs to task"),
        "{}",
        error.message
    );
    let error = remove(&mut storage, serde_json::json!({ "criterion_id": 999 })).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);

    let removed = remove(&mut storage, serde_json::json!({ "id": manual })).unwrap();
    assert_eq!(removed.criteria, task.criteria[..1]);
    // Naming the merge criterion removes it deliberately.
    let merge = task.criteria[0].id.0;
    let removed = remove(&mut storage, serde_json::json!({ "criterion_id": merge })).unwrap();
    assert!(removed.criteria.is_empty());
    assert_eq!(get_task(&storage, other.id).unwrap().criteria.len(), 1);
}

fn check(storage: &mut Storage, request: serde_json::Value) -> CommandResult<Task> {
    check_criterion(storage, serde_json::from_value(request).unwrap())
}

/// A task with the merge criterion and a manual one checked with evidence.
fn task_with_checked_criterion(storage: &mut Storage, workspace: WorkspaceId) -> Task {
    let task = create(storage, workspace, "Schema", vec![]).unwrap();
    let merge = task.criteria[0].id.0;
    let task = update(
        storage,
        serde_json::json!({ "id": task.id, "criteria": [
            { "id": merge }, { "text": "Docs updated", "kind": "manual" }
        ]}),
    )
    .unwrap();
    let manual = task.criteria[1].id.0;
    check(
        storage,
        serde_json::json!({ "id": manual, "evidence": "docs/guide.md" }),
    )
    .unwrap()
}

#[test]
fn criteria_given_by_id_alone_are_kept_with_their_evidence() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = task_with_checked_criterion(&mut storage, workspace);
    let [merge, manual] = [task.criteria[0].id.0, task.criteria[1].id.0];
    let kept = update(
        &mut storage,
        serde_json::json!({ "id": task.id, "criteria": [
            { "id": merge }, { "id": manual }, { "text": "Released", "kind": "manual" }
        ]}),
    )
    .unwrap();
    assert_eq!(kept.criteria[..2], task.criteria[..]);
    assert_eq!(kept.criteria[2].text, "Released");
    let renamed = update(
        &mut storage,
        serde_json::json!({ "id": task.id, "criteria": [
            { "id": merge }, { "id": manual, "text": "Guide updated" }
        ]}),
    )
    .unwrap();
    assert_eq!(renamed.criteria[1].text, "Guide updated");
    assert_eq!(renamed.criteria[1].state, types::CriterionState::Met);
    assert_eq!(
        renamed.criteria[1].evidence.as_deref(),
        Some("docs/guide.md")
    );

    let error = update(
        &mut storage,
        serde_json::json!({ "id": task.id, "criteria": [
            { "id": merge }, { "text": "No kind" }
        ]}),
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    assert!(
        error.message.contains("needs text and kind"),
        "{}",
        error.message
    );
}

#[test]
fn criteria_with_a_repeated_or_foreign_id_are_rejected() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = task_with_checked_criterion(&mut storage, workspace);
    let other = create(&mut storage, workspace, "API", vec![]).unwrap();
    let merge = task.criteria[0].id.0;
    let error = update(
        &mut storage,
        serde_json::json!({ "id": task.id, "criteria": [{ "id": merge }, { "id": merge }] }),
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    assert_eq!(
        error.message,
        format!("criterion {merge} appears twice; send each criterion once")
    );
    let foreign = other.criteria[0].id.0;
    let error = update(
        &mut storage,
        serde_json::json!({ "id": task.id, "criteria": [{ "id": merge }, { "id": foreign }] }),
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    assert!(
        error.message.starts_with(&format!(
            "criterion {foreign} belongs to task {}, not task {}; call get_task",
            other.id.0, task.id.0
        )),
        "{}",
        error.message
    );
    assert_eq!(get_task(&storage, task.id).unwrap().criteria, task.criteria);
}

#[test]
fn criteria_can_be_removed_by_omitting_them_from_the_new_list() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = task_with_checked_criterion(&mut storage, workspace);
    let manual = task.criteria[1].id;
    let removed = update(
        &mut storage,
        serde_json::json!({"id": task.id, "criteria": [{"id": manual}]}),
    )
    .unwrap();
    assert_eq!(removed.criteria, task.criteria[1..]);
}

#[test]
fn check_criterion_finds_the_task_of_the_criterion() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = task_with_checked_criterion(&mut storage, workspace);
    let other = create(&mut storage, workspace, "API", vec![]).unwrap();
    let manual = task.criteria[1].id.0;
    assert_eq!(task.criteria[1].state, types::CriterionState::Met);
    assert_eq!(task.criteria[1].evidence.as_deref(), Some("docs/guide.md"));

    let error = check(
        &mut storage,
        serde_json::json!({ "task_id": other.id, "criterion_id": manual, "met": false }),
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    assert!(
        error.message.starts_with(&format!(
            "criterion {manual} belongs to task {}, not task {}",
            task.id.0, other.id.0
        )),
        "{}",
        error.message
    );
    let unchecked = check(
        &mut storage,
        serde_json::json!({ "task_id": task.id, "criterion_id": manual, "met": false }),
    )
    .unwrap();
    assert_eq!(unchecked.criteria[1].state, types::CriterionState::Pending);
    let error = check(
        &mut storage,
        serde_json::json!({ "id": 999, "evidence": "x" }),
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
}

#[test]
fn estimates_and_due_dates_are_set_kept_when_omitted_and_cleared_by_null() {
    let (mut storage, workspace) = storage_with_workspace();
    let request: CreateTask = serde_json::from_value(serde_json::json!({
        "workspace_id": workspace,
        "task_type": "feat",
        "title": "Schema",
        "estimate": { "unit": "hours", "amount": 2.5 },
        "due_date": "2026-10-20",
    }))
    .unwrap();
    let task = insert_task(&mut storage, request).unwrap();
    let planned = Some(Estimate {
        unit: types::EstimateUnit::Hours,
        amount: 2.5,
    });
    assert_eq!(task.estimate, planned);
    assert_eq!(task.due_date.as_deref(), Some("2026-10-20"));

    let update = |storage: &mut Storage, fields: serde_json::Value| {
        let mut request = serde_json::json!({ "id": task.id });
        request
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        update_task(storage, serde_json::from_value(request).unwrap())
    };
    let kept = update(&mut storage, serde_json::json!({ "title": "Tables" })).unwrap();
    assert_eq!(
        (kept.estimate, kept.due_date.as_deref()),
        (planned, Some("2026-10-20"))
    );
    let weeks = update(
        &mut storage,
        serde_json::json!({ "estimate": { "unit": "weeks", "amount": 3 }, "due_date": null }),
    )
    .unwrap();
    assert_eq!(
        (weeks.estimate, weeks.due_date),
        (
            Some(Estimate {
                unit: types::EstimateUnit::Weeks,
                amount: 3.0
            }),
            None
        )
    );
    let cleared = update(&mut storage, serde_json::json!({ "estimate": null })).unwrap();
    assert_eq!(cleared.estimate, None);
    assert_eq!(
        Task::from(&storage.get_task(task.id.into()).unwrap().unwrap()),
        cleared
    );

    for invalid in [
        serde_json::json!({ "due_date": "2026-02-30" }),
        serde_json::json!({ "estimate": { "unit": "hours", "amount": 0 } }),
    ] {
        let error = update(&mut storage, invalid.clone()).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput, "{invalid}");
    }
    assert_eq!(
        Task::from(&storage.get_task(task.id.into()).unwrap().unwrap()),
        cleared
    );
}

#[test]
fn autopilot_is_set_on_create_listed_by_filter_kept_when_marked_again_and_cleared() {
    let (mut storage, workspace) = storage_with_workspace();
    let plain = create(&mut storage, workspace, "Plain", vec![]).unwrap();
    assert_eq!((plain.autopilot, plain.autopilot_at), (false, None));
    let request: CreateTask = serde_json::from_value(serde_json::json!({
        "workspace_id": workspace,
        "task_type": "feat",
        "title": "Flagged",
        "autopilot": true,
    }))
    .unwrap();
    let flagged = insert_task(&mut storage, request).unwrap();
    assert!(flagged.autopilot);
    let since = flagged.autopilot_at.expect("a marked task records when");

    let listed = |storage: &Storage, autopilot: Option<bool>| -> Vec<TaskId> {
        let request = ListTasks {
            autopilot,
            ..ListTasks::default()
        };
        list_tasks(storage, request)
            .unwrap()
            .into_iter()
            .map(|listed| listed.task.id)
            .collect()
    };
    assert_eq!(listed(&storage, Some(true)), [flagged.id]);
    assert_eq!(listed(&storage, Some(false)), [plain.id]);
    assert_eq!(listed(&storage, None), [plain.id, flagged.id]);

    let update = |storage: &mut Storage, id: TaskId, fields: serde_json::Value| {
        let mut request = serde_json::json!({ "id": id });
        request
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        update_task(storage, serde_json::from_value(request).unwrap()).unwrap()
    };
    let renamed = update(
        &mut storage,
        flagged.id,
        serde_json::json!({ "title": "Still" }),
    );
    assert_eq!(renamed.autopilot_at, Some(since));
    let again = update(
        &mut storage,
        flagged.id,
        serde_json::json!({ "autopilot": true }),
    );
    assert_eq!(again.autopilot_at, Some(since));
    let cleared = update(
        &mut storage,
        flagged.id,
        serde_json::json!({ "autopilot": false }),
    );
    assert_eq!((cleared.autopilot, cleared.autopilot_at), (false, None));
    let marked = update(
        &mut storage,
        plain.id,
        serde_json::json!({ "autopilot": true }),
    );
    assert!(marked.autopilot && marked.autopilot_at.is_some());
    assert_eq!(listed(&storage, Some(true)), [plain.id]);

    let created = create_plan(
        &StorageState::new(storage),
        plan(serde_json::json!([
            { "key": "a", "workspace_id": workspace, "task_type": "feat", "title": "A", "autopilot": true },
            { "key": "b", "workspace_id": workspace, "task_type": "feat", "title": "B" },
        ])),
    )
    .unwrap();
    let flags: Vec<bool> = created
        .tasks
        .iter()
        .map(|planned| planned.task.autopilot)
        .collect();
    assert_eq!(flags, [true, false]);
}

#[test]
fn labels_are_set_kept_when_omitted_replaced_and_cleared() {
    let (mut storage, workspace) = storage_with_workspace();
    let request: CreateTask = serde_json::from_value(serde_json::json!({
        "workspace_id": workspace,
        "task_type": "feat",
        "title": "Schema",
        "labels": [" search ", "q4-goal", "search"],
    }))
    .unwrap();
    let task = insert_task(&mut storage, request).unwrap();
    assert_eq!(task.labels, ["q4-goal", "search"]);

    let update = |storage: &mut Storage, fields: serde_json::Value| {
        let mut request = serde_json::json!({ "id": task.id });
        request
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        update_task(storage, serde_json::from_value(request).unwrap())
    };
    let kept = update(&mut storage, serde_json::json!({ "title": "Tables" })).unwrap();
    assert_eq!(kept.labels, ["q4-goal", "search"]);
    let replaced = update(&mut storage, serde_json::json!({ "labels": ["review"] })).unwrap();
    assert_eq!(replaced.labels, ["review"]);

    let error = update(&mut storage, serde_json::json!({ "labels": ["a,b"] })).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    assert!(error.message.contains("own list item"), "{error:?}");
    let error = update(
        &mut storage,
        serde_json::json!({ "title": "Renamed", "labels": [""] }),
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    let stored = Task::from(&storage.get_task(task.id.into()).unwrap().unwrap());
    assert_eq!(
        (stored.title.as_str(), stored.labels.as_slice()),
        ("Tables", ["review".to_owned()].as_slice())
    );

    let cleared = update(&mut storage, serde_json::json!({ "labels": [] })).unwrap();
    assert!(cleared.labels.is_empty());
}

#[test]
fn refs_are_kept_in_order_appended_removed_and_searched() {
    let (mut storage, workspace) = storage_with_workspace();
    let request: CreateTask = serde_json::from_value(serde_json::json!({
        "workspace_id": workspace,
        "task_type": "feat",
        "title": "Schema",
        "refs": [" lane:schema-lane ", "discord:42", "lane:schema-lane"],
    }))
    .unwrap();
    let task = insert_task(&mut storage, request).unwrap();
    assert_eq!(task.refs, ["lane:schema-lane", "discord:42"]);

    let update = |storage: &mut Storage, fields: serde_json::Value| {
        let mut request = serde_json::json!({ "id": task.id });
        request
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        update_task(storage, serde_json::from_value(request).unwrap())
    };
    let kept = update(&mut storage, serde_json::json!({ "title": "Tables" })).unwrap();
    assert_eq!(kept.refs, ["lane:schema-lane", "discord:42"]);
    let changed = update(
        &mut storage,
        serde_json::json!({ "refs": ["pr:7", "discord:42"], "remove_refs": ["lane:schema-lane"] }),
    )
    .unwrap();
    assert_eq!(changed.refs, ["discord:42", "pr:7"]);
    let error = update(
        &mut storage,
        serde_json::json!({ "title": "Renamed", "refs": ["a\nb"] }),
    )
    .unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    assert_eq!(get_task(&storage, task.id).unwrap(), changed);

    let hits = search(&storage, "pr:7").unwrap();
    assert_eq!(hits.iter().map(|hit| hit.id).collect::<Vec<_>>(), [task.id]);
    update(&mut storage, serde_json::json!({ "remove_refs": ["pr:7"] })).unwrap();
    assert!(search(&storage, "pr:7").unwrap().is_empty());
}

#[test]
fn decision_notes_are_kept_apart_from_progress_notes() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    let mut note = |arguments: serde_json::Value| {
        let request: AddProgressNote = serde_json::from_value(arguments).unwrap();
        let (kind, note) = request.into_note();
        add_note(&mut storage, kind, note).unwrap()
    };

    note(serde_json::json!({ "task_id": task.id, "note": "Drafted tables" }));
    let noted = note(serde_json::json!({
        "task_id": task.id, "kind": "decision", "note": "Chose SQLite over files"
    }));
    let kinds: Vec<_> = noted.notes.iter().map(|note| note.kind).collect();
    assert_eq!(
        kinds,
        [types::NoteKind::Progress, types::NoteKind::Decision]
    );
    assert!(
        serde_json::from_value::<AddProgressNote>(serde_json::json!({
            "task_id": task.id, "kind": "blocker", "note": "x"
        }))
        .is_err()
    );
}

#[test]
fn notes_are_trimmed_and_a_blank_note_or_unknown_task_adds_none() {
    let (mut storage, workspace) = storage_with_workspace();
    let task = create(&mut storage, workspace, "Schema", vec![]).unwrap();
    let note = |task_id: TaskId, note: &str| AddNote {
        task_id,
        note: note.to_owned(),
    };

    let noted = add_note(
        &mut storage,
        NoteKind::Progress,
        note(task.id, "  Chose SQLite \n"),
    )
    .unwrap();
    let noted = add_note(&mut storage, NoteKind::Blocker, note(noted.id, "No access")).unwrap();
    let notes: Vec<_> = noted
        .notes
        .iter()
        .map(|note| (note.kind, note.body.as_str()))
        .collect();
    assert_eq!(
        notes,
        [
            (types::NoteKind::Progress, "Chose SQLite"),
            (types::NoteKind::Blocker, "No access"),
        ]
    );

    let error = add_note(&mut storage, NoteKind::Blocker, note(task.id, " \n")).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    let error = add_note(&mut storage, NoteKind::Progress, note(TaskId(99), "x")).unwrap_err();
    assert_eq!(error.kind, CommandErrorKind::NotFound);
    assert_eq!(get_task(&storage, task.id).unwrap().notes.len(), 2);
}

#[test]
fn unknown_arguments_are_rejected_with_the_accepted_ones() {
    let error =
        serde_json::from_value::<UpdateTask>(serde_json::json!({"id": 1, "dueDate": "2026-11-01"}))
            .unwrap_err()
            .to_string();
    assert!(error.contains("unknown field `dueDate`"), "{error}");
    assert!(error.contains("`due_date`"), "{error}");

    let error = serde_json::from_value::<UpdateTask>(serde_json::json!({
        "id": 1, "criteria": [{"idd": 7, "text": "Docs updated", "kind": "manual"}]
    }))
    .unwrap_err()
    .to_string();
    assert!(error.contains("unknown field `idd`"), "{error}");
    assert!(error.contains("`id`"), "{error}");
}

#[test]
fn patch_schemas_advertise_no_null_defaults() {
    let schema = schemars::schema_for!(UpdateTask);
    let properties = schema
        .get("properties")
        .and_then(|p| p.as_object())
        .unwrap();
    for (name, property) in properties {
        assert_ne!(
            property.get("default"),
            Some(&serde_json::Value::Null),
            "{name}: {property}"
        );
    }
}
