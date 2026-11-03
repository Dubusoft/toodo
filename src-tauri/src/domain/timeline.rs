//! Status history of a task and the milestones derived from it (see
//! `docs/architecture.md`, Task Timeline).

use super::status::TaskStatus;

/// One status change of a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskEvent {
    pub status: TaskStatus,
    /// Time of the change in seconds since the Unix epoch (UTC).
    pub at: i64,
}

/// Milestones of a task, in seconds since the Unix epoch. `None` when the task has not
/// reached the milestone or its history does not record it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Milestones {
    /// Task creation: the first event.
    pub planned_at: Option<i64>,
    /// The first move to `in_progress`; restarting a paused task keeps it.
    pub started_at: Option<i64>,
    /// The first move to `in_review`, when the pull request was opened.
    pub review_at: Option<i64>,
    /// The latest move to `done`, unless the task was reopened after it.
    pub completed_at: Option<i64>,
    /// The latest reopening: a move out of `done`, which only reopening makes.
    pub reopened_at: Option<i64>,
    /// The latest pause, a move back to `planned` after work started, unless the task
    /// was started again after it.
    pub paused_at: Option<i64>,
    /// The latest move to `in_review`; later than `review_at` when the task went back to
    /// review, e.g. after a pause.
    pub last_review_at: Option<i64>,
    /// Seconds spent `in_progress` or `in_review` up to the latest status change; the
    /// current period of an active task is not counted yet.
    pub active_seconds: i64,
    /// How often the task was paused: moves back to `planned` after work started.
    pub pause_count: u32,
}

/// Derives the milestones of a task from its status history, oldest event first.
pub fn milestones(timeline: &[TaskEvent]) -> Milestones {
    let mut milestones = Milestones {
        planned_at: timeline.first().map(|event| event.at),
        ..Milestones::default()
    };
    // When the current period of work began, while the task is in progress or in review.
    let mut active_since: Option<i64> = None;
    for event in timeline {
        if event.status != TaskStatus::Done && milestones.completed_at.is_some() {
            milestones.completed_at = None;
            milestones.reopened_at = Some(event.at);
        }
        let active = matches!(event.status, TaskStatus::InProgress | TaskStatus::InReview);
        match (active_since, active) {
            (None, true) => active_since = Some(event.at),
            (Some(since), false) => {
                milestones.active_seconds += (event.at - since).max(0);
                active_since = None;
            }
            _ => {}
        }
        match event.status {
            TaskStatus::Planned => {
                if milestones.started_at.is_some() {
                    milestones.paused_at = Some(event.at);
                    milestones.pause_count += 1;
                }
            }
            TaskStatus::InProgress => {
                milestones.started_at.get_or_insert(event.at);
                milestones.paused_at = None;
            }
            TaskStatus::InReview => {
                milestones.review_at.get_or_insert(event.at);
                milestones.last_review_at = Some(event.at);
            }
            TaskStatus::Done => milestones.completed_at = Some(event.at),
        }
    }
    // The open period counts up to the latest change, e.g. in_progress to in_review.
    if let (Some(since), Some(last)) = (active_since, timeline.last()) {
        milestones.active_seconds += (last.at - since).max(0);
    }
    milestones
}

#[cfg(test)]
mod tests {
    use super::TaskStatus::*;
    use super::*;

    fn events(raw: &[(TaskStatus, i64)]) -> Vec<TaskEvent> {
        raw.iter()
            .map(|&(status, at)| TaskEvent { status, at })
            .collect()
    }

    #[test]
    fn a_task_without_history_has_no_milestones() {
        assert_eq!(milestones(&[]), Milestones::default());
    }

    #[test]
    fn a_completed_task_has_every_milestone_but_a_pause() {
        let timeline = events(&[(Planned, 10), (InProgress, 30), (InReview, 40), (Done, 50)]);
        assert_eq!(
            milestones(&timeline),
            Milestones {
                planned_at: Some(10),
                started_at: Some(30),
                review_at: Some(40),
                completed_at: Some(50),
                reopened_at: None,
                paused_at: None,
                last_review_at: Some(40),
                active_seconds: 20,
                pause_count: 0,
            }
        );
    }

    #[test]
    fn a_reopened_task_is_no_longer_completed_until_it_is_done_again() {
        let mut timeline = events(&[(Planned, 10), (InProgress, 20), (Done, 30), (Planned, 40)]);
        let reopened = milestones(&timeline);
        assert_eq!(reopened.completed_at, None);
        assert_eq!(reopened.reopened_at, Some(40));
        assert_eq!(reopened.paused_at, Some(40));
        assert_eq!(reopened.started_at, Some(20));

        timeline.extend(events(&[(InProgress, 50), (Done, 60)]));
        let done = milestones(&timeline);
        assert_eq!(done.completed_at, Some(60));
        assert_eq!(done.reopened_at, Some(40));
        assert_eq!(done.paused_at, None);
    }

    #[test]
    fn a_paused_task_keeps_the_milestones_it_reached() {
        let timeline = events(&[(Planned, 10), (InProgress, 20), (Planned, 30)]);
        assert_eq!(
            milestones(&timeline),
            Milestones {
                planned_at: Some(10),
                started_at: Some(20),
                review_at: None,
                completed_at: None,
                reopened_at: None,
                paused_at: Some(30),
                last_review_at: None,
                active_seconds: 10,
                pause_count: 1,
            }
        );
    }

    #[test]
    fn a_restarted_task_is_no_longer_paused_and_keeps_its_first_start() {
        let mut timeline = events(&[
            (Planned, 10),
            (InProgress, 20),
            (Planned, 30),
            (InProgress, 40),
        ]);
        assert_eq!(milestones(&timeline).started_at, Some(20));
        assert_eq!(milestones(&timeline).paused_at, None);

        timeline.extend(events(&[(InReview, 50), (Planned, 60)]));
        assert_eq!(milestones(&timeline).review_at, Some(50));
        assert_eq!(milestones(&timeline).paused_at, Some(60));
    }

    #[test]
    fn pauses_are_counted_and_left_out_of_the_active_time() {
        let timeline = events(&[
            (Planned, 0),
            (InProgress, 100),
            (InReview, 150),
            (Planned, 200),
            (InProgress, 1_000),
            (InReview, 1_300),
            (Done, 1_400),
        ]);
        let milestones = milestones(&timeline);
        assert_eq!(milestones.active_seconds, 100 + 400);
        assert_eq!(milestones.pause_count, 1);
        assert_eq!(milestones.review_at, Some(150));
        assert_eq!(milestones.last_review_at, Some(1_300));
    }
}
