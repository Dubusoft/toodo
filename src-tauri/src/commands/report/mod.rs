//! Review reports of a period as Markdown and CSV, rendered from the entries of
//! `review_period` in the time zone of the reader (see `docs/architecture.md`, Review).

mod csv;
mod period;
mod summary;
#[cfg(test)]
mod tests;

use std::collections::HashMap;

use jiff::civil::Date;
use jiff::tz::TimeZone;

use super::types::{
    Estimate, EstimateUnit, NoteKind, PullRequestSnapshot, ReviewEntry, ReviewOutcome,
    ReviewPeriodKind, Task, TaskEvent, TaskResolution, TaskStatus, TaskType,
};

pub use period::ReportPeriod;

/// What a report is rendered from: the reviewed entries of the period, the names of the
/// workspaces, the time zone its days and times are in, and the time due dates and
/// active time are judged at.
pub struct Report<'a> {
    pub period: &'a ReportPeriod,
    pub entries: &'a [ReviewEntry],
    pub workspace_names: &'a HashMap<i64, String>,
    pub time_zone: &'a TimeZone,
    pub now: i64,
}

const OUTCOMES: [ReviewOutcome; 5] = [
    ReviewOutcome::Completed,
    ReviewOutcome::OpenedForReview,
    ReviewOutcome::Started,
    ReviewOutcome::WorkedOn,
    ReviewOutcome::Planned,
];

fn outcome_label(outcome: ReviewOutcome) -> &'static str {
    match outcome {
        ReviewOutcome::Completed => "Completed",
        ReviewOutcome::OpenedForReview => "Awaiting completion",
        ReviewOutcome::Started => "Started",
        ReviewOutcome::WorkedOn => "Worked on",
        ReviewOutcome::Planned => "Planned",
    }
}

fn type_name(task_type: TaskType) -> &'static str {
    match task_type {
        TaskType::Feat => "feat",
        TaskType::Fix => "fix",
        TaskType::Modify => "modify",
        TaskType::Refactor => "refactor",
        TaskType::Docs => "docs",
        TaskType::Test => "test",
        TaskType::Chore => "chore",
        TaskType::Rnd => "rnd",
    }
}

fn resolution_label(resolution: Option<TaskResolution>) -> Option<&'static str> {
    resolution.map(|resolution| match resolution {
        TaskResolution::Merged => "Merged",
        TaskResolution::Completed => "Completed",
        TaskResolution::NotAdopted => "Not adopted",
    })
}

fn plural(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("{count} {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

/// `value` with `digits` decimals, rounding halves up as JavaScript's `toFixed` does for
/// the positive values reports show.
fn fixed(value: f64, digits: i32) -> String {
    let scale = 10_f64.powi(digits);
    format!("{:.*}", digits as usize, (value * scale).round() / scale)
}

/// A duration in seconds as hours below a day, otherwise as days with one decimal.
fn format_duration(seconds: f64) -> String {
    let hours = seconds / 3600.0;
    if hours < 1.0 {
        "<1h".to_owned()
    } else if hours.round() < 24.0 {
        format!("{}h", hours.round())
    } else {
        format!("{}d", fixed(hours / 24.0, 1))
    }
}

/// The text of a note or completion note on one line, for list items and CSV cells.
fn one_line(text: &str) -> String {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    pieces
        .iter()
        .enumerate()
        .map(|(index, piece)| {
            let piece = if index > 0 { piece.trim_start() } else { piece };
            if index < last {
                piece.trim_end()
            } else {
                piece
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn non_empty(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|text| !text.is_empty())
}

fn pull_request_stats(pull_request: &PullRequestSnapshot) -> String {
    format!(
        "#{}, +{}/-{} in {}, {}",
        pull_request.number,
        pull_request.additions,
        pull_request.deletions,
        plural(pull_request.changed_files as usize, "file"),
        plural(pull_request.review_count as usize, "review"),
    )
}

fn format_estimate(estimate: Estimate) -> String {
    let suffix = match estimate.unit {
        EstimateUnit::Hours => "h",
        EstimateUnit::Days => "d",
        EstimateUnit::Weeks => "w",
        EstimateUnit::Months => "mo",
    };
    format!("{}{suffix}", (estimate.amount * 100.0).round() / 100.0)
}

/// The estimate in seconds of active work: a day is 24 hours, a week 7 days, a month 30.
fn estimated_seconds(estimate: Option<Estimate>) -> Option<f64> {
    estimate.map(|estimate| {
        let unit = match estimate.unit {
            EstimateUnit::Hours => 3600.0,
            EstimateUnit::Days => 24.0 * 3600.0,
            EstimateUnit::Weeks => 7.0 * 24.0 * 3600.0,
            EstimateUnit::Months => 30.0 * 24.0 * 3600.0,
        };
        estimate.amount * unit
    })
}

/// A stretch of a task's history from its first start: work (in progress or in review),
/// or waiting (back in `planned`: paused, blocked by prerequisites, or reopened) with the
/// reason recorded when it began. `end` is `None` while the task is still in it.
struct Segment<'a> {
    active: bool,
    start: i64,
    end: Option<i64>,
    reason: Option<&'a str>,
}

impl Segment<'_> {
    fn seconds(&self, now: i64) -> i64 {
        (self.end.unwrap_or(now) - self.start).max(0)
    }
}

/// The stretches of work and waiting of a task, oldest first; empty when the history
/// records no start.
fn segments(timeline: &[TaskEvent]) -> Vec<Segment<'_>> {
    let mut segments: Vec<Segment<'_>> = Vec::new();
    for event in timeline {
        if let Some(last) = segments.last_mut() {
            last.end.get_or_insert(event.at.0);
        }
        let active = match event.status {
            TaskStatus::Done => continue,
            TaskStatus::Planned if segments.is_empty() => continue,
            TaskStatus::Planned => false,
            TaskStatus::InProgress | TaskStatus::InReview => true,
        };
        segments.push(Segment {
            active,
            start: event.at.0,
            end: None,
            reason: event.reason.as_deref(),
        });
    }
    segments
}

/// Seconds a task spent working (`active`) or waiting from its first start; a stretch
/// still under way counts until `now`. `None` when the history records no start.
fn seconds_in(timeline: &[TaskEvent], now: i64, active: bool) -> Option<i64> {
    let segments = segments(timeline);
    if segments.is_empty() {
        return None;
    }
    Some(
        segments
            .iter()
            .filter(|segment| segment.active == active)
            .map(|segment| segment.seconds(now))
            .sum(),
    )
}

/// Seconds a task spent in progress or in review from its first start, leaving out its
/// pauses; a stretch still under way counts until `now`. `None` when the history records
/// no start.
fn active_seconds(timeline: &[TaskEvent], now: i64) -> Option<i64> {
    seconds_in(timeline, now, true)
}

/// Seconds a task spent waiting after its first start: paused, blocked by prerequisites,
/// or reopened, until it was started again; a wait still under way counts until `now`.
/// `None` when the history records no start.
fn waiting_seconds(timeline: &[TaskEvent], now: i64) -> Option<i64> {
    seconds_in(timeline, now, false)
}

/// [`format_duration`], with no time at all as `0h` rather than `<1h`.
fn format_span(seconds: i64) -> String {
    if seconds == 0 {
        "0h".to_owned()
    } else {
        format_duration(seconds as f64)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DueState {
    OnTime,
    Late,
    Overdue,
    Upcoming,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct DurationStat {
    median: f64,
    tasks: usize,
}

fn median(mut values: Vec<f64>) -> Option<DurationStat> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    let median = if values.len() % 2 == 1 {
        values[middle]
    } else {
        (values[middle - 1] + values[middle]) / 2.0
    };
    Some(DurationStat {
        median,
        tasks: values.len(),
    })
}

fn format_stat(stat: Option<DurationStat>) -> String {
    match stat {
        None => "no data".to_owned(),
        Some(stat) => format!(
            "{} ({})",
            format_duration(stat.median),
            plural(stat.tasks, "task")
        ),
    }
}

/// Counts of `keys`, the most frequent first, then by key.
fn count_by(keys: Vec<String>) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for key in keys {
        match counts.iter_mut().find(|(seen, _)| *seen == key) {
            Some((_, count)) => *count += 1,
            None => counts.push((key, 1)),
        }
    }
    counts.sort_by(|(a, a_count), (b, b_count)| {
        b_count
            .cmp(a_count)
            .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
            .then_with(|| a.cmp(b))
    });
    counts
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Changes {
    pull_requests: usize,
    additions: i64,
    deletions: i64,
    changed_files: i64,
    reviews: i64,
    reviewed: usize,
}

impl Changes {
    fn sum<'a>(pull_requests: impl Iterator<Item = &'a PullRequestSnapshot>) -> Option<Self> {
        let total = pull_requests.fold(Self::default(), |total, pull_request| Self {
            pull_requests: total.pull_requests + 1,
            additions: total.additions + pull_request.additions,
            deletions: total.deletions + pull_request.deletions,
            changed_files: total.changed_files + pull_request.changed_files,
            reviews: total.reviews + pull_request.review_count,
            reviewed: total.reviewed + usize::from(pull_request.review_count > 0),
        });
        (total.pull_requests > 0).then_some(total)
    }

    /// E.g. `+120/-30 in 9 files (3 pull requests)`.
    fn format(&self) -> String {
        format!(
            "+{}/-{} in {} ({})",
            self.additions,
            self.deletions,
            plural(self.changed_files as usize, "file"),
            plural(self.pull_requests, "pull request"),
        )
    }
}

struct LateTask<'a> {
    task: &'a Task,
    due_date: &'a str,
    done: bool,
    seconds_late: i64,
}

impl Report<'_> {
    fn date(&self, at: i64) -> Date {
        self.zoned(at).date()
    }

    fn zoned(&self, at: i64) -> jiff::Zoned {
        let at = at.clamp(
            jiff::Timestamp::MIN.as_second(),
            jiff::Timestamp::MAX.as_second(),
        );
        jiff::Timestamp::from_second(at)
            .expect("the second is clamped into range")
            .to_zoned(self.time_zone.clone())
    }

    /// Local date and time as `YYYY-MM-DD HH:MM`, which spreadsheets read as a date.
    fn date_time(&self, at: i64) -> String {
        self.zoned(at).strftime("%Y-%m-%d %H:%M").to_string()
    }

    fn workspace(&self, task: &Task) -> String {
        self.workspace_names
            .get(&task.workspace_id.0)
            .cloned()
            .unwrap_or_else(|| format!("workspace {}", task.workspace_id.0))
    }

    fn completed(&self) -> impl Iterator<Item = &ReviewEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.outcome == ReviewOutcome::Completed)
    }

    /// The end of the due day: a task completed before it is on time.
    fn due_end(&self, day: &str) -> Option<i64> {
        let next = day.parse::<Date>().ok()?.tomorrow().ok()?;
        Some(
            next.to_zoned(self.time_zone.clone())
                .ok()?
                .timestamp()
                .as_second(),
        )
    }

    fn due_state(&self, task: &Task) -> Option<DueState> {
        let end = self.due_end(task.due_date.as_deref()?)?;
        if task.status == TaskStatus::Done {
            let completed_at = task.milestones.completed_at?.0;
            return Some(if completed_at < end {
                DueState::OnTime
            } else {
                DueState::Late
            });
        }
        Some(if self.now >= end {
            DueState::Overdue
        } else {
            DueState::Upcoming
        })
    }

    fn seconds_past_due(&self, task: &Task) -> i64 {
        let Some(end) = task.due_date.as_deref().and_then(|day| self.due_end(day)) else {
            return 0;
        };
        let until = if task.status == TaskStatus::Done {
            task.milestones.completed_at.map_or(self.now, |at| at.0)
        } else {
            self.now
        };
        (until - end).max(0)
    }

    /// Completed tasks done late and open tasks past their due date, the latest first. An
    /// open task is late once its due date passed before the end of the period, or before
    /// now while the period is under way.
    fn late(&self) -> Vec<LateTask<'_>> {
        let cutoff = self.now.min(self.period.end);
        let mut late: Vec<LateTask<'_>> = self
            .entries
            .iter()
            .filter_map(|entry| {
                let task = &entry.task;
                let due_date = task.due_date.as_deref()?;
                if task.status == TaskStatus::Done {
                    return (entry.outcome == ReviewOutcome::Completed
                        && self.due_state(task) == Some(DueState::Late))
                    .then(|| LateTask {
                        task,
                        due_date,
                        done: true,
                        seconds_late: self.seconds_past_due(task),
                    });
                }
                let end = self.due_end(due_date)?;
                (cutoff >= end).then_some(LateTask {
                    task,
                    due_date,
                    done: false,
                    seconds_late: cutoff - end,
                })
            })
            .collect();
        late.sort_by(|a, b| {
            b.seconds_late
                .cmp(&a.seconds_late)
                .then(a.task.id.0.cmp(&b.task.id.0))
        });
        late
    }

    fn late_details(&self, late: &LateTask<'_>) -> String {
        let finish = match late.task.milestones.completed_at {
            Some(at) if late.done => format!("done {}", self.date(at.0)),
            _ => "still open".to_owned(),
        };
        format!(
            "due {}, {finish}, {} {}",
            late.due_date,
            format_duration(late.seconds_late as f64),
            if late.done { "late" } else { "overdue" }
        )
    }

    /// `(estimated, active)` seconds of the completed tasks with an estimate and a
    /// recorded active time.
    fn estimated_and_active(&self, entry: &ReviewEntry) -> Option<(f64, f64)> {
        let estimated = estimated_seconds(entry.task.estimate)?;
        let actual = active_seconds(&entry.task.timeline, entry.at.0)?;
        Some((estimated, actual as f64))
    }

    /// The review as Markdown, for pasting into a report.
    pub fn markdown(&self) -> String {
        let period = self.period;
        let mut lines = vec![
            format!("# {}: {}", period.title(), period.label()),
            String::new(),
        ];
        let groups: Vec<(ReviewOutcome, Vec<&ReviewEntry>)> = OUTCOMES
            .iter()
            .map(|&outcome| {
                let entries = self
                    .entries
                    .iter()
                    .filter(|entry| entry.outcome == outcome)
                    .collect::<Vec<_>>();
                (outcome, entries)
            })
            .filter(|(_, entries)| !entries.is_empty())
            .collect();
        if groups.is_empty() {
            lines.push("No recorded activity.".to_owned());
            lines.push(String::new());
            return lines.join("\n");
        }
        self.summary_lines(&mut lines, &groups);
        if period.kind == ReviewPeriodKind::Year {
            self.year_in_review_lines(&mut lines);
        }
        let months = period.months();
        if months.len() >= 2 {
            lines.push("| Month | Completed |".to_owned());
            lines.push("| --- | --- |".to_owned());
            for month in months {
                let count = self
                    .completed()
                    .filter(|entry| self.date(entry.at.0).strftime("%Y-%m").to_string() == month)
                    .count();
                lines.push(format!("| {month} | {count} |"));
            }
            lines.push(String::new());
        }
        for (outcome, entries) in &groups {
            lines.push(format!(
                "## {} ({})",
                outcome_label(*outcome),
                entries.len()
            ));
            lines.push(String::new());
            for entry in entries {
                self.entry_lines(&mut lines, entry);
            }
            lines.push(String::new());
        }
        lines.join("\n")
    }

    fn entry_lines(&self, lines: &mut Vec<String>, entry: &ReviewEntry) {
        let task = &entry.task;
        let not_adopted = task.resolution == Some(TaskResolution::NotAdopted);
        let mut details = vec![self.workspace(task), self.date(entry.at.0).to_string()];
        if not_adopted {
            details.push("not adopted".to_owned());
        }
        if task.resolution == Some(TaskResolution::Completed) {
            details.push("Completed".to_owned());
        }
        if let Some(estimate) = task.estimate {
            details.push(format!("estimate {}", format_estimate(estimate)));
        }
        if let Some(due) = non_empty(&task.due_date) {
            details.push(format!("due {due}"));
        }
        if let Some(issue) = &task.issue {
            details.push(issue.url.clone());
        }
        details.extend(
            task.refs
                .iter()
                .filter_map(|r| r.strip_prefix("pr:"))
                .map(str::to_owned),
        );
        if let Some(pull_request) = &entry.pull_request {
            details.push(pull_request_stats(pull_request));
        }
        lines.push(format!(
            "- [{}] {} ({})",
            type_name(task.task_type),
            task.title,
            details.join(", ")
        ));
        if let Some(note) = non_empty(&task.completion_note) {
            let label = if not_adopted { "Conclusion" } else { "Note" };
            lines.push(format!("  - {label}: {}", one_line(note)));
        }
        if let (Some(active), Some(waiting)) = (
            active_seconds(&task.timeline, self.now),
            waiting_seconds(&task.timeline, self.now),
        ) {
            lines.push(format!(
                "  - Time: {} active, {} waiting",
                format_span(active),
                format_span(waiting)
            ));
        }
        for wait in segments(&task.timeline) {
            let end = wait.end.unwrap_or(self.now);
            if wait.active || wait.start >= self.period.end || end <= self.period.start {
                continue;
            }
            let still = if wait.end.is_none() {
                ", still waiting"
            } else {
                ""
            };
            lines.push(format!(
                "  - Waiting {} from {}{still}: {}",
                format_span(wait.seconds(self.now)),
                self.date(wait.start),
                wait.reason
                    .map_or("no reason recorded".to_owned(), one_line)
            ));
        }
        for note in &task.notes {
            if self.period.start <= note.at.0 && note.at.0 < self.period.end {
                let label = match note.kind {
                    NoteKind::Blocker => "Blocker",
                    NoteKind::Progress => "Progress",
                    NoteKind::Decision => "Decision",
                };
                lines.push(format!("  - {label}: {}", one_line(&note.body)));
            }
        }
        for commit in &entry.commits {
            let sha: String = commit.sha.chars().take(7).collect();
            let subject = commit.message.split('\n').next().unwrap_or_default();
            lines.push(format!("  - `{sha}` {subject}"));
        }
    }
}
