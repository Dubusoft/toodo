//! Reverse tunnels that let agents on SSH machines reach the MCP server: one `ssh -R`
//! forward of the server's port to every machine with an SSH workspace, so
//! `http://127.0.0.1:<port>/mcp` on that machine reaches this server. A forward that ends
//! is opened again after a growing delay; forwards of machines without workspaces, and all
//! of them when the server stops, are stopped.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::adapters::ssh_tunnel::{Forward, ForwardState, Forwarder};
use crate::commands::events::ssh_machines;
use crate::commands::{Runtime, lock};
use crate::domain::model::{Machine, MachineLabel};

pub type TunnelsState = Arc<Mutex<Tunnels>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelState {
    Connecting,
    Open,
    /// The forward ended and is opened again later.
    Retrying,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelStatus {
    pub machine: MachineLabel,
    pub state: TunnelState,
    /// Why the last forward ended, until a new one is open.
    pub error: Option<String>,
}

struct Entry {
    forward: Option<Box<dyn Forward>>,
    state: TunnelState,
    error: Option<String>,
    retry_at: Instant,
    delay: Duration,
}

const FIRST_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_secs(2);

pub struct Tunnels {
    forwarder: Box<dyn Forwarder>,
    port: u16,
    entries: BTreeMap<MachineLabel, Entry>,
    stopped: bool,
}

impl Tunnels {
    pub fn new(forwarder: Box<dyn Forwarder>, port: u16) -> Self {
        Self {
            forwarder,
            port,
            entries: BTreeMap::new(),
            stopped: false,
        }
    }

    /// Keeps a forward to each of `machines` and stops the others.
    pub fn reconcile(&mut self, machines: &BTreeSet<MachineLabel>, now: Instant) {
        if self.stopped {
            return;
        }
        self.entries.retain(|machine, _| machines.contains(machine));
        for machine in machines {
            let entry = self.entries.entry(machine.clone()).or_insert(Entry {
                forward: None,
                state: TunnelState::Connecting,
                error: None,
                retry_at: now,
                delay: FIRST_RETRY,
            });
            if let Some(forward) = &mut entry.forward {
                match forward.state() {
                    ForwardState::Connecting => entry.state = TunnelState::Connecting,
                    ForwardState::Open => {
                        entry.state = TunnelState::Open;
                        entry.error = None;
                        entry.delay = FIRST_RETRY;
                    }
                    ForwardState::Closed(reason) => {
                        entry.forward = None;
                        entry.fail(reason, now);
                    }
                }
            }
            if entry.forward.is_none() && now >= entry.retry_at {
                match self.forwarder.open(machine, self.port) {
                    Ok(forward) => {
                        entry.forward = Some(forward);
                        entry.state = TunnelState::Connecting;
                    }
                    Err(error) => entry.fail(format!("could not start ssh: {error}"), now),
                }
            }
        }
    }

    pub fn statuses(&self) -> Vec<TunnelStatus> {
        self.entries
            .iter()
            .map(|(machine, entry)| TunnelStatus {
                machine: machine.clone(),
                state: entry.state,
                error: entry.error.clone(),
            })
            .collect()
    }

    /// Stops every forward for good, e.g. when the app exits.
    pub fn shut_down(&mut self) {
        self.stopped = true;
        self.entries.clear();
    }
}

impl Entry {
    fn fail(&mut self, reason: String, now: Instant) {
        self.state = TunnelState::Retrying;
        self.error = Some(reason);
        self.retry_at = now + self.delay;
        self.delay = (self.delay * 2).min(MAX_RETRY);
    }
}

/// Starts the background thread that keeps the forwards in line with the workspaces.
pub fn spawn(app: Arc<dyn Runtime>, tunnels: TunnelsState) -> std::io::Result<()> {
    thread::Builder::new()
        .name("mcp-tunnels".to_owned())
        .spawn(move || {
            let mut last_error = String::new();
            loop {
                let machines = ssh_machines(&lock(app.storage()));
                match machines {
                    Ok(machines) => {
                        last_error.clear();
                        let hosts = machines
                            .into_iter()
                            .filter_map(|machine| match machine {
                                Machine::Ssh(host) => Some(host),
                                Machine::Local => None,
                            })
                            .collect();
                        let mut tunnels = tunnels.lock().unwrap_or_else(PoisonError::into_inner);
                        if tunnels.stopped {
                            return;
                        }
                        tunnels.reconcile(&hosts, Instant::now());
                    }
                    Err(error) => {
                        let message = error.to_string();
                        if message != last_error {
                            eprintln!("toodo: failed to list machines to tunnel to: {message}");
                            last_error = message;
                        }
                    }
                }
                thread::sleep(POLL);
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Arc;

    use super::*;
    use crate::adapters::ssh_tunnel::fake::FakeForwarder;

    fn label(name: &str) -> MachineLabel {
        MachineLabel::parse(name).unwrap()
    }

    fn machines(names: &[&str]) -> BTreeSet<MachineLabel> {
        names.iter().map(|name| label(name)).collect()
    }

    fn status(name: &str, state: TunnelState, error: Option<&str>) -> TunnelStatus {
        TunnelStatus {
            machine: label(name),
            state,
            error: error.map(str::to_owned),
        }
    }

    #[test]
    fn opens_one_forward_per_machine_and_reports_when_it_is_open() {
        let forwarder = Arc::new(FakeForwarder::default());
        let mut tunnels = Tunnels::new(Box::new(forwarder.clone()), 47615);
        let now = Instant::now();
        tunnels.reconcile(&machines(&["devbox", "gpu"]), now);
        tunnels.reconcile(&machines(&["devbox", "gpu"]), now);
        let opened = forwarder.opened.lock().unwrap().clone();
        assert_eq!(
            opened.iter().map(|o| o.host.as_str()).collect::<Vec<_>>(),
            ["devbox", "gpu"]
        );
        *opened[0].state.lock().unwrap() = ForwardState::Open;
        tunnels.reconcile(&machines(&["devbox", "gpu"]), now);
        assert_eq!(
            tunnels.statuses(),
            [
                status("devbox", TunnelState::Open, None),
                status("gpu", TunnelState::Connecting, None),
            ]
        );
    }

    #[test]
    fn ended_forwards_are_opened_again_after_a_growing_delay() {
        let forwarder = Arc::new(FakeForwarder::default());
        let mut tunnels = Tunnels::new(Box::new(forwarder.clone()), 47615);
        let devbox = machines(&["devbox"]);
        let start = Instant::now();
        tunnels.reconcile(&devbox, start);
        let failed = "Error: remote port forwarding failed for listen port 47615";
        *forwarder.opened.lock().unwrap()[0].state.lock().unwrap() =
            ForwardState::Closed(failed.to_owned());
        tunnels.reconcile(&devbox, start);
        assert_eq!(
            tunnels.statuses(),
            [status("devbox", TunnelState::Retrying, Some(failed))]
        );
        assert!(!*forwarder.opened.lock().unwrap()[0].alive.lock().unwrap());

        tunnels.reconcile(&devbox, start + Duration::from_millis(500));
        assert_eq!(forwarder.opened.lock().unwrap().len(), 1);
        tunnels.reconcile(&devbox, start + FIRST_RETRY);
        assert_eq!(forwarder.opened.lock().unwrap().len(), 2);
        // The error stays visible while the new forward connects.
        assert_eq!(
            tunnels.statuses(),
            [status("devbox", TunnelState::Connecting, Some(failed))]
        );

        // The next failure waits twice as long; an open forward resets the delay.
        *forwarder.opened.lock().unwrap()[1].state.lock().unwrap() =
            ForwardState::Closed(failed.to_owned());
        let second = start + FIRST_RETRY;
        tunnels.reconcile(&devbox, second);
        tunnels.reconcile(&devbox, second + FIRST_RETRY);
        assert_eq!(forwarder.opened.lock().unwrap().len(), 2);
        tunnels.reconcile(&devbox, second + FIRST_RETRY * 2);
        assert_eq!(forwarder.opened.lock().unwrap().len(), 3);
        *forwarder.opened.lock().unwrap()[2].state.lock().unwrap() = ForwardState::Open;
        let third = second + FIRST_RETRY * 2;
        tunnels.reconcile(&devbox, third);
        assert_eq!(
            tunnels.statuses(),
            [status("devbox", TunnelState::Open, None)]
        );
        *forwarder.opened.lock().unwrap()[2].state.lock().unwrap() =
            ForwardState::Closed(failed.to_owned());
        tunnels.reconcile(&devbox, third);
        tunnels.reconcile(&devbox, third + FIRST_RETRY);
        assert_eq!(forwarder.opened.lock().unwrap().len(), 4);
    }

    #[test]
    fn ssh_that_cannot_start_is_retried() {
        let forwarder = Arc::new(FakeForwarder::default());
        forwarder
            .failures
            .lock()
            .unwrap()
            .push_back(io::Error::new(io::ErrorKind::NotFound, "program not found"));
        let mut tunnels = Tunnels::new(Box::new(forwarder.clone()), 47615);
        let devbox = machines(&["devbox"]);
        let start = Instant::now();
        tunnels.reconcile(&devbox, start);
        assert_eq!(
            tunnels.statuses(),
            [status(
                "devbox",
                TunnelState::Retrying,
                Some("could not start ssh: program not found")
            )]
        );
        tunnels.reconcile(&devbox, start + FIRST_RETRY);
        assert_eq!(forwarder.opened.lock().unwrap().len(), 1);
    }

    #[test]
    fn forwards_stop_when_their_machine_goes_and_on_shut_down() {
        let forwarder = Arc::new(FakeForwarder::default());
        let mut tunnels = Tunnels::new(Box::new(forwarder.clone()), 47615);
        let now = Instant::now();
        tunnels.reconcile(&machines(&["devbox", "gpu"]), now);
        tunnels.reconcile(&machines(&["gpu"]), now);
        let opened = forwarder.opened.lock().unwrap().clone();
        assert!(!*opened[0].alive.lock().unwrap());
        assert!(*opened[1].alive.lock().unwrap());
        assert_eq!(
            tunnels.statuses(),
            [status("gpu", TunnelState::Connecting, None)]
        );

        tunnels.shut_down();
        assert!(!*opened[1].alive.lock().unwrap());
        tunnels.reconcile(&machines(&["gpu"]), now);
        assert_eq!(tunnels.statuses(), []);
        assert_eq!(forwarder.opened.lock().unwrap().len(), 2);
    }
}
