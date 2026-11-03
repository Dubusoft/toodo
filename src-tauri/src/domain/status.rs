//! Task states and the transitions allowed between them (see `docs/workflow.md`).
//!
//! Whether a `planned` task can start is not a state of its own: it follows from its
//! dependencies (see [`super::dag::is_ready`]).

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskStatus {
    /// Not being worked on: not started yet, or paused. A paused task keeps its branch,
    /// worktree, commit records, and pull request.
    Planned,
    InProgress,
    /// Awaiting completion: the task's pull request is open, waiting for its merge, or
    /// every completion criterion is met and one of them is manual, waiting for someone to
    /// confirm it (see [`super::criteria`]).
    InReview,
    /// Finished: its criteria were met, or the work was concluded without adoption
    /// (see [`super::model::TaskResolution`]).
    Done,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::InProgress => "in_progress",
            Self::InReview => "in_review",
            Self::Done => "done",
        }
    }

    pub fn can_transition_to(self, next: Self) -> bool {
        use TaskStatus::*;
        matches!(
            (self, next),
            (Planned, InProgress)
                | (InProgress, InReview)
                | (InReview, Done)
                // Pausing: work stops until the task is started again.
                | (InProgress | InReview, Planned)
        )
    }

    /// Concludes a task that is being worked on without merging it, e.g. research that
    /// is not adopted. Both concluding and completing allow `in_progress` and
    /// `in_review` tasks; completing requires their completion criteria to be met.
    pub fn conclude(self) -> Result<Self, TransitionError> {
        match self {
            Self::InProgress | Self::InReview => Ok(Self::Done),
            from => Err(TransitionError {
                from,
                to: Self::Done,
            }),
        }
    }

    /// Completes a task that is being worked on once its completion criteria are met: a
    /// task whose criteria Toodo checks on its own can be done straight from
    /// `in_progress`, e.g. a branch merged locally.
    pub fn complete(self) -> Result<Self, TransitionError> {
        self.conclude()
    }

    /// Reopens a `done` task, e.g. one completed or concluded by mistake: it becomes
    /// `planned` again, paused if it was started, so starting it resumes the work. This is
    /// not one of the transitions of [`Self::can_transition_to`], so pausing never reopens
    /// a task.
    pub fn reopen(self) -> Result<Self, TransitionError> {
        match self {
            Self::Done => Ok(Self::Planned),
            from => Err(TransitionError {
                from,
                to: Self::Planned,
            }),
        }
    }

    pub fn transition_to(self, next: Self) -> Result<Self, TransitionError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(TransitionError {
                from: self,
                to: next,
            })
        }
    }
}

impl fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransitionError {
    pub from: TaskStatus,
    pub to: TaskStatus,
}

impl fmt::Display for TransitionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "a {} task cannot become {}", self.from, self.to)
    }
}

impl std::error::Error for TransitionError {}

#[cfg(test)]
mod tests {
    use super::TaskStatus::*;
    use super::*;

    const ALL: [TaskStatus; 4] = [Planned, InProgress, InReview, Done];

    #[test]
    fn only_documented_transitions_are_allowed() {
        let allowed = [
            (Planned, InProgress),
            (InProgress, InReview),
            (InProgress, Planned),
            (InReview, Done),
            (InReview, Planned),
        ];
        for from in ALL {
            for to in ALL {
                let expected = allowed.contains(&(from, to));
                assert_eq!(from.can_transition_to(to), expected, "{from} -> {to}");
            }
        }
    }

    #[test]
    fn only_a_task_being_worked_on_can_be_concluded() {
        for from in ALL {
            let expected = matches!(from, InProgress | InReview);
            assert_eq!(from.conclude().is_ok(), expected, "{from}");
        }
        assert_eq!(
            Planned.conclude().unwrap_err().to_string(),
            "a planned task cannot become done"
        );
    }

    #[test]
    fn only_a_done_task_can_be_reopened() {
        for from in ALL {
            let expected = (from == Done).then_some(Planned);
            assert_eq!(from.reopen().ok(), expected, "{from}");
        }
    }

    #[test]
    fn illegal_transition_reports_both_states() {
        assert_eq!(
            Planned.transition_to(InReview),
            Err(TransitionError {
                from: Planned,
                to: InReview
            })
        );
        assert_eq!(
            Done.transition_to(Planned).unwrap_err().to_string(),
            "a done task cannot become planned"
        );
        assert_eq!(Planned.transition_to(InProgress), Ok(InProgress));
    }
}
