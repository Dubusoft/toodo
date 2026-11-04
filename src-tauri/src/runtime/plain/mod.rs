//! The plain runner: runs the Claude print and Codex exec CLIs directly in a task's
//! worktree, without herdr.

pub mod adapter;

#[cfg(unix)]
mod process;
#[cfg(unix)]
mod remote;
#[cfg(all(test, unix))]
mod tests;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{LaunchReceipt, LaunchSpec, RunCommand, RunLauncher, RunnerError, RuntimeError, lock};
use crate::domain::runtime::{HostRef, RunId, RunState, RunnerKind};
use crate::storage::{Storage, StorageError, TaskRun};
use adapter::{AgentAdapter, McpEndpoint};

/// Supplies the current MCP credentials at launch time, after the server starts listening.
pub type McpProvider = Arc<dyn Fn() -> Option<McpEndpoint> + Send + Sync>;

/// Returns true only while the target's reverse MCP tunnel is Open.
pub type TunnelOpenProvider = Arc<dyn Fn(&str) -> bool + Send + Sync>;

struct LiveRun {
    run: RunId,
    receipt: LaunchReceipt,
    stop: mpsc::Sender<process::Signal>,
    end: Arc<Completion>,
}

#[derive(Default)]
struct Completion {
    result: Mutex<Option<Result<TaskRun, RuntimeError>>>,
    changed: Condvar,
}

/// Runs agent CLIs in local or SSH checkouts and records their outcomes in storage.
#[derive(Clone)]
pub struct PlainRunner {
    storage: Arc<Mutex<Storage>>,
    runs_dir: PathBuf,
    instance: String,
    claude: PathBuf,
    codex: PathBuf,
    registry: Arc<Mutex<HashMap<String, LiveRun>>>,
    mcp: Option<McpProvider>,
    tunnel_open: Option<TunnelOpenProvider>,
    ssh: PathBuf,
}

/// The redacted tails of a run's stdout and stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunLog {
    pub stdout: String,
    pub stderr: String,
}

fn io_error(error: std::io::Error) -> RunnerError {
    RunnerError(format!(
        "{error}; check the local checkout and runs directory permissions, then start a new run"
    ))
}

/// The adapter and the timeout deadline (Unix seconds) of a local run, which a later server
/// process needs to reattach it.
const LAUNCH_FILE: &str = "launch";

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Opens an existing private log for writing from its start.
fn rewritten_file(path: &Path) -> Result<File, RunnerError> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_error)
}

/// Counts the complete lines in `path`.
fn complete_lines(path: &Path) -> Result<usize, RunnerError> {
    let mut file = File::open(path).map_err(io_error)?;
    let mut chunk = [0; 8192];
    let mut lines = 0;
    loop {
        match file.read(&mut chunk).map_err(io_error)? {
            0 => return Ok(lines),
            count => lines += chunk[..count].iter().filter(|&&byte| byte == b'\n').count(),
        }
    }
}

fn private_file(path: &Path, contents: &[u8]) -> Result<File, RunnerError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(io_error)?;
    file.write_all(contents).map_err(io_error)?;
    file.rewind().map_err(io_error)?;
    Ok(file)
}

impl PlainRunner {
    pub fn new(storage: Arc<Mutex<Storage>>, runs_dir: impl Into<PathBuf>, instance: &str) -> Self {
        Self {
            storage,
            runs_dir: runs_dir.into(),
            instance: instance.to_owned(),
            claude: "claude".into(),
            codex: "codex".into(),
            registry: Arc::new(Mutex::new(HashMap::new())),
            mcp: None,
            tunnel_open: None,
            ssh: "ssh".into(),
        }
    }

    #[cfg(test)]
    pub fn with_programs(mut self, claude: impl Into<PathBuf>, codex: impl Into<PathBuf>) -> Self {
        self.claude = claude.into();
        self.codex = codex.into();
        self
    }

    #[cfg(test)]
    pub fn with_ssh_program(mut self, ssh: impl Into<PathBuf>) -> Self {
        self.ssh = ssh.into();
        self
    }

    pub fn with_mcp_provider(mut self, provider: McpProvider) -> Self {
        self.mcp = Some(provider);
        self
    }

    pub fn with_tunnel_open_provider(mut self, provider: TunnelOpenProvider) -> Self {
        self.tunnel_open = Some(provider);
        self
    }

    /// Requests termination of a live process group and waits for its persisted outcome.
    /// Remote runs must confirm their identity-checked stop even without a live stream.
    pub fn stop(&self, run: RunId) -> Result<TaskRun, RuntimeError> {
        let current = lock(&self.storage)
            .get_run(run)?
            .ok_or(StorageError::RunNotFound(run))?;
        if !current.state.is_active() {
            return Ok(current);
        }
        let remote = remote::Remote::from_run(
            &current.host,
            current.checkout_path.as_deref(),
            &self.ssh,
            &self.instance,
        )?;
        let live = self.registry.lock().unwrap();
        if let Some(entry) = live.values().find(|entry| {
            entry.run == run && (remote.is_none() || entry.end.result.lock().unwrap().is_none())
        }) {
            let end = entry.end.clone();
            let sender = entry.stop.clone();
            drop(live);
            if remote.is_some() {
                let (reply, response) = mpsc::channel();
                if sender.send(process::Signal::RemoteStop(reply)).is_ok() {
                    response.recv().map_err(|_| RunnerError(
                        "remote stop observation ended; reconcile the run once the host is reachable".into()
                    ))??;
                }
            } else {
                let _ = sender.send(process::Signal::Stop);
            }
            let mut result = end.result.lock().unwrap();
            while result.is_none() {
                result = end.changed.wait(result).unwrap();
            }
            if let Some(Err(error)) = result.as_ref() {
                return Err(RunnerError(format!(
                    "{error}; read the run log and restart the server before starting a new run"
                ))
                .into());
            }
            return Ok(result.as_ref().unwrap().as_ref().unwrap().clone());
        }
        drop(live);
        if let Some(remote) = &remote {
            lock(&self.storage).append_run_event(run, "stop_requested", None)?;
            remote.stop(run)?;
        }
        let finished = {
            let mut storage = lock(&self.storage);
            let current = storage
                .get_run(run)?
                .ok_or(StorageError::RunNotFound(run))?;
            if !current.state.is_active() {
                return Ok(current);
            }
            if current.host == HostRef::Local {
                storage.append_run_event(run, "stop_requested", None)?;
            }
            storage.finish_run(run, RunState::Cancelled)?
        };
        if let Some(remote) = &remote {
            remote.remove_credentials(&self.storage, run);
        }
        Ok(finished)
    }

    /// Settles durable remote evidence without restarting or reattaching the agent.
    pub fn reconcile(&self, run: RunId) -> Result<TaskRun, RuntimeError> {
        let current = lock(&self.storage)
            .get_run(run)?
            .ok_or(StorageError::RunNotFound(run))?;
        if !matches!(current.state, RunState::Running | RunState::Unknown) {
            return Ok(current);
        }
        let Some(remote) = remote::Remote::from_run(
            &current.host,
            current.checkout_path.as_deref(),
            &self.ssh,
            &self.instance,
        )?
        else {
            return Ok(current);
        };
        if self
            .registry
            .lock()
            .unwrap()
            .values()
            .any(|entry| entry.run == run && entry.end.result.lock().unwrap().is_none())
        {
            return Ok(current);
        }
        use super::host::Probe;
        let (state, event, payload) = match remote.probe(run)? {
            Probe::Exited(code) => (
                if code == 0 {
                    RunState::Exited
                } else {
                    RunState::Failed
                },
                "exit",
                Some(format!("exit code {code}")),
            ),
            Probe::Running => (RunState::Unknown, "remote_still_running", None),
            Probe::Gone => (RunState::Failed, "interrupted", None),
            Probe::Missing => (RunState::Unknown, "remote_missing", None),
        };
        let finished = {
            let mut storage = lock(&self.storage);
            let current = storage
                .get_run(run)?
                .ok_or(StorageError::RunNotFound(run))?;
            if !current.state.is_active() {
                return Ok(current);
            }
            // Reconciling again in the background must not repeat the same finding.
            if state == RunState::Unknown
                && current.state == RunState::Unknown
                && storage
                    .run_events(run)?
                    .last()
                    .is_some_and(|last| last.kind == event)
            {
                return Ok(current);
            }
            storage.append_run_event(run, event, payload.as_deref())?;
            storage.finish_run(run, state)?
        };
        if !finished.state.is_active() {
            remote.remove_credentials(&self.storage, run);
        }
        Ok(finished)
    }

    /// Waits for a managed run to finish, without polling its record.
    #[cfg(test)]
    pub fn wait_for_end(&self, run: RunId, timeout: Duration) -> Option<TaskRun> {
        let end = self
            .registry
            .lock()
            .unwrap()
            .values()
            .find(|entry| entry.run == run)
            .map(|entry| entry.end.clone());
        if let Some(end) = end {
            let result = end.result.lock().unwrap();
            let (result, _) = end
                .changed
                .wait_timeout_while(result, timeout, |result| result.is_none())
                .unwrap();
            return result
                .as_ref()
                .and_then(|result| result.as_ref().ok())
                .cloned();
        }
        lock(&self.storage)
            .get_run(run)
            .ok()
            .flatten()
            .filter(|run| !run.state.is_active())
    }

    pub fn log(&self, run: RunId, tail_bytes: usize) -> Result<RunLog, RuntimeError> {
        lock(&self.storage)
            .get_run(run)?
            .ok_or(StorageError::RunNotFound(run))?;
        let tail = |name| -> Result<String, RunnerError> {
            let path = self.runs_dir.join(run.to_string()).join(name);
            let mut file = match File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(String::new());
                }
                Err(error) => return Err(io_error(error)),
            };
            let size = file.metadata().map_err(io_error)?.len();
            file.seek(SeekFrom::Start(size.saturating_sub(tail_bytes as u64)))
                .map_err(io_error)?;
            let mut bytes = Vec::new();
            file.take(size.min(tail_bytes as u64))
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        };
        Ok(RunLog {
            stdout: tail("stdout.log")?,
            stderr: tail("stderr.log")?,
        })
    }

    /// Takes over the plain runs of an earlier server process. A local run whose wrapper
    /// recorded its PID is reattached: followed while its agent still runs, or settled from
    /// its output and exit code. Other runs become unknown; remote ones are left to
    /// [`Self::reconcile`], since this runs before the server serves and never uses SSH.
    pub fn recover_after_restart(&self) -> Result<(), RuntimeError> {
        let runs = {
            let storage = lock(&self.storage);
            let mut runs = Vec::new();
            for workspace in storage.list_workspaces()? {
                for task in storage.list_tasks(workspace.id)? {
                    runs.extend(storage.list_task_runs(task.id)?.into_iter().filter(|run| {
                        run.runner_kind == RunnerKind::Plain
                            && (matches!(run.state, RunState::Reserved | RunState::Running)
                                || (matches!(run.host, HostRef::Ssh(_))
                                    && run.state == RunState::Unknown))
                    }));
                }
            }
            runs
        };
        for run in runs {
            lock(&self.storage).append_run_event(run.id, "server_restarted", None)?;
            if run.host == HostRef::Local {
                match self.reattach(&run) {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(error) => eprintln!(
                        "toodo-server: could not reattach plain run {} ({error}); it is \
                         unknown now, stop it with stop_run",
                        run.id
                    ),
                }
            }
            lock(&self.storage).finish_run(run.id, RunState::Unknown)?;
        }
        Ok(())
    }

    /// Follows a local run from the files its wrapper left. False when the run predates
    /// them or its wrapper never recorded a PID.
    fn reattach(&self, run: &TaskRun) -> Result<bool, RunnerError> {
        let dir = self.runs_dir.join(run.id.to_string());
        let Ok(launch) = fs::read_to_string(dir.join(LAUNCH_FILE)) else {
            return Ok(false);
        };
        let Some((adapter, deadline)) = launch.trim_end().split_once(' ') else {
            return Ok(false);
        };
        let (Ok(adapter), Ok(deadline)) = (AgentAdapter::parse(adapter), deadline.parse::<u64>())
        else {
            return Ok(false);
        };
        let Some(pid) = process::recorded_wrapper(&dir) else {
            return Ok(false);
        };
        let raw_stdout = dir.join(process::RAW_STDOUT);
        let replayed = complete_lines(&raw_stdout)?;
        let raw = |name| File::open(dir.join(name)).map_err(io_error);
        let (raw_stdout, raw_stderr) = (raw(process::RAW_STDOUT)?, raw(process::RAW_STDERR)?);
        let stdout = rewritten_file(&dir.join("stdout.log"))?;
        let stderr = rewritten_file(&dir.join("stderr.log"))?;
        let receipt = LaunchReceipt {
            provider_run_ref: run.provider_run_ref.clone().unwrap_or_else(|| {
                format!("pid:{}", pid.map_or(String::new(), |pid| pid.to_string()))
            }),
        };
        lock(&self.storage)
            .append_run_event(run.id, "reattached", None)
            .map_err(|error| RunnerError(format!("{error}; restart the server")))?;
        let (sender, receiver) = mpsc::channel();
        let end = Arc::new(Completion::default());
        self.registry.lock().unwrap().insert(
            run.request_key.clone(),
            LiveRun {
                run: run.id,
                receipt: receipt.clone(),
                stop: sender.clone(),
                end: end.clone(),
            },
        );
        process::manage(process::ManagedRun {
            watch: process::Watch::Reattached {
                pid,
                dir,
                stdout: raw_stdout,
                stderr: raw_stderr,
                replayed,
            },
            sender,
            receiver,
            stdout,
            stderr,
            adapter,
            secret: self
                .mcp
                .as_ref()
                .and_then(|provider| provider())
                .map(|endpoint| endpoint.token)
                .unwrap_or_default(),
            timeout: Duration::from_secs(deadline.saturating_sub(unix_now())),
            storage: self.storage.clone(),
            run: run.id,
            receipt,
            end,
            remote: None,
        });
        Ok(true)
    }
}

impl RunLauncher for PlainRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Plain
    }

    fn find_launch(&self, spec: &LaunchSpec) -> Result<Option<LaunchReceipt>, RunnerError> {
        Ok(self
            .registry
            .lock()
            .unwrap()
            .get(&spec.request_key)
            .map(|entry| entry.receipt.clone()))
    }

    fn launch(&self, spec: &LaunchSpec) -> Result<LaunchReceipt, RunnerError> {
        let RunCommand::Agent(agent) = &spec.command else {
            return Err(RunnerError(
                "start a run with runner plain and an Agent command".to_owned(),
            ));
        };
        let cwd = spec.cwd.as_deref().ok_or_else(|| {
            RunnerError("start the task in a worktree before starting a plain run".to_owned())
        })?;
        let remote =
            remote::Remote::from_run(&spec.host, spec.cwd.as_deref(), &self.ssh, &self.instance)?;
        let mut registry = self.registry.lock().unwrap();
        if let Some(entry) = registry.get(&spec.request_key) {
            return Ok(entry.receipt.clone());
        }
        if agent.mcp
            && let HostRef::Ssh(target) = &spec.host
            && !self.tunnel_open.as_ref().is_some_and(|open| open(target))
        {
            return Err(RunnerError(format!(
                "the MCP reverse tunnel for {target} is not Open; wait for the tunnel to open or start the run with mcp false"
            )));
        }
        let mut endpoint = if agent.mcp {
            Some(
                self.mcp
                    .as_ref()
                    .and_then(|provider| provider())
                    .ok_or_else(|| {
                        RunnerError(
                            "configure the server MCP endpoint, or start the run with mcp false"
                                .to_owned(),
                        )
                    })?,
            )
        } else {
            None
        };
        if remote.is_some()
            && let Some(endpoint) = &mut endpoint
        {
            let url = reqwest::Url::parse(&endpoint.url).map_err(|_| {
                RunnerError(
                    "configure a valid server MCP endpoint URL, or start the run with mcp false"
                        .into(),
                )
            })?;
            let port = url.port_or_known_default().ok_or_else(|| {
                RunnerError(
                    "configure the server MCP endpoint port, or start the run with mcp false"
                        .into(),
                )
            })?;
            endpoint.url = format!("http://127.0.0.1:{port}/mcp");
        }
        if let Some(remote) = &remote {
            remote.check_launcher()?;
        }
        fs::create_dir_all(&self.runs_dir).map_err(io_error)?;
        let dir = self.runs_dir.join(spec.run.to_string());
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&dir).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                RunnerError(format!(
                    "remove the leftover directory {} on local host, then start a new run",
                    dir.display()
                ))
            } else {
                io_error(error)
            }
        })?;
        if let Some(remote) = &remote {
            remote.create_directory(spec.run)?;
        }
        let brief = private_file(&dir.join("brief.md"), agent.brief.as_bytes())?;
        let stdout = private_file(&dir.join("stdout.log"), b"")?;
        let stderr = private_file(&dir.join("stderr.log"), b"")?;
        let invocation = agent.adapter.invocation(
            &dir,
            endpoint.as_ref(),
            agent.resume.as_ref().map(|resume| resume.session.as_str()),
        );
        for (name, contents) in &invocation.files {
            private_file(&dir.join(name), contents.as_bytes())?;
        }
        let program = match agent.adapter {
            AgentAdapter::Claude => &self.claude,
            AgentAdapter::Codex => &self.codex,
        };
        let (watch, sender, receiver) = if let Some(remote) = &remote {
            remote.stage(spec.run, "brief.md", agent.brief.as_bytes())?;
            for (name, contents) in &invocation.files {
                remote.stage(spec.run, name, contents.as_bytes())?;
            }
            if let Some(endpoint) = &endpoint {
                remote.stage(spec.run, "token", endpoint.token.as_bytes())?;
            }
            let (child, sender, receiver) = remote.spawn(spec.run, cwd, program, &invocation)?;
            (process::Watch::Pipes(child), sender, receiver)
        } else {
            let deadline = unix_now().saturating_add(agent.timeout_secs);
            private_file(
                &dir.join(LAUNCH_FILE),
                format!("{} {deadline}\n", agent.adapter.as_wire()).as_bytes(),
            )?;
            let raw_stdout = private_file(&dir.join(process::RAW_STDOUT), b"")?;
            let raw_stderr = private_file(&dir.join(process::RAW_STDERR), b"")?;
            let raw = |name| File::open(dir.join(name)).map_err(io_error);
            let (out, err) = (raw(process::RAW_STDOUT)?, raw(process::RAW_STDERR)?);
            let child = process::spawn_local(
                program,
                cwd,
                &dir,
                brief,
                raw_stdout,
                raw_stderr,
                &invocation,
            )?;
            let (sender, receiver) = mpsc::channel();
            (
                process::Watch::Files {
                    child,
                    dir: dir.clone(),
                    stdout: out,
                    stderr: err,
                },
                sender,
                receiver,
            )
        };
        let receipt = LaunchReceipt {
            provider_run_ref: match (&spec.host, &watch) {
                (HostRef::Local, process::Watch::Files { child, .. }) => {
                    format!("pid:{}", child.id())
                }
                (HostRef::Local, _) => unreachable!("local runs are watched through files"),
                (HostRef::Ssh(target), _) => format!("ssh:{target}:{}", spec.run),
            },
        };
        let end = Arc::new(Completion::default());
        registry.insert(
            spec.request_key.clone(),
            LiveRun {
                run: spec.run,
                receipt: receipt.clone(),
                stop: sender.clone(),
                end: end.clone(),
            },
        );
        process::manage(process::ManagedRun {
            watch,
            sender,
            receiver,
            stdout,
            stderr,
            adapter: agent.adapter,
            secret: endpoint.map(|endpoint| endpoint.token).unwrap_or_default(),
            timeout: Duration::from_secs(agent.timeout_secs),
            storage: self.storage.clone(),
            run: spec.run,
            receipt: receipt.clone(),
            end,
            remote,
        });
        Ok(receipt)
    }
}
