use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{WorkspaceId, local_path, machine_label, remote_path, required};
use crate::adapters::{git, github, herdr, ssh};
use crate::commands::{CommandError, CommandResult};
use crate::domain::{model, ssh_config};

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
    /// How its tasks get done.
    pub completion: CompletionMode,
    /// What runs started tasks.
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
    /// The workspace with its settings from this one and the location and source of
    /// `stored`, the saved workspace: the location only changes by moving it, the source
    /// never after creation. The default base branch may be empty only for source none,
    /// which has no repository; completion and runner must work with the source and the
    /// location (see [`model::check_axes`] and [`model::check_runner_location`]).
    pub(crate) fn into_model(self, stored: &model::Workspace) -> CommandResult<model::Workspace> {
        let default_base_branch = match stored.source {
            model::Source::None => self.default_base_branch.trim().to_owned(),
            model::Source::LocalGit | model::Source::GitHub => {
                required("default base branch", self.default_base_branch)?
            }
        };
        let (completion, runner) = (self.completion.into(), self.runner.into());
        model::check_axes(stored.source, completion, runner)
            .and_then(|()| model::check_runner_location(runner, &stored.location))
            .map_err(|error| CommandError::invalid_input(error.0))?;
        Ok(model::Workspace {
            id: self.id.into(),
            name: required("workspace name", self.name)?,
            location: stored.location.clone(),
            default_base_branch,
            agent_merge: self.agent_merge.into(),
            source: stored.source,
            completion,
            runner,
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

/// What testing the connection to an SSH machine found: Toodo connects without a prompt and
/// git runs there, or a problem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshMachineCheck {
    /// `git --version` on the machine, e.g. `git version 2.43.0`; `None` when the test failed.
    pub git_version: Option<String>,
    /// What failed and the next step that fixes it; `None` when the test passed.
    pub problem: Option<String>,
}

impl From<ssh::MachineCheck> for SshMachineCheck {
    fn from(check: ssh::MachineCheck) -> Self {
        match check {
            ssh::MachineCheck::Ready { git_version } => Self {
                git_version: Some(git_version),
                problem: None,
            },
            ssh::MachineCheck::Problem(problem) => Self {
                git_version: None,
                problem: Some(problem),
            },
        }
    }
}

/// A host appended to the SSH config, and the connection test run on it right after.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddedSshHost {
    /// Host aliases of the updated config.
    pub hosts: Vec<String>,
    pub check: SshMachineCheck,
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
