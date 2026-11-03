//! Tells how far an `in_progress` or `in_review` task's branch has fallen behind its base
//! branch. In a task DAG this happens often: a prerequisite is merged into the base while
//! its dependent is still built on the older base.

use super::State;

use super::completion::checkout;
use super::types::{BranchFreshness, TaskId};
use super::{CommandResult, GitHubState, GitState, StorageState};
use crate::adapters::git::Git;
use crate::adapters::github::GitHub;
use crate::domain::model;

/// Counts the commits of the base branch (fetched from `origin` first) that the task's
/// branch lacks, and asks GitHub whether its pull request, if any, merges without
/// conflicts. A failing fetch or pull request lookup is reported in the result rather
/// than failing the whole check. `None` when the workspace repository has no `origin`,
/// since there is no shared base branch to fall behind.
#[specta::specta]
pub fn branch_freshness(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    github: State<'_, GitHubState>,
    id: TaskId,
) -> CommandResult<Option<BranchFreshness>> {
    freshness(&storage, &git, &github, id.into())
}

fn freshness(
    storage: &StorageState,
    git: &Git,
    github: &GitHub,
    id: model::TaskId,
) -> CommandResult<Option<BranchFreshness>> {
    let checkout = checkout(storage, git, id)?;
    let Some(behind) = git.commits_behind(
        &checkout.location,
        &checkout.repository,
        &checkout.base,
        &checkout.branch,
    )?
    else {
        return Ok(None);
    };
    let (mergeable, mergeable_error) = match checkout.task.pull_request_url.as_deref() {
        None => (None, None),
        Some(url) => match github.mergeable(url) {
            Ok(mergeable) => (Some(mergeable.into()), None),
            Err(error) => (None, Some(error.to_string())),
        },
    };
    Ok(Some(BranchFreshness {
        base: behind.base,
        behind: behind.behind,
        fetch_error: behind.fetch_error,
        mergeable,
        mergeable_error,
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::adapters::git::GitError;
    use crate::adapters::git::fake::{FakeRunner, failed};
    use crate::commands::lock;
    use crate::commands::types::MergeState;
    use crate::domain::model::{HostPath, TaskType, WorkspaceLocation};
    use crate::domain::naming::TaskCheckout;
    use crate::domain::path::WindowsPath;
    use crate::storage::{NewTask, NewWorkspace, Storage};

    const PR: &str = "https://github.com/acme/toodo/pull/12";

    fn started_task() -> (StorageState, model::TaskId) {
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
                task_type: TaskType::Feat,
                title: "Use login".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap();
        let checkout = TaskCheckout {
            path: HostPath::Windows(WindowsPath::parse(r"D:\wt\toodo\feat-use-login-1").unwrap()),
            branch: "feat/use-login-1".to_owned(),
        };
        storage.start_task(task.id, &checkout, "w1").unwrap();
        (Mutex::new(storage), task.id)
    }

    fn adapters(
        git: Vec<Result<String, GitError>>,
        gh: Vec<Result<String, GitError>>,
    ) -> (Git, GitHub, Arc<FakeRunner>) {
        let gh = Arc::new(FakeRunner::new(gh));
        (
            Git::new(Box::new(Arc::new(FakeRunner::new(
                std::iter::once(Ok(
                    "worktree D:/wt/toodo/feat-use-login-1\0HEAD abc\0\0".to_owned()
                ))
                .chain(git),
            )))),
            GitHub::new(Box::new(gh.clone())),
            gh,
        )
    }

    fn behind_by(count: u32) -> Vec<Result<String, GitError>> {
        vec![
            Ok("origin\n".to_owned()),
            Ok(String::new()),
            Ok("abc\n".to_owned()),
            Ok(format!("{count}\n")),
        ]
    }

    #[test]
    fn a_missing_worktree_still_fetches_and_counts_from_the_workspace_repository() {
        let (storage, id) = started_task();
        let runner = Arc::new(FakeRunner::new(
            std::iter::once(Ok(String::new())).chain(behind_by(3)),
        ));
        let git = Git::new(Box::new(runner.clone()));
        let github = GitHub::new(Box::new(Arc::new(FakeRunner::default())));

        let result = freshness(&storage, &git, &github, id).unwrap().unwrap();

        assert_eq!(result.behind, 3);
        assert!(
            lock(&storage)
                .get_task(id)
                .unwrap()
                .unwrap()
                .worktree_path
                .is_none()
        );
        for invocation in runner.invocations.lock().unwrap().iter() {
            assert_eq!(invocation.args[..2], ["-C", r"C:\dev\toodo"]);
        }
    }

    #[test]
    fn a_task_without_a_pull_request_reports_only_how_far_it_is_behind() {
        let (storage, id) = started_task();
        let (git, github, gh) = adapters(behind_by(4), Vec::new());

        let freshness = freshness(&storage, &git, &github, id).unwrap().unwrap();

        assert_eq!(
            freshness,
            BranchFreshness {
                base: "origin/main".to_owned(),
                behind: 4,
                fetch_error: None,
                mergeable: None,
                mergeable_error: None,
            }
        );
        assert!(gh.invocations.lock().unwrap().is_empty());
    }

    #[test]
    fn a_task_in_review_reports_whether_its_pull_request_conflicts() {
        let (storage, id) = started_task();
        lock(&storage).open_pull_request(id, &[], PR, None).unwrap();
        let (git, github, _) = adapters(
            behind_by(2),
            vec![Ok(r#"{"mergeable":"CONFLICTING"}"#.to_owned())],
        );

        let freshness = freshness(&storage, &git, &github, id).unwrap().unwrap();

        assert_eq!(freshness.behind, 2);
        assert_eq!(freshness.mergeable, Some(MergeState::Conflicting));
    }

    #[test]
    fn a_failed_pull_request_lookup_keeps_the_behind_count() {
        let (storage, id) = started_task();
        lock(&storage).open_pull_request(id, &[], PR, None).unwrap();
        let (git, github, _) = adapters(behind_by(1), vec![Err(failed())]);

        let freshness = freshness(&storage, &git, &github, id).unwrap().unwrap();

        assert_eq!(freshness.behind, 1);
        assert_eq!(freshness.mergeable, None);
        assert!(freshness.mergeable_error.is_some());
    }

    #[test]
    fn a_repository_without_origin_reports_no_freshness() {
        let (storage, id) = started_task();
        lock(&storage).open_pull_request(id, &[], PR, None).unwrap();
        let (git, github, gh) = adapters(vec![Ok(String::new())], Vec::new());

        assert_eq!(freshness(&storage, &git, &github, id).unwrap(), None);
        assert!(gh.invocations.lock().unwrap().is_empty());
    }
}
