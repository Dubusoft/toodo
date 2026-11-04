//! Managed agent processes: pipe readers, process-group termination, and persisted outcomes.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use super::adapter::{
    self, AgentAdapter, EventTracker, ExitKind, Invocation, LineSplitter, MAX_STDERR_TAIL_BYTES,
    MCP_TOKEN_ENV, MCP_URL_ENV,
};
use super::{Completion, LaunchReceipt, RunnerError, RuntimeError, io_error, lock};
use crate::domain::runtime::{RunId, RunState, RunUsage};
use crate::storage::{Storage, StorageError, TaskRun};

pub(super) enum Signal {
    Stop,
    RemoteStop(mpsc::Sender<Result<(), RunnerError>>),
    Exit(std::io::Result<ExitStatus>),
    /// The agent of a reattached run ended without recording its exit code.
    Interrupted,
    Stdout(std::io::Result<EventTracker>),
    Stderr(std::io::Result<String>),
}

/// Files of a local run directory that outlive the server process: the agent's raw output,
/// the wrapper's PID and start time, its exit code, and the launch parameters.
pub(super) const RAW_STDOUT: &str = "stdout.raw";
pub(super) const RAW_STDERR: &str = "stderr.raw";
const PID_FILE: &str = "pid";
const EXIT_FILE: &str = "exit";

/// How often a reader at the end of a raw output file looks for more output, and a
/// reattached run's watcher for its exit.
const FOLLOW_INTERVAL: Duration = Duration::from_millis(100);
const EXIT_INTERVAL: Duration = Duration::from_millis(250);

/// Runs the agent in its own session-independent process group, ignoring the hangup of a
/// server that goes away. Its PID, start time, and exit code go to the run directory in
/// `$1`, so a later server process can tell whether it still runs and how it ended.
const LOCAL_WRAPPER: &str = r#"run=$1
shift
trap '' HUP
(umask 077; printf '%s %s\n' "$$" "$(LC_ALL=C ps -o lstart= -p $$)" > "$run/pid")
"$@"
code=$?
(umask 077; printf '%s\n' "$code" > "$run/exit")
exit "$code"
"#;

fn launch_error(program: &Path, key: &str, error: impl std::fmt::Display) -> RunnerError {
    RunnerError(format!(
        "could not launch {}: {error}; install {key} on the server's PATH or start the run with the other adapter",
        program.display()
    ))
}

/// Finds an executable `program` as a shell would: a path with a slash as it is, a bare
/// name on `PATH`.
fn resolve(program: &Path) -> Option<PathBuf> {
    let executable = |path: &Path| {
        fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    };
    if program.components().count() > 1 || program.is_absolute() {
        return executable(program).then(|| program.to_owned());
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|path| executable(path))
}

/// Starts the agent under [`LOCAL_WRAPPER`] with the brief on stdin and its output going
/// straight to the raw output files, so it neither needs nor notices this server process.
pub(super) fn spawn_local(
    program: &Path,
    cwd: &str,
    dir: &Path,
    brief: File,
    stdout: File,
    stderr: File,
    invocation: &Invocation,
) -> Result<Child, RunnerError> {
    let resolved = resolve(program)
        .ok_or_else(|| launch_error(program, invocation.program_key, "not found"))?;
    Command::new("/bin/sh")
        .arg("-c")
        .arg(LOCAL_WRAPPER)
        .arg("sh")
        .arg(dir)
        .arg(resolved)
        .args(&invocation.args)
        .env_remove(MCP_URL_ENV)
        .env_remove(MCP_TOKEN_ENV)
        .envs(invocation.env.iter().cloned())
        .current_dir(cwd)
        .stdin(brief)
        .stdout(stdout)
        .stderr(stderr)
        .process_group(0)
        .spawn()
        .map_err(|error| launch_error(program, invocation.program_key, error))
}

/// The recorded exit code of a local run, once its wrapper wrote it completely.
fn recorded_exit(dir: &Path) -> Option<i32> {
    fs::read_to_string(dir.join(EXIT_FILE))
        .ok()?
        .strip_suffix('\n')?
        .parse()
        .ok()
}

fn start_identity(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let identity = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (output.status.success() && !identity.is_empty()).then_some(identity)
}

/// What an earlier server process left of a local run's wrapper: `None` without a PID
/// file, `Some(None)` when the recorded process is gone (or its PID was reused), and
/// `Some(Some(pid))` while it still runs.
pub(super) fn recorded_wrapper(dir: &Path) -> Option<Option<u32>> {
    let record = fs::read_to_string(dir.join(PID_FILE)).ok()?;
    let (pid, identity) = record.trim_end().split_once(' ')?;
    let pid: u32 = pid.parse().ok()?;
    Some((start_identity(pid).as_deref() == Some(identity.trim())).then_some(pid))
}

/// Reads a raw output file that another process is still writing: at its end it waits for
/// more until `done` is set, then reads what is left and reports the end.
struct Follow {
    file: File,
    done: Arc<AtomicBool>,
}

impl Read for Follow {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let finished = self.done.load(Ordering::Acquire);
            let count = self.file.read(buffer)?;
            if count > 0 || finished {
                return Ok(count);
            }
            thread::sleep(FOLLOW_INTERVAL);
        }
    }
}

/// How the server learns a run's output and exit.
pub(super) enum Watch {
    /// Remote runs: the `ssh` child streams the output on its pipes.
    Pipes(Child),
    /// Local runs this server started: the wrapper is its child, the output in raw files.
    Files {
        child: Child,
        dir: PathBuf,
        stdout: File,
        stderr: File,
    },
    /// Local runs an earlier server process started. `pid` is the wrapper while it runs;
    /// the first `replayed` stdout lines were already recorded before the restart.
    Reattached {
        pid: Option<u32>,
        dir: PathBuf,
        stdout: File,
        stderr: File,
        replayed: usize,
    },
}

pub(super) struct ManagedRun {
    pub watch: Watch,
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

/// Appends a `todo` event while the run is active. A storage error is logged, never
/// fatal: the reader must keep draining stdout.
fn record_todo(storage: &Arc<Mutex<Storage>>, run: RunId, payload: &str) {
    let mut storage = lock(storage);
    let result = storage.get_run(run).and_then(|found| match found {
        Some(found) if found.state.is_active() => storage
            .append_run_event(run, "todo", Some(payload))
            .map(drop),
        _ => Ok(()),
    });
    if let Err(error) = result {
        eprintln!("toodo: failed to record the todo list of run {run}: {error}");
    }
}

/// How often, at most, a run's last activity is stored while its agent keeps writing;
/// a change of the reported usage is stored at once.
const ACTIVITY_INTERVAL: Duration = Duration::from_secs(5);

/// Stores when the agent of a run last wrote output, at most every
/// [`ACTIVITY_INTERVAL`] unless its usage changed.
struct ActivityRecorder {
    stored_at: Option<Instant>,
    usage: Option<RunUsage>,
    pending: bool,
}

impl ActivityRecorder {
    fn new() -> Self {
        Self {
            stored_at: None,
            usage: None,
            pending: false,
        }
    }

    fn line(&mut self, storage: &Arc<Mutex<Storage>>, run: RunId, usage: Option<RunUsage>) {
        self.pending = true;
        if usage != self.usage
            || self
                .stored_at
                .is_none_or(|at| at.elapsed() >= ACTIVITY_INTERVAL)
        {
            self.usage = usage;
            self.flush(storage, run);
        }
    }

    /// Stores the activity not stored yet. A storage error is logged, never fatal: the
    /// reader must keep draining stdout.
    fn flush(&mut self, storage: &Arc<Mutex<Storage>>, run: RunId) {
        if !self.pending {
            return;
        }
        self.pending = false;
        self.stored_at = Some(Instant::now());
        if let Err(error) = lock(storage).record_run_activity(run, self.usage) {
            eprintln!("toodo: failed to record the activity of run {run}: {error}");
        }
    }
}

/// Sends the exit of a reattached run's wrapper, which is not this process's child: its
/// recorded exit code, or [`Signal::Interrupted`] once it is gone without one.
fn watch_reattached(
    pid: Option<u32>,
    dir: PathBuf,
    done: Arc<AtomicBool>,
    sender: mpsc::Sender<Signal>,
) {
    loop {
        let alive = pid.is_some_and(|pid| signal_group(pid, 0));
        if let Some(code) = recorded_exit(&dir) {
            done.store(true, Ordering::Release);
            let _ = sender.send(Signal::Exit(Ok(ExitStatus::from_raw((code & 0xff) << 8))));
            return;
        }
        if !alive {
            done.store(true, Ordering::Release);
            let _ = sender.send(Signal::Interrupted);
            return;
        }
        thread::sleep(EXIT_INTERVAL);
    }
}

/// A stream of the agent's output.
type Output = Box<dyn Read + Send>;
/// Waits for the agent's exit and sends it.
type Waiter = Box<dyn FnOnce(mpsc::Sender<Signal>) + Send>;

pub(super) fn manage(managed: ManagedRun) {
    let done = Arc::new(AtomicBool::new(false));
    let follow = |file| -> Output {
        Box::new(Follow {
            file,
            done: done.clone(),
        })
    };
    let (pid, stdout, stderr, replayed, raw, waiter): (
        Option<u32>,
        Output,
        Output,
        usize,
        Option<PathBuf>,
        Waiter,
    ) = match managed.watch {
        Watch::Pipes(mut child) => (
            Some(child.id()),
            Box::new(child.stdout.take().unwrap()),
            Box::new(child.stderr.take().unwrap()),
            0,
            None,
            Box::new(move |sender| {
                let _ = sender.send(Signal::Exit(child.wait()));
            }),
        ),
        Watch::Files {
            mut child,
            dir,
            stdout,
            stderr,
        } => {
            let done = done.clone();
            (
                Some(child.id()),
                follow(stdout),
                follow(stderr),
                0,
                Some(dir),
                Box::new(move |sender| {
                    let status = child.wait();
                    done.store(true, Ordering::Release);
                    let _ = sender.send(Signal::Exit(status));
                }),
            )
        }
        Watch::Reattached {
            pid,
            dir,
            stdout,
            stderr,
            replayed,
        } => {
            let done = done.clone();
            (
                pid,
                follow(stdout),
                follow(stderr),
                replayed,
                Some(dir.clone()),
                Box::new(move |sender| watch_reattached(pid, dir, done, sender)),
            )
        }
    };
    let signal = move |signal| pid.is_some_and(|pid| signal_group(pid, signal));
    let sender = managed.sender.clone();
    let secret = managed.secret.clone();
    let adapter = managed.adapter;
    let storage = managed.storage.clone();
    let run = managed.run;
    thread::spawn(move || {
        let mut tracker = EventTracker::new(adapter);
        let mut activity = ActivityRecorder::new();
        let mut lines = 0;
        let result = read_output(stdout, managed.stdout, &secret, true, |line| {
            lines += 1;
            // Replayed lines rebuild the tracker; their events were recorded before.
            let replay = lines <= replayed;
            if !line.truncated
                && let Some(payload) = tracker.feed(&line.text)
                && !replay
            {
                record_todo(&storage, run, &adapter::redact(&payload, &secret));
            }
            if !replay {
                activity.line(&storage, run, tracker.usage());
            }
        });
        activity.flush(&storage, run);
        let result = result.map(|_| tracker);
        let _ = sender.send(Signal::Stdout(result));
    });
    let sender = managed.sender.clone();
    let secret = managed.secret.clone();
    thread::spawn(move || {
        let result = read_output(stderr, managed.stderr, &secret, false, |_| {});
        let _ = sender.send(Signal::Stderr(result));
    });
    let sender = managed.sender;
    thread::spawn(move || waiter(sender));
    thread::spawn(move || {
        let mut deadline = Instant::now() + managed.timeout;
        let mut termination = None;
        let mut killed = false;
        let mut exit = None;
        let mut tracker = None;
        let mut stderr = None;
        let mut observation_lost = false;
        let mut interrupted = false;
        while exit.is_none()
            || tracker.is_none()
            || stderr.is_none()
            || (termination.is_some() && !killed && signal(0))
        {
            match managed
                .receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(Signal::Stop) if termination.is_none() => {
                    termination = Some(ExitKind::Stopped);
                    signal(libc::SIGTERM);
                    deadline = Instant::now() + Duration::from_secs(5);
                }
                Ok(Signal::Stop) => {}
                Ok(Signal::RemoteStop(reply)) => {
                    let mut result = managed.remote.as_ref().unwrap().stop(managed.run);
                    if result.is_ok() {
                        termination = Some(ExitKind::Stopped);
                        signal(libc::SIGTERM);
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
                Ok(Signal::Interrupted) => {
                    interrupted = true;
                    exit = Some(Ok(ExitStatus::from_raw(0)));
                }
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
                        signal(libc::SIGTERM);
                        deadline = Instant::now() + Duration::from_secs(5);
                    } else if !killed {
                        signal(libc::SIGKILL);
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
            if interrupted && termination.is_none() {
                outcome.state = RunState::Failed;
                outcome.events = vec![(
                    "interrupted",
                    "the agent ended while the server was down and recorded no exit code; read \
                     the run log and start a new run"
                        .into(),
                )];
            }
            if observation_lost {
                outcome.state = RunState::Unknown;
                outcome.events = vec![(
                    "observation_lost",
                    "SSH observation was lost; reconcile the run once the host is reachable".into(),
                )];
            }
            let mut storage = lock(&managed.storage);
            let run = storage
                .get_run(managed.run)?
                .ok_or(StorageError::RunNotFound(managed.run))?;
            if run.state == RunState::Reserved {
                storage.record_launch(run.id, &managed.receipt.provider_run_ref)?;
            }
            // A stopped or failed run keeps its session, so a follow-up can resume it.
            if let Some(session) = tracker.session_id() {
                storage.record_run_session(run.id, session)?;
            }
            if !run.state.is_active() {
                return Ok(run);
            }
            if let Some(session) = tracker.session_id() {
                storage.append_run_event(
                    run.id,
                    "agent_session",
                    Some(&adapter::redact(session, &managed.secret)),
                )?;
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
        // An agent that may still run keeps its credentials until the run ends.
        if let (Some(remote), Ok(run)) = (&managed.remote, &result)
            && !run.state.is_active()
        {
            remote.remove_credentials(&managed.storage, run.id);
        }
        // The raw output is not redacted; the redacted logs replace it once the run ended.
        if let (Some(dir), Ok(run)) = (&raw, &result)
            && !run.state.is_active()
        {
            for name in [RAW_STDOUT, RAW_STDERR] {
                let _ = fs::remove_file(dir.join(name));
            }
        }
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
