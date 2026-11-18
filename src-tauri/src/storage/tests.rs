use super::*;
use crate::domain::dag;
use crate::domain::model::{
    CommitRecord, LinkedIssue, NoteKind, Task, TaskType, TaskWait, Workspace,
};
use crate::domain::status::TaskStatus;
use TaskStatus::*;

fn local_location(path: &str) -> String {
    path.to_owned()
}

fn ssh_location(machine: &str, path: &str) -> String {
    format!("{machine}:{path}")
}

fn add_workspace(storage: &mut Storage, name: &str, location: String) -> Workspace {
    storage
        .create_workspace(&NewWorkspace {
            name: name.to_owned(),
            description: None,
            repository: Some(location),
        })
        .unwrap()
}

fn add_task(storage: &mut Storage, workspace: &Workspace, title: &str) -> Task {
    storage
        .create_task(&NewTask {
            workspace_id: workspace.id,
            task_type: TaskType::Feat,
            title: title.to_owned(),
            description: format!("Implement {title}"),
            estimate: None,
            due_date: None,
            autopilot: false,
            criteria: Vec::new(),
        })
        .unwrap()
}

fn status(storage: &Storage, task: &Task) -> TaskStatus {
    storage.get_task(task.id).unwrap().unwrap().status
}

fn ready(storage: &Storage, task: &Task) -> bool {
    dag::is_ready(&storage.list_all_tasks().unwrap(), task.id).unwrap()
}

fn commit(task: TaskId, sha: &str, committed_at: i64) -> CommitRecord {
    CommitRecord {
        task_id: task,
        sha: sha.to_owned(),
        message: format!("Commit {sha}"),
        author: "Dev <dev@example.com>".to_owned(),
        committed_at,
    }
}

fn row_count(storage: &Storage, table: &str) -> i64 {
    storage
        .conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn entities_survive_reopening_the_database_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("toodo.sqlite3");

    let mut storage = Storage::open(&path).unwrap();
    let local = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let remote = add_workspace(
        &mut storage,
        "Server",
        ssh_location("devbox", "/home/me/server"),
    );
    let base = add_task(&mut storage, &local, "Base");
    let mut started = add_task(&mut storage, &local, "Login page");
    let remote_task = add_task(&mut storage, &remote, "Remote fix");
    storage.add_dependency(started.id, base.id).unwrap();
    for status in [InProgress, InReview, Done] {
        storage.set_task_status(base.id, status).unwrap();
    }
    storage.set_task_status(started.id, InProgress).unwrap();
    started.task_type = TaskType::Fix;
    started.description = "Updated task".to_owned();
    storage.update_task(&started).unwrap();
    let commits = vec![commit(started.id, "bbb", 20), commit(started.id, "aaa", 10)];
    storage.seed_commit_records(started.id, &commits).unwrap();

    let workspaces = storage.list_workspaces().unwrap();
    let local_tasks = storage.list_tasks(local.id).unwrap();
    let remote_tasks = storage.list_tasks(remote.id).unwrap();
    drop(storage);

    let storage = Storage::open(&path).unwrap();
    assert_eq!(
        migrations::schema_version(&storage.conn).unwrap(),
        migrations::LATEST_VERSION
    );
    assert_eq!(storage.list_workspaces().unwrap(), workspaces);
    assert_eq!(workspaces, [local.clone(), remote.clone()]);
    assert_eq!(
        storage.get_workspace(remote.id).unwrap(),
        Some(remote.clone())
    );
    assert_eq!(storage.list_tasks(local.id).unwrap(), local_tasks);
    assert_eq!(storage.list_tasks(remote.id).unwrap(), remote_tasks);
    let mut expected_started = started.clone();
    expected_started.status = InProgress;
    expected_started.depends_on = [base.id].into();
    expected_started.timeline = local_tasks[1].timeline.clone();
    assert_eq!(
        expected_started
            .timeline
            .iter()
            .map(|event| event.status)
            .collect::<Vec<_>>(),
        [Planned, InProgress]
    );
    assert_eq!(
        storage.get_task(started.id).unwrap(),
        Some(expected_started)
    );
    assert_eq!(status(&storage, &base), Done);
    assert_eq!(remote_tasks, [remote_task]);
    assert_eq!(storage.list_commit_records(started.id).unwrap(), commits);
}

#[test]
fn workspace_updates_archive_restore_and_purge() {
    let mut storage = Storage::open_in_memory().unwrap();
    let mut workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let kept = add_workspace(&mut storage, "Kept", local_location(r"C:\src\kept"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    let kept_task = add_task(&mut storage, &kept, "Kept");
    storage.add_dependency(b.id, a.id).unwrap();
    storage
        .seed_commit_records(a.id, &[commit(a.id, "aaa", 1)])
        .unwrap();

    workspace.name = "Renamed".to_owned();
    workspace.description = Some("Workspace notes".to_owned());
    workspace.repository = Some("discord:work".to_owned());
    storage.update_workspace(&workspace).unwrap();
    assert_eq!(
        storage.get_workspace(workspace.id).unwrap(),
        Some(workspace.clone())
    );

    assert!(matches!(
        storage.purge_workspace(workspace.id),
        Err(StorageError::WorkspaceNotArchived(id)) if id == workspace.id
    ));
    storage.set_clock(|| 100);
    storage.archive_workspace(workspace.id).unwrap();
    assert_eq!(storage.get_workspace(workspace.id).unwrap(), None);
    assert_eq!(
        storage.list_workspaces().unwrap(),
        std::slice::from_ref(&kept)
    );
    assert_eq!(
        storage.archived_workspaces().unwrap(),
        [Workspace {
            archived_at: Some(100),
            ..workspace.clone()
        }]
    );
    assert_eq!(storage.get_task(a.id).unwrap(), None);
    assert_eq!(
        storage.list_all_tasks().unwrap(),
        std::slice::from_ref(&kept_task)
    );
    // The tasks of an archived workspace are archived with it, not on their own.
    assert_eq!(storage.archived_tasks().unwrap(), []);
    let reviewed: Vec<_> = storage
        .review_tasks()
        .unwrap()
        .into_iter()
        .map(|task| task.id)
        .collect();
    assert_eq!(reviewed, [a.id, b.id, kept_task.id]);
    assert_eq!(row_count(&storage, "task_dependencies"), 1);
    assert_eq!(row_count(&storage, "commit_records"), 1);
    assert!(matches!(
        storage.restore_task(a.id),
        Err(StorageError::WorkspaceArchived { workspace: id, task }) if id == workspace.id && task == a.id
    ));

    assert!(matches!(
        storage.archive_workspace(workspace.id),
        Err(StorageError::WorkspaceNotFound(id)) if id == workspace.id
    ));
    assert!(matches!(
        storage.update_workspace(&workspace),
        Err(StorageError::WorkspaceNotFound(_))
    ));
    assert!(matches!(
        storage.create_task(&NewTask {
            workspace_id: workspace.id,
            task_type: TaskType::Docs,
            title: "Orphan".to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            autopilot: false,
            criteria: Vec::new(),
        }),
        Err(StorageError::WorkspaceNotFound(_))
    ));

    assert_eq!(
        storage.restore_workspace(workspace.id).unwrap(),
        workspace.clone()
    );
    assert_eq!(
        storage.get_task(b.id).unwrap().unwrap().depends_on,
        [a.id].into()
    );
    storage.archive_workspace(workspace.id).unwrap();
    storage.purge_workspace(workspace.id).unwrap();
    assert_eq!(
        storage.review_tasks().unwrap(),
        std::slice::from_ref(&kept_task)
    );
    assert_eq!(row_count(&storage, "task_dependencies"), 0);
    assert_eq!(row_count(&storage, "commit_records"), 0);
    assert_eq!(storage.list_tasks(kept.id).unwrap(), [kept_task]);
    assert!(matches!(
        storage.purge_workspace(workspace.id),
        Err(StorageError::WorkspaceNotFound(id)) if id == workspace.id
    ));
}

#[test]
fn archived_tasks_leave_the_dag_until_restored_and_purge_explicitly() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    storage.add_dependency(b.id, a.id).unwrap();
    assert!(!ready(&storage, &b));

    assert!(matches!(
        storage.purge_task(a.id),
        Err(StorageError::TaskNotArchived(id)) if id == a.id
    ));
    storage.archive_task(a.id).unwrap();
    assert_eq!(storage.get_task(a.id).unwrap(), None);
    assert!(
        storage
            .get_task(b.id)
            .unwrap()
            .unwrap()
            .depends_on
            .is_empty()
    );
    assert!(ready(&storage, &b));
    let archived: Vec<_> = storage
        .archived_tasks()
        .unwrap()
        .into_iter()
        .map(|task| task.id)
        .collect();
    assert_eq!(archived, [a.id]);
    assert!(matches!(
        storage.add_dependency(b.id, a.id),
        Err(StorageError::Dependency(DependencyError::UnknownTask(id))) if id == a.id
    ));

    // An edge added while A was archived would close a loop once A is back.
    let c = add_task(&mut storage, &workspace, "C");
    storage.add_dependency(c.id, b.id).unwrap();
    storage
        .conn
        .execute(
            "INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?1, ?2)",
            [a.id.0, c.id.0],
        )
        .unwrap();
    assert!(matches!(
        storage.restore_task(a.id),
        Err(StorageError::RestoreClosesCycle(_))
    ));
    assert_eq!(storage.get_task(a.id).unwrap(), None);
    storage.remove_dependency(c.id, b.id).unwrap();

    let restored = storage.restore_task(a.id).unwrap();
    assert_eq!(restored.id, a.id);
    assert_eq!(
        storage.get_task(b.id).unwrap().unwrap().depends_on,
        [a.id].into()
    );
    assert!(matches!(
        storage.restore_task(a.id),
        Err(StorageError::TaskNotArchived(id)) if id == a.id
    ));

    storage.archive_task(a.id).unwrap();
    storage.purge_task(a.id).unwrap();
    assert!(matches!(
        storage.purge_task(a.id),
        Err(StorageError::TaskNotFound(id)) if id == a.id
    ));
    assert_eq!(row_count(&storage, "task_dependencies"), 0);
}

#[test]
fn archive_done_tasks_archives_only_the_live_done_tasks_of_the_workspace() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let other = add_workspace(&mut storage, "Other", local_location(r"C:\src\other"));
    let planned = add_task(&mut storage, &workspace, "Planned");
    let first = add_task(&mut storage, &workspace, "First");
    let second = add_task(&mut storage, &workspace, "Second");
    let elsewhere = add_task(&mut storage, &other, "Elsewhere");
    for task in [&first, &second, &elsewhere] {
        storage
            .set_task_status(task.id, TaskStatus::InProgress)
            .unwrap();
        storage.conclude_task(task.id, "Not needed", None).unwrap();
    }

    assert_eq!(
        storage.archive_done_tasks(workspace.id).unwrap(),
        [first.id, second.id]
    );
    assert_eq!(storage.get_task(first.id).unwrap(), None);
    assert_eq!(storage.get_task(second.id).unwrap(), None);
    assert!(storage.get_task(planned.id).unwrap().is_some());
    assert!(storage.get_task(elsewhere.id).unwrap().is_some());
    assert!(storage.archive_done_tasks(workspace.id).unwrap().is_empty());

    let unknown = WorkspaceId(workspace.id.0 + 100);
    assert!(matches!(
        storage.archive_done_tasks(unknown),
        Err(StorageError::WorkspaceNotFound(id)) if id == unknown
    ));
}

#[test]
fn move_task_changes_only_the_workspace_and_rejects_archived_ones() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let general = add_workspace(&mut storage, "General", local_location(r"C:\src\general"));
    let archived = add_workspace(&mut storage, "Old", local_location(r"C:\src\old"));
    let prerequisite = add_task(&mut storage, &workspace, "Prerequisite");
    let task = add_task(&mut storage, &workspace, "Move me");
    storage.add_dependency(task.id, prerequisite.id).unwrap();
    storage
        .set_task_refs(task.id, &["lane:move".to_owned()])
        .unwrap();
    let before = storage.get_task(task.id).unwrap().unwrap();
    storage.archive_workspace(archived.id).unwrap();

    let moved = storage.move_task(task.id, general.id).unwrap();
    assert_eq!(moved.workspace_id, general.id);
    assert_eq!(
        moved,
        Task {
            workspace_id: general.id,
            ..before.clone()
        }
    );
    assert_eq!(
        storage.list_tasks(general.id).unwrap(),
        std::slice::from_ref(&moved)
    );

    assert!(matches!(
        storage.move_task(task.id, archived.id),
        Err(StorageError::WorkspaceNotFound(id)) if id == archived.id
    ));
    let unknown = WorkspaceId(archived.id.0 + 100);
    assert!(matches!(
        storage.move_task(task.id, unknown),
        Err(StorageError::WorkspaceNotFound(id)) if id == unknown
    ));
    assert_eq!(storage.get_task(task.id).unwrap().unwrap(), moved);
}

#[test]
fn rejected_dependencies_write_nothing() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    let c = add_task(&mut storage, &workspace, "C");
    storage.add_dependency(b.id, a.id).unwrap();
    storage.add_dependency(c.id, b.id).unwrap();
    let before = storage.list_tasks(workspace.id).unwrap();

    let rejected = [
        (
            a.id,
            c.id,
            DependencyError::Cycle(vec![a.id, c.id, b.id, a.id]),
        ),
        (a.id, a.id, DependencyError::SelfDependency(a.id)),
        (a.id, TaskId(999), DependencyError::UnknownTask(TaskId(999))),
        (TaskId(999), a.id, DependencyError::UnknownTask(TaskId(999))),
    ];
    for (task, depends_on, expected) in rejected {
        match storage.add_dependency(task, depends_on) {
            Err(StorageError::Dependency(error)) => assert_eq!(error, expected),
            other => panic!("{task} -> {depends_on}: expected {expected:?}, got {other:?}"),
        }
    }
    assert_eq!(storage.list_tasks(workspace.id).unwrap(), before);
    assert_eq!(row_count(&storage, "task_dependencies"), 2);
}

#[test]
fn dependencies_across_workspaces_share_one_dag() {
    let mut storage = Storage::open_in_memory().unwrap();
    let library = add_workspace(&mut storage, "Library", local_location(r"C:\src\lib"));
    let app = add_workspace(&mut storage, "App", local_location(r"C:\src\app"));
    let api = add_task(&mut storage, &library, "Add low level API");
    let ui = add_task(&mut storage, &app, "Build UI on the API");
    let docs = add_task(&mut storage, &library, "Document the UI");

    storage.add_dependency(ui.id, api.id).unwrap();
    assert!(!ready(&storage, &ui));
    assert_eq!(storage.list_all_tasks().unwrap().len(), 3);
    assert_eq!(
        storage.get_task(ui.id).unwrap().unwrap().depends_on,
        [api.id].into()
    );

    // A loop through two workspaces is a cycle like any other.
    storage.add_dependency(docs.id, ui.id).unwrap();
    match storage.add_dependency(api.id, docs.id) {
        Err(StorageError::Dependency(error)) => assert_eq!(
            error,
            DependencyError::Cycle(vec![api.id, docs.id, ui.id, api.id])
        ),
        other => panic!("expected a cycle, got {other:?}"),
    }

    // The library workspace cannot go while the app task still waits on it.
    let tasks_before = storage.list_all_tasks().unwrap();
    assert!(matches!(
        storage.archive_workspace(library.id),
        Err(StorageError::WorkspaceHasDependents { workspace, task, depends_on })
            if workspace == library.id && task == ui.id && depends_on == api.id
    ));
    assert_eq!(storage.list_all_tasks().unwrap(), tasks_before);
    assert_eq!(row_count(&storage, "task_dependencies"), 2);

    // Finishing the library task releases the app task.
    storage.set_task_status(api.id, InProgress).unwrap();
    storage.set_task_status(api.id, InReview).unwrap();
    assert!(!ready(&storage, &ui));
    assert_eq!(
        storage.complete_task(api.id, None, &[]).unwrap().status,
        Done
    );
    assert!(ready(&storage, &ui));

    // Once the dependent has started, removing the library drops the edge only.
    storage.set_task_status(ui.id, InProgress).unwrap();
    storage.archive_workspace(library.id).unwrap();
    assert_eq!(storage.get_task(api.id).unwrap(), None);
    let ui = storage.get_task(ui.id).unwrap().unwrap();
    assert_eq!(ui.status, InProgress);
    assert!(ui.depends_on.is_empty());
}

#[test]
fn dependency_changes_decide_whether_a_task_can_start() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    assert_eq!(status(&storage, &b), Planned);
    assert!(ready(&storage, &b));

    storage.add_dependency(b.id, a.id).unwrap();
    storage.add_dependency(b.id, a.id).unwrap();
    assert!(!ready(&storage, &b));
    assert_eq!(status(&storage, &b), Planned);

    storage.remove_dependency(b.id, a.id).unwrap();
    assert!(ready(&storage, &b));
    assert!(
        storage
            .get_task(b.id)
            .unwrap()
            .unwrap()
            .depends_on
            .is_empty()
    );
    assert_eq!(timeline(&storage, &b).len(), 1);
}

#[test]
fn status_changes_follow_transitions_and_wait_for_dependencies() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    let c = add_task(&mut storage, &workspace, "C");
    storage.add_dependency(b.id, a.id).unwrap();
    storage.add_dependency(c.id, a.id).unwrap();
    storage.add_dependency(c.id, b.id).unwrap();

    assert!(matches!(
        storage.set_task_status(b.id, InProgress),
        Err(StorageError::DependenciesNotDone { task, .. }) if task == b.id
    ));
    assert!(matches!(
        storage.set_task_status(a.id, Planned),
        Err(StorageError::Transition(error)) if error.from == Planned && error.to == Planned
    ));
    assert!(matches!(
        storage.set_task_status(TaskId(999), Done),
        Err(StorageError::TaskNotFound(TaskId(999)))
    ));
    assert_eq!(status(&storage, &b), Planned);

    assert_eq!(
        storage.set_task_status(a.id, InProgress).unwrap().status,
        InProgress
    );
    assert!(matches!(
        storage.set_task_status(a.id, Done),
        Err(StorageError::Transition(error)) if error.from == InProgress && error.to == Done
    ));
    storage.set_task_status(a.id, InReview).unwrap();
    assert!(!ready(&storage, &b));
    storage.set_task_status(a.id, Done).unwrap();
    assert!(ready(&storage, &b));
    assert!(!ready(&storage, &c));
    storage.set_task_status(b.id, InProgress).unwrap();
    assert_eq!(
        storage.set_task_status(b.id, Planned).unwrap().status,
        Planned
    );
    assert!(!ready(&storage, &c));
    assert!(matches!(
        storage.set_task_status(b.id, Done),
        Err(StorageError::Transition(_))
    ));
}

#[test]
fn a_paused_task_keeps_its_work_and_starts_again_once_its_dependencies_are_done() {
    let (mut storage, now) = clocked_storage(100);
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");

    set_now(&now, 200);
    storage.set_task_status(a.id, InProgress).unwrap();
    let started = storage.get_task(a.id).unwrap().unwrap();
    storage
        .set_task_refs(started.id, &["branch:feat/a-1".to_owned()])
        .unwrap();
    storage.update_task(&started).unwrap();
    set_now(&now, 300);
    let paused = storage.set_task_status(a.id, Planned).unwrap();
    assert_eq!(paused.status, Planned);
    assert_eq!(paused.refs, ["branch:feat/a-1"]);

    set_now(&now, 400);
    storage.add_dependency(a.id, b.id).unwrap();
    assert!(matches!(
        storage.set_task_status(a.id, InProgress),
        Err(StorageError::DependenciesNotDone { .. })
    ));
    storage.remove_dependency(a.id, b.id).unwrap();
    set_now(&now, 500);
    storage.set_task_status(a.id, InProgress).unwrap();
    assert_eq!(
        timeline(&storage, &a),
        [
            (Planned, 100),
            (InProgress, 200),
            (Planned, 300),
            (InProgress, 500)
        ]
    );
}

#[test]
fn a_prerequisite_that_is_not_done_pauses_a_task_in_progress() {
    let (mut storage, now) = clocked_storage(100);
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let fix = add_task(&mut storage, &workspace, "Fix");
    let docs = add_task(&mut storage, &workspace, "Docs");
    set_now(&now, 200);
    storage.set_task_status(a.id, InProgress).unwrap();
    let started = storage.get_task(a.id).unwrap().unwrap();
    storage
        .set_task_refs(started.id, &["branch:feat/a-1".to_owned()])
        .unwrap();
    storage.update_task(&started).unwrap();

    set_now(&now, 300);
    let added = storage.add_dependencies(a.id, &[fix.id, docs.id]).unwrap();

    assert!(added.paused);
    assert_eq!(added.task.status, Planned);
    assert_eq!(added.task.depends_on, [fix.id, docs.id].into());
    assert_eq!(added.task.refs, ["branch:feat/a-1"]);
    assert_eq!(
        timeline(&storage, &a),
        [(Planned, 100), (InProgress, 200), (Planned, 300)]
    );
    // The pause event records what the task waits on.
    assert_eq!(
        added.task.timeline.last().unwrap().reason,
        Some(format!(
            "Waiting on #{} Fix (planned), #{} Docs (planned)",
            fix.id, docs.id
        ))
    );
    // The pause records what it waits on, at the time of the pause.
    let note = added.task.notes.last().unwrap();
    assert_eq!(note.kind, NoteKind::Blocker);
    assert_eq!(note.at, 300);
    assert_eq!(
        note.body,
        format!(
            "Paused: waiting on #{} Fix (planned), #{} Docs (planned)",
            fix.id, docs.id
        )
    );
}

#[test]
fn asking_before_a_pause_adds_nothing_that_would_pause_the_task() {
    use super::{DependencyChange, PauseRule};
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let fix = add_task(&mut storage, &workspace, "Fix");
    let b = add_task(&mut storage, &workspace, "B");
    storage.set_task_status(a.id, InProgress).unwrap();

    assert_eq!(
        storage
            .add_dependencies_with(a.id, &[fix.id], PauseRule::Ask)
            .unwrap(),
        DependencyChange::NeedsPause
    );
    let a_now = storage.get_task(a.id).unwrap().unwrap();
    assert_eq!(a_now.status, InProgress);
    assert!(a_now.depends_on.is_empty());
    assert!(a_now.notes.is_empty());

    // A task that the prerequisite does not pause gets it right away.
    assert!(matches!(
        storage.add_dependencies_with(b.id, &[fix.id], PauseRule::Ask).unwrap(),
        DependencyChange::Added(added)
            if !added.paused && added.task.depends_on == std::collections::BTreeSet::from([fix.id])
    ));
}

#[test]
fn a_done_task_cannot_wait_on_new_prerequisites() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let base = add_task(&mut storage, &workspace, "Base");
    let fix = add_task(&mut storage, &workspace, "Fix");
    for status in [InProgress, InReview] {
        storage.set_task_status(a.id, status).unwrap();
    }
    // A task in review still gets prerequisites, as in the app.
    storage.add_dependency(a.id, base.id).unwrap();
    storage.set_task_status(a.id, Done).unwrap();

    assert!(matches!(
        storage.add_dependency(a.id, fix.id),
        Err(StorageError::PrerequisiteOfDoneTask { task, .. }) if task == a.id
    ));
    assert!(matches!(
        storage.remove_dependency(a.id, base.id),
        Err(StorageError::DependencyOfDoneTask { task, depends_on }) if task == a.id && depends_on == base.id
    ));
    assert_eq!(
        storage.get_task(a.id).unwrap().unwrap().depends_on,
        std::collections::BTreeSet::from([base.id])
    );
}

#[test]
fn removing_a_dependency_or_link_that_does_not_exist_is_rejected() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");

    assert!(matches!(
        storage.remove_dependency(a.id, b.id),
        Err(StorageError::DependencyNotFound { task, depends_on }) if task == a.id && depends_on == b.id
    ));
    assert!(matches!(
        storage.remove_related(a.id, b.id),
        Err(StorageError::RelationNotFound { task, related }) if task == a.id && related == b.id
    ));
}

#[test]
fn a_done_prerequisite_or_a_task_in_review_is_not_paused() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let base = add_task(&mut storage, &workspace, "Base");
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    let fix = add_task(&mut storage, &workspace, "Fix");
    for task in [&base, &a, &b] {
        storage.set_task_status(task.id, InProgress).unwrap();
    }
    storage.set_task_status(base.id, InReview).unwrap();
    storage.set_task_status(base.id, Done).unwrap();
    storage.set_task_status(b.id, InReview).unwrap();

    let added = storage.add_dependencies(a.id, &[base.id]).unwrap();
    assert!(!added.paused);
    assert_eq!(added.task.status, InProgress);
    let added = storage.add_dependencies(b.id, &[fix.id]).unwrap();
    assert!(!added.paused);
    assert_eq!(added.task.status, InReview);
}

#[test]
fn one_rejected_prerequisite_adds_none_and_keeps_the_task_in_progress() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let fix = add_task(&mut storage, &workspace, "Fix");
    let follow_up = add_task(&mut storage, &workspace, "Follow-up");
    storage.add_dependency(follow_up.id, a.id).unwrap();
    storage.set_task_status(a.id, InProgress).unwrap();

    assert!(matches!(
        storage.add_dependencies(a.id, &[fix.id, follow_up.id]),
        Err(StorageError::Dependency(dag::DependencyError::Cycle(_)))
    ));
    let a = storage.get_task(a.id).unwrap().unwrap();
    assert_eq!(a.status, InProgress);
    assert!(a.depends_on.is_empty());
}

#[test]
fn deleting_a_task_releases_its_dependents() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    storage.add_dependency(b.id, a.id).unwrap();
    storage
        .seed_commit_records(a.id, &[commit(a.id, "aaa", 1)])
        .unwrap();

    storage.delete_task(a.id).unwrap();
    assert!(ready(&storage, &b));
    assert_eq!(storage.get_task(a.id).unwrap(), None);
    assert!(
        storage
            .get_task(b.id)
            .unwrap()
            .unwrap()
            .depends_on
            .is_empty()
    );
    assert_eq!(row_count(&storage, "commit_records"), 0);
    assert!(matches!(
        storage.delete_task(a.id),
        Err(StorageError::TaskNotFound(_))
    ));
}

#[test]
fn task_ids_are_not_reused_after_deletion() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let first = add_task(&mut storage, &workspace, "First");
    storage.delete_task(first.id).unwrap();
    let second = add_task(&mut storage, &workspace, "Second");
    assert!(second.id > first.id);
}

#[test]
fn corrupt_stored_values_are_reported_as_errors() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", "repo".to_owned());
    let task = add_task(&mut storage, &workspace, "A");
    storage
        .conn
        .execute("UPDATE tasks SET refs = '[123]' WHERE id = ?1", [task.id.0])
        .unwrap();
    assert!(
        matches!(storage.get_task(task.id), Err(StorageError::InvalidData(message)) if message.contains("refs"))
    );
}

#[test]
fn databases_from_a_newer_version_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("toodo.sqlite3");
    drop(Storage::open(&path).unwrap());
    rusqlite::Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", migrations::LATEST_VERSION + 1)
        .unwrap();
    assert!(matches!(
        Storage::open(&path),
        Err(StorageError::UnsupportedSchemaVersion { found, supported })
            if found == migrations::LATEST_VERSION + 1 && supported == migrations::LATEST_VERSION
    ));
}

#[test]
fn commit_records_in_a_period_span_every_task_oldest_first() {
    let mut storage = Storage::open_in_memory().unwrap();
    let toodo = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let server = add_workspace(&mut storage, "Server", ssh_location("devbox", "/srv/app"));
    let a = add_task(&mut storage, &toodo, "A");
    let b = add_task(&mut storage, &server, "B");
    storage
        .seed_commit_records(
            a.id,
            &[commit(a.id, "a-end", 200), commit(a.id, "a-in", 150)],
        )
        .unwrap();
    storage
        .seed_commit_records(
            b.id,
            &[commit(b.id, "b-start", 100), commit(b.id, "b-before", 99)],
        )
        .unwrap();

    let period = crate::domain::review::Period::new(100, 200).unwrap();
    assert_eq!(
        storage.list_commit_records_in(period).unwrap(),
        [commit(b.id, "b-start", 100), commit(a.id, "a-in", 150)]
    );
}

#[test]
fn commits_in_a_period_include_historical_activity_without_duplicates() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let recorded = add_task(&mut storage, &workspace, "Recorded");
    let polled = add_task(&mut storage, &workspace, "Polled");
    storage
        .seed_commit_records(recorded.id, &[commit(recorded.id, "rec", 120)])
        .unwrap();
    for (task, sha, title, at) in [
        (recorded.id, "rec", "Recorded", 120),
        (polled.id, "new", "Fix login", 150),
        (polled.id, "old", "Before", 50),
    ] {
        storage.conn.execute("INSERT INTO task_activity (task_id, dedup_key, kind, source, external_ref, title, author, occurred_at, received_at, confirmed_at) VALUES (?1, ?2, 'commit', 'git_poll', ?2, ?3, ?4, ?5, 300, 300)", rusqlite::params![task.0, sha, title, format!("{title} author"), at]).unwrap();
    }
    let records = storage
        .list_commit_records_in(crate::domain::review::Period::new(100, 200).unwrap())
        .unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0], commit(recorded.id, "rec", 120));
    assert_eq!(records[1].sha, "new");
}

/// Storage whose clock reads `now`, so status changes get known timestamps.
fn clocked_storage(start: i64) -> (Storage, std::sync::Arc<std::sync::atomic::AtomicI64>) {
    let mut storage = Storage::open_in_memory().unwrap();
    let now = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(start));
    let clock = now.clone();
    storage.set_clock(move || clock.load(std::sync::atomic::Ordering::SeqCst));
    (storage, now)
}

fn set_now(now: &std::sync::atomic::AtomicI64, at: i64) {
    now.store(at, std::sync::atomic::Ordering::SeqCst);
}

fn timeline(storage: &Storage, task: &Task) -> Vec<(TaskStatus, i64)> {
    storage
        .get_task(task.id)
        .unwrap()
        .unwrap()
        .timeline
        .iter()
        .map(|event| (event.status, event.at))
        .collect()
}

#[test]
fn every_status_change_of_a_task_is_recorded_with_its_time() {
    let (mut storage, now) = clocked_storage(100);
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let task = add_task(&mut storage, &workspace, "Add login");
    assert_eq!(timeline(&storage, &task), [(Planned, 100)]);
    assert_eq!(storage.get_task(task.id).unwrap().unwrap(), task);

    set_now(&now, 200);
    storage.start_task(task.id, None, &[]).unwrap();
    set_now(&now, 300);
    storage.set_task_status(task.id, InReview).unwrap();
    set_now(&now, 350);
    let pushed_again = storage.get_task(task.id).unwrap().unwrap();
    assert_eq!(pushed_again.timeline.len(), 3);
    set_now(&now, 400);
    let done = storage.complete_task(task.id, None, &[]).unwrap();

    assert_eq!(
        timeline(&storage, &task),
        [
            (Planned, 100),
            (InProgress, 200),
            (InReview, 300),
            (Done, 400)
        ]
    );
    assert_eq!(done, storage.get_task(task.id).unwrap().unwrap());
    assert_eq!(
        crate::domain::timeline::milestones(&done.timeline),
        crate::domain::timeline::Milestones {
            planned_at: Some(100),
            started_at: Some(200),
            review_at: Some(300),
            completed_at: Some(400),
            reopened_at: None,
            paused_at: None,
            last_review_at: Some(300),
            active_seconds: 200,
            pause_count: 0,
        }
    );
}

#[test]
fn a_waiting_task_is_paused_until_its_time_then_returns_to_its_status() {
    let (mut storage, now) = clocked_storage(100);
    let workspace = add_workspace(&mut storage, "Toodo", local_location("/src/toodo"));
    let active = add_task(&mut storage, &workspace, "Active");
    let review = add_task(&mut storage, &workspace, "Review");
    let planned = add_task(&mut storage, &workspace, "Planned");
    storage.set_task_status(active.id, InProgress).unwrap();
    storage.set_task_status(review.id, InProgress).unwrap();
    storage.set_task_status(review.id, InReview).unwrap();
    let before = storage.last_status_change().unwrap();

    set_now(&now, 200);
    let waiting = storage.wait_task(active.id, 1_000, Some("Vendor")).unwrap();
    assert_eq!(waiting.status, Planned);
    assert_eq!(
        waiting.wait,
        Some(TaskWait {
            until: 1_000,
            status: InProgress
        })
    );
    storage.wait_task(review.id, 2_000, None).unwrap();
    storage.wait_task(planned.id, 500, None).unwrap();
    // Waiting again moves the time and keeps the status to return to.
    let moved = storage.wait_task(active.id, 600, None).unwrap();
    assert_eq!(
        moved.wait,
        Some(TaskWait {
            until: 600,
            status: InProgress
        })
    );
    let (changes, _) = storage.status_changes_after(before).unwrap();
    let pauses: Vec<_> = changes.iter().map(|c| (c.task, c.from, c.to)).collect();
    assert_eq!(
        pauses,
        [
            (active.id, Some(InProgress), Planned),
            (review.id, Some(InReview), Planned),
        ]
    );

    set_now(&now, 599);
    assert_eq!(storage.end_due_waits().unwrap(), [workspace.id]);
    assert_eq!(storage.get_task(planned.id).unwrap().unwrap().wait, None);
    assert_eq!(status(&storage, &planned), Planned);
    assert_eq!(status(&storage, &active), Planned);

    let paused = storage.last_status_change().unwrap();
    set_now(&now, 600);
    assert_eq!(storage.end_due_waits().unwrap(), [workspace.id]);
    let returned = storage.get_task(active.id).unwrap().unwrap();
    assert_eq!((returned.status, returned.wait), (InProgress, None));
    // Ending the wait early returns an in_review task to review.
    let ended = storage
        .end_task_wait(review.id, Some("Reply came"))
        .unwrap();
    assert_eq!((ended.status, ended.wait), (InReview, None));
    let (changes, _) = storage.status_changes_after(paused).unwrap();
    let returns: Vec<_> = changes
        .iter()
        .map(|c| (c.task, c.from, c.to, c.at))
        .collect();
    assert_eq!(
        returns,
        [
            (active.id, Some(Planned), InProgress, 600),
            (review.id, Some(Planned), InReview, 600),
        ]
    );
    assert!(storage.end_due_waits().unwrap().is_empty());
}

#[test]
fn a_status_change_ends_a_wait_and_a_new_prerequisite_keeps_it_paused() {
    let (mut storage, now) = clocked_storage(100);
    let workspace = add_workspace(&mut storage, "Toodo", local_location("/src/toodo"));
    let started = add_task(&mut storage, &workspace, "Started");
    let blocked = add_task(&mut storage, &workspace, "Blocked");
    let prerequisite = add_task(&mut storage, &workspace, "Prerequisite");
    storage.set_task_status(started.id, InProgress).unwrap();
    storage.set_task_status(blocked.id, InProgress).unwrap();
    storage.wait_task(started.id, 1_000, None).unwrap();
    storage.wait_task(blocked.id, 1_000, None).unwrap();

    // Resuming by hand takes the place of the return.
    storage.set_task_status(started.id, InProgress).unwrap();
    assert_eq!(storage.get_task(started.id).unwrap().unwrap().wait, None);
    assert!(storage.wait_task(prerequisite.id, 1_000, None).is_ok());
    storage
        .conclude_task(prerequisite.id, "Dropped", None)
        .unwrap();
    assert_eq!(
        storage.get_task(prerequisite.id).unwrap().unwrap().wait,
        None
    );
    assert!(matches!(
        storage.wait_task(prerequisite.id, 2_000, None),
        Err(StorageError::Transition(_))
    ));

    let other = add_task(&mut storage, &workspace, "Other");
    storage.add_dependency(blocked.id, other.id).unwrap();
    set_now(&now, 1_000);
    storage.end_due_waits().unwrap();
    let still = storage.get_task(blocked.id).unwrap().unwrap();
    assert_eq!((still.status, still.wait), (Planned, None));
    assert!(still.notes.iter().any(
        |note| note.kind == NoteKind::Blocker && note.body.contains(&format!("#{}", other.id))
    ));
}

#[test]
fn status_changes_after_a_record_name_both_statuses_and_the_tasks_made_ready() {
    let (mut storage, now) = clocked_storage(100);
    let workspace = add_workspace(&mut storage, "Toodo", local_location("/src/toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    let waits_on_a = add_task(&mut storage, &workspace, "Waits on A");
    let waits_on_both = add_task(&mut storage, &workspace, "Waits on A and B");
    storage.add_dependency(waits_on_a.id, a.id).unwrap();
    storage.add_dependency(waits_on_both.id, a.id).unwrap();
    storage.add_dependency(waits_on_both.id, b.id).unwrap();
    let created = storage.last_status_change().unwrap();
    let (changes, ready) = storage.status_changes_after(0).unwrap();
    assert_eq!(changes.len(), 4);
    assert_eq!(
        (changes[0].task, changes[0].from, changes[0].to),
        (a.id, None, Planned)
    );
    assert!(ready.is_empty());

    set_now(&now, 200);
    storage.set_task_status(a.id, InProgress).unwrap();
    storage.complete_task(a.id, None, &[]).unwrap();
    let (changes, ready) = storage.status_changes_after(created).unwrap();
    let moves: Vec<_> = changes
        .iter()
        .map(|change| {
            (
                change.task,
                change.workspace,
                change.from,
                change.to,
                change.at,
            )
        })
        .collect();
    assert_eq!(
        moves,
        [
            (a.id, workspace.id, Some(Planned), InProgress, 200),
            (a.id, workspace.id, Some(InProgress), Done, 200),
        ]
    );
    assert_eq!(
        ready,
        [ReadyTask {
            task: waits_on_a.id,
            workspace: workspace.id,
            unblocked_by: a.id,
            at: 200,
        }]
    );

    // A dependency concluded as not adopted keeps its dependents blocked.
    let completed = storage.last_status_change().unwrap();
    storage.conclude_task(b.id, "Not needed", None).unwrap();
    let (changes, ready) = storage.status_changes_after(completed).unwrap();
    assert_eq!((changes[0].task, changes[0].to), (b.id, Done));
    assert!(ready.is_empty());
    assert_eq!(
        storage
            .status_changes_after(storage.last_status_change().unwrap())
            .unwrap(),
        (Vec::new(), Vec::new())
    );
}

#[test]
fn only_status_changes_are_recorded_and_rejected_changes_record_nothing() {
    let (mut storage, now) = clocked_storage(100);
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");

    set_now(&now, 200);
    storage.add_dependency(b.id, a.id).unwrap();
    set_now(&now, 250);
    assert!(storage.add_dependency(a.id, b.id).is_err());
    assert!(storage.set_task_status(b.id, InProgress).is_err());
    assert!(storage.complete_task(a.id, None, &[]).is_err());
    assert!(storage.set_task_status(a.id, InReview).is_err());
    assert_eq!(timeline(&storage, &a), [(Planned, 100)]);
    assert_eq!(timeline(&storage, &b), [(Planned, 100)]);

    for (at, status) in [(300, InProgress), (400, InReview), (500, Done)] {
        set_now(&now, at);
        storage.set_task_status(a.id, status).unwrap();
    }
    set_now(&now, 600);
    storage.set_task_status(b.id, InProgress).unwrap();
    set_now(&now, 650);
    storage.set_task_status(b.id, Planned).unwrap();
    assert_eq!(
        timeline(&storage, &b),
        [(Planned, 100), (InProgress, 600), (Planned, 650)]
    );

    set_now(&now, 700);
    let c = add_task(&mut storage, &workspace, "C");
    let d = add_task(&mut storage, &workspace, "D");
    set_now(&now, 710);
    storage.add_dependency(c.id, d.id).unwrap();
    set_now(&now, 720);
    storage.remove_dependency(c.id, d.id).unwrap();
    assert_eq!(timeline(&storage, &c), [(Planned, 700)]);

    let events_before = row_count(&storage, "task_events");
    storage.delete_task(a.id).unwrap();
    assert_eq!(events_before - row_count(&storage, "task_events"), 4);
}

#[test]
fn a_linked_issue_is_stored_with_the_task_until_it_is_unlinked() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "toodo", local_location(r"C:\dev\toodo"));
    let task = add_task(&mut storage, &workspace, "Fix login");
    assert_eq!(task.issue, None);
    let issue = LinkedIssue {
        number: 12,
        url: "https://github.com/acme/toodo/issues/12".to_owned(),
    };

    let linked = storage.set_task_issue(task.id, Some(&issue)).unwrap();
    assert_eq!(linked.issue.as_ref(), Some(&issue));
    assert_eq!(storage.get_task(task.id).unwrap().unwrap(), linked);

    let unlinked = storage.set_task_issue(task.id, None).unwrap();
    assert_eq!(unlinked.issue, None);
    assert!(matches!(
        storage.set_task_issue(TaskId(999), Some(&issue)),
        Err(StorageError::TaskNotFound(TaskId(999)))
    ));
}

#[test]
fn notes_are_kept_in_order_with_their_time_and_deleted_with_their_task() {
    use crate::domain::model::{NoteKind, TaskNote};
    let (mut storage, now) = clocked_storage(100);
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let task = add_task(&mut storage, &workspace, "Login");
    let other = add_task(&mut storage, &workspace, "Logout");

    set_now(&now, 200);
    storage
        .add_task_note(task.id, NoteKind::Progress, "Chose PKCE")
        .unwrap();
    set_now(&now, 300);
    let noted = storage
        .add_task_note(task.id, NoteKind::Blocker, "No test account")
        .unwrap();

    let expected = vec![
        TaskNote {
            kind: NoteKind::Progress,
            body: "Chose PKCE".to_owned(),
            at: 200,
        },
        TaskNote {
            kind: NoteKind::Blocker,
            body: "No test account".to_owned(),
            at: 300,
        },
    ];
    assert_eq!(noted.notes, expected);
    assert_eq!(storage.list_all_tasks().unwrap()[0].notes, expected);
    assert!(
        storage
            .get_task(other.id)
            .unwrap()
            .unwrap()
            .notes
            .is_empty()
    );
    assert!(matches!(
        storage.add_task_note(TaskId(99), NoteKind::Progress, "x"),
        Err(StorageError::TaskNotFound(TaskId(99)))
    ));

    storage.delete_task(task.id).unwrap();
    assert_eq!(row_count(&storage, "task_notes"), 0);
}

#[test]
fn labels_are_replaced_per_task_and_deleted_with_their_task() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let task = add_task(&mut storage, &workspace, "Login");
    let other = add_task(&mut storage, &workspace, "Logout");

    let labels = ["auth".to_owned(), "q4".to_owned()];
    assert_eq!(
        storage.set_task_labels(task.id, &labels).unwrap().labels,
        labels
    );
    storage.set_task_labels(other.id, &labels[..1]).unwrap();
    let replaced = storage.set_task_labels(task.id, &labels[1..]).unwrap();
    assert_eq!(replaced.labels, ["q4"]);
    let all: Vec<_> = storage
        .list_all_tasks()
        .unwrap()
        .into_iter()
        .map(|task| task.labels)
        .collect();
    assert_eq!(all, [vec!["q4".to_owned()], vec!["auth".to_owned()]]);
    assert!(matches!(
        storage.set_task_labels(TaskId(99), &labels),
        Err(StorageError::TaskNotFound(TaskId(99)))
    ));

    storage.delete_task(task.id).unwrap();
    assert_eq!(row_count(&storage, "task_labels"), 1);
}

fn search(storage: &Storage, query: &str) -> Vec<TaskId> {
    storage
        .search_tasks(&TaskSearch {
            query,
            workspace: None,
            status: None,
            limit: 20,
        })
        .unwrap()
}

fn add_described(storage: &mut Storage, workspace: &Workspace, title: &str, text: &str) -> Task {
    let mut task = add_task(storage, workspace, title);
    task.description = text.to_owned();
    storage.update_task(&task).unwrap();
    task
}

#[test]
fn search_ranks_title_matches_first_and_filters_by_workspace_status_and_limit() {
    let mut storage = Storage::open_in_memory().unwrap();
    let toodo = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let other = add_workspace(&mut storage, "Other", local_location(r"C:\src\other"));
    let titled = add_described(&mut storage, &toodo, "Deploy the server", "Use systemd");
    let described = add_described(&mut storage, &other, "Write docs", "How to deploy it");
    add_described(&mut storage, &toodo, "Unrelated", "Nothing here");

    assert_eq!(search(&storage, "deploy"), [titled.id, described.id]);
    assert_eq!(search(&storage, "DEPLOY server"), [titled.id]);
    assert!(search(&storage, "deploy nothing").is_empty());
    assert!(search(&storage, "   ").is_empty());

    storage.set_task_status(described.id, InProgress).unwrap();
    let filtered = |workspace: Option<WorkspaceId>, status: Option<TaskStatus>, limit| {
        storage
            .search_tasks(&TaskSearch {
                query: "deploy",
                workspace,
                status,
                limit,
            })
            .unwrap()
    };
    assert_eq!(filtered(Some(other.id), None, 20), [described.id]);
    assert_eq!(filtered(None, Some(Planned), 20), [titled.id]);
    assert_eq!(filtered(None, None, 1), [titled.id]);
}

#[test]
fn search_matches_words_shorter_than_three_characters_with_like() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    // "Server deploy" in Korean, and "dry the laundry".
    let deploy = add_described(
        &mut storage,
        &workspace,
        "\u{c11c}\u{bc84} \u{bc30}\u{d3ec}",
        "",
    );
    let dry = add_described(
        &mut storage,
        &workspace,
        "Other",
        "\u{bc8c}\u{b798} \u{b9d0}\u{b9ac}\u{ae30}",
    );
    let ci = add_described(&mut storage, &workspace, "Speed up CI", "100% cached_build");

    assert_eq!(search(&storage, "\u{bc30}\u{d3ec}"), [deploy.id]);
    assert_eq!(search(&storage, "\u{b9d0}\u{b9ac}"), [dry.id]);
    assert_eq!(
        search(&storage, "\u{bc30}\u{d3ec} \u{c11c}\u{bc84}"),
        [deploy.id]
    );
    assert_eq!(search(&storage, "ci"), [ci.id]);
    assert_eq!(search(&storage, "CI speed"), [ci.id]);
    // Three characters or more use the trigram index, also in Korean.
    assert_eq!(search(&storage, "\u{b9d0}\u{b9ac}\u{ae30}"), [dry.id]);
    // LIKE wildcards are literal.
    assert_eq!(search(&storage, "%"), [ci.id]);
    assert_eq!(search(&storage, "d_"), [ci.id]);
    assert!(search(&storage, "_x").is_empty());
}

#[test]
fn search_takes_operators_quotes_and_wildcards_literally() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let quoted = add_described(
        &mut storage,
        &workspace,
        r#"Parse "quoted" (NOT* ready)"#,
        "",
    );
    let plain = add_described(&mut storage, &workspace, "Ready to go", "");

    for (query, found) in [
        (r#""quoted""#, vec![quoted.id]),
        ("(NOT*", vec![quoted.id]),
        ("ready)", vec![quoted.id]),
        (r#""quoted" NOT*"#, vec![quoted.id]),
        ("NOT", vec![quoted.id]),
        ("\"", vec![quoted.id]),
        ("*", vec![quoted.id]),
        ("AND", vec![]),
        ("OR", vec![]),
        ("NEAR(a b)", vec![]),
        ("title:ready", vec![]),
        ("^re", vec![]),
    ] {
        assert_eq!(search(&storage, query), found, "{query}");
    }
    let mut ready = search(&storage, "ready");
    ready.sort();
    assert_eq!(ready, [quoted.id, plain.id]);
}

#[test]
fn the_search_index_follows_edits_notes_refs_and_deletes() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let mut task = add_task(&mut storage, &workspace, "Add login");
    assert_eq!(search(&storage, "login"), [task.id]);
    task.title = "Add sign-in".into();
    task.description = "Replace passwords".into();
    storage.update_task(&task).unwrap();
    assert!(search(&storage, "login").is_empty());
    storage
        .add_task_note(task.id, NoteKind::Decision, "Use OAuth")
        .unwrap();
    storage.set_task_refs(task.id, &["pr:42".into()]).unwrap();
    assert_eq!(search(&storage, "oauth"), [task.id]);
    assert_eq!(search(&storage, "pr:42"), [task.id]);
    storage.delete_task(task.id).unwrap();
    assert!(search(&storage, "sign").is_empty());
}

#[test]
fn related_links_go_both_ways_across_workspaces_and_never_block() {
    let mut storage = Storage::open_in_memory().unwrap();
    let toodo = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let other = add_workspace(&mut storage, "Other", local_location(r"C:\src\other"));
    let earlier = add_task(&mut storage, &toodo, "Research search");
    let later = add_task(&mut storage, &other, "Add search");

    storage.add_related(later.id, earlier.id).unwrap();
    storage.add_related(earlier.id, later.id).unwrap();
    assert_eq!(storage.list_relations().unwrap(), [(earlier.id, later.id)]);
    // Unlike a dependency, the link does not wait for the planned task.
    assert!(ready(&storage, &later));
    storage.ensure_ready(later.id).unwrap();
    storage.set_task_status(later.id, InProgress).unwrap();

    assert!(matches!(
        storage.add_related(later.id, later.id),
        Err(StorageError::SelfRelation(id)) if id == later.id
    ));
    assert!(matches!(
        storage.add_related(later.id, TaskId(99)),
        Err(StorageError::TaskNotFound(TaskId(99)))
    ));

    storage.remove_related(later.id, earlier.id).unwrap();
    assert!(storage.list_relations().unwrap().is_empty());
    storage.add_related(later.id, earlier.id).unwrap();
    storage.archive_task(earlier.id).unwrap();
    assert!(storage.list_relations().unwrap().is_empty());
    storage.restore_task(earlier.id).unwrap();
    assert_eq!(storage.list_relations().unwrap(), [(earlier.id, later.id)]);
    storage.delete_task(earlier.id).unwrap();
    assert!(storage.list_relations().unwrap().is_empty());
}

#[test]
fn dependencies_not_done_names_each_blocker_and_its_next_step() {
    use crate::domain::dag::BlockingDependency;
    use crate::domain::model::TaskResolution;

    let error = StorageError::DependenciesNotDone {
        task: TaskId(2),
        blockers: vec![
            BlockingDependency {
                id: TaskId(1),
                status: Done,
                resolution: Some(TaskResolution::NotAdopted),
            },
            BlockingDependency {
                id: TaskId(7),
                status: Planned,
                resolution: None,
            },
        ],
    };
    assert_eq!(
        error.to_string(),
        "task 2 cannot start yet: #1 is done as not_adopted (remove_dependency task_id 2 depends_on 1 to unblock, or conclude_task id 1 with outcome shipped_with and shipped_with set to the completed task id); #7 is planned (wait for it); call complete_task for those prerequisite ids first"
    );
}

#[test]
fn the_database_file_uses_write_ahead_logging_and_a_busy_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(&dir.path().join("toodo.sqlite3")).unwrap();

    let mode: String = storage
        .conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    let timeout: u128 = storage
        .conn
        .pragma_query_value(None, "busy_timeout", |row| row.get::<_, i64>(0))
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(mode, "wal");
    assert_eq!(timeout, BUSY_TIMEOUT.as_millis());
}

#[test]
fn the_reader_reads_committed_data_while_a_write_is_in_progress() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("toodo.sqlite3");
    let mut storage = Storage::open(&path).unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let reader = Storage::open_reader(&path).unwrap();
    // Without write-ahead logging the exclusive lock below would make the read fail at
    // once with SQLITE_BUSY.
    reader.conn.busy_timeout(std::time::Duration::ZERO).unwrap();

    storage
        .conn
        .execute_batch("BEGIN EXCLUSIVE; UPDATE workspaces SET name = 'Renamed'")
        .unwrap();
    assert_eq!(
        reader.list_workspaces().unwrap(),
        std::slice::from_ref(&workspace)
    );
    storage.conn.execute_batch("COMMIT").unwrap();

    let renamed = reader.get_workspace(workspace.id).unwrap().unwrap();
    assert_eq!(renamed.name, "Renamed");
    assert!(reader.conn.execute("DELETE FROM workspaces", []).is_err());
}

#[test]
fn query_tasks_filters_and_pages_back_from_the_newest() {
    let mut storage = Storage::open_in_memory().unwrap();
    let local = add_workspace(&mut storage, "local", local_location(r"C:\dev\local"));
    let remote = add_workspace(&mut storage, "remote", ssh_location("box", "/srv/remote"));
    let [a, b, c, d, e] = ["A", "B", "C", "D", "E"].map(|title| {
        let workspace = if title == "B" || title == "D" {
            &remote
        } else {
            &local
        };
        add_task(&mut storage, workspace, title).id
    });
    for done in [a, b, c] {
        storage
            .conn
            .execute(
                "UPDATE tasks SET status = 'done', resolution = 'completed' WHERE id = ?1",
                [done.0],
            )
            .unwrap();
    }
    let ids = |query: TaskQuery| -> Vec<TaskId> {
        storage
            .query_tasks(&query)
            .unwrap()
            .into_iter()
            .map(|task| task.id)
            .collect()
    };
    assert_eq!(ids(TaskQuery::default()), [a, b, c, d, e]);
    let done = |before| TaskQuery {
        statuses: vec![Done],
        before,
        limit: Some(2),
        ..TaskQuery::default()
    };
    assert_eq!(ids(done(None)), [b, c]);
    assert_eq!(ids(done(Some(b))), [a]);
    let local_planned = TaskQuery {
        workspace: Some(local.id),
        statuses: vec![Planned, InProgress],
        ..TaskQuery::default()
    };
    assert_eq!(ids(local_planned), [e]);
    let listed = |list: Vec<TaskId>| TaskQuery {
        ids: Some(list),
        ..TaskQuery::default()
    };
    assert_eq!(ids(listed(vec![d, a])), [a, d]);
    assert_eq!(ids(listed(Vec::new())), Vec::<TaskId>::new());
    // A limited page loads the same details as reading each task.
    let page = storage
        .query_tasks(&TaskQuery {
            before: Some(e),
            limit: Some(2),
            ..TaskQuery::default()
        })
        .unwrap();
    let each = [c, d].map(|id| storage.get_task(id).unwrap().unwrap());
    assert_eq!(page, each);
}
