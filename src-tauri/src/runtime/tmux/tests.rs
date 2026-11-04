use super::*;
use crate::domain::model::{CompletionMode, Runner, Source, TaskId, TaskType, WorkspaceLocation};
use crate::domain::path::PosixPath;
use crate::domain::runtime::{OwnerKey, RunRole};
use crate::runtime::{AgentLaunch, RuntimeService, StartRun};
use crate::storage::{NewRun, NewTask, NewWorkspace};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::time::Duration;

const TOKEN: &str = "tmux-test-token-$[literal]";
const RESULT: &str = r#"printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'"#;
const WAIT: Duration = Duration::from_secs(15);

fn program(path: &Path, script: &str) {
    fs::write(path, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn fifo(path: &Path) -> File {
    let name = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .unwrap()
}

fn signal(file: &mut File) {
    let mut fd = libc::pollfd {
        fd: file.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(
        unsafe { libc::poll(&mut fd, 1, 15_000) },
        1,
        "bounded FIFO signal"
    );
    let mut byte = [0];
    assert_eq!(file.read(&mut byte).unwrap(), 1);
}

struct Fixture {
    dir: tempfile::TempDir,
    runner: TmuxRunner,
    task: TaskId,
    ready: File,
    gate: File,
}

impl Fixture {
    fn new(script: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ready = fifo(&dir.path().join("ready"));
        let gate = fifo(&dir.path().join("gate"));
        program(&dir.path().join("agent"), script);
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "tmux".into(),
                location: WorkspaceLocation::Local {
                    path: PosixPath::parse(dir.path().to_str().unwrap())
                        .unwrap()
                        .into(),
                },
                default_base_branch: "main".into(),
                source: Source::LocalGit,
                completion: CompletionMode::LocalMerge,
                runner: Runner::Tmux,
                axes_detected: true,
            })
            .unwrap();
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: "Tmux run".into(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: vec![],
            })
            .unwrap()
            .id;
        let mut runner = TmuxRunner::new(
            Arc::new(Mutex::new(storage)),
            dir.path().join("runs"),
            "0123456789ab",
        )
        .with_socket(format!(
            "toodo-test-{}",
            dir.path().file_name().unwrap().to_string_lossy()
        ))
        .with_mcp_provider(Arc::new(|| {
            Some(adapter::McpEndpoint {
                url: "http://192.0.2.1:12345/mcp".into(),
                token: TOKEN.into(),
            })
        }));
        runner.claude = dir.path().join("agent");
        runner.codex = runner.claude.clone();
        runner = runner.with_tmux_program(PathBuf::from(
            std::env::var_os("TOODO_TEST_TMUX").unwrap_or_else(|| "tmux".into()),
        ));
        Self {
            dir,
            runner,
            task,
            ready,
            gate,
        }
    }

    fn real(script: &str) -> Option<Self> {
        let fixture = Self::new(script);
        if !Command::new(&fixture.runner.tmux)
            .arg("-V")
            .status()
            .is_ok_and(|status| status.success())
        {
            eprintln!(
                "SKIP real tmux tests: install tmux or set TOODO_TEST_TMUX to a working binary"
            );
            return None;
        }
        Some(fixture)
    }

    fn request(&self, remote: bool, mcp: bool) -> StartRun {
        StartRun {
            owner: OwnerKey::implicit(),
            task: self.task,
            request_key: "one".into(),
            role: RunRole::Writer,
            host: if remote {
                HostRef::Ssh("test-host".into())
            } else {
                HostRef::Local
            },
            checkout_path: Some(self.dir.path().to_string_lossy().into_owned()),
            runtime_workspace: None,
            adapter_profile: Some("claude".into()),
            command: RunCommand::Agent(AgentLaunch {
                adapter: AgentAdapter::Claude,
                brief: "Implement the task\n".into(),
                mcp,
                options: Default::default(),
                timeout_secs: 60,
            }),
        }
    }

    fn start(&self, remote: bool, mcp: bool) -> TaskRun {
        RuntimeService
            .start_run(
                &self.runner.storage,
                &self.runner,
                self.request(remote, mcp),
            )
            .unwrap()
    }

    fn end(&self, run: RunId) -> TaskRun {
        end(&self.runner, run)
    }

    fn reserve(&self, host: HostRef) -> TaskRun {
        lock(&self.runner.storage)
            .reserve_run(&NewRun {
                owner: OwnerKey::implicit(),
                task: self.task,
                request_key: "reserved".into(),
                runner_kind: RunnerKind::Tmux,
                role: RunRole::Observer,
                host,
                checkout_path: Some(self.dir.path().to_string_lossy().into_owned()),
                runtime_workspace: None,
                adapter_profile: None,
            })
            .unwrap()
            .into_run()
    }

    fn spec(&self, run: &TaskRun) -> LaunchSpec {
        LaunchSpec {
            run: run.id,
            request_key: run.request_key.clone(),
            generation: run.generation,
            task: self.task,
            host: run.host.clone(),
            cwd: run.checkout_path.clone(),
            workspace_ref: None,
            command: self.request(false, false).command,
        }
    }

    fn remote(&mut self) {
        program(
            &self.dir.path().join("ssh"),
            r#"
HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export HOME
printf '%s\n' "$@" >> "$HOME/ssh-argv"
test ! -f "$HOME/offline" || exit 255
while [ "$1" != -- ]; do shift; done
shift
test "$1" = test-host || exit 254
shift
case "$1" in
    *"'new-session'"*)
        if [ -f "$HOME/lose-launch" ]; then
            sh -c "$1" || exit
            : > "$HOME/offline"
            exit 255
        fi
        ;;
    *"'wait-for'"*)
        if [ -f "$HOME/disconnect" ]; then
            printf x > "$HOME/wait-ready"
            read disconnect < "$HOME/disconnect-gate"
            exit 255
        fi
        ;;
esac
exec sh -c "$1"
"#,
        );
        self.runner.ssh = self.dir.path().join("ssh");
        self.runner = self
            .runner
            .clone()
            .with_tunnel_open_provider(Arc::new(|target| target == "test-host"));
    }

    fn restarted(&self) -> TmuxRunner {
        let mut runner = TmuxRunner::new(
            self.runner.storage.clone(),
            self.runner.runs_dir.clone(),
            "0123456789ab",
        )
        .with_tmux_program(self.runner.tmux.clone())
        .with_socket(self.runner.socket.clone().unwrap());
        runner.ssh = self.runner.ssh.clone();
        // The old observer still exists in this test process, unlike a real restart.
        // Serialize its final write with the new instance's stop/completion.
        runner.operations = self.runner.operations.clone();
        runner
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new(&self.runner.tmux)
            .args(["-L", self.runner.socket.as_deref().unwrap(), "kill-server"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn end(runner: &TmuxRunner, run: RunId) -> TaskRun {
    let observation = lock(&runner.observations).get(&run).unwrap().clone();
    let result = lock(&observation.result);
    let (result, timeout) = observation
        .changed
        .wait_timeout_while(result, WAIT, |result| result.is_none())
        .unwrap();
    assert!(
        !timeout.timed_out(),
        "bounded tmux completion: {:?}",
        runner.current(run)
    );
    match result.as_ref().expect("completion") {
        Ok(run) => run.clone(),
        Err(error) => panic!("{error}"),
    }
}

#[test]
fn command_construction_is_quoted_and_windows_names_plain() {
    let fixture = Fixture::new("exit 0");
    let run = fixture.reserve(HostRef::Local);
    let mut spec = fixture.spec(&run);
    spec.host = HostRef::Ssh("test-host".into());
    spec.cwd = Some(r"C:\work\repo".into());
    assert!(
        fixture
            .runner
            .launch(&spec)
            .unwrap_err()
            .0
            .contains("runner plain")
    );
    let host = Host::Ssh {
        target: MachineLabel::parse("test-host").unwrap(),
        os: HostOs::Posix,
    };
    let invocation = host
        .tmux_new_session(fixture.runner.key(run.id), "/work/a'b", "echo 'safe'")
        .unwrap();
    let command = fixture.runner.command(&host, run.id, invocation);
    let args = format!("{:?}", command.get_args().collect::<Vec<_>>());
    assert!(args.contains("new-session"));
    assert!(args.contains("toodo-test-"));
    assert!(!args.contains(TOKEN));
    let mut missing = fixture.runner.clone();
    missing.tmux = fixture.dir.path().join("not-installed");
    assert!(
        missing
            .find_launch(&fixture.spec(&run))
            .unwrap_err()
            .0
            .contains("install tmux")
    );
}

#[test]
fn real_launch_classifies_success_failure_and_exit_after_result() {
    let Some(fixture) = Fixture::real(RESULT) else {
        return;
    };
    let run = fixture.start(false, false);
    assert_eq!(fixture.end(run.id).state, RunState::Settled);
    assert_eq!(
        run.provider_run_ref,
        Some(format!("tmux:local:toodo-0123456789ab-run-{}", run.id))
    );
    assert!(
        fixture
            .runner
            .attach_command(run.id)
            .unwrap()
            .contains("attach -t")
    );

    let Some(failure) = Fixture::real("printf failure >&2\nexit 17") else {
        return;
    };
    let run = failure.start(false, false);
    assert_eq!(failure.end(run.id).state, RunState::Failed);
    assert!(
        lock(&failure.runner.storage)
            .run_events(run.id)
            .unwrap()
            .iter()
            .any(|event| event.payload.as_deref() == Some("exit code 17"))
    );

    let Some(exited) = Fixture::real(&format!("{RESULT}\nexit 7")) else {
        return;
    };
    let run = exited.start(false, false);
    assert_eq!(exited.end(run.id).state, RunState::Exited);
}

#[test]
fn real_stop_cancels_and_removes_session() {
    let Some(mut fixture) = Fixture::real("printf x > ready\nread gate < gate") else {
        return;
    };
    let run = fixture.start(false, false);
    signal(&mut fixture.ready);
    assert_eq!(
        fixture.runner.stop(run.id).unwrap().state,
        RunState::Cancelled
    );
    assert!(!fixture.runner.has_session(&Host::Local, run.id).unwrap());
    assert_eq!(fixture.end(run.id).state, RunState::Cancelled);
}

#[test]
fn real_find_launch_adopts_and_restart_rearms_live_unknown_session() {
    let Some(mut fixture) = Fixture::real(&format!("printf x > ready\nread gate < gate\n{RESULT}"))
    else {
        return;
    };
    let run = fixture.start(false, false);
    signal(&mut fixture.ready);
    let restarted = fixture.restarted();
    assert_eq!(
        restarted
            .find_launch(&fixture.spec(&run))
            .unwrap()
            .unwrap()
            .provider_run_ref,
        run.provider_run_ref.clone().unwrap()
    );
    lock(&fixture.runner.storage)
        .finish_run(run.id, RunState::Unknown)
        .unwrap();
    restarted.recover_after_restart(&restarted.storage).unwrap();
    assert_eq!(restarted.current(run.id).unwrap().state, RunState::Running);
    assert!(
        lock(&restarted.storage)
            .run_events(run.id)
            .unwrap()
            .iter()
            .any(|event| event.kind == "recovered")
    );
    fixture.gate.write_all(b"go\n").unwrap();
    assert_eq!(end(&restarted, run.id).state, RunState::Settled);
    fixture.end(run.id);
}

#[test]
fn real_restart_settles_ended_session_and_missing_session() {
    let Some(fixture) = Fixture::real(RESULT) else {
        return;
    };
    // Launch independently of the first runner's monitor, as after a server crash.
    let run = fixture.reserve(HostRef::Local);
    let host = Host::Local;
    fixture.runner.create_directory(&host, run.id).unwrap();
    fixture
        .runner
        .stage(&host, run.id, "brief.md", b"brief")
        .unwrap();
    fixture
        .runner
        .stage(&host, run.id, "adapter", b"claude")
        .unwrap();
    for (file, data) in [
        ("exit", "0\n"),
        (
            "stdout.log",
            "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}\n",
        ),
        ("stderr.log", ""),
    ] {
        fixture
            .runner
            .stage(&host, run.id, file, data.as_bytes())
            .unwrap();
    }
    lock(&fixture.runner.storage)
        .record_launch(
            run.id,
            &receipt(&fixture.runner.instance, run.id, &run.host).provider_run_ref,
        )
        .unwrap();
    let restarted = fixture.restarted();
    restarted.recover_after_restart(&restarted.storage).unwrap();
    assert_eq!(restarted.current(run.id).unwrap().state, RunState::Settled);
    let missing = lock(&restarted.storage)
        .reserve_run(&NewRun {
            request_key: "missing".into(),
            owner: OwnerKey::implicit(),
            task: fixture.task,
            runner_kind: RunnerKind::Tmux,
            role: RunRole::Observer,
            host: HostRef::Local,
            checkout_path: run.checkout_path,
            runtime_workspace: None,
            adapter_profile: None,
        })
        .unwrap()
        .into_run();
    lock(&restarted.storage)
        .record_launch(
            missing.id,
            &receipt(&fixture.runner.instance, missing.id, &missing.host).provider_run_ref,
        )
        .unwrap();
    assert_eq!(
        restarted.reconcile(missing.id).unwrap().state,
        RunState::Failed
    );
}

#[test]
fn real_mcp_redacts_durable_logs_terminal_and_argv_and_removes_credentials() {
    let Some(fixture) = Fixture::real(&format!(
        r#"
IFS= read -r brief
test "$brief" = 'Implement the task' || exit 4
test "$TOODO_MCP_URL" = http://192.0.2.1:12345/mcp || exit 5
printf '%s\n' "$@" > argv
printf '%s\n' "$TOODO_MCP_TOKEN" "$TOODO_MCP_TOKEN"
printf '%s\n' "$TOODO_MCP_TOKEN" >&2
{RESULT}
"#
    )) else {
        return;
    };
    let run = fixture.start(false, true);
    assert_eq!(fixture.end(run.id).state, RunState::Settled);
    let log = fixture.runner.log(run.id, MAX_LOG_BYTES).unwrap();
    assert!(log.stdout.contains("[redacted]"));
    assert!(log.stderr.contains("[redacted]"));
    assert!(!format!("{log:?}").contains(TOKEN));
    let dir = fixture.runner.runs_dir.join(run.id.to_string());
    assert!(!dir.join("token").exists());
    assert!(!dir.join("mcp.json").exists());
    assert!(
        !fs::read_to_string(dir.join("stdout.log"))
            .unwrap()
            .contains(TOKEN)
    );
    assert!(
        !fs::read_to_string(fixture.dir.path().join("argv"))
            .unwrap()
            .contains(TOKEN)
    );
    assert!(
        !format!(
            "{:?}",
            lock(&fixture.runner.storage).run_events(run.id).unwrap()
        )
        .contains(TOKEN)
    );
}

#[test]
fn fake_ssh_runs_real_remote_tmux_and_cleans_credentials() {
    let Some(mut fixture) = Fixture::real(&format!(
        r#"
test "$TOODO_MCP_URL" = http://127.0.0.1:12345/mcp || exit 9
printf '%s\n' "$TOODO_MCP_TOKEN"
{RESULT}
"#
    )) else {
        return;
    };
    fixture.remote();
    let run = fixture.start(true, true);
    assert_eq!(fixture.end(run.id).state, RunState::Settled);
    assert_eq!(
        run.provider_run_ref,
        Some(format!(
            "tmux:ssh:test-host:toodo-0123456789ab-run-{}",
            run.id
        ))
    );
    assert!(
        fixture
            .runner
            .attach_command(run.id)
            .unwrap()
            .starts_with("ssh -t 'test-host'")
    );
    assert!(
        !fs::read_to_string(fixture.dir.path().join("ssh-argv"))
            .unwrap()
            .contains(TOKEN)
    );
    let remote_dir = fixture
        .dir
        .path()
        .join(".toodo/runs/0123456789ab")
        .join(run.id.to_string());
    assert!(!remote_dir.join("token").exists());
    assert!(!remote_dir.join("mcp.json").exists());
    assert!(
        fixture
            .runner
            .log(run.id, 4096)
            .unwrap()
            .stdout
            .contains("[redacted]")
    );
}

#[test]
fn fake_ssh_unreachable_stop_preserves_writer_and_restart_never_uses_ssh() {
    let Some(mut fixture) = Fixture::real("printf x > ready\nread gate < gate") else {
        return;
    };
    fixture.remote();
    let run = fixture.start(true, false);
    signal(&mut fixture.ready);
    fs::write(fixture.dir.path().join("offline"), b"").unwrap();
    let error = fixture.runner.stop(run.id).unwrap_err().to_string();
    assert!(error.contains("reconcile"));
    assert!(fixture.runner.current(run.id).unwrap().state.is_active());
    assert!(
        lock(&fixture.runner.storage)
            .run_events(run.id)
            .unwrap()
            .iter()
            .any(|event| event.kind == "stop_requested")
    );
    let restarted = fixture.restarted();
    let before = fs::read(fixture.dir.path().join("ssh-argv")).unwrap();
    restarted.recover_after_restart(&restarted.storage).unwrap();
    assert_eq!(
        before,
        fs::read(fixture.dir.path().join("ssh-argv")).unwrap()
    );
    assert_eq!(restarted.current(run.id).unwrap().state, RunState::Unknown);
    assert_eq!(
        restarted.reconcile(run.id).unwrap().state,
        RunState::Unknown
    );
    fs::remove_file(fixture.dir.path().join("offline")).unwrap();
    assert_eq!(
        restarted.reconcile(run.id).unwrap().state,
        RunState::Running
    );
    assert_eq!(restarted.stop(run.id).unwrap().state, RunState::Cancelled);
    end(&restarted, run.id);
    fixture.end(run.id);
}

#[test]
fn fake_ssh_wait_disconnect_is_unknown_until_reconciled() {
    let Some(mut fixture) = Fixture::real(&format!("printf x > ready\nread gate < gate\n{RESULT}"))
    else {
        return;
    };
    fixture.remote();
    fs::write(fixture.dir.path().join("disconnect"), b"").unwrap();
    let mut wait_ready = fifo(&fixture.dir.path().join("wait-ready"));
    let mut disconnect_gate = fifo(&fixture.dir.path().join("disconnect-gate"));
    let run = fixture.start(true, false);
    signal(&mut fixture.ready);
    signal(&mut wait_ready);
    disconnect_gate.write_all(b"disconnect\n").unwrap();
    assert_eq!(fixture.end(run.id).state, RunState::Unknown);
    fs::remove_file(fixture.dir.path().join("disconnect")).unwrap();
    assert_eq!(
        fixture.runner.reconcile(run.id).unwrap().state,
        RunState::Running
    );
    fixture.gate.write_all(b"go\n").unwrap();
    assert_eq!(fixture.end(run.id).state, RunState::Settled);
}

#[test]
fn fake_ssh_tunnel_admission_rejects_before_staging_token() {
    let Some(mut fixture) = Fixture::real(RESULT) else {
        return;
    };
    fixture.remote();
    fixture.runner.tunnel_open = None;
    let error = RuntimeService
        .start_run(
            &fixture.runner.storage,
            &fixture.runner,
            fixture.request(true, true),
        )
        .unwrap_err()
        .to_string();
    assert!(error.contains("mcp false"));
    assert!(!fixture.dir.path().join(".toodo/runs/0123456789ab").exists());
}

#[test]
fn fake_ssh_lost_launch_response_keeps_unknown_until_session_can_be_adopted() {
    let Some(mut fixture) = Fixture::real("printf x > ready\nread gate < gate") else {
        return;
    };
    fixture.remote();
    fs::write(fixture.dir.path().join("lose-launch"), b"").unwrap();
    let run = fixture.start(true, false);
    signal(&mut fixture.ready);
    assert_eq!(run.state, RunState::Unknown);
    assert!(run.provider_run_ref.is_some());
    fs::remove_file(fixture.dir.path().join("offline")).unwrap();
    assert_eq!(
        fixture.runner.reconcile(run.id).unwrap().state,
        RunState::Running
    );
    assert_eq!(
        fixture.runner.stop(run.id).unwrap().state,
        RunState::Cancelled
    );
    fixture.end(run.id);
}

#[test]
fn real_find_launch_requires_its_own_request_and_generation_marker() {
    let Some(mut fixture) = Fixture::real("printf R > ready\nread value < gate") else {
        return;
    };
    let run = fixture.start(false, false);
    signal(&mut fixture.ready);
    let spec = fixture.spec(&run);
    assert!(fixture.runner.find_launch(&spec).unwrap().is_some());
    let mut other = spec.clone();
    other.request_key = "another request".into();
    assert!(fixture.runner.find_launch(&other).unwrap().is_none());
    other = spec.clone();
    other.generation += 1;
    assert!(fixture.runner.find_launch(&other).unwrap().is_none());
    let marker = fixture
        .runner
        .runs_dir
        .join(run.id.to_string())
        .join("request");
    fs::remove_file(marker).unwrap();
    assert!(fixture.runner.find_launch(&spec).unwrap().is_none());
    assert!(
        fixture
            .runner
            .launch(&spec)
            .unwrap_err()
            .0
            .contains("remove the leftover directory")
    );
    fixture.runner.stop(run.id).unwrap();
    assert_eq!(fixture.end(run.id).state, RunState::Cancelled);
}

#[test]
fn fake_ssh_two_server_instances_keep_same_run_id_separate() {
    let Some(mut first) = Fixture::real("printf R > ready\nread value < gate") else {
        return;
    };
    let Some(mut second) = Fixture::real("printf R > ready\nread value < gate") else {
        return;
    };
    first.remote();
    second.remote();
    second.runner.instance = "fedcba987654".into();
    second.runner.ssh = first.runner.ssh.clone();
    second.runner.socket = first.runner.socket.clone();
    let a = first.start(true, false);
    let b = second.start(true, false);
    signal(&mut first.ready);
    signal(&mut second.ready);
    assert_eq!(a.id, b.id);
    assert_ne!(a.provider_run_ref, b.provider_run_ref);
    assert_ne!(
        first.runner.attach_command(a.id),
        second.runner.attach_command(b.id)
    );
    let host = first
        .runner
        .host(&a.host, a.checkout_path.as_deref())
        .unwrap();
    assert!(first.runner.has_session(&host, a.id).unwrap());
    assert!(second.runner.has_session(&host, b.id).unwrap());
    for instance in ["0123456789ab", "fedcba987654"] {
        assert!(
            first
                .dir
                .path()
                .join(".toodo/runs")
                .join(instance)
                .join(a.id.to_string())
                .join("request")
                .exists()
        );
    }
    first.runner.stop(a.id).unwrap();
    assert!(second.runner.has_session(&host, b.id).unwrap());
    second.runner.stop(b.id).unwrap();
    assert_eq!(first.end(a.id).state, RunState::Cancelled);
    assert_eq!(second.end(b.id).state, RunState::Cancelled);
}

#[test]
fn real_launch_rejects_an_unmarked_session_even_without_a_run_directory() {
    let Some(mut fixture) = Fixture::real("printf R > ready\nread value < gate") else {
        return;
    };
    let run = fixture.start(false, false);
    signal(&mut fixture.ready);
    let spec = fixture.spec(&run);
    let dir = fixture.runner.runs_dir.join(run.id.to_string());
    fs::remove_dir_all(&dir).unwrap();
    assert!(fixture.runner.find_launch(&spec).unwrap().is_none());
    let error = fixture.runner.launch(&spec).unwrap_err().0;
    assert!(error.contains("kill-session -t"), "{error}");
    assert!(!dir.exists());
    assert!(fixture.runner.has_session(&Host::Local, run.id).unwrap());
    fixture.runner.stop(run.id).unwrap();
    assert_eq!(fixture.end(run.id).state, RunState::Cancelled);
}
