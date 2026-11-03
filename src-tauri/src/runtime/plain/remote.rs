//! SSH transport for host-generated scripts. Credentials travel only on staging stdin.

use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, mpsc};

use super::adapter::{MCP_CONFIG_FILE, MCP_TOKEN_ENV, MCP_URL_ENV};
use super::{RunnerError, adapter, lock, process};
use crate::adapters::git::Invocation;
use crate::domain::model::{HostPath, MachineLabel};
use crate::domain::runtime::{HostRef, RunId};
use crate::runtime::host::{Host, HostOs, Probe, RUN_FILE_PREFIX, RunKey, parse_probe};
use crate::storage::Storage;

#[derive(Clone)]
pub(super) struct Remote {
    pub host: Host,
    pub ssh: PathBuf,
    instance: String,
}

impl Remote {
    pub fn from_run(
        host: &HostRef,
        cwd: Option<&str>,
        ssh: &Path,
        instance: &str,
    ) -> Result<Option<Self>, RunnerError> {
        let HostRef::Ssh(target) = host else {
            return Ok(None);
        };
        let path = cwd
            .and_then(|path| HostPath::parse_stored(path).ok())
            .ok_or_else(|| {
                RunnerError("set an absolute remote checkout path, then start a new run".into())
            })?;
        let target = MachineLabel::parse(target)
            .map_err(|_| RunnerError("select a saved SSH target, then start a new run".into()))?;
        Ok(Some(Self {
            host: Host::Ssh {
                target,
                os: if path.is_windows() {
                    HostOs::Windows
                } else {
                    HostOs::Posix
                },
            },
            ssh: ssh.to_owned(),
            instance: instance.to_owned(),
        }))
    }

    fn key(&self, id: RunId) -> RunKey<'_> {
        RunKey {
            instance: &self.instance,
            id,
        }
    }

    pub fn create_directory(&self, run: RunId) -> Result<(), RunnerError> {
        let output = self
            .command(self.host.create_directory(self.key(run)))
            .stdin(Stdio::null())
            .output()
            .map_err(|_| self.error("create run directory"))?;
        if output.status.code() == Some(73) {
            return Err(RunnerError(
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        if !output.status.success() {
            return Err(self.error("create run directory"));
        }
        Ok(())
    }

    fn command(&self, invocation: Invocation) -> Command {
        let mut command = Command::new(&self.ssh);
        command
            .args(invocation.args)
            .env_remove(MCP_TOKEN_ENV)
            .env_remove(MCP_URL_ENV);
        command
    }

    fn error(&self, action: &str) -> RunnerError {
        RunnerError(format!(
            "could not {action} on {}; restore SSH connectivity and reconcile the run once the host is reachable",
            match &self.host {
                Host::Ssh { target, .. } => target.as_str(),
                Host::Local => unreachable!(),
            }
        ))
    }

    pub fn stage(&self, run: RunId, name: &str, bytes: &[u8]) -> Result<(), RunnerError> {
        let mut child = self
            .command(self.host.stage(self.key(run), name))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| self.error("stage run files"))?;
        let written = child.stdin.take().unwrap().write_all(bytes);
        let status = child.wait().map_err(|_| self.error("stage run files"))?;
        if written.is_err() || !status.success() {
            return Err(self.error("stage run files"));
        }
        Ok(())
    }

    pub fn spawn(
        &self,
        run: RunId,
        cwd: &str,
        program: &Path,
        invocation: &adapter::Invocation,
    ) -> Result<
        (
            Child,
            mpsc::Sender<process::Signal>,
            mpsc::Receiver<process::Signal>,
        ),
        RunnerError,
    > {
        let launch = self.launch_invocation(run, cwd, program, invocation)?;
        let child = self
            .command(launch)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|_| self.error("launch the agent"))?;
        let (sender, receiver) = mpsc::channel();
        Ok((child, sender, receiver))
    }

    pub fn launch_invocation(
        &self,
        run: RunId,
        cwd: &str,
        program: &Path,
        invocation: &adapter::Invocation,
    ) -> Result<Invocation, RunnerError> {
        let mut argv = vec![program.to_string_lossy().into_owned()];
        argv.extend(invocation.args.clone());
        if let Some(at) = argv.iter().position(|arg| arg == "--mcp-config") {
            argv[at + 1] = format!("{RUN_FILE_PREFIX}{MCP_CONFIG_FILE}");
        }
        let secret_env: Vec<_> = invocation
            .env
            .iter()
            .filter(|(name, _)| name == MCP_TOKEN_ENV)
            .map(|_| (MCP_TOKEN_ENV, "token"))
            .collect();
        let env: Vec<_> = invocation
            .env
            .iter()
            .filter(|(name, _)| name != MCP_TOKEN_ENV)
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        self.host
            .launch(self.key(run), &argv, cwd, &secret_env, &env)
            .map_err(|error| RunnerError(error.into()))
    }

    fn output(&self, invocation: Invocation, action: &str) -> Result<String, RunnerError> {
        let output = self
            .command(invocation)
            .stdin(Stdio::null())
            .output()
            .map_err(|_| self.error(action))?;
        if !output.status.success() {
            return Err(self.error(action));
        }
        String::from_utf8(output.stdout).map_err(|_| self.error(action))
    }

    pub fn stop(&self, run: RunId) -> Result<(), RunnerError> {
        match self.output(self.host.stop(self.key(run)), "stop the agent")?.trim() {
            "stopped" | "gone" => Ok(()),
            _ => Err(RunnerError(
                "remote process identity did not match; reconcile the run before trying to stop it again".into()
            )),
        }
    }

    fn target(&self) -> &str {
        match &self.host {
            Host::Ssh { target, .. } => target.as_str(),
            Host::Local => unreachable!(),
        }
    }

    /// Fails with the next step when a POSIX host lacks util-linux `setsid --wait`.
    pub fn check_launcher(&self) -> Result<(), RunnerError> {
        let Some(check) = self.host.check_launcher() else {
            return Ok(());
        };
        let status = self
            .command(check)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| self.error("check for setsid"))?;
        match status.code() {
            Some(0) => Ok(()),
            Some(255) | None => Err(self.error("check for setsid")),
            Some(_) => Err(RunnerError(format!(
                "{} has no util-linux `setsid --wait`, which plain runs over SSH need; install \
                 util-linux setsid on the host, or use runner herdr for this workspace",
                self.target()
            ))),
        }
    }

    /// Removes the staged token and MCP config of an ended run. A failure is recorded as
    /// a run event and never changes the outcome.
    pub fn remove_credentials(&self, storage: &Mutex<Storage>, run: RunId) {
        if self
            .output(
                self.host.remove_credentials(self.key(run)),
                "remove staged credentials",
            )
            .is_ok()
        {
            return;
        }
        if let Err(error) = lock(storage).append_run_event(
            run,
            "credential_cleanup_failed",
            Some(
                "could not remove staged credentials; restore connectivity and remove token \
                 and mcp.json from the run directory",
            ),
        ) {
            eprintln!(
                "toodo: could not record the credential cleanup failure of run {run}: {error}"
            );
        }
    }

    pub fn probe(&self, run: RunId) -> Result<Probe, RunnerError> {
        parse_probe(&self.output(self.host.probe(self.key(run)), "probe the agent")?)
            .map_err(|error| RunnerError(error.into()))
    }
}
