//! Detached POSIX tmux sessions. Terminal attachment is a view, not a control channel;
//! structured agent output is read from separate, redacted durable logs.

#[cfg(all(test, unix))]
mod tests;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Condvar, Mutex};

use super::host::{self, Host, HostOs, Probe, RunKey};
use super::plain::adapter::{
    self, AgentAdapter, EventTracker, ExitKind, MCP_TOKEN_ENV, MCP_URL_ENV,
};
use super::plain::{McpProvider, RunLog, TunnelOpenProvider};
use super::{LaunchReceipt, LaunchSpec, RunCommand, RunLauncher, RunnerError, RuntimeError};
use crate::adapters::git::{Invocation, shell_quote};
use crate::domain::model::{HostPath, MachineLabel};
use crate::domain::runtime::{HostRef, RunId, RunState, RunnerKind};
use crate::storage::{Storage, StorageError, TaskRun};

const MAX_LOG_BYTES: usize = 4 * 1024 * 1024;

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Default)]
struct Observation {
    result: Mutex<Option<Result<TaskRun, RuntimeError>>>,
    changed: Condvar,
}

/// All configuration must be applied before sharing the runner with commands.
#[derive(Clone)]
pub struct TmuxRunner {
    storage: Arc<Mutex<Storage>>,
    runs_dir: PathBuf,
    instance: String,
    tmux: PathBuf,
    socket: Option<String>,
    ssh: PathBuf,
    claude: PathBuf,
    codex: PathBuf,
    mcp: Option<McpProvider>,
    tunnel_open: Option<TunnelOpenProvider>,
    observations: Arc<Mutex<HashMap<RunId, Arc<Observation>>>>,
    // Serializes stop and completion so a late observation cannot undo cancellation.
    operations: Arc<Mutex<()>>,
}

fn error() -> RunnerError {
    RunnerError("tmux operation failed; restore SSH connectivity or check the local run directory, then reconcile the run".into())
}

fn receipt(instance: &str, run: RunId, host: &HostRef) -> LaunchReceipt {
    LaunchReceipt {
        provider_run_ref: format!(
            "tmux:{}:{}",
            host.as_wire(),
            host::session(RunKey { instance, id: run })
        ),
    }
}

impl TmuxRunner {
    pub fn new(storage: Arc<Mutex<Storage>>, runs_dir: impl Into<PathBuf>, instance: &str) -> Self {
        Self {
            storage,
            runs_dir: runs_dir.into(),
            instance: instance.to_owned(),
            tmux: "tmux".into(),
            socket: None,
            ssh: "ssh".into(),
            claude: "claude".into(),
            codex: "codex".into(),
            mcp: None,
            tunnel_open: None,
            observations: Arc::default(),
            operations: Arc::default(),
        }
    }

    fn key(&self, id: RunId) -> RunKey<'_> {
        RunKey {
            instance: &self.instance,
            id,
        }
    }

    #[cfg(test)]
    pub fn with_tmux_program(mut self, program: impl Into<PathBuf>) -> Self {
        self.tmux = program.into();
        self
    }

    /// A private tmux server name, for isolated integration tests.
    #[cfg(test)]
    pub fn with_socket(mut self, socket: impl Into<String>) -> Self {
        self.socket = Some(socket.into());
        self
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

    /// Waits for the observation of a run to settle it, without polling its record.
    #[cfg(test)]
    pub fn wait_for_end(&self, run: RunId, timeout: std::time::Duration) -> Option<TaskRun> {
        let observation = lock(&self.observations).get(&run).cloned()?;
        let result = lock(&observation.result);
        let (result, _) = observation
            .changed
            .wait_timeout_while(result, timeout, |result| result.is_none())
            .unwrap();
        result
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .cloned()
    }

    pub fn with_mcp_provider(mut self, provider: McpProvider) -> Self {
        self.mcp = Some(provider);
        self
    }

    pub fn with_tunnel_open_provider(mut self, provider: TunnelOpenProvider) -> Self {
        self.tunnel_open = Some(provider);
        self
    }

    fn host(&self, host: &HostRef, cwd: Option<&str>) -> Result<Host, RunnerError> {
        match host {
            HostRef::Local => Ok(Host::Local),
            HostRef::Ssh(target) => {
                let path = cwd
                    .and_then(|cwd| HostPath::parse_stored(cwd).ok())
                    .ok_or_else(|| {
                        RunnerError(
                            "set an absolute remote checkout path, then start a new run".into(),
                        )
                    })?;
                if path.is_windows() {
                    return Err(RunnerError(
                        "tmux requires a POSIX SSH host; choose runner plain on Windows".into(),
                    ));
                }
                Ok(Host::Ssh {
                    target: MachineLabel::parse(target).map_err(|_| {
                        RunnerError("select a saved SSH target, then start a new run".into())
                    })?,
                    os: HostOs::Posix,
                })
            }
        }
    }

    fn directory(&self, host: &Host, run: RunId) -> String {
        match host {
            Host::Local => shell_quote(&self.runs_dir.join(run.to_string()).to_string_lossy()),
            Host::Ssh { .. } => host::run_directory(HostOs::Posix, self.key(run)),
        }
    }

    fn localize(&self, host: &Host, run: RunId, script: String) -> String {
        if *host == Host::Local {
            script.replacen(
                &host::run_directory(HostOs::Posix, self.key(run)),
                &self.directory(host, run),
                1,
            )
        } else {
            script
        }
    }

    fn tmux_words(&self) -> String {
        let mut words = shell_quote(&self.tmux.to_string_lossy());
        if let Some(socket) = &self.socket {
            words.push_str(&format!(" -L {} -f /dev/null", shell_quote(socket)));
        }
        words
    }

    /// Adapt host builders for a configured binary/socket without changing their
    /// quoting or SSH transport contract.
    fn command(&self, host: &Host, run: RunId, invocation: Invocation) -> Command {
        let mut command;
        match host {
            Host::Local => {
                if invocation.program == "tmux" {
                    command = Command::new(&self.tmux);
                    if let Some(socket) = &self.socket {
                        command.args(["-L", socket, "-f", "/dev/null"]);
                    }
                    command.args(invocation.args);
                } else {
                    command = Command::new(invocation.program);
                    command.args(
                        invocation
                            .args
                            .into_iter()
                            .map(|arg| self.localize(host, run, arg)),
                    );
                }
            }
            Host::Ssh { .. } => {
                command = Command::new(&self.ssh);
                command.args(invocation.args.into_iter().map(
                    |arg| match arg.strip_prefix("tmux ") {
                        Some(rest) => format!("{} {rest}", self.tmux_words()),
                        None => arg,
                    },
                ));
            }
        }
        command.env_remove(MCP_TOKEN_ENV).env_remove(MCP_URL_ENV);
        command
    }

    fn output(
        &self,
        host: &Host,
        run: RunId,
        invocation: Invocation,
    ) -> Result<Output, RunnerError> {
        self.command(host, run, invocation)
            .stdin(Stdio::null())
            .output()
            .map_err(|_| error())
    }

    fn checked(
        &self,
        host: &Host,
        run: RunId,
        invocation: Invocation,
    ) -> Result<String, RunnerError> {
        let output = self.output(host, run, invocation)?;
        if !output.status.success() {
            return Err(error());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn has_session(&self, host: &Host, run: RunId) -> Result<bool, RunnerError> {
        let output = self
            .output(
                host,
                run,
                host.tmux_has_session(self.key(run)).map_err(build_error)?,
            )
            .map_err(|_| {
                if *host == Host::Local {
                    install_error()
                } else {
                    error()
                }
            })?;
        match output.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            Some(127) => Err(install_error()),
            _ => Err(error()),
        }
    }

    fn stage(&self, host: &Host, run: RunId, name: &str, bytes: &[u8]) -> Result<(), RunnerError> {
        let mut child = self
            .command(host, run, host.stage(self.key(run), name))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| error())?;
        let written = child.stdin.take().unwrap().write_all(bytes);
        let status = child.wait().map_err(|_| error())?;
        if written.is_err() || !status.success() {
            return Err(error());
        }
        Ok(())
    }

    fn owns_request(&self, host: &Host, spec: &LaunchSpec) -> Result<bool, RunnerError> {
        let dir = self.directory(host, spec.run);
        let script = format!(
            "test -f {dir}/request && test \"$(cat -- {dir}/request)\" = {}",
            shell_quote(&request_marker(spec))
        );
        let output = self.output(host, spec.run, script_invocation(host, script))?;
        match output.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(error()),
        }
    }

    fn create_directory(&self, host: &Host, run: RunId) -> Result<(), RunnerError> {
        let output = self.output(host, run, host.create_directory(self.key(run)))?;
        if output.status.code() == Some(73) {
            return Err(RunnerError(
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        if !output.status.success() {
            return Err(error());
        }
        Ok(())
    }

    fn current(&self, run: RunId) -> Result<TaskRun, RuntimeError> {
        Ok(lock(&self.storage)
            .get_run(run)?
            .ok_or(StorageError::RunNotFound(run))?)
    }

    fn tail(
        &self,
        host: &Host,
        run: RunId,
        name: &str,
        bytes: usize,
    ) -> Result<String, RunnerError> {
        self.checked(
            host,
            run,
            host.tail(self.key(run), name, bytes.min(MAX_LOG_BYTES))
                .map_err(build_error)?,
        )
    }

    fn secret(&self, host: &Host, run: RunId) -> Result<String, RunnerError> {
        // Read the staged credential, not the current provider's possibly rotated token.
        let script = format!(
            "if [ -f {dir}/token ]; then cat -- {dir}/token; fi",
            dir = self.directory(host, run)
        );
        self.checked(host, run, script_invocation(host, script))
    }

    fn cleanup(&self, host: &Host, run: RunId) -> Result<(), RuntimeError> {
        let script = format!(
            "rm -f -- {dir}/token {dir}/mcp.json",
            dir = self.directory(host, run)
        );
        if self
            .checked(host, run, script_invocation(host, script))
            .is_err()
        {
            lock(&self.storage).append_run_event(
                run, "credential_cleanup_failed",
                Some("could not remove staged credentials; restore connectivity and remove token and mcp.json from the run directory"),
            )?;
        }
        Ok(())
    }

    fn finish(&self, host: &Host, run: RunId, code: i32) -> Result<TaskRun, RuntimeError> {
        let current = self.current(run)?;
        if !current.state.is_active() {
            return Ok(current);
        }
        let secret = self.secret(host, run)?;
        let stdout = adapter::redact(&self.tail(host, run, "stdout.log", MAX_LOG_BYTES)?, &secret);
        let stderr = adapter::redact(
            &self.tail(host, run, "stderr.log", adapter::MAX_STDERR_TAIL_BYTES)?,
            &secret,
        );
        let adapter = self.checked(
            host,
            run,
            host.tail(self.key(run), "adapter", 32)
                .map_err(build_error)?,
        )?;
        let adapter = AgentAdapter::parse(adapter.trim()).map_err(|_| {
            RunnerError(
                "run adapter metadata is invalid; inspect the run directory and start a new run"
                    .into(),
            )
        })?;
        let mut tracker = EventTracker::new(adapter);
        let mut splitter = adapter::LineSplitter::new();
        let mut lines = splitter.push(stdout.as_bytes());
        lines.extend(splitter.finish());
        let wrote_output = !lines.is_empty();
        for line in lines {
            if !line.truncated {
                tracker.feed(&line.text);
            }
        }
        let outcome = adapter::classify(&tracker, ExitKind::Code(code), &stderr);
        let finished = {
            let mut storage = lock(&self.storage);
            let current = storage
                .get_run(run)?
                .ok_or(StorageError::RunNotFound(run))?;
            if !current.state.is_active() {
                return Ok(current);
            }
            if current.state == RunState::Reserved {
                storage.record_launch(
                    run,
                    &receipt(&self.instance, run, &current.host).provider_run_ref,
                )?;
            }
            // The output of a tmux run is read once it ended, so its last activity is
            // when that end was seen.
            if wrote_output {
                storage.record_run_activity(run, tracker.usage())?;
            }
            if let Some(id) = tracker.session_id() {
                storage.append_run_event(
                    run,
                    "agent_session",
                    Some(&adapter::redact(id, &secret)),
                )?;
            }
            for (kind, payload) in outcome.events {
                storage.append_run_event(run, kind, Some(&adapter::redact(&payload, &secret)))?;
            }
            storage.finish_run(run, outcome.state)?
        };
        self.cleanup(host, run)?;
        Ok(finished)
    }

    fn lost(&self, run: RunId) -> Result<TaskRun, RuntimeError> {
        let mut storage = lock(&self.storage);
        let current = storage
            .get_run(run)?
            .ok_or(StorageError::RunNotFound(run))?;
        if !current.state.is_active() {
            return Ok(current);
        }
        if current.state == RunState::Reserved {
            storage.record_launch(
                run,
                &receipt(&self.instance, run, &current.host).provider_run_ref,
            )?;
        }
        storage.append_run_event(
            run,
            "observation_lost",
            Some("tmux observation was lost; restore SSH connectivity and reconcile the run"),
        )?;
        Ok(storage.finish_run(run, RunState::Unknown)?)
    }

    fn observe(&self, host: Host, run: RunId) -> Result<(), RunnerError> {
        let mut observations = lock(&self.observations);
        if observations
            .get(&run)
            .is_some_and(|observation| lock(&observation.result).is_none())
        {
            return Ok(());
        }
        // Spawn before returning so launch errors cannot silently leave an unobserved run.
        let mut waiter = self
            .command(
                &host,
                run,
                host.tmux_wait_for(self.key(run)).map_err(build_error)?,
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| error())?;
        let observation = Arc::new(Observation::default());
        observations.insert(run, observation.clone());
        let runner = self.clone();
        std::thread::spawn(move || {
            let _ = waiter.wait();
            let _operation = lock(&runner.operations);
            let result = (|| {
                let current = runner.current(run)?;
                if !current.state.is_active() {
                    return Ok(current);
                }
                let probe = runner
                    .checked(&host, run, host.probe(runner.key(run)))
                    .and_then(|text| host::parse_probe(&text).map_err(build_error));
                match probe {
                    Ok(Probe::Exited(code)) => runner.finish(&host, run, code),
                    _ => match runner.has_session(&host, run) {
                        Ok(false) => runner.missing(&host, run),
                        _ => runner.lost(run),
                    },
                }
            })();
            // Read/transport failures also preserve the active writer as Unknown.
            let result = result.or_else(|_| runner.lost(run));
            *lock(&observation.result) = Some(result);
            observation.changed.notify_all();
        });
        Ok(())
    }

    fn missing(&self, host: &Host, run: RunId) -> Result<TaskRun, RuntimeError> {
        let finished = {
            let mut storage = lock(&self.storage);
            let current = storage
                .get_run(run)?
                .ok_or(StorageError::RunNotFound(run))?;
            if !current.state.is_active() {
                return Ok(current);
            }
            storage.append_run_event(run, "interrupted", Some(
                "the tmux session and exit record are missing; inspect the run log and start a new run",
            ))?;
            storage.finish_run(run, RunState::Failed)?
        };
        self.cleanup(host, run)?;
        Ok(finished)
    }

    pub fn stop(&self, run: RunId) -> Result<TaskRun, RuntimeError> {
        let _operation = lock(&self.operations);
        let current = self.current(run)?;
        if !current.state.is_active() {
            return Ok(current);
        }
        let host = self.host(&current.host, current.checkout_path.as_deref())?;
        lock(&self.storage).append_run_event(run, "stop_requested", None)?;
        let killed = self.checked(
            &host,
            run,
            host.tmux_kill_session(self.key(run)).map_err(build_error)?,
        );
        if killed.is_err() && self.has_session(&host, run)? {
            return Err(error().into());
        }
        let finished = lock(&self.storage).finish_run(run, RunState::Cancelled)?;
        // kill-session does not signal wait-for on a server with other sessions.
        let signal = script_invocation(
            &host,
            format!(
                "{} wait-for -S {}",
                self.tmux_words(),
                shell_quote(&host::session(self.key(run)))
            ),
        );
        let _ = self.output(&host, run, signal);
        self.cleanup(&host, run)?;
        Ok(finished)
    }

    pub fn log(&self, run: RunId, tail_bytes: usize) -> Result<RunLog, RuntimeError> {
        let current = self.current(run)?;
        let host = self.host(&current.host, current.checkout_path.as_deref())?;
        let secret = self.secret(&host, run)?;
        Ok(RunLog {
            stdout: adapter::redact(&self.tail(&host, run, "stdout.log", tail_bytes)?, &secret),
            stderr: adapter::redact(&self.tail(&host, run, "stderr.log", tail_bytes)?, &secret),
        })
    }

    pub fn attach_command(&self, run: RunId) -> Option<String> {
        let current = self.current(run).ok()?;
        self.host(&current.host, current.checkout_path.as_deref())
            .ok()?;
        let tmux = format!(
            "{} attach -t {}",
            self.tmux_words(),
            shell_quote(&host::session(self.key(run)))
        );
        Some(match current.host {
            HostRef::Local => tmux,
            HostRef::Ssh(target) => {
                format!("ssh -t {} {}", shell_quote(&target), shell_quote(&tmux))
            }
        })
    }

    pub fn reconcile(&self, run: RunId) -> Result<TaskRun, RuntimeError> {
        let _operation = lock(&self.operations);
        let current = self.current(run)?;
        if !matches!(current.state, RunState::Running | RunState::Unknown) {
            return Ok(current);
        }
        let host = self.host(&current.host, current.checkout_path.as_deref())?;
        let probe = self
            .checked(&host, run, host.probe(self.key(run)))
            .and_then(|text| host::parse_probe(&text).map_err(build_error));
        if let Ok(Probe::Exited(code)) = probe {
            return self.finish(&host, run, code).or_else(|_| self.lost(run));
        }
        match self.has_session(&host, run) {
            Ok(true) => {
                let current = if current.state == RunState::Unknown {
                    lock(&self.storage).resume_observed_run(
                        run,
                        &receipt(&self.instance, run, &current.host).provider_run_ref,
                    )?
                } else {
                    current
                };
                self.observe(host, run)?;
                Ok(current)
            }
            Ok(false) if probe.is_ok() => self.missing(&host, run),
            _ => self.lost(run),
        }
    }

    /// Local sessions are probed immediately. Remote runs are marked Unknown without
    /// SSH; callers reconcile them off the server's startup path.
    pub fn recover_after_restart(&self, storage: &Mutex<Storage>) -> Result<(), RuntimeError> {
        let runs = {
            let storage = lock(storage);
            let mut runs = Vec::new();
            for workspace in storage.list_workspaces()? {
                for task in storage.list_tasks(workspace.id)? {
                    runs.extend(storage.list_task_runs(task.id)?.into_iter().filter(|run| {
                        run.runner_kind == RunnerKind::Tmux
                            && matches!(run.state, RunState::Running | RunState::Unknown)
                    }));
                }
            }
            runs
        };
        for run in runs {
            if run.host == HostRef::Local {
                self.reconcile(run.id)?;
            } else {
                self.lost(run.id)?;
            }
        }
        Ok(())
    }
}

fn request_marker(spec: &LaunchSpec) -> String {
    serde_json::to_string(&(&spec.request_key, spec.generation))
        .expect("a request key and generation serialize")
}

fn build_error(message: &str) -> RunnerError {
    RunnerError(message.into())
}

fn install_error() -> RunnerError {
    RunnerError(
        "tmux is unavailable; install tmux on the execution host and start a new run".into(),
    )
}

fn script_invocation(host: &Host, script: String) -> Invocation {
    match host {
        Host::Local => Invocation {
            program: "sh",
            args: vec!["-c".into(), script],
        },
        Host::Ssh { target, .. } => Invocation {
            program: "ssh",
            args: vec![
                "-o".into(),
                "BatchMode=yes".into(),
                "--".into(),
                target.as_str().into(),
                format!("sh -c {}", shell_quote(&script)),
            ],
        },
    }
}

impl RunLauncher for TmuxRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Tmux
    }

    fn find_launch(&self, spec: &LaunchSpec) -> Result<Option<LaunchReceipt>, RunnerError> {
        let host = self.host(&spec.host, spec.cwd.as_deref())?;
        if self.has_session(&host, spec.run)? && self.owns_request(&host, spec)? {
            if self.observe(host, spec.run).is_err() {
                self.lost(spec.run).map_err(|_| error())?;
            }
            Ok(Some(receipt(&self.instance, spec.run, &spec.host)))
        } else {
            Ok(None)
        }
    }

    fn launch(&self, spec: &LaunchSpec) -> Result<LaunchReceipt, RunnerError> {
        let _operation = lock(&self.operations);
        let host = self.host(&spec.host, spec.cwd.as_deref())?;
        if !self
            .current(spec.run)
            .map_err(|_| error())?
            .state
            .is_active()
        {
            return Err(RunnerError(
                "the run has ended; start a new run with a new request key".into(),
            ));
        }
        let RunCommand::Agent(agent) = &spec.command else {
            return Err(RunnerError(
                "choose an Agent command before starting a tmux run".into(),
            ));
        };
        let cwd = spec.cwd.as_deref().ok_or_else(|| {
            RunnerError("open the task worktree before starting a tmux run".into())
        })?;
        if self.has_session(&host, spec.run)? {
            if !self.owns_request(&host, spec)? {
                return Err(RunnerError(format!(
                    "tmux session {} on {} has no matching launch marker; stop it with {} kill-session -t {}; remove the leftover directory {} on {}, then start a new run",
                    host::session(self.key(spec.run)),
                    spec.host.as_wire(),
                    self.tmux_words(),
                    shell_quote(&format!("={}", host::session(self.key(spec.run)))),
                    self.directory(&host, spec.run),
                    spec.host.as_wire()
                )));
            }
            if self.observe(host, spec.run).is_err() {
                self.lost(spec.run).map_err(|_| error())?;
            }
            return Ok(receipt(&self.instance, spec.run, &spec.host));
        }
        // Check installation on the execution host before staging any credentials.
        let version = script_invocation(
            &host,
            format!("{} -V", shell_quote(&self.tmux.to_string_lossy())),
        );
        if self.checked(&host, spec.run, version).is_err() {
            return Err(RunnerError(
                "tmux is unavailable; install tmux on the execution host and start a new run"
                    .into(),
            ));
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
                                .into(),
                        )
                    })?,
            )
        } else {
            None
        };
        if let Some(endpoint) = &mut endpoint
            && matches!(host, Host::Ssh { .. })
        {
            let url = reqwest::Url::parse(&endpoint.url).ok();
            let port = url
                .as_ref()
                .and_then(|url| url.port_or_known_default())
                .ok_or_else(|| {
                    RunnerError(
                        "configure a valid server MCP endpoint and port, or start with mcp false"
                            .into(),
                    )
                })?;
            endpoint.url = format!("http://127.0.0.1:{port}/mcp");
        }
        let mut invocation = agent.adapter.invocation(
            Path::new(host::RUN_FILE_PREFIX),
            endpoint.as_ref(),
            &agent.options,
        );
        // Path::join preserves the {run}/ prefix for host-native resolution.
        if let Some(at) = invocation.args.iter().position(|arg| arg == "--mcp-config") {
            invocation.args[at + 1] =
                format!("{}{}", host::RUN_FILE_PREFIX, adapter::MCP_CONFIG_FILE);
        }
        self.create_directory(&host, spec.run)?;
        let staged = (|| {
            self.stage(&host, spec.run, "request", request_marker(spec).as_bytes())?;
            self.stage(&host, spec.run, "brief.md", agent.brief.as_bytes())?;
            self.stage(
                &host,
                spec.run,
                "adapter",
                agent.adapter.as_wire().as_bytes(),
            )?;
            for name in ["stdout.log", "stderr.log"] {
                self.stage(&host, spec.run, name, b"")?;
            }
            for (name, contents) in &invocation.files {
                self.stage(&host, spec.run, name, contents.as_bytes())?;
            }
            if let Some(endpoint) = &endpoint {
                self.stage(&host, spec.run, "token", endpoint.token.as_bytes())?;
            }
            Ok::<(), RunnerError>(())
        })();
        if let Err(error) = staged {
            let _ = self.cleanup(&host, spec.run);
            return Err(error);
        }
        let program = match agent.adapter {
            AgentAdapter::Claude => &self.claude,
            AgentAdapter::Codex => &self.codex,
        };
        let mut argv = vec![program.to_string_lossy().into_owned()];
        argv.extend(invocation.args);
        let secret_env = if endpoint.is_some() {
            vec![(MCP_TOKEN_ENV, "token")]
        } else {
            vec![]
        };
        let env: Vec<_> = invocation
            .env
            .iter()
            .filter(|(name, _)| name != MCP_TOKEN_ENV)
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let wrapper = host::wrapper_script(
            HostOs::Posix,
            self.key(spec.run),
            &argv,
            cwd,
            &secret_env,
            &env,
            true,
        )
        .map_err(build_error)?;
        let wrapper = self.localize(&host, spec.run, wrapper).replace(
            "tmux wait-for -S",
            &format!("{} wait-for -S", self.tmux_words()),
        );
        let started = self.checked(
            &host,
            spec.run,
            host.tmux_new_session(self.key(spec.run), cwd, &wrapper)
                .map_err(build_error)?,
        );
        if started.is_err() {
            // A lost SSH response may still have created the session.
            match self.has_session(&host, spec.run) {
                Ok(true) => {}
                Ok(false) => {
                    let _ = self.cleanup(&host, spec.run);
                    return Err(RunnerError("could not create the tmux session; install tmux on the execution host and check the checkout path before starting a new run".into()));
                }
                Err(_) => {
                    // The launch side effect is uncertain, not a confirmed failure.
                    self.lost(spec.run).map_err(|_| error())?;
                    return Ok(receipt(&self.instance, spec.run, &spec.host));
                }
            }
        }
        if self.observe(host, spec.run).is_err() {
            self.lost(spec.run).map_err(|_| error())?;
        }
        Ok(receipt(&self.instance, spec.run, &spec.host))
    }
}
