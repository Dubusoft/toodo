//! Reverse port forwards that let programs on an SSH machine reach a loopback port of
//! this machine, kept open by `ssh -N -R`.

use std::io::{self, BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::domain::model::MachineLabel;

/// How one forward is doing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForwardState {
    /// ssh is connecting and has not confirmed the forward yet.
    Connecting,
    /// The remote port forwards to this machine.
    Open,
    /// ssh exited; carries why, e.g. the remote port is taken.
    Closed(String),
}

/// A running forward; dropping it stops the forward.
pub trait Forward: Send {
    fn state(&mut self) -> ForwardState;
}

pub trait Forwarder: Send + Sync {
    /// Makes `127.0.0.1:<port>` on `host` forward to `127.0.0.1:<port>` here.
    fn open(&self, host: &MachineLabel, port: u16) -> io::Result<Box<dyn Forward>>;
}

/// Forwards with the `ssh` client, sharing the user's `~/.ssh/config` and agent.
pub struct SshForwarder;

/// The ssh arguments of a forward. `-v` makes ssh report when the server accepted the
/// forward; `ExitOnForwardFailure` makes it exit when it did not, e.g. because the
/// remote port is taken. A dedicated connection (`ControlPath=none`) keeps the forward
/// from outliving the process in a shared master connection.
pub fn forward_args(host: &MachineLabel, port: u16) -> Vec<String> {
    let forward = format!("127.0.0.1:{port}:127.0.0.1:{port}");
    [
        "-v",
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ControlPath=none",
        "-R",
        &forward,
        "--",
        host.as_str(),
    ]
    .map(str::to_owned)
    .to_vec()
}

impl Forwarder for SshForwarder {
    fn open(&self, host: &MachineLabel, port: u16) -> io::Result<Box<dyn Forward>> {
        let mut command = Command::new("ssh");
        command
            .args(forward_args(host, port))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("ssh has no piped standard error"));
        };
        let log: Arc<Mutex<Log>> = Arc::default();
        let reader_log = log.clone();
        let reader = thread::Builder::new()
            .name(format!("ssh-forward-{host}"))
            .spawn(move || read_log(stderr, &reader_log));
        let reader = match reader {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        Ok(Box::new(SshForward {
            child,
            log,
            reader,
            exited_at: None,
        }))
    }
}

/// What ssh reported so far.
#[derive(Debug, Default, PartialEq, Eq)]
struct Log {
    open: bool,
    /// The last line that may explain an exit.
    error: Option<String>,
}

impl Log {
    fn apply(&mut self, line: &str) {
        let line = line.trim();
        if line.contains("remote forward success for: listen") {
            self.open = true;
        } else if !line.is_empty() && !is_chatter(line) {
            self.error = Some(line.to_owned());
        }
    }
}

/// Lines ssh prints at `-v` that never explain why it exited.
fn is_chatter(line: &str) -> bool {
    [
        "debug",
        "OpenSSH_",
        "Authenticated to ",
        "Transferred: ",
        "Bytes per second: ",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn read_log(stderr: impl Read, log: &Mutex<Log>) {
    for line in BufReader::new(stderr).split(b'\n') {
        let Ok(line) = line else { break };
        log.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .apply(&String::from_utf8_lossy(&line));
    }
}

/// How long an exited ssh may take to finish printing why before it is reported.
const STDERR_GRACE: Duration = Duration::from_secs(2);

struct SshForward {
    child: Child,
    log: Arc<Mutex<Log>>,
    reader: JoinHandle<()>,
    exited_at: Option<Instant>,
}

impl Forward for SshForward {
    fn state(&mut self) -> ForwardState {
        let status = match self.child.try_wait() {
            Ok(status) => status,
            Err(error) => return ForwardState::Closed(format!("could not check ssh: {error}")),
        };
        let log = self.log.lock().unwrap_or_else(PoisonError::into_inner);
        let alive = if log.open {
            ForwardState::Open
        } else {
            ForwardState::Connecting
        };
        let Some(status) = status else {
            return alive;
        };
        let exited_at = *self.exited_at.get_or_insert_with(Instant::now);
        if !self.reader.is_finished() && exited_at.elapsed() < STDERR_GRACE {
            return alive;
        }
        ForwardState::Closed(
            log.error
                .clone()
                .unwrap_or_else(|| format!("ssh exited with {status}")),
        )
    }
}

impl Drop for SshForward {
    fn drop(&mut self) {
        // ssh may have exited already, in which case there is nothing to stop.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
pub mod fake {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// A forward whose state the test sets; `alive` turns false once it is dropped.
    pub struct FakeForward {
        pub state: Arc<Mutex<ForwardState>>,
        pub alive: Arc<Mutex<bool>>,
    }

    impl Forward for FakeForward {
        fn state(&mut self) -> ForwardState {
            self.state.lock().unwrap().clone()
        }
    }

    impl Drop for FakeForward {
        fn drop(&mut self) {
            *self.alive.lock().unwrap() = false;
        }
    }

    /// Handles to one opened fake forward.
    #[derive(Clone)]
    pub struct Opened {
        pub host: MachineLabel,
        pub state: Arc<Mutex<ForwardState>>,
        pub alive: Arc<Mutex<bool>>,
    }

    /// Opens fake forwards, or fails with the scripted errors first.
    #[derive(Default)]
    pub struct FakeForwarder {
        pub failures: Mutex<VecDeque<io::Error>>,
        pub opened: Mutex<Vec<Opened>>,
    }

    impl Forwarder for Arc<FakeForwarder> {
        fn open(&self, host: &MachineLabel, _port: u16) -> io::Result<Box<dyn Forward>> {
            if let Some(error) = self.failures.lock().unwrap().pop_front() {
                return Err(error);
            }
            let opened = Opened {
                host: host.clone(),
                state: Arc::new(Mutex::new(ForwardState::Connecting)),
                alive: Arc::new(Mutex::new(true)),
            };
            self.opened.lock().unwrap().push(opened.clone());
            Ok(Box::new(FakeForward {
                state: opened.state,
                alive: opened.alive,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_the_same_loopback_port_over_a_dedicated_connection() {
        let args = forward_args(&MachineLabel::parse("devbox").unwrap(), 47615);
        assert_eq!(args[..2], ["-v", "-N"]);
        for option in [
            "BatchMode=yes",
            "ExitOnForwardFailure=yes",
            "ControlPath=none",
        ] {
            let at = args.iter().position(|arg| arg == option).unwrap();
            assert_eq!(args[at - 1], "-o");
        }
        assert_eq!(
            args[args.len() - 4..],
            ["-R", "127.0.0.1:47615:127.0.0.1:47615", "--", "devbox"]
        );
    }

    #[test]
    fn the_log_tracks_the_forward_and_the_reason_ssh_exited() {
        let log = Mutex::new(Log::default());
        let stderr = "OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13 30 Jan 2024\r\n\
            debug1: Connecting to devbox port 22.\n\
            Authenticated to devbox ([10.0.0.5]:22) using \"publickey\".\n\
            debug1: remote forward success for: listen 127.0.0.1:47615, connect 127.0.0.1:47615\n";
        read_log(stderr.as_bytes(), &log);
        assert_eq!(
            *log.lock().unwrap(),
            Log {
                open: true,
                error: None
            }
        );

        let log = Mutex::new(Log::default());
        let stderr = "debug1: Remote connections from 127.0.0.1:47615 forwarded to local address 127.0.0.1:47615\n\
            Error: remote port forwarding failed for listen port 47615\n\
            Transferred: sent 2580, received 2196 bytes, in 0.1 seconds\n\
            Bytes per second: sent 39147.2, received 33320.7\n";
        read_log(stderr.as_bytes(), &log);
        assert_eq!(
            *log.lock().unwrap(),
            Log {
                open: false,
                error: Some(
                    "Error: remote port forwarding failed for listen port 47615".to_owned()
                ),
            }
        );
    }
}
