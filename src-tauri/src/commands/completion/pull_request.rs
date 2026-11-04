use super::settle::branch_commits;
use crate::adapters::git::{Git, GitError};
use crate::adapters::github::{
    GitHub, NewPullRequest, PullRequest, PullRequestRefusal, PullRequestState,
};
use crate::commands::{CommandError, CommandErrorCode, CommandResult, StorageState, lock};
use crate::domain::issue::{closes_issue, with_closing_reference};
use crate::domain::model::{self, WorkspaceLocation};
use crate::domain::remote::GitHubRepository;
use crate::domain::status::TaskStatus;
use crate::storage::StorageError;

/// An `in_progress` or `in_review` task with the workspace repository its git commands
/// run in.
pub(in crate::commands) struct Checkout {
    pub(in crate::commands) task: model::Task,
    pub(in crate::commands) location: WorkspaceLocation,
    pub(in crate::commands) base: String,
    pub(in crate::commands) branch: String,
    pub(in crate::commands) repository: String,
}

pub(in crate::commands) fn checkout(
    storage: &StorageState,
    git: &Git,
    id: model::TaskId,
) -> CommandResult<Checkout> {
    let stored = lock(storage);
    let mut task = stored.get_task(id)?.ok_or(StorageError::TaskNotFound(id))?;
    if !matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview) {
        return Err(CommandError::rejected(format!(
            "task {id} is {}; only an in_progress or in_review task can record commits or open a pull request",
            task.status
        )));
    }
    let workspace = stored
        .get_workspace(task.workspace_id)?
        .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
    let Some(branch) = task.branch.clone() else {
        if workspace.runner == model::Runner::None {
            return Err(CommandError::rejected(format!(
                "task {id} belongs to workspace {}, which runs tasks without herdr (runner none), so it has no branch to record commits from, push, or open a pull request for; complete it with complete_task once its criteria are met",
                workspace.name
            )));
        }
        return Err(CommandError::rejected(format!(
            "task {id} has no branch; start it in the Toodo app first"
        )));
    };
    drop(stored);
    if clear_missing_worktree(storage, git, &task, &workspace)? {
        task = lock(storage)
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
    }
    let repository = match &workspace.location {
        WorkspaceLocation::Local { path } | WorkspaceLocation::Ssh { path, .. } => path.to_string(),
    };
    Ok(Checkout {
        task,
        location: workspace.location,
        base: workspace.default_base_branch,
        branch,
        repository,
    })
}

/// Clears only the checkout that was inspected, not one restored while git ran.
pub(in crate::commands) fn clear_missing_worktree(
    storage: &StorageState,
    git: &Git,
    task: &model::Task,
    workspace: &model::Workspace,
) -> CommandResult<bool> {
    let Some(path) = &task.worktree_path else {
        return Ok(false);
    };
    if git.worktree_exists(&workspace.location, path)? {
        return Ok(false);
    }
    let mut storage = lock(storage);
    let current = storage
        .get_task(task.id)?
        .ok_or(StorageError::TaskNotFound(task.id))?;
    if current.worktree_path != task.worktree_path
        || current.herdr_workspace_id != task.herdr_workspace_id
    {
        return Ok(false);
    }
    storage.clear_task_worktree(task.id)?;
    Ok(true)
}

fn commit_records(git: &Git, checkout: &Checkout) -> CommandResult<Vec<model::CommitRecord>> {
    let commits = git.commits_between(
        &checkout.location,
        &checkout.repository,
        &checkout.base,
        &checkout.branch,
    )?;
    Ok(commits
        .into_iter()
        .map(|commit| model::CommitRecord {
            task_id: checkout.task.id,
            sha: commit.sha,
            message: commit.message,
            author: commit.author,
            committed_at: commit.committed_at,
        })
        .collect())
}

pub(super) fn refresh(
    storage: &StorageState,
    git: &Git,
    id: model::TaskId,
) -> CommandResult<Vec<model::CommitRecord>> {
    let checkout = checkout(storage, git, id)?;
    let records = commit_records(git, &checkout)?;
    lock(storage).replace_commit_records(id, &records)?;
    Ok(records)
}

pub(super) fn open(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    let checkout = checkout(storage, git, id)?;
    let records = commit_records(git, &checkout)?;
    let origin = git
        .origin_url(&checkout.location, &checkout.repository)
        .map_err(|error| match &error {
            GitError::Failed { stderr, .. } if stderr.contains("No such remote") => {
                CommandError::rejected(format!(
                    "the repository has no origin remote, so there is no pull request to open; merge {} into {} locally to complete the task",
                    checkout.branch, checkout.base
                ))
            }
            _ => error.into(),
        })?;
    let repository = GitHubRepository::from_remote_url(&origin).ok_or_else(|| {
        CommandError::rejected(format!(
            "remote origin {origin:?} is not a GitHub repository; pull requests are opened on GitHub only"
        ))
    })?;
    // A closed pull request is not reused: a new one is opened into the right base.
    let existing = github
        .find_pull_request(&repository, &checkout.branch, &checkout.base)?
        .filter(|pull_request| pull_request.state != PullRequestState::Closed);
    if let Some(pull_request) = &existing {
        check_base(pull_request, &checkout.base)?;
    }
    if let Some(PullRequest {
        url,
        state: PullRequestState::Merged,
        merged_at,
        ..
    }) = existing
    {
        // After the merge the base may already contain the branch, so its log can be
        // empty; keep the commits recorded before in that case.
        let mut storage = lock(storage);
        let records = if records.is_empty() {
            storage.list_commit_records(id)?
        } else {
            records
        };
        return Ok(storage.open_pull_request(id, &records, &url, merged_at)?);
    }
    if records.is_empty() {
        return Err(CommandError::rejected(format!(
            "branch {} has no commits that are not on {}; commit the work before opening a pull request",
            checkout.branch, checkout.base
        )));
    }
    git.push_branch(&checkout.location, &checkout.repository, &checkout.branch)?;
    let issue = checkout.task.issue.as_ref();
    let pull_request_url = match existing {
        Some(pull_request) => {
            if let Some(issue) = issue {
                ensure_closing_reference(github, &pull_request.url, issue)?;
            }
            pull_request.url
        }
        None => {
            let body = match issue {
                Some(issue) => with_closing_reference(&checkout.task.description, issue.number),
                None => checkout.task.description.clone(),
            };
            let options =
                lock(storage).workspace_pull_request_options(checkout.task.workspace_id)?;
            github
                .create_pull_request(&NewPullRequest {
                    repository: &repository,
                    head: &checkout.branch,
                    base: &checkout.base,
                    title: &checkout.task.title,
                    body: &body,
                    options: &options,
                })
                .map_err(|error| creation_error(error, &repository, &checkout))?
        }
    };
    Ok(lock(storage).open_pull_request(id, &records, &pull_request_url, None)?)
}

/// The error of a pull request GitHub did not open, with a code for why and the step that
/// fixes it. GitHub may open the pull request and then refuse a reviewer, so every
/// retry first looks for one from the branch and records it.
fn creation_error(
    error: GitError,
    repository: &GitHubRepository,
    checkout: &Checkout,
) -> CommandError {
    let Some(refusal) = PullRequestRefusal::of(&error) else {
        return match error {
            GitError::Failed { .. } => CommandError::new(
                CommandErrorCode::PullRequestFailed,
                format!(
                    "{error}; check that {repository} accepts pull requests from {} into {}, then open the pull request again",
                    checkout.branch, checkout.base
                ),
            ),
            error => error.into(),
        };
    };
    let fix_options = "change the workspace's pull request options (Pull requests in the workspace header, or set_workspace_pull_request_options), then open the pull request again";
    let (code, reason) = match refusal {
        PullRequestRefusal::NotLoggedIn => (
            CommandErrorCode::GitHubAuthFailed,
            "gh is not logged in to GitHub: run `gh auth login` as the user that runs toodo-server, then open the pull request again".to_owned(),
        ),
        PullRequestRefusal::PermissionDenied => (
            CommandErrorCode::GitHubAuthFailed,
            format!("the gh login may not open pull requests in {repository}: log gh in as a user with write access to it (`gh auth login`), then open the pull request again"),
        ),
        PullRequestRefusal::InvalidReviewer => (
            CommandErrorCode::PullRequestOptionInvalid,
            format!("GitHub refused a reviewer: every reviewer must be a user or org/team with access to {repository} other than the author; {fix_options}"),
        ),
        PullRequestRefusal::UnknownLabel => (
            CommandErrorCode::PullRequestOptionInvalid,
            format!("a label does not exist in {repository}: create it on GitHub or remove it; {fix_options}"),
        ),
        PullRequestRefusal::DraftUnsupported => (
            CommandErrorCode::PullRequestOptionInvalid,
            format!("{repository} does not allow draft pull requests: turn off draft; {fix_options}"),
        ),
        PullRequestRefusal::AlreadyExists => (
            CommandErrorCode::PullRequestFailed,
            format!("a pull request from {} into {} is already open: open the pull request again to record it", checkout.branch, checkout.base),
        ),
        PullRequestRefusal::NoCommits => (
            CommandErrorCode::PullRequestFailed,
            format!("GitHub sees no commits on {} that are not on {}: push the branch's commits, then open the pull request again", checkout.branch, checkout.base),
        ),
    };
    CommandError::new(code, format!("{reason} ({error})"))
}

/// Appends a closing reference to `issue` to the body of the open pull request at `url`
/// unless the body already has one, so merging the pull request closes the issue.
pub(in crate::commands) fn ensure_closing_reference(
    github: &dyn GitHub,
    url: &str,
    issue: &model::LinkedIssue,
) -> CommandResult<()> {
    let body = github.pull_request_body(url)?;
    if !closes_issue(&body, issue.number) {
        github.edit_pull_request_body(url, &with_closing_reference(&body, issue.number))?;
    }
    Ok(())
}

/// Rejects a pull request that does not merge into the workspace's base branch: the
/// worktrees of dependent tasks start from that branch, so they would miss the work.
pub(super) fn check_base(pull_request: &PullRequest, base: &str) -> CommandResult<()> {
    if pull_request.base == base {
        return Ok(());
    }
    Err(CommandError::rejected(format!(
        "pull request {} merges into {}, not the workspace base branch {base}; dependent tasks start from {base}, so retarget it or open a new one",
        pull_request.url, pull_request.base
    )))
}

/// The preferred pull request from `branch` into the workspace base branch.
/// A repository without a GitHub origin has none.
pub(super) fn branch_pull_request(
    git: &Git,
    github: &dyn GitHub,
    workspace: &model::Workspace,
    branch: &str,
) -> CommandResult<Option<PullRequest>> {
    let location = &workspace.location;
    if !git.has_origin(location)? {
        return Ok(None);
    }
    let path = match location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    };
    let origin = git.origin_url(location, path)?;
    let Some(repository) = GitHubRepository::from_remote_url(&origin) else {
        return Ok(None);
    };
    Ok(github.find_pull_request(&repository, branch, &workspace.default_base_branch)?)
}

/// Records an open or merged pull request opened outside Toodo for an active task,
/// including one without a worktree, and moves it to (or keeps it in) `in_review`.
/// Nothing is pushed. A branch without a pull request, or with a closed one only,
/// leaves the task as it is.
pub(super) fn adopt_pull_request(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    id: model::TaskId,
) -> CommandResult<Option<model::Task>> {
    let (task, workspace) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        (task, workspace)
    };
    if !matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview) {
        return Ok(None);
    }
    let Some(branch) = &task.branch else {
        return Ok(None);
    };
    let Some(pull_request) = branch_pull_request(git, github, &workspace, branch)?
        .filter(|pull_request| pull_request.state != PullRequestState::Closed)
    else {
        return Ok(None);
    };
    check_base(&pull_request, &workspace.default_base_branch)?;
    let records = if task.worktree_path.is_some() {
        branch_commits(git, &task, &workspace)?
    } else {
        Vec::new()
    };
    let mut storage = lock(storage);
    // The task may have been paused while git and gh ran.
    let task = storage
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    if !matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview)
        || task.pull_request_url.is_some()
    {
        return Ok(None);
    }
    // After a merge the base may already contain the branch, so its log can be empty;
    // keep the commits recorded before in that case.
    let records = if records.is_empty() {
        storage.list_commit_records(id)?
    } else {
        records
    };
    Ok(Some(storage.open_pull_request(
        id,
        &records,
        &pull_request.url,
        pull_request.merged_at,
    )?))
}
