use super::*;

#[test]
fn workspace_metadata_is_stored_without_interpreting_the_repository() {
    let new: NewWorkspace = serde_json::from_value(serde_json::json!({"name":" toodo ","description":"# Planning", "repository":"discord:tasks"})).unwrap();
    let new: crate::storage::NewWorkspace = new.try_into().unwrap();
    assert_eq!(new.name, "toodo");
    assert_eq!(new.description.as_deref(), Some("# Planning"));
    assert_eq!(new.repository.as_deref(), Some("discord:tasks"));
    assert!(
        serde_json::from_value::<NewWorkspace>(serde_json::json!({"name":"toodo", "path":"/repo"}))
            .is_err()
    );
    let blank: NewWorkspace = serde_json::from_value(serde_json::json!({"name":" "})).unwrap();
    assert!(crate::storage::NewWorkspace::try_from(blank).is_err());
}

#[test]
fn task_list_filter_bounds_the_page_and_the_ids() {
    let query = |filter: serde_json::Value| {
        let filter: TaskListFilter = serde_json::from_value(filter).unwrap();
        crate::storage::TaskQuery::try_from(filter)
    };
    let invalid = |filter: serde_json::Value| {
        query(filter)
            .is_err_and(|error| error.code == crate::commands::CommandErrorCode::InvalidInput)
    };
    assert!(invalid(serde_json::json!({"limit": 0})));
    assert!(invalid(serde_json::json!({"limit": MAX_TASK_PAGE + 1})));
    assert_eq!(
        query(serde_json::json!({"limit": 1})).unwrap().limit,
        Some(1)
    );
    assert_eq!(
        query(serde_json::json!({"limit": MAX_TASK_PAGE}))
            .unwrap()
            .limit,
        Some(MAX_TASK_PAGE)
    );
    let ids = |count: i64| serde_json::json!({"ids": (1..=count).collect::<Vec<_>>()});
    assert!(invalid(ids(i64::from(MAX_TASK_PAGE) + 1)));
    let listed = query(ids(i64::from(MAX_TASK_PAGE))).unwrap().ids.unwrap();
    assert_eq!(listed.len(), MAX_TASK_PAGE as usize);
    assert!(
        query(serde_json::json!({"statuses": []}))
            .unwrap()
            .statuses
            .is_empty()
    );
}

#[test]
fn serialized_shapes_use_the_frontend_names() {
    assert_eq!(
        serde_json::to_value(TaskStatus::InProgress).unwrap(),
        "in_progress"
    );
    let edit: TaskEdit = serde_json::from_value(
        serde_json::json!({"id":7,"taskType":"refactor","title":"Split storage","description":""}),
    )
    .unwrap();
    assert_eq!(edit.id, TaskId(7));
    assert_eq!(edit.task_type, TaskType::Refactor);
}
