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
    /// Empty for a workspace with source [`Source::None`], which has no repository.
    pub default_base_branch: String,
    pub agent_merge: AgentMerge,
    pub source: Source,
    pub completion: CompletionMode,
    pub runner: Runner,
}

/// What a workspace location holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    /// A plain directory without a repository; tasks have no branches or worktrees.
    None,
    /// A git repository without a GitHub remote; task branches merge locally.
    LocalGit,
    /// A git repository whose `origin` remote is on GitHub; tasks ship as pull requests.
    GitHub,
}

impl Source {
    pub const ALL: [Self; 3] = [Self::None, Self::LocalGit, Self::GitHub];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::LocalGit => "local_git",
            Self::GitHub => "github",
        }
    }

    /// Whether the location holds a git repository.
    pub fn is_git(self) -> bool {
        self != Self::None
    }
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How the tasks of a workspace get done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CompletionMode {
    /// Their criteria are met without a merge, e.g. checked by hand.
    Manual,
    /// Their branch is merged into the base branch locally.
    LocalMerge,
    /// Their pull request is merged into the base branch.
    PullRequestMerge,
}

impl CompletionMode {
    pub const ALL: [Self; 3] = [Self::Manual, Self::LocalMerge, Self::PullRequestMerge];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::LocalMerge => "local_merge",
            Self::PullRequestMerge => "pr_merge",
        }
    }
}

impl fmt::Display for CompletionMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What runs the work of a started task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Runner {
    /// Nothing: starting a task only marks it in progress.
    None,
    /// Agents in a herdr workspace on a task worktree and branch.
    Herdr,
    /// Agent CLIs that Toodo runs itself on a task worktree and branch, without herdr.
    Plain,
    /// Agent CLIs in a tmux session on a POSIX host.
    Tmux,
}

impl Runner {
    pub const ALL: [Self; 4] = [Self::None, Self::Herdr, Self::Plain, Self::Tmux];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Herdr => "herdr",
            Self::Plain => "plain",
            Self::Tmux => "tmux",
        }
    }
}

impl fmt::Display for Runner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A source, completion, and runner that do not work together; the message names a
/// combination that does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidAxes(pub String);

impl fmt::Display for InvalidAxes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidAxes {}

/// Checks that a workspace can work with `source`, `completion`, and `runner` together.
pub fn check_axes(
    source: Source,
    completion: CompletionMode,
    runner: Runner,
) -> Result<(), InvalidAxes> {
    let invalid = |message: String| Err(InvalidAxes(message));
    match (source, completion) {
        (Source::None, CompletionMode::LocalMerge | CompletionMode::PullRequestMerge) => {
            return invalid(format!(
                "completion {completion} needs a git repository; choose completion manual for \
                 source none, or source {} for completion {completion}",
                if completion == CompletionMode::LocalMerge {
                    Source::LocalGit
                } else {
                    Source::GitHub
                }
            ));
        }
        (Source::LocalGit, CompletionMode::PullRequestMerge) => {
            return invalid(
                "source local_git has no pull requests; choose completion local_merge or \
                 manual, or source github for a repository with a GitHub origin remote"
                    .to_owned(),
            );
        }
        (Source::GitHub, CompletionMode::LocalMerge) => {
            return invalid(
                "source github completes tasks through pull requests; choose completion \
                 pr_merge or manual, or source local_git to merge task branches locally"
                    .to_owned(),
            );
        }
        _ => {}
    }
    if source == Source::None && runner != Runner::None {
        return invalid(format!(
            "runner {runner} needs a git repository for task worktrees; choose runner none \
             for source none, or source local_git or github for runner {runner}"
        ));
    }
    if runner == Runner::None && completion != CompletionMode::Manual {
        return invalid(format!(
            "completion {completion} merges the task branch that only a runner creates; \
             choose runner herdr for completion {completion}, or completion manual for \
             runner none"
        ));
    }
    Ok(())
}

/// Checks the host requirements of a runner. Plain supports either remote OS; tmux
/// requires a POSIX host.
pub fn check_runner_location(
    runner: Runner,
    location: &WorkspaceLocation,
) -> Result<(), InvalidAxes> {
    if runner == Runner::Tmux
        && matches!(location, WorkspaceLocation::Ssh { path, .. } if path.is_windows())
    {
        return Err(InvalidAxes(
            "runner tmux needs a POSIX host; choose runner plain or herdr for a Windows \
             SSH workspace, or choose a POSIX path for runner tmux"
                .to_owned(),
        ));
    }
    Ok(())
}

/// The completion of a workspace created with `source` and no completion given.
pub fn default_completion(source: Source) -> CompletionMode {
    match source {
        Source::None => CompletionMode::Manual,
        Source::LocalGit => CompletionMode::LocalMerge,
        Source::GitHub => CompletionMode::PullRequestMerge,
    }
}

/// The runner of a workspace created with `source` and no runner given.
pub fn default_runner(source: Source) -> Runner {
    match source {
        Source::None => Runner::None,
        Source::LocalGit | Source::GitHub => Runner::Herdr,
    }
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
    /// Labels such as a project or goal, sorted and unique (see
    /// [`crate::domain::plan::labels`]).
    pub labels: Vec<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_listed_axes_combinations_are_allowed() {
        use CompletionMode::{LocalMerge, Manual, PullRequestMerge};
        let allowed = [
            (Source::None, Manual, Runner::None),
            (Source::LocalGit, Manual, Runner::None),
            (Source::LocalGit, Manual, Runner::Herdr),
            (Source::LocalGit, LocalMerge, Runner::Herdr),
            (Source::GitHub, Manual, Runner::None),
            (Source::GitHub, Manual, Runner::Herdr),
            (Source::GitHub, PullRequestMerge, Runner::Herdr),
            (Source::LocalGit, Manual, Runner::Plain),
            (Source::LocalGit, LocalMerge, Runner::Plain),
            (Source::GitHub, Manual, Runner::Plain),
            (Source::GitHub, PullRequestMerge, Runner::Plain),
            (Source::LocalGit, Manual, Runner::Tmux),
            (Source::LocalGit, LocalMerge, Runner::Tmux),
            (Source::GitHub, Manual, Runner::Tmux),
            (Source::GitHub, PullRequestMerge, Runner::Tmux),
        ];
        let mut checked = 0;
        for source in Source::ALL {
            for completion in CompletionMode::ALL {
                for runner in Runner::ALL {
                    let result = check_axes(source, completion, runner);
                    let combination = (source, completion, runner);
                    assert_eq!(
                        result.is_ok(),
                        allowed.contains(&combination),
                        "{combination:?}: {result:?}"
                    );
                    if let Err(InvalidAxes(message)) = result {
                        assert!(message.contains("choose"), "{message}");
                    }
                    checked += 1;
                }
            }
        }
        assert_eq!(checked, 36);
    }

    #[test]
    fn rejections_name_a_combination_that_works() {
        let message =
            |source, completion, runner| check_axes(source, completion, runner).unwrap_err().0;
        assert_eq!(
            message(Source::None, CompletionMode::PullRequestMerge, Runner::None),
            "completion pr_merge needs a git repository; choose completion manual for source \
             none, or source github for completion pr_merge"
        );
        assert_eq!(
            message(Source::None, CompletionMode::Manual, Runner::Herdr),
            "runner herdr needs a git repository for task worktrees; choose runner none for \
             source none, or source local_git or github for runner herdr"
        );
        assert_eq!(
            message(Source::None, CompletionMode::Manual, Runner::Plain),
            "runner plain needs a git repository for task worktrees; choose runner none for \
             source none, or source local_git or github for runner plain"
        );
        assert_eq!(
            message(
                Source::LocalGit,
                CompletionMode::PullRequestMerge,
                Runner::Herdr
            ),
            "source local_git has no pull requests; choose completion local_merge or manual, \
             or source github for a repository with a GitHub origin remote"
        );
        assert_eq!(
            message(Source::GitHub, CompletionMode::LocalMerge, Runner::Herdr),
            "source github completes tasks through pull requests; choose completion pr_merge \
             or manual, or source local_git to merge task branches locally"
        );
        assert_eq!(
            message(
                Source::GitHub,
                CompletionMode::PullRequestMerge,
                Runner::None
            ),
            "completion pr_merge merges the task branch that only a runner creates; choose \
             runner herdr for completion pr_merge, or completion manual for runner none"
        );
    }

    #[test]
    fn only_tmux_rejects_a_windows_ssh_path() {
        let local = WorkspaceLocation::Local {
            path: crate::domain::path::PosixPath::parse("/srv/repo")
                .unwrap()
                .into(),
        };
        let ssh = WorkspaceLocation::Ssh {
            machine: MachineLabel::parse("devbox").unwrap(),
            path: crate::domain::path::PosixPath::parse("/srv/repo")
                .unwrap()
                .into(),
        };
        for runner in Runner::ALL {
            check_runner_location(runner, &local).unwrap();
            check_runner_location(runner, &ssh).unwrap();
            let windows = WorkspaceLocation::Ssh {
                machine: MachineLabel::parse("devbox").unwrap(),
                path: WindowsPath::parse(r"C:\repo").unwrap().into(),
            };
            assert_eq!(
                check_runner_location(runner, &windows).is_err(),
                runner == Runner::Tmux
            );
        }
    }

    #[test]
    fn defaults_follow_the_source_and_are_allowed() {
        let defaults =
            Source::ALL.map(|source| (source, default_completion(source), default_runner(source)));
        assert_eq!(
            defaults,
            [
                (Source::None, CompletionMode::Manual, Runner::None),
                (Source::LocalGit, CompletionMode::LocalMerge, Runner::Herdr),
                (
                    Source::GitHub,
                    CompletionMode::PullRequestMerge,
                    Runner::Herdr
                ),
            ]
        );
        for (source, completion, runner) in defaults {
            check_axes(source, completion, runner).unwrap();
        }
    }

    #[test]
    fn axes_have_their_wire_names() {
        assert_eq!(
            Source::ALL.map(Source::as_str),
            ["none", "local_git", "github"]
        );
        assert_eq!(
            CompletionMode::ALL.map(CompletionMode::as_str),
            ["manual", "local_merge", "pr_merge"]
        );
        assert_eq!(
            Runner::ALL.map(Runner::as_str),
            ["none", "herdr", "plain", "tmux"]
        );
    }
}
