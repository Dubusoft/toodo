//! The health of the tools on the server: herdr for herdr workspaces, tmux for local
//! tmux workspaces, the agent CLIs plain and tmux runs launch, git, gh for GitHub
//! workspaces, and ssh for SSH workspaces. Missing tools are reported, never an error.

use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use super::State;

use super::types::{
    AgentAdapter, AgentHealth, HerdrHealth, RunnerHealth, TmuxHealth, Tool, ToolHealth,
};
use super::{CommandResult, HerdrState};
use crate::adapters::github::{GH_LOGGED_OUT, GH_MISSING};
use crate::adapters::herdr::{Herdr, HerdrError};
use crate::cli::find_on_path;
use crate::runtime::plain::adapter;

/// Reports whether herdr is installed and running, whether tmux runs, whether the
/// `claude` and `codex` CLIs of plain and tmux runs are on the server's `PATH`, whether
/// git and ssh run, and whether gh runs and is logged in.
#[specta::specta]
pub fn runner_health(herdr: State<'_, HerdrState>) -> CommandResult<RunnerHealth> {
    Ok(check(&herdr))
}

/// The checks of [`runner_health`] with this process's `PATH` and environment, which
/// `toodo init` runs as well.
pub fn check(herdr: &Herdr) -> RunnerHealth {
    health(herdr, &probe, &|name| std::env::var(name).ok())
}

/// How long one check may take; `gh auth status` asks GitHub and can hang offline.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs `program args` without input and returns its output, killing it after
/// [`PROBE_TIMEOUT`].
fn probe(program: &str, args: &[&str]) -> io::Result<Output> {
    let mut child = Command::new(program)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            // Best effort: the child may have exited since try_wait.
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "{program} {} did not finish within {} seconds",
                    args.join(" "),
                    PROBE_TIMEOUT.as_secs()
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout)?;
    }
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_end(&mut stderr)?;
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Runs a program with arguments, as [`probe`] does.
type Probe<'a> = &'a dyn Fn(&str, &[&str]) -> io::Result<Output>;

/// [`check`] with the programs run through `probe` and the environment variables read
/// through `var`.
fn health(herdr: &Herdr, probe: Probe<'_>, var: &dyn Fn(&str) -> Option<String>) -> RunnerHealth {
    RunnerHealth {
        herdr: herdr_health(herdr.server_status()),
        tmux: tmux_health(probe("tmux", &["-V"])),
        agents: [AgentAdapter::Claude, AgentAdapter::Codex]
            .into_iter()
            .map(|adapter| agent_health(adapter, var))
            .collect(),
        tools: vec![git_health(probe), gh_health(probe), ssh_health(probe)],
    }
}

const GIT_NEXT: &str = "install git on the PATH of the user that runs toodo-server, then \
                        retry; local workspaces with a repository need it";

const SSH_NEXT: &str = "install OpenSSH (`ssh`) on the PATH of the user that runs \
                        toodo-server, then retry; workspaces on SSH machines need it";

fn git_health(probe: Probe<'_>) -> ToolHealth {
    version_health(Tool::Git, "git", &["--version"], probe, GIT_NEXT)
}

fn ssh_health(probe: Probe<'_>) -> ToolHealth {
    version_health(Tool::Ssh, "ssh", &["-V"], probe, SSH_NEXT)
}

/// gh is ready when it runs and `gh auth status` succeeds; it fails without a login and
/// when the token is rejected.
fn gh_health(probe: Probe<'_>) -> ToolHealth {
    let installed = version_health(Tool::Gh, "gh", &["--version"], probe, GH_MISSING);
    if !installed.ready {
        return installed;
    }
    match probe("gh", &["auth", "status"]) {
        Ok(output) if output.status.success() => installed,
        Ok(output) => ToolHealth {
            ready: false,
            message: Some(format!(
                "`gh auth status` failed ({}); {GH_LOGGED_OUT}.",
                first_line(&output.stderr)
                    .or_else(|| first_line(&output.stdout))
                    .unwrap_or_else(|| output.status.to_string())
            )),
            ..installed
        },
        Err(error) => ToolHealth {
            ready: false,
            message: Some(format!(
                "`gh auth status` could not run ({error}); {GH_LOGGED_OUT}."
            )),
            ..installed
        },
    }
}

/// A tool is ready when `program args` runs and succeeds; its version is the first line it
/// printed (ssh prints it to stderr).
fn version_health(
    tool: Tool,
    program: &str,
    args: &[&str],
    probe: Probe<'_>,
    next: &str,
) -> ToolHealth {
    match probe(program, args) {
        Ok(output) if output.status.success() => ToolHealth {
            tool,
            installed: true,
            ready: true,
            version: first_line(&output.stdout).or_else(|| first_line(&output.stderr)),
            message: None,
        },
        Ok(output) => ToolHealth {
            tool,
            installed: true,
            ready: false,
            version: None,
            message: Some(format!(
                "`{program} {}` failed ({}: {}); {next}.",
                args.join(" "),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => ToolHealth {
            tool,
            installed: false,
            ready: false,
            version: None,
            message: Some(format!(
                "{program} was not found on the server's PATH; {next}."
            )),
        },
        Err(error) => ToolHealth {
            tool,
            installed: false,
            ready: false,
            version: None,
            message: Some(format!("{program} could not run ({error}); {next}.")),
        },
    }
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
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

/// tmux is usable when `tmux -V` runs and succeeds. SSH workspaces run the tmux of their
/// host, which this does not check.
fn tmux_health(output: std::io::Result<std::process::Output>) -> TmuxHealth {
    const NEXT: &str = "install tmux on the server's PATH for local tmux workspaces, or \
                        set the workspace runner to plain";
    match output {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            TmuxHealth {
                installed: true,
                version: (!version.is_empty()).then_some(version),
                message: None,
            }
        }
        Ok(output) => TmuxHealth {
            installed: false,
            version: None,
            message: Some(format!(
                "tmux -V failed ({}: {}); {NEXT}.",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )),
        },
        Err(error) => TmuxHealth {
            installed: false,
            version: None,
            message: Some(format!(
                "tmux was not found on the server's PATH ({error}); {NEXT}."
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

    /// A probe that finds no program.
    fn nothing(_: &str, _: &[&str]) -> io::Result<Output> {
        Err(io::Error::from(io::ErrorKind::NotFound))
    }

    fn no_tmux() -> std::io::Result<std::process::Output> {
        Err(std::io::Error::from(std::io::ErrorKind::NotFound))
    }

    fn output(code: i32, stdout: &str, stderr: &str) -> std::io::Result<std::process::Output> {
        use std::os::unix::process::ExitStatusExt;
        Ok(std::process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        })
    }

    #[test]
    fn tmux_reports_its_version_or_the_next_step() {
        assert_eq!(
            tmux_health(output(0, "tmux 3.6\n", "")),
            TmuxHealth {
                installed: true,
                version: Some("tmux 3.6".to_owned()),
                message: None,
            }
        );
        let missing = tmux_health(no_tmux());
        assert!(!missing.installed);
        let message = missing.message.unwrap();
        assert!(message.contains("install tmux"), "{message}");
        assert!(message.contains("runner to plain"), "{message}");
        let failed = tmux_health(output(1, "", "broken"));
        assert!(!failed.installed);
        assert!(failed.message.unwrap().contains("broken"));
    }

    #[test]
    fn missing_herdr_is_reported_as_not_installed() {
        let health = health(
            &herdr(Err(GitError::Spawn {
                program: "herdr".to_owned(),
                message: "No such file or directory (os error 2)".to_owned(),
            })),
            &nothing,
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
            &nothing,
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
            &nothing,
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
            &nothing,
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

    fn tools(probe: Probe<'_>) -> Vec<ToolHealth> {
        health(
            &herdr(Ok(r#"{"server":{"running":true}}"#.to_owned())),
            probe,
            &no_path,
        )
        .tools
    }

    #[test]
    fn ready_tools_report_their_versions() {
        let tools = tools(&|program, args| match (program, args) {
            ("git", ["--version"]) => output(0, "git version 2.43.0\n", ""),
            ("gh", ["--version"]) => output(
                0,
                "gh version 2.83.0 (2025-11-04)\nhttps://github.com/cli/cli\n",
                "",
            ),
            ("gh", ["auth", "status"]) => output(0, "github.com\n  Logged in\n", ""),
            // ssh prints its version to stderr.
            ("ssh", ["-V"]) => output(0, "", "OpenSSH_9.6p1, OpenSSL 3.0.13\n"),
            _ => nothing(program, args),
        });
        let versions: Vec<_> = tools
            .iter()
            .map(|tool| {
                (
                    tool.tool,
                    tool.ready,
                    tool.version.as_deref(),
                    tool.message.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            versions,
            vec![
                (Tool::Git, true, Some("git version 2.43.0"), None),
                (Tool::Gh, true, Some("gh version 2.83.0 (2025-11-04)"), None),
                (Tool::Ssh, true, Some("OpenSSH_9.6p1, OpenSSL 3.0.13"), None),
            ]
        );
    }

    #[test]
    fn gh_without_a_login_is_installed_but_not_ready() {
        let tools = tools(&|program, args| match (program, args) {
            ("gh", ["--version"]) => output(0, "gh version 2.83.0\n", ""),
            ("gh", ["auth", "status"]) => output(
                1,
                "",
                "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
            ),
            _ => nothing(program, args),
        });
        let gh = &tools[1];
        assert_eq!((gh.tool, gh.installed, gh.ready), (Tool::Gh, true, false));
        assert_eq!(gh.version.as_deref(), Some("gh version 2.83.0"));
        let message = gh.message.as_deref().unwrap();
        assert!(
            message.contains("You are not logged into any GitHub hosts"),
            "{message}"
        );
        assert!(
            message.contains("run `gh auth login` as the user"),
            "{message}"
        );
    }

    #[test]
    fn missing_tools_name_the_install_step() {
        let tools = tools(&nothing);
        assert!(tools.iter().all(|tool| !tool.installed && !tool.ready));
        let messages: Vec<_> = tools
            .iter()
            .map(|tool| tool.message.clone().unwrap())
            .collect();
        assert!(
            messages[0].starts_with("git was not found"),
            "{}",
            messages[0]
        );
        assert!(messages[0].contains("install git"), "{}", messages[0]);
        assert!(
            messages[1].contains("install the GitHub CLI"),
            "{}",
            messages[1]
        );
        assert!(messages[2].contains("install OpenSSH"), "{}", messages[2]);
    }

    #[test]
    fn a_failing_tool_reports_its_error() {
        let tools = tools(&|program, args| match program {
            "git" => output(128, "", "fatal: broken install"),
            _ => nothing(program, args),
        });
        assert!(tools[0].installed && !tools[0].ready);
        let message = tools[0].message.as_deref().unwrap();
        assert!(message.contains("fatal: broken install"), "{message}");
        assert!(message.contains("install git"), "{message}");
    }

    #[test]
    fn probe_returns_the_output_of_a_finished_program() {
        let output = probe("sh", &["-c", "echo ok"]).unwrap();
        assert!(output.status.success());
        assert_eq!(first_line(&output.stdout).as_deref(), Some("ok"));
    }
}
