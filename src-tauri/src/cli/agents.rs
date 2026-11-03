//! Registering the server's MCP endpoint with the coding agents on `PATH`: Claude Code
//! through `claude mcp add`, Codex in its `config.toml`.

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::Var;
use super::process;

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
        Some(_) => claude(url, token, token_file),
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

fn claude(url: &str, token: &str, token_file: &Path) -> Outcome {
    // A registration from an earlier init may have another port or token.
    drop(process::output(
        "claude",
        &["mcp", "remove", "--scope", "user", SERVER_NAME],
    ));
    let header = format!("Authorization: Bearer {token}");
    let args = [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        SERVER_NAME,
        url,
        "--header",
        &header,
    ];
    let next_step = format!(
        "register it yourself with: claude mcp add --transport http --scope user {SERVER_NAME} \
         {url} --header \"Authorization: Bearer $(cat {})\"",
        token_file.display()
    );
    match process::run("claude", &args, &next_step) {
        Ok(_) => Outcome::Registered("user scope of Claude Code".to_owned()),
        Err(error) => Outcome::Failed(error),
    }
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
