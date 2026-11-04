//! Registering the server's MCP endpoint with the coding agents on `PATH`: Claude Code
//! through `claude mcp add-json`, Codex in its `config.toml`.
//!
//! The token never goes on a command line, where other users could read it in the process
//! list: Claude Code gets a `headersHelper` that reads the token file each time it
//! connects, and Codex gets the token in its config file, readable by the owner only.

use std::fs;
use std::io;
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::Var;
use super::process;
use super::settings::{self, DataDir};

const SERVER_NAME: &str = "toodo";
const CODEX_TABLE: &str = "[mcp_servers.toodo]";

/// What happened for one agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Outcome {
    /// Registered, in this place.
    Registered(String),
    /// Not on `PATH`.
    Skipped,
    /// Failed, with the reason and the next step.
    Failed(String),
}

/// Registers `url` with Claude Code and Codex, each when it is on `PATH`.
pub(super) fn register(
    url: &str,
    token: &str,
    token_file: &Path,
    var: Var,
) -> Vec<(&'static str, Outcome)> {
    let claude = match process::find_on_path("claude", var) {
        Some(_) => claude(url, token_file),
        None => Outcome::Skipped,
    };
    let codex = match process::find_on_path("codex", var) {
        Some(_) => match codex_config(var) {
            Ok(path) => codex(&path, url, token),
            Err(error) => Outcome::Failed(error),
        },
        None => Outcome::Skipped,
    };
    vec![("claude", claude), ("codex", codex)]
}

/// Registers `url` again with the agents that have a registration of the server already,
/// so they follow a new port or a replaced token, and prints what happened. Agents without
/// one are left alone, as `toodo init --no-mcp` left them.
pub(super) fn refresh(data: &DataDir, listen: SocketAddr, var: Var) {
    let token_file = data.mcp_token();
    let token = match fs::read_to_string(&token_file) {
        Ok(token) if !token.trim().is_empty() => token.trim().to_owned(),
        Ok(_) => {
            println!(
                "MCP: {} is empty, so no agent was registered again; register them with: \
                 toodo init",
                token_file.display()
            );
            return;
        }
        Err(error) => {
            println!(
                "MCP: cannot read {}: {error}, so no agent was registered again; register \
                 them with: toodo init",
                token_file.display()
            );
            return;
        }
    };
    let url = settings::mcp_url(listen);
    let claude = if process::find_on_path("claude", var).is_some()
        && process::succeeds("claude", &["mcp", "get", SERVER_NAME])
    {
        claude(&url, &token_file)
    } else {
        Outcome::Skipped
    };
    let codex = match codex_config(var) {
        Ok(path) => codex_refresh(&path, &url, &token),
        Err(error) => Outcome::Failed(error),
    };
    for (agent, outcome) in [("claude", claude), ("codex", codex)] {
        match outcome {
            Outcome::Registered(place) => {
                println!("MCP for {agent}: registered {url} again ({place})");
            }
            Outcome::Skipped => {}
            Outcome::Failed(error) => println!("MCP for {agent}: failed: {error}"),
        }
    }
}

/// Removes the registration of `url` from Claude Code and Codex, and prints what
/// happened; a registration of another URL, e.g. of another server, is left alone.
pub(super) fn unregister(url: &str, var: Var) {
    if process::find_on_path("claude", var).is_some()
        && process::output("claude", &["mcp", "get", SERVER_NAME]).is_ok_and(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains(url)
        })
    {
        match process::run(
            "claude",
            &["mcp", "remove", "--scope", "user", SERVER_NAME],
            &format!("remove it yourself with: claude mcp remove --scope user {SERVER_NAME}"),
        ) {
            Ok(_) => println!("MCP for claude: removed {url}"),
            Err(error) => println!("MCP for claude: failed: {error}"),
        }
    }
    let path = match codex_config(var) {
        Ok(path) => path,
        Err(error) => {
            println!("MCP for codex: failed: {error}");
            return;
        }
    };
    let Ok(existing) = fs::read_to_string(&path) else {
        return;
    };
    let (rest, table) = remove_table(&existing, CODEX_TABLE);
    if !table.is_some_and(|table| table.contains(&format!("url = \"{url}\""))) {
        return;
    }
    match write_private(&path, &rest) {
        Ok(()) => println!("MCP for codex: removed {url} from {}", path.display()),
        Err(error) => println!(
            "MCP for codex: cannot update {}: {error}; delete its {CODEX_TABLE} table yourself",
            path.display()
        ),
    }
}

fn claude(url: &str, token_file: &Path) -> Outcome {
    // A registration from an earlier init may have another port or header.
    drop(process::output(
        "claude",
        &["mcp", "remove", "--scope", "user", SERVER_NAME],
    ));
    let entry = claude_entry(url, token_file);
    let args = ["mcp", "add-json", "--scope", "user", SERVER_NAME, &entry];
    let next_step = format!(
        "register it yourself with: claude mcp add-json --scope user {SERVER_NAME} {}",
        shell_quote(&entry)
    );
    match process::run("claude", &args, &next_step) {
        Ok(_) => Outcome::Registered("user scope of Claude Code".to_owned()),
        Err(error) => Outcome::Failed(error),
    }
}

/// The Claude Code server entry for `url`: its `headersHelper` prints the `Authorization`
/// header with the token read from `token_file` whenever Claude Code connects.
pub(super) fn claude_entry(url: &str, token_file: &Path) -> String {
    let helper = format!(
        "printf '{{\"Authorization\":\"Bearer %s\"}}' \"$(cat {})\"",
        shell_quote(&token_file.display().to_string())
    );
    serde_json::json!({ "type": "http", "url": url, "headersHelper": helper }).to_string()
}

/// `text` as one POSIX shell word.
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`.
pub(super) fn codex_config(var: Var) -> Result<PathBuf, String> {
    let home = match var("CODEX_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => super::settings::home(var)?.join(".codex"),
    };
    Ok(home.join("config.toml"))
}

fn codex(path: &Path, url: &str, token: &str) -> Outcome {
    let failed = |error: io::Error| {
        Outcome::Failed(format!(
            "cannot update {}: {error}; fix its permissions and rerun toodo init",
            path.display()
        ))
    };
    let existing = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return failed(error),
    };
    let text = upsert_table(&existing, CODEX_TABLE, &codex_table(url, token));
    match write_private(path, &text) {
        Ok(()) => Outcome::Registered(path.display().to_string()),
        Err(error) => failed(error),
    }
}

/// Rewrites the table of the server in the Codex config at `path` when it has one.
fn codex_refresh(path: &Path, url: &str, token: &str) -> Outcome {
    match fs::read_to_string(path) {
        Ok(text) if text.lines().any(|line| line.trim() == CODEX_TABLE) => codex(path, url, token),
        Ok(_) => Outcome::Skipped,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Outcome::Skipped,
        Err(error) => Outcome::Failed(format!(
            "cannot read {}: {error}; fix its permissions and rerun toodo init",
            path.display()
        )),
    }
}

/// The Codex `config.toml` table for the server.
pub(super) fn codex_table(url: &str, token: &str) -> String {
    format!(
        "{CODEX_TABLE}\nurl = \"{url}\"\nhttp_headers = {{ \"Authorization\" = \"Bearer {token}\" }}\n"
    )
}

/// `existing` with the table that starts at the line `header` (up to the next line that
/// starts with `[`) replaced by `table`, or with `table` appended; the rest is untouched.
pub(super) fn upsert_table(existing: &str, header: &str, table: &str) -> String {
    let lines: Vec<&str> = existing.split_inclusive('\n').collect();
    let Some(start) = lines.iter().position(|line| line.trim() == header) else {
        if existing.trim().is_empty() {
            return table.to_owned();
        }
        let separator = if existing.ends_with('\n') {
            "\n"
        } else {
            "\n\n"
        };
        return format!("{existing}{separator}{table}");
    };
    let end = lines[start + 1..]
        .iter()
        .position(|line| line.starts_with('['))
        .map_or(lines.len(), |offset| start + 1 + offset);
    let mut text: String = lines[..start].concat();
    text.push_str(table);
    if end < lines.len() {
        text.push('\n');
        text.push_str(&lines[end..].concat());
    }
    text
}

/// `existing` without the table that starts at the line `header`, and that table, if
/// there is one; the blank lines before it go with it.
pub(super) fn remove_table(existing: &str, header: &str) -> (String, Option<String>) {
    let lines: Vec<&str> = existing.split_inclusive('\n').collect();
    let Some(start) = lines.iter().position(|line| line.trim() == header) else {
        return (existing.to_owned(), None);
    };
    let end = lines[start + 1..]
        .iter()
        .position(|line| line.starts_with('['))
        .map_or(lines.len(), |offset| start + 1 + offset);
    let before = lines[..start]
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .map_or(0, |last| last + 1);
    let mut rest: String = lines[..before].concat();
    if end < lines.len() && !rest.is_empty() {
        rest.push('\n');
    }
    rest.push_str(&lines[end..].concat());
    (rest, Some(lines[start..end].concat()))
}

/// Writes `text` to `path`, readable by the owner only, creating its directory.
fn write_private(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let temporary = path.with_file_name(format!(
        ".{}.{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    fs::write(&temporary, text)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = "[mcp_servers.toodo]\nurl = \"http://127.0.0.1:1/mcp\"\n";

    #[test]
    fn the_codex_table_carries_the_url_and_the_bearer_token() {
        assert_eq!(
            codex_table("http://127.0.0.1:47616/mcp", "abc"),
            "[mcp_servers.toodo]\nurl = \"http://127.0.0.1:47616/mcp\"\n\
             http_headers = { \"Authorization\" = \"Bearer abc\" }\n"
        );
    }

    #[test]
    fn the_claude_helper_reads_the_token_file_on_each_run() {
        let dir = tempfile::tempdir().unwrap();
        let token_file = dir.path().join("it's a dir/mcp-token");
        fs::create_dir_all(token_file.parent().unwrap()).unwrap();
        fs::write(&token_file, "abc\n").unwrap();
        let entry: serde_json::Value =
            serde_json::from_str(&claude_entry("http://127.0.0.1:1/mcp", &token_file)).unwrap();
        assert_eq!(entry["type"], "http");
        assert_eq!(entry["url"], "http://127.0.0.1:1/mcp");
        assert!(entry.get("headers").is_none());
        let helper = entry["headersHelper"].as_str().unwrap();
        let headers = || {
            let output = std::process::Command::new("sh")
                .args(["-c", helper])
                .output()
                .unwrap();
            assert!(output.status.success());
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        assert_eq!(
            headers(),
            serde_json::json!({ "Authorization": "Bearer abc" })
        );
        fs::write(&token_file, "def").unwrap();
        assert_eq!(
            headers(),
            serde_json::json!({ "Authorization": "Bearer def" })
        );
    }

    #[test]
    fn a_refresh_rewrites_only_an_existing_codex_registration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        assert_eq!(
            codex_refresh(&path, "http://127.0.0.1:1/mcp", "new"),
            Outcome::Skipped
        );
        assert!(!path.exists());
        fs::write(&path, "model = \"o3\"\n").unwrap();
        assert_eq!(
            codex_refresh(&path, "http://127.0.0.1:1/mcp", "new"),
            Outcome::Skipped
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "model = \"o3\"\n");
        fs::write(
            &path,
            format!(
                "model = \"o3\"\n\n{}",
                codex_table("http://127.0.0.1:1/mcp", "old")
            ),
        )
        .unwrap();
        assert_eq!(
            codex_refresh(&path, "http://127.0.0.1:1/mcp", "new"),
            Outcome::Registered(path.display().to_string())
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!(
                "model = \"o3\"\n\n{}",
                codex_table("http://127.0.0.1:1/mcp", "new")
            )
        );
    }

    #[test]
    fn the_table_is_the_whole_of_an_empty_config() {
        assert_eq!(upsert_table("", CODEX_TABLE, TABLE), TABLE);
        assert_eq!(upsert_table("\n", CODEX_TABLE, TABLE), TABLE);
    }

    #[test]
    fn the_table_is_appended_after_other_content() {
        let existing = "model = \"o3\"\n\n[mcp_servers.other]\nurl = \"x\"";
        assert_eq!(
            upsert_table(existing, CODEX_TABLE, TABLE),
            format!("{existing}\n\n{TABLE}")
        );
        let existing = "model = \"o3\"\n";
        assert_eq!(
            upsert_table(existing, CODEX_TABLE, TABLE),
            format!("{existing}\n{TABLE}")
        );
    }

    #[test]
    fn an_existing_table_is_replaced_and_other_tables_are_kept() {
        let existing = "model = \"o3\"\n\n[mcp_servers.toodo]\nurl = \"http://old/mcp\"\n\
                        http_headers = { \"Authorization\" = \"Bearer old\" }\n\n\
                        [mcp_servers.other]\nurl = \"x\"\n";
        assert_eq!(
            upsert_table(existing, CODEX_TABLE, TABLE),
            format!("model = \"o3\"\n\n{TABLE}\n[mcp_servers.other]\nurl = \"x\"\n")
        );
        let last = "[a]\nb = 1\n[mcp_servers.toodo]\nurl = \"old\"\n";
        assert_eq!(
            upsert_table(last, CODEX_TABLE, TABLE),
            format!("[a]\nb = 1\n{TABLE}")
        );
    }

    #[test]
    fn removing_the_table_keeps_the_other_tables() {
        let other = "model = \"o3\"\n\n[mcp_servers.other]\nurl = \"x\"\n";
        let (rest, removed) = remove_table(&format!("{other}\n{TABLE}"), CODEX_TABLE);
        assert_eq!(rest, other);
        assert_eq!(removed.as_deref(), Some(TABLE));
        let (rest, removed) =
            remove_table(&format!("[a]\nb = 1\n\n{TABLE}\n[c]\nd = 2\n"), CODEX_TABLE);
        assert_eq!(rest, "[a]\nb = 1\n\n[c]\nd = 2\n");
        assert_eq!(removed.as_deref(), Some(&*format!("{TABLE}\n")));
        assert_eq!(remove_table(other, CODEX_TABLE), (other.to_owned(), None));
        assert_eq!(remove_table(TABLE, CODEX_TABLE).0, "");
    }

    #[test]
    fn the_codex_config_is_created_private_and_updated_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codex/config.toml");
        assert_eq!(
            codex(&path, "http://127.0.0.1:1/mcp", "one"),
            Outcome::Registered(path.display().to_string())
        );
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        fs::write(
            &path,
            format!("[other]\nx = 1\n\n{}", fs::read_to_string(&path).unwrap()),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        codex(&path, "http://127.0.0.1:2/mcp", "two");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!(
                "[other]\nx = 1\n\n{}",
                codex_table("http://127.0.0.1:2/mcp", "two")
            )
        );
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn the_codex_config_follows_codex_home() {
        let var = |name: &str| match name {
            "CODEX_HOME" => Some("/c".to_owned()),
            "HOME" => Some("/home/a".to_owned()),
            _ => None,
        };
        assert_eq!(codex_config(&var).unwrap(), Path::new("/c/config.toml"));
        let var = |name: &str| (name == "HOME").then(|| "/home/a".to_owned());
        assert_eq!(
            codex_config(&var).unwrap(),
            Path::new("/home/a/.codex/config.toml")
        );
    }
}
