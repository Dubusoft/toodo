//! Review of the work done in a period such as a week, derived from the recorded task
//! milestones and commit records (see `docs/architecture.md`, Week Review).

use std::fmt;

use super::model::{CommitRecord, Task, TaskId};
use super::timeline::milestones;

/// A half-open time range `[start, end)` in seconds since the Unix epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Period {
    start: i64,
    end: i64,
}

impl Period {
    pub fn new(start: i64, end: i64) -> Result<Self, EmptyPeriod> {
        if start >= end {
            return Err(EmptyPeriod);
        }
        Ok(Self { start, end })
    }

    pub fn start(self) -> i64 {
        self.start
    }

    pub fn end(self) -> i64 {
        self.end
    }

    pub fn contains(self, at: i64) -> bool {
        self.start <= at && at < self.end
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyPeriod;

impl fmt::Display for EmptyPeriod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a review period must end after it starts")
    }
}

impl std::error::Error for EmptyPeriod {}

/// What happened to a task during a period: the most advanced milestone it reached in
/// the period. Variants are ordered from most to least advanced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Outcome {
    Completed,
    OpenedForReview,
    Started,
    /// No milestone in the period, but commits were made.
    WorkedOn,
    Planned,
}

/// A task that had activity in a period.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskReview {
    pub task_id: TaskId,
    pub outcome: Outcome,
    /// Time of the outcome: the milestone, or the latest commit for `WorkedOn`.
    pub at: i64,
    /// Commits of the task made in the period, oldest first.
    pub commits: Vec<CommitRecord>,
}

/// Reviews `tasks` over `period`: every task that reached a milestone or got a commit in
/// the period, ordered by outcome, then by time, then by task ID. Commits of tasks not
/// in `tasks` are ignored. Tasks without status history are reviewed by their commits
/// alone; their milestones are not guessed.
pub fn review(period: Period, tasks: &[Task], commits: &[CommitRecord]) -> Vec<TaskReview> {
    let mut reviews: Vec<TaskReview> = tasks
        .iter()
        .filter_map(|task| {
            let mut task_commits: Vec<CommitRecord> = commits
                .iter()
                .filter(|commit| commit.task_id == task.id && period.contains(commit.committed_at))
                .cloned()
                .collect();
            task_commits.sort_by_key(|commit| commit.committed_at);
            let reached = milestones(&task.timeline);
            let in_period = |at: Option<i64>| at.filter(|&at| period.contains(at));
            let (outcome, at) = [
                (Outcome::Completed, in_period(reached.completed_at)),
                (Outcome::OpenedForReview, in_period(reached.review_at)),
                (Outcome::Started, in_period(reached.started_at)),
                (
                    Outcome::WorkedOn,
                    task_commits.last().map(|commit| commit.committed_at),
                ),
                (Outcome::Planned, in_period(reached.planned_at)),
            ]
            .into_iter()
            .find_map(|(outcome, at)| at.map(|at| (outcome, at)))?;
            Some(TaskReview {
                task_id: task.id,
                outcome,
                at,
                commits: task_commits,
            })
        })
        .collect();
    reviews.sort_by_key(|review| (review.outcome, review.at, review.task_id));
    reviews
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::domain::model::{TaskType, WorkspaceId};
    use crate::domain::status::TaskStatus::{self, *};
    use crate::domain::timeline::TaskEvent;

    const WEEK: Period = Period {
        start: 1000,
        end: 2000,
    };

    fn task(id: i64, history: &[(TaskStatus, i64)]) -> Task {
        Task {
            id: TaskId(id),
            workspace_id: WorkspaceId(1),
            task_type: TaskType::Feat,
            title: format!("Task {id}"),
            description: String::new(),
            status: history.last().map_or(Planned, |&(status, _)| status),
            depends_on: BTreeSet::new(),
            branch: None,
            worktree_path: None,
            herdr_workspace_id: None,
            pull_request_url: None,
            pull_request_merged_at: None,
            pull_request: None,
            resolution: None,
            merged_with: None,
            completion_note: None,
            estimate: None,
            due_date: None,
            issue: None,
            timeline: history
                .iter()
                .map(|&(status, at)| TaskEvent { status, at })
                .collect(),
            notes: Vec::new(),
            criteria: Vec::new(),
        }
    }

    fn commit(task: i64, sha: &str, committed_at: i64) -> CommitRecord {
        CommitRecord {
            task_id: TaskId(task),
            sha: sha.to_owned(),
            message: format!("Commit {sha}"),
            author: "Dev <dev@example.com>".to_owned(),
            committed_at,
        }
    }

    fn outcomes(reviews: &[TaskReview]) -> Vec<(i64, Outcome, i64)> {
        reviews
            .iter()
            .map(|review| (review.task_id.0, review.outcome, review.at))
            .collect()
    }

    #[test]
    fn a_period_must_end_after_it_starts() {
        assert_eq!(Period::new(10, 10), Err(EmptyPeriod));
        assert_eq!(Period::new(20, 10), Err(EmptyPeriod));
        let period = Period::new(10, 20).unwrap();
        assert!(period.contains(10));
        assert!(!period.contains(20));
    }

    #[test]
    fn each_task_gets_its_most_advanced_milestone_in_the_period() {
        let tasks = [
            task(
                1,
                &[
                    (Planned, 1100),
                    (InProgress, 1200),
                    (InReview, 1300),
                    (Done, 1400),
                ],
            ),
            task(2, &[(Planned, 100), (InProgress, 200), (InReview, 1500)]),
            task(3, &[(Planned, 100), (InProgress, 1100), (Planned, 1150)]),
            task(4, &[(Planned, 100), (InProgress, 1600)]),
            task(5, &[(Planned, 1700)]),
            task(
                6,
                &[
                    (Planned, 100),
                    (InProgress, 200),
                    (InReview, 300),
                    (Done, 1050),
                ],
            ),
        ];
        assert_eq!(
            outcomes(&review(WEEK, &tasks, &[])),
            [
                (6, Outcome::Completed, 1050),
                (1, Outcome::Completed, 1400),
                (2, Outcome::OpenedForReview, 1500),
                (3, Outcome::Started, 1100),
                (4, Outcome::Started, 1600),
                (5, Outcome::Planned, 1700),
            ]
        );
    }

    #[test]
    fn the_period_includes_its_start_and_excludes_its_end() {
        let tasks = [
            task(1, &[(Planned, 100), (InProgress, 1000)]),
            task(2, &[(Planned, 100), (InProgress, 2000)]),
            task(3, &[(Planned, 999), (InProgress, 1999)]),
        ];
        let commits = [commit(2, "end", 2000), commit(2, "before", 999)];
        assert_eq!(
            outcomes(&review(WEEK, &tasks, &commits)),
            [(1, Outcome::Started, 1000), (3, Outcome::Started, 1999)]
        );
    }

    #[test]
    fn commits_alone_make_a_task_worked_on_and_keep_only_the_period() {
        let tasks = [
            task(1, &[(Planned, 100), (InProgress, 200)]),
            task(2, &[(Planned, 100), (InProgress, 1100)]),
            task(3, &[]),
        ];
        let commits = [
            commit(1, "late", 1800),
            commit(1, "early", 1200),
            commit(1, "old", 500),
            commit(2, "start", 1150),
            commit(3, "legacy", 1300),
            commit(9, "unknown task", 1300),
        ];
        let reviews = review(WEEK, &tasks, &commits);
        assert_eq!(
            outcomes(&reviews),
            [
                (2, Outcome::Started, 1100),
                (3, Outcome::WorkedOn, 1300),
                (1, Outcome::WorkedOn, 1800),
            ]
        );
        let shas: Vec<&str> = reviews[2]
            .commits
            .iter()
            .map(|commit| commit.sha.as_str())
            .collect();
        assert_eq!(shas, ["early", "late"]);
        assert_eq!(reviews[0].commits.len(), 1);
    }

    #[test]
    fn tasks_without_activity_in_the_period_are_left_out() {
        let tasks = [
            task(
                1,
                &[
                    (Planned, 100),
                    (InProgress, 200),
                    (InReview, 300),
                    (Done, 400),
                ],
            ),
            task(2, &[(Planned, 2500)]),
            task(3, &[]),
        ];
        let commits = [commit(1, "old", 300), commit(3, "later", 2100)];
        assert_eq!(review(WEEK, &tasks, &commits), []);
    }
}
