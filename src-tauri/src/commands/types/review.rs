use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use super::{ReviewEntry, Timestamp, WorkspaceId};

/// The kind of a reviewed period.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPeriodKind {
    /// Seven days, from a Monday unless `from` names another first day.
    Week,
    /// A calendar month.
    Month,
    /// A calendar quarter.
    Quarter,
    /// A calendar year.
    Year,
    /// The days `from` to `to`, both included.
    Custom,
}

/// The file format of a review report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReportFormat {
    /// Markdown, for pasting into a status update or a year-end report.
    Markdown,
    /// One row per reviewed task (RFC 4180, CRLF line ends, led by a UTF-8 byte order
    /// mark), for spreadsheets.
    Csv,
}

/// Which review report to render. Days are `YYYY-MM-DD` in `timeZone`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewReportRequest {
    pub period: ReviewPeriodKind,
    /// A day inside the period, for any kind but `custom`; today when neither `date` nor
    /// `from` is given.
    #[serde(default)]
    pub date: Option<String>,
    /// The first day of the period: required for `custom`, any first day of a `week`, and
    /// a day inside a month, quarter, or year.
    #[serde(default)]
    pub from: Option<String>,
    /// The last day of a `custom` period, included.
    #[serde(default)]
    pub to: Option<String>,
    pub format: ReportFormat,
    /// An IANA time zone such as `Europe/Berlin` that the days, the period, and the times
    /// in the report are in; the review time zone of the server when omitted (see
    /// [`ReviewTimeZone`]).
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Only tasks of this workspace.
    #[serde(default)]
    pub workspace_id: Option<WorkspaceId>,
    /// Only tasks with this label.
    #[serde(default)]
    pub label: Option<String>,
}

/// A rendered review report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReport {
    /// A file name for the report, e.g. `toodo-review-2026-Q4.md`.
    pub file_name: String,
    /// `text/markdown` or `text/csv`.
    pub media_type: String,
    /// The first and last day of the reviewed period, as `YYYY-MM-DD`.
    pub from: String,
    pub to: String,
    pub contents: String,
}

/// The time zone the server judges reviewed periods in, so a period covers the same
/// time on every device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTimeZone {
    /// The IANA time zone in use: the one set, else the server's own (`UTC` when the
    /// server's has no IANA name).
    pub time_zone: String,
    /// The time zone set for reviews; `null` while the server's own is used.
    pub configured: Option<String>,
}

/// The reviewed tasks of the days `from` to `to`, with the period the server judged
/// them by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPeriodEntries {
    /// The first and last day, as `YYYY-MM-DD` in `timeZone`.
    pub from: String,
    pub to: String,
    /// The period as `[start, end)`: midnight of `from` to midnight after `to` in
    /// `timeZone`.
    pub start: Timestamp,
    pub end: Timestamp,
    pub time_zone: String,
    pub entries: Vec<ReviewEntry>,
}

/// Which review to save as a snapshot: a period as for [`ReviewReportRequest`] (judged in
/// the review time zone of the server) and the tasks to keep.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveReviewSnapshotRequest {
    pub period: ReviewPeriodKind,
    /// The first day of a week or custom period, or a day inside a month, quarter, or
    /// year, as `YYYY-MM-DD`.
    pub from: String,
    /// The last day of a `custom` period, included.
    #[serde(default)]
    pub to: Option<String>,
    /// Only tasks of this workspace.
    #[serde(default)]
    pub workspace_id: Option<WorkspaceId>,
    /// Only tasks with this label.
    #[serde(default)]
    pub label: Option<String>,
    /// A name for the snapshot; the period's, e.g. `Year review 2026`, when omitted.
    #[serde(default)]
    pub title: Option<String>,
}

/// The ID of a saved review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct ReviewSnapshotId(#[specta(type = Number)] pub i64);

/// A saved review, without its contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshotSummary {
    pub id: ReviewSnapshotId,
    pub title: String,
    pub period: ReviewPeriodKind,
    /// The first and last day, as `YYYY-MM-DD` in `timeZone`.
    pub from: String,
    pub to: String,
    pub time_zone: String,
    pub workspace_id: Option<WorkspaceId>,
    pub label: Option<String>,
    /// The period as `[start, end)`.
    pub start: Timestamp,
    pub end: Timestamp,
    /// When it was saved; durations and due dates in it are judged at this time.
    pub saved_at: Timestamp,
    #[specta(type = Number)]
    pub entry_count: i64,
}

/// The name of a workspace as a saved review shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkspaceName {
    pub id: WorkspaceId,
    pub name: String,
}

/// A saved review as it was when saved: its reviewed tasks, the names of their
/// workspaces, and its report as Markdown and CSV.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshot {
    pub summary: ReviewSnapshotSummary,
    /// Kept as the JSON it was saved as, so later changes to tasks do not touch it.
    #[specta(type = Vec<ReviewEntry>)]
    pub entries: serde_json::Value,
    pub workspaces: Vec<ReviewWorkspaceName>,
    /// The report as `review_report` rendered it when saved.
    pub markdown: ReviewReport,
    pub csv: ReviewReport,
}
