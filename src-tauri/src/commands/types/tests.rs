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
