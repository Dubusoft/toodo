//! The Claude print and Codex exec adapters of the plain runner: the command line,
//! environment, and files of one agent process, the stream of its stdout split into
//! lines and tracked as events, and the mapping of how the process ended to a run state
//! with its run events. Everything here is pure: no process, file, or storage access.
// The plain runner will use this module once it spawns agent processes.
#![cfg_attr(not(test), allow(dead_code))]

use std::path::Path;

use serde_json::Value;

use crate::domain::runtime::{RunState, RunUsage, UnknownWireValue};

/// The longest line, in bytes, that is parsed; a longer line is cut to this length.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// The longest result summary, in bytes, kept in the `result` event.
pub const MAX_SUMMARY_BYTES: usize = 4 * 1024;
/// The longest stderr tail, in bytes, kept in the `stderr` event.
pub const MAX_STDERR_TAIL_BYTES: usize = 4 * 1024;
/// The most todo items kept in a `todo` event; later items are dropped.
pub const MAX_TODO_ITEMS: usize = 50;
/// The longest todo item text, in bytes, kept in a `todo` event.
pub const MAX_TODO_TEXT_BYTES: usize = 500;

/// Name of the Claude MCP configuration file inside the run directory.
pub const MCP_CONFIG_FILE: &str = "mcp.json";
/// Environment variable carrying the MCP endpoint URL to the agent process.
pub const MCP_URL_ENV: &str = "TOODO_MCP_URL";
/// Environment variable carrying the MCP bearer token to the agent process.
pub const MCP_TOKEN_ENV: &str = "TOODO_MCP_TOKEN";

const CLAUDE_MCP_CONFIG: &str = r#"{"mcpServers":{"toodo":{"type":"http","url":"${TOODO_MCP_URL}","headers":{"Authorization":"Bearer ${TOODO_MCP_TOKEN}"}}}}"#;

/// Which agent CLI a plain run drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentAdapter {
    Claude,
    Codex,
}

impl AgentAdapter {
    pub const ALL: [AgentAdapter; 2] = [AgentAdapter::Claude, AgentAdapter::Codex];

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn parse(value: &str) -> Result<Self, UnknownWireValue> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            other => Err(UnknownWireValue {
                kind: "agent adapter",
                value: other.to_owned(),
            }),
        }
    }

    /// The command line, environment, and files for one run in `run_dir`. The prompt is
    /// fed on stdin, and the bearer token only ever appears in the environment.
    pub fn invocation(&self, run_dir: &Path, mcp: Option<&McpEndpoint>) -> Invocation {
        let mut args: Vec<String> = Vec::new();
        let mut env = Vec::new();
        let mut files = Vec::new();
        match self {
            Self::Claude => {
                args.extend(
                    [
                        "-p",
                        "--output-format",
                        "stream-json",
                        "--verbose",
                        "--permission-mode",
                        "bypassPermissions",
                    ]
                    .map(str::to_owned),
                );
                if mcp.is_some() {
                    args.push("--mcp-config".to_owned());
                    args.push(run_dir.join(MCP_CONFIG_FILE).to_string_lossy().into_owned());
                    args.push("--strict-mcp-config".to_owned());
                    files.push((MCP_CONFIG_FILE.to_owned(), CLAUDE_MCP_CONFIG.to_owned()));
                }
            }
            Self::Codex => {
                args.extend(["exec", "--json", "--full-auto"].map(str::to_owned));
                if let Some(mcp) = mcp {
                    args.push("-c".to_owned());
                    args.push(format!("mcp_servers.toodo.url=\"{}\"", mcp.url));
                    args.push("-c".to_owned());
                    args.push(format!(
                        "mcp_servers.toodo.bearer_token_env_var=\"{MCP_TOKEN_ENV}\""
                    ));
                }
                args.push("-".to_owned());
            }
        }
        if let Some(mcp) = mcp {
            env.push((MCP_URL_ENV.to_owned(), mcp.url.clone()));
            env.push((MCP_TOKEN_ENV.to_owned(), mcp.token.clone()));
        }
        Invocation {
            program_key: self.as_wire(),
            args,
            env,
            files,
        }
    }
}

/// The server's MCP endpoint handed to an agent process.
#[derive(Clone, PartialEq, Eq)]
pub struct McpEndpoint {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for McpEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpEndpoint")
            .field("url", &self.url)
            .field("token", &"[redacted]")
            .finish()
    }
}

/// What to spawn for one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    /// Names the program to look up for the adapter: `claude` or `codex`.
    pub program_key: &'static str,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Files to create in the run directory: file name and content.
    pub files: Vec<(String, String)>,
}

/// One line of process output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    /// The line was longer than [`MAX_LINE_BYTES`]: `text` is its start, and it must be
    /// logged but not parsed.
    pub truncated: bool,
}

/// Splits arbitrary byte chunks into lines. Splitting works on bytes, so a multi-byte
/// character cut by a chunk boundary is decoded whole once its line is complete.
#[derive(Debug, Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
    overflowed: bool,
}

impl LineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk and returns the lines it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Line> {
        let mut lines = Vec::new();
        let mut rest = chunk;
        while let Some(at) = rest.iter().position(|&b| b == b'\n') {
            self.append(&rest[..at]);
            lines.push(self.take());
            rest = &rest[at + 1..];
        }
        self.append(rest);
        lines
    }

    /// Returns the final line when the stream ended without a trailing newline.
    pub fn finish(&mut self) -> Option<Line> {
        if self.buf.is_empty() && !self.overflowed {
            return None;
        }
        Some(self.take())
    }

    fn append(&mut self, bytes: &[u8]) {
        let room = MAX_LINE_BYTES - self.buf.len();
        if bytes.len() > room {
            self.overflowed = true;
        }
        self.buf.extend_from_slice(&bytes[..bytes.len().min(room)]);
    }

    fn take(&mut self) -> Line {
        let mut bytes = std::mem::take(&mut self.buf);
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        Line {
            text: String::from_utf8_lossy(&bytes).into_owned(),
            truncated: std::mem::take(&mut self.overflowed),
        }
    }
}

/// The status of one step in an agent's todo list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

impl TodoStatus {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
        }
    }

    /// Parses a Claude todo status; an unknown status is `pending`.
    fn parse_lossy(value: &str) -> Self {
        match value {
            "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            _ => Self::Pending,
        }
    }
}

/// One step in an agent's todo list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

/// The payload of a `todo` run event: `{"items":[{"text":..,"status":..},..]}`.
pub fn todo_payload(items: &[TodoItem]) -> String {
    let items: Vec<String> = items
        .iter()
        .map(|item| {
            format!(
                r#"{{"text":{},"status":"{}"}}"#,
                Value::String(item.text.clone()),
                item.status.as_wire()
            )
        })
        .collect();
    format!(r#"{{"items":[{}]}}"#, items.join(","))
}

/// Follows the JSON event lines of one agent process.
#[derive(Debug)]
pub struct EventTracker {
    adapter: AgentAdapter,
    session_id: Option<String>,
    success: Option<String>,
    error: Option<String>,
    last_message: Option<String>,
    /// The last todo list reported by [`EventTracker::feed`].
    todos: Option<Vec<TodoItem>>,
    usage: Option<RunUsage>,
}

impl EventTracker {
    pub fn new(adapter: AgentAdapter) -> Self {
        Self {
            adapter,
            session_id: None,
            success: None,
            error: None,
            last_message: None,
            todos: None,
            usage: None,
        }
    }

    /// The tokens the agent reported using so far: those of Claude's result, or the sum
    /// over Codex's completed turns.
    pub fn usage(&self) -> Option<RunUsage> {
        self.usage
    }

    /// The Claude session id or the Codex thread id, once seen.
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// The summary of a successful result (at most [`MAX_SUMMARY_BYTES`]).
    pub fn success_summary(&self) -> Option<&str> {
        self.success.as_deref()
    }

    /// The message of the first error result.
    pub fn error_message(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// Feeds one complete line. Lines that are not JSON objects, and events of an
    /// unknown type, are ignored. Returns the `todo` event payload (see
    /// [`todo_payload`]) when the line changed the agent's todo list.
    pub fn feed(&mut self, line: &str) -> Option<String> {
        let Ok(Value::Object(event)) = serde_json::from_str::<Value>(line) else {
            return None;
        };
        let value = Value::Object(event);
        let todos = match self.adapter {
            AgentAdapter::Claude => self.feed_claude(&value),
            AgentAdapter::Codex => self.feed_codex(&value),
        }?;
        if self.todos.as_ref() == Some(&todos) {
            return None;
        }
        let payload = todo_payload(&todos);
        self.todos = Some(todos);
        Some(payload)
    }

    /// Returns the todo list of the last `TodoWrite` call in an assistant message.
    fn feed_claude(&mut self, event: &Value) -> Option<Vec<TodoItem>> {
        match str_field(event, "type") {
            Some("assistant") => {
                let content = event.get("message")?.get("content")?.as_array()?;
                return content
                    .iter()
                    .filter(|block| {
                        str_field(block, "type") == Some("tool_use")
                            && str_field(block, "name") == Some("TodoWrite")
                    })
                    .filter_map(|block| block.get("input")?.get("todos")?.as_array())
                    .next_back()
                    .map(|todos| {
                        todo_items(todos, |todo| TodoItem {
                            text: str_field(todo, "content").unwrap_or("").to_owned(),
                            status: TodoStatus::parse_lossy(
                                str_field(todo, "status").unwrap_or(""),
                            ),
                        })
                    });
            }
            Some("system") => {
                if self.session_id.is_none() {
                    self.session_id = str_field(event, "session_id").map(str::to_owned);
                }
            }
            Some("result") => {
                if let Some(id) = str_field(event, "session_id") {
                    self.session_id = Some(id.to_owned());
                }
                if let Some(usage) = event.get("usage") {
                    let cached = token_count(usage, "cache_read_input_tokens");
                    self.usage = Some(RunUsage {
                        input_tokens: token_count(usage, "input_tokens")
                            + token_count(usage, "cache_creation_input_tokens")
                            + cached,
                        cached_input_tokens: cached,
                        output_tokens: token_count(usage, "output_tokens"),
                    });
                }
                let text = str_field(event, "result").unwrap_or("");
                let is_error = event.get("is_error").and_then(Value::as_bool) == Some(true)
                    || str_field(event, "subtype").is_some_and(|s| s != "success");
                if is_error {
                    let message = if text.is_empty() {
                        str_field(event, "subtype").unwrap_or("error")
                    } else {
                        text
                    };
                    self.set_error(message);
                } else {
                    self.success = Some(truncate(text, MAX_SUMMARY_BYTES));
                }
            }
            _ => {}
        }
        None
    }

    /// Returns the todo list of a `todo_list` item.
    fn feed_codex(&mut self, event: &Value) -> Option<Vec<TodoItem>> {
        let kind = str_field(event, "type");
        if matches!(
            kind,
            Some("item.started" | "item.updated" | "item.completed")
        ) && let Some(item) = event.get("item")
            && str_field(item, "type") == Some("todo_list")
        {
            let items = item.get("items")?.as_array()?;
            return Some(todo_items(items, |todo| TodoItem {
                text: str_field(todo, "text").unwrap_or("").to_owned(),
                status: if todo.get("completed").and_then(Value::as_bool) == Some(true) {
                    TodoStatus::Completed
                } else {
                    TodoStatus::Pending
                },
            }));
        }
        match kind {
            Some("thread.started") => {
                if let Some(id) = str_field(event, "thread_id") {
                    self.session_id = Some(id.to_owned());
                }
            }
            Some("item.completed") => {
                if let Some(item) = event.get("item")
                    && str_field(item, "type") == Some("agent_message")
                    && let Some(text) = str_field(item, "text")
                {
                    self.last_message = Some(truncate(text, MAX_SUMMARY_BYTES));
                }
            }
            Some("turn.completed") => {
                self.success = Some(self.last_message.clone().unwrap_or_default());
                if let Some(usage) = event.get("usage") {
                    let total = self.usage.get_or_insert_default();
                    total.input_tokens += token_count(usage, "input_tokens");
                    total.cached_input_tokens += token_count(usage, "cached_input_tokens");
                    total.output_tokens += token_count(usage, "output_tokens");
                }
            }
            Some("turn.failed") => {
                let message = event
                    .get("error")
                    .and_then(|e| str_field(e, "message"))
                    .unwrap_or("turn failed");
                self.set_error(message);
            }
            Some("error") => {
                self.set_error(str_field(event, "message").unwrap_or("error"));
            }
            _ => {}
        }
        None
    }

    fn set_error(&mut self, message: &str) {
        if self.error.is_none() {
            self.error = Some(truncate(message, MAX_SUMMARY_BYTES));
        }
    }
}

/// Maps the object entries of an agent's todo list, keeping at most
/// [`MAX_TODO_ITEMS`] and cutting each text to [`MAX_TODO_TEXT_BYTES`].
fn todo_items(todos: &[Value], item: impl Fn(&Value) -> TodoItem) -> Vec<TodoItem> {
    todos
        .iter()
        .filter(|todo| todo.is_object())
        .take(MAX_TODO_ITEMS)
        .map(|todo| {
            let mut item = item(todo);
            item.text = truncate(&item.text, MAX_TODO_TEXT_BYTES);
            item
        })
        .collect()
}

/// A token count of a usage object; a missing or malformed one counts as 0.
fn token_count(usage: &Value, key: &str) -> i64 {
    usage.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// The first `max` bytes of `text`, cut at a character boundary.
fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// The last `max` bytes of `text`, cut at a character boundary.
fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// How an agent process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitKind {
    Code(i32),
    Signal(i32),
    TimedOut,
    Stopped,
}

/// The run state a process ended in and the run events to record, in order, as event
/// kind and payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub state: RunState,
    pub events: Vec<(&'static str, String)>,
}

/// Maps how the process ended, and what its events said, to the run's final state.
/// `stderr_tail` should already be redacted; only its last [`MAX_STDERR_TAIL_BYTES`]
/// are kept.
pub fn classify(tracker: &EventTracker, exit: ExitKind, stderr_tail: &str) -> Outcome {
    let outcome = |state, events| Outcome { state, events };
    let exit_text = match exit {
        ExitKind::Code(code) => format!("exit code {code}"),
        ExitKind::Signal(signal) => format!("signal {signal}"),
        ExitKind::TimedOut | ExitKind::Stopped => String::new(),
    };
    match exit {
        ExitKind::TimedOut => {
            return outcome(
                RunState::Failed,
                vec![(
                    "timed_out",
                    "the run exceeded its timeout; start a new run with a larger timeout_secs"
                        .to_owned(),
                )],
            );
        }
        ExitKind::Stopped => {
            return outcome(
                RunState::Cancelled,
                vec![("stop_requested", "the run was stopped".to_owned())],
            );
        }
        ExitKind::Code(_) | ExitKind::Signal(_) => {}
    }
    let clean = exit == ExitKind::Code(0);
    if let Some(message) = tracker.error_message() {
        return outcome(RunState::Failed, vec![("result_error", message.to_owned())]);
    }
    if let Some(summary) = tracker.success_summary() {
        return if clean {
            outcome(RunState::Settled, vec![("result", summary.to_owned())])
        } else {
            outcome(RunState::Exited, vec![("exit_after_result", exit_text)])
        };
    }
    if clean {
        return outcome(
            RunState::Failed,
            vec![(
                "no_result",
                "the agent exited without a result; read the run log and start a new run"
                    .to_owned(),
            )],
        );
    }
    outcome(
        RunState::Failed,
        vec![
            (
                "stderr",
                tail(stderr_tail, MAX_STDERR_TAIL_BYTES).to_owned(),
            ),
            ("exit", exit_text),
        ],
    )
}

/// Replaces every occurrence of `secret` in `text` with `[redacted]`.
pub fn redact(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        return text.to_owned();
    }
    text.replace(secret, "[redacted]")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "s3cr3t-token-value";

    fn endpoint() -> McpEndpoint {
        McpEndpoint {
            url: "http://127.0.0.1:47616/mcp".to_owned(),
            token: TOKEN.to_owned(),
        }
    }

    fn lines(splitter: &mut LineSplitter, chunks: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(splitter.push(chunk).into_iter().map(|l| l.text));
        }
        out
    }

    fn tracked(adapter: AgentAdapter, input: &[&str]) -> EventTracker {
        let mut tracker = EventTracker::new(adapter);
        for line in input {
            tracker.feed(line);
        }
        tracker
    }

    #[test]
    fn adapter_wire_names_round_trip() {
        for adapter in AgentAdapter::ALL {
            assert_eq!(AgentAdapter::parse(adapter.as_wire()), Ok(adapter));
        }
        assert!(AgentAdapter::parse("gemini").is_err());
    }

    #[test]
    fn argv_and_files_never_contain_the_token() {
        let dir = Path::new("/data/runs/7");
        for adapter in AgentAdapter::ALL {
            for mcp in [None, Some(endpoint())] {
                let inv = adapter.invocation(dir, mcp.as_ref());
                assert!(inv.args.iter().all(|a| !a.contains(TOKEN)), "{adapter:?}");
                assert!(inv.files.iter().all(|(_, c)| !c.contains(TOKEN)));
                assert_eq!(inv.env.is_empty(), mcp.is_none());
                if mcp.is_some() {
                    assert!(
                        inv.env
                            .contains(&(MCP_TOKEN_ENV.to_owned(), TOKEN.to_owned()))
                    );
                    assert!(inv.env.iter().any(|(k, _)| k == MCP_URL_ENV));
                }
            }
        }
    }

    #[test]
    fn claude_invocation_with_and_without_mcp() {
        let dir = Path::new("/data/runs/7");
        let plain = AgentAdapter::Claude.invocation(dir, None);
        assert_eq!(plain.program_key, "claude");
        assert_eq!(
            plain.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "bypassPermissions"
            ]
        );
        assert!(plain.files.is_empty());

        let with = AgentAdapter::Claude.invocation(dir, Some(&endpoint()));
        assert_eq!(
            with.args[6..],
            [
                "--mcp-config",
                "/data/runs/7/mcp.json",
                "--strict-mcp-config"
            ]
        );
        let (name, content) = &with.files[0];
        assert_eq!(name, "mcp.json");
        assert!(content.contains("${TOODO_MCP_URL}"));
        assert!(content.contains("Bearer ${TOODO_MCP_TOKEN}"));
        assert!(serde_json::from_str::<Value>(content).is_ok());
    }

    #[test]
    fn codex_invocation_with_and_without_mcp() {
        let dir = Path::new("/data/runs/7");
        let plain = AgentAdapter::Codex.invocation(dir, None);
        assert_eq!(plain.program_key, "codex");
        assert_eq!(plain.args, ["exec", "--json", "--full-auto", "-"]);
        assert!(plain.files.is_empty());

        let with = AgentAdapter::Codex.invocation(dir, Some(&endpoint()));
        assert_eq!(
            with.args,
            [
                "exec",
                "--json",
                "--full-auto",
                "-c",
                "mcp_servers.toodo.url=\"http://127.0.0.1:47616/mcp\"",
                "-c",
                "mcp_servers.toodo.bearer_token_env_var=\"TOODO_MCP_TOKEN\"",
                "-"
            ]
        );
        assert!(with.files.is_empty());
    }

    #[test]
    fn splitter_joins_json_across_chunks() {
        let mut s = LineSplitter::new();
        let got = lines(&mut s, &[b"{\"type\":\"sys", b"tem\"}\n{\"a\"", b":1}\n"]);
        assert_eq!(got, ["{\"type\":\"system\"}", "{\"a\":1}"]);
        assert!(s.finish().is_none());
    }

    #[test]
    fn splitter_handles_split_multibyte_character() {
        let text = "{\"t\":\"h\u{e9}llo \u{1f600}\"}\n";
        let bytes = text.as_bytes();
        let cut = text.find('\u{1f600}').unwrap() + 2;
        let mut s = LineSplitter::new();
        let got = lines(&mut s, &[&bytes[..cut], &bytes[cut..]]);
        assert_eq!(got, ["{\"t\":\"h\u{e9}llo \u{1f600}\"}"]);
    }

    #[test]
    fn splitter_yields_final_line_without_newline() {
        let mut s = LineSplitter::new();
        assert!(s.push(b"one\ntwo").len() == 1);
        let last = s.finish().unwrap();
        assert_eq!(last.text, "two");
        assert!(!last.truncated);
        assert!(s.finish().is_none());
    }

    #[test]
    fn splitter_strips_carriage_return() {
        let mut s = LineSplitter::new();
        assert_eq!(lines(&mut s, &[b"a\r\n"]), ["a"]);
    }

    #[test]
    fn splitter_truncates_long_lines_and_recovers() {
        let mut s = LineSplitter::new();
        let long = vec![b'x'; MAX_LINE_BYTES + 10];
        assert!(s.push(&long).is_empty());
        let got = s.push(b"yyy\nnext\n");
        assert_eq!(got.len(), 2);
        assert!(got[0].truncated);
        assert_eq!(got[0].text.len(), MAX_LINE_BYTES);
        assert_eq!(
            got[1],
            Line {
                text: "next".to_owned(),
                truncated: false
            }
        );
    }

    #[test]
    fn splitter_truncated_final_line() {
        let mut s = LineSplitter::new();
        s.push(&vec![b'x'; MAX_LINE_BYTES + 1]);
        assert!(s.finish().unwrap().truncated);
    }

    #[test]
    fn tracker_ignores_non_json_and_unknown_lines() {
        let t = tracked(
            AgentAdapter::Claude,
            &[
                "warning: hello",
                "",
                "[1,2]",
                "{\"type\":\"mystery\"}",
                "{bad",
            ],
        );
        assert!(t.session_id().is_none());
        assert!(t.success_summary().is_none());
        assert!(t.error_message().is_none());
    }

    #[test]
    fn claude_tracker_records_session_and_success() {
        let t = tracked(
            AgentAdapter::Claude,
            &[
                r#"{"type":"system","subtype":"init","session_id":"sess-1"}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-1"}"#,
            ],
        );
        assert_eq!(t.session_id(), Some("sess-1"));
        assert_eq!(t.success_summary(), Some("done"));
        assert!(t.error_message().is_none());
    }

    #[test]
    fn claude_tracker_records_error_result() {
        let t = tracked(
            AgentAdapter::Claude,
            &[
                r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","session_id":"s"}"#,
            ],
        );
        assert_eq!(t.error_message(), Some("error_max_turns"));
        assert!(t.success_summary().is_none());
    }

    #[test]
    fn summary_is_capped_at_a_character_boundary() {
        let long = "\u{e9}".repeat(MAX_SUMMARY_BYTES);
        let line = format!(r#"{{"type":"result","subtype":"success","result":"{long}"}}"#);
        let t = tracked(AgentAdapter::Claude, &[&line]);
        assert_eq!(t.success_summary().unwrap().len(), MAX_SUMMARY_BYTES);
    }

    #[test]
    fn codex_tracker_records_thread_and_success() {
        let t = tracked(
            AgentAdapter::Codex,
            &[
                r#"{"type":"thread.started","thread_id":"th-1"}"#,
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"first"}}"#,
                r#"{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}"#,
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"final"}}"#,
                r#"{"type":"turn.completed","usage":{}}"#,
            ],
        );
        assert_eq!(t.session_id(), Some("th-1"));
        assert_eq!(t.success_summary(), Some("final"));
    }

    #[test]
    fn claude_result_usage_counts_cache_reads_and_writes_as_input() {
        let t = tracked(
            AgentAdapter::Claude,
            &[
                r#"{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":40}}"#,
            ],
        );
        assert_eq!(
            t.usage(),
            Some(RunUsage {
                input_tokens: 3210,
                cached_input_tokens: 3000,
                output_tokens: 40,
            })
        );
        assert_eq!(
            tracked(AgentAdapter::Claude, &[r#"{"type":"result"}"#]).usage(),
            None
        );
    }

    #[test]
    fn codex_usage_sums_completed_turns() {
        let t = tracked(
            AgentAdapter::Codex,
            &[
                r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":7}}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":"many","output_tokens":3}}"#,
            ],
        );
        assert_eq!(
            t.usage(),
            Some(RunUsage {
                input_tokens: 150,
                cached_input_tokens: 60,
                output_tokens: 10,
            })
        );
    }

    #[test]
    fn codex_tracker_records_turn_failed_and_error() {
        let failed = tracked(
            AgentAdapter::Codex,
            &[r#"{"type":"turn.failed","error":{"message":"boom"}}"#],
        );
        assert_eq!(failed.error_message(), Some("boom"));

        let error = tracked(
            AgentAdapter::Codex,
            &[
                r#"{"type":"error","message":"first"}"#,
                r#"{"type":"turn.failed","error":{"message":"second"}}"#,
            ],
        );
        assert_eq!(error.error_message(), Some("first"));
    }

    fn claude_todos(todos: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"plan"}},{{"type":"tool_use","name":"TodoWrite","input":{{"todos":{todos}}}}}]}}}}"#
        )
    }

    fn codex_todos(kind: &str, items: &str) -> String {
        format!(
            r#"{{"type":"{kind}","item":{{"id":"item_1","type":"todo_list","items":{items}}}}}"#
        )
    }

    #[test]
    fn claude_todo_write_reports_the_list() {
        let mut t = EventTracker::new(AgentAdapter::Claude);
        let line = claude_todos(
            r#"[{"content":"Read code","status":"completed","activeForm":"Reading"},{"content":"Write \"tests\"","status":"in_progress","activeForm":"Writing"},{"content":"Ship","status":"pending","activeForm":"Shipping"}]"#,
        );
        assert_eq!(
            t.feed(&line).as_deref(),
            Some(
                r#"{"items":[{"text":"Read code","status":"completed"},{"text":"Write \"tests\"","status":"in_progress"},{"text":"Ship","status":"pending"}]}"#
            )
        );
        assert_eq!(
            t.feed(&claude_todos("[]")).as_deref(),
            Some(r#"{"items":[]}"#)
        );
    }

    #[test]
    fn codex_todo_list_items_report_the_list() {
        let mut t = EventTracker::new(AgentAdapter::Codex);
        let started = codex_todos(
            "item.started",
            r#"[{"text":"Plan","completed":false},{"text":"Build","completed":false}]"#,
        );
        assert_eq!(
            t.feed(&started).as_deref(),
            Some(
                r#"{"items":[{"text":"Plan","status":"pending"},{"text":"Build","status":"pending"}]}"#
            )
        );
        let updated = codex_todos(
            "item.updated",
            r#"[{"text":"Plan","completed":true},{"text":"Build","completed":false}]"#,
        );
        assert_eq!(
            t.feed(&updated).as_deref(),
            Some(
                r#"{"items":[{"text":"Plan","status":"completed"},{"text":"Build","status":"pending"}]}"#
            )
        );
        let completed = codex_todos(
            "item.completed",
            r#"[{"text":"Plan","completed":true},{"text":"Build","completed":true}]"#,
        );
        assert_eq!(
            t.feed(&completed).as_deref(),
            Some(
                r#"{"items":[{"text":"Plan","status":"completed"},{"text":"Build","status":"completed"}]}"#
            )
        );
    }

    #[test]
    fn unchanged_todo_list_reports_nothing() {
        let mut claude = EventTracker::new(AgentAdapter::Claude);
        let line = claude_todos(r#"[{"content":"A","status":"pending"}]"#);
        assert!(claude.feed(&line).is_some());
        assert!(claude.feed(&line).is_none());
        // Only the normalized list counts: a changed activeForm is no change.
        let reworded = claude_todos(r#"[{"content":"A","status":"pending","activeForm":"x"}]"#);
        assert!(claude.feed(&reworded).is_none());

        let mut codex = EventTracker::new(AgentAdapter::Codex);
        let items = r#"[{"text":"A","completed":false}]"#;
        assert!(codex.feed(&codex_todos("item.started", items)).is_some());
        assert!(codex.feed(&codex_todos("item.updated", items)).is_none());
        assert!(codex.feed(&codex_todos("item.completed", items)).is_none());
    }

    #[test]
    fn unknown_claude_todo_status_is_pending() {
        let mut t = EventTracker::new(AgentAdapter::Claude);
        let line = claude_todos(r#"[{"content":"A","status":"blocked"},{"content":"B"}]"#);
        assert_eq!(
            t.feed(&line).as_deref(),
            Some(r#"{"items":[{"text":"A","status":"pending"},{"text":"B","status":"pending"}]}"#)
        );
    }

    #[test]
    fn todo_items_and_texts_are_capped() {
        let long = "\u{e9}".repeat(MAX_TODO_TEXT_BYTES);
        let todos: Vec<String> = (0..MAX_TODO_ITEMS + 5)
            .map(|i| format!(r#"{{"content":"{long}{i}","status":"pending"}}"#))
            .collect();
        let line = claude_todos(&format!("[{}]", todos.join(",")));
        let mut t = EventTracker::new(AgentAdapter::Claude);
        let payload: Value = serde_json::from_str(&t.feed(&line).unwrap()).unwrap();
        let items = payload["items"].as_array().unwrap();
        assert_eq!(items.len(), MAX_TODO_ITEMS);
        for item in items {
            assert_eq!(item["text"].as_str().unwrap().len(), MAX_TODO_TEXT_BYTES);
        }
    }

    #[test]
    fn other_tool_uses_and_items_are_not_todos() {
        let mut claude = EventTracker::new(AgentAdapter::Claude);
        let bash = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"todos":[]}}]}}"#;
        assert!(claude.feed(bash).is_none());
        let text = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        assert!(claude.feed(text).is_none());

        let mut codex = EventTracker::new(AgentAdapter::Codex);
        let message = r#"{"type":"item.completed","item":{"type":"agent_message","text":"done"}}"#;
        assert!(codex.feed(message).is_none());
        assert!(codex.feed(r#"{"type":"turn.completed"}"#).is_none());
        assert_eq!(codex.success_summary(), Some("done"));
    }

    fn ok(adapter: AgentAdapter) -> EventTracker {
        match adapter {
            AgentAdapter::Claude => tracked(
                adapter,
                &[r#"{"type":"result","subtype":"success","is_error":false,"result":"all good"}"#],
            ),
            AgentAdapter::Codex => tracked(
                adapter,
                &[
                    r#"{"type":"item.completed","item":{"type":"agent_message","text":"all good"}}"#,
                    r#"{"type":"turn.completed"}"#,
                ],
            ),
        }
    }

    #[test]
    fn outcome_success_then_exit_zero_settles() {
        for adapter in AgentAdapter::ALL {
            let o = classify(&ok(adapter), ExitKind::Code(0), "");
            assert_eq!(o.state, RunState::Settled);
            assert_eq!(o.events, [("result", "all good".to_owned())]);
        }
    }

    #[test]
    fn outcome_error_result_fails() {
        let t = tracked(
            AgentAdapter::Codex,
            &[r#"{"type":"turn.failed","error":{"message":"boom"}}"#],
        );
        for exit in [ExitKind::Code(0), ExitKind::Code(1), ExitKind::Signal(9)] {
            let o = classify(&t, exit, "noise");
            assert_eq!(o.state, RunState::Failed);
            assert_eq!(o.events, [("result_error", "boom".to_owned())]);
        }
    }

    #[test]
    fn outcome_no_result_exit_zero_fails() {
        let t = EventTracker::new(AgentAdapter::Claude);
        let o = classify(&t, ExitKind::Code(0), "");
        assert_eq!(o.state, RunState::Failed);
        assert_eq!(o.events.len(), 1);
        assert_eq!(o.events[0].0, "no_result");
    }

    #[test]
    fn outcome_no_result_nonzero_exit_reports_stderr_then_exit() {
        let t = EventTracker::new(AgentAdapter::Codex);
        let o = classify(&t, ExitKind::Code(2), "bad flag");
        assert_eq!(o.state, RunState::Failed);
        assert_eq!(
            o.events,
            [
                ("stderr", "bad flag".to_owned()),
                ("exit", "exit code 2".to_owned())
            ]
        );
        let signaled = classify(&t, ExitKind::Signal(11), "");
        assert_eq!(signaled.events[1], ("exit", "signal 11".to_owned()));
    }

    #[test]
    fn outcome_stderr_keeps_only_the_last_4_kib() {
        let t = EventTracker::new(AgentAdapter::Claude);
        let stderr = format!("{}{}", "a".repeat(10_000), "END");
        let o = classify(&t, ExitKind::Code(1), &stderr);
        assert_eq!(o.events[0].1.len(), MAX_STDERR_TAIL_BYTES);
        assert!(o.events[0].1.ends_with("END"));
    }

    #[test]
    fn outcome_success_then_bad_exit_is_exited() {
        let t = ok(AgentAdapter::Claude);
        let code = classify(&t, ExitKind::Code(3), "");
        assert_eq!(code.state, RunState::Exited);
        assert_eq!(
            code.events,
            [("exit_after_result", "exit code 3".to_owned())]
        );
        let signal = classify(&t, ExitKind::Signal(15), "");
        assert_eq!(signal.state, RunState::Exited);
        assert_eq!(signal.events[0].0, "exit_after_result");
    }

    #[test]
    fn outcome_timeout_and_stop_override_events() {
        let t = ok(AgentAdapter::Claude);
        let timed_out = classify(&t, ExitKind::TimedOut, "");
        assert_eq!(timed_out.state, RunState::Failed);
        assert_eq!(timed_out.events.len(), 1);
        assert_eq!(timed_out.events[0].0, "timed_out");
        let stopped = classify(&t, ExitKind::Stopped, "");
        assert_eq!(stopped.state, RunState::Cancelled);
        assert_eq!(stopped.events.len(), 1);
        assert_eq!(stopped.events[0].0, "stop_requested");
    }

    #[test]
    fn redact_replaces_every_occurrence() {
        assert_eq!(
            redact(&format!("a {TOKEN} b {TOKEN}"), TOKEN),
            "a [redacted] b [redacted]"
        );
        assert_eq!(redact("nothing", TOKEN), "nothing");
        assert_eq!(redact("keep", ""), "keep");
    }

    #[test]
    fn endpoint_debug_hides_the_token() {
        assert!(!format!("{:?}", endpoint()).contains(TOKEN));
    }
}
