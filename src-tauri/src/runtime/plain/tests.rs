use std::ffi::CString;
use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use super::*;
use crate::domain::model::{CompletionMode, Runner, Source, TaskId, TaskType, WorkspaceLocation};
use crate::domain::path::PosixPath;
use crate::domain::runtime::{OwnerKey, RunRole, RunUsage};
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
        let runner = PlainRunner::new(storage.clone(), dir.path().join("runs"), "0123456789ab")
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
                options: Default::default(),
                timeout_secs,
                resume: None,
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
    fixture.end(run.id, RunState::Settled, &["agent_session", "result"]);
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
fn runs_record_their_last_activity_and_reported_usage() {
    let fixture = Fixture::new(
        r#"printf '%s\n' '{"type":"thread.started","thread_id":"t"}' '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":9}}'"#,
    );
    lock(&fixture.storage).set_clock(|| 4242);
    let run = fixture.start(AgentAdapter::Codex, false, 30);
    let ended = fixture.end(run.id, RunState::Settled, &["agent_session", "result"]);
    assert_eq!(ended.last_activity_at, Some(4242));
    assert_eq!(
        ended.usage,
        Some(RunUsage {
            input_tokens: 120,
            cached_input_tokens: 20,
            output_tokens: 9,
        })
    );
    // An ended run keeps the activity it had.
    let mut storage = lock(&fixture.storage);
    storage.set_clock(|| 9999);
    assert!(!storage.record_run_activity(run.id, None).unwrap());
    assert_eq!(
        storage.get_run(run.id).unwrap().unwrap().last_activity_at,
        Some(4242)
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
            conversation: None,
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
    fixture.runner.recover_after_restart().unwrap();
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

/// Starts the agent the way an earlier server process did, without managing it, and lets
/// a thread reap the wrapper like that process would have. Joining the thread waits for
/// the wrapper to exit.
fn launch_unmanaged(
    fixture: &Fixture,
    key: &str,
) -> (
    TaskRun,
    std::thread::JoinHandle<std::io::Result<std::process::ExitStatus>>,
) {
    let run = reserve(fixture, key);
    let dir = fixture.dir.path().join("runs").join(run.id.to_string());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("brief.md"), "Implement the task").unwrap();
    fs::write(
        dir.join(LAUNCH_FILE),
        format!("claude {}\n", unix_now() + 60),
    )
    .unwrap();
    let invocation = AgentAdapter::Claude.invocation(&dir, None, &Default::default(), None);
    let mut child = process::spawn_local(
        &fixture.runner.claude,
        fixture.dir.path().to_str().unwrap(),
        &dir,
        File::open(dir.join("brief.md")).unwrap(),
        File::create(dir.join(process::RAW_STDOUT)).unwrap(),
        File::create(dir.join(process::RAW_STDERR)).unwrap(),
        &invocation,
    )
    .unwrap();
    let run = lock(&fixture.storage)
        .record_launch(run.id, &format!("pid:{}", child.id()))
        .unwrap();
    (run, std::thread::spawn(move || child.wait()))
}

fn event_kinds(fixture: &Fixture, run: RunId) -> Vec<String> {
    lock(&fixture.storage)
        .run_events(run)
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect()
}

#[test]
fn restart_reattaches_a_running_local_run_and_settles_it_from_its_output() {
    let todo = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[{"content":"Fix","status":"pending","activeForm":"Fixing"}]}}]}}"#;
    let mut fixture = Fixture::new(&format!(
        "printf '%s\\n' '{todo}'\nprintf R > ready\nread value < gate\n{RESULT}"
    ));
    let (run, _) = launch_unmanaged(&fixture, "one");
    fixture.ready();
    // The earlier server process recorded the todo list before it went away.
    lock(&fixture.storage)
        .append_run_event(run.id, "todo", Some("before restart"))
        .unwrap();
    fixture.runner.recover_after_restart().unwrap();
    assert_eq!(
        lock(&fixture.storage)
            .get_run(run.id)
            .unwrap()
            .unwrap()
            .state,
        RunState::Running
    );
    fixture.release();
    let ended = fixture.runner.wait_for_end(run.id, WAIT).unwrap();
    assert_eq!(ended.state, RunState::Settled);
    assert_eq!(
        event_kinds(&fixture, run.id),
        [
            "reserved",
            "launched",
            "todo",
            "server_restarted",
            "reattached",
            "result",
            "settled"
        ]
    );
    let log = fixture.runner.log(run.id, 65536).unwrap();
    assert!(log.stdout.starts_with(todo), "{}", log.stdout);
    assert!(log.stdout.contains(r#""result":"done""#));
    let dir = fixture.dir.path().join("runs").join(run.id.to_string());
    assert!(!dir.join(process::RAW_STDOUT).exists());
    assert!(!dir.join(process::RAW_STDERR).exists());
}

#[test]
fn restart_settles_a_local_run_that_ended_while_the_server_was_down() {
    let fixture = Fixture::new(&format!("printf 'warning\\n' >&2\n{RESULT}\nexit 3"));
    let (run, wrapper) = launch_unmanaged(&fixture, "one");
    assert_eq!(wrapper.join().unwrap().unwrap().code(), Some(3));
    fixture.runner.recover_after_restart().unwrap();
    let ended = fixture.runner.wait_for_end(run.id, WAIT).unwrap();
    assert_eq!(ended.state, RunState::Exited);
    assert_eq!(
        event_kinds(&fixture, run.id),
        [
            "reserved",
            "launched",
            "server_restarted",
            "reattached",
            "exit_after_result",
            "exited"
        ]
    );
    assert_eq!(
        fixture.runner.log(run.id, 65536).unwrap().stderr,
        "warning\n"
    );
}

#[test]
fn a_reattached_run_stops_and_a_vanished_one_fails_as_interrupted() {
    let mut fixture = Fixture::new("printf R > ready\nread value < gate");
    let (stopped, _) = launch_unmanaged(&fixture, "stopped");
    fixture.ready();
    let (vanished, wrapper) = launch_unmanaged(&fixture, "vanished");
    fixture.ready();
    let pid: i32 = vanished
        .provider_run_ref
        .as_deref()
        .unwrap()
        .strip_prefix("pid:")
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(-pid, libc::SIGKILL) }, 0);
    assert!(wrapper.join().unwrap().unwrap().code().is_none());
    fixture.runner.recover_after_restart().unwrap();
    assert_eq!(
        fixture.runner.stop(stopped.id).unwrap().state,
        RunState::Cancelled
    );
    assert!(event_kinds(&fixture, stopped.id).ends_with(&[
        "reattached".to_owned(),
        "stop_requested".to_owned(),
        "cancelled".to_owned()
    ]));
    let ended = fixture.runner.wait_for_end(vanished.id, WAIT).unwrap();
    assert_eq!(ended.state, RunState::Failed);
    assert!(event_kinds(&fixture, vanished.id).ends_with(&[
        "reattached".to_owned(),
        "interrupted".to_owned(),
        "failed".to_owned()
    ]));
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

impl Fixture {
    fn enable_remote(&mut self) {
        let ssh = self.dir.path().join("ssh");
        fs::write(
            &ssh,
            r#"#!/bin/sh
HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export HOME
printf '%s\n' "$@" >> "$HOME/ssh-argv"
test ! -f "$HOME/offline" || exit 255
while [ "$1" != "--" ]; do shift; done
shift
test "$1" = test-host || exit 254
shift
case "$1" in
    "command -v setsid "*)
        test ! -f "$HOME/no-setsid" || exit 1
        ;;
    "exec setsid "*)
        if [ -f "$HOME/disconnect" ]; then
            sh -c "$1" </dev/null > "$HOME/remote.out" 2> "$HOME/remote.err" &
            read disconnect < "$HOME/transport-gate"
            exit 255
        fi
        ;;
esac
exec sh -c "$1"
"#,
        )
        .unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
        self.runner.ssh = ssh;
        self.runner = self
            .runner
            .clone()
            .with_tunnel_open_provider(Arc::new(|target| target == "test-host"));
    }

    fn start_remote(&self, mcp: bool) -> TaskRun {
        let mut request = self.request("remote", AgentAdapter::Claude, mcp, 60);
        request.host = HostRef::Ssh("test-host".into());
        RuntimeService
            .start_run(&self.storage, &self.runner, request)
            .unwrap()
    }

    fn remote(&self) -> remote::Remote {
        remote::Remote::from_run(
            &HostRef::Ssh("test-host".into()),
            self.dir.path().to_str(),
            &self.runner.ssh,
            &self.runner.instance,
        )
        .unwrap()
        .unwrap()
    }

    fn reserve_remote(&self, key: &str) -> TaskRun {
        let run = lock(&self.storage)
            .reserve_run(&NewRun {
                owner: OwnerKey::implicit(),
                task: self.task,
                request_key: key.into(),
                runner_kind: RunnerKind::Plain,
                role: RunRole::Observer,
                host: HostRef::Ssh("test-host".into()),
                checkout_path: Some(self.dir.path().to_str().unwrap().into()),
                runtime_workspace: None,
                adapter_profile: None,
                conversation: None,
            })
            .unwrap()
            .into_run();
        lock(&self.storage)
            .record_launch(run.id, &format!("ssh:test-host:{}", run.id))
            .unwrap()
    }
}

#[test]
fn remote_success_stages_private_credentials_and_redacts_streams() {
    let mut fixture = Fixture::new(&format!(
        r#"
test "$TOODO_MCP_URL" = http://127.0.0.1:12345/mcp || exit 2
test "$TOODO_MCP_TOKEN" = {TOKEN} || exit 3
IFS= read -r brief
test "$brief" = 'Implement the task' || exit 4
while [ "$1" != --mcp-config ]; do shift; done
test -f "$2" || exit 5
printf '%s\n' "$TOODO_MCP_TOKEN"
printf '%s\n' "$TOODO_MCP_TOKEN" >&2
{RESULT}
"#
    ));
    fixture.enable_remote();
    // Remote agents must use the reverse tunnel, not the server's listen address.
    fixture.runner.mcp = Some(Arc::new(|| {
        Some(McpEndpoint {
            url: "http://192.0.2.1:12345/mcp".into(),
            token: TOKEN.into(),
        })
    }));
    let run = fixture.start_remote(true);
    assert_eq!(
        run.provider_run_ref,
        Some(format!("ssh:test-host:{}", run.id))
    );
    fixture.end(run.id, RunState::Settled, &["result"]);
    let remote_dir = fixture
        .dir
        .path()
        .join(".toodo/runs/0123456789ab")
        .join(run.id.to_string());
    assert_eq!(
        fs::metadata(&remote_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    // The ended run's staged credentials are gone; its brief, logs, and exit are kept.
    assert!(!remote_dir.join("token").exists());
    assert!(!remote_dir.join("mcp.json").exists());
    assert!(remote_dir.join("brief.md").exists());
    let config = fs::read_to_string(
        fixture
            .dir
            .path()
            .join("runs")
            .join(run.id.to_string())
            .join("mcp.json"),
    )
    .unwrap();
    assert!(config.contains("${TOODO_MCP_TOKEN}"));
    assert!(config.contains("${TOODO_MCP_URL}"));
    assert!(!config.contains(TOKEN));
    let argv = fs::read_to_string(fixture.dir.path().join("ssh-argv")).unwrap();
    assert!(!argv.contains(TOKEN));
    let log = fixture.runner.log(run.id, 65536).unwrap();
    assert!(log.stdout.contains("[redacted]"));
    assert!(log.stderr.contains("[redacted]"));
    assert!(!format!("{log:?}").contains(TOKEN));
    assert!(!format!("{:?}", lock(&fixture.storage).run_events(run.id).unwrap()).contains(TOKEN));
    assert_eq!(fs::read_to_string(remote_dir.join("exit")).unwrap(), "0\n");
}

#[test]
fn remote_launch_without_setsid_names_the_next_step_before_staging() {
    let mut fixture = Fixture::new(RESULT);
    fixture.enable_remote();
    fs::write(fixture.dir.path().join("no-setsid"), "").unwrap();
    let mut request = fixture.request("remote", AgentAdapter::Claude, false, 60);
    request.host = HostRef::Ssh("test-host".into());
    let error = RuntimeService
        .start_run(&fixture.storage, &fixture.runner, request)
        .unwrap_err()
        .to_string();
    assert!(error.contains("install util-linux setsid"), "{error}");
    assert!(error.contains("runner herdr"), "{error}");
    let argv = fs::read_to_string(fixture.dir.path().join("ssh-argv")).unwrap();
    assert!(!argv.contains("exec setsid"), "{argv}");
    assert!(!fixture.dir.path().join(".toodo").exists());
}

#[test]
fn remote_nonzero_exit_uses_adapter_classification() {
    let mut fixture = Fixture::new("printf 'agent failed' >&2\nexit 17");
    fixture.enable_remote();
    let run = fixture.start_remote(false);
    fixture.end(run.id, RunState::Failed, &["stderr", "exit"]);
    assert!(
        lock(&fixture.storage)
            .run_events(run.id)
            .unwrap()
            .iter()
            .any(|event| event.payload.as_deref() == Some("exit code 17"))
    );
}

#[test]
fn remote_agent_exit_255_is_distinguished_from_transport_loss() {
    let mut fixture = Fixture::new("exit 255");
    fixture.enable_remote();
    let run = fixture.start_remote(false);
    fixture.end(run.id, RunState::Failed, &["stderr", "exit"]);
    assert_eq!(
        fixture.remote().probe(run.id).unwrap(),
        super::super::host::Probe::Exited(255)
    );
}

#[test]
fn remote_connection_loss_keeps_agent_running_until_reconciled_and_stopped() {
    let mut fixture = Fixture::new("printf R > ready\nread value < gate");
    fixture.enable_remote();
    fs::write(fixture.dir.path().join("disconnect"), "").unwrap();
    let mut transport = fifo(&fixture.dir.path().join("transport-gate"));
    let run = fixture.start_remote(false);
    fixture.ready();
    transport.write_all(b"disconnect\n").unwrap();
    fixture.end(run.id, RunState::Unknown, &["observation_lost"]);
    assert_eq!(
        fixture.remote().probe(run.id).unwrap(),
        super::super::host::Probe::Running
    );
    assert_eq!(
        fixture.runner.reconcile(run.id).unwrap().state,
        RunState::Unknown
    );
    assert!(
        lock(&fixture.storage)
            .run_events(run.id)
            .unwrap()
            .iter()
            .any(|event| event.kind == "remote_still_running")
    );
    assert_eq!(
        fixture.runner.stop(run.id).unwrap().state,
        RunState::Cancelled
    );
}

#[cfg(target_os = "linux")]
#[test]
fn remote_stop_cancels_and_terminates_the_remote_process_group() {
    use std::os::fd::{FromRawFd, OwnedFd};
    let mut fixture = Fixture::new(
        r#"
sh -c 'trap "" TERM; echo $$ > child_pid; printf R > ready; read value < gate' &
wait
"#,
    );
    fixture.enable_remote();
    let run = fixture.start_remote(false);
    fixture.ready();
    // An attached stream is authoritative; reconcile must not downgrade it.
    assert_eq!(
        fixture.runner.reconcile(run.id).unwrap().state,
        RunState::Running
    );
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
fn remote_stop_failure_keeps_stream_active_until_connectivity_returns() {
    let mut fixture = Fixture::new("printf R > ready\nread value < gate");
    fixture.enable_remote();
    let run = fixture.start_remote(false);
    fixture.ready();
    fs::write(fixture.dir.path().join("offline"), "").unwrap();
    let error = fixture.runner.stop(run.id).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("reconcile the run once the host is reachable")
    );
    assert_eq!(
        lock(&fixture.storage)
            .get_run(run.id)
            .unwrap()
            .unwrap()
            .state,
        RunState::Running
    );
    assert!(
        lock(&fixture.storage)
            .run_events(run.id)
            .unwrap()
            .iter()
            .any(|event| event.kind == "stop_requested")
    );
    fs::remove_file(fixture.dir.path().join("offline")).unwrap();
    assert_eq!(
        fixture.runner.stop(run.id).unwrap().state,
        RunState::Cancelled
    );
}

#[test]
fn remote_stop_before_pid_prevents_a_late_wrapper_from_starting_the_agent() {
    let mut fixture = Fixture::new("printf unexpected > agent_started");
    fixture.enable_remote();
    let run = fixture.reserve_remote("late");
    let remote = fixture.remote();
    remote.create_directory(run.id).unwrap();
    remote.stage(run.id, "brief.md", b"brief").unwrap();
    assert_eq!(
        fixture.runner.stop(run.id).unwrap().state,
        RunState::Cancelled
    );
    let invocation =
        AgentAdapter::Claude.invocation(Path::new("unused"), None, &Default::default(), None);
    let (child, _, _) = remote
        .spawn(
            run.id,
            fixture.dir.path().to_str().unwrap(),
            &fixture.runner.claude,
            &invocation,
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(143));
    assert!(!fixture.dir.path().join("agent_started").exists());
}

#[test]
fn remote_reconcile_maps_durable_evidence_and_restart_never_contacts_ssh() {
    let mut fixture = Fixture::new(RESULT);
    fixture.enable_remote();
    let remote = fixture.remote();
    let identity = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &std::process::id().to_string()])
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(identity.status.success());
    let identity = String::from_utf8(identity.stdout).unwrap();
    for (key, file, data, state, event) in [
        ("clean", "exit", "0".to_owned(), RunState::Exited, "exit"),
        ("failed", "exit", "19".to_owned(), RunState::Failed, "exit"),
        (
            "running",
            "pid",
            format!("{} {}", std::process::id(), identity),
            RunState::Unknown,
            "remote_still_running",
        ),
        (
            "gone",
            "pid",
            "2147483647 old identity".to_owned(),
            RunState::Failed,
            "interrupted",
        ),
        (
            "missing",
            "brief.md",
            String::new(),
            RunState::Unknown,
            "remote_missing",
        ),
    ] {
        let run = fixture.reserve_remote(key);
        remote.create_directory(run.id).unwrap();
        remote.stage(run.id, file, data.as_bytes()).unwrap();
        let count = fs::read_to_string(fixture.dir.path().join("ssh-argv"))
            .unwrap()
            .len();
        fixture.runner.recover_after_restart().unwrap();
        assert_eq!(
            fs::read_to_string(fixture.dir.path().join("ssh-argv"))
                .unwrap()
                .len(),
            count
        );
        assert_eq!(
            lock(&fixture.storage)
                .get_run(run.id)
                .unwrap()
                .unwrap()
                .state,
            RunState::Unknown
        );
        assert_eq!(fixture.runner.reconcile(run.id).unwrap().state, state);
        let events = lock(&fixture.storage).run_events(run.id).unwrap();
        assert!(events.iter().any(|item| item.kind == "server_restarted"));
        assert!(events.iter().any(|item| item.kind == event));
        if key == "failed" {
            assert!(
                events
                    .iter()
                    .any(|item| item.payload.as_deref() == Some("exit code 19"))
            );
        }
    }
    let run = fixture.reserve_remote("unreachable");
    fs::write(fixture.dir.path().join("offline"), "").unwrap();
    assert!(
        fixture
            .runner
            .reconcile(run.id)
            .unwrap_err()
            .to_string()
            .contains("reconcile the run once the host is reachable")
    );
    assert_eq!(
        lock(&fixture.storage)
            .get_run(run.id)
            .unwrap()
            .unwrap()
            .state,
        RunState::Running
    );
    assert!(fixture.runner.stop(run.id).is_err());
    assert_eq!(
        lock(&fixture.storage)
            .get_run(run.id)
            .unwrap()
            .unwrap()
            .state,
        RunState::Running
    );
}

#[test]
fn remote_runs_left_unknown_by_a_restart_are_reconciled_in_a_background_pass() {
    let mut fixture = Fixture::new(RESULT);
    fixture.enable_remote();
    let remote = fixture.remote();
    let identity = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &std::process::id().to_string()])
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    let identity = String::from_utf8(identity.stdout).unwrap();
    let clean = fixture.reserve_remote("clean");
    remote.create_directory(clean.id).unwrap();
    remote.stage(clean.id, "exit", b"0").unwrap();
    let running = fixture.reserve_remote("running");
    remote.create_directory(running.id).unwrap();
    remote
        .stage(
            running.id,
            "pid",
            format!("{} {identity}", std::process::id()).as_bytes(),
        )
        .unwrap();
    fixture.runner.recover_after_restart().unwrap();
    let tmux = crate::runtime::tmux::TmuxRunner::new(
        fixture.storage.clone(),
        fixture.dir.path().join("runs"),
        "0123456789ab",
    );
    let pass =
        crate::runtime::reconcile_remote_runs(&fixture.storage, &fixture.runner, &tmux).unwrap();
    let state = |run: RunId| lock(&fixture.storage).get_run(run).unwrap().unwrap().state;
    assert_eq!(state(clean.id), RunState::Exited);
    assert_eq!(state(running.id), RunState::Unknown);
    assert!(pass.pending);
    assert_eq!(pass.changed.len(), 1);
    let events = event_kinds(&fixture, running.id);
    // A later pass finds the same live agent and records nothing new.
    let again =
        crate::runtime::reconcile_remote_runs(&fixture.storage, &fixture.runner, &tmux).unwrap();
    assert!(again.pending && again.changed.is_empty());
    assert_eq!(event_kinds(&fixture, running.id), events);
    assert_eq!(
        events.last().map(String::as_str),
        Some("remote_still_running")
    );
}

#[test]
fn remote_mcp_requires_an_open_tunnel_before_staging_or_spawning() {
    for provider in [None, Some(Arc::new(|_: &str| false) as TunnelOpenProvider)] {
        let mut fixture = Fixture::new(RESULT);
        fixture.enable_remote();
        fixture.runner.tunnel_open = provider;
        let mut request = fixture.request("remote", AgentAdapter::Claude, true, 60);
        request.host = HostRef::Ssh("test-host".into());
        let error = RuntimeService
            .start_run(&fixture.storage, &fixture.runner, request)
            .unwrap_err();
        assert!(error.to_string().contains("wait for the tunnel to open"));
        assert!(error.to_string().contains("mcp false"));
        assert!(!fixture.dir.path().join("ssh-argv").exists());
    }
}

#[test]
fn remote_windows_uses_native_staging_launch_stop_and_probe_scripts() {
    use crate::adapters::git::fake::decode_powershell;
    use crate::runtime::host::{HostOs, RunKey};
    let remote = remote::Remote::from_run(
        &HostRef::Ssh("windows".into()),
        Some(r"C:\repo"),
        Path::new("ssh"),
        "0123456789ab",
    )
    .unwrap()
    .unwrap();
    assert_eq!(remote.host.os(), HostOs::Windows);
    let endpoint = McpEndpoint {
        url: "http://127.0.0.1:12345/mcp".into(),
        token: TOKEN.into(),
    };
    let invocation = AgentAdapter::Claude.invocation(
        Path::new("unused"),
        Some(&endpoint),
        &Default::default(),
        None,
    );
    let launch = remote
        .launch_invocation(RunId(42), r"C:\repo", Path::new("claude.exe"), &invocation)
        .unwrap();
    let script = decode_powershell(&launch.args[4]);
    assert!(script.contains("(Join-Path $run 'mcp.json')"));
    assert!(script.contains("$info.WorkingDirectory = 'C:\\repo'"));
    assert!(
        script.contains(
            "$info.EnvironmentVariables['TOODO_MCP_TOKEN'] = [System.IO.File]::ReadAllText"
        )
    );
    assert!(script.contains("'http://127.0.0.1:12345/mcp'"));
    let stage = remote.host.stage(
        RunKey {
            instance: "0123456789ab",
            id: RunId(42),
        },
        "token",
    );
    let stop = remote.host.stop(RunKey {
        instance: "0123456789ab",
        id: RunId(42),
    });
    let probe = remote.host.probe(RunKey {
        instance: "0123456789ab",
        id: RunId(42),
    });
    assert!(decode_powershell(&stage.args[4]).contains("[Console]::OpenStandardInput().CopyTo"));
    assert!(decode_powershell(&stop.args[4]).contains("taskkill /PID $process.Id /T /F"));
    assert!(decode_powershell(&probe.args[4]).contains("StartTime.ToFileTimeUtc()"));
    for invocation in [launch, stage, stop, probe] {
        let decoded = decode_powershell(&invocation.args[4]);
        assert!(!decoded.contains(TOKEN));
        assert!(!decoded.contains("sh -c"));
    }
}

#[test]
fn remote_leftover_markers_reject_launch_before_writing_or_starting() {
    for marker in ["stop", "exit"] {
        let mut fixture = Fixture::new("printf unexpected > agent_started");
        fixture.enable_remote();
        let dir = fixture.dir.path().join(".toodo/runs/0123456789ab/1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(marker), "143").unwrap();
        let mut request = fixture.request("remote", AgentAdapter::Claude, false, 60);
        request.host = HostRef::Ssh("test-host".into());
        let error = RuntimeService
            .start_run(&fixture.storage, &fixture.runner, request)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!(
                "remove the leftover directory {} on test-host, then start a new run",
                dir.display()
            )),
            "{error}"
        );
        assert_eq!(fs::read_to_string(dir.join(marker)).unwrap(), "143");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert!(!fixture.dir.path().join("agent_started").exists());
        let events = lock(&fixture.storage).run_events(RunId(1)).unwrap();
        assert!(
            !events
                .iter()
                .any(|event| event.kind == "launched" || event.kind == "exit")
        );
    }
}
