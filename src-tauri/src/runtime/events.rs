//! Provider-neutral host observations and snapshot reconciliation.

use crate::adapters::herdr_events::HerdrEvent;
use crate::domain::model::{HostPath, Task, WorkspaceId};
use crate::domain::path::{PosixPath, WindowsPath};
use crate::domain::runtime::{HostRef, OwnerKey};
use crate::storage::{Storage, StorageError};

use super::RuntimeService;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostState {
    Online,
    Offline,
    Unknown,
}

impl HostState {
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Offline => "offline",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeEventKind {
    WorkspaceOpened {
        provider_workspace_ref: String,
        checkout_path: String,
    },
    WorkspaceClosed {
        provider_workspace_ref: String,
        checkout_path: String,
    },
    ActivityChanged,
    HostState(HostState),
    SnapshotReconciled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEvent {
    pub owner_key: OwnerKey,
    pub host_ref: HostRef,
    pub kind: RuntimeEventKind,
}

/// An open workspace reported by a provider's host snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotWorkspace {
    pub provider_workspace_ref: String,
    pub checkout_path: String,
}

pub fn translate(owner_key: OwnerKey, host_ref: HostRef, event: &HerdrEvent) -> RuntimeEvent {
    let kind = match event {
        HerdrEvent::WorktreeOpened { workspace_id, path } => RuntimeEventKind::WorkspaceOpened {
            provider_workspace_ref: workspace_id.clone(),
            checkout_path: path.clone(),
        },
        HerdrEvent::WorktreeRemoved { workspace_id, path } => RuntimeEventKind::WorkspaceClosed {
            provider_workspace_ref: workspace_id.clone(),
            checkout_path: path.clone(),
        },
        HerdrEvent::AgentsChanged => RuntimeEventKind::ActivityChanged,
    };
    RuntimeEvent {
        owner_key,
        host_ref,
        kind,
    }
}

impl RuntimeService {
    /// Applies observations only to tasks on the observed host. Handle changes leave
    /// all earlier generations' runs untouched. Returns workspaces to notify.
    pub fn apply_event(
        &self,
        storage: &mut Storage,
        tasks: &[Task],
        event: &RuntimeEvent,
    ) -> Result<Vec<WorkspaceId>, StorageError> {
        let mut changed = Vec::new();
        for task in tasks {
            let Some(workspace) = storage.get_workspace(task.workspace_id)? else {
                continue;
            };
            if HostRef::from(&workspace.location.machine()) != event.host_ref {
                continue;
            }
            let open = storage.open_runtime_workspace(task.id)?;
            match &event.kind {
                RuntimeEventKind::WorkspaceClosed {
                    provider_workspace_ref,
                    ..
                } => {
                    if open.as_ref().is_some_and(|open| {
                        open.host == event.host_ref
                            && open.provider_workspace_ref == *provider_workspace_ref
                    }) {
                        storage.clear_task_worktree(task.id)?;
                        changed.push(task.workspace_id);
                    }
                }
                RuntimeEventKind::WorkspaceOpened {
                    provider_workspace_ref,
                    checkout_path,
                } => {
                    if is_checkout(task.worktree_path.as_ref(), checkout_path)
                        && !open.as_ref().is_some_and(|open| {
                            open.host == event.host_ref
                                && open.provider_workspace_ref == *provider_workspace_ref
                        })
                        && !storage.closed_runtime_workspace_used(
                            task.id,
                            &event.host_ref,
                            provider_workspace_ref,
                        )?
                    {
                        storage.set_task_herdr_workspace(task.id, provider_workspace_ref)?;
                        changed.push(task.workspace_id);
                    }
                }
                RuntimeEventKind::ActivityChanged
                | RuntimeEventKind::HostState(_)
                | RuntimeEventKind::SnapshotReconciled => {}
            }
        }
        storage.append_host_event(event)?;
        Ok(changed)
    }

    /// Missing checkouts are kept for lazy reopening; only a matching checkout with a
    /// new, non-stale handle is adopted.
    pub fn reconcile_snapshot(
        &self,
        storage: &mut Storage,
        host: &HostRef,
        snapshot: &[SnapshotWorkspace],
    ) -> Result<Vec<WorkspaceId>, StorageError> {
        let mut changed = Vec::new();
        for workspace in storage.list_workspaces()? {
            if HostRef::from(&workspace.location.machine()) != *host {
                continue;
            }
            for task in storage.list_tasks(workspace.id)? {
                if let Some(open) = storage.open_runtime_workspace(task.id)?
                    && open.host == *host
                    && snapshot
                        .iter()
                        .any(|entry| entry.provider_workspace_ref == open.provider_workspace_ref)
                {
                    continue;
                }
                if let Some(entry) = snapshot
                    .iter()
                    .find(|entry| is_checkout(task.worktree_path.as_ref(), &entry.checkout_path))
                {
                    let event = RuntimeEvent {
                        owner_key: OwnerKey::implicit(),
                        host_ref: host.clone(),
                        kind: RuntimeEventKind::WorkspaceOpened {
                            provider_workspace_ref: entry.provider_workspace_ref.clone(),
                            checkout_path: entry.checkout_path.clone(),
                        },
                    };
                    changed.extend(self.apply_event(storage, &[task], &event)?);
                }
            }
        }
        storage.mark_host_reconciled(&OwnerKey::implicit(), host)?;
        Ok(changed)
    }
}

/// Windows checkout paths compare case-insensitively after path normalization.
fn is_checkout(worktree: Option<&HostPath>, path: &str) -> bool {
    match worktree {
        Some(HostPath::Windows(worktree)) => WindowsPath::parse(path)
            .is_ok_and(|path| worktree.as_str().eq_ignore_ascii_case(path.as_str())),
        Some(HostPath::Posix(worktree)) => {
            PosixPath::parse(path).is_ok_and(|path| path.as_str() == worktree.as_str())
        }
        None => false,
    }
}
