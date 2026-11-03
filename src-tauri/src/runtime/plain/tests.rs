use std::ffi::CString;
use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use super::*;
use crate::domain::model::{CompletionMode, Runner, Source, TaskId, TaskType, WorkspaceLocation};
use crate::domain::path::PosixPath;
use crate::domain::runtime::{OwnerKey, RunRole};
use crate::runtime::{AgentLaunch, NoRunner, RuntimeService, StartRun};
use crate::storage::{NewRun, NewTask, NewWorkspace};

const RESULT: &str =
    r#"printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'"#;
const TOKEN: &str = "runner-test-secret-73";
const WAIT: Duration = Duration::from_secs(15);

struct Fixture {
    dir: tempfile::TempDir,
    storage: Arc<Mutex<Storage>>,
    runner: PlainRunner,
    task: TaskId,
    gate: File,
    ready: File,
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

impl Fixture {
    fn new(script: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let gate = fifo(&dir.path().join("gate"));
        let ready = fifo(&dir.path().join("ready"));
        let program = dir.path().join("agent");
        fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "plain".to_owned(),
                location: WorkspaceLocation::Local {
                    path: PosixPath::parse(dir.path().to_str().unwrap())
                        .unwrap()
                        .into(),
                },
                default_base_branch: "main".to_owned(),
                source: Source::LocalGit,
                completion: CompletionMode::LocalMerge,
                runner: Runner::Plain,
                axes_detected: true,
            })
            .unwrap();
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: "Plain run".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: vec![],
            })
            .unwrap()
            .id;
        let storage = Arc::new(Mutex::new(storage));
        let runner = PlainRunner::new(storage.clone(), dir.path().join("runs"))
            .with_programs(&program, &program)
            .with_mcp_provider(Arc::new(|| {
                Some(McpEndpoint {
                    url: "http://127.0.0.1:12345/mcp".to_owned(),
                    token: TOKEN.to_owned(),
                })
            }));
        Self {
            dir,
            storage,
            runner,
            task,
            gate,
            ready,
        }
    }

    fn request(&self, key: &str, adapter: AgentAdapter, mcp: bool, timeout_secs: u64) -> StartRun {
        StartRun {
            owner: OwnerKey::implicit(),
            task: self.task,
            request_key: key.to_owned(),
            role: RunRole::Writer,
            host: HostRef::Local,
            checkout_path: Some(self.dir.path().to_str().unwrap().to_owned()),
            runtime_workspace: None,
            adapter_profile: Some(adapter.as_wire().to_owned()),
            command: RunCommand::Agent(AgentLaunch {
                adapter,
                brief: "Implement the task".to_owned(),
                mcp,
                timeout_secs,
            }),
        }
    }

    fn start(&self, adapter: AgentAdapter, mcp: bool, timeout_secs: u64) -> TaskRun {
        RuntimeService
            .start_run(
                &self.storage,
                &self.runner,
                self.request("one", adapter, mcp, timeout_secs),
            )
            .unwrap()
    }

    fn end(&self, run: RunId, state: RunState, events: &[&str]) -> TaskRun {
        let ended = self.runner.wait_for_end(run, WAIT).expect("run completion");
        assert_eq!(ended.state, state);
        let observed = lock(&self.storage).run_events(run).unwrap();
        let kinds: Vec<_> = observed.iter().map(|event| event.kind.as_str()).collect();
        let mut expected = vec!["reserved", "launched"];
        expected.extend_from_slice(events);
        expected.push(state.as_wire());
        assert_eq!(kinds, expected);
        ended
    }

    fn ready(&mut self) {
        let mut fd = libc::pollfd {
            fd: self.ready.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(
            unsafe { libc::poll(&mut fd, 1, 10_000) },
            1,
            "agent readiness"
        );
        let mut byte = [0];
        self.ready.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [b'R']);
    }

    fn release(&mut self) {
        self.gate.write_all(b"go\n").unwrap();
    }
}

#[test]
fn split_json_with_unterminated_final_line_settles_and_keeps_private_files() {
    let fixture = Fixture::new(
        r#"printf '%s' '{"type":"res'; printf '%s' 'ult","subtype":"success","result":"done"}'"#,
    );
    let run = fixture.start(AgentAdapter::Claude, false, 30);
    fixture.end(run.id, RunState::Settled, &["result"]);
    let dir = fixture.dir.path().join("runs").join(run.id.to_string());
    assert_eq!(
        fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for name in ["brief.md", "stdout.log", "stderr.log"] {
        assert_eq!(
            fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(!dir.join("mcp.json").exists());
    assert_eq!(fixture.runner.log(run.id, 4).unwrap().stdout.len(), 4);
}

#[test]
fn brief_is_read_from_stdin_in_the_checkout_without_mcp_environment() {
    let fixture = Fixture::new(
        r#"test -z "${TOODO_MCP_URL+x}" || exit 2
test -z "${TOODO_MCP_TOKEN+x}" || exit 2
IFS= read -r brief
printf '{"type":"result","subtype":"success","result":"%s"}' "$brief"
"#,
    );
    let request = fixture.request("one", AgentAdapter::Claude, false, 30);
    let RunCommand::Agent(agent) = &request.command else {
        unreachable!()
    };
    let brief = agent.brief.clone();
    let run = RuntimeService
        .start_run(&fixture.storage, &fixture.runner, request)
        .unwrap();
    fixture.end(run.id, RunState::Settled, &["result"]);
    let events = lock(&fixture.storage).run_events(run.id).unwrap();
    assert_eq!(events[2].payload.as_deref(), Some(brief.as_str()));
}

#[test]
fn stderr_error_and_exit_two_fail_with_redacted_event() {
    let fixture = Fixture::new("printf 'error %s\\n' \"$TOODO_MCP_TOKEN\" >&2\nexit 2");
    let run = fixture.start(AgentAdapter::Claude, true, 30);
    fixture.end(run.id, RunState::Failed, &["stderr", "exit"]);
    let events = lock(&fixture.storage).run_events(run.id).unwrap();
    assert!(events[2].payload.as_ref().unwrap().contains("[redacted]"));
    assert!(!format!("{events:?}").contains(TOKEN));
}

#[test]
fn eof_without_result_fails_with_no_result() {
    let fixture = Fixture::new("printf 'not json\\n'");
    let run = fixture.start(AgentAdapter::Claude, false, 30);
    fixture.end(run.id, RunState::Failed, &["no_result"]);
}

#[test]
fn result_then_exit_three_is_exited() {
    let fixture = Fixture::new(&format!("{RESULT}\nexit 3"));
    let run = fixture.start(AgentAdapter::Claude, false, 30);
    fixture.end(run.id, RunState::Exited, &["exit_after_result"]);
}

#[test]
fn duplicate_request_launches_one_process_and_second_writer_is_rejected() {
    let mut fixture = Fixture::new(&format!(
        "printf 'launch\\n' >> launches\nprintf R > ready\nread value < gate\n{RESULT}"
    ));
    let request = fixture.request("one", AgentAdapter::Claude, false, 30);
    let first = RuntimeService
        .start_run(&fixture.storage, &fixture.runner, request.clone())
        .unwrap();
    fixture.ready();
    let second = RuntimeService
        .start_run(&fixture.storage, &fixture.runner, request)
        .unwrap();
    assert_eq!(first.id, second.id);
    let error = RuntimeService
        .start_run(
            &fixture.storage,
            &fixture.runner,
            fixture.request("two", AgentAdapter::Claude, false, 30),
        )
        .unwrap_err();
    assert!(matches!(
        error,
        RuntimeError::Storage(StorageError::CheckoutHasActiveWriter { .. })
    ));
    assert_eq!(
        fs::read_to_string(fixture.dir.path().join("launches")).unwrap(),
        "launch\n"
    );
    fixture.release();
    fixture.end(first.id, RunState::Settled, &["result"]);
}

#[test]
fn timeout_terminates_a_fifo_blocked_process() {
    let mut fixture = Fixture::new("printf R > ready\nread value < gate");
    let run = fixture.start(AgentAdapter::Claude, false, 1);
    fixture.ready();
    fixture.end(run.id, RunState::Failed, &["timed_out"]);
}

#[test]
fn stop_terminates_a_fifo_blocked_process_and_cancels() {
    let mut fixture = Fixture::new("printf R > ready\nread value < gate");
    let run = fixture.start(AgentAdapter::Claude, false, 30);
    fixture.ready();
    let ended = fixture.runner.stop(run.id).unwrap();
    assert_eq!(ended.state, RunState::Cancelled);
    fixture.end(run.id, RunState::Cancelled, &["stop_requested"]);
}

#[test]
fn stop_escalates_when_the_process_ignores_sigterm() {
    let mut fixture = Fixture::new("trap '' TERM\nprintf R > ready\nread value < gate");
    let run = fixture.start(AgentAdapter::Claude, false, 30);
    fixture.ready();
    assert_eq!(
        fixture.runner.stop(run.id).unwrap().state,
        RunState::Cancelled
    );
    fixture.end(run.id, RunState::Cancelled, &["stop_requested"]);
}

#[cfg(target_os = "linux")]
#[test]
fn stop_kills_descendants_even_after_the_leader_and_its_pipes_exit() {
    use std::os::fd::{FromRawFd, OwnedFd};

    let mut fixture = Fixture::new(
        r#"sh -c 'trap "" TERM; echo $$ > child_pid; exec 1>&- 2>&-; printf R > ready; read value < gate' &
wait"#,
    );
    let run = fixture.start(AgentAdapter::Claude, false, 30);
    fixture.ready();
    let pid: i32 = fs::read_to_string(fixture.dir.path().join("child_pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    assert!(fd >= 0);
    let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    assert_eq!(
        fixture.runner.stop(run.id).unwrap().state,
        RunState::Cancelled
    );
    let mut descriptor = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(unsafe { libc::poll(&mut descriptor, 1, 10_000) }, 1);
    fixture.end(run.id, RunState::Cancelled, &["stop_requested"]);
}

#[test]
fn overlong_result_line_is_logged_truncated_and_not_parsed() {
    let fixture = Fixture::new(
        r#"printf '{"type":"result","subtype":"success","result":"'
printf '%1048576s' x
printf '"}'
"#,
    );
    let run = fixture.start(AgentAdapter::Claude, false, 30);
    fixture.end(run.id, RunState::Failed, &["no_result"]);
    let log = fixture.runner.log(run.id, usize::MAX).unwrap();
    assert_eq!(log.stdout.len(), adapter::MAX_LINE_BYTES + 1);
}

#[test]
fn mcp_bearer_is_only_in_environment_and_is_redacted_from_logs_and_events() {
    let mut fixture = Fixture::new(
        r#"printf '%s\n' "$TOODO_MCP_TOKEN"
printf '%s\n' "$TOODO_MCP_TOKEN" >&2
cat /proc/$$/cmdline
printf '\n'
cat /proc/$$/cmdline >&2
printf '\n' >&2
printf R > ready
read value < gate
printf '{"type":"result","subtype":"success","result":"%s"}' "$TOODO_MCP_TOKEN"
"#,
    );
    let run = fixture.start(AgentAdapter::Claude, true, 30);
    fixture.ready();
    let pid = run
        .provider_run_ref
        .as_ref()
        .unwrap()
        .strip_prefix("pid:")
        .unwrap();
    let argv = fs::read(format!("/proc/{pid}/cmdline")).unwrap();
    assert!(!String::from_utf8_lossy(&argv).contains(TOKEN));
    fixture.release();
    fixture.end(run.id, RunState::Settled, &["result"]);
    let log = fixture.runner.log(run.id, 65536).unwrap();
    assert!(log.stdout.contains("[redacted]"));
    assert!(log.stderr.contains("[redacted]"));
    assert!(!format!("{log:?}").contains(TOKEN));
    let events = lock(&fixture.storage).run_events(run.id).unwrap();
    assert!(!format!("{events:?}").contains(TOKEN));
    assert!(
        events
            .iter()
            .any(|event| event.payload.as_deref() == Some("[redacted]"))
    );
    let config = fixture
        .dir
        .path()
        .join("runs")
        .join(run.id.to_string())
        .join("mcp.json");
    assert!(!fs::read_to_string(&config).unwrap().contains(TOKEN));
    assert_eq!(
        fs::metadata(config).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn codex_turn_completed_settles() {
    let fixture = Fixture::new(
        r#"printf '%s\n' '{"type":"thread.started","thread_id":"test"}' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}' '{"type":"turn.completed"}'"#,
    );
    let run = fixture.start(AgentAdapter::Codex, false, 30);
    fixture.end(run.id, RunState::Settled, &["result"]);
}

#[test]
fn changed_todo_lists_are_recorded_while_running() {
    let todo = |status: &str| {
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"TodoWrite","input":{{"todos":[{{"content":"Fix","status":"{status}","activeForm":"Fixing"}}]}}}}]}}}}"#
        )
    };
    let (pending, progress) = (todo("pending"), todo("in_progress"));
    // The gate holds output until the launch is recorded, so the events keep their order.
    let mut fixture = Fixture::new(&format!(
        "printf R > ready\nread value < gate\nprintf '%s\\n' '{pending}' '{progress}' '{progress}'\n{RESULT}"
    ));
    let run = fixture.start(AgentAdapter::Claude, false, 30);
    fixture.ready();
    fixture.release();
    fixture.end(run.id, RunState::Settled, &["todo", "todo", "result"]);
    let events = lock(&fixture.storage).run_events(run.id).unwrap();
    assert_eq!(
        events[2].payload.as_deref(),
        Some(r#"{"items":[{"text":"Fix","status":"pending"}]}"#)
    );
    assert_eq!(
        events[3].payload.as_deref(),
        Some(r#"{"items":[{"text":"Fix","status":"in_progress"}]}"#)
    );
}

#[test]
fn codex_turn_failed_fails() {
    let fixture =
        Fixture::new(r#"printf '%s\n' '{"type":"turn.failed","error":{"message":"try again"}}'"#);
    let run = fixture.start(AgentAdapter::Codex, false, 30);
    fixture.end(run.id, RunState::Failed, &["result_error"]);
}

#[test]
fn missing_program_fails_launch_with_next_step() {
    let mut fixture = Fixture::new(RESULT);
    fixture.runner = fixture
        .runner
        .clone()
        .with_programs(fixture.dir.path().join("missing"), "missing");
    let error = RuntimeService
        .start_run(
            &fixture.storage,
            &fixture.runner,
            fixture.request("one", AgentAdapter::Claude, false, 30),
        )
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("install claude on the server's PATH")
    );
    assert!(error.to_string().contains("other adapter"));
    let runs = lock(&fixture.storage).list_task_runs(fixture.task).unwrap();
    assert_eq!(runs[0].state, RunState::Failed);
    let events = lock(&fixture.storage).run_events(runs[0].id).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        ["reserved", "launch_failed"]
    );
}

fn reserve(fixture: &Fixture, key: &str) -> TaskRun {
    lock(&fixture.storage)
        .reserve_run(&NewRun {
            owner: OwnerKey::implicit(),
            task: fixture.task,
            request_key: key.to_owned(),
            runner_kind: RunnerKind::Plain,
            role: RunRole::Observer,
            host: HostRef::Local,
            checkout_path: Some(fixture.dir.path().to_str().unwrap().to_owned()),
            runtime_workspace: None,
            adapter_profile: None,
        })
        .unwrap()
        .into_run()
}

#[test]
fn settling_records_the_launch_before_the_service_records_its_receipt() {
    let fixture = Fixture::new(RESULT);
    let run = reserve(&fixture, "one");
    let spec = LaunchSpec {
        run: run.id,
        request_key: run.request_key,
        generation: run.generation,
        task: fixture.task,
        host: HostRef::Local,
        cwd: run.checkout_path,
        workspace_ref: None,
        command: fixture
            .request("one", AgentAdapter::Claude, false, 30)
            .command,
    };
    let receipt = fixture.runner.launch(&spec).unwrap();
    fixture.end(run.id, RunState::Settled, &["result"]);
    let recorded = lock(&fixture.storage)
        .record_launch(run.id, &receipt.provider_run_ref)
        .unwrap();
    assert_eq!(recorded.state, RunState::Settled);
    assert_eq!(recorded.provider_run_ref, Some(receipt.provider_run_ref));
}

#[test]
fn restart_marks_reserved_and_running_unknown_and_stop_without_process_cancels() {
    let fixture = Fixture::new(RESULT);
    let reserved = reserve(&fixture, "reserved");
    let running = reserve(&fixture, "running");
    lock(&fixture.storage)
        .record_launch(running.id, "pid:123")
        .unwrap();
    PlainRunner::recover_after_restart(&fixture.storage).unwrap();
    for run in [reserved, running] {
        let storage = lock(&fixture.storage);
        assert_eq!(
            storage.get_run(run.id).unwrap().unwrap().state,
            RunState::Unknown
        );
        let events = storage.run_events(run.id).unwrap();
        assert!(events.iter().any(|event| event.kind == "server_restarted"));
        drop(storage);
        assert_eq!(
            fixture.runner.stop(run.id).unwrap().state,
            RunState::Cancelled
        );
    }
}

#[test]
fn non_plain_runners_reject_agent_command_with_plain_next_step() {
    use crate::adapters::{git::fake::FakeRunner, herdr::Herdr};
    let fixture = Fixture::new(RESULT);
    let spec = LaunchSpec {
        run: RunId(1),
        request_key: "one".to_owned(),
        generation: 1,
        task: fixture.task,
        host: HostRef::Local,
        cwd: None,
        workspace_ref: None,
        command: fixture
            .request("one", AgentAdapter::Claude, false, 30)
            .command,
    };
    assert!(
        NoRunner
            .launch(&spec)
            .unwrap_err()
            .0
            .contains("runner plain")
    );
    let herdr = Herdr::new(Box::new(Arc::new(FakeRunner::new(vec![]))));
    assert!(herdr.launch(&spec).unwrap_err().0.contains("runner plain"));
}
