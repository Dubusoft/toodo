use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::WorkspaceId;

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
    /// in the report are in; the server's time zone when omitted.
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
