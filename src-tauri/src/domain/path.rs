//! Absolute paths on the machine that hosts a workspace. Windows and POSIX paths are
//! distinct types so a local path can never be used on a remote machine or vice versa.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathError {
    NotAbsolute(String),
    WslNotSupported(String),
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute(path) => write!(f, "path is not absolute: {path:?}"),
            Self::WslNotSupported(path) => write!(
                f,
                "WSL paths are not supported as local workspaces; register them as SSH workspaces: {path:?}"
            ),
        }
    }
}

impl std::error::Error for PathError {}

/// Absolute Windows path: a drive path (`C:\dev`) or a UNC path (`\\server\share`).
/// Forward slashes are normalized to backslashes and trailing separators are removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsPath(String);

impl WindowsPath {
    pub fn parse(raw: &str) -> Result<Self, PathError> {
        let normalized = raw.trim().replace('/', "\\");
        let lower = normalized.to_ascii_lowercase();
        if lower.starts_with(r"\\wsl$\") || lower.starts_with(r"\\wsl.localhost\") {
            return Err(PathError::WslNotSupported(raw.to_owned()));
        }
        let bytes = normalized.as_bytes();
        let is_drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\';
        let is_unc = normalized.len() > 2
            && normalized.starts_with(r"\\")
            && !normalized[2..].starts_with('\\');
        if !is_drive && !is_unc {
            return Err(PathError::NotAbsolute(raw.to_owned()));
        }
        // Keep the separator of a bare drive root (`C:\`).
        let trimmed_len = normalized.trim_end_matches('\\').len().max(3);
        Ok(Self(normalized[..trimmed_len].to_owned()))
    }

    /// Appends one path segment. `segment` must not contain separators.
    pub fn join(&self, segment: &str) -> Self {
        if self.0.ends_with('\\') {
            Self(format!("{}{segment}", self.0))
        } else {
            Self(format!("{}\\{segment}", self.0))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for WindowsPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Absolute POSIX path on a remote machine. Trailing separators are removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PosixPath(String);

impl PosixPath {
    pub fn parse(raw: &str) -> Result<Self, PathError> {
        let path = raw.trim();
        if !path.starts_with('/') {
            return Err(PathError::NotAbsolute(raw.to_owned()));
        }
        let trimmed_len = path.trim_end_matches('/').len().max(1);
        Ok(Self(path[..trimmed_len].to_owned()))
    }

    /// Appends one path segment. `segment` must not contain separators.
    pub fn join(&self, segment: &str) -> Self {
        if self.0 == "/" {
            Self(format!("/{segment}"))
        } else {
            Self(format!("{}/{segment}", self.0))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PosixPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_drive_paths_are_normalized() {
        let path = WindowsPath::parse(r"C:/dev/worktrees\").unwrap();
        assert_eq!(path.as_str(), r"C:\dev\worktrees");
        assert_eq!(WindowsPath::parse(r"D:\").unwrap().as_str(), r"D:\");
        assert_eq!(
            WindowsPath::parse(r"D:\").unwrap().join("repo").as_str(),
            r"D:\repo"
        );
    }

    #[test]
    fn windows_unc_paths_are_accepted() {
        let path = WindowsPath::parse(r"\\server\share\repo\").unwrap();
        assert_eq!(path.join("a").as_str(), r"\\server\share\repo\a");
    }

    #[test]
    fn windows_relative_and_wsl_paths_are_rejected() {
        for raw in [r"dev\repo", r"C:dev", r"\dev", "", r"\\\x"] {
            assert_eq!(
                WindowsPath::parse(raw),
                Err(PathError::NotAbsolute(raw.to_owned())),
                "{raw:?}"
            );
        }
        for raw in [
            r"\\wsl$\Ubuntu\home",
            r"\\WSL.localhost\Ubuntu\home",
            "//wsl$/Ubuntu",
        ] {
            assert_eq!(
                WindowsPath::parse(raw),
                Err(PathError::WslNotSupported(raw.to_owned())),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn posix_paths_require_a_leading_slash() {
        assert_eq!(
            PosixPath::parse("/home/me/wt/").unwrap().join("x").as_str(),
            "/home/me/wt/x"
        );
        assert_eq!(PosixPath::parse("/").unwrap().join("x").as_str(), "/x");
        assert_eq!(
            PosixPath::parse("~/wt"),
            Err(PathError::NotAbsolute("~/wt".to_owned()))
        );
    }
}
