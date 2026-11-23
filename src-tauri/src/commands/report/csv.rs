//! The CSV report, one row per reviewed task.

use std::borrow::Cow;

use crate::commands::types::{EstimateUnit, ReviewEntry};

use super::{
    DueState, Report, active_seconds, one_line, outcome_label, resolution_label, type_name,
    waiting_seconds,
};

impl Report<'_> {
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
        let time =
            |at: Option<crate::commands::types::Timestamp>| at.map(|at| self.date_time(at.0));
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

/// Spreadsheet apps evaluate a cell that starts with one of these as a formula.
const CSV_FORMULA_STARTS: [char; 6] = ['=', '+', '-', '@', '\t', '\r'];

/// A text cell an app would evaluate as a formula gets a leading `'`, so titles and
/// notes written by agents stay text. Numbers, negative ones included, stay as they are.
fn neutralize_csv_formula(field: &str) -> Cow<'_, str> {
    let number = field.parse::<f64>().is_ok()
        && field
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b'.'));
    if field.starts_with(CSV_FORMULA_STARTS) && !number {
        Cow::Owned(format!("'{field}"))
    } else {
        Cow::Borrowed(field)
    }
}

fn push_csv_row(text: &mut String, fields: &[Option<String>]) {
    let row: Vec<String> = fields
        .iter()
        .map(|field| {
            let field = neutralize_csv_formula(field.as_deref().unwrap_or_default());
            if field.contains(['"', ',', '\r', '\n']) {
                format!("\"{}\"", field.replace('"', "\"\""))
            } else {
                field.into_owned()
            }
        })
        .collect();
    text.push_str(&row.join(","));
    text.push_str("\r\n");
}
