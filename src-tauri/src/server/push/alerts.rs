//! What deserves a push notification: the changes between two snapshots of task statuses,
//! agent statuses, and pull request statuses. Something seen for the first time raises
//! nothing, so starting the server or opening a task is silent.

use std::collections::HashMap;

use serde::Serialize;

use crate::commands::types::{
    AgentStatus, ChecksStatus, ReviewStatus, TaskAgentStatus, TaskPullRequestStatus,
};
use crate::domain::model::TaskId;
use crate::domain::push::PushKind;
use crate::domain::status::TaskStatus;

/// The longest notification body, in characters; a message must fit one 4 KB record.
const MAX_BODY_CHARS: usize = 300;

/// One notification, as the service worker receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// The setting that turns it off; `None` for the test notification, which every
    /// subscription gets.
    #[serde(skip)]
    pub kind: Option<PushKind>,
    /// Whether the user should see it now rather than when the device wakes up.
    #[serde(skip)]
    pub urgent: bool,
    pub title: String,
    pub body: String,
    /// A later notification with the same tag replaces the earlier one.
    pub tag: String,
    pub task_id: Option<i64>,
}

impl Alert {
    pub fn test() -> Self {
        Self {
            kind: None,
            urgent: true,
            title: "Toodo notifications are on".to_owned(),
            body: "This device will get notifications even while Toodo is closed.".to_owned(),
            tag: "test".to_owned(),
            task_id: None,
        }
    }

    fn task(kind: PushKind, urgent: bool, title: &str, task: TaskId, name: Option<&str>) -> Self {
        let tag = match kind {
            PushKind::Agent => "agent",
            PushKind::PullRequests => "pull-request",
            PushKind::Completion => "completion",
        };
        let body = match name {
            Some(name) => format!("#{task} {name}"),
            None => format!("#{task}"),
        };
        Self {
            kind: Some(kind),
            urgent,
            title: title.to_owned(),
            body: shorten(&body),
            tag: format!("task-{task}-{tag}"),
            task_id: Some(task.0),
        }
    }
}

fn shorten(text: &str) -> String {
    match text.char_indices().nth(MAX_BODY_CHARS) {
        Some((end, _)) => format!("{}...", &text[..end]),
        None => text.to_owned(),
    }
}

/// The last statuses seen.
#[derive(Debug, Default)]
pub struct Watch {
    tasks: Option<HashMap<TaskId, (TaskStatus, String)>>,
    agents: HashMap<TaskId, AgentStatus>,
    pull_requests: HashMap<TaskId, TaskPullRequestStatus>,
}

impl Watch {
    /// A task that moved to `in_review` is awaiting completion. The first list of tasks
    /// only sets the baseline.
    pub fn tasks<'a>(
        &mut self,
        tasks: impl IntoIterator<Item = (TaskId, TaskStatus, &'a str)>,
    ) -> Vec<Alert> {
        let next: HashMap<TaskId, (TaskStatus, String)> = tasks
            .into_iter()
            .map(|(id, status, title)| (id, (status, title.to_owned())))
            .collect();
        let mut alerts: Vec<Alert> = match &self.tasks {
            None => Vec::new(),
            Some(before) => next
                .iter()
                .filter(|(id, (status, _))| {
                    *status == TaskStatus::InReview
                        && before
                            .get(id)
                            .is_some_and(|(was, _)| *was != TaskStatus::InReview)
                })
                .map(|(id, (_, title))| {
                    Alert::task(
                        PushKind::Completion,
                        false,
                        "Task awaiting completion",
                        *id,
                        Some(title),
                    )
                })
                .collect(),
        };
        alerts.sort_by_key(|alert| alert.task_id);
        self.tasks = Some(next);
        alerts
    }

    fn title(&self, task: TaskId) -> Option<&str> {
        self.tasks
            .as_ref()?
            .get(&task)
            .map(|(_, title)| title.as_str())
    }

    /// An agent that started waiting for input, or that stopped working.
    pub fn agents(&mut self, statuses: &[TaskAgentStatus]) -> Vec<Alert> {
        let alerts = statuses
            .iter()
            .filter_map(|entry| {
                let task = TaskId(entry.task_id.0);
                let was = *self.agents.get(&task)?;
                let (title, urgent) = match (was, entry.status) {
                    (was, AgentStatus::Blocked) if was != AgentStatus::Blocked => {
                        ("Agent needs input", true)
                    }
                    (AgentStatus::Working, AgentStatus::Done | AgentStatus::Idle) => {
                        ("Agent finished", false)
                    }
                    _ => return None,
                };
                Some(Alert::task(
                    PushKind::Agent,
                    urgent,
                    title,
                    task,
                    self.title(task),
                ))
            })
            .collect();
        self.agents = statuses
            .iter()
            .map(|entry| (TaskId(entry.task_id.0), entry.status))
            .collect();
        alerts
    }

    /// CI checks that finished (passed or failed) and reviews that approved or requested
    /// changes.
    pub fn pull_requests(&mut self, statuses: &[TaskPullRequestStatus]) -> Vec<Alert> {
        let mut alerts = Vec::new();
        for entry in statuses {
            let task = TaskId(entry.task_id.0);
            let Some(was) = self.pull_requests.get(&task) else {
                continue;
            };
            let name = self.title(task);
            if entry.checks != was.checks {
                match entry.checks {
                    Some(ChecksStatus::Failing) => alerts.push(Alert::task(
                        PushKind::PullRequests,
                        true,
                        "CI failed",
                        task,
                        name,
                    )),
                    Some(ChecksStatus::Passing) => alerts.push(Alert::task(
                        PushKind::PullRequests,
                        false,
                        "CI passed",
                        task,
                        name,
                    )),
                    Some(ChecksStatus::Pending) | None => {}
                }
            }
            if entry.review != was.review {
                match entry.review {
                    ReviewStatus::ChangesRequested => alerts.push(Alert::task(
                        PushKind::PullRequests,
                        true,
                        "Changes requested",
                        task,
                        name,
                    )),
                    ReviewStatus::Approved => alerts.push(Alert::task(
                        PushKind::PullRequests,
                        false,
                        "Pull request approved",
                        task,
                        name,
                    )),
                    ReviewStatus::Pending => {}
                }
            }
        }
        self.pull_requests = statuses
            .iter()
            .map(|entry| (TaskId(entry.task_id.0), entry.clone()))
            .collect();
        alerts
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::types;

    fn tasks(list: &[(i64, TaskStatus)]) -> Vec<(TaskId, TaskStatus, String)> {
        list.iter()
            .map(|&(id, status)| (TaskId(id), status, format!("Task {id}")))
            .collect()
    }

    fn seen(watch: &mut Watch, list: &[(i64, TaskStatus)]) -> Vec<Alert> {
        let list = tasks(list);
        watch.tasks(
            list.iter()
                .map(|(id, status, title)| (*id, *status, title.as_str())),
        )
    }

    fn agent(id: i64, status: AgentStatus) -> TaskAgentStatus {
        TaskAgentStatus {
            task_id: types::TaskId(id),
            status,
        }
    }

    fn pr(id: i64, checks: Option<ChecksStatus>, review: ReviewStatus) -> TaskPullRequestStatus {
        TaskPullRequestStatus {
            task_id: types::TaskId(id),
            checks,
            review,
        }
    }

    fn titles(alerts: &[Alert]) -> Vec<(&str, &str)> {
        alerts
            .iter()
            .map(|alert| (alert.title.as_str(), alert.body.as_str()))
            .collect()
    }

    #[test]
    fn tasks_awaiting_completion_after_the_baseline_raise_one_alert() {
        let mut watch = Watch::default();
        assert!(
            seen(
                &mut watch,
                &[(1, TaskStatus::InReview), (2, TaskStatus::InProgress)]
            )
            .is_empty()
        );
        let alerts = seen(
            &mut watch,
            &[
                (1, TaskStatus::InReview),
                (2, TaskStatus::InReview),
                (3, TaskStatus::InReview),
            ],
        );
        assert_eq!(titles(&alerts), [("Task awaiting completion", "#2 Task 2")]);
        assert_eq!(alerts[0].kind, Some(PushKind::Completion));
        assert_eq!(alerts[0].task_id, Some(2));
        assert_eq!(alerts[0].tag, "task-2-completion");
        assert!(seen(&mut watch, &[(2, TaskStatus::Done)]).is_empty());
    }

    #[test]
    fn agents_that_need_input_or_finish_raise_alerts() {
        let mut watch = Watch::default();
        seen(
            &mut watch,
            &[(1, TaskStatus::InProgress), (2, TaskStatus::InProgress)],
        );
        assert!(
            watch
                .agents(&[
                    agent(1, AgentStatus::Working),
                    agent(2, AgentStatus::Working)
                ])
                .is_empty()
        );
        let alerts = watch.agents(&[
            agent(1, AgentStatus::Blocked),
            agent(2, AgentStatus::Idle),
            agent(3, AgentStatus::Blocked),
        ]);
        assert_eq!(
            titles(&alerts),
            [
                ("Agent needs input", "#1 Task 1"),
                ("Agent finished", "#2 Task 2")
            ]
        );
        assert!(alerts[0].urgent);
        assert!(!alerts[1].urgent);
        assert!(watch.agents(&[agent(1, AgentStatus::Blocked)]).is_empty());
        assert!(watch.agents(&[agent(1, AgentStatus::Done)]).is_empty());
        assert!(watch.agents(&[agent(1, AgentStatus::Working)]).is_empty());
        assert_eq!(
            titles(&watch.agents(&[agent(1, AgentStatus::Blocked)])),
            [("Agent needs input", "#1 Task 1")]
        );
    }

    #[test]
    fn a_vanished_agent_starts_over_as_first_seen() {
        let mut watch = Watch::default();
        watch.agents(&[agent(1, AgentStatus::Working)]);
        watch.agents(&[]);
        assert!(watch.agents(&[agent(1, AgentStatus::Blocked)]).is_empty());
    }

    #[test]
    fn finished_checks_and_reviews_raise_alerts() {
        let mut watch = Watch::default();
        assert!(
            watch
                .pull_requests(&[pr(1, Some(ChecksStatus::Failing), ReviewStatus::Pending)])
                .is_empty()
        );
        assert!(
            watch
                .pull_requests(&[pr(1, Some(ChecksStatus::Pending), ReviewStatus::Pending)])
                .is_empty()
        );
        let alerts = watch.pull_requests(&[pr(
            1,
            Some(ChecksStatus::Passing),
            ReviewStatus::ChangesRequested,
        )]);
        assert_eq!(
            titles(&alerts),
            [("CI passed", "#1"), ("Changes requested", "#1")]
        );
        let alerts =
            watch.pull_requests(&[pr(1, Some(ChecksStatus::Failing), ReviewStatus::Approved)]);
        assert_eq!(
            titles(&alerts),
            [("CI failed", "#1"), ("Pull request approved", "#1")]
        );
        assert!(
            alerts
                .iter()
                .all(|alert| alert.kind == Some(PushKind::PullRequests))
        );
        assert!(
            watch
                .pull_requests(&[pr(1, Some(ChecksStatus::Failing), ReviewStatus::Approved)])
                .is_empty()
        );
    }

    #[test]
    fn long_titles_are_shortened_and_payloads_have_the_service_worker_shape() {
        let mut watch = Watch::default();
        let long = "x".repeat(1000);
        watch.tasks([(TaskId(1), TaskStatus::InProgress, long.as_str())]);
        let alert = watch
            .tasks([(TaskId(1), TaskStatus::InReview, long.as_str())])
            .remove(0);
        assert_eq!(alert.body.chars().count(), MAX_BODY_CHARS + 3);
        let json = serde_json::to_value(&alert).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["body", "tag", "taskId", "title"]
        );
    }
}
