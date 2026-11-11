//! Review reports of a period as Markdown and CSV, rendered from the entries of
//! `review_period` in the time zone of the reader (see `docs/architecture.md`, Review).

use std::collections::HashMap;

use jiff::ToSpan;
use jiff::civil::Date;
use jiff::tz::TimeZone;

use super::types::{
    Estimate, EstimateUnit, NoteKind, PullRequestSnapshot, ReportFormat, ReviewEntry,
    ReviewOutcome, ReviewPeriodKind, Task, TaskEvent, TaskResolution, TaskStatus, TaskType,
};

/// A reviewed period: the calendar days `from` to `to`, both included, and the half-open
/// range `[start, end)` from midnight of `from` to midnight after `to` in its time zone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportPeriod {
    pub kind: ReviewPeriodKind,
    pub from: Date,
    pub to: Date,
    pub start: i64,
    pub end: i64,
}

impl ReportPeriod {
    /// The period of `kind` that starts on `from` (for a week), contains `from` or `date`
    /// (for a month, quarter, or year), or contains `today` when neither is given; a
    /// custom period needs `from` and `to`.
    pub fn resolve(
        kind: ReviewPeriodKind,
        date: Option<Date>,
        from: Option<Date>,
        to: Option<Date>,
        today: Date,
        tz: &TimeZone,
    ) -> Result<Self, String> {
        if date.is_some() && from.is_some() {
            return Err(
                "give either date (a day inside the period) or from (its first day), not both"
                    .to_owned(),
            );
        }
        let out_of_range = || {
            "the period is out of the supported range of days; pick days in the years 1 to 9998"
                .to_owned()
        };
        let (first, last) = match kind {
            ReviewPeriodKind::Custom => {
                if date.is_some() {
                    return Err(
                        "a custom period takes from and to, its first and last day; pass those \
                         instead of date, or pick period week, month, quarter, or year"
                            .to_owned(),
                    );
                }
                let (Some(from), Some(to)) = (from, to) else {
                    return Err(
                        "a custom period needs from and to, its first and last day as \
                         YYYY-MM-DD; or pick period week, month, quarter, or year"
                            .to_owned(),
                    );
                };
                if to < from {
                    return Err(format!(
                        "to {to} is before from {from}; pass a last day on or after the first"
                    ));
                }
                (from, to)
            }
            _ if to.is_some() => {
                return Err(
                    "to is only for a custom period; pass period custom with from and to, or \
                     leave out to"
                        .to_owned(),
                );
            }
            ReviewPeriodKind::Week => {
                let first = match from {
                    Some(from) => from,
                    None => {
                        let day = date.unwrap_or(today);
                        let since_monday = i64::from(day.weekday().to_monday_zero_offset());
                        day.checked_sub(since_monday.days())
                            .map_err(|_| out_of_range())?
                    }
                };
                let last = first.checked_add(6.days()).map_err(|_| out_of_range())?;
                (first, last)
            }
            ReviewPeriodKind::Month | ReviewPeriodKind::Quarter | ReviewPeriodKind::Year => {
                let day = from.or(date).unwrap_or(today);
                let (first_month, months) = match kind {
                    ReviewPeriodKind::Month => (day.month(), 1),
                    ReviewPeriodKind::Quarter => (day.month() - (day.month() - 1) % 3, 3),
                    _ => (1, 12),
                };
                let first = Date::new(day.year(), first_month, 1).map_err(|_| out_of_range())?;
                let last = first
                    .checked_add(months.months())
                    .and_then(|next| next.yesterday())
                    .map_err(|_| out_of_range())?;
                (first, last)
            }
        };
        let midnight = |day: Date| {
            day.to_zoned(tz.clone())
                .map(|zoned| zoned.timestamp().as_second())
                .map_err(|_| out_of_range())
        };
        Ok(Self {
            kind,
            from: first,
            to: last,
            start: midnight(first)?,
            end: midnight(last.tomorrow().map_err(|_| out_of_range())?)?,
        })
    }

    fn title(&self) -> &'static str {
        match self.kind {
            ReviewPeriodKind::Week => "Week review",
            ReviewPeriodKind::Month => "Month review",
            ReviewPeriodKind::Quarter => "Quarter review",
            ReviewPeriodKind::Year => "Year review",
            ReviewPeriodKind::Custom => "Review",
        }
    }

    /// The title of the period with its label, e.g. `Year review 2026`.
    pub fn name(&self) -> String {
        format!("{} {}", self.title(), self.label())
    }

    fn label(&self) -> String {
        match self.kind {
            ReviewPeriodKind::Month => self.from.strftime("%Y-%m").to_string(),
            ReviewPeriodKind::Quarter => {
                format!("{} Q{}", self.from.year(), (self.from.month() - 1) / 3 + 1)
            }
            ReviewPeriodKind::Year => self.from.year().to_string(),
            ReviewPeriodKind::Week | ReviewPeriodKind::Custom => {
                format!("{} to {}", self.from, self.to)
            }
        }
    }

    pub fn file_name(&self, format: ReportFormat) -> String {
        let extension = match format {
            ReportFormat::Markdown => "md",
            ReportFormat::Csv => "csv",
        };
        format!(
            "toodo-review-{}.{extension}",
            self.label().replace(' ', "-")
        )
    }

    /// The calendar months the period touches, as `YYYY-MM`.
    fn months(&self) -> Vec<String> {
        let mut months = Vec::new();
        let mut month = self.from.first_of_month();
        while month <= self.to {
            months.push(month.strftime("%Y-%m").to_string());
            match month.checked_add(1.month()) {
                Ok(next) => month = next,
                Err(_) => break,
            }
        }
        months
    }
}

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

    fn summary_lines(
        &self,
        lines: &mut Vec<String>,
        groups: &[(ReviewOutcome, Vec<&ReviewEntry>)],
    ) {
        let completed: Vec<&ReviewEntry> = self.completed().collect();
        lines.push("## Summary".to_owned());
        lines.push(String::new());
        lines.push(format!(
            "- {}",
            groups
                .iter()
                .map(|(outcome, entries)| format!("{}: {}", outcome_label(*outcome), entries.len()))
                .collect::<Vec<_>>()
                .join(", ")
        ));
        let commits: usize = self.entries.iter().map(|entry| entry.commits.len()).sum();
        lines.push(format!("- Commits: {commits}"));
        let not_adopted = completed
            .iter()
            .filter(|entry| entry.task.resolution == Some(TaskResolution::NotAdopted))
            .count();
        if not_adopted > 0 {
            lines.push(format!(
                "- Concluded without merging (not adopted): {not_adopted}"
            ));
        }
        if !completed.is_empty() {
            let by_type = count_by(
                completed
                    .iter()
                    .map(|entry| type_name(entry.task.task_type).to_owned())
                    .collect(),
            );
            let by_workspace = count_by(
                completed
                    .iter()
                    .map(|entry| self.workspace(&entry.task))
                    .collect(),
            );
            let join = |counts: Vec<(String, usize)>| {
                counts
                    .iter()
                    .map(|(key, count)| format!("{key} {count}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            lines.push(format!("- Completed by type: {}", join(by_type)));
            lines.push(format!("- Completed by workspace: {}", join(by_workspace)));
        }
        if let Some(changes) = Changes::sum(
            completed
                .iter()
                .filter_map(|entry| entry.pull_request.as_ref()),
        ) {
            lines.push(format!(
                "- Changes in completed pull requests: {}",
                changes.format()
            ));
        }
        let span = |from: fn(&Task) -> Option<i64>, to: fn(&ReviewEntry) -> i64| {
            median(
                completed
                    .iter()
                    .filter_map(|entry| from(&entry.task).map(|from| (to(entry) - from) as f64))
                    .collect(),
            )
        };
        let at = |entry: &ReviewEntry| entry.at.0;
        let durations = [
            (
                "Median lead time (planned to completed)",
                span(|task| task.milestones.planned_at.map(|at| at.0), at),
            ),
            (
                "Median cycle time (started to completed)",
                span(|task| task.milestones.started_at.map(|at| at.0), at),
            ),
            (
                "Median active time (started to completed, without pauses)",
                median(
                    completed
                        .iter()
                        .filter_map(|entry| active_seconds(&entry.task.timeline, entry.at.0))
                        .map(|seconds| seconds as f64)
                        .collect(),
                ),
            ),
            (
                "Median review time (awaiting completion to merged)",
                span(
                    |task| task.milestones.review_at.map(|at| at.0),
                    |entry| entry.at.0,
                ),
            ),
        ];
        for (label, stat) in durations {
            lines.push(format!("- {label}: {}", format_stat(stat)));
        }
        let planned = self
            .entries
            .iter()
            .any(|entry| entry.task.estimate.is_some() || entry.task.due_date.is_some());
        if planned {
            let timed: Vec<(f64, f64)> = completed
                .iter()
                .filter_map(|entry| self.estimated_and_active(entry))
                .collect();
            if !timed.is_empty() {
                let estimated: f64 = timed.iter().map(|(estimated, _)| estimated).sum();
                let actual: f64 = timed.iter().map(|(_, actual)| actual).sum();
                lines.push(format!(
                    "- Estimate vs active time: {} estimated, {} active ({}, {}x)",
                    format_duration(estimated),
                    format_duration(actual),
                    plural(timed.len(), "task"),
                    fixed(actual / estimated, 2),
                ));
            }
            let due: Vec<DueState> = completed
                .iter()
                .filter_map(|entry| self.due_state(&entry.task))
                .filter(|state| matches!(state, DueState::OnTime | DueState::Late))
                .collect();
            if !due.is_empty() {
                let on_time = due
                    .iter()
                    .filter(|state| **state == DueState::OnTime)
                    .count();
                lines.push(format!(
                    "- Due dates met: {on_time} of {} ({}%)",
                    due.len(),
                    (on_time as f64 / due.len() as f64 * 100.0).round()
                ));
            }
        }
        lines.push(String::new());
        if planned {
            let late = self.late();
            if !late.is_empty() {
                lines.push(format!("## Late ({})", late.len()));
                lines.push(String::new());
                for late in &late {
                    lines.push(format!(
                        "- [{}] {} ({})",
                        type_name(late.task.task_type),
                        late.task.title,
                        self.late_details(late)
                    ));
                }
                lines.push(String::new());
            }
        }
    }

    /// Merged pull requests, research conclusions, and estimate overruns of the tasks
    /// completed in a year.
    fn year_in_review_lines(&self, lines: &mut Vec<String>) {
        let completed: Vec<&ReviewEntry> = self.completed().collect();
        let merged: Vec<(&Task, &PullRequestSnapshot)> = completed
            .iter()
            .filter_map(|entry| entry.pull_request.as_ref().map(|pr| (&entry.task, pr)))
            .collect();
        let mut research: Vec<&ReviewEntry> = completed
            .iter()
            .copied()
            .filter(|entry| entry.task.task_type == TaskType::Rnd)
            .collect();
        research.sort_by_key(|entry| (entry.at.0, entry.task.id.0));
        let mut overruns: Vec<(&Task, f64, f64)> = completed
            .iter()
            .filter_map(|entry| {
                let (estimated, actual) = self.estimated_and_active(entry)?;
                (actual > estimated).then_some((&entry.task, estimated, actual))
            })
            .collect();
        overruns.sort_by(|(a, a_estimated, a_actual), (b, b_estimated, b_actual)| {
            (b_actual - b_estimated)
                .total_cmp(&(a_actual - a_estimated))
                .then(a.id.0.cmp(&b.id.0))
        });
        overruns.truncate(3);
        if merged.is_empty() && research.is_empty() && overruns.is_empty() {
            return;
        }
        lines.push("## Year in review".to_owned());
        lines.push(String::new());
        if let Some(totals) = Changes::sum(merged.iter().map(|(_, pr)| *pr)) {
            lines.push(format!("- Merged pull requests: {}", totals.format()));
            lines.push(format!(
                "- Reviews: {} on {} of {}",
                plural(totals.reviews as usize, "review"),
                totals.reviewed,
                plural(totals.pull_requests, "pull request")
            ));
        }
        if !merged.is_empty() {
            let mut largest = merged.clone();
            largest.sort_by(|(a, a_pr), (b, b_pr)| {
                (b_pr.additions + b_pr.deletions)
                    .cmp(&(a_pr.additions + a_pr.deletions))
                    .then(a.id.0.cmp(&b.id.0))
            });
            lines.push("- Largest pull requests:".to_owned());
            for (task, pull_request) in largest.iter().take(3) {
                lines.push(format!(
                    "  - [{}] {} ({})",
                    type_name(task.task_type),
                    task.title,
                    pull_request_stats(pull_request)
                ));
            }
        }
        if !research.is_empty() {
            lines.push("- Research conclusions:".to_owned());
            for entry in research {
                let task = &entry.task;
                let adopted = task.resolution != Some(TaskResolution::NotAdopted);
                let conclusion = non_empty(&task.completion_note)
                    .map(|note| format!(": {}", one_line(note)))
                    .unwrap_or_default();
                lines.push(format!(
                    "  - {} ({}){conclusion}",
                    task.title,
                    if adopted { "adopted" } else { "not adopted" }
                ));
            }
        }
        if !overruns.is_empty() {
            lines.push("- Largest estimate overruns:".to_owned());
            for (task, estimated, actual) in overruns {
                lines.push(format!(
                    "  - [{}] {} (estimated {}, {} active)",
                    type_name(task.task_type),
                    task.title,
                    format_duration(estimated),
                    format_duration(actual)
                ));
            }
        }
        lines.push(String::new());
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

    /// One row per reviewed task as CSV (RFC 4180, CRLF line ends), led by a UTF-8 byte
    /// order mark so spreadsheet apps read non-ASCII titles correctly. Active hours of a
    /// task still being worked on count until now.
    pub fn csv(&self) -> String {
        let mut text = String::from("\u{feff}");
        let header = CSV_COLUMNS.map(|column| Some(column.to_owned()));
        push_csv_row(&mut text, &header);
        for entry in self.entries {
            push_csv_row(&mut text, &self.csv_row(entry));
        }
        text
    }

    fn csv_row(&self, entry: &ReviewEntry) -> [Option<String>; CSV_COLUMNS.len()] {
        let task = &entry.task;
        let time = |at: Option<super::types::Timestamp>| at.map(|at| self.date_time(at.0));
        let milestones = &task.milestones;
        let pull_request = entry.pull_request.as_ref();
        let due_status = self.due_state(task).map(|state| {
            match state {
                DueState::OnTime => "On time",
                DueState::Late => "Late",
                DueState::Overdue => "Overdue",
                DueState::Upcoming => "Not due yet",
            }
            .to_owned()
        });
        [
            Some(task.id.0.to_string()),
            Some(self.workspace(task)),
            Some(type_name(task.task_type).to_owned()),
            Some(task.title.clone()),
            Some(outcome_label(entry.outcome).to_owned()),
            Some(self.date_time(entry.at.0)),
            resolution_label(task.resolution).map(str::to_owned),
            time(milestones.planned_at),
            time(milestones.started_at),
            time(milestones.review_at),
            time(milestones.completed_at),
            None,
            task.refs
                .iter()
                .find_map(|r| r.strip_prefix("pr:").map(str::to_owned)),
            task.issue.as_ref().map(|issue| issue.url.clone()),
            Some(entry.commits.len().to_string()),
            active_seconds(&task.timeline, self.now).map(hours),
            waiting_seconds(&task.timeline, self.now).map(hours),
            task.estimate.map(|estimate| estimate.amount.to_string()),
            task.estimate.map(|estimate| {
                match estimate.unit {
                    EstimateUnit::Hours => "hours",
                    EstimateUnit::Days => "days",
                    EstimateUnit::Weeks => "weeks",
                    EstimateUnit::Months => "months",
                }
                .to_owned()
            }),
            task.due_date.clone(),
            due_status,
            pull_request.map(|pr| pr.additions.to_string()),
            pull_request.map(|pr| pr.deletions.to_string()),
            pull_request.map(|pr| pr.changed_files.to_string()),
            pull_request.map(|pr| pr.review_count.to_string()),
            task.completion_note.as_deref().map(one_line),
        ]
    }
}

/// Seconds as hours with one decimal, for CSV cells.
fn hours(seconds: i64) -> String {
    ((seconds as f64 / 360.0).round() / 10.0).to_string()
}

const CSV_COLUMNS: [&str; 26] = [
    "Task",
    "Workspace",
    "Type",
    "Title",
    "Outcome",
    "Outcome at",
    "Resolution",
    "Planned",
    "Started",
    "Awaiting completion",
    "Completed",
    "Merged",
    "Pull request",
    "Issue",
    "Commits in period",
    "Active hours",
    "Waiting hours",
    "Estimate",
    "Estimate unit",
    "Due date",
    "Due status",
    "Additions",
    "Deletions",
    "Changed files",
    "Reviews",
    "Completion note",
];

fn push_csv_row(text: &mut String, fields: &[Option<String>]) {
    let row: Vec<String> = fields
        .iter()
        .map(|field| {
            let field = field.as_deref().unwrap_or_default();
            if field.contains(['"', ',', '\r', '\n']) {
                format!("\"{}\"", field.replace('"', "\"\""))
            } else {
                field.to_owned()
            }
        })
        .collect();
    text.push_str(&row.join(","));
    text.push_str("\r\n");
}

#[cfg(test)]
mod tests {
    use jiff::civil::date;

    use super::*;
    use crate::commands::types::{
        CommitRecord, LinkedIssue, TaskId, TaskMilestones, TaskNote, Timestamp, WorkspaceId,
    };

    const HOUR: i64 = 3600;
    const DAY: i64 = 24 * HOUR;

    fn local(year: i16, month: i8, day: i8, hour: i8) -> i64 {
        date(year, month, day)
            .at(hour, 0, 0, 0)
            .to_zoned(TimeZone::UTC)
            .unwrap()
            .timestamp()
            .as_second()
    }

    fn now() -> i64 {
        local(2026, 12, 31, 0)
    }

    fn period(kind: ReviewPeriodKind, day: &str) -> ReportPeriod {
        let day = day.parse().ok();
        let (date, from) = match kind {
            ReviewPeriodKind::Week => (None, day),
            _ => (day, None),
        };
        ReportPeriod::resolve(kind, date, from, None, date_of(now()), &TimeZone::UTC).unwrap()
    }

    fn date_of(at: i64) -> Date {
        jiff::Timestamp::from_second(at)
            .unwrap()
            .to_zoned(TimeZone::UTC)
            .date()
    }

    fn week() -> ReportPeriod {
        period(ReviewPeriodKind::Week, "2026-10-12")
    }

    fn entry(id: i64, outcome: ReviewOutcome) -> ReviewEntry {
        ReviewEntry {
            pull_request: None,
            task: Task {
                refs: Vec::new(),
                id: TaskId(id),
                workspace_id: WorkspaceId(1),
                task_type: TaskType::Feat,
                title: format!("Task {id}"),
                description: String::new(),
                status: TaskStatus::InProgress,
                resolution: None,
                depends_on: Vec::new(),

                issue: None,
                estimate: None,
                due_date: None,
                labels: Vec::new(),

                completion_note: None,
                timeline: Vec::new(),
                milestones: TaskMilestones {
                    planned_at: None,
                    started_at: None,
                    review_at: None,
                    completed_at: None,
                    reopened_at: None,
                    paused_at: None,
                    last_review_at: None,
                    active_seconds: 0,
                    pause_count: 0,
                },
                notes: Vec::new(),
                criteria: Vec::new(),
                wait: None,
                autopilot: false,
                autopilot_at: None,
            },
            outcome,
            at: Timestamp(local(2026, 10, 13, 15)),
            commits: Vec::new(),
            archived: false,
        }
    }

    fn completed(id: i64, at: i64) -> ReviewEntry {
        let mut entry = entry(id, ReviewOutcome::Completed);
        entry.task.status = TaskStatus::Done;
        entry.task.milestones.completed_at = Some(Timestamp(at));
        entry.at = Timestamp(at);
        entry
    }

    fn snapshot(number: i64) -> PullRequestSnapshot {
        PullRequestSnapshot {
            number,
            title: format!("Pull request {number}"),
            additions: 120,
            deletions: 30,
            changed_files: 4,
            merge_commit_sha: Some("abc123".to_owned()),
            review_count: 2,
            reviewer_count: 1,
            first_reviewed_at: None,
        }
    }

    fn event(status: TaskStatus, at: i64) -> TaskEvent {
        TaskEvent {
            status,
            at: Timestamp(at),
            reopened: false,
            reason: None,
        }
    }

    fn names() -> HashMap<i64, String> {
        HashMap::from([(1, "toodo".to_owned())])
    }

    fn markdown(period: &ReportPeriod, entries: &[ReviewEntry]) -> String {
        render(period, entries, &TimeZone::UTC, now()).markdown()
    }

    fn render<'a>(
        period: &'a ReportPeriod,
        entries: &'a [ReviewEntry],
        time_zone: &'a TimeZone,
        now: i64,
    ) -> Report<'a> {
        static NAMES: std::sync::LazyLock<HashMap<i64, String>> = std::sync::LazyLock::new(names);
        Report {
            period,
            entries,
            workspace_names: &NAMES,
            time_zone,
            now,
        }
    }

    #[test]
    fn resolves_each_kind_of_period_and_names_its_file() {
        let today = date(2026, 10, 15);
        let tz = TimeZone::UTC;
        let resolve = |kind, date: Option<&str>, from: Option<&str>, to: Option<&str>| {
            let day = |text: Option<&str>| text.map(|text| text.parse::<Date>().unwrap());
            ReportPeriod::resolve(kind, day(date), day(from), day(to), today, &tz)
        };
        let days = |period: Result<ReportPeriod, String>| {
            let period = period.unwrap();
            (
                period.from.to_string(),
                period.to.to_string(),
                period.file_name(ReportFormat::Markdown),
            )
        };
        let expect =
            |from: &str, to: &str, name: &str| (from.to_owned(), to.to_owned(), name.to_owned());

        assert_eq!(
            days(resolve(ReviewPeriodKind::Week, None, None, None)),
            expect(
                "2026-10-12",
                "2026-10-18",
                "toodo-review-2026-10-12-to-2026-10-18.md"
            )
        );
        assert_eq!(
            days(resolve(
                ReviewPeriodKind::Week,
                None,
                Some("2026-10-15"),
                None
            )),
            expect(
                "2026-10-15",
                "2026-10-21",
                "toodo-review-2026-10-15-to-2026-10-21.md"
            )
        );
        assert_eq!(
            days(resolve(
                ReviewPeriodKind::Month,
                Some("2026-02-10"),
                None,
                None
            )),
            expect("2026-02-01", "2026-02-28", "toodo-review-2026-02.md")
        );
        assert_eq!(
            days(resolve(
                ReviewPeriodKind::Quarter,
                Some("2026-12-31"),
                None,
                None
            )),
            expect("2026-10-01", "2026-12-31", "toodo-review-2026-Q4.md")
        );
        assert_eq!(
            days(resolve(ReviewPeriodKind::Year, None, None, None)),
            expect("2026-01-01", "2026-12-31", "toodo-review-2026.md")
        );
        assert_eq!(
            days(resolve(
                ReviewPeriodKind::Custom,
                None,
                Some("2026-10-01"),
                Some("2026-10-03")
            )),
            expect(
                "2026-10-01",
                "2026-10-03",
                "toodo-review-2026-10-01-to-2026-10-03.md"
            )
        );

        for (kind, date, from, to) in [
            (ReviewPeriodKind::Custom, None, Some("2026-10-01"), None),
            (
                ReviewPeriodKind::Custom,
                None,
                Some("2026-10-03"),
                Some("2026-10-01"),
            ),
            (ReviewPeriodKind::Custom, Some("2026-10-01"), None, None),
            (ReviewPeriodKind::Month, None, None, Some("2026-10-01")),
            (
                ReviewPeriodKind::Week,
                Some("2026-10-01"),
                Some("2026-10-01"),
                None,
            ),
        ] {
            assert!(
                resolve(kind, date, from, to).is_err(),
                "{kind:?} {date:?} {from:?} {to:?}"
            );
        }
    }

    #[test]
    fn a_period_runs_between_local_midnights_across_a_daylight_saving_change() {
        let berlin = TimeZone::posix("CET-1CEST,M3.5.0,M10.5.0/3").unwrap();
        let period = ReportPeriod::resolve(
            ReviewPeriodKind::Week,
            None,
            Some(date(2026, 10, 19)),
            None,
            date(2026, 10, 19),
            &berlin,
        )
        .unwrap();

        assert_eq!(period.start, local(2026, 10, 18, 22));
        assert_eq!(period.end, local(2026, 10, 25, 23));
    }

    #[test]
    fn leads_with_a_summary_then_lists_each_outcome_with_its_tasks_and_commits() {
        let mut done = entry(1, ReviewOutcome::Completed);
        done.task.title = "Add login".to_owned();
        done.task.refs.push(format!(
            "pr:{}",
            "https://github.com/acme/toodo/pull/3".to_owned()
        ));
        done.task.milestones.planned_at = Some(Timestamp(done.at.0 - 2 * DAY));
        done.task.milestones.completed_at = Some(done.at);
        done.commits = vec![CommitRecord {
            task_id: TaskId(1),
            sha: "0123456789abcdef".to_owned(),
            message: "Add login form\n\nWith validation.".to_owned(),
            author: "Ada <ada@example.com>".to_owned(),
            committed_at: done.at.0,
        }];
        let mut worked = entry(2, ReviewOutcome::WorkedOn);
        worked.task.task_type = TaskType::Fix;

        assert_eq!(
            markdown(&week(), &[worked, done]),
            [
                "# Week review: 2026-10-12 to 2026-10-18",
                "",
                "## Summary",
                "",
                "- Completed: 1, Worked on: 1",
                "- Commits: 1",
                "- Completed by type: feat 1",
                "- Completed by workspace: toodo 1",
                "- Median lead time (planned to completed): 2.0d (1 task)",
                "- Median cycle time (started to completed): no data",
                "- Median active time (started to completed, without pauses): no data",
                "- Median review time (awaiting completion to merged): no data",
                "",
                "## Completed (1)",
                "",
                "- [feat] Add login (toodo, 2026-10-13, https://github.com/acme/toodo/pull/3)",
                "  - `0123456` Add login form",
                "",
                "## Worked on (1)",
                "",
                "- [fix] Task 2 (toodo, 2026-10-13)",
                "",
            ]
            .join("\n")
        );
    }

    #[test]
    fn says_so_when_the_period_has_no_recorded_activity() {
        assert_eq!(
            markdown(&period(ReviewPeriodKind::Year, "2026-01-01"), &[]),
            "# Year review: 2026\n\nNo recorded activity.\n"
        );
    }

    #[test]
    fn adds_a_completed_per_month_table_for_a_period_over_several_months() {
        let markdown = markdown(
            &period(ReviewPeriodKind::Quarter, "2026-10-01"),
            &[completed(1, local(2026, 11, 3, 0))],
        );

        assert!(markdown.starts_with("# Quarter review: 2026 Q4\n"));
        assert!(markdown.contains(
            "| Month | Completed |\n| --- | --- |\n| 2026-10 | 0 |\n| 2026-11 | 1 |\n| 2026-12 | 0 |\n"
        ));
    }

    #[test]
    fn adds_pull_request_sizes_completion_notes_and_conclusions() {
        let at = local(2026, 10, 13, 15);
        let mut shipped = completed(1, at);
        shipped.pull_request = Some(snapshot(12));
        shipped.task.completion_note = Some("Sign-in is twice as fast\n  for everyone".to_owned());
        let mut small = completed(2, at);
        small.pull_request = Some(PullRequestSnapshot {
            changed_files: 1,
            review_count: 1,
            ..snapshot(13)
        });
        let mut research = completed(3, at);
        research.task.task_type = TaskType::Rnd;
        research.task.resolution = Some(TaskResolution::NotAdopted);
        research.task.refs.push(format!(
            "pr:{}",
            "https://github.com/acme/toodo/pull/5".to_owned()
        ));
        research.task.completion_note = Some("Twice as slow\nas the current cache".to_owned());

        let markdown = markdown(&week(), &[shipped, small, research]);

        assert!(markdown.contains("- Concluded without merging (not adopted): 1\n"));
        assert!(markdown.contains("- Completed by type: feat 2, rnd 1\n"));
        assert!(markdown.contains(
            "- Changes in completed pull requests: +240/-60 in 5 files (2 pull requests)\n"
        ));
        assert!(markdown.contains(
            "- [feat] Task 1 (toodo, 2026-10-13, #12, +120/-30 in 4 files, 2 reviews)\n  - Note: Sign-in is twice as fast for everyone\n"
        ));
        assert!(
            markdown.contains(
                "- [feat] Task 2 (toodo, 2026-10-13, #13, +120/-30 in 1 file, 1 review)\n"
            )
        );
        assert!(markdown.contains(
            "- [rnd] Task 3 (toodo, 2026-10-13, not adopted, https://github.com/acme/toodo/pull/5)\n  - Conclusion: Twice as slow as the current cache\n"
        ));
    }

    #[test]
    fn shows_active_against_waiting_time_and_each_wait_in_the_period_with_its_reason() {
        let mut waited = completed(1, local(2026, 10, 16, 12));
        let wait = |at, reason: Option<&str>| TaskEvent {
            reason: reason.map(str::to_owned),
            ..event(TaskStatus::Planned, at)
        };
        waited.task.timeline = vec![
            event(TaskStatus::Planned, local(2026, 10, 1, 0)),
            event(TaskStatus::InProgress, local(2026, 10, 2, 0)),
            wait(local(2026, 10, 2, 5), Some("Waiting on #2 API (planned)")),
            event(TaskStatus::InProgress, local(2026, 10, 11, 0)),
            wait(local(2026, 10, 13, 3), None),
            event(TaskStatus::InProgress, local(2026, 10, 15, 3)),
            event(TaskStatus::InReview, local(2026, 10, 16, 0)),
            event(TaskStatus::Done, local(2026, 10, 16, 12)),
        ];
        let mut paused = entry(3, ReviewOutcome::Started);
        paused.task.status = TaskStatus::Planned;
        paused.task.timeline = vec![
            event(TaskStatus::Planned, local(2026, 10, 12, 0)),
            event(TaskStatus::InProgress, local(2026, 10, 12, 1)),
            wait(local(2026, 12, 29, 0), Some("Waiting for the API design")),
        ];
        let mut never_started = entry(4, ReviewOutcome::Planned);
        never_started.task.timeline = vec![event(TaskStatus::Planned, local(2026, 10, 12, 0))];

        let text = markdown(&week(), &[waited, paused, never_started]);

        // 5h + 51h + 21h + 12h active, 211h + 48h waiting; the first wait ended before the
        // week, so it is only summed.
        assert!(text.contains(
            "- [feat] Task 1 (toodo, 2026-10-16)\n  - Time: 3.7d active, 10.8d waiting\n  - Waiting 2.0d from 2026-10-13: no reason recorded\n"
        ), "{text}");
        assert!(!text.contains("Waiting on #2"), "{text}");
        // A wait still under way counts until now and is in every period it overlaps.
        assert!(
            text.contains(
                "- [feat] Task 3 (toodo, 2026-10-13)\n  - Time: 78.0d active, 2.0d waiting\n"
            ),
            "{text}"
        );
        let task4 = text.split("Task 4").nth(1).unwrap();
        assert!(!task4.contains("Time:"), "{text}");

        let still_waiting = period(ReviewPeriodKind::Month, "2026-12-01");
        let mut paused = entry(3, ReviewOutcome::Started);
        paused.task.timeline = vec![
            event(TaskStatus::Planned, local(2026, 10, 12, 0)),
            event(TaskStatus::InProgress, local(2026, 10, 12, 1)),
            wait(local(2026, 12, 29, 0), Some("Waiting for the API design")),
        ];
        assert!(markdown(&still_waiting, &[paused]).contains(
            "  - Waiting 2.0d from 2026-12-29, still waiting: Waiting for the API design\n"
        ));
    }

    #[test]
    fn lists_the_notes_left_on_a_task_during_the_period() {
        let mut working = entry(1, ReviewOutcome::Started);
        let note = |kind, body: &str, at| TaskNote {
            kind,
            body: body.to_owned(),
            at: Timestamp(at),
        };
        working.task.notes = vec![
            note(
                NoteKind::Progress,
                "Planned last week",
                local(2026, 10, 11, 23),
            ),
            note(
                NoteKind::Progress,
                "Chose PKCE\nover implicit flow",
                local(2026, 10, 13, 9),
            ),
            note(
                NoteKind::Blocker,
                "No test account",
                local(2026, 10, 18, 23),
            ),
            note(NoteKind::Progress, "Next week", local(2026, 10, 19, 0)),
        ];

        let markdown = markdown(&week(), &[working]);

        assert!(markdown.contains(
            "- [feat] Task 1 (toodo, 2026-10-13)\n  - Progress: Chose PKCE over implicit flow\n  - Blocker: No test account\n"
        ));
        assert!(!markdown.contains("Planned last week"));
        assert!(!markdown.contains("Next week"));
    }

    #[test]
    fn adds_the_plan_to_the_summary_and_a_late_section() {
        let mut ship = completed(1, local(2026, 10, 15, 10));
        ship.task.title = "Ship".to_owned();
        ship.task.estimate = Some(Estimate {
            unit: EstimateUnit::Hours,
            amount: 4.0,
        });
        ship.task.due_date = Some("2026-10-14".to_owned());
        ship.task.timeline = vec![
            event(TaskStatus::InProgress, local(2026, 10, 15, 4)),
            event(TaskStatus::Done, local(2026, 10, 15, 10)),
        ];
        let mut open = entry(2, ReviewOutcome::Started);
        open.task.due_date = Some("2026-10-16".to_owned());

        let markdown = markdown(&week(), &[ship, open]);

        assert!(
            markdown
                .contains("- Estimate vs active time: 4h estimated, 6h active (1 task, 1.50x)\n")
        );
        assert!(markdown.contains("- Due dates met: 0 of 1 (0%)\n"));
        assert!(markdown.contains(
            "## Late (2)\n\n- [feat] Task 2 (due 2026-10-16, still open, 2.0d overdue)\n- [feat] Ship (due 2026-10-14, done 2026-10-15, 10h late)\n"
        ));
        assert!(
            markdown.contains("- [feat] Ship (toodo, 2026-10-15, estimate 4h, due 2026-10-14)")
        );
    }

    #[test]
    fn adds_a_year_in_review_section_to_a_year_only() {
        let at = local(2026, 5, 1, 12);
        let mut login = completed(1, at);
        login.task.title = "Add login".to_owned();
        login.pull_request = Some(PullRequestSnapshot {
            additions: 50,
            deletions: 10,
            changed_files: 2,
            ..snapshot(11)
        });
        let mut cache = completed(2, at);
        cache.task.task_type = TaskType::Rnd;
        cache.task.resolution = Some(TaskResolution::NotAdopted);
        cache.task.title = "Try a cache".to_owned();
        cache.task.completion_note = Some("Twice as slow\nas before".to_owned());
        let overran = |id, estimate: f64, active_hours: i64| {
            let mut entry = completed(id, at);
            entry.task.estimate = Some(Estimate {
                unit: EstimateUnit::Hours,
                amount: estimate,
            });
            entry.task.timeline = vec![
                event(TaskStatus::InProgress, at - active_hours * HOUR),
                event(TaskStatus::Done, at),
            ];
            entry
        };
        let entries = [
            login,
            cache,
            overran(3, 2.0, 3),
            overran(4, 1.0, 6),
            overran(5, 4.0, 2),
            overran(6, 1.0, 3),
            overran(7, 2.0, 4),
        ];

        let year = markdown(&period(ReviewPeriodKind::Year, "2026-06-01"), &entries);

        assert!(
            year.contains(
                &[
                    "## Year in review",
                    "",
                    "- Merged pull requests: +50/-10 in 2 files (1 pull request)",
                    "- Reviews: 2 reviews on 1 of 1 pull request",
                    "- Largest pull requests:",
                    "  - [feat] Add login (#11, +50/-10 in 2 files, 2 reviews)",
                    "- Research conclusions:",
                    "  - Try a cache (not adopted): Twice as slow as before",
                    "- Largest estimate overruns:",
                    "  - [feat] Task 4 (estimated 1h, 6h active)",
                    "  - [feat] Task 6 (estimated 1h, 3h active)",
                    "  - [feat] Task 7 (estimated 2h, 4h active)",
                    "",
                ]
                .join("\n")
            )
        );
        assert!(
            !markdown(&period(ReviewPeriodKind::Quarter, "2026-06-01"), &entries)
                .contains("Year in review")
        );
    }

    #[test]
    fn writes_one_csv_row_per_task_with_local_times_and_quotes_fields_that_need_it() {
        let at = local(2026, 10, 13, 15);
        let mut done = completed(7, at);
        done.task.milestones.planned_at = Some(Timestamp(local(2026, 10, 1, 9)));
        done.task.title = "Fix \"login\", then\nlogout".to_owned();
        done.task.refs.push(format!(
            "pr:{}",
            "https://github.com/acme/toodo/pull/3".to_owned()
        ));
        done.task.issue = Some(LinkedIssue {
            number: 12,
            url: "https://github.com/acme/toodo/issues/12".to_owned(),
        });
        done.pull_request = Some(snapshot(3));
        done.task.completion_note = Some("Cut login time\n  in half, finally".to_owned());
        done.task.resolution = Some(TaskResolution::NotAdopted);
        done.task.estimate = Some(Estimate {
            unit: EstimateUnit::Hours,
            amount: 2.0,
        });
        done.task.due_date = Some("2026-10-12".to_owned());
        done.task.timeline = vec![
            event(TaskStatus::Planned, local(2026, 10, 1, 9)),
            event(TaskStatus::InProgress, at - 3 * HOUR),
            event(TaskStatus::InReview, at - 2 * HOUR),
            event(TaskStatus::Done, at),
        ];
        let mut working = entry(8, ReviewOutcome::Planned);
        working.task.workspace_id = WorkspaceId(9);
        working.task.title = "Plan café".to_owned();
        working.task.timeline = vec![event(TaskStatus::InProgress, at - 1800)];
        // Two hours east of UTC: the times are local to the reader.
        let tz = TimeZone::fixed(jiff::tz::offset(2));
        let entries = [done, working];

        let csv = render(&week(), &entries, &tz, at).csv();

        assert_eq!(
            csv,
            "\u{feff}".to_owned()
                + &[
                    "Task,Workspace,Type,Title,Outcome,Outcome at,Resolution,Planned,Started,Awaiting completion,Completed,Merged,Pull request,Issue,Commits in period,Active hours,Waiting hours,Estimate,Estimate unit,Due date,Due status,Additions,Deletions,Changed files,Reviews,Completion note",
                    "7,toodo,feat,\"Fix \"\"login\"\", then\nlogout\",Completed,2026-10-13 17:00,Not adopted,2026-10-01 11:00,,,2026-10-13 17:00,,https://github.com/acme/toodo/pull/3,https://github.com/acme/toodo/issues/12,0,3,0,2,hours,2026-10-12,Late,120,30,4,2,\"Cut login time in half, finally\"",
                    "8,workspace 9,feat,Plan café,Planned,2026-10-13 17:00,,,,,,,,,0,0.5,0,,,,,,,,,",
                ]
                .join("\r\n")
                + "\r\n"
        );
    }

    #[test]
    fn formats_durations_as_hours_below_a_day_and_days_above() {
        assert_eq!(format_duration(1800.0), "<1h");
        assert_eq!(format_duration(5.0 * 3600.0), "5h");
        assert_eq!(format_duration(23.6 * 3600.0), "1.0d");
        assert_eq!(format_duration(30.0 * 3600.0), "1.3d");
    }
}
