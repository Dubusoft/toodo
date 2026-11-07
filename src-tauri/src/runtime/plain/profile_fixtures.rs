//! Fixture tests of the agent profiles added after Claude and Codex. Each fixture in
//! `fixtures/` is the JSON event stream a pinned release of the agent CLI wrote during its
//! contract probe (named `<agent>-<version>-<case>.jsonl`), trimmed of fields the tracker
//! never reads. They pin the parsing to what the CLI really writes; `profile_smoke.rs`
//! runs the installed CLIs themselves.

use std::path::Path;

use super::adapter::*;
use crate::domain::model::PermissionMode;
use crate::domain::runtime::{RunState, RunUsage};

const TOKEN: &str = "s3cr3t-token-value";

fn endpoint() -> McpEndpoint {
    McpEndpoint {
        url: "http://127.0.0.1:47616/mcp".to_owned(),
        token: TOKEN.to_owned(),
    }
}

fn replay(adapter: AgentAdapter, fixture: &str) -> (EventTracker, Vec<String>) {
    let mut tracker = EventTracker::new(adapter);
    let todos = fixture
        .lines()
        .filter_map(|line| tracker.feed(line))
        .collect();
    (tracker, todos)
}

fn args(adapter: AgentAdapter, options: &LaunchOptions, resume: Option<&str>) -> Vec<String> {
    adapter
        .invocation(Path::new("/data/runs/7"), None, options, resume)
        .args
}

fn mode(mode: PermissionMode) -> LaunchOptions {
    LaunchOptions {
        model: None,
        permission_mode: Some(mode),
    }
}

#[test]
fn pi_invocation_reads_stdin_and_maps_read_only_to_a_tool_set() {
    let default = LaunchOptions::default();
    assert_eq!(
        args(AgentAdapter::Pi, &default, None),
        ["-p", "--mode", "json"]
    );
    let options = LaunchOptions {
        model: Some("anthropic/claude-sonnet-4-5".to_owned()),
        permission_mode: Some(PermissionMode::ReadOnly),
    };
    assert_eq!(
        args(AgentAdapter::Pi, &options, Some("sess-1")),
        [
            "-p",
            "--mode",
            "json",
            "--tools",
            "read,grep,find,ls",
            "--model",
            "anthropic/claude-sonnet-4-5",
            "--session",
            "sess-1"
        ]
    );
    let inv = AgentAdapter::Pi.invocation(Path::new("/r"), None, &default, None);
    assert_eq!(inv.program_key, "pi");
    assert!(inv.files.is_empty() && inv.env.is_empty());
}

#[test]
fn omo_invocation_resumes_by_session_id() {
    assert_eq!(
        args(
            AgentAdapter::Omo,
            &mode(PermissionMode::Bypass),
            Some("s-1")
        ),
        ["-p", "--mode", "json", "--session", "s-1"]
    );
    assert_eq!(
        AgentAdapter::Omo
            .invocation(Path::new("/r"), None, &LaunchOptions::default(), None)
            .program_key,
        "omo"
    );
}

#[test]
fn opencode_invocation_maps_modes_and_adds_mcp_through_a_config_file() {
    assert_eq!(
        args(
            AgentAdapter::OpenCode,
            &mode(PermissionMode::ReadOnly),
            None
        ),
        ["run", "--format", "json", "--agent", "plan"]
    );
    assert_eq!(
        args(AgentAdapter::OpenCode, &mode(PermissionMode::Edit), None),
        ["run", "--format", "json"]
    );
    let options = LaunchOptions {
        model: Some("anthropic/claude-sonnet-4-5".to_owned()),
        permission_mode: Some(PermissionMode::Bypass),
    };
    assert_eq!(
        args(AgentAdapter::OpenCode, &options, Some("ses_1")),
        [
            "run",
            "--format",
            "json",
            "--auto",
            "--model",
            "anthropic/claude-sonnet-4-5",
            "--session",
            "ses_1"
        ]
    );

    let inv = AgentAdapter::OpenCode.invocation(
        Path::new("/data/runs/7"),
        Some(&endpoint()),
        &LaunchOptions::default(),
        None,
    );
    assert!(inv.env.contains(&(
        OPENCODE_CONFIG_ENV.to_owned(),
        "/data/runs/7/opencode.json".to_owned()
    )));
    let (name, content) = &inv.files[0];
    assert_eq!(name, OPENCODE_CONFIG_FILE);
    assert!(!content.contains(TOKEN));
    let config: serde_json::Value = serde_json::from_str(content).unwrap();
    let toodo = &config["mcp"]["toodo"];
    assert_eq!(toodo["type"], "remote");
    assert_eq!(toodo["url"], "http://127.0.0.1:47616/mcp");
    assert_eq!(
        toodo["headers"]["Authorization"],
        "Bearer {env:TOODO_MCP_TOKEN}"
    );
}

#[test]
fn gemini_invocation_runs_headless_on_stdin_in_a_trusted_worktree() {
    let expect = |mode_flag: &'static str| {
        vec![
            "-p",
            "",
            "--output-format",
            "stream-json",
            "--skip-trust",
            "--approval-mode",
            mode_flag,
        ]
    };
    assert_eq!(
        args(AgentAdapter::Gemini, &mode(PermissionMode::ReadOnly), None),
        expect("plan")
    );
    assert_eq!(
        args(AgentAdapter::Gemini, &mode(PermissionMode::Edit), None),
        expect("auto_edit")
    );
    assert_eq!(
        args(AgentAdapter::Gemini, &LaunchOptions::default(), None),
        expect("yolo")
    );
    let options = LaunchOptions {
        model: Some("gemini-2.5-pro".to_owned()),
        permission_mode: None,
    };
    assert_eq!(
        args(AgentAdapter::Gemini, &options, Some("uuid-1"))[7..],
        ["--model", "gemini-2.5-pro", "--resume", "uuid-1"]
    );
}

#[test]
fn pi_fixture_records_session_result_and_usage() {
    let (tracker, todos) = replay(
        AgentAdapter::Pi,
        include_str!("fixtures/pi-0.73.1-success.jsonl"),
    );
    assert_eq!(
        tracker.session_id(),
        Some("01a1b4d1-227b-746f-8cc3-70c35dda9fa6")
    );
    assert_eq!(tracker.success_summary(), Some("PROBE_OK"));
    assert!(tracker.error_message().is_none());
    assert_eq!(
        tracker.usage(),
        Some(RunUsage {
            input_tokens: 11,
            cached_input_tokens: 0,
            output_tokens: 3,
        })
    );
    assert!(todos.is_empty());
}

#[test]
fn pi_fixture_error_fails_the_run_though_pi_exits_zero() {
    let (tracker, _) = replay(
        AgentAdapter::Pi,
        include_str!("fixtures/pi-0.73.1-error.jsonl"),
    );
    assert_eq!(tracker.error_message(), Some("Connection error."));
    let outcome = classify(&tracker, ExitKind::Code(0), "");
    assert_eq!(outcome.state, RunState::Failed);
    assert_eq!(
        outcome.events,
        [("result_error", "Connection error.".to_owned())]
    );
}

#[test]
fn pi_retry_that_succeeds_settles_the_run() {
    let mut tracker = EventTracker::new(AgentAdapter::Pi);
    tracker.feed(r#"{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"overloaded"}]}"#);
    tracker.feed(r#"{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}]}"#);
    assert_eq!(
        classify(&tracker, ExitKind::Code(0), "").state,
        RunState::Settled
    );
}

#[test]
fn omo_fixture_mirrors_the_todo_list_and_sums_usage() {
    let (tracker, todos) = replay(
        AgentAdapter::Omo,
        include_str!("fixtures/omo-5.1.61-todo.jsonl"),
    );
    assert_eq!(
        todos,
        [r#"{"items":[{"text":"Probe step","status":"in_progress"}]}"#]
    );
    assert_eq!(
        tracker.session_id(),
        Some("0190c0de-0000-7000-8000-000000000001")
    );
    assert_eq!(tracker.success_summary(), Some("PROBE_OK"));
    assert_eq!(
        tracker.usage(),
        Some(RunUsage {
            input_tokens: 2 + 100 + 50 + 1 + 150 + 10,
            cached_input_tokens: 250,
            output_tokens: 12,
        })
    );
}

#[test]
fn opencode_fixture_mirrors_todowrite_and_settles_on_the_last_step() {
    let (tracker, todos) = replay(
        AgentAdapter::OpenCode,
        include_str!("fixtures/opencode-1.19.5-success.jsonl"),
    );
    assert_eq!(
        todos,
        [r#"{"items":[{"text":"Probe step","status":"in_progress"}]}"#]
    );
    assert_eq!(tracker.session_id(), Some("ses_e4b2d722effeFL4pCyqhLk2zwR"));
    assert_eq!(tracker.success_summary(), Some("PROBE_OK"));
    assert_eq!(
        tracker.usage(),
        Some(RunUsage {
            input_tokens: 22,
            cached_input_tokens: 0,
            output_tokens: 6,
        })
    );
    assert_eq!(
        classify(&tracker, ExitKind::Code(0), "").state,
        RunState::Settled
    );
}

#[test]
fn opencode_step_that_calls_tools_is_not_a_result() {
    let mut tracker = EventTracker::new(AgentAdapter::OpenCode);
    tracker.feed(r#"{"type":"step_finish","sessionID":"s","part":{"reason":"tool-calls"}}"#);
    assert!(tracker.success_summary().is_none());
}

#[test]
fn opencode_fixture_error_fails_with_its_message() {
    let (tracker, _) = replay(
        AgentAdapter::OpenCode,
        include_str!("fixtures/opencode-1.19.5-error.jsonl"),
    );
    assert!(
        tracker
            .error_message()
            .unwrap()
            .starts_with("Cannot connect to API: ECONNREFUSED")
    );
    assert_eq!(
        classify(&tracker, ExitKind::Code(1), "").state,
        RunState::Failed
    );
}

#[test]
fn gemini_fixture_mirrors_write_todos_and_records_the_answer() {
    let (tracker, todos) = replay(
        AgentAdapter::Gemini,
        include_str!("fixtures/gemini-0.67.0-todo.jsonl"),
    );
    assert_eq!(
        todos,
        [r#"{"items":[{"text":"Probe step","status":"in_progress"}]}"#]
    );
    assert_eq!(
        tracker.session_id(),
        Some("fea684ae-dc63-4018-b797-90bcc9cf6fa6")
    );
    assert_eq!(tracker.success_summary(), Some("PROBE_OK"));
    assert_eq!(
        tracker.usage(),
        Some(RunUsage {
            input_tokens: 22,
            cached_input_tokens: 0,
            output_tokens: 6,
        })
    );
}

#[test]
fn gemini_answer_is_the_text_after_the_last_tool_call() {
    let mut tracker = EventTracker::new(AgentAdapter::Gemini);
    for line in [
        r#"{"type":"message","role":"assistant","content":"Let me look","delta":true}"#,
        r#"{"type":"tool_use","tool_name":"read_file","tool_id":"t1","parameters":{}}"#,
        r#"{"type":"message","role":"assistant","content":"Done, ","delta":true}"#,
        r#"{"type":"message","role":"assistant","content":"all fixed.","delta":true}"#,
        r#"{"type":"result","status":"success"}"#,
    ] {
        tracker.feed(line);
    }
    assert_eq!(tracker.success_summary(), Some("Done, all fixed."));
}

#[test]
fn gemini_fixture_error_fails_with_its_message() {
    let (tracker, _) = replay(
        AgentAdapter::Gemini,
        include_str!("fixtures/gemini-0.67.0-error.jsonl"),
    );
    assert_eq!(
        tracker.error_message(),
        Some("[API Error: exception TypeError: fetch failed sending request]")
    );
    assert!(tracker.success_summary().is_none());
}
