//! The user's OpenSSH client config, shared with `ssh.exe` and herdr, and directory
//! listings of remote machines for the folder browser.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Duration;

use super::git::{
    GitError, Invocation, Runner, SSH_OPTIONS, powershell_command, powershell_quote, shell_quote,
    ssh_invocation,
};
use crate::domain::model::{HostPath, MachineLabel};
use crate::domain::path::{PosixPath, WindowsPath};
use crate::domain::ssh_config::{self, SshHost, SshHostError};

#[derive(Debug)]
pub enum SshConfigError {
    Io { path: PathBuf, error: io::Error },
    Host(SshHostError),
}

impl fmt::Display for SshConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, error } => write!(f, "failed to access {}: {error}", path.display()),
            Self::Host(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for SshConfigError {}

/// `~/.ssh/config`; `%USERPROFILE%\.ssh\config` on Windows.
pub struct SshConfigFile {
    path: PathBuf,
}

impl SshConfigFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The config in the user's home directory, or `None` when the home directory is
    /// unknown.
    pub fn in_home() -> Option<Self> {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .filter(|home| !home.is_empty())?;
        Some(Self::new(PathBuf::from(home).join(".ssh").join("config")))
    }

    /// Host aliases of the config, read on every call so external edits show up. A
    /// missing file has no hosts.
    pub fn host_aliases(&self) -> Result<Vec<String>, SshConfigError> {
        Ok(ssh_config::host_aliases(&self.read()?))
    }

    /// Appends a `Host` block, creating the file and its directory when missing.
    pub fn add_host(&self, host: &SshHost) -> Result<(), SshConfigError> {
        let block = host
            .block_to_append(&self.read()?)
            .map_err(SshConfigError::Host)?;
        let io_error = |error| SshConfigError::Io {
            path: self.path.clone(),
            error,
        };
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(io_error)?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| file.write_all(block.as_bytes()))
            .map_err(io_error)
    }

    fn read(&self) -> Result<String, SshConfigError> {
        match fs::read_to_string(&self.path) {
            Ok(config) => Ok(config),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(SshConfigError::Io {
                path: self.path.clone(),
                error,
            }),
        }
    }
}

/// Subdirectories of one directory on a remote machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDirectory {
    /// Absolute path of the listed directory as resolved by the remote shell; a Windows
    /// path on a Windows host.
    pub path: HostPath,
    /// Names of subdirectories, hidden ones included, sorted case-insensitively.
    pub directories: Vec<String>,
}

/// What testing the connection to an SSH machine found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineCheck {
    /// Toodo connected without a prompt and found git; holds the `git --version` line.
    Ready { git_version: String },
    /// The test failed; says what failed and the next step that fixes it.
    Problem(String),
}

/// How long a connection test may take; `ssh` itself gives up connecting after 10 seconds.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Ssh {
    runner: Box<dyn Runner>,
}

impl Ssh {
    pub fn new(runner: Box<dyn Runner>) -> Self {
        Self { runner }
    }

    /// Tests that Toodo reaches `machine` the way it runs git there: `ssh` without prompts
    /// runs `git --version`, which works in `sh`, `cmd`, and PowerShell alike. The test
    /// opens its own connection, so a shared one left from before a config change does not
    /// hide what changed.
    pub fn check_machine(&self, machine: &MachineLabel) -> MachineCheck {
        let invocation = Invocation {
            program: "ssh",
            args: SSH_OPTIONS
                .iter()
                .chain(&["--", machine.as_str(), "git --version"])
                .map(|arg| (*arg).to_owned())
                .collect(),
        };
        match self.runner.run_within(&invocation, CHECK_TIMEOUT) {
            Ok(output) => match output
                .lines()
                .map(str::trim)
                .find(|line| line.starts_with("git version"))
            {
                Some(version) => MachineCheck::Ready {
                    git_version: version.to_owned(),
                },
                None => MachineCheck::Problem(format!(
                    "Connected to {machine}, but `git --version` printed {:?} instead of a git \
                     version. Run `ssh {machine} git --version` in a terminal on the server, make \
                     it print `git version ...`, then test again.",
                    output.trim()
                )),
            },
            Err(error) => MachineCheck::Problem(check_problem(machine, &error)),
        }
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

/// Why `ssh <machine> git --version` failed, and the next step that fixes it, told by what
/// `ssh` or the remote shell printed.
fn check_problem(machine: &MachineLabel, error: &GitError) -> String {
    let output = match error {
        GitError::Spawn { message, .. } => {
            return format!(
                "Could not run ssh on the server ({message}). Install OpenSSH so that `ssh` is \
                 on the PATH of toodo-server, then test again."
            );
        }
        GitError::Failed { stderr, .. } => stderr,
        GitError::UnexpectedOutput { output, .. } => output,
    };
    let said = output.to_lowercase();
    let has = |needle: &str| said.contains(needle);
    let problem = if has("could not resolve hostname") {
        format!(
            "The host name of {machine} could not be resolved. Check the HostName of \
             `Host {machine}` in ~/.ssh/config on the server, or add that Host block, then \
             test again."
        )
    } else if has("host key verification failed") || has("remote host identification has changed") {
        format!(
            "The server does not know the host key of {machine}, or it changed. Run \
             `ssh {machine}` once in a terminal on the server to check and accept the key, \
             then test again."
        )
    } else if has("permission denied") {
        format!(
            "{machine} refused the server's SSH key, and Toodo never asks for a password. Add \
             the server's public key to ~/.ssh/authorized_keys on {machine} (for example with \
             `ssh-copy-id {machine}`) or set the IdentityFile of `Host {machine}` in \
             ~/.ssh/config, then test again."
        )
    } else if has("connection refused") {
        format!(
            "Nothing accepts SSH connections on {machine}. Check that the SSH server runs there \
             and that the Port of `Host {machine}` in ~/.ssh/config is right, then test again."
        )
    } else if has("timed out")
        || has("no route to host")
        || has("network is unreachable")
        || has("stopped after")
    {
        format!(
            "{machine} did not answer. Check that it is on and reachable from the server \
             (network, VPN, firewall) and that its HostName in ~/.ssh/config is right, then \
             test again."
        )
    } else if has("git") && (has("not found") || has("not recognized")) {
        format!(
            "Connected to {machine}, but git is not installed there or not on the PATH of SSH \
             commands. Install git on {machine} (for example `sudo apt install git`, or Git \
             for Windows), then test again."
        )
    } else {
        format!(
            "Connecting to {machine} failed. Run `ssh {machine} git --version` in a terminal \
             on the server to see why, fix what it reports, then test again."
        )
    };
    match output.lines().map(str::trim).rfind(|line| !line.is_empty()) {
        Some(detail) => format!("{problem} ssh said: {detail}"),
        None => problem,
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

    #[test]
    fn check_machine_runs_git_on_its_own_connection() {
        let runner = Arc::new(FakeRunner::new([Ok("git version 2.43.0\n".to_owned())]));
        let ssh = Ssh::new(Box::new(runner.clone()));
        assert_eq!(
            ssh.check_machine(&devbox()),
            MachineCheck::Ready {
                git_version: "git version 2.43.0".to_owned()
            }
        );
        let invocation = runner.invocations.lock().unwrap()[0].clone();
        assert_eq!(invocation.program, "ssh");
        let mut expected = crate::adapters::git::fake::run_ssh_args("devbox");
        expected.push("git --version".to_owned());
        assert_eq!(invocation.args, expected);
    }

    #[test]
    fn check_machine_names_the_next_step_of_each_failure() {
        let failed = |stderr: &str| {
            Err(GitError::Failed {
                command: "ssh devbox git --version".to_owned(),
                stderr: stderr.to_owned(),
            })
        };
        let cases = [
            (
                failed("ssh: Could not resolve hostname devbox: Name or service not known\n"),
                "HostName of `Host devbox` in ~/.ssh/config",
            ),
            (
                failed("No ED25519 host key is known for devbox.\nHost key verification failed.\n"),
                "Run `ssh devbox` once in a terminal",
            ),
            (
                failed("me@devbox: Permission denied (publickey).\n"),
                "`ssh-copy-id devbox`",
            ),
            (
                failed("ssh: connect to host 10.0.0.5 port 22: Connection refused\n"),
                "Port of `Host devbox`",
            ),
            (
                failed("ssh: connect to host 10.0.0.5 port 22: Connection timed out\n"),
                "reachable from the server",
            ),
            (failed("sh: 1: git: not found\n"), "Install git on devbox"),
            (
                failed("'git' is not recognized as an internal or external command,\r\n"),
                "Install git on devbox",
            ),
            (
                failed("kex_exchange_identification: read: Connection reset\n"),
                "Run `ssh devbox git --version`",
            ),
            (
                Err(GitError::Spawn {
                    program: "ssh".to_owned(),
                    message: "No such file or directory (os error 2)".to_owned(),
                }),
                "Install OpenSSH",
            ),
            (Ok("Welcome!\n".to_owned()), "instead of a git version"),
        ];
        for (result, next_step) in cases {
            let ssh = Ssh::new(Box::new(Arc::new(FakeRunner::new([result]))));
            match ssh.check_machine(&devbox()) {
                MachineCheck::Problem(problem) => {
                    assert!(problem.contains(next_step), "{problem}")
                }
                ready => panic!("expected a problem with {next_step:?}, got {ready:?}"),
            }
        }
    }

    #[test]
    fn config_file_lists_and_appends_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let config = SshConfigFile::new(dir.path().join(".ssh").join("config"));
        assert!(config.host_aliases().unwrap().is_empty());
        config
            .add_host(&SshHost::new("devbox", "10.0.0.5", Some("me"), None).unwrap())
            .unwrap();
        config
            .add_host(&SshHost::new("gpu", "gpu.lan", None, Some(2222)).unwrap())
            .unwrap();
        assert_eq!(config.host_aliases().unwrap(), ["devbox", "gpu"]);
        assert_eq!(
            fs::read_to_string(dir.path().join(".ssh").join("config")).unwrap(),
            "Host devbox\n    HostName 10.0.0.5\n    User me\n\nHost gpu\n    HostName gpu.lan\n    Port 2222\n"
        );
        assert!(matches!(
            config.add_host(&SshHost::new("gpu", "x", None, None).unwrap()),
            Err(SshConfigError::Host(SshHostError::AlreadyExists(_)))
        ));
    }
}
