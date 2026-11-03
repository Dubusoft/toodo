//! OpenSSH client configuration (`~/.ssh/config`): the host aliases a user can connect
//! to, and the `Host` block written when a remote machine is added.

use std::fmt;

/// Aliases of the `Host` entries that name one concrete host, in file order without
/// duplicates. Patterns with wildcards or negations (`*`, `?`, `!`) are skipped, as in
/// VS Code Remote-SSH, because they cannot be connected to by name.
pub fn host_aliases(config: &str) -> Vec<String> {
    let mut aliases: Vec<String> = Vec::new();
    for line in config.lines() {
        let Some((keyword, rest)) = split_keyword(line) else {
            continue;
        };
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        for alias in arguments(rest) {
            if is_concrete(&alias) && !aliases.contains(&alias) {
                aliases.push(alias);
            }
        }
    }
    aliases
}

/// Splits a config line into its keyword and the remaining arguments. Keywords are
/// separated from arguments by whitespace or one `=`.
fn split_keyword(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest);
    Some((&line[..end], rest))
}

/// Whitespace-separated arguments; double quotes group an argument with spaces.
fn arguments(rest: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

fn is_concrete(alias: &str) -> bool {
    !alias.is_empty() && !alias.contains(['*', '?', '!'])
}

/// A remote machine to add to the SSH config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshHost {
    alias: String,
    host_name: String,
    user: Option<String>,
    port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshHostError {
    /// The alias is empty or contains whitespace, quotes, `#`, or pattern characters.
    InvalidAlias(String),
    /// The host name or user is empty where required or contains whitespace or quotes.
    InvalidField {
        field: &'static str,
        value: String,
    },
    InvalidPort,
    /// The config already has a `Host` entry with this alias.
    AlreadyExists(String),
}

impl fmt::Display for SshHostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAlias(alias) => write!(
                f,
                "host alias {alias:?} must be one word without quotes, '#', '*', '?', or '!'"
            ),
            Self::InvalidField { field, value } => {
                write!(f, "{field} {value:?} must be one word without quotes")
            }
            Self::InvalidPort => f.write_str("port must be between 1 and 65535"),
            Self::AlreadyExists(alias) => {
                write!(f, "the SSH config already has a host named {alias:?}")
            }
        }
    }
}

impl std::error::Error for SshHostError {}

fn is_word(value: &str) -> bool {
    !value.is_empty() && !value.contains(|c: char| c.is_whitespace() || c == '"' || c == '#')
}

impl SshHost {
    /// Validates the fields; an empty user or a missing port leaves them to ssh defaults.
    pub fn new(
        alias: &str,
        host_name: &str,
        user: Option<&str>,
        port: Option<u16>,
    ) -> Result<Self, SshHostError> {
        let alias = alias.trim();
        if !is_word(alias) || !is_concrete(alias) {
            return Err(SshHostError::InvalidAlias(alias.to_owned()));
        }
        let host_name = host_name.trim();
        if !is_word(host_name) {
            return Err(SshHostError::InvalidField {
                field: "host name",
                value: host_name.to_owned(),
            });
        }
        let user = user.map(str::trim).filter(|user| !user.is_empty());
        if let Some(user) = user.filter(|user| !is_word(user)) {
            return Err(SshHostError::InvalidField {
                field: "user",
                value: user.to_owned(),
            });
        }
        if port == Some(0) {
            return Err(SshHostError::InvalidPort);
        }
        Ok(Self {
            alias: alias.to_owned(),
            host_name: host_name.to_owned(),
            user: user.map(str::to_owned),
            port,
        })
    }

    pub fn alias(&self) -> &str {
        &self.alias
    }

    /// Text to append to `config` so that it gains this host. Starts with a blank line
    /// that separates it from the previous entry.
    pub fn block_to_append(&self, config: &str) -> Result<String, SshHostError> {
        if host_aliases(config).contains(&self.alias) {
            return Err(SshHostError::AlreadyExists(self.alias.clone()));
        }
        let mut block = String::new();
        if !config.is_empty() {
            if !config.ends_with('\n') {
                block.push('\n');
            }
            block.push('\n');
        }
        block.push_str(&format!(
            "Host {}\n    HostName {}\n",
            self.alias, self.host_name
        ));
        if let Some(user) = &self.user {
            block.push_str(&format!("    User {user}\n"));
        }
        if let Some(port) = self.port {
            block.push_str(&format!("    Port {port}\n"));
        }
        Ok(block)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_aliases_lists_concrete_hosts_in_order() {
        let config = "\
# comment
Host devbox build-1
    HostName 10.0.0.5
  host=\"quoted alias\"
Host *
    ServerAliveInterval 30
Host *.corp !bastion gpu?
Host devbox
Match host other
HostName not-a-host
";
        assert_eq!(
            host_aliases(config),
            ["devbox", "build-1", "quoted alias"].map(str::to_owned)
        );
        assert!(host_aliases("").is_empty());
    }

    #[test]
    fn block_is_appended_after_a_blank_line() {
        let host = SshHost::new(" devbox ", "10.0.0.5", Some("me"), Some(2222)).unwrap();
        assert_eq!(
            host.block_to_append("Host a\n    HostName a").unwrap(),
            "\n\nHost devbox\n    HostName 10.0.0.5\n    User me\n    Port 2222\n"
        );
        let minimal = SshHost::new("devbox", "devbox.lan", Some(" "), None).unwrap();
        assert_eq!(
            minimal.block_to_append("").unwrap(),
            "Host devbox\n    HostName devbox.lan\n"
        );
    }

    #[test]
    fn invalid_or_duplicate_hosts_are_rejected() {
        for alias in ["", "dev box", "dev*", "!dev", "a#b"] {
            assert_eq!(
                SshHost::new(alias, "h", None, None),
                Err(SshHostError::InvalidAlias(alias.trim().to_owned()))
            );
        }
        assert!(matches!(
            SshHost::new("a", "", None, None),
            Err(SshHostError::InvalidField { .. })
        ));
        assert!(matches!(
            SshHost::new("a", "h", Some("a b"), None),
            Err(SshHostError::InvalidField { .. })
        ));
        assert_eq!(
            SshHost::new("a", "h", None, Some(0)),
            Err(SshHostError::InvalidPort)
        );
        let host = SshHost::new("devbox", "h", None, None).unwrap();
        assert_eq!(
            host.block_to_append("Host other devbox\n"),
            Err(SshHostError::AlreadyExists("devbox".to_owned()))
        );
    }
}
