//! Runs git for a workspace: `git` for local workspaces and `ssh <machine> git ...` for
//! workspaces on a saved herdr SSH machine. On a Windows host git runs through PowerShell
//! (see [`windows_remote`]).

use std::collections::BTreeSet;
use std::fmt;
use std::process::{Command, Stdio};

use base64::Engine;

use crate::domain::model::{HostPath, MachineLabel, WorkspaceLocation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: &'static str,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitError {
    /// The process could not be started, e.g. `git` or `ssh` is not on `PATH`.
    Spawn { program: String, message: String },
    /// The process exited with a non-zero status.
    Failed { command: String, stderr: String },
    /// The process succeeded but printed something the app cannot use.
    UnexpectedOutput { command: String, output: String },
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn { program, message } => write!(f, "failed to run {program}: {message}"),
            Self::Failed { command, stderr } => write!(f, "`{command}` failed: {stderr}"),
            Self::UnexpectedOutput { command, output } => {
                write!(f, "`{command}` printed unexpected output: {output:?}")
            }
        }
    }
}

impl std::error::Error for GitError {}

/// Runs an invocation and returns its standard output.
pub trait Runner: Send + Sync {
    fn run(&self, invocation: &Invocation) -> Result<String, GitError>;
}

pub struct ProcessRunner;

impl Runner for ProcessRunner {
    fn run(&self, invocation: &Invocation) -> Result<String, GitError> {
        let mut command = Command::new(invocation.program);
        command
            .args(&invocation.args)
            // Fail instead of waiting for input on a terminal the user cannot see.
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null());
        let output = command.output().map_err(|error| GitError::Spawn {
            program: invocation.program.to_owned(),
            message: error.to_string(),
        })?;
        if !output.status.success() {
            return Err(GitError::Failed {
                command: describe(invocation),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

pub(super) fn describe(invocation: &Invocation) -> String {
    std::iter::once(invocation.program)
        .chain(invocation.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Quotes one word for a POSIX shell, such as the one that runs an SSH remote command.
pub(crate) fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// Quotes one argument for a Windows command line the way `CommandLineToArgvW` and the C
/// runtime of programs such as git split it again.
pub(crate) fn windows_quote(word: &str) -> String {
    if !word.is_empty() && !word.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return word.to_owned();
    }
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for c in word.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                continue;
            }
            // Backslashes before a quote escape themselves and the quote.
            '"' => quoted.push_str(&"\\".repeat(backslashes * 2 + 1)),
            _ => quoted.push_str(&"\\".repeat(backslashes)),
        }
        quoted.push(c);
        backslashes = 0;
    }
    // Backslashes before the closing quote escape themselves.
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// Quotes text as a single-quoted PowerShell string. PowerShell also takes the typographic
/// single quotes as quote characters, so they are doubled like `'`.
pub(crate) fn powershell_quote(text: &str) -> String {
    let mut quoted = String::from('\'');
    for c in text.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}') {
            quoted.push(c);
        }
        quoted.push(c);
    }
    quoted.push('\'');
    quoted
}

/// The remote command that runs `program` with the Windows command line `arguments` on a
/// Windows host, in `dir` when given. The SSH server there hands remote commands to
/// `cmd.exe` or PowerShell, which quote differently, so the command is a PowerShell script
/// encoded in base64, which both pass on untouched. The script starts the program
/// directly with the exact command line (no shell parses the arguments again), copies its
/// output bytes unchanged, and exits with its exit code.
pub(crate) fn windows_remote(program: &str, arguments: &str, dir: Option<&str>) -> String {
    let program = format!(
        "(Get-Command -Name {} -CommandType Application -TotalCount 1).Path",
        powershell_quote(program)
    );
    windows_start("", &program, arguments, dir)
}

/// Like [`windows_remote`], for a program whose path the PowerShell expression `program`
/// gives after the script lines `find` ran.
pub(crate) fn windows_start(
    find: &str,
    program: &str,
    arguments: &str,
    dir: Option<&str>,
) -> String {
    let working_directory = dir
        .map(|dir| format!("$info.WorkingDirectory = {}\n", powershell_quote(dir)))
        .unwrap_or_default();
    let script = format!(
        "$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:GIT_TERMINAL_PROMPT = '0'
{find}$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = {program}
$info.Arguments = {arguments}
{working_directory}$info.UseShellExecute = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($info)
$process.StandardInput.Close()
$out = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
$err = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
$process.WaitForExit()
$out.Wait()
$err.Wait()
exit $process.ExitCode
",
        arguments = powershell_quote(arguments),
    );
    powershell_command(&script)
}

/// A command line that runs the PowerShell `script`, passed as base64 of its UTF-16 text so
/// that no shell on the way changes it.
pub(crate) fn powershell_command(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(utf16)
    )
}

/// `ssh` running `remote` on `machine` without prompting for passwords or host keys.
pub(super) fn ssh_invocation(machine: &MachineLabel, remote: String) -> Invocation {
    Invocation {
        program: "ssh",
        args: vec![
            "-o".to_owned(),
            "BatchMode=yes".to_owned(),
            "--".to_owned(),
            machine.as_str().to_owned(),
            remote,
        ],
    }
}

pub struct Git {
    runner: Box<dyn Runner>,
}

impl Git {
    pub fn new(runner: Box<dyn Runner>) -> Self {
        Self { runner }
    }

    /// Clones `url` into the location's path, which must not exist or be empty.
    pub fn clone_repository(&self, url: &str, target: &WorkspaceLocation) -> Result<(), GitError> {
        let path = location_path(target);
        self.run(target, None, &["clone", "--", url, path])?;
        Ok(())
    }

    /// Makes the location's path, a plain folder or one that does not exist yet, a git
    /// repository whose first branch is `branch`. Running it on a repository leaves its
    /// history and branches alone.
    pub fn init_repository(
        &self,
        target: &WorkspaceLocation,
        branch: &str,
    ) -> Result<(), GitError> {
        let initial_branch = format!("--initial-branch={branch}");
        self.run(
            target,
            None,
            &["init", "--quiet", &initial_branch, location_path(target)],
        )?;
        Ok(())
    }

    /// Returns the root of the repository that contains the location's path. Fails when
    /// the path is not inside a git repository.
    pub fn repository_root(
        &self,
        location: &WorkspaceLocation,
    ) -> Result<WorkspaceLocation, GitError> {
        let args = ["rev-parse", "--show-toplevel"];
        let output = self.run(location, Some(location_path(location)), &args)?;
        let root = output.trim();
        let unexpected = || GitError::UnexpectedOutput {
            command: format!("git {}", args.join(" ")),
            output: root.to_owned(),
        };
        Ok(match location {
            WorkspaceLocation::Local { path } => WorkspaceLocation::Local {
                path: path.parse_like(root).map_err(|_| unexpected())?,
            },
            WorkspaceLocation::Ssh { machine, path } => WorkspaceLocation::Ssh {
                machine: machine.clone(),
                path: path.parse_like(root).map_err(|_| unexpected())?,
            },
        })
    }

    /// Returns the branch `origin/HEAD` points to, or else the checked-out branch.
    /// Returns `None` when neither exists, e.g. without a remote on a detached HEAD.
    pub fn default_branch(&self, repo: &WorkspaceLocation) -> Result<Option<String>, GitError> {
        let path = Some(location_path(repo));
        let symbolic_ref =
            |name| self.run(repo, path, &["symbolic-ref", "--quiet", "--short", name]);
        let branch = match symbolic_ref("refs/remotes/origin/HEAD") {
            Ok(remote_head) => {
                let remote_head = remote_head.trim();
                remote_head
                    .strip_prefix("origin/")
                    .unwrap_or(remote_head)
                    .to_owned()
            }
            Err(GitError::Failed { .. }) => match symbolic_ref("HEAD") {
                Ok(head) => head.trim().to_owned(),
                Err(GitError::Failed { .. }) => return Ok(None),
                Err(error) => return Err(error),
            },
            Err(error) => return Err(error),
        };
        Ok(Some(branch).filter(|branch| !branch.is_empty()))
    }

    /// Gives an empty repository, one without any commit, its first commit on `branch` so
    /// worktrees can branch off it, and pushes it to `origin` when that remote exists.
    /// The commit is empty: files the user staged stay staged. Returns whether it
    /// committed; a repository that already has commits is left alone.
    pub fn create_initial_commit(
        &self,
        repo: &WorkspaceLocation,
        branch: &str,
    ) -> Result<bool, GitError> {
        let path = Some(location_path(repo));
        let local_branch = format!("refs/heads/{branch}");
        for revision in [local_branch.as_str(), "HEAD"] {
            match self.run(repo, path, &["rev-parse", "--verify", "--quiet", revision]) {
                Ok(_) => return Ok(false),
                Err(GitError::Failed { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        let has_origin = self
            .run(repo, path, &["remote"])?
            .lines()
            .any(|remote| remote.trim() == "origin");
        self.run(repo, path, &["symbolic-ref", "HEAD", &local_branch])?;
        self.run(
            repo,
            path,
            &["commit", "--allow-empty", "--only", "-m", "Initial commit"],
        )?;
        if has_origin {
            self.run(repo, path, &["push", "--set-upstream", "origin", branch])?;
        }
        Ok(true)
    }

    /// Where a worktree for the existing `branch` can be checked out from: the branch
    /// itself while the repository still has it, else its `origin/<branch>` remote-tracking
    /// branch. `None` when neither exists.
    pub fn branch_source(
        &self,
        repo: &WorkspaceLocation,
        branch: &str,
    ) -> Result<Option<String>, GitError> {
        let path = Some(location_path(repo));
        let remote = format!("origin/{branch}");
        for (reference, source) in [
            (format!("refs/heads/{branch}"), branch),
            (format!("refs/remotes/{remote}"), remote.as_str()),
        ] {
            match self.run(
                repo,
                path,
                &["rev-parse", "--verify", "--quiet", &reference],
            ) {
                Ok(_) => return Ok(Some(source.to_owned())),
                Err(GitError::Failed { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }

    /// Where a new task branch should start: `origin/<base>` right after fetching it, so
    /// the branch contains everything merged into the base even when the local base is
    /// behind. Only `origin/*` references are updated; the local base and its working copy
    /// are left alone. A repository without `origin`, or whose `origin` has no `base`,
    /// starts from the local `base`; so does a failed fetch, which is reported together
    /// with the local base's commit. Ref-lock contention is retried up to three total
    /// fetch attempts before falling back.
    pub fn task_branch_start(
        &self,
        repo: &WorkspaceLocation,
        base: &str,
    ) -> Result<BranchStart, GitError> {
        let path = Some(location_path(repo));
        let local = || BranchStart {
            start: base.to_owned(),
            fetch_failure: None,
        };
        if !self.has_origin(repo)? {
            return Ok(local());
        }
        let mut retries = 0;
        let fetch_error = loop {
            match self.run(repo, path, &["fetch", "--quiet", "origin", base]) {
                Ok(_) => break None,
                Err(GitError::Failed { stderr, .. })
                    if retries < 2
                        && (stderr.contains("cannot lock ref")
                            || (stderr.contains("fetching ref ")
                                && (stderr.contains("failed: reference already exists")
                                    || stderr
                                        .contains("failed: incorrect old value provided")))) =>
                {
                    retries += 1;
                }
                Err(error @ GitError::Failed { .. }) => break Some(error),
                Err(error) => return Err(error),
            }
        };
        let Some(fetch_error) = fetch_error else {
            let remote_base = format!("refs/remotes/origin/{base}");
            return match self.run(
                repo,
                path,
                &["rev-parse", "--verify", "--quiet", &remote_base],
            ) {
                Ok(_) => Ok(BranchStart {
                    start: format!("origin/{base}"),
                    fetch_failure: None,
                }),
                // A fetch refspec that does not map to `origin/*`.
                Err(GitError::Failed { .. }) => Ok(local()),
                Err(error) => Err(error),
            };
        };
        // Fetching a branch `origin` does not have fails too; that is no failure to report.
        let remote_head = format!("refs/heads/{base}");
        if let Ok(heads) = self.run(
            repo,
            path,
            &["ls-remote", "--heads", "origin", &remote_head],
        ) && heads.trim().is_empty()
        {
            return Ok(local());
        }
        let local_base = format!("refs/heads/{base}");
        let commit = self.run(
            repo,
            path,
            &["rev-parse", "--short", "--verify", &local_base],
        )?;
        Ok(BranchStart {
            start: base.to_owned(),
            fetch_failure: Some(FetchFailure {
                commit: commit.trim().to_owned(),
                error: fetch_error.to_string(),
            }),
        })
    }

    /// Creates the task branch `branch` at `start` without an upstream, so pulling on it
    /// never pulls the base and a push cannot land on the base; its first push sets its own
    /// remote branch as upstream. An existing `branch` is left as it is. Returns whether
    /// the branch was created.
    pub fn create_task_branch(
        &self,
        repo: &WorkspaceLocation,
        branch: &str,
        start: &str,
    ) -> Result<bool, GitError> {
        let path = Some(location_path(repo));
        let reference = format!("refs/heads/{branch}");
        match self.run(
            repo,
            path,
            &["rev-parse", "--verify", "--quiet", &reference],
        ) {
            Ok(_) => return Ok(false),
            Err(GitError::Failed { .. }) => {}
            Err(error) => return Err(error),
        }
        self.run(repo, path, &["branch", "--no-track", branch, start])?;
        Ok(true)
    }

    /// Deletes the local `branch`, e.g. a task branch whose worktree could not be created.
    pub fn delete_branch(&self, repo: &WorkspaceLocation, branch: &str) -> Result<(), GitError> {
        self.run(repo, Some(location_path(repo)), &["branch", "-D", branch])?;
        Ok(())
    }

    /// Whether the repository still has a checkout at `path`. Git marks a registered
    /// worktree whose directory was deleted as prunable, even before it is pruned.
    pub fn worktree_exists(
        &self,
        repo: &WorkspaceLocation,
        path: &HostPath,
    ) -> Result<bool, GitError> {
        let output = self.run(
            repo,
            Some(location_path(repo)),
            &["worktree", "list", "--porcelain", "-z"],
        )?;
        let expected = path.to_string().replace('\\', "/");
        Ok(output.split("\0\0").any(|record| {
            let mut fields = record.split('\0');
            fields
                .next()
                .and_then(|field| field.strip_prefix("worktree "))
                .is_some_and(|listed| listed.replace('\\', "/") == expected)
                && !fields.any(|field| field == "prunable" || field.starts_with("prunable "))
        }))
    }

    /// Commits reachable from `branch` but not from `base`, oldest first, read in the
    /// repository or worktree at `dir` on the machine of `location`.
    pub fn commits_between(
        &self,
        location: &WorkspaceLocation,
        dir: &str,
        base: &str,
        branch: &str,
    ) -> Result<Vec<LoggedCommit>, GitError> {
        // A repository cloned without a local `base` only has `origin/<base>`.
        let mut range = format!("origin/{base}..{branch}");
        let args = ["log", "--reverse", LOG_FORMAT, &range, "--"];
        let output = match self.run(location, Some(dir), &args) {
            Err(GitError::Failed { .. }) => {
                range = format!("{base}..{branch}");
                let args = ["log", "--reverse", LOG_FORMAT, &range, "--"];
                self.run(location, Some(dir), &args)?
            }
            other => other?,
        };
        output
            .split(RECORD_SEPARATOR)
            .map(|record| record.trim_start_matches(['\r', '\n']))
            .filter(|record| !record.trim().is_empty())
            .map(|record| {
                parse_commit(record).ok_or_else(|| GitError::UnexpectedOutput {
                    command: format!("git log {range}"),
                    output: record.to_owned(),
                })
            })
            .collect()
    }

    /// `origin/<base>` when that remote-tracking branch exists in `dir`, else `<base>`, so a
    /// repository without a local base branch (e.g. a fresh clone) still resolves it.
    fn remote_tracking_or_local(
        &self,
        location: &WorkspaceLocation,
        dir: &str,
        base: &str,
    ) -> Result<String, GitError> {
        let remote_base = format!("refs/remotes/origin/{base}");
        match self.run(
            location,
            Some(dir),
            &["rev-parse", "--verify", "--quiet", &remote_base],
        ) {
            Ok(_) => Ok(format!("origin/{base}")),
            Err(GitError::Failed { .. }) => Ok(base.to_owned()),
            Err(error) => Err(error),
        }
    }

    /// How many commits of the base branch `branch` lacks, read in the repository or
    /// worktree at `dir`. The repository's `origin` is where prerequisites get merged, so its
    /// `base` is fetched first and counted against; a failed fetch (e.g. offline) counts
    /// against the last fetched state and reports the failure. `None` when the repository
    /// has no `origin`: there is no shared base to fall behind.
    pub fn commits_behind(
        &self,
        location: &WorkspaceLocation,
        dir: &str,
        base: &str,
        branch: &str,
    ) -> Result<Option<BehindBase>, GitError> {
        let has_origin = self
            .run(location, Some(dir), &["remote"])?
            .lines()
            .any(|remote| remote.trim() == "origin");
        if !has_origin {
            return Ok(None);
        }
        let mut fetch_error = None;
        match self.run(location, Some(dir), &["fetch", "--quiet", "origin", base]) {
            Ok(_) => {}
            Err(error @ GitError::Failed { .. }) => fetch_error = Some(error.to_string()),
            Err(error) => return Err(error),
        }
        let base_ref = self.remote_tracking_or_local(location, dir, base)?;
        let range = format!("{branch}..{base_ref}");
        let output = self.run(location, Some(dir), &["rev-list", "--count", &range, "--"])?;
        let behind = output
            .trim()
            .parse()
            .map_err(|_| GitError::UnexpectedOutput {
                command: format!("git rev-list --count {range}"),
                output: output.clone(),
            })?;
        Ok(Some(BehindBase {
            base: base_ref,
            behind,
            fetch_error,
        }))
    }

    /// Pushes `branch` to `origin` and makes it the upstream of the local branch.
    pub fn push_branch(
        &self,
        location: &WorkspaceLocation,
        dir: &str,
        branch: &str,
    ) -> Result<(), GitError> {
        self.run(
            location,
            Some(dir),
            &["push", "--set-upstream", "origin", branch],
        )?;
        Ok(())
    }

    /// URL of the `origin` remote of the repository at `dir`.
    pub fn origin_url(&self, location: &WorkspaceLocation, dir: &str) -> Result<String, GitError> {
        let output = self.run(location, Some(dir), &["remote", "get-url", "origin"])?;
        let url = output.trim();
        if url.is_empty() {
            return Err(GitError::UnexpectedOutput {
                command: "git remote get-url origin".to_owned(),
                output: output.clone(),
            });
        }
        Ok(url.to_owned())
    }

    /// Branch names of the repository: its local branches and those of `origin`, sorted
    /// and without duplicates, after fetching `origin` with pruning so the list matches the
    /// remote. A failed fetch (e.g. offline) still lists the branches known locally and
    /// reports the failure.
    pub fn list_branches(&self, repo: &WorkspaceLocation) -> Result<BranchList, GitError> {
        let path = Some(location_path(repo));
        let fetch_error = if self.has_origin(repo)? {
            match self.run(repo, path, &["fetch", "--prune", "--quiet", "origin"]) {
                Ok(_) => None,
                Err(error @ GitError::Failed { .. }) => Some(error.to_string()),
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let output = self.run(
            repo,
            path,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads",
                "refs/remotes/origin",
            ],
        )?;
        let names: BTreeSet<String> = output
            .lines()
            .map(str::trim)
            .filter_map(|reference| {
                reference
                    .strip_prefix("refs/heads/")
                    .or_else(|| reference.strip_prefix("refs/remotes/origin/"))
            })
            .filter(|name| !name.is_empty() && *name != "HEAD")
            .map(str::to_owned)
            .collect();
        Ok(BranchList {
            names: names.into_iter().collect(),
            fetch_error,
        })
    }

    /// Whether git accepts `name` as a branch name (`git check-ref-format --branch`).
    pub fn is_valid_branch_name(
        &self,
        repo: &WorkspaceLocation,
        name: &str,
    ) -> Result<bool, GitError> {
        if name.is_empty() || name.starts_with('-') {
            return Ok(false);
        }
        let path = Some(location_path(repo));
        match self.run(repo, path, &["check-ref-format", "--branch", name]) {
            Ok(_) => Ok(true),
            Err(GitError::Failed { .. }) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Creates branch `name` at `start` (a branch or `origin/<branch>`) without tracking
    /// it, and pushes it to `origin` when that remote exists so pull requests can target
    /// it. When the push fails, the new local branch is deleted again so a retry starts
    /// clean.
    pub fn create_branch(
        &self,
        repo: &WorkspaceLocation,
        name: &str,
        start: &str,
    ) -> Result<(), GitError> {
        let path = location_path(repo);
        self.run(repo, Some(path), &["branch", "--no-track", name, start])?;
        if self.has_origin(repo)?
            && let Err(error) = self.push_branch(repo, path, name)
        {
            // The push error is what the user needs; a failed cleanup leaves only a
            // local branch behind, which the next attempt reports as existing.
            let _ = self.run(repo, Some(path), &["branch", "-D", name]);
            return Err(error);
        }
        Ok(())
    }

    /// The commit `revision` points to in the repository of `repo`.
    pub fn commit_of(&self, repo: &WorkspaceLocation, revision: &str) -> Result<String, GitError> {
        let spec = format!("{revision}^{{commit}}");
        let output = self.run(
            repo,
            Some(location_path(repo)),
            &["rev-parse", "--verify", "--quiet", &spec],
        )?;
        Ok(output.trim().to_owned())
    }

    /// Whether `branch` has been merged into the local `base` branch of the repository of
    /// `repo`, as merging it there without a remote does. `start` is the commit the branch
    /// started from: a branch that has no commits of its own since then is not merged
    /// work, even though `base` contains it. Without `start`, a branch that is ahead of
    /// `base` reports where it forked, which callers keep as its start.
    pub fn local_merge(
        &self,
        repo: &WorkspaceLocation,
        branch: &str,
        base: &str,
        start: Option<&str>,
    ) -> Result<LocalMerge, GitError> {
        let path = Some(location_path(repo));
        let local_branch = format!("refs/heads/{branch}");
        match self.run(
            repo,
            path,
            &["rev-parse", "--verify", "--quiet", &local_branch],
        ) {
            Ok(_) => {}
            Err(GitError::Failed { .. }) => return Ok(LocalMerge::NoBranch),
            Err(error) => return Err(error),
        }
        let count = |range: &str| -> Result<u32, GitError> {
            let output = self.run(repo, path, &["rev-list", "--count", range])?;
            output
                .trim()
                .parse()
                .map_err(|_| GitError::UnexpectedOutput {
                    command: format!("git rev-list --count {range}"),
                    output: output.trim().to_owned(),
                })
        };
        let ahead = count(&format!("refs/heads/{base}..{local_branch}"))?;
        if ahead > 0 {
            let start = match start {
                Some(start) => start.to_owned(),
                None => self
                    .run(repo, path, &["merge-base", base, &local_branch])?
                    .trim()
                    .to_owned(),
            };
            return Ok(LocalMerge::NotMerged { ahead, start });
        }
        let Some(start) = start else {
            return Ok(LocalMerge::StartUnknown);
        };
        match count(&format!("{start}..{local_branch}"))? {
            0 => Ok(LocalMerge::NoCommits),
            commits => Ok(LocalMerge::Merged { commits }),
        }
    }

    /// Runs `command` with the shell of the machine that hosts `location` in the directory
    /// `dir` there: `cmd.exe` for Windows paths (on Windows hosts started through
    /// [`windows_remote`]), `sh` otherwise. Returns its standard
    /// output; a non-zero exit status is a [`GitError::Failed`] with its standard error.
    pub fn run_command(
        &self,
        location: &WorkspaceLocation,
        dir: &str,
        command: &str,
    ) -> Result<String, GitError> {
        let invocation = match location {
            WorkspaceLocation::Local {
                path: HostPath::Windows(_),
            } => Invocation {
                program: "cmd",
                args: vec![
                    "/D".to_owned(),
                    "/S".to_owned(),
                    "/C".to_owned(),
                    format!("cd /d \"{dir}\" && {command}"),
                ],
            },
            WorkspaceLocation::Local {
                path: HostPath::Posix(_),
            } => Invocation {
                program: "sh",
                args: vec![
                    "-c".to_owned(),
                    format!("cd {} && {command}", shell_quote(dir)),
                ],
            },
            WorkspaceLocation::Ssh {
                machine,
                path: HostPath::Windows(_),
            } => ssh_invocation(
                machine,
                windows_remote("cmd", &format!("/D /S /C \"{command}\""), Some(dir)),
            ),
            WorkspaceLocation::Ssh {
                machine,
                path: HostPath::Posix(_),
            } => ssh_invocation(machine, format!("cd {} && {command}", shell_quote(dir))),
        };
        self.runner.run(&invocation)
    }

    /// Fetches `url` with `curl` on this machine, following redirects, and returns the
    /// HTTP status of the final response; fails when no response arrives.
    pub fn fetch_url(&self, url: &str) -> Result<u16, GitError> {
        let output = self.runner.run(&Invocation {
            program: "curl",
            args: [
                "--silent",
                "--show-error",
                "--location",
                "--max-time",
                "30",
                "--output",
                "/dev/null",
                "--write-out",
                "%{http_code}",
                url,
            ]
            .map(str::to_owned)
            .to_vec(),
        })?;
        output
            .trim()
            .parse()
            .map_err(|_| GitError::UnexpectedOutput {
                command: format!("curl {url}"),
                output,
            })
    }

    /// Whether the repository of the workspace at `repo` has an `origin` remote.
    pub fn has_origin(&self, repo: &WorkspaceLocation) -> Result<bool, GitError> {
        Ok(self
            .run(repo, Some(location_path(repo)), &["remote"])?
            .lines()
            .any(|remote| remote.trim() == "origin"))
    }

    /// Runs `git [-C <dir>] <args>` on the machine that hosts `location`.
    fn run(
        &self,
        location: &WorkspaceLocation,
        dir: Option<&str>,
        args: &[&str],
    ) -> Result<String, GitError> {
        let mut git_args: Vec<&str> = Vec::new();
        if let Some(dir) = dir {
            git_args.extend(["-C", dir]);
        }
        git_args.extend(args);
        let invocation = match location {
            WorkspaceLocation::Local { .. } => Invocation {
                program: "git",
                args: git_args.iter().map(|arg| (*arg).to_owned()).collect(),
            },
            WorkspaceLocation::Ssh {
                machine,
                path: HostPath::Windows(_),
            } => {
                let arguments = git_args
                    .iter()
                    .map(|arg| windows_quote(arg))
                    .collect::<Vec<_>>()
                    .join(" ");
                ssh_invocation(machine, windows_remote("git", &arguments, None))
            }
            WorkspaceLocation::Ssh {
                machine,
                path: HostPath::Posix(_),
            } => {
                let remote = std::iter::once("git".to_owned())
                    .chain(git_args.iter().map(|arg| shell_quote(arg)))
                    .collect::<Vec<_>>()
                    .join(" ");
                ssh_invocation(machine, remote)
            }
        };
        self.runner.run(&invocation)
    }
}

/// Branches listed by [`Git::list_branches`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchList {
    /// Local and `origin` branch names, sorted, without `origin/` prefixes.
    pub names: Vec<String>,
    /// Why fetching `origin` failed, when it did.
    pub fetch_error: Option<String>,
}

/// What [`Git::local_merge`] found about a task branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalMerge {
    /// The repository has no such branch.
    NoBranch,
    /// The branch has `ahead` commits the base does not contain; it started at `start`.
    NotMerged { ahead: u32, start: String },
    /// The base contains the branch, which has `commits` commits since its start.
    Merged { commits: u32 },
    /// The base contains the branch, which has no commits since its start.
    NoCommits,
    /// The base contains the branch, but where the branch started is not known, so
    /// whether it had commits of its own is not either.
    StartUnknown,
}

/// Where [`Git::task_branch_start`] starts a new task branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchStart {
    /// `origin/<base>` after a successful fetch, else the local `<base>`.
    pub start: String,
    /// Why fetching `origin` failed, when the branch starts from the local base because
    /// of it.
    pub fetch_failure: Option<FetchFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchFailure {
    /// Abbreviated commit of the local base the branch starts from.
    pub commit: String,
    pub error: String,
}

/// How far a branch is behind its base, as counted by [`Git::commits_behind`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BehindBase {
    /// The revision counted against: `origin/<base>` when it exists, else `<base>`.
    pub base: String,
    /// Commits on the base that the branch does not contain.
    pub behind: u32,
    /// Why fetching `origin` failed; the count is then against the last fetched base.
    pub fetch_error: Option<String>,
}

/// A commit as printed by [`Git::commits_between`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoggedCommit {
    pub sha: String,
    /// Subject and body.
    pub message: String,
    /// `Name <email>` of the author.
    pub author: String,
    /// Committer timestamp in seconds since the Unix epoch.
    pub committed_at: i64,
}

// Fields are separated by US (0x1f) and commits by RS (0x1e), which cannot appear in
// the fields themselves.
const LOG_FORMAT: &str = "--format=%H%x1f%an <%ae>%x1f%ct%x1f%B%x1e";
const FIELD_SEPARATOR: char = '\u{1f}';
const RECORD_SEPARATOR: char = '\u{1e}';

fn parse_commit(record: &str) -> Option<LoggedCommit> {
    let mut fields = record.splitn(4, FIELD_SEPARATOR);
    let sha = fields.next()?.trim();
    let author = fields.next()?;
    let committed_at = fields.next()?.trim().parse().ok()?;
    let message = fields.next()?.trim_end();
    if sha.len() < 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(LoggedCommit {
        sha: sha.to_owned(),
        message: message.to_owned(),
        author: author.to_owned(),
        committed_at,
    })
}

fn location_path(location: &WorkspaceLocation) -> &str {
    match location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    }
}

#[cfg(test)]
pub mod fake {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;

    /// Returns scripted results in order and records every invocation.
    #[derive(Default)]
    pub struct FakeRunner {
        pub results: Mutex<VecDeque<Result<String, GitError>>>,
        pub invocations: Mutex<Vec<Invocation>>,
    }

    impl FakeRunner {
        pub fn new(results: impl IntoIterator<Item = Result<String, GitError>>) -> Self {
            Self {
                results: Mutex::new(results.into_iter().collect()),
                invocations: Mutex::default(),
            }
        }
    }

    impl Runner for std::sync::Arc<FakeRunner> {
        fn run(&self, invocation: &Invocation) -> Result<String, GitError> {
            self.invocations.lock().unwrap().push(invocation.clone());
            self.results
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected git invocation")
        }
    }

    pub fn failed() -> GitError {
        GitError::Failed {
            command: "git".to_owned(),
            stderr: "fatal".to_owned(),
        }
    }

    /// The script of a command made by [`powershell_command`].
    pub fn decode_powershell(command: &str) -> String {
        let encoded = command
            .strip_prefix(
                "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass \
                 -EncodedCommand ",
            )
            .expect("a PowerShell command");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::fake::{FakeRunner, failed};
    use super::*;
    use crate::domain::path::WindowsPath;

    fn git(results: Vec<Result<String, GitError>>) -> (Git, Arc<FakeRunner>) {
        let runner = Arc::new(FakeRunner::new(results));
        (Git::new(Box::new(runner.clone())), runner)
    }

    fn local(path: &str) -> WorkspaceLocation {
        WorkspaceLocation::Local {
            path: WindowsPath::parse(path).unwrap().into(),
        }
    }

    fn remote(path: &str) -> WorkspaceLocation {
        WorkspaceLocation::Ssh {
            machine: MachineLabel::parse("devbox").unwrap(),
            path: HostPath::parse(path).unwrap(),
        }
    }

    #[test]
    fn worktree_presence_distinguishes_existing_prunable_and_unregistered_paths() {
        let path = HostPath::parse(r"D:\wt\some task").unwrap();
        for (listing, expected) in [
            ("worktree D:/wt/some task\0HEAD abc\0\0", true),
            (
                "worktree D:/wt/some task\0HEAD abc\0prunable gitdir file points to non-existent location\0\0",
                false,
            ),
            ("worktree C:/repo\0HEAD abc\0\0", false),
            ("", false),
        ] {
            let (git, runner) = git(vec![Ok(listing.to_owned())]);
            assert_eq!(
                git.worktree_exists(&local(r"C:\repo"), &path).unwrap(),
                expected
            );
            assert_eq!(
                runner.invocations.lock().unwrap()[0].args,
                ["-C", r"C:\repo", "worktree", "list", "--porcelain", "-z"]
            );
        }
    }

    #[test]
    fn worktree_presence_uses_the_ssh_repository_and_preserves_lookup_errors() {
        let repo = remote("/srv/repo");
        let path = HostPath::parse("/wt/some\n task").unwrap();
        let (git, runner) = git(vec![
            Ok("worktree /wt/some\n task\0HEAD abc\0\0".to_owned()),
            Err(failed()),
        ]);

        assert!(git.worktree_exists(&repo, &path).unwrap());
        assert!(git.worktree_exists(&repo, &path).is_err());
        let calls = runner.invocations.lock().unwrap();
        assert_eq!(calls[0].program, "ssh");
        assert_eq!(calls[0].args[3], "devbox");
        assert_eq!(
            calls[0].args[4],
            "git '-C' '/srv/repo' 'worktree' 'list' '--porcelain' '-z'"
        );
    }

    /// The PowerShell script the only invocation ran over `ssh devbox`.
    fn remote_script(runner: &FakeRunner) -> String {
        let invocations = runner.invocations.lock().unwrap();
        assert_eq!(invocations.len(), 1);
        assert_eq!(invocations[0].program, "ssh");
        assert_eq!(
            invocations[0].args[..4],
            ["-o", "BatchMode=yes", "--", "devbox"]
        );
        fake::decode_powershell(&invocations[0].args[4])
    }

    #[test]
    fn windows_quote_follows_the_command_line_rules_of_windows_programs() {
        for (word, quoted) in [
            ("plain", "plain"),
            (r"C:\dev\a", r"C:\dev\a"),
            ("", r#""""#),
            ("two words", r#""two words""#),
            (r#"say "hi""#, r#""say \"hi\"""#),
            (r#"a\"b"#, r#""a\\\"b""#),
            (r"C:\a b\", r#""C:\a b\\""#),
            (r"C:\a\", r"C:\a\"),
            ("line\nbreak", "\"line\nbreak\""),
            ("%H%x1f%an <%ae>", "\"%H%x1f%an <%ae>\""),
        ] {
            assert_eq!(windows_quote(word), quoted, "{word:?}");
        }
    }

    #[test]
    fn powershell_quote_doubles_every_single_quote_powershell_knows() {
        assert_eq!(powershell_quote("it's"), "'it''s'");
        assert_eq!(
            powershell_quote("\u{2018}a\u{2019} \u{201a}b\u{201b} \"$x\""),
            "'\u{2018}\u{2018}a\u{2019}\u{2019} \u{201a}\u{201a}b\u{201b}\u{201b} \"$x\"'"
        );
    }

    #[test]
    fn git_on_a_windows_host_runs_through_encoded_powershell() {
        let (git, runner) = git(vec![Ok(String::new())]);
        git.clone_repository("git@host:o/a.git", &remote(r"D:\dev\it's here"))
            .unwrap();
        let invocation = runner.invocations.lock().unwrap()[0].args[4].clone();
        // Nothing a cmd.exe or PowerShell login shell would interpret.
        assert!(
            invocation
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " -+/=".contains(c)),
            "{invocation}"
        );
        let script = remote_script(&runner);
        assert!(
            script.contains(
                "$info.FileName = (Get-Command -Name 'git' -CommandType Application -TotalCount 1).Path\n"
            ),
            "{script}"
        );
        assert!(
            script.contains(
                "$info.Arguments = 'clone -- git@host:o/a.git \"D:\\dev\\it''s here\"'\n"
            ),
            "{script}"
        );
        assert!(!script.contains("WorkingDirectory"), "{script}");
        assert!(script.ends_with("exit $process.ExitCode\n"), "{script}");
    }

    #[test]
    fn repository_root_on_a_windows_host_is_a_windows_path() {
        let (git, runner) = git(vec![Ok("D:/dev/a\r\n".to_owned())]);
        assert_eq!(
            git.repository_root(&remote(r"D:\dev\a\src")).unwrap(),
            remote(r"D:\dev\a")
        );
        assert!(
            remote_script(&runner)
                .contains(r"$info.Arguments = '-C D:\dev\a\src rev-parse --show-toplevel'")
        );
    }

    #[test]
    fn commands_on_a_windows_host_run_in_cmd_in_the_directory() {
        let (git, runner) = git(vec![Ok("ok\n".to_owned())]);
        git.run_command(&remote(r"\\nas\src\a"), r"\\nas\wt\it's", "npm test")
            .unwrap();
        let script = remote_script(&runner);
        assert!(script.contains("-Name 'cmd' "), "{script}");
        assert!(
            script.contains("$info.Arguments = '/D /S /C \"npm test\"'\n"),
            "{script}"
        );
        assert!(
            script.contains(r"$info.WorkingDirectory = '\\nas\wt\it''s'"),
            "{script}"
        );
    }

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    fn ref_lock_failure(attempt: usize) -> GitError {
        GitError::Failed {
            command: "git fetch --quiet origin main".to_owned(),
            stderr: format!(
                "error: cannot lock ref 'refs/remotes/origin/main': \
                 is at commit-{attempt} but expected old-commit"
            ),
        }
    }

    #[test]
    fn task_branch_start_retries_ref_lock_failures_before_using_origin() {
        for failures in [1, 2] {
            let results = std::iter::once(Ok("origin\n".to_owned()))
                .chain((1..=failures).map(|attempt| Err(ref_lock_failure(attempt))))
                .chain([Ok(String::new()), Ok("remote-sha\n".to_owned())])
                .collect();
            let (git, runner) = git(results);

            let start = git.task_branch_start(&local(r"C:\dev\a"), "main").unwrap();

            assert_eq!(start.start, "origin/main");
            assert_eq!(start.fetch_failure, None);
            assert_eq!(
                git_commands(&runner),
                std::iter::once(args(&["remote"]))
                    .chain(std::iter::repeat_n(
                        args(&["fetch", "--quiet", "origin", "main"]),
                        failures + 1
                    ))
                    .chain([args(&[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        "refs/remotes/origin/main"
                    ])])
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn task_branch_start_falls_back_after_three_ref_lock_failures() {
        let (git, runner) = git(vec![
            Ok("origin\n".to_owned()),
            Err(ref_lock_failure(1)),
            Err(ref_lock_failure(2)),
            Err(ref_lock_failure(3)),
            Ok("remote-sha\trefs/heads/main\n".to_owned()),
            Ok("local-sha\n".to_owned()),
        ]);

        let start = git.task_branch_start(&local(r"C:\dev\a"), "main").unwrap();

        assert_eq!(start.start, "main");
        assert_eq!(
            start.fetch_failure,
            Some(FetchFailure {
                commit: "local-sha".to_owned(),
                error: ref_lock_failure(3).to_string(),
            })
        );
        assert_eq!(git_commands(&runner).len(), 6);
    }

    #[test]
    fn task_branch_start_retries_rejected_fetch_ref_updates() {
        for reason in ["reference already exists", "incorrect old value provided"] {
            let (git, _) = git(vec![
                Ok("origin\n".to_owned()),
                Err(GitError::Failed {
                    command: "git fetch --quiet origin main".to_owned(),
                    stderr: format!(
                        "error: fetching ref refs/remotes/origin/main failed: {reason}"
                    ),
                }),
                Ok(String::new()),
                Ok("remote-sha\n".to_owned()),
            ]);

            let start = git.task_branch_start(&local(r"C:\dev\a"), "main").unwrap();

            assert_eq!(start.start, "origin/main", "{reason}");
            assert_eq!(start.fetch_failure, None);
        }
    }

    #[test]
    fn task_branch_start_does_not_retry_spawn_failures() {
        let spawn = GitError::Spawn {
            program: "git".to_owned(),
            message: "cannot lock ref executable not found".to_owned(),
        };
        let (git, runner) = git(vec![Ok("origin\n".to_owned()), Err(spawn.clone())]);

        let error = git
            .task_branch_start(&local(r"C:\dev\a"), "main")
            .unwrap_err();

        assert_eq!(error, spawn);
        assert_eq!(git_commands(&runner).len(), 2);
    }

    #[test]
    fn local_clone_runs_git_directly() {
        let (git, runner) = git(vec![Ok(String::new())]);
        git.clone_repository("https://example.com/a.git", &local(r"C:\dev\a"))
            .unwrap();
        assert_eq!(
            runner.invocations.lock().unwrap()[0],
            Invocation {
                program: "git",
                args: args(&["clone", "--", "https://example.com/a.git", r"C:\dev\a"]),
            }
        );
    }

    #[test]
    fn remote_clone_quotes_the_remote_command() {
        let (git, runner) = git(vec![Ok(String::new())]);
        git.clone_repository("git@host:o/a.git", &remote("/srv/it's"))
            .unwrap();
        assert_eq!(
            runner.invocations.lock().unwrap()[0],
            Invocation {
                program: "ssh",
                args: args(&[
                    "-o",
                    "BatchMode=yes",
                    "--",
                    "devbox",
                    r"git 'clone' '--' 'git@host:o/a.git' '/srv/it'\''s'",
                ]),
            }
        );
    }

    #[test]
    fn repository_root_is_parsed_for_the_machine() {
        let (git, runner) = git(vec![Ok("C:/dev/a\n".to_owned()), Ok("/srv/a\n".to_owned())]);
        assert_eq!(
            git.repository_root(&local(r"C:\dev\a\src")).unwrap(),
            local(r"C:\dev\a")
        );
        assert_eq!(
            git.repository_root(&remote("/srv/a/src")).unwrap(),
            remote("/srv/a")
        );
        assert_eq!(
            runner.invocations.lock().unwrap()[0].args,
            args(&["-C", r"C:\dev\a\src", "rev-parse", "--show-toplevel"])
        );
    }

    #[test]
    fn repository_root_rejects_unparseable_output() {
        let (git, _) = git(vec![Ok("/c/dev/a\n".to_owned())]);
        assert!(matches!(
            git.repository_root(&local(r"C:\dev\a")),
            Err(GitError::UnexpectedOutput { .. })
        ));
    }

    #[test]
    fn default_branch_prefers_origin_head() {
        let (git, _) = git(vec![Ok("origin/develop\n".to_owned())]);
        assert_eq!(
            git.default_branch(&local(r"C:\dev\a")).unwrap(),
            Some("develop".to_owned())
        );
    }

    #[test]
    fn default_branch_falls_back_to_the_checked_out_branch() {
        let (git, runner) = git(vec![Err(failed()), Ok("main\n".to_owned())]);
        assert_eq!(
            git.default_branch(&local(r"C:\dev\a")).unwrap(),
            Some("main".to_owned())
        );
        assert_eq!(
            runner.invocations.lock().unwrap()[1].args,
            args(&[
                "-C",
                r"C:\dev\a",
                "symbolic-ref",
                "--quiet",
                "--short",
                "HEAD"
            ])
        );
    }

    #[test]
    fn default_branch_is_none_on_a_detached_head_without_remote() {
        let (git, _) = git(vec![Err(failed()), Err(failed())]);
        assert_eq!(git.default_branch(&local(r"C:\dev\a")).unwrap(), None);
    }

    #[test]
    fn default_branch_reports_spawn_failures() {
        let spawn = GitError::Spawn {
            program: "git".to_owned(),
            message: "not found".to_owned(),
        };
        let (git, _) = git(vec![Err(spawn.clone())]);
        assert_eq!(git.default_branch(&local(r"C:\dev\a")), Err(spawn));
    }

    #[test]
    fn an_empty_repository_gets_an_initial_commit_pushed_to_origin() {
        let (git, runner) = git(vec![
            Err(failed()),
            Err(failed()),
            Ok("origin\n".to_owned()),
            Ok(String::new()),
            Ok(String::new()),
            Ok(String::new()),
        ]);
        assert!(
            git.create_initial_commit(&local(r"C:\dev\a"), "main")
                .unwrap()
        );
        let commands: Vec<Vec<String>> = runner
            .invocations
            .lock()
            .unwrap()
            .iter()
            .map(|invocation| invocation.args[2..].to_vec())
            .collect();
        assert_eq!(
            commands,
            [
                args(&["rev-parse", "--verify", "--quiet", "refs/heads/main"]),
                args(&["rev-parse", "--verify", "--quiet", "HEAD"]),
                args(&["remote"]),
                args(&["symbolic-ref", "HEAD", "refs/heads/main"]),
                args(&["commit", "--allow-empty", "--only", "-m", "Initial commit"]),
                args(&["push", "--set-upstream", "origin", "main"]),
            ]
        );
    }

    #[test]
    fn an_empty_repository_without_origin_is_only_committed_to() {
        let (git, runner) = git(vec![
            Err(failed()),
            Err(failed()),
            Ok("upstream\n".to_owned()),
            Ok(String::new()),
            Ok(String::new()),
        ]);
        assert!(
            git.create_initial_commit(&remote("/srv/a"), "main")
                .unwrap()
        );
        assert_eq!(runner.invocations.lock().unwrap().len(), 5);
    }

    #[test]
    fn a_repository_with_commits_is_left_alone() {
        let (git, runner) = git(vec![
            Ok("abc\n".to_owned()),
            Err(failed()),
            Ok("def\n".to_owned()),
        ]);
        let repo = local(r"C:\dev\a");
        assert!(!git.create_initial_commit(&repo, "main").unwrap());
        assert!(!git.create_initial_commit(&repo, "develop").unwrap());
        assert_eq!(runner.invocations.lock().unwrap().len(), 3);
    }

    #[test]
    fn branch_source_prefers_the_local_branch_then_origin() {
        let (git, runner) = git(vec![
            Ok("abc\n".to_owned()),
            Err(failed()),
            Ok("abc\n".to_owned()),
            Err(failed()),
            Err(failed()),
        ]);
        let repo = local(r"C:\dev\a");
        assert_eq!(
            git.branch_source(&repo, "feat/x-1").unwrap().as_deref(),
            Some("feat/x-1")
        );
        assert_eq!(
            git.branch_source(&repo, "feat/x-1").unwrap().as_deref(),
            Some("origin/feat/x-1")
        );
        assert_eq!(git.branch_source(&repo, "feat/x-1").unwrap(), None);
        let references: Vec<String> = runner
            .invocations
            .lock()
            .unwrap()
            .iter()
            .map(|invocation| invocation.args.last().unwrap().clone())
            .collect();
        assert_eq!(
            references,
            [
                "refs/heads/feat/x-1",
                "refs/heads/feat/x-1",
                "refs/remotes/origin/feat/x-1",
                "refs/heads/feat/x-1",
                "refs/remotes/origin/feat/x-1",
            ]
        );
    }

    const SHA_A: &str = "1111111111111111111111111111111111111111";
    const SHA_B: &str = "2222222222222222222222222222222222222222";

    #[test]
    fn commits_between_parses_log_records_oldest_first() {
        let log = format!(
            "{SHA_A}\u{1f}Ada <ada@example.com>\u{1f}1700000000\u{1f}Add login\n\nWith a body\n\u{1e}\n\
             {SHA_B}\u{1f}Bob <bob@example.com>\u{1f}1700000100\u{1f}Fix login\n\u{1e}\n"
        );
        let (git, runner) = git(vec![Ok(log)]);
        let commits = git
            .commits_between(&local(r"C:\dev\a"), r"D:\wt\a\feat-x-1", "main", "feat/x-1")
            .unwrap();
        assert_eq!(
            commits,
            vec![
                LoggedCommit {
                    sha: SHA_A.to_owned(),
                    message: "Add login\n\nWith a body".to_owned(),
                    author: "Ada <ada@example.com>".to_owned(),
                    committed_at: 1_700_000_000,
                },
                LoggedCommit {
                    sha: SHA_B.to_owned(),
                    message: "Fix login".to_owned(),
                    author: "Bob <bob@example.com>".to_owned(),
                    committed_at: 1_700_000_100,
                },
            ]
        );
        assert_eq!(
            runner.invocations.lock().unwrap()[0].args,
            args(&[
                "-C",
                r"D:\wt\a\feat-x-1",
                "log",
                "--reverse",
                "--format=%H%x1f%an <%ae>%x1f%ct%x1f%B%x1e",
                "origin/main..feat/x-1",
                "--",
            ])
        );
    }

    #[test]
    fn commits_between_falls_back_to_the_local_base_without_origin_tracking_branch() {
        let (git, runner) = git(vec![Err(failed()), Ok(String::new())]);
        git.commits_between(&local(r"C:\dev\a"), r"D:\wt\a", "main", "feat/x-1")
            .unwrap();
        assert_eq!(
            git_commands(&runner),
            [
                args(&[
                    "log",
                    "--reverse",
                    LOG_FORMAT,
                    "origin/main..feat/x-1",
                    "--"
                ]),
                args(&["log", "--reverse", LOG_FORMAT, "main..feat/x-1", "--"]),
            ]
        );
    }

    #[test]
    fn commits_between_is_empty_without_new_commits_and_rejects_garbage() {
        let (git, _) = git(vec![Ok(String::new()), Ok("not a log\n".to_owned())]);
        let location = local(r"C:\dev\a");
        assert_eq!(
            git.commits_between(&location, r"C:\dev\a", "main", "feat/x-1")
                .unwrap(),
            Vec::new()
        );
        assert!(matches!(
            git.commits_between(&location, r"C:\dev\a", "main", "feat/x-1"),
            Err(GitError::UnexpectedOutput { .. })
        ));
    }

    #[test]
    fn push_and_origin_url_run_in_the_given_directory_on_the_machine() {
        let (git, runner) = git(vec![
            Ok(String::new()),
            Ok("git@github.com:acme/a.git\n".to_owned()),
        ]);
        git.push_branch(&remote("/srv/a"), "/wt/a/feat-x-1", "feat/x-1")
            .unwrap();
        assert_eq!(
            git.origin_url(&remote("/srv/a"), "/wt/a/feat-x-1").unwrap(),
            "git@github.com:acme/a.git"
        );
        let invocations = runner.invocations.lock().unwrap();
        assert_eq!(
            invocations[0].args[4],
            "git '-C' '/wt/a/feat-x-1' 'push' '--set-upstream' 'origin' 'feat/x-1'"
        );
        assert_eq!(
            invocations[1].args[4],
            "git '-C' '/wt/a/feat-x-1' 'remote' 'get-url' 'origin'"
        );
    }

    fn git_commands(runner: &FakeRunner) -> Vec<Vec<String>> {
        runner
            .invocations
            .lock()
            .unwrap()
            .iter()
            .map(|invocation| invocation.args[2..].to_vec())
            .collect()
    }

    #[test]
    fn branches_are_fetched_and_merged_from_local_and_origin() {
        let (git, runner) = git(vec![
            Ok("origin\n".to_owned()),
            Ok(String::new()),
            Ok(
                "refs/heads/main\nrefs/heads/feat/x-1\nrefs/remotes/origin/HEAD\n\
                refs/remotes/origin/main\nrefs/remotes/origin/release\n"
                    .to_owned(),
            ),
        ]);
        assert_eq!(
            git.list_branches(&local(r"C:\dev\a")).unwrap(),
            BranchList {
                names: vec!["feat/x-1".into(), "main".into(), "release".into()],
                fetch_error: None,
            }
        );
        assert_eq!(
            git_commands(&runner),
            [
                args(&["remote"]),
                args(&["fetch", "--prune", "--quiet", "origin"]),
                args(&[
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/heads",
                    "refs/remotes/origin"
                ]),
            ]
        );
    }

    #[test]
    fn a_failed_fetch_still_lists_known_branches() {
        let (git, _) = git(vec![
            Ok("origin\n".to_owned()),
            Err(failed()),
            Ok("refs/heads/main\n".to_owned()),
        ]);
        let branches = git.list_branches(&remote("/srv/a")).unwrap();
        assert_eq!(branches.names, ["main"]);
        assert_eq!(branches.fetch_error, Some(failed().to_string()));
    }

    #[test]
    fn branches_without_origin_are_not_fetched() {
        let (git, runner) = git(vec![Ok(String::new()), Ok("refs/heads/main\n".to_owned())]);
        assert_eq!(
            git.list_branches(&local(r"C:\dev\a")).unwrap().names,
            ["main"]
        );
        assert_eq!(runner.invocations.lock().unwrap().len(), 2);
    }

    #[test]
    fn branch_names_are_checked_by_git() {
        let (git, runner) = git(vec![Ok("feat/x\n".to_owned()), Err(failed())]);
        let repo = local(r"C:\dev\a");
        assert!(git.is_valid_branch_name(&repo, "feat/x").unwrap());
        assert!(!git.is_valid_branch_name(&repo, "bad..name").unwrap());
        // Names git would read as options never reach it.
        assert!(!git.is_valid_branch_name(&repo, "-x").unwrap());
        assert!(!git.is_valid_branch_name(&repo, "").unwrap());
        assert_eq!(
            git_commands(&runner),
            [
                args(&["check-ref-format", "--branch", "feat/x"]),
                args(&["check-ref-format", "--branch", "bad..name"]),
            ]
        );
    }

    #[test]
    fn a_new_branch_is_created_without_tracking_and_pushed() {
        let (git, runner) = git(vec![
            Ok(String::new()),
            Ok("origin\n".to_owned()),
            Ok(String::new()),
        ]);
        git.create_branch(&local(r"C:\dev\a"), "release", "origin/main")
            .unwrap();
        let invocations = runner.invocations.lock().unwrap();
        assert_eq!(
            invocations[0].args[2..],
            args(&["branch", "--no-track", "release", "origin/main"])
        );
        assert_eq!(
            invocations[2].args[2..],
            args(&["push", "--set-upstream", "origin", "release"])
        );
    }

    #[test]
    fn a_failed_push_deletes_the_new_branch() {
        let (git, runner) = git(vec![
            Ok(String::new()),
            Ok("origin\n".to_owned()),
            Err(failed()),
            Ok(String::new()),
        ]);
        assert_eq!(
            git.create_branch(&remote("/srv/a"), "release", "main"),
            Err(failed())
        );
        assert_eq!(
            runner.invocations.lock().unwrap()[3].args[4],
            "git '-C' '/srv/a' 'branch' '-D' 'release'"
        );
    }

    #[test]
    fn a_new_branch_without_origin_is_only_created() {
        let (git, runner) = git(vec![Ok(String::new()), Ok(String::new())]);
        git.create_branch(&local(r"C:\dev\a"), "release", "main")
            .unwrap();
        assert_eq!(runner.invocations.lock().unwrap().len(), 2);
    }

    #[test]
    fn commits_behind_fetches_origin_and_counts_against_its_base() {
        let (git, runner) = git(vec![
            Ok("origin\n".to_owned()),
            Ok(String::new()),
            Ok("abc\n".to_owned()),
            Ok("3\n".to_owned()),
        ]);
        let behind = git
            .commits_behind(&local(r"C:\dev\a"), r"D:\wt\a", "main", "feat/x-1")
            .unwrap()
            .unwrap();
        assert_eq!(
            behind,
            BehindBase {
                base: "origin/main".to_owned(),
                behind: 3,
                fetch_error: None,
            }
        );
        let invocations = runner.invocations.lock().unwrap();
        assert_eq!(
            invocations[1].args,
            args(&["-C", r"D:\wt\a", "fetch", "--quiet", "origin", "main"])
        );
        assert_eq!(
            invocations[3].args,
            args(&[
                "-C",
                r"D:\wt\a",
                "rev-list",
                "--count",
                "feat/x-1..origin/main",
                "--"
            ])
        );
    }

    #[test]
    fn commits_behind_counts_against_the_last_fetched_base_when_the_fetch_fails() {
        let (git, _) = git(vec![
            Ok("origin\n".to_owned()),
            Err(failed()),
            Ok("abc\n".to_owned()),
            Ok("0\n".to_owned()),
        ]);
        let behind = git
            .commits_behind(&local(r"C:\dev\a"), r"D:\wt\a", "main", "feat/x-1")
            .unwrap()
            .unwrap();
        assert_eq!(behind.base, "origin/main");
        assert_eq!(behind.behind, 0);
        assert!(behind.fetch_error.is_some());
    }

    #[test]
    fn commits_behind_without_origin_reports_nothing() {
        let (git, runner) = git(vec![Ok("upstream\n".to_owned())]);
        let behind = git
            .commits_behind(&local(r"C:\dev\a"), r"D:\wt\a", "main", "feat/x-1")
            .unwrap();
        assert_eq!(behind, None);
        assert_eq!(runner.invocations.lock().unwrap().len(), 1);
    }

    #[test]
    fn commits_behind_rejects_a_count_that_is_not_a_number() {
        let (git, _) = git(vec![
            Ok("origin\n".to_owned()),
            Ok(String::new()),
            Ok("abc\n".to_owned()),
            Ok("many\n".to_owned()),
        ]);
        assert!(matches!(
            git.commits_behind(&local(r"C:\dev\a"), r"D:\wt\a", "main", "feat/x-1"),
            Err(GitError::UnexpectedOutput { .. })
        ));
    }

    #[test]
    fn process_runner_reports_stderr_of_failed_commands() {
        let invocation = Invocation {
            program: "git",
            args: args(&["no-such-command-for-toodo"]),
        };
        match ProcessRunner.run(&invocation) {
            Err(GitError::Failed { command, stderr }) => {
                assert_eq!(command, "git no-such-command-for-toodo");
                assert!(!stderr.is_empty());
            }
            other => panic!("expected a failed command, got {other:?}"),
        }
    }
}
