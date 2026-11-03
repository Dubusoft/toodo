//! Keeps Toodo in sync with herdr servers through their event subscriptions.
//!
//! One background thread watches the local herdr server, and one more each machine that
//! hosts an SSH workspace, whose herdr server is reached through `ssh -W`. Each thread
//! subscribes to herdr events and, for the tasks of its machine:
//! - forgets the worktree of a task whose worktree was removed in herdr,
//! - remembers the new herdr workspace of a task whose worktree was opened again,
//! - keeps the agent status of each task with a herdr workspace, read again from
//!   `herdr pane list` whenever panes or agents change,
//!
//! and tells the frontend through the [`TasksChanged`] and [`AgentStatusesChanged`]
//! events. When the subscription ends, e.g. herdr stopped or reported `events_lost`, it
//! subscribes again after a growing delay and reconciles with a fresh pane list. herdr
//! IDs are scoped to one server, so events of one machine never touch tasks of another.
//!
//! herdr on a Windows host serves its API on a named pipe, which `ssh -W` cannot reach, so
//! a Windows machine (one whose workspaces have Windows paths) is not subscribed to: its
//! agent statuses are read from `herdr --machine <id> pane list` every [`POLL`], and
//! worktrees removed or opened again in herdr there are not noticed.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use super::types::{AgentStatus, TaskAgentStatus, TaskPullRequestStatus, WorkspaceId};
use super::{Runtime, State, StorageState, lock};
use crate::adapters::herdr::{self, Herdr, HerdrError};
use crate::adapters::herdr_events::{
    Connector, EventStreamError, Flow, HerdrEvent, LocalSocket, Message, SshSocket, subscribe,
};
use crate::domain::model::{self, HostPath, Machine, WorkspaceLocation};
use crate::domain::path::{PosixPath, WindowsPath};
use crate::storage::{Storage, StorageError};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Agent statuses of the tasks of each watched machine.
pub type AgentStatusState = Mutex<HashMap<Machine, Vec<TaskAgentStatus>>>;

/// Tasks of the workspace changed outside a command, e.g. herdr removed a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TasksChanged {
    pub workspace_id: WorkspaceId,
}

/// Workspaces were added outside the app's own forms, e.g. by an agent through MCP.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorkspacesChanged;

/// The agent statuses of tasks changed; carries all of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AgentStatusesChanged {
    pub statuses: Vec<TaskAgentStatus>,
}

/// The CI or review state of the pull request of an `in_review` task changed; carries
/// all of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PullRequestStatusesChanged {
    pub statuses: Vec<TaskPullRequestStatus>,
}

/// The names the frontend listens to these events by, the ones tauri-specta derives in
/// the desktop app; the server sends them under the same names.
pub mod names {
    pub const TASKS_CHANGED: &str = "tasks-changed";
    pub const WORKSPACES_CHANGED: &str = "workspaces-changed";
    pub const AGENT_STATUSES_CHANGED: &str = "agent-statuses-changed";
    pub const PULL_REQUEST_STATUSES_CHANGED: &str = "pull-request-statuses-changed";
}

#[specta::specta]
pub fn list_agent_statuses(statuses: State<'_, AgentStatusState>) -> Vec<TaskAgentStatus> {
    all_statuses(&lock_statuses(&statuses))
}

fn lock_statuses(
    statuses: &AgentStatusState,
) -> MutexGuard<'_, HashMap<Machine, Vec<TaskAgentStatus>>> {
    statuses.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The agent statuses of all machines, ordered by task ID.
fn all_statuses(by_machine: &HashMap<Machine, Vec<TaskAgentStatus>>) -> Vec<TaskAgentStatus> {
    let mut statuses: Vec<TaskAgentStatus> = by_machine.values().flatten().cloned().collect();
    statuses.sort_by_key(|status| status.task_id.0);
    statuses
}

/// Where changes are announced; the app emits them to the frontend.
pub trait Notifier {
    fn tasks_changed(&self, workspace: model::WorkspaceId);
    fn workspaces_changed(&self);
    fn agent_statuses_changed(&self, statuses: &[TaskAgentStatus]);
    fn pull_request_statuses_changed(&self, statuses: &[TaskPullRequestStatus]);
}

#[derive(Debug)]
pub enum SyncError {
    NotRunning,
    Herdr(HerdrError),
    Stream(EventStreamError),
    Storage(StorageError),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRunning => write!(f, "the herdr server is not running"),
            Self::Herdr(error) => error.fmt(f),
            Self::Stream(error) => error.fmt(f),
            Self::Storage(error) => error.fmt(f),
        }
    }
}

impl From<HerdrError> for SyncError {
    fn from(error: HerdrError) -> Self {
        Self::Herdr(error)
    }
}

impl From<StorageError> for SyncError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

/// How one subscription ended.
#[derive(Debug)]
pub struct SessionEnd {
    /// Whether herdr accepted the subscription.
    pub started: bool,
    /// `None` when new panes need a new subscription.
    pub error: Option<SyncError>,
}

pub struct EventSync<'a> {
    /// The machine whose herdr server is subscribed to.
    pub machine: Machine,
    pub storage: &'a StorageState,
    pub herdr: &'a Herdr,
    pub statuses: &'a AgentStatusState,
    pub notifier: &'a dyn Notifier,
}

impl EventSync<'_> {
    /// Subscribes once, to lifecycle events and the agent status of every current pane,
    /// and applies events until the subscription ends or must be renewed.
    pub fn run_once(&self, connector: &dyn Connector) -> SessionEnd {
        let mut started = false;
        let subscribed = match self.refresh_agents() {
            Ok(panes) => panes,
            Err(error) => {
                return SessionEnd {
                    started,
                    error: Some(error),
                };
            }
        };
        let mut failure = None;
        let result = subscribe(connector, &subscribed, |message| {
            if message == Message::Started {
                started = true;
            }
            if let Message::Event(event) = &message
                && let Err(error) = self.apply_worktree_event(event)
            {
                eprintln!("toodo: failed to apply herdr event {event:?}: {error}");
            }
            // Every message may change which pane runs which agent, so the statuses are
            // read again instead of patched from the event.
            match self.refresh_agents() {
                Ok(panes) if panes.is_subset(&subscribed) => Flow::Continue,
                Ok(_) => Flow::Resubscribe,
                Err(error) => {
                    failure = Some(error);
                    Flow::Resubscribe
                }
            }
        });
        let error = match result {
            Ok(()) => failure,
            Err(error) => Some(SyncError::Stream(error)),
        };
        SessionEnd { started, error }
    }

    /// Follows the herdr server without an event subscription: reads the panes every
    /// `interval` for as long as `keep` says so, or until reading them fails.
    pub fn poll(&self, interval: Duration, mut keep: impl FnMut() -> bool) -> SessionEnd {
        let mut started = false;
        while keep() {
            if let Err(error) = self.refresh_agents() {
                return SessionEnd {
                    started,
                    error: Some(error),
                };
            }
            started = true;
            thread::sleep(interval);
        }
        SessionEnd {
            started,
            error: None,
        }
    }

    /// Forgets all agent statuses, e.g. after herdr stopped.
    pub fn clear_agents(&self) {
        self.publish(Vec::new());
    }

    /// Reads the panes again, publishes the agent status of each task, and returns the
    /// IDs of the panes.
    fn refresh_agents(&self) -> Result<BTreeSet<String>, SyncError> {
        let panes = self.herdr.list_panes(&self.machine)?;
        let mut by_workspace: BTreeMap<&str, herdr::AgentStatus> = BTreeMap::new();
        for pane in &panes {
            let status = by_workspace
                .entry(pane.workspace_id.as_str())
                .or_insert(pane.status);
            *status = (*status).max(pane.status);
        }
        let mut statuses: Vec<TaskAgentStatus> = machine_tasks(&lock(self.storage), &self.machine)?
            .into_iter()
            .filter_map(|task| {
                let status = by_workspace.get(task.herdr_workspace_id.as_deref()?)?;
                Some(TaskAgentStatus {
                    task_id: task.id.into(),
                    status: AgentStatus::from_herdr(*status)?,
                })
            })
            .collect();
        statuses.sort_by_key(|status| status.task_id.0);
        self.publish(statuses);
        Ok(panes.into_iter().map(|pane| pane.pane_id).collect())
    }

    fn publish(&self, statuses: Vec<TaskAgentStatus>) {
        let mut current = lock_statuses(self.statuses);
        let machine = current.entry(self.machine.clone()).or_default();
        if *machine != statuses {
            *machine = statuses;
            self.notifier
                .agent_statuses_changed(&all_statuses(&current));
        }
    }

    fn apply_worktree_event(&self, event: &HerdrEvent) -> Result<(), StorageError> {
        let mut storage = lock(self.storage);
        let tasks = machine_tasks(&storage, &self.machine)?;
        match event {
            HerdrEvent::WorktreeRemoved { workspace_id, .. } => {
                for task in tasks
                    .iter()
                    .filter(|task| task.herdr_workspace_id.as_ref() == Some(workspace_id))
                {
                    storage.clear_task_worktree(task.id)?;
                    self.notifier.tasks_changed(task.workspace_id);
                }
            }
            HerdrEvent::WorktreeOpened { workspace_id, path } => {
                for task in tasks.iter().filter(|task| {
                    task.herdr_workspace_id.as_ref() != Some(workspace_id)
                        && is_checkout(task.worktree_path.as_ref(), path)
                }) {
                    storage.set_task_herdr_workspace(task.id, workspace_id)?;
                    self.notifier.tasks_changed(task.workspace_id);
                }
            }
            HerdrEvent::AgentsChanged => {}
        }
        Ok(())
    }
}

/// Whether `path`, as reported by herdr, is the worktree checkout: case-insensitively on
/// Windows.
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

/// Tasks of the workspaces on `machine`, the only ones its herdr server knows.
fn machine_tasks(storage: &Storage, machine: &Machine) -> Result<Vec<model::Task>, StorageError> {
    let mut tasks = Vec::new();
    for workspace in storage.list_workspaces()? {
        if workspace.location.machine() == *machine {
            tasks.extend(storage.list_tasks(workspace.id)?);
        }
    }
    Ok(tasks)
}

/// Machines that host at least one SSH workspace.
pub(crate) fn ssh_machines(storage: &Storage) -> Result<HashSet<Machine>, StorageError> {
    Ok(storage
        .list_workspaces()?
        .into_iter()
        .map(|workspace| workspace.location.machine())
        .filter(|machine| *machine != Machine::Local)
        .collect())
}

const FIRST_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(30);
/// How often the workspaces are checked for machines to start watching.
const MACHINE_SCAN: Duration = Duration::from_secs(5);
/// How often the panes of a machine without event subscriptions are read.
const POLL: Duration = Duration::from_secs(5);

/// Whether `machine` is a Windows host: one of its workspaces has a Windows path.
pub(crate) fn windows_host(storage: &Storage, machine: &Machine) -> Result<bool, StorageError> {
    Ok(storage.list_workspaces()?.into_iter().any(|workspace| {
        workspace.location.machine() == *machine
            && matches!(
                workspace.location,
                WorkspaceLocation::Ssh {
                    path: HostPath::Windows(_),
                    ..
                }
            )
    }))
}

/// Starts the background threads that keep the subscriptions to the local herdr server
/// and to the herdr server of every machine with an SSH workspace.
pub fn spawn(app: Arc<dyn Runtime>) -> std::io::Result<()> {
    let local = app.clone();
    thread::Builder::new()
        .name("herdr-events-local".to_owned())
        .spawn(move || watch(local.as_ref(), &Machine::Local))?;
    thread::Builder::new()
        .name("herdr-events-machines".to_owned())
        .spawn(move || watch_machines(&app))?;
    Ok(())
}

/// Starts a watching thread for each machine that gets an SSH workspace. A thread ends
/// once its machine has no workspace left, and starts again if one is added later.
fn watch_machines(app: &Arc<dyn Runtime>) {
    let watched: Arc<Mutex<HashSet<Machine>>> = Arc::default();
    let mut last_error = String::new();
    loop {
        let machines = ssh_machines(&lock(app.storage()));
        match machines {
            Ok(machines) => {
                last_error.clear();
                for machine in machines {
                    let mut running = watched.lock().unwrap_or_else(PoisonError::into_inner);
                    if !running.insert(machine.clone()) {
                        continue;
                    }
                    let (app, watched) = (app.clone(), watched.clone());
                    let thread_machine = machine.clone();
                    let spawned = thread::Builder::new()
                        .name(format!("herdr-events-{machine}"))
                        .spawn(move || {
                            watch(app.as_ref(), &thread_machine);
                            watched
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner)
                                .remove(&thread_machine);
                        });
                    if let Err(error) = spawned {
                        running.remove(&machine);
                        eprintln!("toodo: failed to watch herdr events of {machine}: {error}");
                    }
                }
            }
            Err(error) => {
                let message = error.to_string();
                if message != last_error {
                    eprintln!("toodo: failed to list machines to watch: {message}");
                    last_error = message;
                }
            }
        }
        thread::sleep(MACHINE_SCAN);
    }
}

/// How the herdr server of a machine is followed.
enum Source {
    /// Its event socket.
    Socket(Box<dyn Connector>),
    /// Its pane list, read every [`POLL`].
    Poll,
}

/// How to follow the herdr server of `machine`, or `None` while it is not running.
fn source(herdr: &Herdr, machine: &Machine, windows: bool) -> Result<Option<Source>, HerdrError> {
    let status = match machine {
        Machine::Local => herdr.server_status()?,
        Machine::Ssh(host) if windows => {
            return Ok(herdr
                .windows_server_status(host)?
                .running
                .then_some(Source::Poll));
        }
        Machine::Ssh(host) => herdr.remote_server_status(host)?,
    };
    let (true, Some(socket)) = (status.running, status.socket) else {
        return Ok(None);
    };
    Ok(Some(Source::Socket(match machine {
        Machine::Local => Box::new(LocalSocket::new(&socket)),
        Machine::Ssh(host) => Box::new(SshSocket::new(host.clone(), socket)),
    })))
}

/// Keeps the subscription to the herdr server of `machine`. Returns once an SSH machine
/// has no workspace left; the local server is watched for as long as the app runs.
fn watch(app: &dyn Runtime, machine: &Machine) {
    let storage = app.storage();
    let herdr = app.herdr();
    let sync = EventSync {
        machine: machine.clone(),
        storage,
        herdr,
        statuses: app.agent_statuses(),
        notifier: app,
    };
    let mut delay = FIRST_RETRY;
    let mut last_error = String::new();
    loop {
        if *machine != Machine::Local {
            match ssh_machines(&lock(storage)) {
                Ok(machines) if !machines.contains(machine) => {
                    sync.clear_agents();
                    return;
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("toodo: failed to check the workspaces of {machine}: {error}");
                }
            }
        }
        let windows = *machine != Machine::Local
            && windows_host(&lock(storage), machine).unwrap_or_else(|error| {
                eprintln!("toodo: failed to check the workspaces of {machine}: {error}");
                false
            });
        let end = match source(herdr, machine, windows) {
            Ok(Some(Source::Socket(connector))) => sync.run_once(connector.as_ref()),
            // Polled until the machine has no Windows workspace left.
            Ok(Some(Source::Poll)) => sync.poll(POLL, || {
                windows_host(&lock(storage), machine).unwrap_or(true)
            }),
            Ok(None) => SessionEnd {
                started: false,
                error: Some(SyncError::NotRunning),
            },
            Err(error) => SessionEnd {
                started: false,
                error: Some(error.into()),
            },
        };
        let Some(error) = end.error else {
            delay = FIRST_RETRY;
            continue;
        };
        // A subscription herdr accepted, or dropped for a reason a fresh pane list fixes,
        // is retried soon; a server that stays unreachable is retried less and less often.
        if end.started || matches!(&error, SyncError::Stream(error) if error.is_transient()) {
            delay = FIRST_RETRY;
        }
        sync.clear_agents();
        let message = error.to_string();
        if message != last_error {
            eprintln!("toodo: herdr events of {machine} unavailable, retrying: {message}");
            last_error = message;
        }
        thread::sleep(delay);
        delay = (delay * 2).min(MAX_RETRY);
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Arc;

    use super::*;
    use crate::adapters::git::GitError;
    use crate::adapters::git::fake::FakeRunner;
    use crate::adapters::herdr_events::fake::FakeConnector;
    use crate::domain::model::{MachineLabel, TaskType, WorkspaceLocation};
    use crate::domain::naming::TaskCheckout;
    use crate::domain::path::PosixPath;
    use crate::storage::{NewTask, NewWorkspace, Storage};

    #[derive(Default)]
    struct Recorder {
        tasks_changed: Mutex<Vec<model::WorkspaceId>>,
        statuses: Mutex<Vec<Vec<TaskAgentStatus>>>,
    }

    impl Notifier for Recorder {
        fn tasks_changed(&self, workspace: model::WorkspaceId) {
            self.tasks_changed.lock().unwrap().push(workspace);
        }

        fn workspaces_changed(&self) {}

        fn agent_statuses_changed(&self, statuses: &[TaskAgentStatus]) {
            self.statuses.lock().unwrap().push(statuses.to_vec());
        }

        fn pull_request_statuses_changed(&self, _: &[TaskPullRequestStatus]) {}
    }

    struct Fixture {
        storage: StorageState,
        statuses: AgentStatusState,
        recorder: Recorder,
        local: model::Task,
        remote: model::Task,
    }

    /// A started task in a local workspace (herdr workspace `w1`) and one in an SSH
    /// workspace whose remote herdr also calls its workspace `w1`.
    fn fixture() -> Fixture {
        let mut storage = Storage::open_in_memory().unwrap();
        let mut started = |location: WorkspaceLocation, path: HostPath| {
            let workspace = storage
                .create_workspace(&NewWorkspace {
                    name: "toodo".to_owned(),
                    location,
                    default_base_branch: "main".to_owned(),
                })
                .unwrap();
            let task = storage
                .create_task(&NewTask {
                    workspace_id: workspace.id,
                    task_type: TaskType::Feat,
                    title: "Add login".to_owned(),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: Vec::new(),
                })
                .unwrap();
            let checkout = TaskCheckout {
                path,
                branch: format!("feat/add-login-{}", task.id),
            };
            storage.start_task(task.id, &checkout, "w1").unwrap()
        };
        let local = started(
            WorkspaceLocation::Local {
                path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
            },
            HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap()),
        );
        let remote = started(
            WorkspaceLocation::Ssh {
                machine: MachineLabel::parse("devbox").unwrap(),
                path: PosixPath::parse("/srv/toodo").unwrap().into(),
            },
            HostPath::Posix(PosixPath::parse("/wt/toodo/feat-add-login-2").unwrap()),
        );
        Fixture {
            storage: Mutex::new(storage),
            statuses: Mutex::default(),
            recorder: Recorder::default(),
            local,
            remote,
        }
    }

    fn herdr(pane_lists: &[&str]) -> Herdr {
        let results = pane_lists.iter().map(|panes| {
            Ok(format!(
                r#"{{"id":"cli:pane:list","result":{{"panes":[{panes}]}}}}"#
            ))
        });
        Herdr::new(Box::new(Arc::new(FakeRunner::new(
            results.collect::<Vec<Result<String, GitError>>>(),
        ))))
    }

    fn pane(pane_id: &str, workspace_id: &str, status: &str) -> String {
        format!(
            r#"{{"agent_status":"{status}","pane_id":"{pane_id}","workspace_id":"{workspace_id}"}}"#
        )
    }

    const STARTED: &str = r#"{"id":"toodo:events","result":{"type":"subscription_started"}}"#;

    fn sync<'a>(fixture: &'a Fixture, herdr: &'a Herdr) -> EventSync<'a> {
        sync_on(Machine::Local, fixture, herdr)
    }

    fn sync_on<'a>(machine: Machine, fixture: &'a Fixture, herdr: &'a Herdr) -> EventSync<'a> {
        EventSync {
            machine,
            storage: &fixture.storage,
            herdr,
            statuses: &fixture.statuses,
            notifier: &fixture.recorder,
        }
    }

    fn task(fixture: &Fixture, id: model::TaskId) -> model::Task {
        lock(&fixture.storage).get_task(id).unwrap().unwrap()
    }

    fn statuses(entries: &[(model::TaskId, AgentStatus)]) -> Vec<TaskAgentStatus> {
        entries
            .iter()
            .map(|(id, status)| TaskAgentStatus {
                task_id: (*id).into(),
                status: *status,
            })
            .collect()
    }

    #[test]
    fn removed_worktrees_are_forgotten_on_local_tasks_only() {
        let fixture = fixture();
        let empty = String::new();
        let herdr = herdr(&[&empty, &empty, &empty]);
        let removed = r#"{"data":{"forced":false,"type":"worktree_removed","workspace_id":"w1","worktree":{"path":"D:\\wt\\toodo\\feat-add-login-1"}},"event":"worktree_removed"}"#;
        let connector = FakeConnector::new([Ok(format!("{STARTED}\n{removed}\n"))]);
        let end = sync(&fixture, &herdr).run_once(&connector);
        assert!(end.started);
        assert!(matches!(
            end.error,
            Some(SyncError::Stream(EventStreamError::Closed))
        ));
        let local = task(&fixture, fixture.local.id);
        assert_eq!(local.worktree_path, None);
        assert_eq!(local.herdr_workspace_id, None);
        assert_eq!(local.branch, fixture.local.branch);
        let remote = task(&fixture, fixture.remote.id);
        assert_eq!(remote.herdr_workspace_id.as_deref(), Some("w1"));
        assert_eq!(
            *fixture.recorder.tasks_changed.lock().unwrap(),
            [fixture.local.workspace_id]
        );
    }

    #[test]
    fn reopened_worktrees_adopt_the_new_herdr_workspace() {
        let fixture = fixture();
        let empty = String::new();
        let herdr = herdr(&[&empty, &empty, &empty]);
        let opened = r#"{"data":{"already_open":false,"type":"worktree_opened","workspace":{"workspace_id":"w9"},"worktree":{"path":"d:/wt/toodo/feat-add-login-1/"}},"event":"worktree_opened"}"#;
        let connector = FakeConnector::new([Ok(format!("{STARTED}\n{opened}\n"))]);
        sync(&fixture, &herdr).run_once(&connector);
        let local = task(&fixture, fixture.local.id);
        assert_eq!(local.herdr_workspace_id.as_deref(), Some("w9"));
        assert_eq!(local.worktree_path, fixture.local.worktree_path);
        assert_eq!(
            task(&fixture, fixture.remote.id)
                .herdr_workspace_id
                .as_deref(),
            Some("w1")
        );
        assert_eq!(
            *fixture.recorder.tasks_changed.lock().unwrap(),
            [fixture.local.workspace_id]
        );
    }

    #[test]
    fn agent_statuses_summarize_the_panes_of_each_task_workspace() {
        let fixture = fixture();
        let before = [pane("w1:p1", "w1", "idle"), pane("w7:p1", "w7", "working")].join(",");
        let after = [
            pane("w1:p1", "w1", "working"),
            pane("w1:p2", "w1", "blocked"),
            pane("w1:p3", "w1", "unknown"),
        ]
        .join(",");
        let herdr = herdr(&[&before, &before, &after]);
        let status = r#"{"data":{"agent":"claude","agent_status":"blocked","pane_id":"w1:p2","workspace_id":"w1"},"event":"pane.agent_status_changed"}"#;
        let connector = FakeConnector::new([Ok(format!("{STARTED}\n{status}\n"))]);
        let end = sync(&fixture, &herdr).run_once(&connector);
        // The new panes of `w1` need their own subscription.
        assert!(end.started);
        assert!(end.error.is_none());
        let id = fixture.local.id;
        assert_eq!(
            *fixture.recorder.statuses.lock().unwrap(),
            [
                statuses(&[(id, AgentStatus::Idle)]),
                statuses(&[(id, AgentStatus::Blocked)]),
            ]
        );
        assert_eq!(
            list_statuses(&fixture),
            statuses(&[(id, AgentStatus::Blocked)])
        );
        let request = &connector.requests.lock().unwrap()[0];
        assert!(request.contains(r#""pane_id":"w1:p1""#));
        assert!(request.contains(r#""pane_id":"w7:p1""#));
    }

    fn list_statuses(fixture: &Fixture) -> Vec<TaskAgentStatus> {
        all_statuses(&lock_statuses(&fixture.statuses))
    }

    fn devbox() -> Machine {
        Machine::Ssh(MachineLabel::parse("devbox").unwrap())
    }

    /// herdr answers for `devbox`: each pane list is preceded by the machine lookup.
    fn devbox_herdr(pane_lists: &[&str]) -> Herdr {
        let machines = r#"[{"id":"m2","label":"devbox","target":"devbox","session":"default","enabled":true,"selected":false}]"#;
        let results = pane_lists.iter().flat_map(|panes| {
            [
                Ok(machines.to_owned()),
                Ok(format!(
                    r#"{{"id":"cli:pane:list","result":{{"panes":[{panes}]}}}}"#
                )),
            ]
        });
        Herdr::new(Box::new(Arc::new(FakeRunner::new(
            results.collect::<Vec<Result<String, GitError>>>(),
        ))))
    }

    #[test]
    fn polling_reads_the_panes_until_told_to_stop() {
        let fixture = fixture();
        let herdr = devbox_herdr(&[
            &pane("w1:p1", "w1", "working"),
            &pane("w1:p1", "w1", "idle"),
        ]);
        let mut rounds = 0;
        let end = sync_on(devbox(), &fixture, &herdr).poll(Duration::ZERO, || {
            rounds += 1;
            rounds <= 2
        });
        assert!(end.started);
        assert!(end.error.is_none());
        let id = fixture.remote.id;
        assert_eq!(
            *fixture.recorder.statuses.lock().unwrap(),
            [
                statuses(&[(id, AgentStatus::Working)]),
                statuses(&[(id, AgentStatus::Idle)]),
            ]
        );
    }

    #[test]
    fn polling_ends_when_the_pane_list_fails() {
        let fixture = fixture();
        let machines = r#"[{"id":"m2","label":"devbox","target":"devbox","session":"default","enabled":true}]"#;
        let herdr = Herdr::new(Box::new(Arc::new(FakeRunner::new(vec![
            Ok(machines.to_owned()),
            Err(GitError::Failed {
                command: "herdr --machine m2 pane list".to_owned(),
                stderr: "remote SSH connection failed".to_owned(),
            }),
        ]))));
        let end = sync_on(devbox(), &fixture, &herdr).poll(Duration::ZERO, || true);
        assert!(!end.started);
        assert!(matches!(end.error, Some(SyncError::Herdr(_))));
    }

    #[test]
    fn windows_hosts_are_told_by_the_paths_of_their_workspaces() {
        let fixture = fixture();
        let winpc = MachineLabel::parse("winpc").unwrap();
        let mut storage = lock(&fixture.storage);
        storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Ssh {
                    machine: winpc.clone(),
                    path: WindowsPath::parse(r"D:\dev\toodo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
            })
            .unwrap();
        assert!(windows_host(&storage, &Machine::Ssh(winpc)).unwrap());
        assert!(!windows_host(&storage, &devbox()).unwrap());
        assert!(!windows_host(&storage, &Machine::Local).unwrap());
    }

    #[test]
    fn ssh_machines_apply_events_to_their_own_tasks_only() {
        let fixture = fixture();
        let empty = String::new();
        let herdr = devbox_herdr(&[&empty, &empty, &empty, &empty]);
        let opened = r#"{"data":{"already_open":false,"type":"worktree_opened","workspace":{"workspace_id":"w9"},"worktree":{"path":"/wt/toodo/feat-add-login-2"}},"event":"worktree_opened"}"#;
        let removed = r#"{"data":{"forced":false,"type":"worktree_removed","workspace_id":"w9","worktree":{"path":"/wt/toodo/feat-add-login-2"}},"event":"worktree_removed"}"#;
        let connector = FakeConnector::new([Ok(format!("{STARTED}\n{opened}\n{removed}\n"))]);
        let end = sync_on(devbox(), &fixture, &herdr).run_once(&connector);
        assert!(end.started);
        let remote = task(&fixture, fixture.remote.id);
        assert_eq!(remote.worktree_path, None);
        assert_eq!(remote.herdr_workspace_id, None);
        let local = task(&fixture, fixture.local.id);
        assert_eq!(local.herdr_workspace_id.as_deref(), Some("w1"));
        assert_eq!(local.worktree_path, fixture.local.worktree_path);
        assert_eq!(
            *fixture.recorder.tasks_changed.lock().unwrap(),
            [fixture.remote.workspace_id, fixture.remote.workspace_id]
        );
    }

    #[test]
    fn agent_statuses_of_all_machines_are_published_together() {
        let fixture = fixture();
        let working = pane("w1:p1", "w1", "working");
        let local_herdr = herdr(&[&working]);
        let failed = FakeConnector::new([Err(io::Error::other("no socket"))]);
        sync(&fixture, &local_herdr).run_once(&failed);
        let blocked = pane("w1:p1", "w1", "blocked");
        let remote_herdr = devbox_herdr(&[&blocked]);
        let failed = FakeConnector::new([Err(io::Error::other("no socket"))]);
        let remote = sync_on(devbox(), &fixture, &remote_herdr);
        remote.run_once(&failed);
        let both = statuses(&[
            (fixture.local.id, AgentStatus::Working),
            (fixture.remote.id, AgentStatus::Blocked),
        ]);
        assert_eq!(list_statuses(&fixture), both);
        assert_eq!(
            fixture.recorder.statuses.lock().unwrap().last(),
            Some(&both)
        );
        remote.clear_agents();
        assert_eq!(
            list_statuses(&fixture),
            statuses(&[(fixture.local.id, AgentStatus::Working)])
        );
    }

    #[test]
    fn a_failed_subscription_keeps_nothing_stale() {
        let fixture = fixture();
        let working = pane("w1:p1", "w1", "working");
        let herdr = herdr(&[&working]);
        let connector =
            FakeConnector::new([Err(io::Error::new(io::ErrorKind::NotFound, "no socket"))]);
        let sync = sync(&fixture, &herdr);
        let end = sync.run_once(&connector);
        assert!(!end.started);
        assert!(matches!(
            end.error,
            Some(SyncError::Stream(EventStreamError::Io { .. }))
        ));
        sync.clear_agents();
        assert_eq!(list_statuses(&fixture), []);
        assert_eq!(fixture.recorder.statuses.lock().unwrap().len(), 2);
    }
}
