use super::background::record_completion_activity;
use super::pull_request::{
    adopt_pull_request, branch_pull_request, check_base, ensure_closing_reference,
};
use crate::adapters::git::{Git, GitError, LocalMerge};
use crate::adapters::github::{ChecksState, GitHub, PullRequestState, ViewedPullRequest};
use crate::adapters::herdr::Herdr;
use crate::commands::{CommandError, CommandResult, StorageState, lock};
use crate::domain::criteria::{self, CheckKind, CriterionState, Decision};
use crate::domain::model::{self, WorkspaceLocation};
use crate::domain::status::TaskStatus;
use crate::runtime::RuntimeService;
use crate::storage::{CriterionCheck, StorageError};

/// Completes a task being worked on whose completion criteria are met, which is also how
/// a task with a manual criterion is confirmed: Toodo first checks the criteria it checks
/// on its own, then completes the task if every criterion is met. A task without
/// criteria is completed as it is. Rejected with the criteria not met yet.
pub(crate) fn complete(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    herdr: &Herdr,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    match settle(storage, git, github, herdr, id, Settle::Confirm)? {
        Settled::Done(task) => {
            record_completion_activity(storage, id);
            Ok(*task)
        }
        Settled::Open { task, viewed, .. } => Err(not_complete(&task, viewed.as_ref())),
    }
}

/// Completes work shipped without any pull request, with its explanation as evidence.
pub(crate) fn complete_without_pull_request(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
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
pub(super) enum Settle<'a> {
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
pub(super) enum Settled {
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
pub(super) fn settle(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
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
/// is missing. A task that never had a worktree (no branch, e.g. of a workspace with
/// runner none) runs it in the workspace location.
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
    let run = |dir: &str| match git.run_command(location, dir, command) {
        Ok(output) => check(
            CriterionState::Met,
            clip(&format!("`{command}` succeeded\n{}", output.trim())),
        ),
        Err(error) => check(CriterionState::Failed, clip(&error.to_string())),
    };
    if task.worktree_path.is_none() && task.branch.is_none() {
        let (WorkspaceLocation::Local { path } | WorkspaceLocation::Ssh { path, .. }) = location;
        return run(&path.to_string());
    }
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
    run(&worktree.to_string())
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
    github: &dyn GitHub,
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
    let machine = workspace.location.machine();
    Ok(
        RuntimeService.close_workspace(storage, herdr, id, &machine, |storage| match note {
            Some(note) => storage.complete_task_without_pull_request(id, note, &commits),
            None => storage.complete_task(id, merged_at, snapshot.as_ref(), &commits),
        })?,
    )
}

/// The commits of a task's branch since it started (the start commit a
/// `branch_merged_locally` criterion found), or else those not on the base branch; none
/// for a task without a branch. After a local merge only the start tells them apart.
pub(super) fn branch_commits(
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
