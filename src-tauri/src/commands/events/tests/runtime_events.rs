use super::*;
use crate::domain::runtime::{HostRef, OwnerKey, RunRole, RunState, RunnerKind};
use crate::runtime::RuntimeService;
use crate::runtime::events::{RuntimeEvent, RuntimeEventKind, SnapshotWorkspace};
use crate::storage::NewRun;

fn writer(storage: &mut Storage, task: &model::Task, key: &str) -> crate::domain::runtime::RunId {
    let open = storage.open_runtime_workspace(task.id).unwrap().unwrap();
    let run = storage
        .reserve_run(&NewRun {
            owner: OwnerKey::implicit(),
            task: task.id,
            request_key: key.to_owned(),
            runner_kind: RunnerKind::Herdr,
            role: RunRole::Writer,
            host: open.host,
            checkout_path: task.worktree_path.as_ref().map(ToString::to_string),
            runtime_workspace: Some(open.id),
            adapter_profile: None,
            conversation: None,
        })
        .unwrap()
        .into_run();
    storage.record_launch(run.id, "w1:p1").unwrap();
    run.id
}

#[test]
fn stale_workspace_events_preserve_reopened_generation_and_earlier_runs() {
    let fixture = fixture();
    let mut storage = lock(&fixture.storage);
    let old = writer(&mut storage, &fixture.local, "generation-one");
    storage.finish_run(old, RunState::Settled).unwrap();
    storage
        .set_task_herdr_workspace(fixture.local.id, "w9")
        .unwrap();
    let new = writer(&mut storage, &fixture.local, "generation-two");
    let event = |kind| RuntimeEvent {
        owner_key: OwnerKey::implicit(),
        host_ref: HostRef::Local,
        kind,
    };
    let path = fixture.local.worktree_path.as_ref().unwrap().to_string();
    for kind in [
        RuntimeEventKind::WorkspaceOpened {
            provider_workspace_ref: "w1".to_owned(),
            checkout_path: path.clone(),
        },
        RuntimeEventKind::WorkspaceClosed {
            provider_workspace_ref: "w1".to_owned(),
            checkout_path: path.clone(),
        },
    ] {
        assert!(
            RuntimeService
                .apply_event(
                    &mut storage,
                    std::slice::from_ref(&fixture.local),
                    &event(kind),
                )
                .unwrap()
                .is_empty()
        );
    }
    // A stale snapshot must obey the same guard as a streamed open observation.
    RuntimeService
        .reconcile_snapshot(
            &mut storage,
            &HostRef::Local,
            &[SnapshotWorkspace {
                provider_workspace_ref: "w1".to_owned(),
                checkout_path: path,
            }],
        )
        .unwrap();
    let open = storage
        .open_runtime_workspace(fixture.local.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (open.provider_workspace_ref.as_str(), open.generation),
        ("w9", 2)
    );
    assert_eq!(
        storage.get_run(old).unwrap().unwrap().state,
        RunState::Settled
    );
    assert_eq!(
        storage.get_run(new).unwrap().unwrap().state,
        RunState::Running
    );
}

#[test]
fn identical_provider_refs_are_isolated_by_host_in_events_and_snapshots() {
    for local in [true, false] {
        let mut fixture = fixture();
        {
            // The checkout path also collides, so neither paths nor provider refs
            // can stand in for the host boundary.
            let mut storage = lock(&fixture.storage);
            storage.clear_task_worktree(fixture.local.id).unwrap();
            let mut workspace = storage
                .get_workspace(fixture.local.workspace_id)
                .unwrap()
                .unwrap();
            workspace.location = WorkspaceLocation::Local {
                path: PosixPath::parse("/srv/toodo").unwrap().into(),
            };
            storage.update_workspace(&workspace).unwrap();
            fixture.local = storage
                .restore_task_worktree(
                    fixture.local.id,
                    fixture.remote.worktree_path.as_ref().unwrap(),
                    "w1",
                )
                .unwrap();
        }
        let (selected, other, host, other_host) = if local {
            (
                &fixture.local,
                &fixture.remote,
                HostRef::Local,
                HostRef::from(&devbox()),
            )
        } else {
            (
                &fixture.remote,
                &fixture.local,
                HostRef::from(&devbox()),
                HostRef::Local,
            )
        };
        let mut storage = lock(&fixture.storage);
        let untouched = storage
            .host_cursor(&OwnerKey::implicit(), &other_host)
            .unwrap();
        let path = selected.worktree_path.as_ref().unwrap().to_string();
        let tasks = [fixture.local.clone(), fixture.remote.clone()];
        let opened = RuntimeEvent {
            owner_key: OwnerKey::implicit(),
            host_ref: host.clone(),
            kind: RuntimeEventKind::WorkspaceOpened {
                provider_workspace_ref: "w9".to_owned(),
                checkout_path: path.clone(),
            },
        };
        RuntimeService
            .apply_event(&mut storage, &tasks, &opened)
            .unwrap();
        RuntimeService
            .reconcile_snapshot(
                &mut storage,
                &host,
                &[SnapshotWorkspace {
                    provider_workspace_ref: "w11".to_owned(),
                    checkout_path: path.clone(),
                }],
            )
            .unwrap();
        // Both hosts began with w1; removing it here must not remove the other host's w1.
        RuntimeService
            .apply_event(
                &mut storage,
                &tasks,
                &RuntimeEvent {
                    kind: RuntimeEventKind::WorkspaceClosed {
                        provider_workspace_ref: "w1".to_owned(),
                        checkout_path: path,
                    },
                    ..opened
                },
            )
            .unwrap();
        let changed = storage.get_task(selected.id).unwrap().unwrap();
        assert_eq!(changed.herdr_workspace_id.as_deref(), Some("w11"));
        assert_eq!(storage.get_task(other.id).unwrap().unwrap(), *other);
        assert_eq!(
            storage
                .host_cursor(&OwnerKey::implicit(), &other_host)
                .unwrap(),
            untouched
        );
        let cursor = storage.host_cursor(&OwnerKey::implicit(), &host).unwrap();
        assert_eq!(
            (cursor.last_sequence, cursor.reconciled_sequence),
            (4, Some(3))
        );
    }
}
