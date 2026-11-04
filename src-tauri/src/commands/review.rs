//! Commands for reviewing the work done in a period, such as a week or a year.

use super::State;

use super::types::{BackfillSummary, ReviewEntry, Task, Timestamp};
use super::{CommandError, CommandResult, GitHubState, GitState, StorageState, lock};
use crate::adapters::git::Git;
use crate::adapters::github::{GitHub, ListedPullRequest};
use crate::domain::model::{Source, TaskType, Workspace, WorkspaceLocation};
use crate::domain::remote::GitHubRepository;
use crate::domain::review::{self, Period};
use crate::storage::{MergedPullRequestTask, Storage};

/// Tasks of every workspace that reached a milestone or got a commit in `[start, end)`,
/// ordered by outcome, then by time. The caller picks the period, such as a week, a
/// month, or a year in the local time zone.
#[specta::specta]
pub fn review_period(
    storage: State<'_, StorageState>,
    start: Timestamp,
    end: Timestamp,
) -> CommandResult<Vec<ReviewEntry>> {
    review_entries(&lock(&storage), start, end)
}

/// Records the pull requests the signed-in `gh` user merged into the base branch of each
/// GitHub workspace in `[start, end)` as tasks done as merged, each planned, started,
/// and in review from the opening of its pull request, so a review of that time shows
/// work from before Toodo tracked it. A pull request a task already records, or whose
/// branch a task of its workspace has, is skipped, so importing again adds nothing
/// twice. A workspace whose pull requests cannot be read is reported in `failures`;
/// the others are still imported.
#[specta::specta]
pub fn backfill_pull_requests(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    github: State<'_, GitHubState>,
    start: Timestamp,
    end: Timestamp,
) -> CommandResult<BackfillSummary> {
    backfill(&storage, &git, &**github, start, end)
}

fn backfill(
    storage: &StorageState,
    git: &Git,
    github: &dyn GitHub,
    start: Timestamp,
    end: Timestamp,
) -> CommandResult<BackfillSummary> {
    Period::new(start.0, end.0).map_err(|error| CommandError::invalid_input(error.to_string()))?;
    let workspaces = lock(storage).list_workspaces()?;
    let mut summary = BackfillSummary::default();
    for workspace in workspaces
        .iter()
        .filter(|workspace| workspace.source == Source::GitHub)
    {
        let merged = match merged_pull_requests(git, github, workspace, start.0, end.0) {
            Ok(merged) => merged,
            Err(error) => {
                summary
                    .failures
                    .push(format!("Workspace {}: {}", workspace.name, error.message));
                continue;
            }
        };
        for pull_request in &merged {
            let task = merged_task(workspace, pull_request);
            match lock(storage).record_merged_pull_request(&task)? {
                Some(_) => summary.imported += 1,
                None => summary.skipped += 1,
            }
        }
    }
    Ok(summary)
}

/// The pull requests merged into the base branch of `workspace` in `[since, until)`.
fn merged_pull_requests(
    git: &Git,
    github: &dyn GitHub,
    workspace: &Workspace,
    since: i64,
    until: i64,
) -> CommandResult<Vec<ListedPullRequest>> {
    let location = &workspace.location;
    let path = match location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    };
    let origin = git.origin_url(location, path)?;
    let repository = GitHubRepository::from_remote_url(&origin).ok_or_else(|| {
        CommandError::rejected(format!(
            "its origin remote {origin} names no GitHub repository; point origin at the GitHub repository with git remote set-url origin <url>, then import again"
        ))
    })?;
    Ok(github.merged_pull_requests(&repository, &workspace.default_base_branch, since, until)?)
}

fn merged_task(workspace: &Workspace, pull_request: &ListedPullRequest) -> MergedPullRequestTask {
    MergedPullRequestTask {
        workspace_id: workspace.id,
        task_type: inferred_type(&pull_request.head, &pull_request.title),
        title: pull_request.title.trim().to_owned(),
        description: format!(
            "Recorded from pull request [#{}]({}), merged before Toodo tracked its work.",
            pull_request.number, pull_request.url
        ),
        branch: pull_request.head.clone(),
        pull_request_url: pull_request.url.clone(),
        opened_at: pull_request.created_at,
        merged_at: pull_request.merged_at,
    }
}

/// The task type a branch prefix (`fix/...`) or a conventional commit title
/// (`docs: ...`) names; `modify` when neither names one.
fn inferred_type(branch: &str, title: &str) -> TaskType {
    let branch_prefix = branch.split_once('/').map(|(prefix, _)| prefix);
    let title_prefix = title
        .split_once(':')
        .map(|(prefix, _)| prefix.split(['(', '!']).next().unwrap_or(prefix));
    [branch_prefix, title_prefix]
        .into_iter()
        .flatten()
        .find_map(|prefix| match prefix.trim().to_ascii_lowercase().as_str() {
            "feat" | "feature" => Some(TaskType::Feat),
            "fix" | "bugfix" | "hotfix" => Some(TaskType::Fix),
            "modify" | "perf" | "style" => Some(TaskType::Modify),
            "refactor" => Some(TaskType::Refactor),
            "docs" | "doc" => Some(TaskType::Docs),
            "test" | "tests" => Some(TaskType::Test),
            "chore" | "build" | "ci" => Some(TaskType::Chore),
            "rnd" | "research" | "spike" => Some(TaskType::Rnd),
            _ => None,
        })
        .unwrap_or(TaskType::Modify)
}

fn review_entries(
    storage: &Storage,
    start: Timestamp,
    end: Timestamp,
) -> CommandResult<Vec<ReviewEntry>> {
    let period = Period::new(start.0, end.0)
        .map_err(|error| CommandError::invalid_input(error.to_string()))?;
    let mut tasks = Vec::new();
    for workspace in storage.list_workspaces()? {
        tasks.extend(storage.list_tasks(workspace.id)?);
    }
    let commits = storage.list_commit_records_in(period)?;
    Ok(review::review(period, &tasks, &commits)
        .into_iter()
        .map(|reviewed| {
            let task = tasks
                .iter()
                .find(|task| task.id == reviewed.task_id)
                .expect("a review entry belongs to a reviewed task");
            ReviewEntry {
                task: Task::from(task),
                outcome: reviewed.outcome.into(),
                at: Timestamp(reviewed.at),
                commits: reviewed.commits.iter().map(Into::into).collect(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::CommandErrorKind;
    use crate::commands::types::ReviewOutcome;
    use crate::domain::model::{CommitRecord, TaskType, WorkspaceLocation};
    use crate::domain::path::WindowsPath;
    use crate::domain::status::TaskStatus;
    use crate::storage::{NewTask, NewWorkspace};

    #[test]
    fn reviews_tasks_of_every_workspace_and_rejects_an_empty_period() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 500);
        let mut add_task = |name: &str| {
            let workspace = storage
                .create_workspace(&NewWorkspace {
                    name: name.to_owned(),
                    location: WorkspaceLocation::Local {
                        path: WindowsPath::parse(&format!(r"C:\dev\{name}"))
                            .unwrap()
                            .into(),
                    },
                    default_base_branch: "main".to_owned(),
                    source: crate::domain::model::Source::GitHub,
                    completion: crate::domain::model::CompletionMode::PullRequestMerge,
                    runner: crate::domain::model::Runner::Herdr,
                    axes_detected: true,
                })
                .unwrap();
            storage
                .create_task(&NewTask {
                    workspace_id: workspace.id,
                    task_type: TaskType::Feat,
                    title: format!("Work on {name}"),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: Vec::new(),
                })
                .unwrap()
        };
        let started = add_task("toodo");
        let committed = add_task("herdr");
        storage
            .set_task_status(started.id, TaskStatus::InProgress)
            .unwrap();
        let record = CommitRecord {
            task_id: committed.id,
            sha: "abc".to_owned(),
            message: "Add herdr".to_owned(),
            author: "Dev <dev@example.com>".to_owned(),
            committed_at: 1500,
        };
        storage
            .replace_commit_records(committed.id, std::slice::from_ref(&record))
            .unwrap();

        let entries = review_entries(&storage, Timestamp(1000), Timestamp(2000)).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.task.title.as_str(), entry.outcome, entry.at.0))
            .collect();
        assert_eq!(summary, [("Work on herdr", ReviewOutcome::WorkedOn, 1500)]);
        assert_eq!(entries[0].commits, [(&record).into()]);

        let entries = review_entries(&storage, Timestamp(0), Timestamp(1000)).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.task.title.as_str(), entry.outcome))
            .collect();
        assert_eq!(
            summary,
            [
                ("Work on toodo", ReviewOutcome::Started),
                ("Work on herdr", ReviewOutcome::Planned),
            ]
        );

        let error = review_entries(&storage, Timestamp(10), Timestamp(10)).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }

    #[test]
    fn backfill_records_merged_pull_requests_once_and_reports_unreadable_workspaces() {
        use std::sync::{Arc, Mutex};

        use crate::adapters::git::fake::FakeRunner;
        use crate::adapters::github::GhCli;

        let mut storage = Storage::open_in_memory().unwrap();
        for name in ["toodo", "elsewhere"] {
            storage
                .create_workspace(&NewWorkspace {
                    name: name.to_owned(),
                    location: WorkspaceLocation::Local {
                        path: WindowsPath::parse(&format!(r"C:\dev\{name}"))
                            .unwrap()
                            .into(),
                    },
                    default_base_branch: "main".to_owned(),
                    source: Source::GitHub,
                    completion: crate::domain::model::CompletionMode::PullRequestMerge,
                    runner: crate::domain::model::Runner::Herdr,
                    axes_detected: true,
                })
                .unwrap();
        }
        let storage = Mutex::new(storage);
        let origins = || {
            [
                Ok("git@github.com:acme/toodo.git\n".to_owned()),
                Ok("/srv/git/elsewhere.git\n".to_owned()),
            ]
        };
        let git = Git::new(Box::new(Arc::new(FakeRunner::new(
            origins().into_iter().chain(origins()),
        ))));
        let listed = serde_json::json!([
            {
                "url": "https://github.com/acme/toodo/pull/4",
                "number": 4,
                "title": "docs: Explain the review",
                "headRefName": "explain-review",
                "createdAt": "1970-01-01T00:16:40Z",
                "mergedAt": "1970-01-01T00:25:00Z",
            },
        ])
        .to_string();
        let github = GhCli::new(Box::new(Arc::new(FakeRunner::new([
            Ok(listed.clone()),
            Ok(listed),
        ]))));

        let summary = backfill(&storage, &git, &github, Timestamp(1000), Timestamp(2000)).unwrap();

        assert_eq!((summary.imported, summary.skipped), (1, 0));
        assert_eq!(summary.failures.len(), 1);
        assert!(
            summary.failures[0]
                .starts_with("Workspace elsewhere: its origin remote /srv/git/elsewhere.git")
        );
        let entries = review_entries(&lock(&storage), Timestamp(1000), Timestamp(2000)).unwrap();
        let summary_of: Vec<_> = entries
            .iter()
            .map(|entry| {
                (
                    entry.task.title.as_str(),
                    entry.task.task_type,
                    entry.outcome,
                    entry.at.0,
                )
            })
            .collect();
        assert_eq!(
            summary_of,
            [(
                "docs: Explain the review",
                crate::commands::types::TaskType::Docs,
                ReviewOutcome::Completed,
                1500
            )]
        );

        let again = backfill(&storage, &git, &github, Timestamp(1000), Timestamp(2000)).unwrap();
        assert_eq!((again.imported, again.skipped), (0, 1));
    }

    #[test]
    fn the_task_type_comes_from_the_branch_prefix_or_a_conventional_title() {
        assert_eq!(inferred_type("fix/crash", "Stop a crash"), TaskType::Fix);
        assert_eq!(
            inferred_type("main-docs", "docs(readme): Add"),
            TaskType::Docs
        );
        assert_eq!(inferred_type("feature/x", "chore: y"), TaskType::Feat);
        assert_eq!(inferred_type("update", "Fix: a typo"), TaskType::Fix);
        assert_eq!(inferred_type("update", "Add a page"), TaskType::Modify);
    }
}
