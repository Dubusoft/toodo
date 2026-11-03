//! Commands that link a task to a GitHub issue of its workspace repository, found with
//! `gh` in the repository named by the workspace's `origin` remote. The pull request of
//! a task with an issue closes it on merge: Toodo writes `Closes #<number>` into the
//! pull requests it opens and adds it to open ones that lack a closing reference,
//! including those opened outside Toodo (see [`super::completion`]).

use super::State;

use super::completion::ensure_closing_reference;
use super::types::{Task, TaskId};
use super::{CommandError, CommandResult, GitHubState, GitState, StorageState, lock};
use crate::adapters::git::Git;
use crate::adapters::github::{GitHub, PullRequestState};
use crate::domain::model::{self, LinkedIssue, WorkspaceLocation};
use crate::domain::remote::GitHubRepository;
use crate::domain::status::TaskStatus;
use crate::storage::StorageError;

/// Links issue `number` of the workspace repository to a task that is not done, after
/// checking that the issue exists; `null` unlinks the current issue. An open pull
/// request of the task gets a closing reference to the issue.
#[specta::specta]
pub fn link_issue(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    github: State<'_, GitHubState>,
    id: TaskId,
    number: Option<u32>,
) -> CommandResult<Task> {
    Ok((&link(&storage, &git, &github, id.into(), number)?).into())
}

/// Opens an issue in the workspace repository with the title and description of a task
/// that is not done and has no issue yet, and links it to the task. An open pull request
/// of the task gets a closing reference to the issue.
#[specta::specta]
pub fn create_issue(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    github: State<'_, GitHubState>,
    id: TaskId,
) -> CommandResult<Task> {
    Ok((&create(&storage, &git, &github, id.into())?).into())
}

/// A task that may change its issue, with the GitHub repository of its workspace.
fn issue_target(
    storage: &StorageState,
    git: &Git,
    id: model::TaskId,
) -> CommandResult<(model::Task, GitHubRepository)> {
    let (task, location) = {
        let storage = lock(storage);
        let task = storage
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        let workspace = storage
            .get_workspace(task.workspace_id)?
            .ok_or(StorageError::WorkspaceNotFound(task.workspace_id))?;
        (task, workspace.location)
    };
    if task.status == TaskStatus::Done {
        return Err(CommandError::rejected(format!(
            "task {id} is done; its issue can no longer change"
        )));
    }
    let path = match &location {
        WorkspaceLocation::Local { path } => path.as_str(),
        WorkspaceLocation::Ssh { path, .. } => path.as_str(),
    };
    let origin = git.origin_url(&location, path)?;
    let repository = GitHubRepository::from_remote_url(&origin).ok_or_else(|| {
        CommandError::rejected(format!(
            "remote origin {origin:?} is not a GitHub repository; issues are linked on GitHub only"
        ))
    })?;
    Ok((task, repository))
}

fn link(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
    id: model::TaskId,
    number: Option<u32>,
) -> CommandResult<model::Task> {
    let Some(number) = number else {
        let task = lock(storage)
            .get_task(id)?
            .ok_or(StorageError::TaskNotFound(id))?;
        if task.status == TaskStatus::Done {
            return Err(CommandError::rejected(format!(
                "task {id} is done; its issue can no longer change"
            )));
        }
        return Ok(lock(storage).set_task_issue(id, None)?);
    };
    if number == 0 {
        return Err(CommandError::invalid_input(
            "an issue number must be positive",
        ));
    }
    let (task, repository) = issue_target(storage, git, id)?;
    let issue = github.issue(&repository, i64::from(number))?;
    link_and_reference(storage, github, &task, &issue)
}

fn create(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
    id: model::TaskId,
) -> CommandResult<model::Task> {
    let (task, repository) = issue_target(storage, git, id)?;
    if let Some(issue) = &task.issue {
        return Err(CommandError::rejected(format!(
            "task {id} is already linked to issue #{}",
            issue.number
        )));
    }
    let issue = github.create_issue(&repository, &task.title, &task.description)?;
    link_and_reference(storage, github, &task, &issue)
}

/// Stores the link first, so a failed pull request update does not lose an issue that
/// was just created; the background check adds the missing reference later.
fn link_and_reference(
    storage: &StorageState,
    github: &GitHub,
    task: &model::Task,
    issue: &LinkedIssue,
) -> CommandResult<model::Task> {
    let linked = lock(storage).set_task_issue(task.id, Some(issue))?;
    if let Some(url) = &linked.pull_request_url
        && github.pull_request(url)?.pull_request.state == PullRequestState::Open
    {
        ensure_closing_reference(github, url, issue)?;
    }
    Ok(linked)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::adapters::git::fake::{FakeRunner, failed};
    use crate::adapters::git::{GitError, Invocation};
    use crate::commands::CommandErrorKind;
    use crate::domain::model::{HostPath, TaskType};
    use crate::domain::naming::TaskCheckout;
    use crate::domain::path::WindowsPath;
    use crate::storage::{NewTask, NewWorkspace, Storage};

    const ISSUE: &str = "https://github.com/acme/toodo/issues/12";
    const PR: &str = "https://github.com/acme/toodo/pull/3";

    fn storage_with_task() -> (StorageState, model::Task) {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
            })
            .unwrap();
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Fix,
                title: "Fix login".to_owned(),
                description: "Login fails".to_owned(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap();
        (Mutex::new(storage), task)
    }

    fn adapters(
        git: Vec<Result<String, GitError>>,
        gh: Vec<Result<String, GitError>>,
    ) -> (Git, GitHub, Arc<FakeRunner>, Arc<FakeRunner>) {
        let git_runner = Arc::new(FakeRunner::new(git));
        let gh_runner = Arc::new(FakeRunner::new(gh));
        (
            Git::new(Box::new(git_runner.clone())),
            GitHub::new(Box::new(gh_runner.clone())),
            git_runner,
            gh_runner,
        )
    }

    fn origin() -> Result<String, GitError> {
        Ok("git@github.com:acme/toodo.git\n".to_owned())
    }

    fn viewed_issue() -> Result<String, GitError> {
        Ok(format!(r#"{{"number":12,"url":"{ISSUE}"}}"#))
    }

    fn calls(runner: &FakeRunner) -> Vec<Invocation> {
        runner.invocations.lock().unwrap().clone()
    }

    fn stored(storage: &StorageState, task: &model::Task) -> model::Task {
        lock(storage).get_task(task.id).unwrap().unwrap()
    }

    fn issue_12() -> LinkedIssue {
        LinkedIssue {
            number: 12,
            url: ISSUE.to_owned(),
        }
    }

    #[test]
    fn linking_checks_the_issue_in_the_origin_repository_and_stores_it() {
        let (storage, task) = storage_with_task();
        let (git, github, git_runner, gh_runner) = adapters(vec![origin()], vec![viewed_issue()]);

        let linked = link(&storage, &git, &github, task.id, Some(12)).unwrap();

        assert_eq!(linked.issue, Some(issue_12()));
        assert_eq!(stored(&storage, &task), linked);
        assert_eq!(
            calls(&git_runner)[0].args,
            ["-C", r"C:\dev\toodo", "remote", "get-url", "origin"].map(str::to_owned)
        );
        assert_eq!(
            calls(&gh_runner)[0].args[..4],
            ["issue", "view", "12", "--repo"].map(str::to_owned)
        );
    }

    #[test]
    fn an_unknown_issue_or_number_zero_links_nothing() {
        let (storage, task) = storage_with_task();
        let (git, github, _, _) = adapters(vec![origin()], vec![Err(failed())]);

        let error = link(&storage, &git, &github, task.id, Some(99)).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::External);
        let error = link(&storage, &git, &github, task.id, Some(0)).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert_eq!(stored(&storage, &task).issue, None);
    }

    #[test]
    fn unlinking_needs_no_github() {
        let (storage, task) = storage_with_task();
        lock(&storage)
            .set_task_issue(task.id, Some(&issue_12()))
            .unwrap();
        let (git, github, git_runner, gh_runner) = adapters(Vec::new(), Vec::new());

        let unlinked = link(&storage, &git, &github, task.id, None).unwrap();

        assert_eq!(unlinked.issue, None);
        assert!(calls(&git_runner).is_empty() && calls(&gh_runner).is_empty());
    }

    #[test]
    fn creating_opens_an_issue_from_the_task_and_links_it_once() {
        let (storage, task) = storage_with_task();
        let (git, github, _, gh_runner) =
            adapters(vec![origin(), origin()], vec![Ok(format!("{ISSUE}\n"))]);

        let linked = create(&storage, &git, &github, task.id).unwrap();

        assert_eq!(linked.issue, Some(issue_12()));
        assert_eq!(
            calls(&gh_runner)[0].args,
            [
                "issue",
                "create",
                "--repo",
                "github.com/acme/toodo",
                "--title",
                "Fix login",
                "--body",
                "Login fails"
            ]
            .map(str::to_owned)
        );
        let error = create(&storage, &git, &github, task.id).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert_eq!(calls(&gh_runner).len(), 1);
    }

    #[test]
    fn the_issue_of_a_done_task_cannot_change() {
        let (storage, task) = storage_with_task();
        for status in [
            TaskStatus::InProgress,
            TaskStatus::InReview,
            TaskStatus::Done,
        ] {
            lock(&storage).set_task_status(task.id, status).unwrap();
        }
        let (git, github, git_runner, gh_runner) = adapters(Vec::new(), Vec::new());

        for error in [
            link(&storage, &git, &github, task.id, Some(12)).unwrap_err(),
            link(&storage, &git, &github, task.id, None).unwrap_err(),
            create(&storage, &git, &github, task.id).unwrap_err(),
        ] {
            assert_eq!(error.kind, CommandErrorKind::Rejected);
        }
        assert!(calls(&git_runner).is_empty() && calls(&gh_runner).is_empty());
    }

    #[test]
    fn linking_a_task_in_review_adds_the_reference_to_its_open_pull_request() {
        let (storage, task) = storage_with_task();
        {
            let mut storage = lock(&storage);
            let checkout = TaskCheckout {
                path: HostPath::Windows(WindowsPath::parse(r"D:\wt\fix-login-1").unwrap()),
                branch: "fix/fix-login-1".to_owned(),
            };
            storage.start_task(task.id, &checkout, "w1").unwrap();
            storage.open_pull_request(task.id, &[], PR, None).unwrap();
        }
        let (git, github, _, gh_runner) = adapters(
            vec![origin()],
            vec![
                viewed_issue(),
                Ok(format!(
                    r#"{{"baseRefName":"main","latestReviews":[],"mergedAt":null,"reviewDecision":"","state":"OPEN","statusCheckRollup":[],"url":"{PR}"}}"#
                )),
                Ok(r#"{"body":""}"#.to_owned()),
                Ok(String::new()),
            ],
        );

        let linked = link(&storage, &git, &github, task.id, Some(12)).unwrap();

        assert_eq!(linked.issue, Some(issue_12()));
        assert_eq!(
            calls(&gh_runner)[3].args,
            ["pr", "edit", PR, "--body", "Closes #12"].map(str::to_owned)
        );
    }
}
