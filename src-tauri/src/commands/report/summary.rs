//! The summary and year-in-review sections of the Markdown report.

use crate::commands::types::{
    PullRequestSnapshot, ReviewEntry, ReviewOutcome, Task, TaskResolution, TaskType,
};

use super::{
    Changes, DueState, Report, active_seconds, count_by, fixed, format_duration, format_stat,
    median, non_empty, one_line, outcome_label, plural, pull_request_stats, type_name,
};

impl Report<'_> {
    pub(super) fn summary_lines(
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
    pub(super) fn year_in_review_lines(&self, lines: &mut Vec<String>) {
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
}
