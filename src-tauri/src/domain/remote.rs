//! GitHub repositories identified from git remote URLs, so pull requests can be opened
//! with `gh --repo <host>/<owner>/<name>` from any machine.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubRepository {
    pub host: String,
    pub owner: String,
    pub name: String,
}

impl GitHubRepository {
    /// Parses a remote URL in one of the forms git accepts for a hosted repository:
    /// `https://host/owner/name(.git)`, `ssh://[user@]host[:port]/owner/name(.git)`, or
    /// `[user@]host:owner/name(.git)`. Returns `None` for local paths and for URLs whose
    /// path is not exactly `owner/name`.
    pub fn from_remote_url(url: &str) -> Option<Self> {
        let url = url.trim();
        let (authority, path) = match url.split_once("://") {
            Some((scheme, rest)) => {
                if !matches!(scheme, "https" | "http" | "ssh" | "git") {
                    return None;
                }
                rest.split_once('/')?
            }
            None => {
                let (authority, path) = url.split_once(':')?;
                if authority.contains('/') || authority.contains('\\') {
                    return None;
                }
                (authority, path)
            }
        };
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        // A single letter before `:` is a Windows drive, not a host.
        if host.len() < 2 || !host.chars().all(is_host_char) {
            return None;
        }
        let path = path.trim_matches('/');
        let path = path.strip_suffix(".git").unwrap_or(path);
        let (owner, name) = path.split_once('/')?;
        if [owner, name]
            .iter()
            .any(|part| part.is_empty() || !part.chars().all(is_name_char))
        {
            return None;
        }
        Some(Self {
            host: host.to_ascii_lowercase(),
            owner: owner.to_owned(),
            name: name.to_owned(),
        })
    }
}

fn is_host_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-')
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')
}

impl fmt::Display for GitHubRepository {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}/{}", self.host, self.owner, self.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Option<String> {
        GitHubRepository::from_remote_url(url).map(|repo| repo.to_string())
    }

    #[test]
    fn hosted_remote_urls_name_the_repository() {
        let cases = [
            "https://github.com/acme/toodo.git",
            "https://github.com/acme/toodo",
            "https://user@GitHub.com/acme/toodo/",
            "ssh://git@github.com/acme/toodo.git",
            "ssh://git@github.com:22/acme/toodo.git",
            "git@github.com:acme/toodo.git",
            "github.com:acme/toodo\n",
        ];
        for url in cases {
            assert_eq!(
                parse(url).as_deref(),
                Some("github.com/acme/toodo"),
                "{url}"
            );
        }
        assert_eq!(
            parse("git@ghe.example.com:team/my_repo.v2.git").as_deref(),
            Some("ghe.example.com/team/my_repo.v2")
        );
    }

    #[test]
    fn local_paths_and_other_shapes_are_not_repositories() {
        let cases = [
            "",
            "/srv/git/toodo.git",
            r"C:\repos\toodo",
            "C:/acme/toodo",
            "file:///srv/git/toodo.git",
            "https://github.com/acme",
            "https://github.com/acme/toodo/tree/main",
            "git@github.com:acme/to do.git",
        ];
        for url in cases {
            assert_eq!(parse(url), None, "{url}");
        }
    }
}
