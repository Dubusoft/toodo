//! Smoke tests of the installed, pinned agent CLIs, kept apart from the fixture tests:
//! each runs the real CLI with the command line its adapter builds and feeds its output
//! to the adapter's tracker. They are ignored by default because they need the CLIs and
//! a fake model server; run them as `docs/runners.md` (Agent profiles) describes:
//!
//! ```sh
//! TOODO_AGENT_SMOKE_URL=http://127.0.0.1:47901 TOODO_AGENT_SMOKE_PI=/path/to/pi \
//!   cargo test --lib profile_smoke -- --ignored
//! ```
//!
//! `TOODO_AGENT_SMOKE_URL` is `scripts/agent-smoke/fake-model.mjs`, which answers as an
//! OpenAI-compatible API, the Gemini API, and an MCP server with the token
//! `probe-token`; `TOODO_AGENT_SMOKE_<AGENT>` names each CLI to run. A test whose CLI is
//! not named passes without running anything. omo runs against its signed-in account,
//! since it takes no model provider on the command line.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use super::adapter::*;
use crate::domain::model::PermissionMode;

const PROBE_TOKEN: &str = "probe-token";

struct Smoke {
    session: Option<String>,
    success: Option<String>,
    error: Option<String>,
    todos: Vec<String>,
}

/// The CLI named by `TOODO_AGENT_SMOKE_<AGENT>`, after checking it is the pinned release.
fn pinned(adapter: AgentAdapter, version: &str) -> Option<String> {
    let var = format!("TOODO_AGENT_SMOKE_{}", adapter.as_wire().to_uppercase());
    let program = std::env::var(&var).ok()?;
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(&program)
        .arg("--version")
        .envs(isolated_home(home.path()))
        .output()
        .unwrap();
    // Some of the CLIs print their version on stderr.
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        printed.contains(version),
        "{var} is {printed:?}, not the pinned {version}; install that release"
    );
    Some(program)
}

fn fake_url() -> String {
    std::env::var("TOODO_AGENT_SMOKE_URL")
        .expect("set TOODO_AGENT_SMOKE_URL to the fake model server (scripts/agent-smoke)")
}

fn run(
    adapter: AgentAdapter,
    program: &str,
    home: &Path,
    env: &[(&str, String)],
    options: &LaunchOptions,
    mcp: bool,
    prompt: &str,
) -> Smoke {
    let work = home.join("work");
    std::fs::create_dir_all(&work).unwrap();
    assert!(
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&work)
            .status()
            .unwrap()
            .success()
    );
    let run_dir = home.join("run");
    std::fs::create_dir_all(&run_dir).unwrap();
    let endpoint = McpEndpoint {
        url: format!("{}/mcp", fake_url()),
        token: PROBE_TOKEN.to_owned(),
    };
    let invocation = adapter.invocation(&run_dir, mcp.then_some(&endpoint), options, None);
    for (name, content) in &invocation.files {
        std::fs::write(run_dir.join(name), content).unwrap();
    }
    let mut command = Command::new(program);
    command
        .args(&invocation.args)
        .current_dir(&work)
        .envs(invocation.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(prompt.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let mut tracker = EventTracker::new(adapter);
    let mut splitter = LineSplitter::new();
    let mut lines = splitter.push(&output.stdout);
    lines.extend(splitter.finish());
    let todos = lines
        .iter()
        .filter_map(|line| tracker.feed(&line.text))
        .collect();
    Smoke {
        session: tracker.session_id().map(str::to_owned),
        success: tracker.success_summary().map(str::to_owned),
        error: tracker.error_message().map(str::to_owned),
        todos,
    }
}

fn isolated_home(dir: &Path) -> Vec<(&'static str, String)> {
    let path = |sub: &str| dir.join(sub).to_string_lossy().into_owned();
    vec![
        ("HOME", path("")),
        ("XDG_CONFIG_HOME", path(".config")),
        ("XDG_DATA_HOME", path(".local/share")),
        ("XDG_CACHE_HOME", path(".cache")),
        ("XDG_STATE_HOME", path(".local/state")),
    ]
}

fn write(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

const PROBE_TODO: &str = r#"{"items":[{"text":"Probe step","status":"in_progress"}]}"#;

#[test]
#[ignore = "needs the pinned pi CLI and the fake model server"]
fn pi_0_73_1_runs_read_only_with_a_model() {
    let Some(pi) = pinned(AgentAdapter::Pi, "0.73.1") else {
        return;
    };
    let home = tempfile::tempdir().unwrap();
    let provider = serde_json::json!({"providers": {"probe": {
        "baseUrl": format!("{}/v1", fake_url()), "api": "openai-completions",
        "apiKey": "probe-key", "models": [{"id": "probe-model"}]}}});
    write(
        &home.path().join(".pi/agent/models.json"),
        &provider.to_string(),
    );
    let mut env = isolated_home(home.path());
    env.push(("PI_OFFLINE", "1".to_owned()));
    let options = LaunchOptions {
        model: Some("probe/probe-model".to_owned()),
        permission_mode: Some(PermissionMode::ReadOnly),
    };
    let smoke = run(
        AgentAdapter::Pi,
        &pi,
        home.path(),
        &env,
        &options,
        false,
        "Say PROBE_OK",
    );
    assert_eq!(smoke.error, None);
    assert_eq!(smoke.success.as_deref(), Some("PROBE_OK"));
    assert!(smoke.session.is_some());
}

#[test]
#[ignore = "needs the pinned omo CLI, signed in"]
fn omo_5_1_61_runs_with_its_account() {
    let Some(omo) = pinned(AgentAdapter::Omo, "5.1.61") else {
        return;
    };
    let home = tempfile::tempdir().unwrap();
    let smoke = run(
        AgentAdapter::Omo,
        &omo,
        home.path(),
        &[],
        &LaunchOptions::default(),
        false,
        "Call the todo tool once with op init and items [\"Probe step\"], then reply with \
         exactly PROBE_OK.",
    );
    assert_eq!(smoke.error, None);
    assert_eq!(smoke.success.as_deref(), Some("PROBE_OK"));
    assert!(smoke.session.is_some());
    assert_eq!(smoke.todos.last().map(String::as_str), Some(PROBE_TODO));
}

#[test]
#[ignore = "needs the pinned OpenCode CLI and the fake model server"]
fn opencode_1_19_5_runs_with_mcp_and_mirrors_todos() {
    let Some(opencode) = pinned(AgentAdapter::OpenCode, "1.19.5") else {
        return;
    };
    let home = tempfile::tempdir().unwrap();
    let provider = serde_json::json!({"provider": {"probe": {
        "npm": "@ai-sdk/openai-compatible", "name": "probe",
        "options": {"baseURL": format!("{}/v1", fake_url()), "apiKey": "probe-key"},
        "models": {"probe-model": {"name": "probe"}}}}});
    write(
        &home.path().join(".config/opencode/opencode.json"),
        &provider.to_string(),
    );
    let mut env = isolated_home(home.path());
    env.push((MCP_TOKEN_ENV, PROBE_TOKEN.to_owned()));
    let options = LaunchOptions {
        model: Some("probe/probe-model".to_owned()),
        permission_mode: Some(PermissionMode::Bypass),
    };
    let smoke = run(
        AgentAdapter::OpenCode,
        &opencode,
        home.path(),
        &env,
        &options,
        true,
        "Say PROBE_OK",
    );
    assert_eq!(smoke.error, None);
    assert_eq!(smoke.success.as_deref(), Some("PROBE_OK"));
    assert!(smoke.session.is_some());
    assert_eq!(smoke.todos.last().map(String::as_str), Some(PROBE_TODO));
}

#[test]
#[ignore = "needs the pinned Gemini CLI and the fake model server"]
fn gemini_0_67_0_runs_headless_and_mirrors_todos() {
    let Some(gemini) = pinned(AgentAdapter::Gemini, "0.67.0") else {
        return;
    };
    let home = tempfile::tempdir().unwrap();
    write(
        &home.path().join(".gemini/settings.json"),
        r#"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#,
    );
    let mut env = isolated_home(home.path());
    env.push(("GEMINI_API_KEY", "probe-key".to_owned()));
    env.push(("GOOGLE_GEMINI_BASE_URL", fake_url()));
    // Gemini CLI offers its todo tool to Gemini 2 models only.
    let options = LaunchOptions {
        model: Some("gemini-2.5-pro".to_owned()),
        permission_mode: None,
    };
    let smoke = run(
        AgentAdapter::Gemini,
        &gemini,
        home.path(),
        &env,
        &options,
        false,
        "Say PROBE_OK",
    );
    assert_eq!(smoke.error, None);
    assert_eq!(smoke.success.as_deref(), Some("PROBE_OK"));
    assert!(smoke.session.is_some());
    assert_eq!(smoke.todos.last().map(String::as_str), Some(PROBE_TODO));
}
