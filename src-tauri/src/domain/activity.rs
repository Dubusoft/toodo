//! Git activity of a task: its commits, pull request, CI results, and merge as events on
//! a time axis, shown next to its status timeline (see [`super::timeline`], which is a
//! different thing: the status history).
//!
//! Events arrive from sources that may report the same thing more than once and in any
//! order (every background check polls again). Each event has a dedup key made of its
//! kind and external reference, so it is stored once per task however often and from
//! whichever source it is reported. Storage reconciles a repeated report as follows: the
//! first `received_at`, `source`, `title`, and `author` stay, `occurred_at` becomes the
//! earlier of both, and `confirmed_at` becomes the time of the new report. Events are
//! listed by `occurred_at`, then by the order they were first stored, so the order in
//! which reports arrive never changes the result.

use std::fmt;

use super::model::{CommitRecord, CompletionMode, Source, TaskId};

/// Where an activity event was learned from. A GitHub webhook source can be added later
/// as another variant without model changes: the dedup key ignores the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActivitySource {
    /// The git repository of the workspace, read by the background check.
    GitPoll,
    /// GitHub, read with `gh` by the background check.
    GitHubPoll,
}

impl ActivitySource {
    pub const ALL: [Self; 2] = [Self::GitPoll, Self::GitHubPoll];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitPoll => "git_poll",
            Self::GitHubPoll => "github_poll",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|source| source.as_str() == raw)
    }
}

impl fmt::Display for ActivitySource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActivityKind {
    Commit,
    PullRequestOpened,
    ChecksPassed,
    ChecksFailed,
    PullRequestMerged,
}

impl ActivityKind {
    pub const ALL: [Self; 5] = [
        Self::Commit,
        Self::PullRequestOpened,
        Self::ChecksPassed,
        Self::ChecksFailed,
        Self::PullRequestMerged,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::PullRequestOpened => "pr_opened",
            Self::ChecksPassed => "checks_passed",
            Self::ChecksFailed => "checks_failed",
            Self::PullRequestMerged => "pr_merged",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }
}

impl fmt::Display for ActivityKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One thing that happened in the git history of a task, as a source reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityEvent {
    pub task_id: TaskId,
    pub kind: ActivityKind,
    pub source: ActivitySource,
    /// The commit SHA of a commit, the pull request URL of an opened or merged pull
    /// request, or the head commit SHA the checks ran on for a CI result.
    pub external_ref: String,
    /// The summary line of a commit, the title of a pull request, or a short CI text.
    pub title: String,
    pub author: Option<String>,
    /// When it happened, in seconds since the Unix epoch.
    pub occurred_at: i64,
}

impl ActivityEvent {
    /// Identifies the event within its task. The source is not part of it, so the same
    /// event seen by polling and later by a webhook is stored once.
    pub fn dedup_key(&self) -> String {
        format!("{}:{}", self.kind, self.external_ref)
    }
}

/// An activity event as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedActivity {
    pub event: ActivityEvent,
    /// When Toodo first stored the event, in seconds since the Unix epoch.
    pub received_at: i64,
    /// The latest time any source reported the event again.
    pub confirmed_at: i64,
}

/// Whether a workspace with these axes has a git activity timeline: only a git
/// repository whose tasks are not completed by hand. Nothing is read or recorded for the
/// others.
pub fn tracks(source: Source, completion: CompletionMode) -> bool {
    source.is_git() && completion != CompletionMode::Manual
}

/// Commit events of `records`, titled with the first line of each message.
pub fn commit_events(records: &[CommitRecord], source: ActivitySource) -> Vec<ActivityEvent> {
    records
        .iter()
        .map(|record| ActivityEvent {
            task_id: record.task_id,
            kind: ActivityKind::Commit,
            source,
            external_ref: record.sha.clone(),
            title: record.message.lines().next().unwrap_or("").to_owned(),
            author: Some(record.author.clone()),
            occurred_at: record.committed_at,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::{Runner, check_axes};

    #[test]
    fn kinds_and_sources_round_trip_through_their_names() {
        for kind in ActivityKind::ALL {
            assert_eq!(ActivityKind::parse(kind.as_str()), Some(kind));
        }
        for source in ActivitySource::ALL {
            assert_eq!(ActivitySource::parse(source.as_str()), Some(source));
        }
        assert_eq!(ActivityKind::parse("pull_request_opened"), None);
        assert_eq!(ActivitySource::parse("webhook"), None);
    }

    #[test]
    fn only_git_workspaces_not_completed_by_hand_are_tracked() {
        let tracked = [
            (Source::LocalGit, CompletionMode::LocalMerge),
            (Source::GitHub, CompletionMode::PullRequestMerge),
        ];
        let mut allowed = 0;
        for source in Source::ALL {
            for completion in CompletionMode::ALL {
                if !Runner::ALL
                    .into_iter()
                    .any(|runner| check_axes(source, completion, runner).is_ok())
                {
                    continue;
                }
                allowed += 1;
                assert_eq!(
                    tracks(source, completion),
                    tracked.contains(&(source, completion)),
                    "{source} {completion}"
                );
            }
        }
        assert_eq!(allowed, 5);
    }

    #[test]
    fn the_dedup_key_ignores_the_source_and_commits_take_their_first_line() {
        let record = CommitRecord {
            task_id: TaskId(3),
            sha: "abc".to_owned(),
            message: "Add login\n\nWith a form".to_owned(),
            author: "Ada <ada@example.com>".to_owned(),
            committed_at: 10,
        };
        let polled = commit_events(std::slice::from_ref(&record), ActivitySource::GitPoll);
        let from_github = commit_events(&[record], ActivitySource::GitHubPoll);
        assert_eq!(polled[0].title, "Add login");
        assert_eq!(polled[0].author.as_deref(), Some("Ada <ada@example.com>"));
        assert_eq!(polled[0].occurred_at, 10);
        assert_eq!(polled[0].dedup_key(), "commit:abc");
        assert_eq!(polled[0].dedup_key(), from_github[0].dedup_key());
    }
}
