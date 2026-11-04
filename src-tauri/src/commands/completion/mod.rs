//! Commands that finish a task (see `docs/workflow.md`): recording the commits of its
//! branch, opening its pull request, which pushes the branch, opens (or reuses) a pull
//! request with `gh`, and moves the task to `in_review`, and completing it once that
//! pull request is merged, which closes its herdr workspace (keeping the worktree), moves
//! it to `done`, and releases its dependents.
//!
//! They run on the async runtime because git and gh can take seconds. The database lock
//! is not held while they run.
//!
//! A background thread also moves tasks on its own every minute, telling the frontend
//! through [`TasksChanged`]: it looks up the pull request of the branch of each
//! `in_progress` task and moves the task to `in_review` when one was opened outside
//! Toodo (e.g. by an agent in herdr), then checks the pull requests of `in_review` tasks
//! and completes each task whose pull request was merged, as the `complete_task` command
//! would. Each round reads a pull request at most once and lists the open pull requests
//! of a repository with several at once, and skips `gh` while GitHub's rate limit backs
//! off. For each pull request still open, it keeps the CI and review state and tells
//! the frontend through [`PullRequestStatusesChanged`] when one changes. Before settling,
//! it also records the git activity (see [`crate::domain::activity`]) of each task being
//! worked on in a workspace that tracks it: the commits of its branch and what its pull
//! request shows (opened, CI result, merged).
//!
//! [`TasksChanged`]: super::events::TasksChanged
//! [`PullRequestStatusesChanged`]: super::events::PullRequestStatusesChanged

mod background;
mod conclude;
mod polling;
mod pull_request;
mod settle;
#[cfg(test)]
mod tests;

use super::State;
use super::types::{self, CommitRecord, Task, TaskId};
use super::{CommandError, CommandResult, GitHubState, GitState, HerdrState, StorageState};

pub(crate) use background::lock_statuses;
pub use background::{PolledPullRequest, PullRequestStatusState, spawn};
pub(crate) use conclude::{MergedWithTarget, OpenPullRequest, complete_merged_with, conclude};
pub(super) use pull_request::{checkout, clear_missing_worktree, ensure_closing_reference};
pub(crate) use settle::{complete, complete_without_pull_request};

use background::all_statuses;
use pull_request::{open, refresh};

/// Reads the commits of an `in_progress` or `in_review` task's branch that are not on
/// the base branch and stores them as its commit records.
#[specta::specta]
pub fn refresh_commit_records(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    task_id: TaskId,
) -> CommandResult<Vec<CommitRecord>> {
    Ok(types::map_all(&refresh(&storage, &git, task_id.into())?))
}

/// Records the commits of an `in_progress` or `in_review` task, pushes its branch, opens
/// a pull request into the base branch, and moves the task to `in_review`. A pull request
/// of the branch opened elsewhere (e.g. from herdr) is adopted instead: an open one gets
/// the push, a merged one is recorded without pushing. Run it again after more commits
/// to push them to the pull request.
#[specta::specta]
pub fn open_pull_request(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    github: State<'_, GitHubState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&open(&storage, &git, &**github, id.into())?).into())
}

/// Moves an `in_progress` or `in_review` task to `done` once its completion criteria are
/// met, which also confirms a task with a manual criterion and may make its dependents
/// ready. Toodo checks its automatic criteria first; a merged pull request's size,
/// reviews, and commits are recorded for reviews. Its herdr workspace is closed; the
/// worktree stays on disk. Rejected with the criteria that are not met.
#[specta::specta]
pub fn complete_task(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    github: State<'_, GitHubState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&complete(&storage, &git, &**github, &herdr, id.into())?).into())
}

/// Concludes an `in_progress` or `in_review` task without merging, e.g. research whose
/// result is not adopted: the task becomes `done` as `not_adopted` with `note`, the
/// conclusion, as its completion note. The commits of its branch are recorded, an open
/// pull request of its branch, recorded or not, is closed with the conclusion as a
/// comment and recorded, and its herdr workspace is closed. The branch and worktree stay,
/// and its dependents keep waiting.
#[specta::specta]
pub fn conclude_task(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    github: State<'_, GitHubState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
    note: String,
) -> CommandResult<Task> {
    Ok((&conclude(
        &storage,
        &git,
        &**github,
        &herdr,
        id.into(),
        &note,
        OpenPullRequest::Close,
    )?)
        .into())
}

/// Completes a task whose work shipped through another task, `merged_with_task`, or a
/// merged pull request into the base branch, `pull_request_url`; exactly one of the two.
/// An `in_progress` or `in_review` task, or one done as `not_adopted`, becomes done as
/// merged (completed when the other task was completed without a pull request), and its
/// dependents can start. See `complete_merged_with` for the checks.
#[specta::specta]
pub fn complete_task_merged_with(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    github: State<'_, GitHubState>,
    herdr: State<'_, HerdrState>,
    id: TaskId,
    merged_with_task: Option<TaskId>,
    pull_request_url: Option<String>,
) -> CommandResult<Task> {
    let pull_request_url = pull_request_url.filter(|url| !url.trim().is_empty());
    let target = match (merged_with_task, pull_request_url) {
        (Some(task), None) => MergedWithTarget::Task(task.into()),
        (None, Some(url)) => MergedWithTarget::PullRequest(url),
        _ => {
            return Err(CommandError::invalid_input(
                "name either the task that shipped the work or the URL of its merged pull request, not both or neither",
            ));
        }
    };
    Ok((&complete_merged_with(&storage, &git, &**github, &herdr, id.into(), target)?).into())
}

#[specta::specta]
pub fn list_pull_request_statuses(
    statuses: State<'_, PullRequestStatusState>,
) -> Vec<types::TaskPullRequestStatus> {
    all_statuses(&lock_statuses(&statuses))
}
