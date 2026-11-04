use super::pull_request::{branch_pull_request, check_base};
use super::settle::branch_commits;
use crate::adapters::git::Git;
use crate::adapters::github::{GitHub, PullRequestState};
use crate::adapters::herdr::Herdr;
use crate::commands::{CommandError, CommandResult, StorageState, lock};
use crate::domain::model;
use crate::domain::status::TaskStatus;
use crate::runtime::RuntimeService;
use crate::storage::StorageError;

/// What concluding does with a pull request of the task that is still open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenPullRequest {
    /// Close it with the conclusion as a comment, as the app does.
    Close,
    /// Reject the conclusion and leave the pull request and the task as they are, as
    /// agents do through MCP: closing a pull request stays a decision for the user.
    Reject,
}

pub(crate) fn conclude(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    herdr: &Herdr,
    id: model::TaskId,
    note: &str,
    open_pull_request: OpenPullRequest,
) -> CommandResult<model::Task> {
    let note = note.trim();
    if note.is_empty() {
        return Err(CommandError::invalid_input(
            "a conclusion must say why the work is not adopted",
        ));
    }
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
        return Err(CommandError::rejected(format!(
            "task {id} is {}; only an in_progress or in_review task can be concluded without merging",
            task.status
        )));
    }
    // An empty branch log keeps the commits recorded before.
    let records = branch_commits(git, &task, &workspace)?;
    // The pull requests of the branch on GitHub decide, not only the recorded one: an
    // agent may have opened one that the background check has not adopted yet.
    let pull_request = match &task.branch {
        Some(branch) => branch_pull_request(git, github, &workspace, branch)?,
        None => None,
    };
    if let Some(merged) = pull_request
        .as_ref()
        .filter(|pull_request| pull_request.state == PullRequestState::Merged)
    {
        return Err(CommandError::rejected(format!(
            "pull request {} was merged; call complete_task without merged_with so the task completes with the merge instead",
            merged.url
        )));
    }
    let closed = match pull_request
        .as_ref()
        .filter(|pull_request| pull_request.state == PullRequestState::Open)
    {
        None => None,
        Some(open) => match open_pull_request {
            OpenPullRequest::Close => {
                github.close_pull_request(&open.url, note)?;
                Some(open.url.as_str())
            }
            OpenPullRequest::Reject => {
                return Err(CommandError::rejected(format!(
                    "pull request {} is still open; concluding through MCP never closes a pull request, so the user concludes this task in the Toodo app, which closes it with the conclusion as a comment",
                    open.url
                )));
            }
        },
    };
    let machine = workspace.location.machine();
    Ok(
        RuntimeService.close_workspace(storage, herdr, id, &machine, |storage| {
            storage.conclude_task(id, note, &records, closed)
        })?,
    )
}

/// The merged pull request that shipped the work of a task without a pull request of its
/// own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MergedWithTarget {
    /// The pull request of this task, which is `done` as merged.
    Task(model::TaskId),
    /// A pull request into the workspace base branch, by URL.
    PullRequest(String),
}

/// Completes a task whose work shipped with the merged pull request of another task,
/// e.g. one pull request that fixed several tasks: an `in_progress` or `in_review` task,
/// or one already `done` as `not_adopted`, becomes `done` as merged through `target`. For
/// a task being worked on, the commits of its branch are recorded and its herdr workspace
/// is closed; a merged or open pull request of its own branch rejects it, as it completes
/// with its own pull request or is still under review.
pub(crate) fn complete_merged_with(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    herdr: &Herdr,
    id: model::TaskId,
    target: MergedWithTarget,
) -> CommandResult<model::Task> {
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
    let not_adopted = task.resolution == Some(model::TaskResolution::NotAdopted);
    match task.status {
        TaskStatus::InProgress | TaskStatus::InReview => {}
        TaskStatus::Done if not_adopted => {}
        TaskStatus::Done => {
            let resolution = task
                .resolution
                .map_or("done", model::TaskResolution::as_str);
            return Err(CommandError::rejected(format!(
                "task {id} is already done as {resolution}; there is nothing left to complete; to correct how it ended, change its outcome in the Toodo app"
            )));
        }
        status => {
            return Err(CommandError::rejected(format!(
                "task {id} is {status}; only an in_progress, in_review, or not_adopted task can be completed through another task's pull request"
            )));
        }
    }
    let (merged_with, resolution, merged_at) = match target {
        MergedWithTarget::Task(other) => {
            if other == id {
                return Err(CommandError::invalid_input(format!(
                    "task {id} cannot be merged with itself; complete_task without merged_with completes a task with its own pull request"
                )));
            }
            let other = lock(storage)
                .get_task(other)?
                .ok_or(StorageError::TaskNotFound(other))?;
            shipped_by(&other)?
        }
        MergedWithTarget::PullRequest(url) => {
            let url = url.trim();
            if task.pull_request_url.as_deref() == Some(url) {
                return Err(CommandError::rejected(format!(
                    "pull request {url} is the task's own; complete_task without merged_with completes a task with its own pull request"
                )));
            }
            let pull_request = github.pull_request(url)?.pull_request;
            check_base(&pull_request, &workspace.default_base_branch)?;
            match pull_request.state {
                PullRequestState::Merged => {}
                PullRequestState::Open => {
                    return Err(CommandError::rejected(format!(
                        "pull request {} is not merged yet; complete the task through it once it is merged",
                        pull_request.url
                    )));
                }
                PullRequestState::Closed => {
                    return Err(CommandError::rejected(format!(
                        "pull request {} was closed without merging, so it shipped nothing",
                        pull_request.url
                    )));
                }
            }
            let task_id = lock(storage)
                .list_tasks(task.workspace_id)?
                .into_iter()
                .find(|other| {
                    other.id != id
                        && other
                            .pull_request_url
                            .as_deref()
                            .is_some_and(|own| own == url || own == pull_request.url)
                })
                .map(|other| other.id);
            let merged = model::MergedWith {
                task_id,
                pull_request_url: Some(pull_request.url),
            };
            (
                merged,
                model::TaskResolution::Merged,
                pull_request.merged_at,
            )
        }
    };
    if not_adopted {
        // Concluding already recorded its commits and closed its workspace.
        return Ok(lock(storage).complete_task_merged_with(
            id,
            &merged_with,
            resolution,
            merged_at,
            &[],
        )?);
    }
    // An empty branch log keeps the commits recorded before.
    let records = branch_commits(git, &task, &workspace)?;
    if let Some(branch) = &task.branch
        && let Some(pull_request) = branch_pull_request(git, github, &workspace, branch)?
    {
        match pull_request.state {
            PullRequestState::Merged => {
                return Err(CommandError::rejected(format!(
                    "pull request {} of the task's own branch was merged; complete_task without merged_with completes the task with it",
                    pull_request.url
                )));
            }
            PullRequestState::Open => {
                return Err(CommandError::rejected(format!(
                    "pull request {} of the task's own branch is still open; close it first, since the task ships through {} instead",
                    pull_request.url,
                    shipped_through(&merged_with)
                )));
            }
            PullRequestState::Closed => {}
        }
    }
    let machine = workspace.location.machine();
    Ok(
        RuntimeService.close_workspace(storage, herdr, id, &machine, |storage| {
            storage.complete_task_merged_with(id, &merged_with, resolution, merged_at, &records)
        })?,
    )
}

/// What shipped a task's work, for messages: the pull request, or the task without one.
fn shipped_through(merged_with: &model::MergedWith) -> String {
    match (&merged_with.pull_request_url, merged_with.task_id) {
        (Some(url), _) => url.clone(),
        (None, Some(task)) => format!("task {task}"),
        (None, None) => "another task".to_owned(),
    }
}

/// What shipped the work of `other`, the resolution a task shipped through it gets, and
/// the merge time: its own pull request, the one it was merged with in turn, or, for a
/// task done without a recorded pull request, the task itself.
fn shipped_by(
    other: &model::Task,
) -> CommandResult<(model::MergedWith, model::TaskResolution, Option<i64>)> {
    let id = other.id;
    let itself = model::MergedWith {
        task_id: Some(id),
        pull_request_url: None,
    };
    match (other.status, other.resolution) {
        (TaskStatus::Done, Some(model::TaskResolution::Merged)) => {
            let merged = match (&other.merged_with, &other.pull_request_url) {
                (Some(merged), _) => merged.clone(),
                (None, Some(url)) => model::MergedWith {
                    task_id: Some(id),
                    pull_request_url: Some(url.clone()),
                },
                (None, None) => itself,
            };
            Ok((
                merged,
                model::TaskResolution::Merged,
                other.pull_request_merged_at,
            ))
        }
        (TaskStatus::Done, Some(model::TaskResolution::Completed)) => {
            Ok((itself, model::TaskResolution::Completed, None))
        }
        (TaskStatus::Done, _) => Err(CommandError::rejected(format!(
            "task {id} was not adopted, so its work did not ship; pass the task or pull request that shipped the work instead"
        ))),
        (TaskStatus::InReview, _) => Err(CommandError::rejected(format!(
            "task {id} is in_review: its pull request is not merged, or its merge is not recorded yet (Toodo completes merged tasks within a minute); try again once task {id} is done, or pass the pull request URL"
        ))),
        (status, _) => Err(CommandError::rejected(format!(
            "task {id} is {status}; only a task done as merged or completed has shipped its work; complete it first, or pass the pull request URL"
        ))),
    }
}
