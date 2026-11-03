//! Serializable shapes of the domain model exchanged with the frontend. Inputs are
//! validated when they are converted into domain types.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::{CommandError, CommandResult};
use crate::adapters::{git, github, herdr, ssh};
use crate::domain::runtime as domain_runtime;
use crate::domain::{
    activity, backup, criteria, model, path, plan, review, ssh_config, status, timeline,
};
use crate::runtime::plain;
use crate::storage;

// Database IDs and timestamps stay far below 2^53, so they are exported as `number`
// instead of the `bigint` specta requires for `i64` by default.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(transparent)]
pub struct WorkspaceId(#[specta(type = Number)] pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(transparent)]
pub struct TaskId(#[specta(type = Number)] pub i64);

/// A related link between two tasks, which may belong to different workspaces. The link
/// goes both ways; `task_id` is the lower ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskRelation {
    pub task_id: TaskId,
    pub related_id: TaskId,
}

/// What adding a prerequisite in the app did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DependencyOutcome {
    /// The dependency was added, pausing the task if it blocks it and the pause was
    /// confirmed.
    Added,
    /// The prerequisite would pause the task, which is in progress; nothing was added.
    /// Ask the user, then add it again with the pause confirmed.
    ConfirmPause,
}

/// Seconds since the Unix epoch (UTC).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Timestamp(#[specta(type = Number)] pub i64);

/// An OAuth app with an unrevoked grant and a live token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct OAuthGrantId(#[specta(type = Number)] pub i64);

/// A live app connection shown in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedApp {
    pub grant_id: OAuthGrantId,
    pub client_name: Option<String>,
    pub client_id: String,
    pub scopes: String,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedApps {
    pub public_mcp_url: Option<String>,
    pub apps: Vec<ConnectedApp>,
}

impl From<WorkspaceId> for model::WorkspaceId {
    fn from(id: WorkspaceId) -> Self {
        Self(id.0)
    }
}

impl From<model::WorkspaceId> for WorkspaceId {
    fn from(id: model::WorkspaceId) -> Self {
        Self(id.0)
    }
}

impl From<TaskId> for model::TaskId {
    fn from(id: TaskId) -> Self {
        Self(id.0)
    }
}

impl From<model::TaskId> for TaskId {
    fn from(id: model::TaskId) -> Self {
        Self(id.0)
    }
}

fn required(field: &str, value: String) -> CommandResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid_input(format!(
            "{field} must not be empty"
        )));
    }
    Ok(trimmed.to_owned())
}

/// The unit of time an estimate counts, compared with the time the task spends in
/// progress or in review. A day is 24 hours, a week 7 days, and a month 30 days.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EstimateUnit {
    Hours,
    Days,
    Weeks,
    Months,
}

/// The expected size of a task.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub unit: EstimateUnit,
    /// Greater than 0 and at most 10000, e.g. 1.5. Exported as `number`: it is never NaN
    /// or infinite, which specta's default `number | null` allows for.
    #[specta(type = Number)]
    pub amount: f64,
}

// JSON cannot carry NaN, and outgoing amounts come from validated domain estimates.
impl Eq for Estimate {}

impl From<plan::Estimate> for Estimate {
    fn from(estimate: plan::Estimate) -> Self {
        Self {
            unit: match estimate.unit() {
                plan::EstimateUnit::Hours => EstimateUnit::Hours,
                plan::EstimateUnit::Days => EstimateUnit::Days,
                plan::EstimateUnit::Weeks => EstimateUnit::Weeks,
                plan::EstimateUnit::Months => EstimateUnit::Months,
            },
            amount: estimate.amount(),
        }
    }
}

impl TryFrom<Estimate> for plan::Estimate {
    type Error = CommandError;

    fn try_from(estimate: Estimate) -> CommandResult<Self> {
        let unit = match estimate.unit {
            EstimateUnit::Hours => plan::EstimateUnit::Hours,
            EstimateUnit::Days => plan::EstimateUnit::Days,
            EstimateUnit::Weeks => plan::EstimateUnit::Weeks,
            EstimateUnit::Months => plan::EstimateUnit::Months,
        };
        plan::Estimate::new(unit, estimate.amount)
            .map_err(|error| CommandError::invalid_input(error.to_string()))
    }
}

pub(crate) fn estimate(estimate: Option<Estimate>) -> CommandResult<Option<plan::Estimate>> {
    estimate.map(plan::Estimate::try_from).transpose()
}

/// A due date as `YYYY-MM-DD`; blank means none.
pub(crate) fn due_date(raw: Option<&str>) -> CommandResult<Option<plan::DueDate>> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some(raw) => plan::DueDate::parse(raw)
            .map(Some)
            .map_err(|error| CommandError::invalid_input(error.to_string())),
    }
}

fn machine_label(raw: &str) -> CommandResult<model::MachineLabel> {
    model::MachineLabel::parse(raw).map_err(|error| CommandError::invalid_input(error.to_string()))
}

/// A path on the machine Toodo runs on: a POSIX path on the server.
fn local_path(raw: &str) -> CommandResult<model::HostPath> {
    posix_path(raw).map(model::HostPath::Posix)
}

fn posix_path(raw: &str) -> CommandResult<path::PosixPath> {
    path::PosixPath::parse(raw).map_err(|error| CommandError::invalid_input(error.to_string()))
}

/// A path on an SSH machine: a POSIX path, or a Windows drive or UNC path on a Windows
/// host.
fn remote_path(raw: &str) -> CommandResult<model::HostPath> {
    model::HostPath::parse(raw).map_err(|error| CommandError::invalid_input(error.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceLocation {
    /// Path of a repository on the machine Toodo runs on: a Windows path in the desktop
    /// app, a POSIX path on the server.
    Local { path: String },
    /// Path of a repository on a saved herdr SSH machine: a POSIX path, or a Windows
    /// drive or UNC path when the machine is a Windows host.
    Ssh { machine: String, path: String },
}

impl From<&model::WorkspaceLocation> for WorkspaceLocation {
    fn from(location: &model::WorkspaceLocation) -> Self {
        match location {
            model::WorkspaceLocation::Local { path } => Self::Local {
                path: path.as_str().to_owned(),
            },
            model::WorkspaceLocation::Ssh { machine, path } => Self::Ssh {
                machine: machine.as_str().to_owned(),
                path: path.as_str().to_owned(),
            },
        }
    }
}

impl TryFrom<WorkspaceLocation> for model::WorkspaceLocation {
    type Error = CommandError;

    fn try_from(location: WorkspaceLocation) -> CommandResult<Self> {
        Ok(match location {
            WorkspaceLocation::Local { path } => Self::Local {
                path: local_path(&path)?,
            },
            WorkspaceLocation::Ssh { machine, path } => Self::Ssh {
                machine: machine_label(&machine)?,
                path: remote_path(&path)?,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub location: WorkspaceLocation,
    pub default_base_branch: String,
    /// Whether agents merge their own task pull request into the base branch.
    pub agent_merge: AgentMerge,
    /// Why the server cannot use the repository path, so it can be corrected; `null`
    /// when it can. Ignored when the workspace is saved.
    pub path_problem: Option<PathProblem>,
    /// What the location holds; set at creation and ignored when the workspace is saved.
    pub source: Source,
    /// How its tasks get done; set at creation and ignored when the workspace is saved.
    pub completion: CompletionMode,
    /// What runs started tasks; set at creation and ignored when the workspace is saved.
    pub runner: Runner,
}

/// What a workspace location holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// A plain directory without a repository; tasks have no branches or worktrees.
    None,
    /// A git repository without a GitHub remote; task branches merge locally.
    LocalGit,
    /// A git repository whose `origin` remote is on GitHub; tasks ship as pull requests.
    #[serde(rename = "github")]
    GitHub,
}

impl From<model::Source> for Source {
    fn from(source: model::Source) -> Self {
        match source {
            model::Source::None => Self::None,
            model::Source::LocalGit => Self::LocalGit,
            model::Source::GitHub => Self::GitHub,
        }
    }
}

impl From<Source> for model::Source {
    fn from(source: Source) -> Self {
        match source {
            Source::None => Self::None,
            Source::LocalGit => Self::LocalGit,
            Source::GitHub => Self::GitHub,
        }
    }
}

/// How the tasks of a workspace get done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompletionMode {
    /// Their criteria are met without a merge, e.g. checked by hand.
    Manual,
    /// Their branch is merged into the base branch locally.
    LocalMerge,
    /// Their pull request is merged into the base branch.
    #[serde(rename = "pr_merge")]
    PullRequestMerge,
}

impl From<model::CompletionMode> for CompletionMode {
    fn from(completion: model::CompletionMode) -> Self {
        match completion {
            model::CompletionMode::Manual => Self::Manual,
            model::CompletionMode::LocalMerge => Self::LocalMerge,
            model::CompletionMode::PullRequestMerge => Self::PullRequestMerge,
        }
    }
}

impl From<CompletionMode> for model::CompletionMode {
    fn from(completion: CompletionMode) -> Self {
        match completion {
            CompletionMode::Manual => Self::Manual,
            CompletionMode::LocalMerge => Self::LocalMerge,
            CompletionMode::PullRequestMerge => Self::PullRequestMerge,
        }
    }
}

/// What runs the work of a started task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
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

impl From<model::Runner> for Runner {
    fn from(runner: model::Runner) -> Self {
        match runner {
            model::Runner::None => Self::None,
            model::Runner::Herdr => Self::Herdr,
            model::Runner::Plain => Self::Plain,
            model::Runner::Tmux => Self::Tmux,
        }
    }
}

impl From<Runner> for model::Runner {
    fn from(runner: Runner) -> Self {
        match runner {
            Runner::None => Self::None,
            Runner::Herdr => Self::Herdr,
            Runner::Plain => Self::Plain,
            Runner::Tmux => Self::Tmux,
        }
    }
}

impl From<&model::Workspace> for Workspace {
    fn from(workspace: &model::Workspace) -> Self {
        Self {
            id: workspace.id.into(),
            name: workspace.name.clone(),
            location: (&workspace.location).into(),
            default_base_branch: workspace.default_base_branch.clone(),
            agent_merge: workspace.agent_merge.into(),
            path_problem: PathProblem::of(&workspace.location),
            source: workspace.source.into(),
            completion: workspace.completion.into(),
            runner: workspace.runner.into(),
        }
    }
}

/// Why the server cannot run git in the repository of a local workspace. Paths on SSH
/// machines are not checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PathProblem {
    /// A Windows path, e.g. one kept from the desktop app: it never exists on the server.
    Foreign,
    /// A server path that is not a directory, e.g. a repository that was moved.
    Missing,
}

impl PathProblem {
    pub fn of(location: &model::WorkspaceLocation) -> Option<Self> {
        match location {
            model::WorkspaceLocation::Local {
                path: model::HostPath::Windows(_),
            } => Some(Self::Foreign),
            model::WorkspaceLocation::Local {
                path: model::HostPath::Posix(path),
            } => (!std::path::Path::new(path.as_str()).is_dir()).then_some(Self::Missing),
            model::WorkspaceLocation::Ssh { .. } => None,
        }
    }
}

/// Whether agents merge the pull request of their own task. Toodo itself never merges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AgentMerge {
    /// Agents stop once the pull request is open; the user merges it.
    Never,
    /// Agents merge their pull request into the workspace base branch once every check
    /// on it passed.
    AfterChecks,
}

impl From<model::AgentMerge> for AgentMerge {
    fn from(agent_merge: model::AgentMerge) -> Self {
        match agent_merge {
            model::AgentMerge::Never => Self::Never,
            model::AgentMerge::AfterChecks => Self::AfterChecks,
        }
    }
}

impl From<AgentMerge> for model::AgentMerge {
    fn from(agent_merge: AgentMerge) -> Self {
        match agent_merge {
            AgentMerge::Never => Self::Never,
            AgentMerge::AfterChecks => Self::AfterChecks,
        }
    }
}

impl Workspace {
    /// The workspace with its settings from this one and the location, source,
    /// completion, and runner of `stored`, the saved workspace: the location only changes
    /// by moving it, the other three never after creation. The default base branch may be
    /// empty only for source none, which has no repository.
    pub(crate) fn into_model(self, stored: &model::Workspace) -> CommandResult<model::Workspace> {
        let default_base_branch = match stored.source {
            model::Source::None => self.default_base_branch.trim().to_owned(),
            model::Source::LocalGit | model::Source::GitHub => {
                required("default base branch", self.default_base_branch)?
            }
        };
        Ok(model::Workspace {
            id: self.id.into(),
            name: required("workspace name", self.name)?,
            location: stored.location.clone(),
            default_base_branch,
            agent_merge: self.agent_merge.into(),
            source: stored.source,
            completion: stored.completion,
            runner: stored.runner,
        })
    }
}

/// How the repository of a new workspace gets to its location.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepositorySetup {
    /// The location already holds a cloned repository.
    Open,
    /// Clone `url` into the location, which must not exist or be empty.
    Clone { url: String },
    /// Make the location, a plain folder or one that does not exist yet, a new git
    /// repository without a remote.
    Init,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewWorkspace {
    pub name: String,
    pub location: WorkspaceLocation,
    /// How the repository gets to the location; required for a git source, absent for
    /// none.
    pub repository: Option<RepositorySetup>,
    /// Omitted: github when the prepared repository has an origin remote, else
    /// local_git; none when `repository` is absent.
    pub source: Option<Source>,
    /// Omitted: the default of the source (none: manual, local_git: local_merge,
    /// github: pr_merge).
    pub completion: Option<CompletionMode>,
    /// Omitted: the default of the source (none: none, git sources: herdr), except that a
    /// local git workspace defaults to plain when herdr is not running on the server.
    pub runner: Option<Runner>,
    /// Detected from the repository when empty or absent; ignored for source none.
    pub default_base_branch: Option<String>,
}

/// A validated [`NewWorkspace`] whose repository has not been cloned or checked yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSetup {
    pub name: String,
    pub location: model::WorkspaceLocation,
    /// `None` exactly when the source is none.
    pub repository: Option<RepositorySetup>,
    /// `None` when the repository decides it: github with an origin remote, else
    /// local_git. Never `Some(Source::None)` with a repository.
    pub source: Option<model::Source>,
    pub completion: Option<model::CompletionMode>,
    pub runner: Option<model::Runner>,
    pub default_base_branch: Option<String>,
}

impl TryFrom<NewWorkspace> for WorkspaceSetup {
    type Error = CommandError;

    fn try_from(new: NewWorkspace) -> CommandResult<Self> {
        let source = new.source.map(model::Source::from);
        let repository = match (new.repository, source) {
            (Some(_), Some(model::Source::None)) => {
                return Err(CommandError::invalid_input(
                    "source none has no repository; omit repository, or choose source \
                     local_git or github to open, clone, or init one",
                ));
            }
            (None, Some(source @ (model::Source::LocalGit | model::Source::GitHub))) => {
                return Err(CommandError::invalid_input(format!(
                    "source {source} needs a repository; set repository to open, clone, or \
                     init one, or choose source none for a plain directory"
                )));
            }
            (Some(RepositorySetup::Init), Some(model::Source::GitHub)) => {
                return Err(CommandError::invalid_input(
                    "a new repository has no origin remote for source github; choose source \
                     local_git for a new repository, or clone the GitHub repository instead",
                ));
            }
            (None, _) => None,
            (Some(RepositorySetup::Clone { url }), _) => Some(RepositorySetup::Clone {
                url: required("repository URL", url)?,
            }),
            (Some(setup), _) => Some(setup),
        };
        Ok(Self {
            name: required("workspace name", new.name)?,
            location: new.location.try_into()?,
            source: if repository.is_none() {
                Some(model::Source::None)
            } else {
                source
            },
            repository,
            completion: new.completion.map(Into::into),
            runner: new.runner.map(Into::into),
            default_base_branch: new
                .default_base_branch
                .map(|branch| branch.trim().to_owned())
                .filter(|branch| !branch.is_empty()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Machine {
    Local,
    Ssh { label: String },
}

impl TryFrom<Machine> for model::Machine {
    type Error = CommandError;

    fn try_from(machine: Machine) -> CommandResult<Self> {
        Ok(match machine {
            Machine::Local => Self::Local,
            Machine::Ssh { label } => Self::Ssh(machine_label(&label)?),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MachineSettings {
    pub machine: Machine,
    /// Directory that holds task worktrees; required before a task on this machine can
    /// be started.
    pub worktree_root: Option<String>,
}

impl From<&model::MachineSettings> for MachineSettings {
    fn from(settings: &model::MachineSettings) -> Self {
        match settings {
            model::MachineSettings::Local { worktree_root } => Self {
                machine: Machine::Local,
                worktree_root: worktree_root.as_ref().map(|root| root.as_str().to_owned()),
            },
            model::MachineSettings::Ssh {
                machine,
                worktree_root,
            } => Self {
                machine: Machine::Ssh {
                    label: machine.as_str().to_owned(),
                },
                worktree_root: worktree_root.as_ref().map(|root| root.as_str().to_owned()),
            },
        }
    }
}

impl TryFrom<MachineSettings> for model::MachineSettings {
    type Error = CommandError;

    fn try_from(settings: MachineSettings) -> CommandResult<Self> {
        let root = settings.worktree_root.as_deref();
        Ok(match settings.machine.try_into()? {
            model::Machine::Local => Self::Local {
                worktree_root: root.map(local_path).transpose()?,
            },
            model::Machine::Ssh(machine) => Self::Ssh {
                machine,
                worktree_root: root.map(remote_path).transpose()?,
            },
        })
    }
}

/// A remote machine to append to the user's SSH config.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewSshHost {
    /// Name used by `ssh <alias>` and shown as the machine label.
    pub alias: String,
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
}

impl TryFrom<NewSshHost> for ssh_config::SshHost {
    type Error = CommandError;

    fn try_from(host: NewSshHost) -> CommandResult<Self> {
        Self::new(
            &host.alias,
            &host.host_name,
            host.user.as_deref(),
            host.port,
        )
        .map_err(|error| CommandError::invalid_input(error.to_string()))
    }
}

/// A machine saved in herdr with `herdr machine add`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HerdrMachine {
    /// Opaque herdr profile ID.
    pub id: String,
    /// Name shown in the herdr sidebar.
    pub label: String,
    /// SSH target; workspaces on this machine store it as their `machine`.
    pub target: String,
    /// herdr session on the remote machine.
    pub session: String,
    pub enabled: bool,
}

impl From<&herdr::SavedMachine> for HerdrMachine {
    fn from(machine: &herdr::SavedMachine) -> Self {
        Self {
            id: machine.id.clone(),
            label: machine.label.clone(),
            target: machine.target.clone(),
            session: machine.session.clone(),
            enabled: machine.enabled,
        }
    }
}

/// Branches of a workspace repository a base branch can be picked from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    /// Local and `origin` branch names, sorted, without `origin/` prefixes.
    pub names: Vec<String>,
    /// Why fetching `origin` failed; the names are then the ones known locally.
    pub fetch_error: Option<String>,
}

impl From<git::BranchList> for BranchList {
    fn from(list: git::BranchList) -> Self {
        Self {
            names: list.names,
            fetch_error: list.fetch_error,
        }
    }
}

/// How far an `in_progress` or `in_review` task's branch has fallen behind its base
/// branch, e.g. after a prerequisite was merged into the base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchFreshness {
    /// The revision counted against: `origin/<base>` when it exists, else `<base>`.
    pub base: String,
    /// Commits on the base that the branch does not contain.
    pub behind: u32,
    /// Why fetching `origin` failed; `behind` is then against the last fetched base.
    pub fetch_error: Option<String>,
    /// Whether the task's pull request merges without conflicts; `None` without a pull
    /// request or when it could not be read.
    pub mergeable: Option<MergeState>,
    /// Why the pull request could not be read.
    pub mergeable_error: Option<String>,
}

/// Whether GitHub can merge a pull request into its base without conflicts; `unknown`
/// until GitHub has computed it, and for a pull request that is no longer open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MergeState {
    Mergeable,
    Conflicting,
    Unknown,
}

impl From<github::MergeState> for MergeState {
    fn from(mergeable: github::MergeState) -> Self {
        match mergeable {
            github::MergeState::Mergeable => Self::Mergeable,
            github::MergeState::Conflicting => Self::Conflicting,
            github::MergeState::Unknown => Self::Unknown,
        }
    }
}

/// Subdirectories of a directory on a remote machine, for the folder browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectory {
    /// Absolute POSIX path of the listed directory.
    pub path: String,
    pub directories: Vec<String>,
}

impl From<&ssh::RemoteDirectory> for RemoteDirectory {
    fn from(listing: &ssh::RemoteDirectory) -> Self {
        Self {
            path: listing.path.as_str().to_owned(),
            directories: listing.directories.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Feat,
    Fix,
    Modify,
    Refactor,
    Docs,
    Test,
    Chore,
    Rnd,
}

impl From<model::TaskType> for TaskType {
    fn from(task_type: model::TaskType) -> Self {
        match task_type {
            model::TaskType::Feat => Self::Feat,
            model::TaskType::Fix => Self::Fix,
            model::TaskType::Modify => Self::Modify,
            model::TaskType::Refactor => Self::Refactor,
            model::TaskType::Docs => Self::Docs,
            model::TaskType::Test => Self::Test,
            model::TaskType::Chore => Self::Chore,
            model::TaskType::Rnd => Self::Rnd,
        }
    }
}

impl From<TaskType> for model::TaskType {
    fn from(task_type: TaskType) -> Self {
        match task_type {
            TaskType::Feat => Self::Feat,
            TaskType::Fix => Self::Fix,
            TaskType::Modify => Self::Modify,
            TaskType::Refactor => Self::Refactor,
            TaskType::Docs => Self::Docs,
            TaskType::Test => Self::Test,
            TaskType::Chore => Self::Chore,
            TaskType::Rnd => Self::Rnd,
        }
    }
}

/// How a `done` task ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskResolution {
    /// Its pull request was merged.
    Merged,
    /// Its criteria were met without a pull request or a merge.
    Completed,
    /// Concluded without merging; the completion note says why. Dependents stay
    /// waiting.
    NotAdopted,
}

impl From<TaskResolution> for model::TaskResolution {
    fn from(resolution: TaskResolution) -> Self {
        match resolution {
            TaskResolution::Merged => Self::Merged,
            TaskResolution::Completed => Self::Completed,
            TaskResolution::NotAdopted => Self::NotAdopted,
        }
    }
}

impl From<model::TaskResolution> for TaskResolution {
    fn from(resolution: model::TaskResolution) -> Self {
        match resolution {
            model::TaskResolution::Merged => Self::Merged,
            model::TaskResolution::Completed => Self::Completed,
            model::TaskResolution::NotAdopted => Self::NotAdopted,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Planned,
    InProgress,
    InReview,
    Done,
}

impl From<status::TaskStatus> for TaskStatus {
    fn from(status: status::TaskStatus) -> Self {
        match status {
            status::TaskStatus::Planned => Self::Planned,
            status::TaskStatus::InProgress => Self::InProgress,
            status::TaskStatus::InReview => Self::InReview,
            status::TaskStatus::Done => Self::Done,
        }
    }
}

impl From<TaskStatus> for status::TaskStatus {
    fn from(status: TaskStatus) -> Self {
        match status {
            TaskStatus::Planned => Self::Planned,
            TaskStatus::InProgress => Self::InProgress,
            TaskStatus::InReview => Self::InReview,
            TaskStatus::Done => Self::Done,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: TaskId,
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    /// How the task ended; set exactly when it is `done`.
    pub resolution: Option<TaskResolution>,
    /// Tasks this task depends on, in ascending ID order.
    pub depends_on: Vec<TaskId>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// An active task has a branch but no checkout; restore it in the Toodo app.
    pub worktree_missing: bool,
    pub herdr_workspace_id: Option<String>,
    pub pull_request_url: Option<String>,
    /// The GitHub issue this task works on; its pull request closes it on merge.
    pub issue: Option<LinkedIssue>,
    /// The expected size of the task, if estimated.
    pub estimate: Option<Estimate>,
    /// The day the task should be done by, as `YYYY-MM-DD` in local time.
    pub due_date: Option<String>,
    /// Merge time of the pull request reported by GitHub.
    pub pull_request_merged_at: Option<Timestamp>,
    /// The pull request as GitHub reported it when its merge completed the task; `null`
    /// for tasks completed before Toodo recorded it.
    pub pull_request: Option<PullRequestSnapshot>,
    /// The merged pull request of another task that shipped this task's work, for a task
    /// `done` as merged without a pull request of its own.
    pub merged_with: Option<MergedWith>,
    /// What the user wrote about the outcome of a `done` task; for a `not_adopted` one,
    /// why it was not adopted.
    pub completion_note: Option<String>,
    /// Status history, oldest event first. Empty for tasks created before Toodo
    /// recorded it.
    pub timeline: Vec<TaskEvent>,
    pub milestones: TaskMilestones,
    /// Notes agents left on the task through the MCP server, oldest first.
    pub notes: Vec<TaskNote>,
    /// What has to hold for the task to be done, in order.
    pub criteria: Vec<Criterion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(transparent)]
pub struct CriterionId(#[specta(type = Number)] pub i64);

impl From<CriterionId> for criteria::CriterionId {
    fn from(id: CriterionId) -> Self {
        Self(id.0)
    }
}

/// How a completion criterion is checked: by hand (`manual`) or by Toodo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    /// Checked by the user or an agent, with evidence.
    Manual,
    /// The task's pull request is merged into the workspace base branch.
    PrMerged,
    /// The task's pull request is open and all its checks passed.
    PrOpenCiGreen,
    /// The task branch is merged into the base branch in the repository itself, for
    /// workspaces without an `origin` remote.
    BranchMergedLocally,
    /// A GET of `target`, an http(s) URL, succeeds.
    Url,
    /// `target`, a shell command, exits with status 0 in the task worktree.
    Command,
}

impl From<CheckKind> for criteria::CheckKind {
    fn from(kind: CheckKind) -> Self {
        match kind {
            CheckKind::Manual => Self::Manual,
            CheckKind::PrMerged => Self::PullRequestMerged,
            CheckKind::PrOpenCiGreen => Self::PullRequestOpenChecksPassed,
            CheckKind::BranchMergedLocally => Self::BranchMergedLocally,
            CheckKind::Url => Self::Url,
            CheckKind::Command => Self::Command,
        }
    }
}

impl From<criteria::CheckKind> for CheckKind {
    fn from(kind: criteria::CheckKind) -> Self {
        match kind {
            criteria::CheckKind::Manual => Self::Manual,
            criteria::CheckKind::PullRequestMerged => Self::PrMerged,
            criteria::CheckKind::PullRequestOpenChecksPassed => Self::PrOpenCiGreen,
            criteria::CheckKind::BranchMergedLocally => Self::BranchMergedLocally,
            criteria::CheckKind::Url => Self::Url,
            criteria::CheckKind::Command => Self::Command,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CriterionState {
    Pending,
    Met,
    /// The last automatic check failed, e.g. a command exited with an error; Toodo checks
    /// it again.
    Failed,
}

impl From<criteria::CriterionState> for CriterionState {
    fn from(state: criteria::CriterionState) -> Self {
        match state {
            criteria::CriterionState::Pending => Self::Pending,
            criteria::CriterionState::Met => Self::Met,
            criteria::CriterionState::Failed => Self::Failed,
        }
    }
}

/// Who checked a criterion last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CheckedBy {
    User,
    Agent,
    Toodo,
}

impl From<criteria::CheckedBy> for CheckedBy {
    fn from(by: criteria::CheckedBy) -> Self {
        match by {
            criteria::CheckedBy::User => Self::User,
            criteria::CheckedBy::Agent => Self::Agent,
            criteria::CheckedBy::Toodo => Self::Toodo,
        }
    }
}

/// A completion criterion of a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub id: CriterionId,
    pub text: String,
    pub kind: CheckKind,
    /// The URL or command to check; for `branch_merged_locally`, the commit the branch
    /// started from once Toodo knows it.
    pub target: Option<String>,
    pub state: CriterionState,
    /// What showed the last check's result, or why it failed.
    pub evidence: Option<String>,
    pub checked_by: Option<CheckedBy>,
    pub checked_at: Option<Timestamp>,
}

impl From<&criteria::Criterion> for Criterion {
    fn from(criterion: &criteria::Criterion) -> Self {
        Self {
            id: CriterionId(criterion.id.0),
            text: criterion.text.clone(),
            kind: criterion.kind.into(),
            target: criterion.target.clone(),
            state: criterion.state.into(),
            evidence: criterion.evidence.clone(),
            checked_by: criterion.checked_by.map(CheckedBy::from),
            checked_at: criterion.checked_at.map(Timestamp),
        }
    }
}

/// A completion criterion given when creating or editing a task: an existing one by `id`
/// (only when editing), or a new one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CriterionInput {
    /// An existing criterion of the task, which keeps its state unless its kind or
    /// target changes; omit it for a new criterion. `{"id": N}` alone keeps criterion N
    /// as it is.
    #[serde(default)]
    pub id: Option<CriterionId>,
    /// What has to hold, in words, e.g. `The server answers /health`. Required for a new
    /// criterion; the stored text when omitted with `id`.
    #[serde(default)]
    pub text: Option<String>,
    /// Required for a new criterion; the stored kind when omitted with `id`.
    #[serde(default)]
    pub kind: Option<CheckKind>,
    /// The http(s) URL of a `url` criterion or the shell command of a `command`
    /// criterion; omit it for other kinds. With `id`, the stored target when omitted and
    /// the kind stays the same.
    #[serde(default)]
    pub target: Option<String>,
}

impl CriterionInput {
    /// Keeps the existing criterion `id` as it is.
    pub fn keep(id: CriterionId) -> Self {
        Self {
            id: Some(id),
            text: None,
            kind: None,
            target: None,
        }
    }

    /// A new criterion, which needs its text and kind.
    pub fn parse(&self) -> CommandResult<criteria::NewCriterion> {
        let (Some(text), Some(kind)) = (&self.text, self.kind) else {
            return Err(CommandError::invalid_input(
                "a new criterion needs text and kind, e.g. {\"text\": \"Docs updated\", \"kind\": \"manual\"}; give an existing one by its id instead",
            ));
        };
        criteria::NewCriterion::parse(text, kind.into(), self.target.as_deref())
            .map_err(|error| CommandError::invalid_input(error.to_string()))
    }

    /// The criterion an edit of `known` asks for: omitted fields keep the stored values,
    /// and the stored target stays only while the kind does.
    pub fn parse_over(&self, known: &criteria::Criterion) -> CommandResult<criteria::NewCriterion> {
        let kind = self.kind.map_or(known.kind, Into::into);
        let text = self.text.as_deref().unwrap_or(&known.text);
        let target = match &self.target {
            Some(target) => Some(target.as_str()),
            None if kind == known.kind && kind.takes_target() => known.target.as_deref(),
            None => None,
        };
        criteria::NewCriterion::parse(text, kind, target)
            .map_err(|error| CommandError::invalid_input(error.to_string()))
    }
}

/// The merged pull request or the other task that shipped the work of a task; at least
/// one of the two is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergedWith {
    /// The task that shipped the work; `null` once that task is deleted or for a pull
    /// request no task records.
    pub task_id: Option<TaskId>,
    /// The merged pull request; `null` when the task that shipped the work has no
    /// recorded pull request.
    pub pull_request_url: Option<String>,
}

/// What a note left on a task records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    /// Progress made or a decision taken.
    Progress,
    /// Something that stops the work until someone acts on it.
    Blocker,
}

impl From<model::NoteKind> for NoteKind {
    fn from(kind: model::NoteKind) -> Self {
        match kind {
            model::NoteKind::Progress => Self::Progress,
            model::NoteKind::Blocker => Self::Blocker,
        }
    }
}

/// A note an agent left on a task while working on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskNote {
    pub kind: NoteKind,
    /// Markdown.
    pub body: String,
    pub at: Timestamp,
}

impl From<&model::TaskNote> for TaskNote {
    fn from(note: &model::TaskNote) -> Self {
        Self {
            kind: note.kind.into(),
            body: note.body.clone(),
            at: Timestamp(note.at),
        }
    }
}

/// A GitHub issue of the workspace repository linked to a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkedIssue {
    #[specta(type = Number)]
    pub number: i64,
    pub url: String,
}

impl From<&model::LinkedIssue> for LinkedIssue {
    fn from(issue: &model::LinkedIssue) -> Self {
        Self {
            number: issue.number,
            url: issue.url.clone(),
        }
    }
}

/// A merged pull request as GitHub reported it when it completed its task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSnapshot {
    #[specta(type = Number)]
    pub number: i64,
    pub title: String,
    #[specta(type = Number)]
    pub additions: i64,
    #[specta(type = Number)]
    pub deletions: i64,
    #[specta(type = Number)]
    pub changed_files: i64,
    /// The commit the merge put on the base branch.
    pub merge_commit_sha: Option<String>,
    /// Submitted reviews by anyone but the author of the pull request.
    #[specta(type = Number)]
    pub review_count: i64,
    /// Distinct reviewers other than the author of the pull request.
    #[specta(type = Number)]
    pub reviewer_count: i64,
    pub first_reviewed_at: Option<Timestamp>,
}

impl From<&model::PullRequestSnapshot> for PullRequestSnapshot {
    fn from(snapshot: &model::PullRequestSnapshot) -> Self {
        Self {
            number: snapshot.number,
            title: snapshot.title.clone(),
            additions: snapshot.additions,
            deletions: snapshot.deletions,
            changed_files: snapshot.changed_files,
            merge_commit_sha: snapshot.merge_commit_sha.clone(),
            review_count: snapshot.review_count,
            reviewer_count: snapshot.reviewer_count,
            first_reviewed_at: snapshot.first_reviewed_at.map(Timestamp),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub status: TaskStatus,
    pub at: Timestamp,
    /// The change reopened the task: it follows a move to `done`.
    pub reopened: bool,
}

/// Milestones derived from a task's status history (see `docs/architecture.md`, Task
/// Timeline); `null` when not reached or not recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskMilestones {
    pub planned_at: Option<Timestamp>,
    pub started_at: Option<Timestamp>,
    pub review_at: Option<Timestamp>,
    /// The latest completion, unless the task was reopened after it.
    pub completed_at: Option<Timestamp>,
    /// The latest reopening of the task after it was done.
    pub reopened_at: Option<Timestamp>,
    /// The latest pause, unless the task was started again after it.
    pub paused_at: Option<Timestamp>,
    /// The latest move to `in_review`.
    pub last_review_at: Option<Timestamp>,
    /// Seconds spent in progress or in review up to the latest status change, pauses left
    /// out; the current period of an active task is not counted yet.
    #[specta(type = Number)]
    pub active_seconds: i64,
    /// How often the task was paused after work started.
    pub pause_count: u32,
}

impl From<timeline::Milestones> for TaskMilestones {
    fn from(milestones: timeline::Milestones) -> Self {
        Self {
            planned_at: milestones.planned_at.map(Timestamp),
            started_at: milestones.started_at.map(Timestamp),
            review_at: milestones.review_at.map(Timestamp),
            completed_at: milestones.completed_at.map(Timestamp),
            reopened_at: milestones.reopened_at.map(Timestamp),
            paused_at: milestones.paused_at.map(Timestamp),
            last_review_at: milestones.last_review_at.map(Timestamp),
            active_seconds: milestones.active_seconds,
            pause_count: milestones.pause_count,
        }
    }
}

impl From<&model::Task> for Task {
    fn from(task: &model::Task) -> Self {
        Self {
            id: task.id.into(),
            workspace_id: task.workspace_id.into(),
            task_type: task.task_type.into(),
            title: task.title.clone(),
            description: task.description.clone(),
            status: task.status.into(),
            resolution: task.resolution.map(TaskResolution::from),
            depends_on: task.depends_on.iter().copied().map(TaskId::from).collect(),
            branch: task.branch.clone(),
            worktree_path: task.worktree_path.as_ref().map(ToString::to_string),
            worktree_missing: task.branch.is_some()
                && task.worktree_path.is_none()
                && matches!(
                    task.status,
                    status::TaskStatus::InProgress | status::TaskStatus::InReview
                ),
            herdr_workspace_id: task.herdr_workspace_id.clone(),
            pull_request_url: task.pull_request_url.clone(),
            issue: task.issue.as_ref().map(LinkedIssue::from),
            estimate: task.estimate.map(Estimate::from),
            due_date: task.due_date.map(|due| due.to_string()),
            pull_request_merged_at: task.pull_request_merged_at.map(Timestamp),
            pull_request: task.pull_request.as_ref().map(PullRequestSnapshot::from),
            merged_with: task.merged_with.as_ref().map(|merged| MergedWith {
                task_id: merged.task_id.map(TaskId::from),
                pull_request_url: merged.pull_request_url.clone(),
            }),
            completion_note: task.completion_note.clone(),
            timeline: task
                .timeline
                .iter()
                .enumerate()
                .map(|(index, event)| TaskEvent {
                    status: event.status.into(),
                    at: Timestamp(event.at),
                    reopened: index > 0
                        && task.timeline[index - 1].status == status::TaskStatus::Done
                        && event.status != status::TaskStatus::Done,
                })
                .collect(),
            milestones: timeline::milestones(&task.timeline).into(),
            notes: map_all(&task.notes),
            criteria: map_all(&task.criteria),
        }
    }
}

/// What happened to a task during a reviewed period: the most advanced milestone it
/// reached in the period, or `worked_on` when it only got commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewOutcome {
    Completed,
    OpenedForReview,
    Started,
    WorkedOn,
    Planned,
}

impl From<review::Outcome> for ReviewOutcome {
    fn from(outcome: review::Outcome) -> Self {
        match outcome {
            review::Outcome::Completed => Self::Completed,
            review::Outcome::OpenedForReview => Self::OpenedForReview,
            review::Outcome::Started => Self::Started,
            review::Outcome::WorkedOn => Self::WorkedOn,
            review::Outcome::Planned => Self::Planned,
        }
    }
}

/// A task with activity in a reviewed period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEntry {
    pub task: Task,
    pub outcome: ReviewOutcome,
    /// Time of the outcome: the milestone, or the latest commit for `worked_on`.
    pub at: Timestamp,
    /// Commits of the task made in the period, oldest first.
    pub commits: Vec<CommitRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    pub workspace_id: WorkspaceId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub estimate: Option<Estimate>,
    /// `YYYY-MM-DD`; blank or `null` for none.
    pub due_date: Option<String>,
    /// Completion criteria in order; an `id` is not allowed here.
    pub criteria: Vec<CriterionInput>,
    /// Whether to put the merge criterion first: the task's pull request is merged, or,
    /// in a repository without an `origin` remote, its branch is merged into the base
    /// branch locally. Ignored when `criteria` already has one of those.
    pub merge_criterion: bool,
}

impl TryFrom<NewTask> for storage::NewTask {
    type Error = CommandError;

    fn try_from(new: NewTask) -> CommandResult<Self> {
        Ok(Self {
            workspace_id: new.workspace_id.into(),
            task_type: new.task_type.into(),
            title: required("task title", new.title)?,
            description: new.description,
            estimate: estimate(new.estimate)?,
            due_date: due_date(new.due_date.as_deref())?,
            criteria: new_criteria(&new.criteria)?,
        })
    }
}

/// The criteria of a new task, which cannot refer to existing ones.
fn new_criteria(inputs: &[CriterionInput]) -> CommandResult<Vec<criteria::NewCriterion>> {
    inputs
        .iter()
        .map(|input| match input.id {
            Some(id) => Err(CommandError::invalid_input(format!(
                "criterion {} cannot be given by id when creating a task",
                id.0
            ))),
            None => input.parse(),
        })
        .collect()
}

/// The fields of a task the user edits directly. Status, dependencies, and the
/// worktree, herdr, and pull request fields have their own commands or workflow steps.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskEdit {
    pub id: TaskId,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    /// `null` clears the estimate.
    pub estimate: Option<Estimate>,
    /// `YYYY-MM-DD`; blank or `null` clears the due date.
    pub due_date: Option<String>,
    /// The new completion criteria in order, which replace the current ones; `null`
    /// keeps them. The criteria of a done task cannot change.
    pub criteria: Option<Vec<CriterionInput>>,
    /// Whether to put the merge criterion of the task's repository first when the task
    /// is left without one (see [`NewTask::merge_criterion`]); false changes nothing.
    #[serde(default)]
    pub merge_criterion: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitRecord {
    pub task_id: TaskId,
    pub sha: String,
    pub message: String,
    pub author: String,
    /// Commit timestamp in seconds since the Unix epoch.
    #[specta(type = Number)]
    pub committed_at: i64,
}

impl From<&model::CommitRecord> for CommitRecord {
    fn from(record: &model::CommitRecord) -> Self {
        Self {
            task_id: record.task_id.into(),
            sha: record.sha.clone(),
            message: record.message.clone(),
            author: record.author.clone(),
            committed_at: record.committed_at,
        }
    }
}

/// What happened in the git history of a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ActivityKind {
    #[serde(rename = "commit")]
    Commit,
    #[serde(rename = "pr_opened")]
    PullRequestOpened,
    #[serde(rename = "checks_passed")]
    ChecksPassed,
    #[serde(rename = "checks_failed")]
    ChecksFailed,
    #[serde(rename = "pr_merged")]
    PullRequestMerged,
}

impl From<activity::ActivityKind> for ActivityKind {
    fn from(kind: activity::ActivityKind) -> Self {
        match kind {
            activity::ActivityKind::Commit => Self::Commit,
            activity::ActivityKind::PullRequestOpened => Self::PullRequestOpened,
            activity::ActivityKind::ChecksPassed => Self::ChecksPassed,
            activity::ActivityKind::ChecksFailed => Self::ChecksFailed,
            activity::ActivityKind::PullRequestMerged => Self::PullRequestMerged,
        }
    }
}

/// Where an activity event was first learned from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ActivitySource {
    #[serde(rename = "git_poll")]
    GitPoll,
    #[serde(rename = "github_poll")]
    GitHubPoll,
}

impl From<activity::ActivitySource> for ActivitySource {
    fn from(source: activity::ActivitySource) -> Self {
        match source {
            activity::ActivitySource::GitPoll => Self::GitPoll,
            activity::ActivitySource::GitHubPoll => Self::GitHubPoll,
        }
    }
}

/// One event of the git activity of a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivity {
    pub kind: ActivityKind,
    pub source: ActivitySource,
    /// The commit SHA of a commit or CI result, or the pull request URL.
    pub external_ref: String,
    pub title: String,
    pub author: Option<String>,
    /// When it happened, in seconds since the Unix epoch.
    #[specta(type = Number)]
    pub occurred_at: i64,
    /// When Toodo first stored it.
    #[specta(type = Number)]
    pub received_at: i64,
    /// The latest time any source reported it.
    #[specta(type = Number)]
    pub confirmed_at: i64,
}

impl From<&activity::RecordedActivity> for TaskActivity {
    fn from(recorded: &activity::RecordedActivity) -> Self {
        let event = &recorded.event;
        Self {
            kind: event.kind.into(),
            source: event.source.into(),
            external_ref: event.external_ref.clone(),
            title: event.title.clone(),
            author: event.author.clone(),
            occurred_at: event.occurred_at,
            received_at: recorded.received_at,
            confirmed_at: recorded.confirmed_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HerdrStatus {
    /// Whether the herdr server on this machine is running.
    pub running: bool,
    pub version: Option<String>,
}

impl From<&herdr::ServerStatus> for HerdrStatus {
    fn from(status: &herdr::ServerStatus) -> Self {
        Self {
            running: status.running,
            version: status.version.clone(),
        }
    }
}

/// What the agent working on a task in herdr is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
}

impl AgentStatus {
    /// `None` for panes without a recognized agent.
    pub fn from_herdr(status: herdr::AgentStatus) -> Option<Self> {
        match status {
            herdr::AgentStatus::Unknown => None,
            herdr::AgentStatus::Idle => Some(Self::Idle),
            herdr::AgentStatus::Done => Some(Self::Done),
            herdr::AgentStatus::Working => Some(Self::Working),
            herdr::AgentStatus::Blocked => Some(Self::Blocked),
        }
    }
}

/// A pane of a task's herdr workspace, for the pane view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskPane {
    pub pane_id: String,
    /// The agent herdr recognized in the pane, e.g. `claude`.
    pub agent: Option<String>,
    pub agent_status: Option<AgentStatus>,
    /// The pane's label, or else its terminal title.
    pub title: Option<String>,
}

impl From<&herdr::PaneAgent> for TaskPane {
    fn from(pane: &herdr::PaneAgent) -> Self {
        Self {
            pane_id: pane.pane_id.clone(),
            agent: pane.agent.clone(),
            agent_status: AgentStatus::from_herdr(pane.status),
            title: pane.title.clone(),
        }
    }
}

/// The agent status of a task whose herdr workspace has an agent, summarized over the
/// workspace's panes: blocked over working over done over idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgentStatus {
    pub task_id: TaskId,
    pub status: AgentStatus,
}

/// Combined result of the CI checks of a pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChecksStatus {
    Passing,
    Failing,
    Pending,
}

impl From<github::ChecksState> for ChecksStatus {
    fn from(state: github::ChecksState) -> Self {
        match state {
            github::ChecksState::Passing => Self::Passing,
            github::ChecksState::Failing => Self::Failing,
            github::ChecksState::Pending => Self::Pending,
        }
    }
}

/// Where the reviews of a pull request stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Approved,
    ChangesRequested,
    Pending,
}

impl From<github::ReviewState> for ReviewStatus {
    fn from(state: github::ReviewState) -> Self {
        match state {
            github::ReviewState::Approved => Self::Approved,
            github::ReviewState::ChangesRequested => Self::ChangesRequested,
            github::ReviewState::Pending => Self::Pending,
        }
    }
}

/// CI and review state of the open pull request of an `in_review` task, as of the last
/// background check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskPullRequestStatus {
    pub task_id: TaskId,
    /// `null` when the pull request has no checks.
    pub checks: Option<ChecksStatus>,
    pub review: ReviewStatus,
}

impl TaskPullRequestStatus {
    pub fn new(task: model::TaskId, status: github::PullRequestStatus) -> Self {
        Self {
            task_id: task.into(),
            checks: status.checks.map(Into::into),
            review: status.review.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettings {
    pub enabled: bool,
    pub interval_hours: u32,
    /// Number of automatic backups kept; older ones are deleted.
    pub keep: u32,
}

impl TryFrom<BackupSettings> for backup::BackupSettings {
    type Error = CommandError;

    fn try_from(settings: BackupSettings) -> CommandResult<Self> {
        Self {
            enabled: settings.enabled,
            interval_hours: settings.interval_hours,
            keep: settings.keep,
        }
        .validate()
        .map_err(|error| CommandError::invalid_input(error.to_string()))
    }
}

impl From<backup::BackupSettings> for BackupSettings {
    fn from(settings: backup::BackupSettings) -> Self {
        Self {
            enabled: settings.enabled,
            interval_hours: settings.interval_hours,
            keep: settings.keep,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    Automatic,
    PreRestore,
}

/// A backup in Toodo's backup directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: String,
    pub kind: BackupKind,
    pub created_at: Timestamp,
    #[specta(type = Number)]
    pub size_bytes: u64,
}

impl From<&storage::BackupFile> for BackupEntry {
    fn from(file: &storage::BackupFile) -> Self {
        Self {
            path: file.path.display().to_string(),
            kind: match file.kind {
                backup::BackupKind::Automatic => BackupKind::Automatic,
                backup::BackupKind::PreRestore => BackupKind::PreRestore,
            },
            created_at: Timestamp(file.created_at),
            size_bytes: file.size_bytes,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct RunId(#[specta(type = Number)] pub i64);

impl From<RunId> for domain_runtime::RunId {
    fn from(id: RunId) -> Self {
        Self(id.0)
    }
}

impl From<domain_runtime::RunId> for RunId {
    fn from(id: domain_runtime::RunId) -> Self {
        Self(id.0)
    }
}

/// The agent CLI a plain run drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentAdapter {
    /// Claude Code in print mode (`claude -p`).
    Claude,
    /// Codex in exec mode (`codex exec`).
    Codex,
}

/// What the server can run tasks with: herdr for herdr workspaces, and the agent CLIs of
/// plain runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunnerHealth {
    pub herdr: HerdrHealth,
    /// tmux for local workspaces with runner tmux.
    pub tmux: TmuxHealth,
    /// Claude, then Codex.
    pub agents: Vec<AgentHealth>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TmuxHealth {
    /// Whether `tmux -V` ran from the server's `PATH`.
    pub installed: bool,
    /// The version `tmux -V` printed, such as `tmux 3.4`.
    pub version: Option<String>,
    /// What to do next when tmux cannot run; `None` when it can.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HerdrHealth {
    /// Whether herdr could be run from the server's `PATH`.
    pub installed: bool,
    /// Whether the herdr server on this machine is running.
    pub running: bool,
    pub version: Option<String>,
    /// Why herdr is not usable and what to do next; `None` while it is running.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealth {
    pub adapter: AgentAdapter,
    /// Whether the adapter's CLI is an executable on the server's `PATH`.
    pub installed: bool,
    /// Absolute path of the CLI found on `PATH`.
    pub path: Option<String>,
    /// What to do next when the CLI is missing; `None` when it is installed.
    pub message: Option<String>,
}

impl From<AgentAdapter> for plain::adapter::AgentAdapter {
    fn from(adapter: AgentAdapter) -> Self {
        match adapter {
            AgentAdapter::Claude => Self::Claude,
            AgentAdapter::Codex => Self::Codex,
        }
    }
}

/// Where a run is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Recorded, not launched yet.
    Reserved,
    /// Launched and not ended.
    Running,
    /// Ended with a successful result.
    Settled,
    /// Ended on its own, or ended after its result without success.
    Exited,
    /// Ended with an error result, without a result, or past its time limit.
    Failed,
    /// Stopped on request.
    Cancelled,
    /// Its end was not observed, e.g. the server restarted while it ran.
    Unknown,
}

impl From<domain_runtime::RunState> for RunState {
    fn from(state: domain_runtime::RunState) -> Self {
        match state {
            domain_runtime::RunState::Reserved => Self::Reserved,
            domain_runtime::RunState::Running => Self::Running,
            domain_runtime::RunState::Settled => Self::Settled,
            domain_runtime::RunState::Exited => Self::Exited,
            domain_runtime::RunState::Failed => Self::Failed,
            domain_runtime::RunState::Cancelled => Self::Cancelled,
            domain_runtime::RunState::Unknown => Self::Unknown,
        }
    }
}

/// A run of a task: an agent launch and its outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: RunId,
    pub task_id: TaskId,
    pub request_key: String,
    /// Increases from 1 per task.
    #[specta(type = Number)]
    pub generation: i64,
    /// `plain`, `tmux`, `herdr`, or `none`.
    pub runner_kind: String,
    /// `writer` or `observer`.
    pub role: String,
    /// The agent CLI of a plain run: `claude` or `codex`.
    pub adapter: Option<String>,
    pub checkout_path: Option<String>,
    pub state: RunState,
    /// The runner's reference of the launch, e.g. `pid:<pid>` for a plain run.
    pub provider_run_ref: Option<String>,
    pub created_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
}

impl From<&storage::TaskRun> for TaskRun {
    fn from(run: &storage::TaskRun) -> Self {
        Self {
            id: run.id.into(),
            task_id: run.task.into(),
            request_key: run.request_key.clone(),
            generation: run.generation,
            runner_kind: run.runner_kind.as_wire().to_owned(),
            role: run.role.as_wire().to_owned(),
            adapter: run.adapter_profile.clone(),
            checkout_path: run.checkout_path.clone(),
            state: run.state.into(),
            provider_run_ref: run.provider_run_ref.clone(),
            created_at: Timestamp(run.created_at),
            started_at: run.started_at.map(Timestamp),
            ended_at: run.ended_at.map(Timestamp),
        }
    }
}

/// Something observed about a run, e.g. its result or how it exited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    /// Increases from 1 per run.
    #[specta(type = Number)]
    pub sequence: i64,
    pub kind: String,
    pub payload: Option<String>,
    pub observed_at: Timestamp,
}

impl From<&storage::RunEvent> for RunEvent {
    fn from(event: &storage::RunEvent) -> Self {
        Self {
            sequence: event.sequence,
            kind: event.kind.clone(),
            payload: event.payload.clone(),
            observed_at: Timestamp(event.observed_at),
        }
    }
}

/// A run with its events and the ends of its output, with the MCP token redacted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunLog {
    pub run: TaskRun,
    pub events: Vec<RunEvent>,
    pub stdout: String,
    pub stderr: String,
    /// For an active tmux run, the shell command that attaches a terminal to its session.
    pub attach: Option<String>,
}

pub(crate) fn map_all<'a, T: 'a, U: From<&'a T>>(items: &'a [T]) -> Vec<U> {
    items.iter().map(U::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::CommandErrorKind;

    /// A local path as entered, its normalized form, and a path of the other kind: local
    /// paths are POSIX paths on the server.
    const LOCAL: (&str, &str, &str) = ("/home/me/toodo/", "/home/me/toodo", r"C:\dev\toodo");

    #[test]
    fn local_location_is_normalized() {
        let (entered, normalized, _) = LOCAL;
        let location = model::WorkspaceLocation::try_from(WorkspaceLocation::Local {
            path: entered.to_owned(),
        })
        .unwrap();
        assert_eq!(
            WorkspaceLocation::from(&location),
            WorkspaceLocation::Local {
                path: normalized.to_owned()
            }
        );
    }

    #[test]
    fn location_paths_must_match_the_machine() {
        let cases = [
            WorkspaceLocation::Local {
                path: LOCAL.2.to_owned(),
            },
            WorkspaceLocation::Ssh {
                machine: "devbox".to_owned(),
                path: r"dev\toodo".to_owned(),
            },
            WorkspaceLocation::Ssh {
                machine: "devbox".to_owned(),
                path: "~/toodo".to_owned(),
            },
            WorkspaceLocation::Ssh {
                machine: " ".to_owned(),
                path: "/home/me/toodo".to_owned(),
            },
        ];
        for location in cases {
            let error = model::WorkspaceLocation::try_from(location).unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        }
    }

    #[test]
    fn ssh_locations_take_windows_paths_of_windows_hosts() {
        for (raw, normalized) in [
            (r" D:/dev/toodo/ ", r"D:\dev\toodo"),
            (r"\\nas\src\toodo", r"\\nas\src\toodo"),
            ("/home/me/toodo/", "/home/me/toodo"),
        ] {
            let location = model::WorkspaceLocation::try_from(WorkspaceLocation::Ssh {
                machine: "winpc".to_owned(),
                path: raw.to_owned(),
            })
            .unwrap();
            assert_eq!(
                WorkspaceLocation::from(&location),
                WorkspaceLocation::Ssh {
                    machine: "winpc".to_owned(),
                    path: normalized.to_owned(),
                }
            );
            assert_eq!(PathProblem::of(&location), None);
        }
        let settings = model::MachineSettings::try_from(MachineSettings {
            machine: Machine::Ssh {
                label: "winpc".to_owned(),
            },
            worktree_root: Some(r"D:\wt\".to_owned()),
        })
        .unwrap();
        assert_eq!(
            MachineSettings::from(&settings).worktree_root.as_deref(),
            Some(r"D:\wt")
        );
    }

    fn new_workspace(
        name: &str,
        repository: Option<RepositorySetup>,
        branch: Option<&str>,
    ) -> NewWorkspace {
        NewWorkspace {
            name: name.to_owned(),
            location: WorkspaceLocation::Local {
                path: LOCAL.1.to_owned(),
            },
            repository,
            source: None,
            completion: None,
            runner: None,
            default_base_branch: branch.map(str::to_owned),
        }
    }

    #[test]
    fn new_workspace_requires_a_name_and_a_clone_url() {
        let new = |name: &str, repository: RepositorySetup, branch: Option<&str>| {
            new_workspace(name, Some(repository), branch)
        };
        let clone = |url: &str| RepositorySetup::Clone {
            url: url.to_owned(),
        };
        let parsed =
            WorkspaceSetup::try_from(new(" toodo ", clone(" git@h:a.git "), Some(" main ")))
                .unwrap();
        assert_eq!(parsed.name, "toodo");
        assert_eq!(parsed.repository, Some(clone("git@h:a.git")));
        assert_eq!(parsed.source, None);
        assert_eq!(parsed.default_base_branch.as_deref(), Some("main"));
        let blank_branch =
            WorkspaceSetup::try_from(new("toodo", RepositorySetup::Open, Some(" "))).unwrap();
        assert_eq!(blank_branch.default_base_branch, None);
        for invalid in [
            new("  ", RepositorySetup::Open, None),
            new("toodo", clone(" "), None),
        ] {
            let error = WorkspaceSetup::try_from(invalid).unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        }
    }

    #[test]
    fn new_workspace_matches_its_repository_to_its_source() {
        let without_repository =
            WorkspaceSetup::try_from(new_workspace("notes", None, None)).unwrap();
        assert_eq!(without_repository.source, Some(model::Source::None));
        let with = |repository: Option<RepositorySetup>, source: Source| NewWorkspace {
            source: Some(source),
            ..new_workspace("toodo", repository, None)
        };
        let local =
            WorkspaceSetup::try_from(with(Some(RepositorySetup::Init), Source::LocalGit)).unwrap();
        assert_eq!(local.source, Some(model::Source::LocalGit));
        for (invalid, message) in [
            (
                with(Some(RepositorySetup::Open), Source::None),
                "source none has no repository; omit repository, or choose source local_git \
                 or github to open, clone, or init one",
            ),
            (
                with(None, Source::GitHub),
                "source github needs a repository; set repository to open, clone, or init \
                 one, or choose source none for a plain directory",
            ),
            (
                with(Some(RepositorySetup::Init), Source::GitHub),
                "a new repository has no origin remote for source github; choose source \
                 local_git for a new repository, or clone the GitHub repository instead",
            ),
        ] {
            let error = WorkspaceSetup::try_from(invalid).unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::InvalidInput);
            assert_eq!(error.message, message);
        }
    }

    #[test]
    fn machine_settings_parse_the_root_for_their_machine() {
        let settings = model::MachineSettings::try_from(MachineSettings {
            machine: Machine::Ssh {
                label: "devbox".to_owned(),
            },
            worktree_root: Some("/srv/worktrees/".to_owned()),
        })
        .unwrap();
        assert_eq!(
            MachineSettings::from(&settings),
            MachineSettings {
                machine: Machine::Ssh {
                    label: "devbox".to_owned()
                },
                worktree_root: Some("/srv/worktrees".to_owned()),
            }
        );
        let error = model::MachineSettings::try_from(MachineSettings {
            machine: Machine::Local,
            worktree_root: Some(LOCAL.2.to_owned()),
        })
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }

    #[test]
    fn serialized_shapes_use_the_frontend_names() {
        let location = serde_json::to_value(WorkspaceLocation::Ssh {
            machine: "devbox".to_owned(),
            path: "/srv/toodo".to_owned(),
        })
        .unwrap();
        assert_eq!(
            location,
            serde_json::json!({ "kind": "ssh", "machine": "devbox", "path": "/srv/toodo" })
        );
        assert_eq!(
            serde_json::to_value(TaskStatus::InProgress).unwrap(),
            "in_progress"
        );
        let edit: TaskEdit = serde_json::from_value(serde_json::json!({
            "id": 7, "taskType": "refactor", "title": "Split storage", "description": ""
        }))
        .unwrap();
        assert_eq!(edit.id, TaskId(7));
        assert_eq!(edit.task_type, TaskType::Refactor);
        let new: NewWorkspace = serde_json::from_value(serde_json::json!({
            "name": "toodo",
            "location": { "kind": "local", "path": r"C:\dev\toodo" },
            "repository": { "kind": "clone", "url": "git@h:a.git" },
            "source": "github",
            "completion": "pr_merge",
            "runner": "herdr",
            "defaultBaseBranch": null
        }))
        .unwrap();
        assert_eq!(
            new.repository,
            Some(RepositorySetup::Clone {
                url: "git@h:a.git".to_owned()
            })
        );
        assert_eq!(
            (new.source, new.completion, new.runner),
            (
                Some(Source::GitHub),
                Some(CompletionMode::PullRequestMerge),
                Some(Runner::Herdr)
            )
        );
        assert_eq!(
            serde_json::to_value([Source::None, Source::LocalGit, Source::GitHub]).unwrap(),
            serde_json::json!(["none", "local_git", "github"])
        );
        assert_eq!(
            serde_json::to_value([
                CompletionMode::Manual,
                CompletionMode::LocalMerge,
                CompletionMode::PullRequestMerge
            ])
            .unwrap(),
            serde_json::json!(["manual", "local_merge", "pr_merge"])
        );
        assert_eq!(
            serde_json::to_value([Runner::None, Runner::Herdr, Runner::Plain, Runner::Tmux])
                .unwrap(),
            serde_json::json!(["none", "herdr", "plain", "tmux"])
        );
    }
}
