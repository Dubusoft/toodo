//! The health of the runners on the server: herdr for herdr workspaces, and the agent
//! CLIs plain runs launch. Missing tools are reported, never an error.

use super::State;

use super::types::{AgentAdapter, AgentHealth, HerdrHealth, RunnerHealth};
use super::{CommandResult, HerdrState};
use crate::adapters::herdr::{Herdr, HerdrError};
use crate::cli::find_on_path;
use crate::runtime::plain::adapter;

/// Reports whether herdr is installed and running and whether the `claude` and `codex`
/// CLIs of plain runs are on the server's `PATH`.
#[specta::specta]
pub fn runner_health(herdr: State<'_, HerdrState>) -> CommandResult<RunnerHealth> {
    Ok(health(&herdr, &|name| std::env::var(name).ok()))
}

/// [`runner_health`] with the environment variables read through `var`.
fn health(herdr: &Herdr, var: &dyn Fn(&str) -> Option<String>) -> RunnerHealth {
    RunnerHealth {
        herdr: herdr_health(herdr.server_status()),
        agents: [AgentAdapter::Claude, AgentAdapter::Codex]
            .into_iter()
            .map(|adapter| agent_health(adapter, var))
            .collect(),
    }
}

const WITHOUT_HERDR: &str = "or set the workspace runner to plain to run claude or codex \
                             without herdr";

fn herdr_health(status: Result<crate::adapters::herdr::ServerStatus, HerdrError>) -> HerdrHealth {
    match status {
        Ok(status) if status.running => HerdrHealth {
            installed: true,
            running: true,
            version: status.version,
            message: None,
        },
        Ok(status) => HerdrHealth {
            installed: true,
            running: false,
            version: status.version,
            message: Some(format!(
                "The herdr server is not running; start herdr on the server for herdr \
                 workspaces, {WITHOUT_HERDR}."
            )),
        },
        Err(HerdrError::Spawn { message }) => HerdrHealth {
            installed: false,
            running: false,
            version: None,
            message: Some(format!(
                "herdr was not found on the server's PATH ({message}); install herdr and \
                 start it for herdr workspaces, {WITHOUT_HERDR}."
            )),
        },
        Err(error) => HerdrHealth {
            installed: true,
            running: false,
            version: None,
            message: Some(format!(
                "Cannot read the herdr server status: {error}; start herdr on the server \
                 and check `herdr status --json`, {WITHOUT_HERDR}."
            )),
        },
    }
}

/// Looks up the CLI by the name the plain runner launches it with.
fn agent_health(adapter: AgentAdapter, var: &dyn Fn(&str) -> Option<String>) -> AgentHealth {
    let program = adapter::AgentAdapter::from(adapter).as_wire();
    let other = match adapter {
        AgentAdapter::Claude => "codex",
        AgentAdapter::Codex => "claude",
    };
    match find_on_path(program, var) {
        Some(path) => AgentHealth {
            adapter,
            installed: true,
            path: Some(path.display().to_string()),
            message: None,
        },
        None => AgentHealth {
            adapter,
            installed: false,
            path: None,
            message: Some(format!(
                "{program} was not found on the server's PATH; install {program} on the \
                 server's PATH, or start the run with the {other} adapter."
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    use super::*;
    use crate::adapters::git::GitError;
    use crate::adapters::git::fake::FakeRunner;

    fn herdr(result: Result<String, GitError>) -> Herdr {
        Herdr::new(Box::new(Arc::new(FakeRunner::new([result]))))
    }

    fn no_path(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn missing_herdr_is_reported_as_not_installed() {
        let health = health(
            &herdr(Err(GitError::Spawn {
                program: "herdr".to_owned(),
                message: "No such file or directory (os error 2)".to_owned(),
            })),
            &no_path,
        );
        assert!(!health.herdr.installed);
        assert!(!health.herdr.running);
        assert_eq!(health.herdr.version, None);
        let message = health.herdr.message.unwrap();
        assert!(message.contains("install herdr"), "{message}");
        assert!(message.contains("runner to plain"), "{message}");
    }

    #[test]
    fn running_herdr_reports_its_version() {
        let health = health(
            &herdr(Ok(
                r#"{"server":{"running":true,"version":"0.9.5","socket":"/tmp/herdr.sock"}}"#
                    .to_owned(),
            )),
            &no_path,
        );
        assert_eq!(
            health.herdr,
            HerdrHealth {
                installed: true,
                running: true,
                version: Some("0.9.5".to_owned()),
                message: None,
            }
        );
    }

    #[test]
    fn stopped_herdr_is_installed_but_not_running() {
        let health = health(
            &herdr(Ok(r#"{"server":{"running":false}}"#.to_owned())),
            &no_path,
        );
        assert!(health.herdr.installed);
        assert!(!health.herdr.running);
        assert!(health.herdr.message.unwrap().contains("start herdr"));
    }

    #[test]
    fn agent_clis_are_looked_up_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join("claude");
        fs::write(&claude, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&claude, fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.path().display().to_string();
        let var = |name: &str| (name == "PATH").then(|| path.clone());

        let health = health(
            &herdr(Ok(r#"{"server":{"running":true}}"#.to_owned())),
            &var,
        );
        assert_eq!(
            health.agents,
            vec![
                AgentHealth {
                    adapter: AgentAdapter::Claude,
                    installed: true,
                    path: Some(claude.display().to_string()),
                    message: None,
                },
                AgentHealth {
                    adapter: AgentAdapter::Codex,
                    installed: false,
                    path: None,
                    message: Some(
                        "codex was not found on the server's PATH; install codex on the \
                         server's PATH, or start the run with the claude adapter."
                            .to_owned()
                    ),
                },
            ]
        );
    }
}
