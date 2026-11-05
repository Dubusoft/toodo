//! Directory listings of remote machines over OpenSSH `ssh`, for the folder browser.

use super::git::{
    GitError, Runner, powershell_command, powershell_quote, shell_quote, ssh_invocation,
};
use crate::domain::model::{HostPath, MachineLabel};
use crate::domain::path::{PosixPath, WindowsPath};

/// Subdirectories of one directory on a remote machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDirectory {
    /// Absolute path of the listed directory as resolved by the remote shell; a Windows
    /// path on a Windows host.
    pub path: HostPath,
    /// Names of subdirectories, hidden ones included, sorted case-insensitively.
    pub directories: Vec<String>,
}

pub struct Ssh {
    runner: Box<dyn Runner>,
}

impl Ssh {
    pub fn new(runner: Box<dyn Runner>) -> Self {
        Self { runner }
    }

    /// Lists the subdirectories of `path` on `machine`, or of the login directory when
    /// `path` is `None`. Runs a POSIX `sh` script so that it works whatever the login
    /// shell of the remote user is, and a PowerShell script for a Windows path or, without
    /// a path, when the `sh` script fails, as it does on a Windows host.
    pub fn list_directories(
        &self,
        machine: &MachineLabel,
        path: Option<&HostPath>,
    ) -> Result<RemoteDirectory, GitError> {
        match path {
            Some(HostPath::Windows(path)) => self.list_windows_directories(machine, Some(path)),
            Some(HostPath::Posix(path)) => self.list_posix_directories(machine, Some(path)),
            None => match self.list_posix_directories(machine, None) {
                Err(posix @ GitError::Failed { .. }) => self
                    .list_windows_directories(machine, None)
                    .map_err(|_| posix),
                listing => listing,
            },
        }
    }

    fn list_posix_directories(
        &self,
        machine: &MachineLabel,
        path: Option<&PosixPath>,
    ) -> Result<RemoteDirectory, GitError> {
        let cd = path
            .map(|path| format!("cd -- {} || exit 1; ", shell_quote(path.as_str())))
            .unwrap_or_default();
        let script = format!(
            "{cd}pwd; for entry in * .*; do [ -d \"$entry\" ] && printf '%s\\n' \"$entry\"; done; exit 0"
        );
        let invocation = ssh_invocation(machine, format!("sh -c {}", shell_quote(&script)));
        let output = self.runner.run(&invocation)?;
        listing(machine, &output, |line| {
            PosixPath::parse(line).ok().map(HostPath::Posix)
        })
    }

    /// Lists directories on a Windows host with a PowerShell script that prints the
    /// directory and then the names of its subdirectories as UTF-8 lines.
    fn list_windows_directories(
        &self,
        machine: &MachineLabel,
        path: Option<&WindowsPath>,
    ) -> Result<RemoteDirectory, GitError> {
        let cd = path
            .map(|path| {
                format!(
                    "Set-Location -LiteralPath {}\n",
                    powershell_quote(path.as_str())
                )
            })
            .unwrap_or_default();
        let script = format!(
            "$ErrorActionPreference = 'Stop'
{cd}$lines = @((Get-Location).ProviderPath) + @(Get-ChildItem -LiteralPath . -Directory -Force | ForEach-Object {{ $_.Name }})
$bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join \"`n\") + \"`n\")
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
"
        );
        let output = self
            .runner
            .run(&ssh_invocation(machine, powershell_command(&script)))?;
        listing(machine, &output, |line| {
            WindowsPath::parse(line).ok().map(HostPath::Windows)
        })
    }
}

/// A listing printed as the listed directory, parsed by `parse_path`, followed by the
/// names of its subdirectories, one per line.
fn listing(
    machine: &MachineLabel,
    output: &str,
    parse_path: impl Fn(&str) -> Option<HostPath>,
) -> Result<RemoteDirectory, GitError> {
    let mut lines = output.lines();
    let unexpected = || GitError::UnexpectedOutput {
        command: format!("ssh {machine} ls"),
        output: output.to_owned(),
    };
    let path = lines
        .next()
        .and_then(|line| parse_path(line.trim_end_matches('\r')))
        .ok_or_else(unexpected)?;
    let mut directories: Vec<String> = lines
        .map(|line| line.trim_end_matches('\r'))
        .filter(|name| !matches!(*name, "" | "." | ".."))
        .map(str::to_owned)
        .collect();
    directories.sort_by_key(|name| name.to_lowercase());
    directories.dedup();
    Ok(RemoteDirectory { path, directories })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use super::*;
    use crate::adapters::git::fake::{FakeRunner, decode_powershell, failed};

    fn devbox() -> MachineLabel {
        MachineLabel::parse("devbox").unwrap()
    }

    #[test]
    fn list_directories_runs_a_quoted_script_and_sorts_the_names() {
        let runner = Arc::new(FakeRunner::new([Ok(
            "/home/me/it's\nsrc\n.\n..\n.config\nDocs\napp\n".to_owned(),
        )]));
        let ssh = Ssh::new(Box::new(runner.clone()));
        let listing = ssh.list_directories(&devbox(), None);
        let invocation = runner.invocations.lock().unwrap()[0].clone();
        assert_eq!(invocation.program, "ssh");
        assert_eq!(
            invocation.args[..invocation.args.len() - 1],
            crate::adapters::git::fake::ssh_args("devbox")
        );
        assert_eq!(
            invocation.args.last().unwrap(),
            r#"sh -c 'pwd; for entry in * .*; do [ -d "$entry" ] && printf '\''%s\n'\'' "$entry"; done; exit 0'"#
        );
        assert_eq!(
            listing.unwrap(),
            RemoteDirectory {
                path: HostPath::Posix(PosixPath::parse("/home/me/it's").unwrap()),
                directories: [".config", "app", "Docs", "src"]
                    .map(str::to_owned)
                    .to_vec(),
            }
        );
    }

    /// Runs the remote command the way sshd does, through a local POSIX shell.
    #[cfg(unix)]
    #[test]
    fn remote_script_lists_directories_of_a_quoted_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("it's here");
        for sub in ["b dir", ".hidden", "a"] {
            fs::create_dir_all(root.join(sub)).unwrap();
        }
        fs::write(root.join("file.txt"), "").unwrap();
        let runner = Arc::new(FakeRunner::new([Ok("/\n".to_owned())]));
        let ssh = Ssh::new(Box::new(runner.clone()));
        let path = HostPath::Posix(PosixPath::parse(root.to_str().unwrap()).unwrap());
        ssh.list_directories(&devbox(), Some(&path)).unwrap();
        let remote = runner.invocations.lock().unwrap()[0]
            .args
            .last()
            .unwrap()
            .clone();
        let output = std::process::Command::new("sh")
            .args(["-c", &remote])
            .output()
            .unwrap();
        let real = Ssh::new(Box::new(Arc::new(FakeRunner::new([Ok(
            String::from_utf8(output.stdout).unwrap(),
        )]))));
        let listing = real.list_directories(&devbox(), None).unwrap();
        // Canonical on both sides: the macOS temporary directory is behind a symlink.
        assert_eq!(
            fs::canonicalize(listing.path.as_str()).unwrap(),
            root.canonicalize().unwrap()
        );
        assert_eq!(listing.directories, [".hidden", "a", "b dir"]);

        let missing = HostPath::Posix(PosixPath::parse("/no/such/dir-for-toodo").unwrap());
        let runner = Arc::new(FakeRunner::new([Ok(String::new())]));
        Ssh::new(Box::new(runner.clone()))
            .list_directories(&devbox(), Some(&missing))
            .unwrap_err();
        let remote = runner.invocations.lock().unwrap()[0]
            .args
            .last()
            .unwrap()
            .clone();
        let status = std::process::Command::new("sh")
            .args(["-c", &remote])
            .output()
            .unwrap()
            .status;
        assert!(!status.success());
    }

    #[test]
    fn list_directories_reports_failures_and_garbage() {
        // Without a path, a failing `sh` script is retried as PowerShell; when that fails
        // too, the first failure is reported.
        let runner = Arc::new(FakeRunner::new([
            Err(failed()),
            Err(GitError::Failed {
                command: "powershell".to_owned(),
                stderr: "not found".to_owned(),
            }),
            Ok("relative\n".to_owned()),
        ]));
        let ssh = Ssh::new(Box::new(runner.clone()));
        assert_eq!(ssh.list_directories(&devbox(), None), Err(failed()));
        assert!(matches!(
            ssh.list_directories(&devbox(), None),
            Err(GitError::UnexpectedOutput { .. })
        ));
    }

    #[test]
    fn windows_hosts_are_listed_with_powershell() {
        let runner = Arc::new(FakeRunner::new([
            Err(failed()),
            Ok("C:\\Users\\me\r\nsrc\r\n.git\r\n".to_owned()),
            Ok("D:\\dev\\it's\nrepo\n".to_owned()),
        ]));
        let ssh = Ssh::new(Box::new(runner.clone()));
        assert_eq!(
            ssh.list_directories(&devbox(), None).unwrap(),
            RemoteDirectory {
                path: HostPath::parse(r"C:\Users\me").unwrap(),
                directories: [".git", "src"].map(str::to_owned).to_vec(),
            }
        );
        let path = HostPath::parse(r"D:\dev\it's").unwrap();
        assert_eq!(
            ssh.list_directories(&devbox(), Some(&path)).unwrap(),
            RemoteDirectory {
                path: path.clone(),
                directories: vec!["repo".to_owned()],
            }
        );

        let invocations = runner.invocations.lock().unwrap();
        assert!(invocations[0].args.last().unwrap().starts_with("sh -c "));
        let login = decode_powershell(invocations[1].args.last().unwrap());
        assert!(!login.contains("Set-Location"), "{login}");
        assert!(login.contains("Get-ChildItem -LiteralPath . -Directory -Force"));
        let given = decode_powershell(invocations[2].args.last().unwrap());
        assert!(
            given.contains(r"Set-Location -LiteralPath 'D:\dev\it''s'"),
            "{given}"
        );
    }
}
