//! What deserves a push notification: the changes between two snapshots of task statuses,
//! agent statuses, and pull request statuses. The first snapshot only sets the baseline,
//! so starting the server is silent, and a newly seen task or agent raises nothing; a pull
//! request first seen after the baseline counts as one whose checks and reviews had not
//! finished, so CI that already failed when Toodo first reads it still raises an alert.

use std::collections::HashMap;

use serde::Serialize;

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
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            alerts
                .iter()
                .map(|alert| (alert.title.as_str(), alert.body.as_str()))
                .collect::<Vec<_>>(),
            [("Task awaiting completion", "#2 Task 2")]
        );
        assert_eq!(alerts[0].kind, Some(PushKind::Completion));
        assert_eq!(alerts[0].task_id, Some(2));
        assert_eq!(alerts[0].tag, "task-2-completion");
        assert!(seen(&mut watch, &[(2, TaskStatus::Done)]).is_empty());
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
