use super::*;
use crate::domain::dag;
use crate::domain::model::{
    AgentMerge, CommitRecord, HostPath, LinkedIssue, Machine, MachineLabel, MachineSettings,
    NoteKind, PullRequestSnapshot, Task, TaskType, Workspace, WorkspaceLocation,
};
use crate::domain::path::{PosixPath, WindowsPath};
use crate::domain::status::TaskStatus;
use TaskStatus::*;

fn local_location(path: &str) -> WorkspaceLocation {
    WorkspaceLocation::Local {
        path: WindowsPath::parse(path).unwrap().into(),
    }
}

fn ssh_location(machine: &str, path: &str) -> WorkspaceLocation {
    WorkspaceLocation::Ssh {
        machine: MachineLabel::parse(machine).unwrap(),
        path: HostPath::parse(path).unwrap(),
    }
}

fn add_workspace(storage: &mut Storage, name: &str, location: WorkspaceLocation) -> Workspace {
    storage
        .create_workspace(&NewWorkspace {
            name: name.to_owned(),
            location,
            default_base_branch: "main".to_owned(),
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
    let local_settings = MachineSettings::Local {
        worktree_root: Some(WindowsPath::parse(r"D:\worktrees").unwrap().into()),
    };
    let ssh_settings = MachineSettings::Ssh {
        machine: MachineLabel::parse("devbox").unwrap(),
        worktree_root: Some(PosixPath::parse("/srv/wt").unwrap().into()),
    };
    storage.save_machine_settings(&local_settings).unwrap();
    storage.save_machine_settings(&ssh_settings).unwrap();

    let base = add_task(&mut storage, &local, "Base");
    let mut started = add_task(&mut storage, &local, "Login page");
    let remote_task = add_task(&mut storage, &remote, "Remote fix");
    storage.add_dependency(started.id, base.id).unwrap();
    for status in [InProgress, InReview, Done] {
        storage.set_task_status(base.id, status).unwrap();
    }
    storage.set_task_status(started.id, InProgress).unwrap();
    started.task_type = TaskType::Fix;
    started.branch = Some(format!("fix/login-page-{}", started.id));
    started.worktree_path = Some(HostPath::Windows(
        WindowsPath::parse(r"D:\worktrees\toodo\fix-login-page-2").unwrap(),
    ));
    started.herdr_workspace_id = Some("w-123".to_owned());
    started.pull_request_url = Some("https://github.com/me/toodo/pull/1".to_owned());
    storage.update_task(&started).unwrap();
    let commits = vec![commit(started.id, "bbb", 20), commit(started.id, "aaa", 10)];
    storage
        .replace_commit_records(started.id, &commits)
        .unwrap();

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
    assert_eq!(
        storage.get_machine_settings(&Machine::Local).unwrap(),
        local_settings
    );
    assert_eq!(
        storage
            .get_machine_settings(&ssh_settings.machine())
            .unwrap(),
        ssh_settings
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
fn machines_without_saved_settings_have_no_worktree_root() {
    let mut storage = Storage::open_in_memory().unwrap();
    assert_eq!(
        storage.get_machine_settings(&Machine::Local).unwrap(),
        MachineSettings::Local {
            worktree_root: None
        }
    );
    let label = MachineLabel::parse("devbox").unwrap();
    let cleared = MachineSettings::Ssh {
        machine: label.clone(),
        worktree_root: None,
    };
    storage
        .save_machine_settings(&MachineSettings::Ssh {
            machine: label.clone(),
            worktree_root: Some(PosixPath::parse("/wt").unwrap().into()),
        })
        .unwrap();
    storage.save_machine_settings(&cleared).unwrap();
    assert_eq!(
        storage.get_machine_settings(&Machine::Ssh(label)).unwrap(),
        cleared
    );
    assert_eq!(row_count(&storage, "machine_settings"), 1);
}

#[test]
fn workspace_updates_and_cascading_deletes() {
    let mut storage = Storage::open_in_memory().unwrap();
    let mut workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let kept = add_workspace(&mut storage, "Kept", local_location(r"C:\src\kept"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    let kept_task = add_task(&mut storage, &kept, "Kept");
    storage.add_dependency(b.id, a.id).unwrap();
    storage
        .replace_commit_records(a.id, &[commit(a.id, "aaa", 1)])
        .unwrap();

    workspace.name = "Renamed".to_owned();
    workspace.location = ssh_location("devbox", "/home/me/toodo");
    workspace.default_base_branch = "develop".to_owned();
    // Agents never merge unless the workspace allows it.
    assert_eq!(workspace.agent_merge, AgentMerge::Never);
    workspace.agent_merge = AgentMerge::AfterChecks;
    storage.update_workspace(&workspace).unwrap();
    assert_eq!(
        storage.get_workspace(workspace.id).unwrap(),
        Some(workspace.clone())
    );

    storage.delete_workspace(workspace.id).unwrap();
    assert_eq!(storage.get_workspace(workspace.id).unwrap(), None);
    assert_eq!(storage.get_task(a.id).unwrap(), None);
    assert_eq!(row_count(&storage, "task_dependencies"), 0);
    assert_eq!(row_count(&storage, "commit_records"), 0);
    assert_eq!(storage.list_tasks(kept.id).unwrap(), [kept_task]);

    assert!(matches!(
        storage.delete_workspace(workspace.id),
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
            criteria: Vec::new(),
        }),
        Err(StorageError::WorkspaceNotFound(_))
    ));
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
        storage.delete_workspace(library.id),
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
        storage
            .complete_task(api.id, Some(1), None, &[])
            .unwrap()
            .status,
        Done
    );
    assert!(ready(&storage, &ui));

    // Once the dependent has started, removing the library drops the edge only.
    storage.set_task_status(ui.id, InProgress).unwrap();
    storage.delete_workspace(library.id).unwrap();
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
    let mut started = storage.get_task(a.id).unwrap().unwrap();
    started.branch = Some("feat/a-1".to_owned());
    started.herdr_workspace_id = Some("w1".to_owned());
    storage.update_task(&started).unwrap();
    set_now(&now, 300);
    let paused = storage.set_task_status(a.id, Planned).unwrap();
    assert_eq!(paused.status, Planned);
    assert_eq!(paused.branch.as_deref(), Some("feat/a-1"));
    assert_eq!(paused.herdr_workspace_id.as_deref(), Some("w1"));

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
    let mut started = storage.get_task(a.id).unwrap().unwrap();
    started.branch = Some("feat/a-1".to_owned());
    started.herdr_workspace_id = Some("w1".to_owned());
    storage.update_task(&started).unwrap();

    set_now(&now, 300);
    let added = storage.add_dependencies(a.id, &[fix.id, docs.id]).unwrap();

    assert!(added.paused);
    assert_eq!(added.task.status, Planned);
    assert_eq!(added.task.depends_on, [fix.id, docs.id].into());
    assert_eq!(added.task.branch.as_deref(), Some("feat/a-1"));
    assert_eq!(added.task.herdr_workspace_id.as_deref(), Some("w1"));
    assert_eq!(
        timeline(&storage, &a),
        [(Planned, 100), (InProgress, 200), (Planned, 300)]
    );
    let cleared = storage.clear_task_herdr_workspace(a.id).unwrap();
    assert_eq!(cleared.herdr_workspace_id, None);
    assert_eq!(cleared.branch.as_deref(), Some("feat/a-1"));
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
    let fix = add_task(&mut storage, &workspace, "Fix");
    for status in [InProgress, InReview, Done] {
        storage.set_task_status(a.id, status).unwrap();
    }

    assert!(matches!(
        storage.add_dependency(a.id, fix.id),
        Err(StorageError::PrerequisiteOfDoneTask { task, .. }) if task == a.id
    ));
    assert!(
        storage
            .get_task(a.id)
            .unwrap()
            .unwrap()
            .depends_on
            .is_empty()
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
        .replace_commit_records(a.id, &[commit(a.id, "aaa", 1)])
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
fn worktree_path_must_match_the_workspace_machine() {
    let mut storage = Storage::open_in_memory().unwrap();
    let remote = add_workspace(&mut storage, "Server", ssh_location("devbox", "/srv/app"));
    let mut task = add_task(&mut storage, &remote, "Remote");
    task.worktree_path = Some(HostPath::Windows(WindowsPath::parse(r"C:\wt\x").unwrap()));
    assert!(matches!(
        storage.update_task(&task),
        Err(StorageError::WorktreePathMismatch(id)) if id == task.id
    ));
    task.worktree_path = Some(HostPath::Posix(PosixPath::parse("/wt/server/x").unwrap()));
    storage.update_task(&task).unwrap();
    assert_eq!(storage.get_task(task.id).unwrap(), Some(task.clone()));

    task.id = TaskId(999);
    assert!(matches!(
        storage.update_task(&task),
        Err(StorageError::TaskNotFound(_))
    ));
}

#[test]
fn windows_paths_on_ssh_machines_are_stored() {
    let mut storage = Storage::open_in_memory().unwrap();
    let windows = add_workspace(
        &mut storage,
        "Quest",
        ssh_location("winpc", r"D:\dev\quest"),
    );
    let settings = MachineSettings::Ssh {
        machine: MachineLabel::parse("winpc").unwrap(),
        worktree_root: Some(HostPath::parse(r"\\nas\wt").unwrap()),
    };
    storage.save_machine_settings(&settings).unwrap();
    let mut task = add_task(&mut storage, &windows, "Remote");
    task.worktree_path = Some(HostPath::parse(r"\\nas\wt\quest\feat-remote-1").unwrap());
    storage.update_task(&task).unwrap();

    assert_eq!(storage.get_workspace(windows.id).unwrap(), Some(windows));
    assert_eq!(
        storage
            .get_machine_settings(&Machine::Ssh(MachineLabel::parse("winpc").unwrap()))
            .unwrap(),
        settings
    );
    assert_eq!(storage.get_task(task.id).unwrap(), Some(task.clone()));
    task.worktree_path = Some(HostPath::parse("/wt/quest/feat-remote-1").unwrap());
    assert!(matches!(
        storage.update_task(&task),
        Err(StorageError::WorktreePathMismatch(id)) if id == task.id
    ));
}

#[test]
fn moving_a_workspace_keeps_its_tasks() {
    let mut storage = Storage::open_in_memory().unwrap();
    let mut workspace = add_workspace(&mut storage, "Quest", local_location(r"D:\dev\quest"));
    let planned = add_task(&mut storage, &workspace, "Planned");
    let mut started = add_task(&mut storage, &workspace, "Started");
    storage.set_task_status(started.id, InProgress).unwrap();
    started.worktree_path = Some(HostPath::parse(r"D:\wt\quest\feat-started-2").unwrap());
    started.herdr_workspace_id = Some("w1".to_owned());
    storage.update_task(&started).unwrap();

    // Same machine: the herdr workspace of the task stays.
    workspace.location = local_location(r"D:\src\quest");
    storage.update_workspace(&workspace).unwrap();
    let kept = storage.get_task(started.id).unwrap().unwrap();
    assert_eq!(kept.herdr_workspace_id.as_deref(), Some("w1"));

    // To the Windows host the repository lives on: tasks and worktree paths are kept, the
    // herdr workspace of the old machine is forgotten.
    workspace.location = ssh_location("winpc", r"D:\dev\quest");
    storage.update_workspace(&workspace).unwrap();
    assert_eq!(
        storage.get_workspace(workspace.id).unwrap(),
        Some(workspace.clone())
    );
    let moved = storage.get_task(started.id).unwrap().unwrap();
    assert_eq!(moved.worktree_path, started.worktree_path);
    assert_eq!(moved.status, InProgress);
    assert_eq!(moved.herdr_workspace_id, None);
    assert_eq!(
        storage
            .list_tasks(workspace.id)
            .unwrap()
            .iter()
            .map(|task| task.id)
            .collect::<Vec<_>>(),
        [planned.id, started.id]
    );

    // A POSIX repository path would not match the Windows worktree path of the task.
    let windows = workspace.location.clone();
    workspace.location = ssh_location("winpc", "/srv/quest");
    assert!(matches!(
        storage.update_workspace(&workspace),
        Err(StorageError::WorktreePathMismatch(id)) if id == started.id
    ));
    assert_eq!(
        storage
            .get_workspace(workspace.id)
            .unwrap()
            .unwrap()
            .location,
        windows
    );
}

#[test]
fn commit_records_are_replaced_in_order() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let a = add_task(&mut storage, &workspace, "A");
    let b = add_task(&mut storage, &workspace, "B");
    storage
        .replace_commit_records(a.id, &[commit(a.id, "old", 1)])
        .unwrap();
    let refreshed = vec![
        commit(a.id, "ccc", 30),
        commit(a.id, "aaa", 10),
        commit(a.id, "bbb", 20),
    ];
    storage.replace_commit_records(a.id, &refreshed).unwrap();
    assert_eq!(storage.list_commit_records(a.id).unwrap(), refreshed);
    assert_eq!(storage.list_commit_records(b.id).unwrap(), []);

    assert!(matches!(
        storage.replace_commit_records(b.id, &[commit(a.id, "ddd", 40)]),
        Err(StorageError::CommitTaskMismatch { expected, found }) if expected == b.id && found == a.id
    ));
    assert!(matches!(
        storage.replace_commit_records(TaskId(999), &[]),
        Err(StorageError::TaskNotFound(_))
    ));
    let duplicate = [commit(a.id, "eee", 1), commit(a.id, "eee", 2)];
    assert!(matches!(
        storage.replace_commit_records(a.id, &duplicate),
        Err(StorageError::Sqlite(_))
    ));
    assert_eq!(storage.list_commit_records(a.id).unwrap(), refreshed);
}

#[test]
fn corrupt_stored_values_are_reported_as_errors() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let task = add_task(&mut storage, &workspace, "A");

    storage
        .conn
        .execute(
            "UPDATE tasks SET worktree_path = 'relative' WHERE id = ?1",
            [task.id.0],
        )
        .unwrap();
    assert!(matches!(
        storage.get_task(task.id),
        Err(StorageError::InvalidData(message)) if message.contains("relative")
    ));

    storage
        .conn
        .execute(
            "UPDATE workspaces SET path = 'not/absolute' WHERE id = ?1",
            [workspace.id.0],
        )
        .unwrap();
    assert!(matches!(
        storage.list_workspaces(),
        Err(StorageError::InvalidData(_))
    ));

    storage
        .conn
        .execute(
            "INSERT INTO machine_settings (kind, label, worktree_root) VALUES ('local', '', 'x')",
            [],
        )
        .unwrap();
    assert!(matches!(
        storage.get_machine_settings(&Machine::Local),
        Err(StorageError::InvalidData(_))
    ));
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

fn checkout(path: HostPath, branch: &str) -> crate::domain::naming::TaskCheckout {
    crate::domain::naming::TaskCheckout {
        path,
        branch: branch.to_owned(),
    }
}

#[test]
fn start_task_records_the_worktree_and_moves_to_in_progress() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let task = add_task(&mut storage, &workspace, "Add login");
    let path = HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap());

    let started = storage
        .start_task(task.id, &checkout(path.clone(), "feat/add-login-1"), "w7")
        .unwrap();

    assert_eq!(started.status, InProgress);
    assert_eq!(started.branch.as_deref(), Some("feat/add-login-1"));
    assert_eq!(started.worktree_path, Some(path));
    assert_eq!(started.herdr_workspace_id.as_deref(), Some("w7"));
    assert_eq!(storage.get_task(task.id).unwrap().unwrap(), started);
}

#[test]
fn clear_task_worktree_keeps_the_branch_and_status() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let task = add_task(&mut storage, &workspace, "Add login");
    let path = HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap());
    let started = storage
        .start_task(task.id, &checkout(path, "feat/add-login-1"), "w7")
        .unwrap();
    storage.set_task_status(task.id, Planned).unwrap();

    let cleared = storage.clear_task_worktree(task.id).unwrap();

    assert_eq!(
        (&cleared.worktree_path, &cleared.herdr_workspace_id),
        (&None, &None)
    );
    assert_eq!(cleared.branch, started.branch);
    assert_eq!(cleared.status, Planned);
    assert_eq!(storage.get_task(task.id).unwrap().unwrap(), cleared);
    assert!(matches!(
        storage.clear_task_worktree(TaskId(999)),
        Err(StorageError::TaskNotFound(_))
    ));
}

#[test]
fn restore_task_worktree_keeps_status_branch_and_history() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let task = add_task(&mut storage, &workspace, "Add login");
    let path = HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap());
    let started = storage
        .start_task(task.id, &checkout(path.clone(), "feat/add-login-1"), "w7")
        .unwrap();
    storage.clear_task_worktree(task.id).unwrap();

    let restored = storage.restore_task_worktree(task.id, &path, "w9").unwrap();

    assert_eq!(restored.worktree_path, Some(path));
    assert_eq!(restored.herdr_workspace_id.as_deref(), Some("w9"));
    assert_eq!(
        (&restored.status, &restored.branch, &restored.timeline),
        (&started.status, &started.branch, &started.timeline)
    );
    assert_eq!(storage.get_task(task.id).unwrap().unwrap(), restored);
    let posix = HostPath::Posix(PosixPath::parse("/wt/x").unwrap());
    assert!(matches!(
        storage.restore_task_worktree(task.id, &posix, "w9"),
        Err(StorageError::WorktreePathMismatch(_))
    ));
    assert!(matches!(
        storage.restore_task_worktree(TaskId(999), &posix, "w9"),
        Err(StorageError::TaskNotFound(_))
    ));
}

#[test]
fn start_task_writes_nothing_when_it_is_rejected() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(
        &mut storage,
        "Server",
        ssh_location("devbox", "/srv/server"),
    );
    let first = add_task(&mut storage, &workspace, "First");
    let second = add_task(&mut storage, &workspace, "Second");
    storage.add_dependency(second.id, first.id).unwrap();
    let posix = HostPath::Posix(PosixPath::parse("/wt/server/x").unwrap());
    let windows = HostPath::Windows(WindowsPath::parse(r"C:\wt\x").unwrap());

    assert!(matches!(
        storage.start_task(second.id, &checkout(posix, "feat/x"), "w1"),
        Err(StorageError::DependenciesNotDone { task, .. }) if task == second.id
    ));
    assert!(matches!(
        storage.start_task(first.id, &checkout(windows, "feat/x"), "w1"),
        Err(StorageError::WorktreePathMismatch(_))
    ));
    for task in [&first, &second] {
        let stored = storage.get_task(task.id).unwrap().unwrap();
        assert_eq!(
            (
                stored.branch,
                stored.worktree_path,
                stored.herdr_workspace_id
            ),
            (None, None, None)
        );
    }
    assert_eq!(status(&storage, &first), Planned);
    assert_eq!(status(&storage, &second), Planned);
}

#[test]
fn open_pull_request_stores_commits_and_url_and_keeps_dependents_waiting() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let task = add_task(&mut storage, &workspace, "Add login");
    let dependent = add_task(&mut storage, &workspace, "Use login");
    storage.add_dependency(dependent.id, task.id).unwrap();
    let path = HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap());
    storage
        .start_task(task.id, &checkout(path, "feat/add-login-1"), "w7")
        .unwrap();
    let commits = [commit(task.id, "aaa", 10), commit(task.id, "bbb", 20)];

    let pr = "https://github.com/acme/toodo/pull/3";

    let in_review = storage
        .open_pull_request(task.id, &commits[..1], pr, None)
        .unwrap();

    assert_eq!(in_review.status, InReview);
    assert_eq!(in_review.pull_request_url.as_deref(), Some(pr));
    assert_eq!(storage.get_task(task.id).unwrap().unwrap(), in_review);
    assert!(!ready(&storage, &dependent));

    let updated = storage
        .open_pull_request(task.id, &commits, pr, None)
        .unwrap();
    assert_eq!(updated, in_review);
    assert_eq!(storage.list_commit_records(task.id).unwrap(), commits);
    assert!(!ready(&storage, &dependent));

    storage.set_task_status(task.id, Done).unwrap();
    assert!(ready(&storage, &dependent));
    assert!(matches!(
        storage.open_pull_request(task.id, &commits, pr, None),
        Err(StorageError::Transition(_))
    ));
}

#[test]
fn open_pull_request_writes_nothing_when_it_is_rejected() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let ready = add_task(&mut storage, &workspace, "Not started");
    let started = add_task(&mut storage, &workspace, "Started");
    storage.set_task_status(started.id, InProgress).unwrap();
    storage
        .replace_commit_records(started.id, &[commit(started.id, "old", 1)])
        .unwrap();

    assert!(matches!(
        storage.open_pull_request(
            ready.id,
            &[commit(ready.id, "aaa", 1)],
            "https://x/pull/1",
            None
        ),
        Err(StorageError::Transition(_))
    ));
    assert!(matches!(
        storage.open_pull_request(
            started.id,
            &[commit(ready.id, "aaa", 1)],
            "https://x/pull/1",
            None
        ),
        Err(StorageError::CommitTaskMismatch { .. })
    ));
    let duplicate = [commit(started.id, "aaa", 1), commit(started.id, "aaa", 2)];
    assert!(matches!(
        storage.open_pull_request(started.id, &duplicate, "https://x/pull/1", None),
        Err(StorageError::Sqlite(_))
    ));
    for task in [&ready, &started] {
        assert_eq!(
            storage.get_task(task.id).unwrap().unwrap().pull_request_url,
            None
        );
    }
    assert_eq!(status(&storage, &ready), Planned);
    assert_eq!(status(&storage, &started), InProgress);
    assert_eq!(storage.list_commit_records(ready.id).unwrap(), []);
    assert_eq!(
        storage.list_commit_records(started.id).unwrap(),
        [commit(started.id, "old", 1)]
    );
}

#[test]
fn commit_records_in_a_period_span_every_task_oldest_first() {
    let mut storage = Storage::open_in_memory().unwrap();
    let toodo = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let server = add_workspace(&mut storage, "Server", ssh_location("devbox", "/srv/app"));
    let a = add_task(&mut storage, &toodo, "A");
    let b = add_task(&mut storage, &server, "B");
    storage
        .replace_commit_records(
            a.id,
            &[commit(a.id, "a-end", 200), commit(a.id, "a-in", 150)],
        )
        .unwrap();
    storage
        .replace_commit_records(
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
    let path = HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap());
    storage
        .start_task(task.id, &checkout(path, "feat/add-login-1"), "w7")
        .unwrap();
    set_now(&now, 300);
    let pr = "https://github.com/acme/toodo/pull/3";
    storage.open_pull_request(task.id, &[], pr, None).unwrap();
    set_now(&now, 350);
    let pushed_again = storage.open_pull_request(task.id, &[], pr, None).unwrap();
    assert_eq!(pushed_again.timeline.len(), 3);
    set_now(&now, 400);
    let done = storage
        .complete_task(task.id, Some(390), None, &[])
        .unwrap();

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
    assert_eq!(done.pull_request_merged_at, Some(390));
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
    assert!(storage.complete_task(a.id, None, None, &[]).is_err());
    assert!(
        storage
            .open_pull_request(a.id, &[], "https://x/pull/1", None)
            .is_err()
    );
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
fn base_branch_cannot_change_while_a_task_is_in_review() {
    let mut storage = Storage::open_in_memory().unwrap();
    let mut workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let other = add_workspace(&mut storage, "Other", local_location(r"C:\src\other"));
    let task = add_task(&mut storage, &workspace, "A");
    let elsewhere = add_task(&mut storage, &other, "B");
    storage.set_task_status(elsewhere.id, InProgress).unwrap();
    storage.set_task_status(elsewhere.id, InReview).unwrap();

    // A task in review in another workspace does not matter.
    workspace.default_base_branch = "develop".to_owned();
    storage.update_workspace(&workspace).unwrap();

    storage.set_task_status(task.id, InProgress).unwrap();
    storage.set_task_status(task.id, InReview).unwrap();
    workspace.default_base_branch = "main".to_owned();
    assert!(matches!(
        storage.update_workspace(&workspace),
        Err(StorageError::BaseBranchInReview { workspace: id, task: t })
            if id == workspace.id && t == task.id
    ));
    assert_eq!(
        storage
            .get_workspace(workspace.id)
            .unwrap()
            .unwrap()
            .default_base_branch,
        "develop"
    );

    // Other fields still save while the branch stays.
    workspace.default_base_branch = "develop".to_owned();
    workspace.name = "Renamed".to_owned();
    storage.update_workspace(&workspace).unwrap();
    assert_eq!(
        storage.get_workspace(workspace.id).unwrap(),
        Some(workspace.clone())
    );

    // Once the review is over, the branch can change again.
    storage.complete_task(task.id, Some(1), None, &[]).unwrap();
    workspace.default_base_branch = "main".to_owned();
    storage.update_workspace(&workspace).unwrap();
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
fn the_search_index_follows_edits_notes_pull_requests_and_deletes() {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = add_workspace(&mut storage, "Toodo", local_location(r"C:\src\toodo"));
    let mut task = add_task(&mut storage, &workspace, "Add login");
    assert_eq!(search(&storage, "login"), [task.id]);

    task.title = "Add sign-in".to_owned();
    task.description = "Replace passwords".to_owned();
    task.branch = Some("feat/sign-in-1".to_owned());
    storage.update_task(&task).unwrap();
    assert!(search(&storage, "login").is_empty());
    assert_eq!(search(&storage, "feat/sign-in"), [task.id]);

    storage
        .add_task_note(task.id, NoteKind::Progress, "Chose OAuth over passwords")
        .unwrap();
    assert_eq!(search(&storage, "oauth"), [task.id]);

    storage.set_task_status(task.id, InProgress).unwrap();
    storage
        .open_pull_request(task.id, &[], "https://github.com/acme/toodo/pull/42", None)
        .unwrap();
    assert_eq!(search(&storage, "pull/42"), [task.id]);
    let snapshot = PullRequestSnapshot {
        number: 42,
        title: "Support single sign-on".to_owned(),
        additions: 1,
        deletions: 0,
        changed_files: 1,
        merge_commit_sha: None,
        review_count: 0,
        reviewer_count: 0,
        first_reviewed_at: None,
    };
    storage
        .complete_task(task.id, Some(50), Some(&snapshot), &[])
        .unwrap();
    assert_eq!(search(&storage, "single"), [task.id]);
    assert_eq!(search(&storage, "oauth"), [task.id]);

    storage.delete_task(task.id).unwrap();
    assert!(search(&storage, "sign").is_empty());
    assert_eq!(row_count(&storage, "task_search"), 0);
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
        "task 2 cannot start yet: #1 is done as not_adopted (remove_dependency task_id 2 depends_on 1 to unblock, or complete #1 with merged_with); #7 is planned (wait for it)"
    );
}
