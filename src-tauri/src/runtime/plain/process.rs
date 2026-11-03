//! Managed agent processes: pipe readers, process-group termination, and persisted outcomes.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use super::adapter::{
    self, AgentAdapter, EventTracker, ExitKind, Invocation, LineSplitter, MAX_STDERR_TAIL_BYTES,
    MCP_TOKEN_ENV, MCP_URL_ENV,
};
use super::{Completion, LaunchReceipt, RunnerError, RuntimeError, io_error, lock};
use crate::domain::runtime::{RunId, RunState};
use crate::storage::{Storage, StorageError, TaskRun};

pub(super) enum Signal {
    Stop,
    RemoteStop(mpsc::Sender<Result<(), RunnerError>>),
    Exit(std::io::Result<ExitStatus>),
    Stdout(std::io::Result<EventTracker>),
    Stderr(std::io::Result<String>),
}

pub(super) fn spawn(
    program: &Path,
    cwd: &str,
    brief: File,
    invocation: &Invocation,
) -> Result<(Child, mpsc::Sender<Signal>, mpsc::Receiver<Signal>), RunnerError> {
    let child = Command::new(program)
        .args(&invocation.args)
        .env_remove(MCP_URL_ENV)
        .env_remove(MCP_TOKEN_ENV)
        .envs(invocation.env.iter().cloned())
        .current_dir(cwd)
        .stdin(brief)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|error| RunnerError(format!(
            "could not launch {}: {error}; install {} on the server's PATH or start the run with the other adapter",
            program.display(), invocation.program_key
        )))?;
    let (sender, receiver) = mpsc::channel();
    Ok((child, sender, receiver))
}

pub(super) struct ManagedRun {
    pub child: Child,
    pub sender: mpsc::Sender<Signal>,
    pub receiver: mpsc::Receiver<Signal>,
    pub stdout: File,
    pub stderr: File,
    pub adapter: AgentAdapter,
    pub secret: String,
    pub timeout: Duration,
    pub storage: Arc<Mutex<Storage>>,
    pub run: RunId,
    pub receipt: LaunchReceipt,
    pub end: Arc<Completion>,
    pub remote: Option<super::remote::Remote>,
}

fn signal_group(pid: u32, signal: i32) -> bool {
    // The child creates a process group whose ID is its PID. Negative IDs target the group.
    unsafe { libc::kill(-(pid as i32), signal) == 0 }
}

/// Redacts before truncating, including tokens cut across read or line-limit boundaries.
/// Between reads it holds back only a trailing part that could start the secret, so every
/// other byte reaches the log and the line callback as soon as it is read.
fn read_output(
    mut input: impl Read,
    mut output: File,
    secret: &str,
    truncate_lines: bool,
    mut line: impl FnMut(adapter::Line),
) -> std::io::Result<String> {
    let mut splitter = LineSplitter::new();
    let mut original = LineSplitter::new();
    let mut truncated = VecDeque::new();
    let mut pending = Vec::new();
    let mut tail = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = input.read(&mut chunk)?;
        truncated.extend(
            original
                .push(&chunk[..count])
                .into_iter()
                .map(|line| line.truncated),
        );
        if count == 0
            && let Some(last) = original.finish()
        {
            truncated.push_back(last.truncated);
        }
        pending.extend_from_slice(&chunk[..count]);
        let mut at = 0;
        let mut redacted = Vec::new();
        while at < pending.len() {
            if !secret.is_empty() && pending[at..].starts_with(secret.as_bytes()) {
                redacted.extend_from_slice(b"[redacted]");
                at += secret.len();
            } else if count != 0
                && !secret.is_empty()
                && secret.as_bytes().starts_with(&pending[at..])
            {
                break;
            } else {
                redacted.push(pending[at]);
                at += 1;
            }
        }
        pending.drain(..at);
        // Only redacted bytes ever reach the log or the bounded line buffer.
        tail.extend_from_slice(&redacted);
        tail.drain(..tail.len().saturating_sub(MAX_STDERR_TAIL_BYTES));
        if !truncate_lines {
            output.write_all(&redacted)?;
        }
        for mut complete in splitter.push(&redacted) {
            complete.truncated |= truncated.pop_front().unwrap();
            if truncate_lines {
                writeln!(output, "{}", complete.text)?;
            }
            line(complete);
        }
        if count == 0 {
            break;
        }
    }
    if let Some(mut last) = splitter.finish() {
        last.truncated |= truncated.pop_front().unwrap();
        if truncate_lines {
            writeln!(output, "{}", last.text)?;
        }
        line(last);
    }
    Ok(String::from_utf8_lossy(&tail).into_owned())
}

pub(super) fn manage(mut managed: ManagedRun) {
    let pid = managed.child.id();
    let stdout = managed.child.stdout.take().unwrap();
    let stderr = managed.child.stderr.take().unwrap();
    let sender = managed.sender.clone();
    let secret = managed.secret.clone();
    let adapter = managed.adapter;
    thread::spawn(move || {
        let mut tracker = EventTracker::new(adapter);
        let result = read_output(stdout, managed.stdout, &secret, true, |line| {
            if !line.truncated {
                tracker.feed(&line.text);
            }
        })
        .map(|_| tracker);
        let _ = sender.send(Signal::Stdout(result));
    });
    let sender = managed.sender.clone();
    let secret = managed.secret.clone();
    thread::spawn(move || {
        let result = read_output(stderr, managed.stderr, &secret, false, |_| {});
        let _ = sender.send(Signal::Stderr(result));
    });
    let sender = managed.sender;
    thread::spawn(move || {
        let _ = sender.send(Signal::Exit(managed.child.wait()));
    });
    thread::spawn(move || {
        let mut deadline = Instant::now() + managed.timeout;
        let mut termination = None;
        let mut killed = false;
        let mut exit = None;
        let mut tracker = None;
        let mut stderr = None;
        let mut observation_lost = false;
        while exit.is_none()
            || tracker.is_none()
            || stderr.is_none()
            || (termination.is_some() && !killed && signal_group(pid, 0))
        {
            match managed
                .receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(Signal::Stop) if termination.is_none() => {
                    termination = Some(ExitKind::Stopped);
                    signal_group(pid, libc::SIGTERM);
                    deadline = Instant::now() + Duration::from_secs(5);
                }
                Ok(Signal::Stop) => {}
                Ok(Signal::RemoteStop(reply)) => {
                    let mut result = managed.remote.as_ref().unwrap().stop(managed.run);
                    if result.is_ok() {
                        termination = Some(ExitKind::Stopped);
                        signal_group(pid, libc::SIGTERM);
                        deadline = Instant::now() + Duration::from_secs(5);
                    } else if let Err(error) =
                        lock(&managed.storage).append_run_event(managed.run, "stop_requested", None)
                    {
                        result = Err(RunnerError(format!(
                            "{error}; reconcile the run once the host is reachable"
                        )));
                    }
                    let _ = reply.send(result);
                }
                Ok(Signal::Exit(status)) => exit = Some(status),
                Ok(Signal::Stdout(result)) => tracker = Some(result),
                Ok(Signal::Stderr(result)) => stderr = Some(result),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if termination.is_none() {
                        if let Some(remote) = &managed.remote
                            && remote.stop(managed.run).is_err()
                        {
                            observation_lost = true;
                        }
                        termination = Some(ExitKind::TimedOut);
                        signal_group(pid, libc::SIGTERM);
                        deadline = Instant::now() + Duration::from_secs(5);
                    } else if !killed {
                        signal_group(pid, libc::SIGKILL);
                        killed = true;
                        // After SIGKILL, wait for the exact pipe EOF and waitpid signals.
                        deadline = Instant::now() + Duration::from_secs(86400);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let result = (|| -> Result<TaskRun, RuntimeError> {
            let status = exit.unwrap().map_err(io_error)?;
            let tracker = tracker.unwrap().map_err(io_error)?;
            let stderr = stderr.unwrap().map_err(io_error)?;
            let mut exit = termination.unwrap_or_else(|| match status.code() {
                Some(code) => ExitKind::Code(code),
                None => ExitKind::Signal(status.signal().unwrap_or(0)),
            });
            if termination.is_none()
                && let Some(remote) = &managed.remote
            {
                if status.code() == Some(255) {
                    // SSH's transport failure is not evidence of the agent's exit.
                    match remote.probe(managed.run) {
                        Ok(crate::runtime::host::Probe::Exited(code)) => {
                            exit = ExitKind::Code(code)
                        }
                        _ => observation_lost = true,
                    }
                } else if status.code().is_none() {
                    observation_lost = true;
                }
            }
            let mut outcome = adapter::classify(&tracker, exit, &stderr);
            if observation_lost {
                outcome.state = RunState::Unknown;
                outcome.events = vec![(
                    "observation_lost",
                    "SSH observation was lost; reconcile the run once the host is reachable".into(),
                )];
            } else if managed.remote.is_some() && outcome.state == RunState::Settled {
                // A completed remote command has exited; it cannot accept further input.
                outcome.state = RunState::Exited;
            }
            let mut storage = lock(&managed.storage);
            let run = storage
                .get_run(managed.run)?
                .ok_or(StorageError::RunNotFound(managed.run))?;
            if run.state == RunState::Reserved {
                storage.record_launch(run.id, &managed.receipt.provider_run_ref)?;
            }
            if !run.state.is_active() {
                return Ok(run);
            }
            for (kind, payload) in outcome.events {
                storage.append_run_event(
                    run.id,
                    kind,
                    Some(&adapter::redact(&payload, &managed.secret)),
                )?;
            }
            Ok(storage.finish_run(run.id, outcome.state)?)
        })();
        *managed.end.result.lock().unwrap() = Some(result);
        managed.end.changed.notify_all();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_spans_read_and_line_limit_boundaries_and_bounds_stderr_tail() {
        let secret = "test-token-crossing-buffer";
        let mut text = "x".repeat(8190);
        text.push_str(secret);
        text.push_str(&"y".repeat(adapter::MAX_LINE_BYTES - text.len() - 3));
        text.push_str(secret);
        text.push_str("\nlast line\n");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log");
        let output = File::create(&path).unwrap();
        let mut lines = Vec::new();
        let tail = read_output(std::io::Cursor::new(text), output, secret, true, |line| {
            lines.push(line);
        })
        .unwrap();
        let logged = std::fs::read_to_string(path).unwrap();
        assert!(!logged.contains(secret));
        assert!(!tail.contains(secret));
        assert!(logged.contains("[redacted]"));
        assert!(tail.len() <= MAX_STDERR_TAIL_BYTES);
        assert!(tail.ends_with("last line\n"));
        assert_eq!(lines[1].text, "last line");
    }

    /// Yields its chunks one read at a time and records, at each read, the lines and log
    /// text that had come out before it.
    struct Chunks {
        chunks: VecDeque<Vec<u8>>,
        log: std::path::PathBuf,
        lines: Arc<Mutex<Vec<String>>>,
        seen: Vec<(Vec<String>, String)>,
    }

    impl Read for Chunks {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.seen.push((
                self.lines.lock().unwrap().clone(),
                std::fs::read_to_string(&self.log).unwrap(),
            ));
            let Some(chunk) = self.chunks.pop_front() else {
                return Ok(0);
            };
            buffer[..chunk.len()].copy_from_slice(&chunk);
            Ok(chunk.len())
        }
    }

    #[test]
    fn a_line_shorter_than_the_secret_comes_out_before_the_next_read() {
        let secret = "a-test-bearer-value-much-longer-than-the-first-line-of-output";
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let lines = Arc::new(Mutex::new(Vec::new()));
        let mut first = b"{\"type\":\"init\"}\n".to_vec();
        first.extend_from_slice(&secret.as_bytes()[..7]);
        let mut second = secret.as_bytes()[7..].to_vec();
        second.extend_from_slice(b" end\n");
        let mut input = Chunks {
            chunks: VecDeque::from([first, second]),
            log: log.clone(),
            lines: lines.clone(),
            seen: Vec::new(),
        };
        let output = File::create(&log).unwrap();
        let sink = lines.clone();
        read_output(&mut input, output, secret, true, |line| {
            sink.lock().unwrap().push(line.text)
        })
        .unwrap();
        let (lines_before_second_read, log_before_second_read) = &input.seen[1];
        assert_eq!(lines_before_second_read, &[r#"{"type":"init"}"#]);
        assert_eq!(log_before_second_read, "{\"type\":\"init\"}\n");
        assert_eq!(lines.lock().unwrap()[1], "[redacted] end");
        assert!(!std::fs::read_to_string(&log).unwrap().contains(secret));
    }

    #[test]
    fn redaction_does_not_make_an_overlong_line_parseable() {
        let secret = "a-long-test-bearer-value";
        let text = secret.repeat(adapter::MAX_LINE_BYTES / secret.len() + 1);
        let dir = tempfile::tempdir().unwrap();
        let mut lines = Vec::new();
        read_output(
            std::io::Cursor::new(text),
            File::create(dir.path().join("log")).unwrap(),
            secret,
            true,
            |line| lines.push(line),
        )
        .unwrap();
        assert!(lines[0].truncated);
        assert!(lines[0].text.len() < adapter::MAX_LINE_BYTES);
        assert!(!lines[0].text.contains(secret));
    }
}
