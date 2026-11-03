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
//! would. For each pull request still open, it keeps the CI and review state and tells
//! the frontend through [`PullRequestStatusesChanged`] when one changes.
//!
//! [`TasksChanged`]: super::events::TasksChanged
//! [`PullRequestStatusesChanged`]: super::events::PullRequestStatusesChanged

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use super::{Runtime, State};

use super::events::Notifier;
use super::herdr::{WORKSPACE_NOT_FOUND, has_code};
use super::types::{self, CommitRecord, Task, TaskId};
use super::{CommandError, CommandResult, GitHubState, GitState, HerdrState, StorageState, lock};
use crate::adapters::git::{Git, GitError, LocalMerge};
use crate::adapters::github::{
    ChecksState, GitHub, NewPullRequest, PullRequest, PullRequestState, PullRequestStatus,
    ViewedPullRequest,
};
use crate::adapters::herdr::Herdr;
use crate::domain::criteria::{self, CheckKind, CriterionState, Decision};
use crate::domain::issue::{closes_issue, with_closing_reference};
use crate::domain::model::{self, WorkspaceLocation};
use crate::domain::remote::GitHubRepository;
use crate::domain::status::TaskStatus;
use crate::storage::{CriterionCheck, StorageError};

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
    Ok((&open(&storage, &git, &github, id.into())?).into())
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
    Ok((&complete(&storage, &git, &github, &herdr, id.into())?).into())
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
        &github,
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
    Ok((&complete_merged_with(&storage, &git, &github, &herdr, id.into(), target)?).into())
}

/// What concluding does with a pull request of the task that is still open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenPullRequest {
    /// Close it with the conclusion as a comment, as the app does.
    Close,
    /// Reject the conclusion and leave the pull request and the task as they are, as
    /// agents do through MCP: closing a pull request stays a decision for the user.
    Reject,
}

/// An `in_progress` or `in_review` task with the workspace repository its git commands
/// run in.
pub(super) struct Checkout {
    pub(super) task: model::Task,
    pub(super) location: WorkspaceLocation,
    pub(super) base: String,
    pub(super) branch: String,
    pub(super) repository: String,
}

pub(super) fn checkout(
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
    let Some(branch) = task.branch.clone() else {
        return Err(CommandError::rejected(format!(
            "task {id} has no branch; start it in the Toodo app first"
        )));
    };
    let workspace = stored
        .get_workspace(task.workspace_id)?
        .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
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
pub(super) fn clear_missing_worktree(
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

fn refresh(
    storage: &StorageState,
    git: &Git,
    id: model::TaskId,
) -> CommandResult<Vec<model::CommitRecord>> {
    let checkout = checkout(storage, git, id)?;
    let records = commit_records(git, &checkout)?;
    lock(storage).replace_commit_records(id, &records)?;
    Ok(records)
}

fn open(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
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
            github.create_pull_request(&NewPullRequest {
                repository: &repository,
                head: &checkout.branch,
                base: &checkout.base,
                title: &checkout.task.title,
                body: &body,
            })?
        }
    };
    Ok(lock(storage).open_pull_request(id, &records, &pull_request_url, None)?)
}

/// Appends a closing reference to `issue` to the body of the open pull request at `url`
/// unless the body already has one, so merging the pull request closes the issue.
pub(super) fn ensure_closing_reference(
    github: &GitHub,
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
fn check_base(pull_request: &PullRequest, base: &str) -> CommandResult<()> {
    if pull_request.base == base {
        return Ok(());
    }
    Err(CommandError::rejected(format!(
        "pull request {} merges into {}, not the workspace base branch {base}; dependent tasks start from {base}, so retarget it or open a new one",
        pull_request.url, pull_request.base
    )))
}

/// Completes a task being worked on whose completion criteria are met, which is also how
/// a task with a manual criterion is confirmed: Toodo first checks the criteria it checks
/// on its own, then completes the task if every criterion is met. A task without
/// criteria is completed as it is. Rejected with the criteria not met yet.
pub(crate) fn complete(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    match settle(storage, git, github, herdr, id, Settle::Confirm)? {
        Settled::Done(task) => Ok(*task),
        Settled::Open { task, viewed, .. } => Err(not_complete(&task, viewed.as_ref())),
    }
}

/// Completes work shipped without any pull request, with its explanation as evidence.
pub(crate) fn complete_without_pull_request(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
    herdr: &Herdr,
    id: model::TaskId,
    note: &str,
) -> CommandResult<model::Task> {
    let note = note.trim();
    if note.is_empty() {
        return Err(CommandError::invalid_input(
            "without_pull_request requires a non-empty note; call complete_task with without_pull_request: true and note explaining what shipped",
        ));
    }
    match settle(
        storage,
        git,
        github,
        herdr,
        id,
        Settle::WithoutPullRequest(note),
    )? {
        Settled::Done(task) => Ok(*task),
        Settled::Open { task, viewed, .. } => Err(not_complete(&task, viewed.as_ref())),
    }
}

/// Why `task` cannot be completed yet: its pull request, when that is what it waits for,
/// or the criteria that are not met.
fn not_complete(task: &model::Task, viewed: Option<&ViewedPullRequest>) -> CommandError {
    let id = task.id;
    let waits_for_merge = task
        .criteria
        .iter()
        .any(|criterion| criterion.kind == CheckKind::PullRequestMerged && !criterion.is_met());
    if let Some(viewed) = viewed.filter(|_| waits_for_merge) {
        let url = &viewed.pull_request.url;
        match viewed.pull_request.state {
            PullRequestState::Open => {
                return CommandError::rejected(format!(
                    "pull request {url} is not merged yet; merge it before completing the task"
                ));
            }
            PullRequestState::Closed => {
                return CommandError::rejected(format!(
                    "pull request {url} was closed without merging; reopen the pull request, ask the user to pause the task in the Toodo app, or conclude_task if the work is abandoned"
                ));
            }
            PullRequestState::Merged => {}
        }
    }
    let unmet: Vec<String> = task
        .criteria
        .iter()
        .filter(|criterion| !criterion.is_met())
        .map(|criterion| {
            let reason = match (&criterion.evidence, criterion.kind) {
                (Some(evidence), _) => format!(": {evidence}"),
                (None, CheckKind::PullRequestMerged | CheckKind::PullRequestOpenChecksPassed)
                    if task.pull_request_url.is_none() =>
                {
                    ": the task has no pull request yet".to_owned()
                }
                (None, CheckKind::Manual) => ": check it once it holds".to_owned(),
                (None, _) => String::new(),
            };
            let next = match criterion.kind {
                CheckKind::Manual => format!(
                    "call check_criterion with criterion_id {} and evidence once it holds",
                    criterion.id
                ),
                CheckKind::PullRequestMerged => format!(
                    "merge the branch pull request, then call complete_task with id {id}; if no pull request exists, call it with without_pull_request: true and note"
                ),
                CheckKind::PullRequestOpenChecksPassed => format!(
                    "open the branch pull request and fix its CI checks, then call complete_task with id {id}"
                ),
                CheckKind::BranchMergedLocally => format!(
                    "merge the task branch into the workspace base branch locally, then call complete_task with id {id}"
                ),
                CheckKind::Url => format!(
                    "make URL {:?} reachable, then call complete_task with id {id}",
                    criterion.target.as_deref().unwrap_or("")
                ),
                CheckKind::Command => format!(
                    "restore the worktree in the Toodo app if missing and make command {:?} succeed there, then call complete_task with id {id}",
                    criterion.target.as_deref().unwrap_or("")
                ),
            };
            format!(
                "#{} {:?} ({}, {}){reason}; {next}",
                criterion.id,
                criterion.text,
                criterion.kind,
                criterion.state.as_str()
            )
        })
        .collect();
    CommandError::rejected(format!(
        "task {id} is not done yet: {} of its completion criteria {} not met: {}",
        unmet.len(),
        if unmet.len() == 1 { "is" } else { "are" },
        unmet.join("; ")
    ))
}

/// Whether settling a task may complete it when a manual criterion is met too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Settle<'a> {
    /// The background check: only a task whose criteria are all automatic and met is
    /// completed; one with a manual criterion awaits completion.
    Check,
    /// The user (or an agent for them) completes the task: every criterion met is enough.
    Confirm,
    /// Explicit confirmation that shipped work has no pull request at all.
    WithoutPullRequest(&'a str),
}

enum CompletionEvidence<'a> {
    PullRequest(Option<&'a ViewedPullRequest>),
    WithoutPullRequest(&'a str),
}

/// What settling a task led to.
enum Settled {
    /// The task is now `done`.
    Done(Box<model::Task>),
    /// The task is not done. `changed` says whether a criterion or the status changed;
    /// `viewed` is its pull request as read, if it was.
    Open {
        task: Box<model::Task>,
        changed: bool,
        viewed: Option<ViewedPullRequest>,
    },
}

/// Checks the automatic criteria of an `in_progress` or `in_review` task, stores what
/// was found, and completes the task when its criteria call for it (see
/// [`criteria::decide`]). Reading its pull request fails the whole check, so a gh
/// failure changes nothing; other checks that fail mark their criterion failed.
fn settle(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
    herdr: &Herdr,
    id: model::TaskId,
    settle: Settle<'_>,
) -> CommandResult<Settled> {
    let (task, workspace, records) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        let records = storage.list_commit_records(id)?;
        (task, workspace, records)
    };
    match task.status {
        TaskStatus::InProgress | TaskStatus::InReview => {}
        TaskStatus::Done => {
            let resolution = task
                .resolution
                .map_or("done", model::TaskResolution::as_str);
            let hint = if task.resolution == Some(model::TaskResolution::NotAdopted) {
                "; if the merged pull request of another task shipped its work, complete it with merged_with set to that task or pull request"
            } else {
                ""
            };
            return Err(CommandError::rejected(format!(
                "task {id} is already done as {resolution}; there is nothing left to complete{hint}"
            )));
        }
        status => {
            return Err(CommandError::rejected(format!(
                "task {id} is {status}; only an in_progress or in_review task can be completed"
            )));
        }
    }
    if let Settle::WithoutPullRequest(_) = settle {
        let pull_request = match &task.branch {
            Some(branch) => branch_pull_request(git, github, &workspace, branch)?,
            None => None,
        };
        let pull_request = match (pull_request, task.pull_request_url.as_deref()) {
            (Some(pull_request), _) => Some(pull_request),
            (None, Some(url)) => Some(github.pull_request(url)?.pull_request),
            (None, None) => None,
        };
        if let Some(pull_request) = pull_request {
            let next = match pull_request.state {
                PullRequestState::Merged => format!(
                    "call complete_task with id {id} without without_pull_request, note, or merged_with"
                ),
                PullRequestState::Open => format!(
                    "wait for its merge, then call complete_task with id {id} without without_pull_request or note; if the work is abandoned, ask the user to conclude it in the Toodo app, which closes the pull request"
                ),
                PullRequestState::Closed => format!(
                    "reopen it and wait for merge, then call complete_task with id {id} without without_pull_request or note; if the work is abandoned, call conclude_task with id {id} and note"
                ),
            };
            return Err(CommandError::rejected(format!(
                "pull request {} exists ({}); without_pull_request requires no pull request at all; {next}",
                pull_request.url,
                match pull_request.state {
                    PullRequestState::Merged => "merged",
                    PullRequestState::Open => "open",
                    PullRequestState::Closed => "closed",
                }
            )));
        }
    }
    let task = if settle == Settle::Confirm && task.pull_request_url.is_none() {
        adopt_pull_request(storage, git, github, id)?.unwrap_or(task)
    } else {
        task
    };
    let base = &workspace.default_base_branch;
    let pull_request_unmet = task
        .criteria
        .iter()
        .any(|criterion| criterion.kind.is_pull_request() && !criterion.is_met());
    let viewed = match &task.pull_request_url {
        Some(url) if task.status == TaskStatus::InReview || pull_request_unmet => {
            let viewed = github.pull_request(url)?;
            check_base(&viewed.pull_request, base)?;
            // Pull requests opened outside Toodo, e.g. by an agent, get the reference here.
            if viewed.pull_request.state == PullRequestState::Open
                && let Some(issue) = &task.issue
            {
                ensure_closing_reference(github, url, issue)?;
            }
            Some(viewed)
        }
        _ => None,
    };
    let mut checks = check_criteria(
        git,
        &task,
        &workspace,
        viewed.as_ref(),
        &records,
        settle != Settle::Check,
    );
    if let Settle::WithoutPullRequest(note) = settle {
        checks.retain(|check| {
            !task.criteria.iter().any(|criterion| {
                criterion.id == check.id && criterion.kind == CheckKind::PullRequestMerged
            })
        });
        let (mut task, changed) = lock(storage).record_criterion_checks(id, &checks)?;
        // Keep the waiver in memory until completion stores it atomically with the
        // note. Rejections and external failures must not enable background completion.
        for criterion in &mut task.criteria {
            if criterion.kind == CheckKind::PullRequestMerged {
                criterion.state = CriterionState::Met;
                criterion.evidence = Some(note.to_owned());
            }
        }
        if !criteria::can_confirm(&task.criteria) || task.status == TaskStatus::Done {
            return Ok(Settled::Open {
                task: Box::new(task),
                changed,
                viewed,
            });
        }
        let rechecks = recheck_met(git, &task, &workspace, &checks);
        if !rechecks.is_empty() {
            let task = lock(storage).record_criterion_rechecks(id, &rechecks)?;
            return Ok(Settled::Open {
                task: Box::new(task),
                changed: true,
                viewed,
            });
        }
        return Ok(Settled::Done(Box::new(finish_task(
            storage,
            git,
            github,
            herdr,
            &task,
            &workspace,
            CompletionEvidence::WithoutPullRequest(note),
        )?)));
    }
    let (task, changed) = lock(storage).record_criterion_checks(id, &checks)?;
    let finish = match criteria::decide(&task.criteria) {
        Decision::Complete => true,
        Decision::AwaitConfirmation | Decision::Wait => {
            settle != Settle::Check && criteria::can_confirm(&task.criteria)
        }
    };
    if !finish || task.status == TaskStatus::Done {
        return Ok(Settled::Open {
            task: Box::new(task),
            changed,
            viewed,
        });
    }
    let rechecks = recheck_met(git, &task, &workspace, &checks);
    if !rechecks.is_empty() {
        let task = lock(storage).record_criterion_rechecks(id, &rechecks)?;
        return Ok(Settled::Open {
            task: Box::new(task),
            changed: true,
            viewed,
        });
    }
    Ok(Settled::Done(Box::new(finish_task(
        storage,
        git,
        github,
        herdr,
        &task,
        &workspace,
        CompletionEvidence::PullRequest(viewed.as_ref()),
    )?)))
}

/// What the automatic checks of the criteria of `task` that are not met yet find.
/// A `command` criterion runs only once every other criterion but the merge criterion is
/// met, so it checks the work before the merge without running every minute while the
/// work is still going on; until then it records what it waits for. One that failed runs
/// again in the background check only once the merge criterion is met too, unless
/// `retry_failed`.
fn check_criteria(
    git: &Git,
    task: &model::Task,
    workspace: &model::Workspace,
    viewed: Option<&ViewedPullRequest>,
    records: &[model::CommitRecord],
    retry_failed: bool,
) -> Vec<CriterionCheck> {
    let base = &workspace.default_base_branch;
    let location = &workspace.location;
    let failed = |evidence: String| (CriterionState::Failed, Some(evidence), None);
    let mut checks: Vec<CriterionCheck> = task
        .criteria
        .iter()
        .filter(|criterion| {
            criterion.kind.is_automatic()
                && criterion.kind != CheckKind::Command
                && !criterion.is_met()
        })
        .filter_map(|criterion| {
            let (state, evidence, target) = match criterion.kind {
                CheckKind::Manual | CheckKind::Command => return None,
                CheckKind::PullRequestMerged => match viewed.map(|viewed| &viewed.pull_request) {
                    None => (CriterionState::Pending, None, None),
                    Some(pull_request) => match pull_request.state {
                        PullRequestState::Merged => {
                            (CriterionState::Met, Some(pull_request.url.clone()), None)
                        }
                        PullRequestState::Open => (CriterionState::Pending, None, None),
                        PullRequestState::Closed => failed(format!(
                            "pull request {} was closed without merging",
                            pull_request.url
                        )),
                    },
                },
                CheckKind::PullRequestOpenChecksPassed => match viewed {
                    None => (CriterionState::Pending, None, None),
                    Some(viewed) => {
                        let url = &viewed.pull_request.url;
                        match (viewed.pull_request.state, viewed.status.checks) {
                            (PullRequestState::Merged, _)
                            | (PullRequestState::Open, Some(ChecksState::Passing)) => {
                                (CriterionState::Met, Some(url.clone()), None)
                            }
                            (PullRequestState::Open, Some(ChecksState::Failing)) => {
                                failed(format!("checks of pull request {url} failed"))
                            }
                            (PullRequestState::Open, _) => (CriterionState::Pending, None, None),
                            (PullRequestState::Closed, _) => {
                                failed(format!("pull request {url} was closed without merging"))
                            }
                        }
                    }
                },
                CheckKind::BranchMergedLocally => match &task.branch {
                    None => (CriterionState::Pending, None, None),
                    Some(branch) => {
                        match git.local_merge(location, branch, base, criterion.target.as_deref()) {
                            Ok(LocalMerge::Merged { commits }) => (
                                CriterionState::Met,
                                Some(format!(
                                    "{branch} merged into {base} with {commits} commit{}",
                                    if commits == 1 { "" } else { "s" }
                                )),
                                None,
                            ),
                            Ok(LocalMerge::StartUnknown) if !records.is_empty() => (
                                CriterionState::Met,
                                Some(format!("{branch} merged into {base}")),
                                None,
                            ),
                            Ok(LocalMerge::NotMerged { start, .. }) => {
                                (CriterionState::Pending, None, Some(start))
                            }
                            Ok(
                                LocalMerge::NoBranch
                                | LocalMerge::NoCommits
                                | LocalMerge::StartUnknown,
                            ) => (CriterionState::Pending, None, None),
                            Err(error) => failed(error.to_string()),
                        }
                    }
                },
                CheckKind::Url => {
                    let (state, evidence) = check_url(git, criterion.target.as_deref()?);
                    (state, evidence, None)
                }
            };
            Some(CriterionCheck {
                id: criterion.id,
                state,
                evidence,
                target,
            })
        })
        .collect();
    let met = |criterion: &criteria::Criterion| {
        criterion.is_met()
            || checks
                .iter()
                .any(|check| check.id == criterion.id && check.state == CriterionState::Met)
    };
    let waiting: Vec<String> = task
        .criteria
        .iter()
        .filter(|criterion| {
            criterion.kind != CheckKind::Command && !is_merge(criterion.kind) && !met(criterion)
        })
        .map(|criterion| format!("#{}", criterion.id))
        .collect();
    let merged = task
        .criteria
        .iter()
        .filter(|criterion| is_merge(criterion.kind))
        .all(met);
    let commands: Vec<CriterionCheck> = task
        .criteria
        .iter()
        .filter(|criterion| criterion.kind == CheckKind::Command && !criterion.is_met())
        .filter_map(|criterion| {
            let command = criterion.target.as_deref()?;
            if !waiting.is_empty() {
                return Some(CriterionCheck {
                    id: criterion.id,
                    state: CriterionState::Pending,
                    evidence: Some(format!(
                        "waits for criteria {} to be met; Toodo runs the command then",
                        waiting.join(", ")
                    )),
                    target: None,
                });
            }
            if criterion.state == CriterionState::Failed && !retry_failed && !merged {
                return None;
            }
            Some(check_command(git, task, location, criterion.id, command))
        })
        .collect();
    checks.extend(commands);
    checks
}

fn is_merge(kind: CheckKind) -> bool {
    matches!(
        kind,
        CheckKind::PullRequestMerged | CheckKind::BranchMergedLocally
    )
}

/// What a GET of `url` finds: met with a 2xx or 3xx status, failed otherwise.
fn check_url(git: &Git, url: &str) -> (CriterionState, Option<String>) {
    match git.fetch_url(url) {
        Ok(status) if (200..400).contains(&status) => {
            (CriterionState::Met, Some(format!("GET {url} -> {status}")))
        }
        Ok(status) => (
            CriterionState::Failed,
            Some(format!("GET {url} -> {status}")),
        ),
        Err(GitError::Failed { stderr, .. }) => (
            CriterionState::Failed,
            Some(clip(&format!("GET {url} failed: {}", stderr.trim()))),
        ),
        Err(error) => (
            CriterionState::Failed,
            Some(clip(&format!("GET {url} failed: {error}"))),
        ),
    }
}

/// What running `command` in the worktree of `task` finds; pending while the worktree
/// is missing.
fn check_command(
    git: &Git,
    task: &model::Task,
    location: &model::WorkspaceLocation,
    id: criteria::CriterionId,
    command: &str,
) -> CriterionCheck {
    let check = |state, evidence: String| CriterionCheck {
        id,
        state,
        evidence: Some(evidence),
        target: None,
    };
    let exists = task.worktree_path.as_ref().map_or(Ok(false), |worktree| {
        git.worktree_exists(location, worktree)
    });
    let worktree = match (exists, &task.worktree_path) {
        (Ok(true), Some(worktree)) => worktree,
        (Err(error), _) => return check(CriterionState::Failed, clip(&error.to_string())),
        _ => {
            return check(
                CriterionState::Pending,
                "worktree is missing; restore it in the Toodo app or conclude the task".to_owned(),
            );
        }
    };
    match git.run_command(location, &worktree.to_string(), command) {
        Ok(output) => check(
            CriterionState::Met,
            clip(&format!("`{command}` succeeded\n{}", output.trim())),
        ),
        Err(error) => check(CriterionState::Failed, clip(&error.to_string())),
    }
}

/// Checks the met `url` and `command` criteria of `task` that this pass did not
/// check (`checked`) again right before it is completed, so a later change that broke
/// one keeps the task open. Returns the ones that fail now; a command whose worktree is
/// missing cannot run and stays met.
fn recheck_met(
    git: &Git,
    task: &model::Task,
    workspace: &model::Workspace,
    checked: &[CriterionCheck],
) -> Vec<CriterionCheck> {
    task.criteria
        .iter()
        .filter(|criterion| {
            criterion.is_met() && !checked.iter().any(|check| check.id == criterion.id)
        })
        .filter_map(|criterion| {
            let target = criterion.target.as_deref()?;
            let check = match criterion.kind {
                CheckKind::Url => {
                    let (state, evidence) = check_url(git, target);
                    CriterionCheck {
                        id: criterion.id,
                        state,
                        evidence,
                        target: None,
                    }
                }
                CheckKind::Command => {
                    check_command(git, task, &workspace.location, criterion.id, target)
                }
                _ => return None,
            };
            (check.state == CriterionState::Failed).then_some(check)
        })
        .collect()
}

/// At most the last 2000 characters of `text`, where command output ends with what
/// matters.
fn clip(text: &str) -> String {
    const LIMIT: usize = 2000;
    let text = text.trim();
    match text.char_indices().rev().nth(LIMIT - 1) {
        Some((start, _)) => format!("...{}", &text[start..]),
        None => text.to_owned(),
    }
}

/// Moves a task whose criteria are met to `done`: a merged pull request is recorded with
/// its snapshot and commits (read first, so a gh failure keeps the task as it is), else
/// the commits of its branch since it started are; its herdr workspace is closed.
fn finish_task(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
    herdr: &Herdr,
    task: &model::Task,
    workspace: &model::Workspace,
    evidence: CompletionEvidence<'_>,
) -> CommandResult<model::Task> {
    let id = task.id;
    let (viewed, note) = match evidence {
        CompletionEvidence::PullRequest(viewed) => (viewed, None),
        CompletionEvidence::WithoutPullRequest(note) => (None, Some(note)),
    };
    let (merged_at, snapshot, commits) = match viewed {
        Some(viewed) if viewed.pull_request.state == PullRequestState::Merged => {
            let pull_request = &viewed.pull_request;
            let merged = github.merged_pull_request(&pull_request.url)?;
            let commits = merged
                .commits
                .into_iter()
                .map(|commit| model::CommitRecord {
                    task_id: id,
                    sha: commit.sha,
                    message: commit.message,
                    author: commit.author,
                    committed_at: commit.committed_at,
                })
                .collect();
            (pull_request.merged_at, Some(merged.snapshot), commits)
        }
        _ => (None, None, branch_commits(git, task, workspace)?),
    };
    // A workspace herdr no longer has was already closed, e.g. by the user.
    if let Some(workspace_id) = &task.herdr_workspace_id {
        match herdr.close_workspace(&workspace.location.machine(), workspace_id) {
            Ok(()) => {}
            Err(error) if has_code(&error, WORKSPACE_NOT_FOUND) => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut storage = lock(storage);
    Ok(match note {
        Some(note) => storage.complete_task_without_pull_request(id, note, &commits)?,
        None => storage.complete_task(id, merged_at, snapshot.as_ref(), &commits)?,
    })
}

/// The commits of a task's branch since it started (the start commit a
/// `branch_merged_locally` criterion found), or else those not on the base branch; none
/// for a task without a branch. After a local merge only the start tells them apart.
fn branch_commits(
    git: &Git,
    task: &model::Task,
    workspace: &model::Workspace,
) -> CommandResult<Vec<model::CommitRecord>> {
    let Some(branch) = &task.branch else {
        return Ok(Vec::new());
    };
    let start = task
        .criteria
        .iter()
        .find(|criterion| criterion.kind == CheckKind::BranchMergedLocally)
        .and_then(|criterion| criterion.target.clone());
    let dir = match &workspace.location {
        WorkspaceLocation::Local { path } | WorkspaceLocation::Ssh { path, .. } => path.to_string(),
    };
    let since = start.unwrap_or_else(|| workspace.default_base_branch.clone());
    Ok(git
        .commits_between(&workspace.location, &dir, &since, branch)?
        .into_iter()
        .map(|commit| model::CommitRecord {
            task_id: task.id,
            sha: commit.sha,
            message: commit.message,
            author: commit.author,
            committed_at: commit.committed_at,
        })
        .collect())
}

pub(crate) fn conclude(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
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
    // A workspace herdr no longer has was already closed, e.g. by the user.
    if let Some(workspace_id) = &task.herdr_workspace_id {
        match herdr.close_workspace(&workspace.location.machine(), workspace_id) {
            Ok(()) => {}
            Err(error) if has_code(&error, WORKSPACE_NOT_FOUND) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(lock(storage).conclude_task(id, note, &records, closed)?)
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
    github: &GitHub,
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
    // A workspace herdr no longer has was already closed, e.g. by the user.
    if let Some(workspace_id) = &task.herdr_workspace_id {
        match herdr.close_workspace(&workspace.location.machine(), workspace_id) {
            Ok(()) => {}
            Err(error) if has_code(&error, WORKSPACE_NOT_FOUND) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(lock(storage).complete_task_merged_with(
        id,
        &merged_with,
        resolution,
        merged_at,
        &records,
    )?)
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

/// The preferred pull request from `branch` into the workspace base branch.
/// A repository without a GitHub origin has none.
fn branch_pull_request(
    git: &Git,
    github: &GitHub,
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
fn adopt_pull_request(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
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

/// CI and review state of the open pull request of each `in_review` task, as of the last
/// check.
pub type PullRequestStatusState = Mutex<HashMap<model::TaskId, PullRequestStatus>>;

#[specta::specta]
pub fn list_pull_request_statuses(
    statuses: State<'_, PullRequestStatusState>,
) -> Vec<types::TaskPullRequestStatus> {
    all_statuses(&lock_statuses(&statuses))
}

fn lock_statuses(
    statuses: &PullRequestStatusState,
) -> MutexGuard<'_, HashMap<model::TaskId, PullRequestStatus>> {
    statuses.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The pull request statuses, ordered by task ID.
fn all_statuses(
    statuses: &HashMap<model::TaskId, PullRequestStatus>,
) -> Vec<types::TaskPullRequestStatus> {
    let mut all: Vec<_> = statuses
        .iter()
        .map(|(&id, &status)| types::TaskPullRequestStatus::new(id, status))
        .collect();
    all.sort_by_key(|status| status.task_id.0);
    all
}

/// How often the pull requests of `in_progress` and `in_review` tasks are checked.
const PULL_REQUEST_CHECK_PERIOD: Duration = Duration::from_secs(60);

/// Starts the background thread that moves `in_progress` tasks whose branch has a pull
/// request to `in_review` and completes `in_review` tasks whose pull request was merged.
pub fn spawn(app: Arc<dyn Runtime>) -> io::Result<()> {
    thread::Builder::new()
        .name("pull-request-checks".to_owned())
        .spawn(move || {
            let mut failures = HashMap::new();
            loop {
                check_pull_requests(
                    app.storage(),
                    app.git(),
                    app.github(),
                    app.herdr(),
                    app.as_ref(),
                    &mut failures,
                    app.pull_request_statuses(),
                );
                thread::sleep(PULL_REQUEST_CHECK_PERIOD);
            }
        })?;
    Ok(())
}

/// Moves every `in_progress` task whose branch has a pull request to `in_review`, then
/// settles every task being worked on whose criteria Toodo checks: completes those whose
/// criteria are all automatic and met (including tasks just moved), moves those with a
/// met manual criterion to `in_review`, and announces each change. `failures` holds the
/// last failure of each task, so a failure that repeats on every check (e.g. `gh` is not
/// signed in) is logged once. `statuses` gets the CI and review state of each pull
/// request of an `in_review` task still open; a failed check keeps the last one known.
fn check_pull_requests(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
    herdr: &Herdr,
    notifier: &dyn Notifier,
    failures: &mut HashMap<model::TaskId, String>,
    statuses: &PullRequestStatusState,
) {
    let tasks = match lock(storage).list_all_tasks() {
        Ok(tasks) => tasks,
        Err(error) => {
            eprintln!("toodo: failed to list tasks: {error}");
            return;
        }
    };
    for task in &tasks {
        if task.worktree_path.is_none() {
            continue;
        }
        let workspace = match lock(storage).get_workspace(task.workspace_id) {
            Ok(Some(workspace)) => workspace,
            _ => continue,
        };
        match clear_missing_worktree(storage, git, task, &workspace) {
            Ok(true) => notifier.tasks_changed(task.workspace_id),
            Ok(false) => {}
            Err(error) => remember_failure(failures, task.id, "check its worktree", error),
        }
    }
    let adoptable: Vec<_> = tasks
        .iter()
        .filter(|task| {
            matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview)
                && task.branch.is_some()
                && task.pull_request_url.is_none()
                && task
                    .criteria
                    .iter()
                    .any(|criterion| criterion.kind.is_pull_request() && !criterion.is_met())
        })
        .map(|task| task.id)
        .collect();
    // A failed lookup stays remembered through the settling below, which may succeed.
    let mut failed_lookups = Vec::new();
    for &id in &adoptable {
        match adopt_pull_request(storage, git, github, id) {
            Ok(adopted) => {
                failures.remove(&id);
                if let Some(task) = adopted {
                    notifier.tasks_changed(task.workspace_id);
                }
            }
            Err(error) => {
                failed_lookups.push(id);
                remember_failure(failures, id, "look up its pull request", error);
            }
        }
    }
    let active = match lock(storage).list_all_tasks() {
        Ok(tasks) => tasks
            .into_iter()
            .filter(needs_settling)
            .map(|task| (task.id, task.status == TaskStatus::InReview))
            .collect::<Vec<_>>(),
        Err(error) => {
            eprintln!("toodo: failed to list tasks: {error}");
            return;
        }
    };
    failures
        .retain(|id, _| adoptable.contains(id) || active.iter().any(|(active, _)| active == id));
    let before = lock_statuses(statuses).clone();
    let mut after = before.clone();
    after.retain(|id, _| {
        active
            .iter()
            .any(|(active, in_review)| active == id && *in_review)
    });
    for (id, _) in active {
        match settle(storage, git, github, herdr, id, Settle::Check) {
            Ok(settled) => {
                if !failed_lookups.contains(&id) {
                    failures.remove(&id);
                }
                match settled {
                    Settled::Done(task) => {
                        after.remove(&id);
                        notifier.tasks_changed(task.workspace_id);
                    }
                    Settled::Open {
                        task,
                        changed,
                        viewed,
                    } => {
                        match viewed {
                            Some(viewed)
                                if task.status == TaskStatus::InReview
                                    && viewed.pull_request.state == PullRequestState::Open =>
                            {
                                after.insert(id, viewed.status);
                            }
                            _ => {
                                after.remove(&id);
                            }
                        }
                        if changed {
                            notifier.tasks_changed(task.workspace_id);
                        }
                    }
                }
            }
            Err(error) => {
                remember_failure(failures, id, "check its completion criteria", error);
            }
        }
    }
    if after != before {
        notifier.pull_request_statuses_changed(&all_statuses(&after));
        *lock_statuses(statuses) = after;
    }
}

/// Whether the background check settles `task`: it is being worked on and has a pull
/// request to watch while `in_review`, or a criterion Toodo checks that is not met yet.
fn needs_settling(task: &model::Task) -> bool {
    match task.status {
        TaskStatus::InProgress | TaskStatus::InReview => {
            (task.status == TaskStatus::InReview && task.pull_request_url.is_some())
                || task
                    .criteria
                    .iter()
                    .any(|criterion| criterion.kind.is_automatic() && !criterion.is_met())
        }
        TaskStatus::Planned | TaskStatus::Done => false,
    }
}

/// Logs a failed check of a task unless it is the same failure as the last one.
fn remember_failure(
    failures: &mut HashMap<model::TaskId, String>,
    id: model::TaskId,
    action: &str,
    error: CommandError,
) {
    if failures.get(&id) != Some(&error.message) {
        eprintln!("toodo: task {id}: failed to {action}: {}", error.message);
        failures.insert(id, error.message);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::adapters::git::fake::{FakeRunner, failed};
    use crate::adapters::git::{GitError, Invocation};
    use crate::commands::CommandErrorKind;
    use crate::domain::criteria::NewCriterion;
    use crate::domain::model::{HostPath, MachineLabel, TaskType};
    use crate::domain::naming::TaskCheckout;
    use crate::domain::path::{PosixPath, WindowsPath};
    use crate::storage::{NewTask, NewWorkspace, Storage};

    const SHA_A: &str = "1111111111111111111111111111111111111111";
    const SHA_B: &str = "2222222222222222222222222222222222222222";
    const PR: &str = "https://github.com/acme/toodo/pull/12";

    struct Fixture {
        storage: StorageState,
        task: model::Task,
        dependent: model::Task,
    }

    fn fixture(location: WorkspaceLocation, worktree: HostPath) -> Fixture {
        fixture_with(location, worktree, vec![NewCriterion::merge(true)])
    }

    fn fixture_with(
        location: WorkspaceLocation,
        worktree: HostPath,
        criteria: Vec<NewCriterion>,
    ) -> Fixture {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location,
                default_base_branch: "main".to_owned(),
            })
            .unwrap();
        let new_task = |title: &str| NewTask {
            workspace_id: workspace.id,
            task_type: TaskType::Feat,
            title: title.to_owned(),
            description: format!("Implement {title}"),
            estimate: None,
            due_date: None,
            criteria: criteria.clone(),
        };
        let task = storage.create_task(&new_task("Add login")).unwrap();
        let dependent = storage.create_task(&new_task("Use login")).unwrap();
        storage.add_dependency(dependent.id, task.id).unwrap();
        let checkout = TaskCheckout {
            path: worktree,
            branch: "feat/add-login-1".to_owned(),
        };
        let task = storage.start_task(task.id, &checkout, "w27").unwrap();
        Fixture {
            storage: Mutex::new(storage),
            task,
            dependent,
        }
    }

    fn local_fixture() -> Fixture {
        fixture(
            WorkspaceLocation::Local {
                path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
            },
            HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap()),
        )
    }

    fn deleted_worktree_fixture(criteria: Vec<NewCriterion>) -> (Fixture, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let worktree = dir.path().join("worktree");
        std::fs::create_dir(&repo).unwrap();
        std::fs::create_dir(&worktree).unwrap();
        let fixture = fixture_with(
            WorkspaceLocation::Local {
                path: PosixPath::parse(repo.to_str().unwrap()).unwrap().into(),
            },
            PosixPath::parse(worktree.to_str().unwrap()).unwrap().into(),
            criteria,
        );
        std::fs::remove_dir(&worktree).unwrap();
        (fixture, dir)
    }

    #[test]
    fn concluding_records_branch_commits_after_the_worktree_directory_is_deleted() {
        let (fixture, dir) = deleted_worktree_fixture(Vec::new());
        let git_runner = runner(vec![log(&[SHA_A]), Ok(String::new())]);
        let (git, github) = adapters(&git_runner, &runner(Vec::new()));

        let done = conclude(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
            "The prototype did not improve performance",
            OpenPullRequest::Reject,
        )
        .unwrap();

        assert_eq!(done.resolution, Some(model::TaskResolution::NotAdopted));
        assert_eq!(recorded_shas(&fixture), [SHA_A]);
        for invocation in invocations(&git_runner) {
            assert_eq!(
                invocation.args[1],
                dir.path().join("repo").to_str().unwrap()
            );
        }
    }

    #[test]
    fn completing_records_branch_commits_after_the_worktree_directory_is_deleted() {
        let (fixture, dir) = deleted_worktree_fixture(Vec::new());
        let git_runner = runner(vec![Ok(String::new()), log(&[SHA_A])]);
        let (git, github) = adapters(&git_runner, &runner(Vec::new()));

        let done = complete(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
        )
        .unwrap();

        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
        assert_eq!(recorded_shas(&fixture), [SHA_A]);
        for invocation in invocations(&git_runner) {
            assert_eq!(
                invocation.args[1],
                dir.path().join("repo").to_str().unwrap()
            );
        }
    }

    #[test]
    fn a_missing_worktree_keeps_a_command_pending_without_running_the_command() {
        let command =
            NewCriterion::parse("Tests pass", CheckKind::Command, Some("npm test")).unwrap();
        let (fixture, _dir) = deleted_worktree_fixture(vec![command]);
        let git_runner = runner(vec![Ok(String::new()), Ok(String::new())]);
        let (git, github) = adapters(&git_runner, &runner(Vec::new()));

        complete(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
        )
        .unwrap_err();

        let task = stored(&fixture, &fixture.task);
        assert_eq!(task.criteria[0].state, CriterionState::Pending);
        assert_eq!(
            task.criteria[0].evidence.as_deref(),
            Some("worktree is missing; restore it in the Toodo app or conclude the task")
        );
        assert_eq!(git_commands(&git_runner), ["remote", "worktree"]);
    }

    #[test]
    fn checkout_forgets_a_missing_worktree_and_reads_commits_from_the_repository() {
        let (fixture, dir) = deleted_worktree_fixture(Vec::new());
        let git_runner = runner(vec![Ok(String::new()), log(&[SHA_A])]);
        let git = Git::new(Box::new(git_runner.clone()));

        let records = refresh(&fixture.storage, &git, fixture.task.id).unwrap();

        assert_eq!(records[0].sha, SHA_A);
        let task = stored(&fixture, &fixture.task);
        assert!(task.worktree_path.is_none());
        assert!(task.herdr_workspace_id.is_none());
        assert!(types::Task::from(&task).worktree_missing);
        for invocation in invocations(&git_runner) {
            assert_eq!(
                invocation.args[1],
                dir.path().join("repo").to_str().unwrap()
            );
        }
    }

    #[test]
    fn background_checks_forget_missing_worktrees_even_without_automatic_criteria() {
        let (fixture, _dir) = deleted_worktree_fixture(Vec::new());
        let git = Git::new(Box::new(runner(vec![Ok(String::new())])));
        let github = GitHub::new(Box::new(runner(Vec::new())));
        let recorder = Recorder::default();

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            &recorder,
            &mut HashMap::new(),
            &PullRequestStatusState::default(),
        );

        let task = stored(&fixture, &fixture.task);
        assert_eq!(task.worktree_path, None);
        assert_eq!(task.herdr_workspace_id, None);
        assert_eq!(task.branch, fixture.task.branch);
        assert_eq!(task.status, TaskStatus::InProgress);
        assert_eq!(*recorder.0.lock().unwrap(), [task.workspace_id]);
    }

    #[test]
    fn background_checks_forget_the_missing_worktree_of_a_done_task() {
        let (fixture, _dir) = deleted_worktree_fixture(Vec::new());
        lock(&fixture.storage)
            .complete_task_without_pull_request(fixture.task.id, "Shipped elsewhere", &[])
            .unwrap();
        let git = Git::new(Box::new(runner(vec![Ok(String::new())])));
        let github = GitHub::new(Box::new(runner(Vec::new())));

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            &Recorder::default(),
            &mut HashMap::new(),
            &PullRequestStatusState::default(),
        );

        let task = stored(&fixture, &fixture.task);
        assert_eq!(task.status, TaskStatus::Done);
        assert_eq!(task.worktree_path, None);
    }

    fn runner(results: Vec<Result<String, GitError>>) -> Arc<FakeRunner> {
        Arc::new(FakeRunner::new(results))
    }

    fn worktrees() -> Result<String, GitError> {
        Ok(concat!(
            "worktree D:/wt/toodo/feat-add-login-1\0HEAD abc\0\0",
            "worktree /wt/toodo/feat-add-login-1\0HEAD abc\0\0"
        )
        .to_owned())
    }

    fn checkout_runner(results: Vec<Result<String, GitError>>) -> Arc<FakeRunner> {
        runner(std::iter::once(worktrees()).chain(results).collect())
    }

    /// Git for a background check that only verifies the existing checkout.
    fn worktree_git() -> Git {
        Git::new(Box::new(checkout_runner(Vec::new())))
    }

    fn adapters(git: &Arc<FakeRunner>, gh: &Arc<FakeRunner>) -> (Git, GitHub) {
        (
            Git::new(Box::new(git.clone())),
            GitHub::new(Box::new(gh.clone())),
        )
    }

    fn log(shas: &[&str]) -> Result<String, GitError> {
        Ok(shas
            .iter()
            .enumerate()
            .map(|(index, sha)| {
                format!(
                    "{sha}\u{1f}Ada <ada@example.com>\u{1f}{index}\u{1f}Commit {index}\n\u{1e}\n"
                )
            })
            .collect())
    }

    fn origin(url: &str) -> Result<String, GitError> {
        Ok(format!("{url}\n"))
    }

    fn invocations(runner: &FakeRunner) -> Vec<Invocation> {
        runner.invocations.lock().unwrap().clone()
    }

    fn git_commands(runner: &FakeRunner) -> Vec<String> {
        invocations(runner)
            .iter()
            .map(|invocation| invocation.args[2].clone())
            .collect()
    }

    /// A git that must not be called.
    fn no_git() -> Git {
        Git::new(Box::new(runner(Vec::new())))
    }

    /// A herdr that must not be called.
    fn no_herdr() -> Herdr {
        Herdr::new(Box::new(runner(Vec::new())))
    }

    /// A herdr that closes one workspace.
    fn closing_herdr() -> (Herdr, Arc<FakeRunner>) {
        let runner = runner(vec![Ok(
            r#"{"id":"cli:workspace:close","result":{"type":"ok"}}"#.to_owned(),
        )]);
        (Herdr::new(Box::new(runner.clone())), runner)
    }

    fn dependent_ready(fixture: &Fixture) -> bool {
        let tasks = lock(&fixture.storage).list_all_tasks().unwrap();
        crate::domain::dag::is_ready(&tasks, fixture.dependent.id).unwrap()
    }

    fn stored(fixture: &Fixture, task: &model::Task) -> model::Task {
        lock(&fixture.storage).get_task(task.id).unwrap().unwrap()
    }

    #[test]
    fn opening_a_pull_request_records_commits_pushes_and_puts_the_task_in_review() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![
            log(&[SHA_A, SHA_B]),
            origin("git@github.com:acme/toodo.git"),
            Ok(String::new()),
        ]);
        let gh_runner = runner(vec![Ok("[]".to_owned()), Ok(format!("{PR}\n"))]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

        assert_eq!(in_review.status, TaskStatus::InReview);
        assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
        assert_eq!(stored(&fixture, &fixture.task), in_review);
        let records = lock(&fixture.storage)
            .list_commit_records(fixture.task.id)
            .unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.sha.as_str())
                .collect::<Vec<_>>(),
            [SHA_A, SHA_B]
        );
        assert!(!dependent_ready(&fixture));
        assert_eq!(
            git_commands(&git_runner),
            ["worktree", "log", "remote", "push"]
        );
        assert_eq!(
            invocations(&git_runner)[1].args[..2],
            ["-C", r"C:\dev\toodo"].map(str::to_owned)
        );
        assert_eq!(
            invocations(&gh_runner)[1].args,
            [
                "pr",
                "create",
                "--repo",
                "github.com/acme/toodo",
                "--head",
                "feat/add-login-1",
                "--base",
                "main",
                "--title",
                "Add login",
                "--body",
                "Implement Add login",
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn ssh_tasks_run_git_on_their_machine_and_gh_locally() {
        let devbox = MachineLabel::parse("devbox").unwrap();
        let fixture = fixture(
            WorkspaceLocation::Ssh {
                machine: devbox,
                path: PosixPath::parse("/srv/toodo").unwrap().into(),
            },
            HostPath::Posix(PosixPath::parse("/wt/toodo/feat-add-login-1").unwrap()),
        );
        let git_runner = checkout_runner(vec![
            log(&[SHA_A]),
            origin("https://github.com/acme/toodo.git"),
            Ok(String::new()),
        ]);
        let gh_runner = runner(vec![Ok("[]".to_owned()), Ok(format!("{PR}\n"))]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

        let push = &invocations(&git_runner)[3];
        assert_eq!(push.program, "ssh");
        assert_eq!(
            push.args[4],
            "git '-C' '/srv/toodo' 'push' '--set-upstream' 'origin' 'feat/add-login-1'"
        );
        assert_eq!(invocations(&gh_runner)[1].program, "gh");
    }

    #[test]
    fn a_branch_without_commits_is_rejected_before_anything_is_pushed() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![log(&[]), origin("git@github.com:acme/toodo.git")]);
        let gh_runner = runner(vec![Ok("[]".to_owned())]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let error = open(&fixture.storage, &git, &github, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains("has no commits that are not on main")
        );
        assert_eq!(git_commands(&git_runner), ["worktree", "log", "remote"]);
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert_eq!(stored(&fixture, &fixture.task), fixture.task);
    }

    #[test]
    fn a_non_github_origin_is_rejected_before_anything_is_pushed() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![log(&[SHA_A]), origin("/srv/git/toodo.git")]);
        let gh_runner = runner(Vec::new());
        let (git, github) = adapters(&git_runner, &gh_runner);

        let error = open(&fixture.storage, &git, &github, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("is not a GitHub repository"));
        assert_eq!(git_commands(&git_runner), ["worktree", "log", "remote"]);
        assert!(invocations(&gh_runner).is_empty());
    }

    #[test]
    fn a_failed_pull_request_keeps_the_task_in_progress_and_a_retry_reuses_the_open_one() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![
            log(&[SHA_A]),
            origin("git@github.com:acme/toodo.git"),
            Ok(String::new()),
            worktrees(),
            log(&[SHA_A, SHA_B]),
            origin("git@github.com:acme/toodo.git"),
            Ok(String::new()),
        ]);
        let gh_runner = runner(vec![
            Ok("[]".to_owned()),
            Err(failed()),
            listed("OPEN", "main"),
        ]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let error = open(&fixture.storage, &git, &github, fixture.task.id).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::External);
        assert_eq!(stored(&fixture, &fixture.task), fixture.task);
        assert_eq!(
            lock(&fixture.storage)
                .list_commit_records(fixture.task.id)
                .unwrap(),
            []
        );

        let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();
        assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
        assert_eq!(invocations(&gh_runner).len(), 3);
        assert_eq!(invocations(&gh_runner)[2].args[1], "list");
    }

    #[test]
    fn refresh_stores_the_commits_of_an_in_progress_task_only() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![log(&[SHA_A]), worktrees(), log(&[SHA_A, SHA_B])]);
        let git = Git::new(Box::new(git_runner.clone()));

        assert_eq!(
            refresh(&fixture.storage, &git, fixture.task.id)
                .unwrap()
                .len(),
            1
        );
        let records = refresh(&fixture.storage, &git, fixture.task.id).unwrap();
        assert_eq!(
            lock(&fixture.storage)
                .list_commit_records(fixture.task.id)
                .unwrap(),
            records
        );
        assert_eq!(records.len(), 2);

        let error = refresh(&fixture.storage, &git, fixture.dependent.id).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        let error = refresh(&fixture.storage, &git, model::TaskId(999)).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        assert_eq!(invocations(&git_runner).len(), 4);
    }

    #[test]
    fn an_in_progress_task_without_a_branch_is_rejected() {
        let fixture = local_fixture();
        for status in [TaskStatus::InReview, TaskStatus::Done] {
            lock(&fixture.storage)
                .set_task_status(fixture.task.id, status)
                .unwrap();
        }
        let ready = fixture.dependent.id;
        lock(&fixture.storage)
            .set_task_status(ready, TaskStatus::InProgress)
            .unwrap();
        let git_runner = runner(Vec::new());
        let gh_runner = runner(Vec::new());
        let (git, github) = adapters(&git_runner, &gh_runner);

        let error = open(&fixture.storage, &git, &github, ready).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("has no branch"));
        assert!(invocations(&git_runner).is_empty());
    }

    fn in_review_fixture() -> Fixture {
        let fixture = local_fixture();
        lock(&fixture.storage)
            .open_pull_request(fixture.task.id, &[], PR, None)
            .unwrap();
        fixture
    }

    /// `mergedAt` of a merged pull request in the `gh` output, and the same time in
    /// seconds since the Unix epoch.
    const MERGED_AT: (&str, i64) = ("2026-10-09T14:47:45Z", 1_791_557_265);

    fn pull_request_json(state: &str, base: &str) -> String {
        let merged_at = if state == "MERGED" {
            format!("\"{}\"", MERGED_AT.0)
        } else {
            "null".to_owned()
        };
        format!(
            r#"{{"baseRefName":"{base}","mergedAt":{merged_at},"state":"{state}","url":"{PR}"}}"#
        )
    }

    /// `gh pr list` output with one pull request.
    fn listed(state: &str, base: &str) -> Result<String, GitError> {
        Ok(format!("[{}]", pull_request_json(state, base)))
    }

    /// `gh pr view` output.
    fn viewed(state: &str, base: &str) -> Result<String, GitError> {
        viewed_with(state, base, "[]", "\"\"")
    }

    /// `gh pr view` output with these `statusCheckRollup` and `reviewDecision` values.
    fn viewed_with(
        state: &str,
        base: &str,
        checks: &str,
        decision: &str,
    ) -> Result<String, GitError> {
        let mut view: serde_json::Value =
            serde_json::from_str(&pull_request_json(state, base)).unwrap();
        view["statusCheckRollup"] = serde_json::from_str(checks).unwrap();
        view["reviewDecision"] = serde_json::from_str(decision).unwrap();
        view["latestReviews"] = serde_json::json!([]);
        Ok(view.to_string())
    }

    /// `gh pr view` output with the size, reviews, and commits of the merged pull
    /// request, which has the commits `shas`.
    fn merged_details(shas: &[&str]) -> Result<String, GitError> {
        let commits = shas
            .iter()
            .map(|sha| {
                format!(
                    r#"{{"authors":[{{"email":"ada@example.com","name":"Ada"}}],"committedDate":"{}","messageBody":"","messageHeadline":"Commit {sha}","oid":"{sha}"}}"#,
                    MERGED_AT.0
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        Ok(format!(
            r#"{{"additions":10,"author":{{"login":"ada"}},"changedFiles":2,"commits":[{commits}],"deletions":3,"mergeCommit":{{"oid":"{SHA_B}"}},"number":12,"reviews":[{{"author":{{"login":"bob"}},"state":"APPROVED","submittedAt":"{}"}}],"title":"Add login"}}"#,
            MERGED_AT.0
        ))
    }

    fn recorded_shas(fixture: &Fixture) -> Vec<String> {
        lock(&fixture.storage)
            .list_commit_records(fixture.task.id)
            .unwrap()
            .into_iter()
            .map(|record| record.sha)
            .collect()
    }

    fn merged_before_closed() -> Result<String, GitError> {
        Ok(format!(
            "[{},{}]",
            pull_request_json("CLOSED", "main"),
            pull_request_json("MERGED", "main").replace("/pull/12", "/pull/11")
        ))
    }

    #[test]
    fn completing_discovers_a_merged_pull_request_before_a_newer_closed_one() {
        for status in [TaskStatus::InProgress, TaskStatus::InReview] {
            for worktree in [true, false] {
                let fixture = local_fixture();
                if status == TaskStatus::InReview {
                    lock(&fixture.storage)
                        .set_task_status(fixture.task.id, status)
                        .unwrap();
                }
                if !worktree {
                    lock(&fixture.storage)
                        .clear_task_worktree(fixture.task.id)
                        .unwrap();
                }
                let mut git_results = vec![
                    Ok("origin\n".to_owned()),
                    origin("git@github.com:acme/toodo.git"),
                ];
                if worktree {
                    git_results.push(log(&[]));
                }
                let gh_runner = runner(vec![
                    merged_before_closed(),
                    viewed("MERGED", "main").map(|value| value.replace("/pull/12", "/pull/11")),
                    merged_details(&[SHA_A])
                        .map(|value| value.replace("\"number\":12", "\"number\":11")),
                ]);
                let (git, github) = adapters(&runner(git_results), &gh_runner);

                let done = complete(
                    &fixture.storage,
                    &git,
                    &github,
                    &closing_herdr().0,
                    fixture.task.id,
                )
                .unwrap();

                assert_eq!(done.status, TaskStatus::Done);
                assert_eq!(done.resolution, Some(model::TaskResolution::Merged));
                assert_eq!(
                    done.pull_request_url.as_deref(),
                    Some("https://github.com/acme/toodo/pull/11")
                );
                assert_eq!(done.pull_request_merged_at, Some(MERGED_AT.1));
                assert_eq!(done.pull_request.as_ref().unwrap().number, 11);
                assert_eq!(recorded_shas(&fixture), [SHA_A]);
                assert!(dependent_ready(&fixture));
                assert_eq!(stored(&fixture, &fixture.task), done);
            }
        }
    }

    #[test]
    fn background_checks_discover_merged_pull_requests_without_a_worktree() {
        for status in [TaskStatus::InProgress, TaskStatus::InReview] {
            let fixture = local_fixture();
            if status == TaskStatus::InReview {
                lock(&fixture.storage)
                    .set_task_status(fixture.task.id, status)
                    .unwrap();
            }
            lock(&fixture.storage)
                .clear_task_worktree(fixture.task.id)
                .unwrap();
            let git_runner = runner(vec![
                Ok("origin\n".to_owned()),
                origin("git@github.com:acme/toodo.git"),
            ]);
            let gh_runner = runner(vec![
                merged_before_closed(),
                viewed("MERGED", "main").map(|value| value.replace("/pull/12", "/pull/11")),
                merged_details(&[SHA_A])
                    .map(|value| value.replace("\"number\":12", "\"number\":11")),
            ]);
            let (git, github) = adapters(&git_runner, &gh_runner);
            let mut failures = HashMap::new();

            check_pull_requests(
                &fixture.storage,
                &git,
                &github,
                &closing_herdr().0,
                &Recorder::default(),
                &mut failures,
                &PullRequestStatusState::default(),
            );

            let done = stored(&fixture, &fixture.task);
            assert_eq!(done.status, TaskStatus::Done);
            assert_eq!(done.resolution, Some(model::TaskResolution::Merged));
            assert_eq!(
                done.pull_request_url.as_deref(),
                Some("https://github.com/acme/toodo/pull/11")
            );
            assert_eq!(done.pull_request_merged_at, Some(MERGED_AT.1));
            assert_eq!(done.pull_request.as_ref().unwrap().number, 11);
            assert!(failures.is_empty(), "{failures:?}");
            assert!(dependent_ready(&fixture));
        }
    }

    #[test]
    fn adopting_an_open_pull_request_without_a_worktree_keeps_recorded_commits() {
        for status in [TaskStatus::InProgress, TaskStatus::InReview] {
            let fixture = local_fixture();
            if status == TaskStatus::InReview {
                lock(&fixture.storage)
                    .set_task_status(fixture.task.id, status)
                    .unwrap();
            }
            lock(&fixture.storage)
                .clear_task_worktree(fixture.task.id)
                .unwrap();
            let records = vec![model::CommitRecord {
                task_id: fixture.task.id,
                sha: SHA_A.to_owned(),
                message: "Add login".to_owned(),
                author: "Ada <ada@example.com>".to_owned(),
                committed_at: 1,
            }];
            lock(&fixture.storage)
                .replace_commit_records(fixture.task.id, &records)
                .unwrap();
            let git_runner = runner(vec![
                Ok("origin\n".to_owned()),
                origin("git@github.com:acme/toodo.git"),
            ]);
            let gh_runner = runner(vec![Ok(format!(
                "[{},{}]",
                pull_request_json("CLOSED", "main"),
                pull_request_json("OPEN", "main").replace("/pull/12", "/pull/11"),
            ))]);
            let (git, github) = adapters(&git_runner, &gh_runner);

            let adopted = adopt_pull_request(&fixture.storage, &git, &github, fixture.task.id)
                .unwrap()
                .unwrap();

            assert_eq!(adopted.status, TaskStatus::InReview);
            assert_eq!(
                adopted.pull_request_url.as_deref(),
                Some("https://github.com/acme/toodo/pull/11")
            );
            assert_eq!(adopted.pull_request_merged_at, None);
            assert_eq!(recorded_shas(&fixture), [SHA_A]);
            assert_eq!(git_commands(&git_runner), ["remote", "remote"]);
        }
    }

    #[test]
    fn merged_with_rejects_an_own_merged_pull_request_before_a_newer_closed_one() {
        let fixture = local_fixture();
        lock(&fixture.storage)
            .clear_task_worktree(fixture.task.id)
            .unwrap();
        let git_runner = runner(vec![
            log(&[]),
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
        ]);
        let gh_runner = runner(vec![
            viewed("MERGED", "main").map(|value| value.replace("/pull/12", "/pull/13")),
            merged_before_closed(),
        ]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let error = complete_merged_with(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
            MergedWithTarget::PullRequest("https://github.com/acme/toodo/pull/13".to_owned()),
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains("https://github.com/acme/toodo/pull/11")
        );
        assert_eq!(
            stored(&fixture, &fixture.task).status,
            TaskStatus::InProgress
        );
    }

    #[test]
    fn an_open_pull_request_opened_outside_toodo_is_adopted_and_pushed() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![
            log(&[SHA_A]),
            origin("git@github.com:acme/toodo.git"),
            Ok(String::new()),
        ]);
        let gh_runner = runner(vec![listed("OPEN", "main")]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

        assert_eq!(in_review.status, TaskStatus::InReview);
        assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
        assert_eq!(
            git_commands(&git_runner),
            ["worktree", "log", "remote", "push"]
        );
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert_eq!(recorded_shas(&fixture), [SHA_A]);
    }

    #[test]
    fn a_merged_pull_request_is_adopted_without_pushing_and_can_be_completed() {
        let fixture = local_fixture();
        lock(&fixture.storage)
            .replace_commit_records(
                fixture.task.id,
                &[model::CommitRecord {
                    task_id: fixture.task.id,
                    sha: SHA_A.to_owned(),
                    message: "Add login".to_owned(),
                    author: "Ada <ada@example.com>".to_owned(),
                    committed_at: 1,
                }],
            )
            .unwrap();
        let git_runner = checkout_runner(vec![log(&[]), origin("git@github.com:acme/toodo.git")]);
        let gh_runner = runner(vec![
            listed("MERGED", "main"),
            viewed("MERGED", "main"),
            merged_details(&[]),
        ]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

        assert_eq!(in_review.status, TaskStatus::InReview);
        assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
        assert_eq!(in_review.pull_request_merged_at, Some(MERGED_AT.1));
        assert_eq!(git_commands(&git_runner), ["worktree", "log", "remote"]);
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert_eq!(recorded_shas(&fixture), [SHA_A]);
        assert!(!dependent_ready(&fixture));

        let completed = complete(
            &fixture.storage,
            &no_git(),
            &github,
            &closing_herdr().0,
            fixture.task.id,
        )
        .unwrap();
        assert_eq!(completed.status, TaskStatus::Done);
        assert!(dependent_ready(&fixture));
        // A pull request without commits keeps the commits recorded before.
        assert_eq!(recorded_shas(&fixture), [SHA_A]);
    }

    #[test]
    fn a_closed_pull_request_is_replaced_by_a_new_one() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![
            log(&[SHA_A]),
            origin("git@github.com:acme/toodo.git"),
            Ok(String::new()),
        ]);
        let new_pr = "https://github.com/acme/toodo/pull/13";
        let gh_runner = runner(vec![listed("CLOSED", "develop"), Ok(format!("{new_pr}\n"))]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

        assert_eq!(in_review.pull_request_url.as_deref(), Some(new_pr));
        assert_eq!(
            git_commands(&git_runner),
            ["worktree", "log", "remote", "push"]
        );
        assert_eq!(invocations(&gh_runner)[1].args[..2], ["pr", "create"]);
    }

    #[test]
    fn a_pull_request_into_another_base_is_rejected_when_opening() {
        let fixture = local_fixture();
        let git_runner =
            checkout_runner(vec![log(&[SHA_A]), origin("git@github.com:acme/toodo.git")]);
        let gh_runner = runner(vec![listed("OPEN", "develop")]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let error = open(&fixture.storage, &git, &github, fixture.task.id).unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains("merges into develop, not the workspace base branch main"),
            "{}",
            error.message
        );
        assert_eq!(git_commands(&git_runner), ["worktree", "log", "remote"]);
        assert_eq!(stored(&fixture, &fixture.task), fixture.task);
        assert!(recorded_shas(&fixture).is_empty());
    }

    #[test]
    fn a_pull_request_into_another_base_is_rejected_when_completing() {
        let fixture = in_review_fixture();
        let github = GitHub::new(Box::new(runner(vec![viewed("MERGED", "develop")])));

        let error = complete(
            &fixture.storage,
            &no_git(),
            &github,
            &no_herdr(),
            fixture.task.id,
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("merges into develop"));
        assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
        assert!(!dependent_ready(&fixture));
    }

    #[test]
    fn completing_a_task_with_a_merged_pull_request_finishes_it_and_releases_dependents() {
        let fixture = in_review_fixture();
        lock(&fixture.storage)
            .replace_commit_records(
                fixture.task.id,
                &[model::CommitRecord {
                    task_id: fixture.task.id,
                    sha: SHA_A.to_owned(),
                    message: "Add login".to_owned(),
                    author: "Ada <ada@example.com>".to_owned(),
                    committed_at: 1,
                }],
            )
            .unwrap();
        let gh_runner = runner(vec![
            viewed("MERGED", "main"),
            merged_details(&[SHA_A, SHA_B]),
        ]);
        let github = GitHub::new(Box::new(gh_runner.clone()));
        let (herdr, herdr_runner) = closing_herdr();

        let completed = complete(
            &fixture.storage,
            &no_git(),
            &github,
            &herdr,
            fixture.task.id,
        )
        .unwrap();

        assert_eq!(
            completed.pull_request,
            Some(model::PullRequestSnapshot {
                number: 12,
                title: "Add login".to_owned(),
                additions: 10,
                deletions: 3,
                changed_files: 2,
                merge_commit_sha: Some(SHA_B.to_owned()),
                review_count: 1,
                reviewer_count: 1,
                first_reviewed_at: Some(MERGED_AT.1),
            })
        );
        // The commits pushed after the pull request was opened are recorded too.
        assert_eq!(recorded_shas(&fixture), [SHA_A, SHA_B]);
        assert_eq!(completed.completion_note, None);

        assert_eq!(completed.status, TaskStatus::Done);
        assert_eq!(completed.pull_request_url.as_deref(), Some(PR));
        assert_eq!(completed.pull_request_merged_at, Some(MERGED_AT.1));
        assert_eq!(
            completed.timeline.last().map(|event| event.status),
            Some(TaskStatus::Done)
        );
        assert_eq!(completed.herdr_workspace_id, None);
        assert_eq!(completed.worktree_path, fixture.task.worktree_path);
        assert_eq!(stored(&fixture, &fixture.task), completed);
        assert_eq!(
            invocations(&herdr_runner)[0].args,
            ["workspace", "close", "w27"].map(str::to_owned)
        );
        assert!(dependent_ready(&fixture));
        assert_eq!(
            invocations(&gh_runner)[0].args,
            [
                "pr",
                "view",
                PR,
                "--json",
                "url,state,baseRefName,mergedAt,statusCheckRollup,reviewDecision,latestReviews,headRefOid"
            ]
            .map(str::to_owned)
        );
        assert_eq!(invocations(&gh_runner)[1].args[..3], ["pr", "view", PR]);
    }

    #[test]
    fn a_failure_to_read_the_merged_pull_request_keeps_the_task_in_review() {
        let fixture = in_review_fixture();
        let github = GitHub::new(Box::new(runner(vec![
            viewed("MERGED", "main"),
            Err(failed()),
        ])));
        let before = stored(&fixture, &fixture.task);

        complete(
            &fixture.storage,
            &no_git(),
            &github,
            &no_herdr(),
            fixture.task.id,
        )
        .unwrap_err();

        // The merge is recorded on the criterion; everything else stays as it was.
        let mut after = stored(&fixture, &fixture.task);
        assert_eq!(after.criteria[0].state, CriterionState::Met);
        after.criteria = before.criteria.clone();
        assert_eq!(after, before);
        assert!(!dependent_ready(&fixture));
    }

    #[test]
    fn a_pull_request_that_is_not_merged_keeps_the_task_in_review() {
        let fixture = in_review_fixture();
        let github = GitHub::new(Box::new(runner(vec![
            viewed("OPEN", "main"),
            viewed("CLOSED", "main"),
        ])));

        for expected in [
            "is not merged yet",
            "was closed without merging; reopen the pull request, ask the user to pause the task in the Toodo app, or conclude_task if the work is abandoned",
        ] {
            let error = complete(
                &fixture.storage,
                &no_git(),
                &github,
                &no_herdr(),
                fixture.task.id,
            )
            .unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::Rejected);
            assert!(error.message.contains(expected), "{}", error.message);
        }
        assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
        assert!(!dependent_ready(&fixture));
    }

    #[test]
    fn only_an_in_review_task_can_be_completed() {
        let fixture = local_fixture();
        let gh_runner = runner(Vec::new());
        let github = GitHub::new(Box::new(gh_runner.clone()));

        let error = complete(
            &fixture.storage,
            &Git::new(Box::new(runner(vec![Ok(String::new())]))),
            &github,
            &no_herdr(),
            fixture.task.id,
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("the task has no pull request yet"),
            "{}",
            error.message
        );
        assert!(invocations(&gh_runner).is_empty());
        let error = complete(
            &fixture.storage,
            &no_git(),
            &github,
            &no_herdr(),
            model::TaskId(999),
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
    }

    #[test]
    fn a_herdr_workspace_that_is_already_closed_does_not_block_completion() {
        let fixture = in_review_fixture();
        let github = GitHub::new(Box::new(runner(vec![
            viewed("MERGED", "main"),
            merged_details(&[]),
        ])));
        let herdr = Herdr::new(Box::new(runner(vec![Err(GitError::Failed {
            command: "herdr workspace close".to_owned(),
            stderr:
                r#"{"error":{"code":"workspace_not_found","message":"workspace w27 not found"}}"#
                    .to_owned(),
        })])));

        let completed = complete(
            &fixture.storage,
            &no_git(),
            &github,
            &herdr,
            fixture.task.id,
        )
        .unwrap();

        assert_eq!(completed.status, TaskStatus::Done);
        assert_eq!(completed.herdr_workspace_id, None);
    }

    #[test]
    fn concluding_closes_the_open_pull_request_and_keeps_dependents_waiting() {
        let fixture = in_review_fixture();
        let git_runner = runner(vec![
            log(&[SHA_A, SHA_B]),
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
        ]);
        let gh_runner = runner(vec![listed("OPEN", "main"), Ok(String::new())]);
        let (git, github) = adapters(&git_runner, &gh_runner);
        let (herdr, herdr_runner) = closing_herdr();

        let concluded = conclude(
            &fixture.storage,
            &git,
            &github,
            &herdr,
            fixture.task.id,
            "  Twice as slow as the current cache\n",
            OpenPullRequest::Close,
        )
        .unwrap();

        assert_eq!(concluded.status, TaskStatus::Done);
        assert_eq!(
            concluded.resolution,
            Some(model::TaskResolution::NotAdopted)
        );
        assert_eq!(
            concluded.completion_note.as_deref(),
            Some("Twice as slow as the current cache")
        );
        assert_eq!(
            concluded.timeline.last().map(|event| event.status),
            Some(TaskStatus::Done)
        );
        assert_eq!(concluded.branch.as_deref(), Some("feat/add-login-1"));
        assert_eq!(concluded.worktree_path, fixture.task.worktree_path);
        assert_eq!(concluded.pull_request_url.as_deref(), Some(PR));
        assert_eq!(concluded.herdr_workspace_id, None);
        assert_eq!(stored(&fixture, &fixture.task), concluded);
        assert_eq!(recorded_shas(&fixture), [SHA_A, SHA_B]);
        assert_eq!(git_commands(&git_runner), ["log", "remote", "remote"]);
        assert_eq!(
            invocations(&gh_runner)[0].args[..8],
            [
                "pr",
                "list",
                "--repo",
                "github.com/acme/toodo",
                "--head",
                "feat/add-login-1",
                "--base",
                "main"
            ]
            .map(str::to_owned)
        );
        assert_eq!(
            invocations(&gh_runner)[1].args,
            [
                "pr",
                "close",
                PR,
                "--comment",
                "Twice as slow as the current cache"
            ]
            .map(str::to_owned)
        );
        assert_eq!(
            invocations(&herdr_runner)[0].args,
            ["workspace", "close", "w27"].map(str::to_owned)
        );
        assert!(!dependent_ready(&fixture));
    }

    #[test]
    fn concluding_an_in_progress_task_whose_branch_has_no_pull_request() {
        let fixture = local_fixture();
        let git_runner = runner(vec![
            log(&[]),
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
        ]);
        let gh_runner = runner(vec![Ok("[]\n".to_owned())]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        let concluded = conclude(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
            "Not worth it",
            OpenPullRequest::Close,
        )
        .unwrap();

        assert_eq!(
            concluded.resolution,
            Some(model::TaskResolution::NotAdopted)
        );
        assert_eq!(concluded.pull_request_url, None);
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert!(recorded_shas(&fixture).is_empty());
        assert!(!dependent_ready(&fixture));

        // A done task cannot be concluded again.
        let error = conclude(
            &fixture.storage,
            &no_git(),
            &github,
            &no_herdr(),
            fixture.task.id,
            "Again",
            OpenPullRequest::Close,
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
    }

    #[test]
    fn concluding_a_task_whose_pull_request_was_closed_does_not_close_it_again() {
        let fixture = in_review_fixture();
        let gh_runner = runner(vec![listed("CLOSED", "main")]);
        let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);

        let concluded = conclude(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
            "Superseded",
            OpenPullRequest::Close,
        )
        .unwrap();

        assert_eq!(concluded.status, TaskStatus::Done);
        assert_eq!(invocations(&gh_runner).len(), 1);
    }

    #[test]
    fn concluding_without_closing_rejects_an_open_pull_request_and_changes_nothing() {
        let fixture = in_review_fixture();
        let before = stored(&fixture, &fixture.task);
        let gh_runner = runner(vec![listed("OPEN", "main")]);
        let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);

        let error = conclude(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
            "Not adopted",
            OpenPullRequest::Reject,
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("is still open"), "{}", error.message);
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert_eq!(stored(&fixture, &fixture.task), before);
        assert!(recorded_shas(&fixture).is_empty());
    }

    #[test]
    fn concluding_is_rejected_without_a_note_for_planned_tasks_and_for_merged_pull_requests() {
        let fixture = in_review_fixture();
        let before = stored(&fixture, &fixture.task);

        let error = conclude(
            &fixture.storage,
            &no_git(),
            &GitHub::new(Box::new(runner(Vec::new()))),
            &no_herdr(),
            fixture.task.id,
            " \n",
            OpenPullRequest::Close,
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);

        let error = conclude(
            &fixture.storage,
            &no_git(),
            &GitHub::new(Box::new(runner(Vec::new()))),
            &no_herdr(),
            fixture.dependent.id,
            "Not needed",
            OpenPullRequest::Close,
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains("only an in_progress or in_review task")
        );

        let gh_runner = runner(vec![listed("MERGED", "main")]);
        let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);
        let error = conclude(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
            "Not adopted",
            OpenPullRequest::Close,
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("was merged"), "{}", error.message);
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert_eq!(stored(&fixture, &fixture.task), before);
    }

    /// A git whose branch log has `shas` and whose `origin` is on GitHub.
    fn github_checkout(shas: &[&str]) -> Arc<FakeRunner> {
        runner(vec![
            log(shas),
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
        ])
    }

    #[test]
    fn concluding_finds_an_open_pull_request_that_was_not_recorded_yet() {
        let fixture = local_fixture();
        let before = stored(&fixture, &fixture.task);
        assert_eq!(before.pull_request_url, None);

        // Through MCP the conclusion is rejected and nothing changes.
        let gh_runner = runner(vec![listed("OPEN", "main")]);
        let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);
        let error = conclude(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
            "Not adopted",
            OpenPullRequest::Reject,
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains(&format!("{PR} is still open")),
            "{}",
            error.message
        );
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert_eq!(stored(&fixture, &fixture.task), before);
        assert!(recorded_shas(&fixture).is_empty());

        // The app closes it with the conclusion, records it, and concludes.
        let gh_runner = runner(vec![listed("OPEN", "main"), Ok(String::new())]);
        let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);
        let concluded = conclude(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
            "Not adopted",
            OpenPullRequest::Close,
        )
        .unwrap();
        assert_eq!(concluded.status, TaskStatus::Done);
        assert_eq!(
            concluded.resolution,
            Some(model::TaskResolution::NotAdopted)
        );
        assert_eq!(concluded.pull_request_url.as_deref(), Some(PR));
        assert_eq!(stored(&fixture, &fixture.task), concluded);
        assert_eq!(
            invocations(&gh_runner)[1].args,
            ["pr", "close", PR, "--comment", "Not adopted"].map(str::to_owned)
        );
    }

    #[test]
    fn concluding_is_rejected_for_a_merged_pull_request_that_was_not_recorded_yet() {
        let fixture = local_fixture();
        let before = stored(&fixture, &fixture.task);
        for open_pull_request in [OpenPullRequest::Reject, OpenPullRequest::Close] {
            let gh_runner = runner(vec![merged_before_closed()]);
            let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);
            let error = conclude(
                &fixture.storage,
                &git,
                &github,
                &no_herdr(),
                fixture.task.id,
                "Not adopted",
                open_pull_request,
            )
            .unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::Rejected);
            assert!(
                error.message.contains("completes with the merge"),
                "{}",
                error.message
            );
            assert_eq!(invocations(&gh_runner).len(), 1);
            assert_eq!(stored(&fixture, &fixture.task), before);
        }
    }

    #[test]
    fn concluding_skips_gh_for_a_repository_without_origin() {
        let fixture = local_fixture();
        let git_runner = runner(vec![log(&[]), Ok(String::new())]);
        let gh_runner = runner(Vec::new());
        let (git, github) = adapters(&git_runner, &gh_runner);

        let concluded = conclude(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
            "Not worth it",
            OpenPullRequest::Reject,
        )
        .unwrap();

        assert_eq!(concluded.status, TaskStatus::Done);
        assert_eq!(git_commands(&git_runner), ["log", "remote"]);
        assert!(invocations(&gh_runner).is_empty());
    }

    #[test]
    fn concluding_fails_and_changes_nothing_when_the_lookup_fails() {
        let fixture = in_review_fixture();
        let before = stored(&fixture, &fixture.task);
        let gh_runner = runner(vec![Err(GitError::Failed {
            command: "gh pr list".to_owned(),
            stderr: "error connecting to api.github.com".to_owned(),
        })]);
        let (git, github) = adapters(&github_checkout(&[SHA_A]), &gh_runner);

        let error = conclude(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
            "Not adopted",
            OpenPullRequest::Close,
        )
        .unwrap_err();

        assert!(
            error.message.contains("error connecting to api.github.com"),
            "{}",
            error.message
        );
        assert_eq!(invocations(&gh_runner).len(), 1);
        assert_eq!(stored(&fixture, &fixture.task), before);
        assert!(recorded_shas(&fixture).is_empty());
    }

    #[test]
    fn completing_a_done_task_says_how_it_was_done() {
        let fixture = local_fixture();
        let git_runner = runner(vec![log(&[]), Ok(String::new())]);
        let (git, github) = adapters(&git_runner, &runner(Vec::new()));
        conclude(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
            "Not worth it",
            OpenPullRequest::Close,
        )
        .unwrap();

        let error = complete(
            &fixture.storage,
            &no_git(),
            &github,
            &no_herdr(),
            fixture.task.id,
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("is already done as not_adopted"),
            "{}",
            error.message
        );
    }

    #[derive(Default)]
    struct Recorder(
        Mutex<Vec<model::WorkspaceId>>,
        Mutex<Vec<Vec<types::TaskPullRequestStatus>>>,
    );

    impl Notifier for Recorder {
        fn tasks_changed(&self, workspace: model::WorkspaceId) {
            self.0.lock().unwrap().push(workspace);
        }

        fn workspaces_changed(&self) {}

        fn agent_statuses_changed(&self, _: &[types::TaskAgentStatus]) {}

        fn pull_request_statuses_changed(&self, statuses: &[types::TaskPullRequestStatus]) {
            self.1.lock().unwrap().push(statuses.to_vec());
        }
    }

    #[test]
    fn a_merged_pull_request_completes_its_task_automatically() {
        let fixture = in_review_fixture();
        let gh_runner = runner(vec![
            viewed("OPEN", "main"),
            viewed("MERGED", "main"),
            merged_details(&[]),
        ]);
        let github = GitHub::new(Box::new(gh_runner.clone()));
        let (herdr, herdr_runner) = closing_herdr();
        let recorder = Recorder::default();
        let mut failures = HashMap::new();
        let statuses = PullRequestStatusState::default();

        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &herdr,
            &recorder,
            &mut failures,
            &statuses,
        );
        assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
        assert!(recorder.0.lock().unwrap().is_empty());
        assert!(invocations(&herdr_runner).is_empty());

        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &herdr,
            &recorder,
            &mut failures,
            &statuses,
        );
        let done = stored(&fixture, &fixture.task);
        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.pull_request_merged_at, Some(MERGED_AT.1));
        assert!(dependent_ready(&fixture));
        assert_eq!(*recorder.0.lock().unwrap(), [done.workspace_id]);
        assert_eq!(invocations(&herdr_runner).len(), 1);
        assert!(failures.is_empty());

        // A done task is no longer checked.
        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &herdr,
            &recorder,
            &mut failures,
            &statuses,
        );
        assert_eq!(invocations(&gh_runner).len(), 3);
    }

    #[test]
    fn an_open_pull_request_with_passing_checks_is_reported_ready_and_not_merged() {
        let criterion = NewCriterion::parse(
            "Pull request open with green checks",
            CheckKind::PullRequestOpenChecksPassed,
            None,
        )
        .unwrap();
        let fixture = local_criteria_fixture(vec![criterion]);
        lock(&fixture.storage)
            .open_pull_request(fixture.task.id, &[], PR, None)
            .unwrap();
        let passing = r#"[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]"#;
        let mut view: serde_json::Value =
            serde_json::from_str(&viewed_with("OPEN", "main", passing, "\"\"").unwrap()).unwrap();
        view["headRefOid"] = serde_json::json!(SHA_A);
        let github = GitHub::new(Box::new(runner(vec![Ok(view.to_string())])));
        let git = Git::new(Box::new(checkout_runner(vec![
            Err(failed()),
            log(&[SHA_A]),
        ])));
        let (herdr, _) = closing_herdr();
        let recorder = Recorder::default();

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &herdr,
            &recorder,
            &mut HashMap::new(),
            &PullRequestStatusState::default(),
        );

        let done = stored(&fixture, &fixture.task);
        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.pull_request_merged_at, None);
    }

    #[test]
    fn checks_keep_the_ci_and_review_state_of_open_pull_requests_and_announce_changes() {
        let fixture = in_review_fixture();
        let running = r#"[{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""}]"#;
        let failing = r#"[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]"#;
        let github = GitHub::new(Box::new(runner(vec![
            viewed_with("OPEN", "main", running, "\"\""),
            viewed_with("OPEN", "main", running, "\"\""),
            viewed_with("OPEN", "main", failing, "\"CHANGES_REQUESTED\""),
            Err(failed()),
            viewed("MERGED", "main"),
            merged_details(&[]),
        ])));
        let (herdr, _) = closing_herdr();
        let recorder = Recorder::default();
        let mut failures = HashMap::new();
        let statuses = PullRequestStatusState::default();
        let check = |failures: &mut HashMap<_, _>| {
            check_pull_requests(
                &fixture.storage,
                &worktree_git(),
                &github,
                &herdr,
                &recorder,
                failures,
                &statuses,
            );
        };
        let status = |checks, review| types::TaskPullRequestStatus {
            task_id: fixture.task.id.into(),
            checks: Some(checks),
            review,
        };
        let pending = status(types::ChecksStatus::Pending, types::ReviewStatus::Pending);
        let failed = status(
            types::ChecksStatus::Failing,
            types::ReviewStatus::ChangesRequested,
        );

        // An unchanged state is announced once; a failed check keeps the last one.
        for _ in 0..4 {
            check(&mut failures);
        }
        assert_eq!(
            *recorder.1.lock().unwrap(),
            [vec![pending], vec![failed.clone()]]
        );
        assert_eq!(list(&statuses), [failed]);

        // A merged pull request leaves no state behind.
        check(&mut failures);
        assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::Done);
        assert!(recorder.1.lock().unwrap().last().unwrap().is_empty());
        assert!(list(&statuses).is_empty());
    }

    fn list(statuses: &PullRequestStatusState) -> Vec<types::TaskPullRequestStatus> {
        all_statuses(&lock_statuses(statuses))
    }

    #[test]
    fn a_failed_check_keeps_the_task_in_review_and_remembers_the_failure() {
        let fixture = in_review_fixture();
        let github = GitHub::new(Box::new(runner(vec![
            Err(failed()),
            viewed("OPEN", "main"),
        ])));
        let recorder = Recorder::default();
        let mut failures = HashMap::new();
        let statuses = PullRequestStatusState::default();

        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &no_herdr(),
            &recorder,
            &mut failures,
            &statuses,
        );
        assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
        assert_eq!(failures.keys().collect::<Vec<_>>(), [&fixture.task.id]);

        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &no_herdr(),
            &recorder,
            &mut failures,
            &statuses,
        );
        assert!(failures.is_empty());
        assert!(recorder.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_pull_request_opened_outside_toodo_moves_an_in_progress_task_to_review() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
            worktrees(),
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
            log(&[SHA_A]),
        ]);
        let gh_runner = runner(vec![
            Ok("[]".to_owned()),
            listed("OPEN", "main"),
            viewed("OPEN", "main"),
        ]);
        let (git, github) = adapters(&git_runner, &gh_runner);
        let recorder = Recorder::default();
        let mut failures = HashMap::new();
        let statuses = PullRequestStatusState::default();

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            &recorder,
            &mut failures,
            &statuses,
        );
        assert_eq!(stored(&fixture, &fixture.task), fixture.task);
        assert!(recorder.0.lock().unwrap().is_empty());

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            &recorder,
            &mut failures,
            &statuses,
        );
        let in_review = stored(&fixture, &fixture.task);
        assert_eq!(in_review.status, TaskStatus::InReview);
        assert_eq!(in_review.pull_request_url.as_deref(), Some(PR));
        assert_eq!(in_review.pull_request_merged_at, None);
        assert_eq!(recorded_shas(&fixture), [SHA_A]);
        assert_eq!(*recorder.0.lock().unwrap(), [in_review.workspace_id]);
        assert!(!dependent_ready(&fixture));
        assert!(failures.is_empty());
        // Nothing is pushed: the pull request already has the branch.
        assert_eq!(
            git_commands(&git_runner),
            [
                "worktree", "remote", "remote", "worktree", "remote", "remote", "log"
            ]
        );
        assert_eq!(
            invocations(&gh_runner)[1].args[..6],
            [
                "pr",
                "list",
                "--repo",
                "github.com/acme/toodo",
                "--head",
                "feat/add-login-1"
            ]
            .map(str::to_owned)
        );
        // The task is now checked as an in_review task.
        assert_eq!(
            invocations(&gh_runner)[2].args[..2],
            ["pr", "view"].map(str::to_owned)
        );
    }

    const ISSUE: &str = "https://github.com/acme/toodo/issues/12";

    fn link_issue(fixture: &Fixture) {
        lock(&fixture.storage)
            .set_task_issue(
                fixture.task.id,
                Some(&model::LinkedIssue {
                    number: 12,
                    url: ISSUE.to_owned(),
                }),
            )
            .unwrap();
    }

    fn body(text: &str) -> Result<String, GitError> {
        Ok(serde_json::json!({ "body": text }).to_string())
    }

    #[test]
    fn a_new_pull_request_of_a_task_with_an_issue_closes_it() {
        let fixture = local_fixture();
        link_issue(&fixture);
        let git_runner = checkout_runner(vec![
            log(&[SHA_A]),
            origin("git@github.com:acme/toodo.git"),
            Ok(String::new()),
        ]);
        let gh_runner = runner(vec![Ok("[]".to_owned()), Ok(format!("{PR}\n"))]);
        let (git, github) = adapters(&git_runner, &gh_runner);

        open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

        let create = &invocations(&gh_runner)[1].args;
        assert_eq!(create[1], "create");
        assert_eq!(create.last().unwrap(), "Implement Add login\n\nCloses #12");
        assert_eq!(invocations(&gh_runner).len(), 2);
    }

    #[test]
    fn an_adopted_open_pull_request_gets_a_closing_reference_unless_it_has_one() {
        for (existing, edited) in [
            ("Work by an agent", Some("Work by an agent\n\nCloses #12")),
            ("Work by an agent\n\nfixes #12", None),
        ] {
            let fixture = local_fixture();
            link_issue(&fixture);
            let git_runner = checkout_runner(vec![
                log(&[SHA_A]),
                origin("git@github.com:acme/toodo.git"),
                Ok(String::new()),
            ]);
            let gh_runner = runner(vec![
                listed("OPEN", "main"),
                body(existing),
                Ok(String::new()),
            ]);
            let (git, github) = adapters(&git_runner, &gh_runner);

            let in_review = open(&fixture.storage, &git, &github, fixture.task.id).unwrap();

            assert_eq!(in_review.status, TaskStatus::InReview);
            let calls = invocations(&gh_runner);
            assert_eq!(
                calls[1].args,
                ["pr", "view", PR, "--json", "body"].map(str::to_owned)
            );
            match edited {
                Some(edited) => assert_eq!(
                    calls[2].args,
                    ["pr", "edit", PR, "--body", edited].map(str::to_owned)
                ),
                None => assert_eq!(calls.len(), 2),
            }
        }
    }

    #[test]
    fn a_pull_request_opened_by_an_agent_gets_a_closing_reference_in_the_same_check() {
        let fixture = local_fixture();
        link_issue(&fixture);
        let git_runner = checkout_runner(vec![
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
            log(&[SHA_A]),
            worktrees(),
        ]);
        let gh_runner = runner(vec![
            listed("OPEN", "main"),
            viewed("OPEN", "main"),
            body("Work by an agent"),
            Ok(String::new()),
            viewed("OPEN", "main"),
            body("Work by an agent\n\nCloses #12"),
        ]);
        let (git, github) = adapters(&git_runner, &gh_runner);
        let recorder = Recorder::default();
        let mut failures = HashMap::new();
        let statuses = PullRequestStatusState::default();

        for _ in 0..2 {
            check_pull_requests(
                &fixture.storage,
                &git,
                &github,
                &no_herdr(),
                &recorder,
                &mut failures,
                &statuses,
            );
        }

        assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);
        assert!(failures.is_empty());
        let calls = invocations(&gh_runner);
        assert_eq!(
            calls[3].args,
            ["pr", "edit", PR, "--body", "Work by an agent\n\nCloses #12"].map(str::to_owned)
        );
        // The second check finds the reference and edits nothing.
        assert_eq!(calls.len(), 6);
    }

    #[test]
    fn an_in_progress_task_whose_pull_request_was_merged_is_completed_in_one_check() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
            log(&[]),
        ]);
        let gh_runner = runner(vec![
            listed("MERGED", "main"),
            viewed("MERGED", "main"),
            merged_details(&[]),
        ]);
        let (git, github) = adapters(&git_runner, &gh_runner);
        let (herdr, herdr_runner) = closing_herdr();
        let recorder = Recorder::default();
        let mut failures = HashMap::new();
        let statuses = PullRequestStatusState::default();

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &herdr,
            &recorder,
            &mut failures,
            &statuses,
        );

        let done = stored(&fixture, &fixture.task);
        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.pull_request_url.as_deref(), Some(PR));
        assert_eq!(done.pull_request_merged_at, Some(MERGED_AT.1));
        assert!(dependent_ready(&fixture));
        assert_eq!(invocations(&herdr_runner).len(), 1);
        assert_eq!(recorder.0.lock().unwrap().len(), 2);
        assert!(failures.is_empty());
    }

    #[test]
    fn a_closed_pull_request_or_one_into_another_base_keeps_the_task_in_progress() {
        let fixture = local_fixture();
        let git_runner = checkout_runner(vec![
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
            worktrees(),
            Ok("origin\n".to_owned()),
            origin("git@github.com:acme/toodo.git"),
        ]);
        let gh_runner = runner(vec![listed("CLOSED", "main"), listed("OPEN", "develop")]);
        let (git, github) = adapters(&git_runner, &gh_runner);
        let recorder = Recorder::default();
        let mut failures = HashMap::new();
        let statuses = PullRequestStatusState::default();

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            &recorder,
            &mut failures,
            &statuses,
        );
        assert!(failures.is_empty());
        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            &recorder,
            &mut failures,
            &statuses,
        );
        assert!(
            failures[&fixture.task.id].contains("merges into develop"),
            "{failures:?}"
        );

        assert_eq!(stored(&fixture, &fixture.task), fixture.task);
        assert!(recorder.0.lock().unwrap().is_empty());
        assert_eq!(
            git_commands(&git_runner),
            [
                "worktree", "remote", "remote", "worktree", "remote", "remote"
            ]
        );
    }

    #[test]
    fn a_herdr_failure_keeps_the_task_in_review() {
        let fixture = in_review_fixture();
        let github = GitHub::new(Box::new(runner(vec![
            viewed("MERGED", "main"),
            merged_details(&[SHA_A]),
        ])));
        let herdr = Herdr::new(Box::new(runner(vec![Err(GitError::Spawn {
            program: "herdr".to_owned(),
            message: "program not found".to_owned(),
        })])));
        let before = stored(&fixture, &fixture.task);

        let error = complete(
            &fixture.storage,
            &no_git(),
            &github,
            &herdr,
            fixture.task.id,
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::External);
        // The merge is recorded on the criterion; everything else stays as it was.
        let mut after = stored(&fixture, &fixture.task);
        assert_eq!(after.criteria[0].state, CriterionState::Met);
        after.criteria = before.criteria.clone();
        assert_eq!(after, before);
        assert!(!dependent_ready(&fixture));
    }

    /// A local task whose criteria are `criteria`, in a repository without `origin`.
    fn local_criteria_fixture(criteria: Vec<NewCriterion>) -> Fixture {
        fixture_with(
            WorkspaceLocation::Local {
                path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
            },
            HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-add-login-1").unwrap()),
            criteria,
        )
    }

    #[test]
    fn completing_without_a_pull_request_records_the_note_commits_and_readiness() {
        for status in [TaskStatus::InProgress, TaskStatus::InReview] {
            let fixture = local_fixture();
            if status == TaskStatus::InReview {
                lock(&fixture.storage)
                    .set_task_status(fixture.task.id, status)
                    .unwrap();
            }
            let git_runner = runner(vec![
                Ok("origin\n".to_owned()),
                origin("git@github.com:acme/toodo.git"),
                log(&[SHA_A, SHA_B]),
            ]);
            let (git, github) = adapters(&git_runner, &runner(vec![Ok("[]".to_owned())]));

            let done = complete_without_pull_request(
                &fixture.storage,
                &git,
                &github,
                &closing_herdr().0,
                fixture.task.id,
                "  Deployed the configuration directly  ",
            )
            .unwrap();

            assert_eq!(done.status, TaskStatus::Done);
            assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
            assert_eq!(done.pull_request_url, None);
            assert_eq!(done.pull_request_merged_at, None);
            assert_eq!(done.merged_with, None);
            assert_eq!(
                done.completion_note.as_deref(),
                Some("Deployed the configuration directly")
            );
            assert!(done.criteria[0].is_met());
            assert_eq!(done.criteria[0].evidence, done.completion_note);
            assert_eq!(recorded_shas(&fixture), [SHA_A, SHA_B]);
            assert!(dependent_ready(&fixture));
            assert_eq!(stored(&fixture, &fixture.task), done);
            lock(&fixture.storage)
                .ensure_ready(fixture.dependent.id)
                .unwrap();
        }
    }

    #[test]
    fn completing_without_a_pull_request_requires_a_non_empty_note() {
        let fixture = local_fixture();
        for note in ["", " \n\t "] {
            let error = complete_without_pull_request(
                &fixture.storage,
                &no_git(),
                &GitHub::new(Box::new(runner(vec![]))),
                &no_herdr(),
                fixture.task.id,
                note,
            )
            .unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::InvalidInput);
            assert!(error.message.contains("note"));
            assert_eq!(stored(&fixture, &fixture.task), fixture.task);
        }
    }

    #[test]
    fn completing_without_a_pull_request_rejects_every_existing_pr_state() {
        for state in ["MERGED", "OPEN", "CLOSED"] {
            for recorded in [false, true] {
                let fixture = local_fixture();
                if recorded {
                    lock(&fixture.storage)
                        .open_pull_request(fixture.task.id, &[], PR, None)
                        .unwrap();
                }
                let before = stored(&fixture, &fixture.task);
                let git_runner = runner(vec![
                    Ok("origin\n".to_owned()),
                    origin("git@github.com:acme/toodo.git"),
                ]);
                let (git, github) = adapters(&git_runner, &runner(vec![listed(state, "main")]));

                let error = complete_without_pull_request(
                    &fixture.storage,
                    &git,
                    &github,
                    &no_herdr(),
                    fixture.task.id,
                    "Shipped",
                )
                .unwrap_err();

                assert_eq!(error.kind, CommandErrorKind::Rejected);
                assert!(error.message.contains(PR), "{}", error.message);
                assert!(
                    error.message.contains(if state == "MERGED" {
                        "call complete_task"
                    } else {
                        "wait for"
                    }),
                    "{}",
                    error.message
                );
                assert_eq!(stored(&fixture, &fixture.task), before);
                assert!(!dependent_ready(&fixture));
            }
        }
    }

    #[test]
    fn completing_without_a_pull_request_keeps_other_criteria_required() {
        let fixture = local_criteria_fixture(vec![
            NewCriterion::merge(true),
            manual("Verify deployment"),
            NewCriterion::parse("CI passes", CheckKind::PullRequestOpenChecksPassed, None).unwrap(),
            NewCriterion::parse("Health check", CheckKind::Url, Some("https://example.com"))
                .unwrap(),
            NewCriterion::parse("Tests", CheckKind::Command, Some("npm test")).unwrap(),
        ]);
        lock(&fixture.storage)
            .clear_task_worktree(fixture.task.id)
            .unwrap();
        let (git, github) = adapters(
            &runner(vec![Ok(String::new()), Err(failed())]),
            &runner(vec![]),
        );

        let error = complete_without_pull_request(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
            "Deployed",
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error.message.contains("4 of its completion criteria"),
            "{}",
            error.message
        );
        for next in ["check_criterion", "fix its CI", "make URL", "make command"] {
            assert!(error.message.contains(next), "{}", error.message);
        }
        let after = stored(&fixture, &fixture.task);
        assert!(
            !after.criteria[0].is_met(),
            "a failed attempt must not persist the waiver"
        );
        assert_eq!(after.completion_note, None);
        assert!(!dependent_ready(&fixture));
    }

    #[test]
    fn completing_without_a_pull_request_keeps_met_manual_evidence() {
        let fixture = local_criteria_fixture(vec![NewCriterion::merge(true), manual("Verified")]);
        lock(&fixture.storage)
            .check_criterion(
                fixture.task.id,
                fixture.task.criteria[1].id,
                true,
                Some("Verified on the deployed system"),
                criteria::CheckedBy::Agent,
            )
            .unwrap();
        let (git, github) = adapters(
            &runner(vec![Ok(String::new()), log(&[SHA_A])]),
            &runner(vec![]),
        );

        let done = complete_without_pull_request(
            &fixture.storage,
            &git,
            &github,
            &closing_herdr().0,
            fixture.task.id,
            "Deployed without a pull request",
        )
        .unwrap();

        assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
        assert_eq!(
            done.criteria[1].evidence.as_deref(),
            Some("Verified on the deployed system")
        );
        assert!(dependent_ready(&fixture));
    }

    #[test]
    fn a_failed_no_pr_completion_does_not_persist_the_merge_waiver() {
        let fixture = local_fixture();
        let (git, github) = adapters(
            &runner(vec![Ok(String::new()), log(&[SHA_A])]),
            &runner(vec![]),
        );
        let herdr = Herdr::new(Box::new(runner(vec![Err(failed())])));

        let error = complete_without_pull_request(
            &fixture.storage,
            &git,
            &github,
            &herdr,
            fixture.task.id,
            "Deployed",
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::External);
        assert_eq!(stored(&fixture, &fixture.task), fixture.task);
        assert!(!dependent_ready(&fixture));
    }

    #[test]
    fn no_pr_completion_rejects_a_recorded_pr_missing_from_the_branch_lookup() {
        let fixture = local_fixture();
        lock(&fixture.storage)
            .open_pull_request(fixture.task.id, &[], PR, None)
            .unwrap();
        let before = stored(&fixture, &fixture.task);
        let (git, github) = adapters(
            &runner(vec![Ok(String::new())]),
            &runner(vec![viewed("MERGED", "main")]),
        );

        let error = complete_without_pull_request(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
            "Deployed",
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("call complete_task"));
        assert_eq!(stored(&fixture, &fixture.task), before);
    }

    #[test]
    fn a_task_without_criteria_or_a_branch_completes_as_completed() {
        let fixture = local_fixture();
        let task = {
            let mut storage = lock(&fixture.storage);
            let task = storage
                .create_task(&NewTask {
                    workspace_id: fixture.task.workspace_id,
                    task_type: TaskType::Chore,
                    title: "Configure deployment".to_owned(),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: vec![],
                })
                .unwrap();
            storage
                .set_task_status(task.id, TaskStatus::InProgress)
                .unwrap()
        };
        let github = GitHub::new(Box::new(runner(vec![])));

        let done = complete(&fixture.storage, &no_git(), &github, &no_herdr(), task.id).unwrap();

        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.resolution, Some(model::TaskResolution::Completed));
        assert_eq!(
            lock(&fixture.storage).get_task(task.id).unwrap(),
            Some(done)
        );
    }

    fn manual(text: &str) -> NewCriterion {
        NewCriterion::parse(text, CheckKind::Manual, None).unwrap()
    }

    /// Records `start` as the commit the task's branch started from.
    fn set_start(fixture: &Fixture, start: &str) {
        let criterion = fixture.task.criteria[0].id;
        lock(&fixture.storage)
            .record_criterion_checks(
                fixture.task.id,
                &[CriterionCheck {
                    id: criterion,
                    state: CriterionState::Pending,
                    evidence: None,
                    target: Some(start.to_owned()),
                }],
            )
            .unwrap();
    }

    /// Git output of a branch merged into `main` with two commits since it started.
    fn merged_locally() -> Vec<Result<String, GitError>> {
        vec![
            Ok(format!("{SHA_B}\n")),
            Ok("0\n".to_owned()),
            Ok("2\n".to_owned()),
        ]
    }

    #[test]
    fn a_branch_merged_locally_completes_a_task_without_origin_or_gh() {
        let fixture = local_criteria_fixture(vec![NewCriterion::merge(false)]);
        set_start(&fixture, SHA_A);
        let mut results = vec![Ok(String::new())];
        results.extend(merged_locally());
        // The commits since the start; `origin/<start>` does not exist.
        results.extend([Err(failed()), log(&[SHA_A, SHA_B])]);
        let git_runner = runner(results);
        let gh_runner = runner(Vec::new());
        let (git, github) = adapters(&git_runner, &gh_runner);
        let (herdr, _) = closing_herdr();

        let done = complete(&fixture.storage, &git, &github, &herdr, fixture.task.id).unwrap();

        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.resolution, Some(model::TaskResolution::Merged));
        assert_eq!(done.criteria[0].state, CriterionState::Met);
        assert_eq!(
            done.criteria[0].evidence.as_deref(),
            Some("feat/add-login-1 merged into main with 2 commits")
        );
        assert_eq!(recorded_shas(&fixture), [SHA_A, SHA_B]);
        assert!(dependent_ready(&fixture));
        assert!(invocations(&gh_runner).is_empty());
        let commands: Vec<String> = invocations(&git_runner)
            .iter()
            .map(|invocation| invocation.args[2..].join(" "))
            .collect();
        assert_eq!(
            commands[1..4],
            [
                "rev-parse --verify --quiet refs/heads/feat/add-login-1".to_owned(),
                "rev-list --count refs/heads/main..refs/heads/feat/add-login-1".to_owned(),
                format!("rev-list --count {SHA_A}..refs/heads/feat/add-login-1"),
            ]
        );
    }

    #[test]
    fn a_branch_ahead_of_its_base_is_not_merged_and_keeps_where_it_started() {
        let fixture = local_criteria_fixture(vec![NewCriterion::merge(false)]);
        let git_runner = runner(vec![
            Ok(String::new()),
            Ok(format!("{SHA_B}\n")),
            Ok("3\n".to_owned()),
            Ok(format!("{SHA_A}\n")),
        ]);
        let gh_runner = runner(Vec::new());
        let (git, github) = adapters(&git_runner, &gh_runner);

        let error = complete(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            fixture.task.id,
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains("1 of its completion criteria is not met"),
            "{}",
            error.message
        );
        let task = stored(&fixture, &fixture.task);
        assert_eq!(task.status, TaskStatus::InProgress);
        assert_eq!(task.criteria[0].target.as_deref(), Some(SHA_A));
    }

    #[test]
    fn a_met_manual_criterion_awaits_confirmation_before_the_task_is_done() {
        let fixture =
            local_criteria_fixture(vec![NewCriterion::merge(false), manual("Docs reviewed")]);
        set_start(&fixture, SHA_A);
        let reviewed = fixture.task.criteria[1].id;
        lock(&fixture.storage)
            .check_criterion(
                fixture.task.id,
                reviewed,
                true,
                Some("approved"),
                criteria::CheckedBy::User,
            )
            .unwrap();
        let git_runner = checkout_runner(merged_locally());
        let gh_runner = runner(Vec::new());
        let (git, github) = adapters(&git_runner, &gh_runner);
        let recorder = Recorder::default();
        let mut failures = HashMap::new();

        check_pull_requests(
            &fixture.storage,
            &git,
            &github,
            &no_herdr(),
            &recorder,
            &mut failures,
            &PullRequestStatusState::default(),
        );

        let awaiting = stored(&fixture, &fixture.task);
        assert_eq!(awaiting.status, TaskStatus::InReview);
        assert!(awaiting.criteria.iter().all(|criterion| criterion.is_met()));
        assert_eq!(*recorder.0.lock().unwrap(), [awaiting.workspace_id]);
        assert!(failures.is_empty(), "{failures:?}");
        assert!(!dependent_ready(&fixture));

        // Nothing is left to check, so the next check runs nothing.
        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &no_herdr(),
            &recorder,
            &mut failures,
            &PullRequestStatusState::default(),
        );
        assert_eq!(stored(&fixture, &fixture.task).status, TaskStatus::InReview);

        let git_runner = runner(vec![Ok(String::new()), Err(failed()), log(&[SHA_B])]);
        let git = Git::new(Box::new(git_runner.clone()));
        let (herdr, _) = closing_herdr();
        let done = complete(&fixture.storage, &git, &github, &herdr, fixture.task.id).unwrap();
        assert_eq!(done.status, TaskStatus::Done);
        assert!(dependent_ready(&fixture));
    }

    #[test]
    fn confirming_is_rejected_while_a_manual_criterion_is_not_met() {
        let fixture = local_criteria_fixture(vec![manual("Docs reviewed")]);
        let gh_runner = runner(Vec::new());
        let github = GitHub::new(Box::new(gh_runner.clone()));

        let error = complete(
            &fixture.storage,
            &Git::new(Box::new(runner(vec![Ok(String::new())]))),
            &github,
            &no_herdr(),
            fixture.task.id,
        )
        .unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains(r#""Docs reviewed" (manual, pending)"#),
            "{}",
            error.message
        );
        assert_eq!(
            stored(&fixture, &fixture.task).status,
            TaskStatus::InProgress
        );
    }

    #[test]
    fn a_task_without_criteria_is_completed_when_confirmed() {
        let fixture = local_criteria_fixture(Vec::new());
        let git_runner = runner(vec![Ok(String::new()), Err(failed()), Ok(String::new())]);
        let git = Git::new(Box::new(git_runner.clone()));
        let gh_runner = runner(Vec::new());
        let github = GitHub::new(Box::new(gh_runner.clone()));
        let (herdr, _) = closing_herdr();

        // The background check never completes it on its own.
        check_pull_requests(
            &fixture.storage,
            &worktree_git(),
            &github,
            &no_herdr(),
            &Recorder::default(),
            &mut HashMap::new(),
            &PullRequestStatusState::default(),
        );
        assert_eq!(
            stored(&fixture, &fixture.task).status,
            TaskStatus::InProgress
        );

        let done = complete(&fixture.storage, &git, &github, &herdr, fixture.task.id).unwrap();
        assert_eq!(done.status, TaskStatus::Done);
    }

    #[test]
    fn a_command_criterion_runs_once_the_others_are_met_and_reports_its_failure() {
        let command =
            NewCriterion::parse("Tests pass", CheckKind::Command, Some("npm test")).unwrap();
        let fixture = local_criteria_fixture(vec![manual("Docs reviewed"), command]);
        let gh_runner = runner(Vec::new());
        let github = GitHub::new(Box::new(gh_runner.clone()));
        let mut failures = HashMap::new();
        let check = |git: &Git, failures: &mut HashMap<model::TaskId, String>| {
            check_pull_requests(
                &fixture.storage,
                git,
                &github,
                &no_herdr(),
                &Recorder::default(),
                failures,
                &PullRequestStatusState::default(),
            );
        };
        // The manual criterion is not met yet, so the command does not run.
        check(&worktree_git(), &mut failures);
        assert_eq!(
            stored(&fixture, &fixture.task).criteria[1].state,
            CriterionState::Pending
        );

        lock(&fixture.storage)
            .check_criterion(
                fixture.task.id,
                fixture.task.criteria[0].id,
                true,
                Some("approved"),
                criteria::CheckedBy::Agent,
            )
            .unwrap();
        let git_runner = checkout_runner(vec![
            worktrees(),
            Err(GitError::Failed {
                command: "cmd".to_owned(),
                stderr: "1 test failed".to_owned(),
            }),
        ]);
        check(&Git::new(Box::new(git_runner.clone())), &mut failures);
        let task = stored(&fixture, &fixture.task);
        assert_eq!(task.criteria[1].state, CriterionState::Failed);
        assert!(
            task.criteria[1]
                .evidence
                .as_deref()
                .is_some_and(|evidence| evidence.contains("1 test failed"))
        );
        assert_eq!(task.status, TaskStatus::InProgress);
        let ran = invocations(&git_runner);
        assert_eq!(ran[2].program, "cmd");
        assert_eq!(
            ran[2].args.last().map(String::as_str),
            Some(r#"cd /d "D:\wt\toodo\feat-add-login-1" && npm test"#)
        );

        let git_runner = checkout_runner(vec![worktrees(), Ok("12 passed\n".to_owned())]);
        check(&Git::new(Box::new(git_runner)), &mut failures);
        let task = stored(&fixture, &fixture.task);
        assert_eq!(task.criteria[1].state, CriterionState::Met);
        assert_eq!(task.status, TaskStatus::InReview);
    }
}
