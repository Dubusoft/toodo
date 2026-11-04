use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use super::pull_request::{adopt_pull_request, clear_missing_worktree};
use super::settle::{Settle, Settled, branch_commits, settle};
use crate::adapters::git::Git;
use crate::adapters::github::{ChecksState, GitHub, PullRequestState, PullRequestStatus};
use crate::adapters::herdr::Herdr;
use crate::commands::Runtime;
use crate::commands::events::Notifier;
use crate::commands::types;
use crate::commands::{CommandError, CommandResult, StorageState, lock};
use crate::domain::activity::{self, ActivityEvent, ActivityKind, ActivitySource};
use crate::domain::model;
use crate::domain::status::TaskStatus;
use crate::storage::StorageError;

/// CI and review state of the open pull request of each `in_review` task, as of the last
/// check.
pub type PullRequestStatusState = Mutex<HashMap<model::TaskId, PullRequestStatus>>;

pub(super) fn lock_statuses(
    statuses: &PullRequestStatusState,
) -> MutexGuard<'_, HashMap<model::TaskId, PullRequestStatus>> {
    statuses.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The pull request statuses, ordered by task ID.
pub(super) fn all_statuses(
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
            let mut activity_failures = HashMap::new();
            loop {
                check_pull_requests(
                    app.storage(),
                    app.git(),
                    app.github(),
                    app.herdr(),
                    app.as_ref(),
                    &mut failures,
                    Some(&mut activity_failures),
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
/// signed in) is logged once. `activity_failures` does the same for reading the git
/// activity of each task, which runs after the pull request lookups and before settling,
/// so a merge is recorded before it completes the task; `None` skips that step.
/// `statuses` gets the CI and review state of each pull request of an `in_review` task
/// still open; a failed check keeps the last one known.
#[allow(clippy::too_many_arguments)]
pub(super) fn check_pull_requests(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    herdr: &Herdr,
    notifier: &dyn Notifier,
    failures: &mut HashMap<model::TaskId, String>,
    activity_failures: Option<&mut HashMap<model::TaskId, String>>,
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
    if let Some(activity_failures) = activity_failures {
        poll_activity(storage, git, github, notifier, activity_failures);
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
                        record_completion_activity(storage, id);
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

/// Reads and records the git activity of every `in_progress` or `in_review` task with a
/// branch in a workspace that tracks it, announcing tasks that got new events. Nothing
/// runs for the other workspaces. `failures` holds the last failure of each task, so a
/// failure that repeats on every check is logged once.
fn poll_activity(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    notifier: &dyn Notifier,
    failures: &mut HashMap<model::TaskId, String>,
) {
    let tasks = match lock(storage).list_all_tasks() {
        Ok(tasks) => tasks,
        Err(error) => {
            eprintln!("toodo: failed to list tasks: {error}");
            return;
        }
    };
    let mut polled = Vec::new();
    for task in &tasks {
        if !matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview)
            || task.branch.is_none()
        {
            continue;
        }
        let workspace = match lock(storage).get_workspace(task.workspace_id) {
            Ok(Some(workspace)) => workspace,
            _ => continue,
        };
        if !activity::tracks(workspace.source, workspace.completion) {
            continue;
        }
        polled.push(task.id);
        let recorded = read_activity(storage, git, github, task, &workspace).and_then(|events| {
            let mut storage = lock(storage);
            let now = storage.now();
            Ok(storage.record_activity(task.id, &events, now)?)
        });
        match recorded {
            Ok(new) => {
                failures.remove(&task.id);
                if new > 0 {
                    notifier.tasks_changed(task.workspace_id);
                }
            }
            Err(error) => remember_failure(failures, task.id, "read its git activity", error),
        }
    }
    failures.retain(|id, _| polled.contains(id));
}

/// The git activity of a task being worked on: the commits of its branch and, in a
/// GitHub workspace, what its pull request shows.
fn read_activity(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    task: &model::Task,
    workspace: &model::Workspace,
) -> CommandResult<Vec<ActivityEvent>> {
    let mut events = activity::commit_events(
        &branch_commits(git, task, workspace)?,
        ActivitySource::GitPoll,
    );
    let Some(url) = task
        .pull_request_url
        .as_ref()
        .filter(|_| workspace.source == model::Source::GitHub)
    else {
        return Ok(events);
    };
    let pull_request = github.pull_request_activity(url)?;
    let event = |kind, external_ref: &str, title: &str, occurred_at| ActivityEvent {
        task_id: task.id,
        kind,
        source: ActivitySource::GitHubPoll,
        external_ref: external_ref.to_owned(),
        title: title.to_owned(),
        author: None,
        occurred_at,
    };
    events.push(event(
        ActivityKind::PullRequestOpened,
        url,
        &pull_request.title,
        pull_request.created_at,
    ));
    if let (Some((state, finished_at)), Some(sha)) = (pull_request.checks, &pull_request.head_sha) {
        let kind = match state {
            ChecksState::Passing => Some((ActivityKind::ChecksPassed, "passed")),
            ChecksState::Failing => Some((ActivityKind::ChecksFailed, "failed")),
            ChecksState::Pending => None,
        };
        if let Some((kind, result)) = kind {
            let short: String = sha.chars().take(7).collect();
            let occurred_at = finished_at.unwrap_or_else(|| lock(storage).now());
            events.push(event(
                kind,
                sha,
                &format!("CI {result} on {short}"),
                occurred_at,
            ));
        }
    }
    if let Some(merged_at) = pull_request.merged_at {
        events.push(event(
            ActivityKind::PullRequestMerged,
            url,
            &pull_request.title,
            merged_at,
        ));
    }
    Ok(events)
}

/// Records the git activity a task completed just now keeps: its commit records, which
/// include the commits of a merged pull request, and the merge of its pull request. Only
/// for a workspace that tracks activity; a failure is logged, as the task is done anyway.
pub(super) fn record_completion_activity(storage: &StorageState, id: model::TaskId) {
    let recorded = (|| -> CommandResult<usize> {
        let mut storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        if !activity::tracks(workspace.source, workspace.completion) {
            return Ok(0);
        }
        let source = if task.pull_request.is_some() {
            ActivitySource::GitHubPoll
        } else {
            ActivitySource::GitPoll
        };
        let mut events = activity::commit_events(&storage.list_commit_records(id)?, source);
        if let (Some(url), Some(merged_at)) = (&task.pull_request_url, task.pull_request_merged_at)
        {
            events.push(ActivityEvent {
                task_id: id,
                kind: ActivityKind::PullRequestMerged,
                source: ActivitySource::GitHubPoll,
                external_ref: url.clone(),
                title: task
                    .pull_request
                    .as_ref()
                    .map_or_else(|| task.title.clone(), |snapshot| snapshot.title.clone()),
                author: None,
                occurred_at: merged_at,
            });
        }
        let now = storage.now();
        Ok(storage.record_activity(id, &events, now)?)
    })();
    if let Err(error) = recorded {
        eprintln!(
            "toodo: task {id}: failed to record its git activity: {}",
            error.message
        );
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
