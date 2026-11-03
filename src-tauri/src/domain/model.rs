//! Core domain types: workspaces, machines, tasks, and commit records.

use std::collections::BTreeSet;
use std::fmt;

use super::criteria::Criterion;
use super::path::{PathError, PosixPath, WindowsPath};
use super::plan::{DueDate, Estimate};
use super::status::TaskStatus;
use super::timeline::TaskEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WorkspaceId(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TaskId(pub i64);

impl fmt::Display for TaskId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Label of a saved herdr SSH machine; also used as the `ssh.exe` host.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MachineLabel(String);

impl MachineLabel {
    pub fn parse(raw: &str) -> Result<Self, EmptyMachineLabel> {
        let label = raw.trim();
        if label.is_empty() {
            return Err(EmptyMachineLabel);
        }
        Ok(Self(label.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MachineLabel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyMachineLabel;

impl fmt::Display for EmptyMachineLabel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("machine label must not be empty")
    }
}

impl std::error::Error for EmptyMachineLabel {}

/// The machine that hosts a workspace and its task worktrees.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Machine {
    Local,
    Ssh(MachineLabel),
}

impl fmt::Display for Machine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Local => f.write_str("local"),
            Self::Ssh(label) => label.fmt(f),
        }
    }
}

/// Where a workspace repository lives. Local workspaces use the paths of the machine
/// Toodo runs on (POSIX paths on the server; Windows paths kept from the desktop app
/// cannot be used there), SSH workspaces use the paths of the remote machine: POSIX paths,
/// or Windows paths when the machine is a Windows host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceLocation {
    Local {
        path: HostPath,
    },
    Ssh {
        machine: MachineLabel,
        path: HostPath,
    },
}

impl WorkspaceLocation {
    pub fn machine(&self) -> Machine {
        match self {
            Self::Local { .. } => Machine::Local,
            Self::Ssh { machine, .. } => Machine::Ssh(machine.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub location: WorkspaceLocation,
    pub default_base_branch: String,
    pub agent_merge: AgentMerge,
}

/// Whether agents merge the pull request of their own task. Toodo never merges; this
/// only tells agents (through the MCP server) what they may do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AgentMerge {
    /// Agents stop once the pull request is open; the user merges it.
    #[default]
    Never,
    /// Agents merge their pull request into the workspace base branch once its checks
    /// pass.
    AfterChecks,
}

/// Per-machine configuration. `worktree_root` must be set before a task on that
/// machine can be started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineSettings {
    Local {
        worktree_root: Option<HostPath>,
    },
    Ssh {
        machine: MachineLabel,
        /// A POSIX path, or a Windows path on a Windows host.
        worktree_root: Option<HostPath>,
    },
}

impl MachineSettings {
    pub fn machine(&self) -> Machine {
        match self {
            Self::Local { .. } => Machine::Local,
            Self::Ssh { machine, .. } => Machine::Ssh(machine.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostPath {
    Windows(WindowsPath),
    Posix(PosixPath),
}

impl HostPath {
    /// Parses a path entered for a machine whose kind is not known: a POSIX path when it
    /// starts with `/`, else a Windows drive or UNC path.
    pub fn parse(raw: &str) -> Result<Self, PathError> {
        Self::parse_stored(raw.trim())
    }

    /// Reads a path stored by Toodo, which kept its kind: only POSIX paths start with `/`.
    pub fn parse_stored(raw: &str) -> Result<Self, PathError> {
        if raw.starts_with('/') {
            PosixPath::parse(raw).map(Self::Posix)
        } else {
            WindowsPath::parse(raw).map(Self::Windows)
        }
    }

    /// Parses `raw` as a path of the same kind as this one, e.g. a path a tool reported
    /// for the machine this path is on.
    pub fn parse_like(&self, raw: &str) -> Result<Self, PathError> {
        match self {
            Self::Windows(_) => WindowsPath::parse(raw).map(Self::Windows),
            Self::Posix(_) => PosixPath::parse(raw).map(Self::Posix),
        }
    }

    /// Appends one path segment. `segment` must not contain separators.
    pub fn join(&self, segment: &str) -> Self {
        match self {
            Self::Windows(path) => Self::Windows(path.join(segment)),
            Self::Posix(path) => Self::Posix(path.join(segment)),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Windows(path) => path.as_str(),
            Self::Posix(path) => path.as_str(),
        }
    }

    pub fn is_windows(&self) -> bool {
        matches!(self, Self::Windows(_))
    }
}

impl From<WindowsPath> for HostPath {
    fn from(path: WindowsPath) -> Self {
        Self::Windows(path)
    }
}

impl From<PosixPath> for HostPath {
    fn from(path: PosixPath) -> Self {
        Self::Posix(path)
    }
}

impl fmt::Display for HostPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Windows(path) => path.fmt(f),
            Self::Posix(path) => path.fmt(f),
        }
    }
}

/// Fixed set of task types; used in worktree directory and branch names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskType {
    Feat,
    Fix,
    Modify,
    Refactor,
    Docs,
    Test,
    Chore,
    /// Research and development: work whose conclusion may be not to adopt it.
    Rnd,
}

impl TaskType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feat => "feat",
            Self::Fix => "fix",
            Self::Modify => "modify",
            Self::Refactor => "refactor",
            Self::Docs => "docs",
            Self::Test => "test",
            Self::Chore => "chore",
            Self::Rnd => "rnd",
        }
    }
}

impl fmt::Display for TaskType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How a `done` task ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskResolution {
    /// Its pull request was merged into the base branch.
    Merged,
    /// Its completion criteria were met without a pull request or a merge.
    Completed,
    /// The work was concluded without merging, e.g. research whose result was not
    /// adopted. Its completion note says why; dependents stay blocked.
    NotAdopted,
}

impl TaskResolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::Completed => "completed",
            Self::NotAdopted => "not_adopted",
        }
    }
}

/// The merged pull request or the other task that shipped the work of a task, e.g. one
/// pull request that fixed several tasks: the task is `done` without a pull request of
/// its own. At least one of the two is set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedWith {
    /// The task that shipped the work, if Toodo knows one; `None` once that task is
    /// deleted or for a pull request no task records.
    pub task_id: Option<TaskId>,
    /// The merged pull request; `None` when the task that shipped the work has no
    /// recorded pull request, e.g. it was completed without one.
    pub pull_request_url: Option<String>,
}

/// What a note left on a task records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NoteKind {
    /// Progress made or a decision taken while working on the task.
    Progress,
    /// Something that stops the work until someone acts on it.
    Blocker,
}

impl NoteKind {
    pub const ALL: [Self; 2] = [Self::Progress, Self::Blocker];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Progress => "progress",
            Self::Blocker => "blocker",
        }
    }
}

/// A note an agent left on a task while working on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskNote {
    pub kind: NoteKind,
    /// Non-empty Markdown.
    pub body: String,
    /// Time the note was left, in seconds since the Unix epoch.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: TaskId,
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    /// How the task ended; `Some` exactly when it is `done`.
    pub resolution: Option<TaskResolution>,
    pub depends_on: BTreeSet<TaskId>,
    pub branch: Option<String>,
    pub worktree_path: Option<HostPath>,
    pub herdr_workspace_id: Option<String>,
    pub pull_request_url: Option<String>,
    /// The GitHub issue of the workspace repository this task works on; its pull request
    /// closes it on merge.
    pub issue: Option<LinkedIssue>,
    /// The expected size of the task, if the user or an agent estimated it.
    pub estimate: Option<Estimate>,
    /// The day the task should be done by, if it has one.
    pub due_date: Option<DueDate>,
    /// Merge time of the pull request reported by GitHub, in seconds since the Unix
    /// epoch.
    pub pull_request_merged_at: Option<i64>,
    /// What the pull request looked like when its merge completed the task.
    pub pull_request: Option<PullRequestSnapshot>,
    /// The pull request of another task that shipped this task's work; set only for a
    /// task `done` as merged that way.
    pub merged_with: Option<MergedWith>,
    /// What the user wrote about the outcome of a `done` task, for later reviews.
    pub completion_note: Option<String>,
    /// Status history, oldest event first.
    pub timeline: Vec<TaskEvent>,
    /// Notes left on the task, oldest first.
    pub notes: Vec<TaskNote>,
    /// What has to hold for the task to be done, in the order its author gave.
    pub criteria: Vec<Criterion>,
}

/// A GitHub issue linked to a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedIssue {
    pub number: i64,
    pub url: String,
}

/// A merged pull request as GitHub reported it when it completed its task, kept so
/// reviews do not depend on GitHub later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestSnapshot {
    pub number: i64,
    pub title: String,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    /// The commit the merge put on the base branch; with a squash merge the branch
    /// commits never reach it.
    pub merge_commit_sha: Option<String>,
    /// Submitted reviews by anyone but the author of the pull request.
    pub review_count: i64,
    /// Distinct reviewers other than the author of the pull request.
    pub reviewer_count: i64,
    /// Submission time of the first of those reviews, in seconds since the Unix epoch.
    pub first_reviewed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRecord {
    pub task_id: TaskId,
    pub sha: String,
    pub message: String,
    pub author: String,
    /// Commit timestamp in seconds since the Unix epoch.
    pub committed_at: i64,
}
