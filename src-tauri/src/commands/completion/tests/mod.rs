use std::sync::{Arc, Mutex};

use super::background::check_pull_requests;
use super::pull_request::adopt_pull_request;
use super::*;
use crate::adapters::git::Git;
use crate::adapters::git::fake::{FakeRunner, failed};
use crate::adapters::git::{GitError, Invocation};
use crate::adapters::github::GhCli;
use crate::adapters::herdr::Herdr;
use crate::commands::CommandErrorKind;
use crate::commands::events::Notifier;
use crate::commands::types;
use crate::commands::{StorageState, lock};
use crate::domain::activity::ActivityKind;
use crate::domain::criteria::NewCriterion;
use crate::domain::criteria::{self, CheckKind, CriterionState};
use crate::domain::model::{self, WorkspaceLocation};
use crate::domain::model::{HostPath, MachineLabel, TaskType};
use crate::domain::naming::TaskCheckout;
use crate::domain::path::{PosixPath, WindowsPath};
use crate::domain::status::TaskStatus;
use crate::storage::CriterionCheck;
use crate::storage::{NewTask, NewWorkspace, Storage};
use std::collections::HashMap;

mod adoption;
mod background;
mod complete;
mod conclude;
mod criteria_checks;
mod issues;
mod open;
mod without_pull_request;
mod worktree;

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
    fixture_completed_by(
        location,
        worktree,
        criteria,
        crate::domain::model::CompletionMode::PullRequestMerge,
    )
}

fn fixture_completed_by(
    location: WorkspaceLocation,
    worktree: HostPath,
    criteria: Vec<NewCriterion>,
    completion: crate::domain::model::CompletionMode,
) -> Fixture {
    let mut storage = Storage::open_in_memory().unwrap();
    let workspace = storage
        .create_workspace(&NewWorkspace {
            name: "toodo".to_owned(),
            location,
            default_base_branch: "main".to_owned(),
            source: crate::domain::model::Source::GitHub,
            completion,
            runner: crate::domain::model::Runner::Herdr,
            axes_detected: true,
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

fn adapters(git: &Arc<FakeRunner>, gh: &Arc<FakeRunner>) -> (Git, GhCli) {
    (
        Git::new(Box::new(git.clone())),
        GhCli::new(Box::new(gh.clone())),
    )
}

fn log(shas: &[&str]) -> Result<String, GitError> {
    Ok(shas
        .iter()
        .enumerate()
        .map(|(index, sha)| {
            format!("{sha}\u{1f}Ada <ada@example.com>\u{1f}{index}\u{1f}Commit {index}\n\u{1e}\n")
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
    format!(r#"{{"baseRefName":"{base}","mergedAt":{merged_at},"state":"{state}","url":"{PR}"}}"#)
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
fn viewed_with(state: &str, base: &str, checks: &str, decision: &str) -> Result<String, GitError> {
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

/// A git whose branch log has `shas` and whose `origin` is on GitHub.
fn github_checkout(shas: &[&str]) -> Arc<FakeRunner> {
    runner(vec![
        log(shas),
        Ok("origin\n".to_owned()),
        origin("git@github.com:acme/toodo.git"),
    ])
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

fn list(statuses: &PullRequestStatusState) -> Vec<types::TaskPullRequestStatus> {
    all_statuses(&lock_statuses(statuses))
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
