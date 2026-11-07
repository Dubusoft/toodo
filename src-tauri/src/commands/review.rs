//! Commands for reviewing the work done in a period, such as a week or a year.

use std::collections::{HashMap, HashSet};

use jiff::civil::Date;
use jiff::tz::TimeZone;

use super::State;

use super::report::{Report, ReportPeriod};
use super::types::{
    ReportFormat, ReviewEntry, ReviewPeriodEntries, ReviewPeriodKind, ReviewReport,
    ReviewReportRequest, ReviewSnapshot, ReviewSnapshotId, ReviewSnapshotSummary, ReviewTimeZone,
    ReviewWorkspaceName, SaveReviewSnapshotRequest, Task, Timestamp, WorkspaceId,
};
use super::{CommandError, CommandResult, StorageState, lock};
use crate::domain::review::{self, Period};
use crate::storage::{self, Storage, StorageError};

/// Tasks of every workspace that reached a milestone or got a commit from midnight of the
/// day `from` to midnight after the day `to` (both `YYYY-MM-DD`) in the review time zone
/// of the server, archived ones included, ordered by outcome, then by time. The caller
/// picks the days, such as those of a week, a month, or a year.
#[specta::specta]
pub fn review_period(
    storage: State<'_, StorageState>,
    from: String,
    to: String,
) -> CommandResult<ReviewPeriodEntries> {
    let storage = lock(&storage);
    let (time_zone, time_zone_name) = effective_time_zone(&storage)?;
    let period = days(&from, &to, &time_zone)?;
    Ok(ReviewPeriodEntries {
        from: period.from.to_string(),
        to: period.to.to_string(),
        start: Timestamp(period.start),
        end: Timestamp(period.end),
        time_zone: time_zone_name,
        entries: review_entries(&storage, Timestamp(period.start), Timestamp(period.end))?,
    })
}

/// The time zone reviewed periods are judged in.
#[specta::specta]
pub fn get_review_time_zone(storage: State<'_, StorageState>) -> CommandResult<ReviewTimeZone> {
    review_time_zone(&lock(&storage))
}

/// Sets the IANA time zone (e.g. `Europe/Berlin`) reviewed periods are judged in, on
/// every device and for MCP and `toodo review`; `null` or blank goes back to the
/// server's own.
#[specta::specta]
pub fn set_review_time_zone(
    storage: State<'_, StorageState>,
    time_zone: Option<String>,
) -> CommandResult<ReviewTimeZone> {
    let mut storage = lock(&storage);
    let name = match time_zone.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(name) => {
            let zone = TimeZone::get(name).map_err(|_| unknown_time_zone(name))?;
            Some(zone.iana_name().unwrap_or(name).to_owned())
        }
    };
    storage.set_review_time_zone(name.as_deref())?;
    review_time_zone(&storage)
}

fn review_time_zone(storage: &Storage) -> CommandResult<ReviewTimeZone> {
    Ok(ReviewTimeZone {
        time_zone: effective_time_zone(storage)?.1,
        configured: storage.review_time_zone()?,
    })
}

/// The time zone reviews are judged in, with its IANA name: the one set, else the
/// server's own, else UTC when the server's has no IANA name to record.
fn effective_time_zone(storage: &Storage) -> CommandResult<(TimeZone, String)> {
    if let Some(name) = storage.review_time_zone()? {
        let zone = TimeZone::get(&name).map_err(|_| {
            CommandError::internal(format!(
                "the review time zone {name:?} saved on the server is unknown to it; set \
                 another one under Settings, Review, or with set_review_time_zone"
            ))
        })?;
        return Ok((zone, name));
    }
    let system = TimeZone::system();
    Ok(match system.iana_name().map(str::to_owned) {
        Some(name) => (system, name),
        None => (TimeZone::UTC, "UTC".to_owned()),
    })
}

fn unknown_time_zone(name: &str) -> CommandError {
    CommandError::invalid_input(format!(
        "unknown time zone {name:?}; pass an IANA time zone name such as Europe/Berlin or \
         America/New_York, or leave it out to use the server's"
    ))
}

fn parse_day(field: &str, value: &str) -> CommandResult<Date> {
    value.trim().parse::<Date>().map_err(|_| {
        CommandError::invalid_input(format!(
            "{field} {value:?} is not a day; pass it as YYYY-MM-DD, e.g. 2026-10-12"
        ))
    })
}

/// The days `from` to `to`, both included, in `time_zone`.
fn days(from: &str, to: &str, time_zone: &TimeZone) -> CommandResult<ReportPeriod> {
    let first = parse_day("from", from)?;
    ReportPeriod::resolve(
        ReviewPeriodKind::Custom,
        None,
        Some(first),
        Some(parse_day("to", to)?),
        first,
        time_zone,
    )
    .map_err(CommandError::invalid_input)
}

/// The review of a period rendered as Markdown or CSV, as the web app, the MCP tool
/// `review_report`, and `toodo review` show it; see [`ReviewReportRequest`].
#[specta::specta]
pub fn review_report(
    storage: State<'_, StorageState>,
    request: ReviewReportRequest,
) -> CommandResult<ReviewReport> {
    render_report(&lock(&storage), request)
}

pub(crate) fn render_report(
    storage: &Storage,
    request: ReviewReportRequest,
) -> CommandResult<ReviewReport> {
    Ok(reviewed(storage, &request)?.render(request.format))
}

/// A reviewed period with what its report is rendered from.
struct Reviewed {
    period: ReportPeriod,
    entries: Vec<ReviewEntry>,
    workspace_names: HashMap<i64, String>,
    time_zone: TimeZone,
    time_zone_name: String,
    label: Option<String>,
    now: i64,
}

impl Reviewed {
    fn render(&self, format: ReportFormat) -> ReviewReport {
        let report = Report {
            period: &self.period,
            entries: &self.entries,
            workspace_names: &self.workspace_names,
            time_zone: &self.time_zone,
            now: self.now,
        };
        let contents = match format {
            ReportFormat::Markdown => report.markdown(),
            ReportFormat::Csv => report.csv(),
        };
        rendered(&self.period, format, contents)
    }
}

fn rendered(period: &ReportPeriod, format: ReportFormat, contents: String) -> ReviewReport {
    let media_type = match format {
        ReportFormat::Markdown => "text/markdown",
        ReportFormat::Csv => "text/csv",
    };
    ReviewReport {
        file_name: period.file_name(format),
        media_type: media_type.to_owned(),
        from: period.from.to_string(),
        to: period.to.to_string(),
        contents,
    }
}

/// The period `request` names, in its time zone or else the review time zone, and the
/// tasks reviewed in it that pass its filters.
fn reviewed(storage: &Storage, request: &ReviewReportRequest) -> CommandResult<Reviewed> {
    let (time_zone, time_zone_name) = match request.time_zone.as_deref().map(str::trim) {
        None | Some("") => effective_time_zone(storage)?,
        Some(name) => (
            TimeZone::get(name).map_err(|_| unknown_time_zone(name))?,
            name.to_owned(),
        ),
    };
    let day = |field: &str, value: &Option<String>| -> CommandResult<Option<Date>> {
        value
            .as_deref()
            .map(|value| parse_day(field, value))
            .transpose()
    };
    let now = storage.now();
    let today = jiff::Timestamp::from_second(now)
        .map_err(|error| CommandError::internal(format!("the server clock is off: {error}")))?
        .to_zoned(time_zone.clone())
        .date();
    let period = ReportPeriod::resolve(
        request.period,
        day("date", &request.date)?,
        day("from", &request.from)?,
        day("to", &request.to)?,
        today,
        &time_zone,
    )
    .map_err(CommandError::invalid_input)?;
    // Reviews keep the work of deleted workspaces, so they are named and filtered too.
    let mut workspaces = storage.list_workspaces()?;
    workspaces.extend(storage.archived_workspaces()?);
    if let Some(id) = request.workspace_id
        && !workspaces.iter().any(|workspace| workspace.id == id.into())
    {
        return Err(StorageError::WorkspaceNotFound(id.into()).into());
    }
    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(str::to_owned);
    let entries: Vec<ReviewEntry> =
        review_entries(storage, Timestamp(period.start), Timestamp(period.end))?
            .into_iter()
            .filter(|entry| {
                request
                    .workspace_id
                    .is_none_or(|id| entry.task.workspace_id == id)
                    && label
                        .as_deref()
                        .is_none_or(|label| entry.task.labels.iter().any(|l| l == label))
            })
            .collect();
    let workspace_names: HashMap<i64, String> = workspaces
        .into_iter()
        .map(|workspace| (workspace.id.0, workspace.name))
        .collect();
    Ok(Reviewed {
        period,
        entries,
        workspace_names,
        time_zone,
        time_zone_name,
        label,
        now,
    })
}

/// Saves the review of a period as it is now: its tasks, the names of their workspaces,
/// and its report as Markdown and CSV, judged in the review time zone. Reopening it
/// later shows the same, however the tasks change afterwards.
#[specta::specta]
pub fn save_review_snapshot(
    storage: State<'_, StorageState>,
    request: SaveReviewSnapshotRequest,
) -> CommandResult<ReviewSnapshotSummary> {
    let mut storage = lock(&storage);
    let reviewed = reviewed(
        &storage,
        &ReviewReportRequest {
            period: request.period,
            date: None,
            from: Some(request.from),
            to: request.to,
            format: ReportFormat::Markdown,
            time_zone: None,
            workspace_id: request.workspace_id,
            label: request.label,
        },
    )?;
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map_or_else(|| reviewed.period.name(), str::to_owned);
    let mut workspaces: Vec<ReviewWorkspaceName> = reviewed
        .workspace_names
        .iter()
        .filter(|(id, _)| {
            request.workspace_id.is_some_and(|wanted| wanted.0 == **id)
                || reviewed
                    .entries
                    .iter()
                    .any(|entry| entry.task.workspace_id.0 == **id)
        })
        .map(|(id, name)| ReviewWorkspaceName {
            id: WorkspaceId(*id),
            name: name.clone(),
        })
        .collect();
    workspaces.sort_by_key(|workspace| workspace.id.0);
    let unsaved = |error: serde_json::Error| {
        CommandError::internal(format!("cannot save the review: {error}"))
    };
    let snapshot = storage::ReviewSnapshot {
        info: storage::ReviewSnapshotInfo {
            id: 0,
            title,
            period: period_name(reviewed.period.kind),
            from: reviewed.period.from.to_string(),
            to: reviewed.period.to.to_string(),
            time_zone: reviewed.time_zone_name.clone(),
            workspace_id: request.workspace_id.map(|id| id.0),
            label: reviewed.label.clone(),
            start_at: reviewed.period.start,
            end_at: reviewed.period.end,
            created_at: reviewed.now,
            entry_count: reviewed.entries.len() as i64,
        },
        entries: serde_json::to_string(&reviewed.entries).map_err(unsaved)?,
        workspaces: serde_json::to_string(&workspaces).map_err(unsaved)?,
        markdown: reviewed.render(ReportFormat::Markdown).contents,
        csv: reviewed.render(ReportFormat::Csv).contents,
    };
    snapshot_summary(&storage.save_review_snapshot(&snapshot)?)
}

/// The saved reviews, the most recently saved first.
#[specta::specta]
pub fn list_review_snapshots(
    storage: State<'_, StorageState>,
) -> CommandResult<Vec<ReviewSnapshotSummary>> {
    lock(&storage)
        .list_review_snapshots()?
        .iter()
        .map(snapshot_summary)
        .collect()
}

/// The saved review `id` exactly as it was saved.
#[specta::specta]
pub fn get_review_snapshot(
    storage: State<'_, StorageState>,
    id: ReviewSnapshotId,
) -> CommandResult<ReviewSnapshot> {
    let snapshot = lock(&storage)
        .review_snapshot(id.0)?
        .ok_or_else(|| missing_snapshot(id))?;
    let summary = snapshot_summary(&snapshot.info)?;
    let damaged = |what: &str| {
        CommandError::internal(format!(
            "the {what} of saved review {} are damaged; delete it with \
             delete_review_snapshot and save the review again",
            id.0
        ))
    };
    let entries = serde_json::from_str(&snapshot.entries).map_err(|_| damaged("tasks"))?;
    let workspaces =
        serde_json::from_str(&snapshot.workspaces).map_err(|_| damaged("workspace names"))?;
    let period = ReportPeriod {
        kind: summary.period,
        from: parse_day("from", &summary.from).map_err(|_| damaged("days"))?,
        to: parse_day("to", &summary.to).map_err(|_| damaged("days"))?,
        start: summary.start.0,
        end: summary.end.0,
    };
    Ok(ReviewSnapshot {
        markdown: rendered(&period, ReportFormat::Markdown, snapshot.markdown),
        csv: rendered(&period, ReportFormat::Csv, snapshot.csv),
        summary,
        entries,
        workspaces,
    })
}

/// Deletes the saved review `id`.
#[specta::specta]
pub fn delete_review_snapshot(
    storage: State<'_, StorageState>,
    id: ReviewSnapshotId,
) -> CommandResult<()> {
    if lock(&storage).delete_review_snapshot(id.0)? {
        Ok(())
    } else {
        Err(missing_snapshot(id))
    }
}

fn missing_snapshot(id: ReviewSnapshotId) -> CommandError {
    CommandError::not_found(format!(
        "there is no saved review {}; list the saved reviews with list_review_snapshots and \
         pass one of their ids",
        id.0
    ))
}

fn period_name(kind: ReviewPeriodKind) -> String {
    match kind {
        ReviewPeriodKind::Week => "week",
        ReviewPeriodKind::Month => "month",
        ReviewPeriodKind::Quarter => "quarter",
        ReviewPeriodKind::Year => "year",
        ReviewPeriodKind::Custom => "custom",
    }
    .to_owned()
}

fn snapshot_summary(info: &storage::ReviewSnapshotInfo) -> CommandResult<ReviewSnapshotSummary> {
    let period = match info.period.as_str() {
        "week" => ReviewPeriodKind::Week,
        "month" => ReviewPeriodKind::Month,
        "quarter" => ReviewPeriodKind::Quarter,
        "year" => ReviewPeriodKind::Year,
        "custom" => ReviewPeriodKind::Custom,
        other => {
            return Err(CommandError::internal(format!(
                "saved review {} has an unknown kind of period {other:?}; delete it with \
                 delete_review_snapshot and save the review again",
                info.id
            )));
        }
    };
    Ok(ReviewSnapshotSummary {
        id: ReviewSnapshotId(info.id),
        title: info.title.clone(),
        period,
        from: info.from.clone(),
        to: info.to.clone(),
        time_zone: info.time_zone.clone(),
        workspace_id: info.workspace_id.map(WorkspaceId),
        label: info.label.clone(),
        start: Timestamp(info.start_at),
        end: Timestamp(info.end_at),
        saved_at: Timestamp(info.created_at),
        entry_count: info.entry_count,
    })
}

fn review_entries(
    storage: &Storage,
    start: Timestamp,
    end: Timestamp,
) -> CommandResult<Vec<ReviewEntry>> {
    let period = Period::new(start.0, end.0)
        .map_err(|error| CommandError::invalid_input(error.to_string()))?;
    let tasks = storage.review_tasks()?;
    let live: HashSet<_> = storage
        .list_all_tasks()?
        .into_iter()
        .map(|task| task.id)
        .collect();
    let commits = storage.list_commit_records_in(period)?;
    review::review(period, &tasks, &commits)
        .into_iter()
        .map(|reviewed| {
            let task = tasks
                .iter()
                .find(|task| task.id == reviewed.task_id)
                .expect("a review entry belongs to a reviewed task");
            Ok(ReviewEntry {
                pull_request: storage
                    .historical_pull_request(task.id)?
                    .as_ref()
                    .map(Into::into),
                task: Task::from(task),
                outcome: reviewed.outcome.into(),
                at: Timestamp(reviewed.at),
                commits: reviewed.commits.iter().map(Into::into).collect(),
                archived: !live.contains(&task.id),
            })
        })
        .collect::<CommandResult<Vec<_>>>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::CommandErrorKind;
    use crate::commands::types::ReviewOutcome;
    use crate::domain::model::{CommitRecord, TaskType};
    use crate::domain::status::TaskStatus;
    use crate::storage::{NewTask, NewWorkspace};

    #[test]
    fn reviews_tasks_of_every_workspace_and_rejects_an_empty_period() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 500);
        let mut add_task = |name: &str| {
            let workspace = storage
                .create_workspace(&NewWorkspace {
                    name: name.to_owned(),
                    description: None,
                    repository: None,
                })
                .unwrap();
            storage
                .create_task(&NewTask {
                    workspace_id: workspace.id,
                    task_type: TaskType::Feat,
                    title: format!("Work on {name}"),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: Vec::new(),
                })
                .unwrap()
        };
        let started = add_task("toodo");
        let committed = add_task("herdr");
        storage
            .set_task_status(started.id, TaskStatus::InProgress)
            .unwrap();
        let record = CommitRecord {
            task_id: committed.id,
            sha: "abc".to_owned(),
            message: "Add herdr".to_owned(),
            author: "Dev <dev@example.com>".to_owned(),
            committed_at: 1500,
        };
        storage
            .seed_commit_records(committed.id, std::slice::from_ref(&record))
            .unwrap();

        let entries = review_entries(&storage, Timestamp(1000), Timestamp(2000)).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.task.title.as_str(), entry.outcome, entry.at.0))
            .collect();
        assert_eq!(summary, [("Work on herdr", ReviewOutcome::WorkedOn, 1500)]);
        assert_eq!(entries[0].commits, [(&record).into()]);

        let entries = review_entries(&storage, Timestamp(0), Timestamp(1000)).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.task.title.as_str(), entry.outcome))
            .collect();
        assert_eq!(
            summary,
            [
                ("Work on toodo", ReviewOutcome::Started),
                ("Work on herdr", ReviewOutcome::Planned),
            ]
        );

        // Deleting archives the task; its work still counts and is marked archived.
        storage.archive_task(committed.id).unwrap();
        let entries = review_entries(&storage, Timestamp(1000), Timestamp(2000)).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.task.title.as_str(), entry.archived))
            .collect();
        assert_eq!(summary, [("Work on herdr", true)]);
        storage.purge_task(committed.id).unwrap();
        assert!(
            review_entries(&storage, Timestamp(1000), Timestamp(2000))
                .unwrap()
                .is_empty()
        );

        let error = review_entries(&storage, Timestamp(10), Timestamp(10)).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }

    fn second(at: &str) -> i64 {
        at.parse::<jiff::Timestamp>().unwrap().as_second()
    }

    fn storage_with_task() -> (std::sync::Mutex<Storage>, crate::domain::model::TaskId) {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                description: None,
                repository: None,
            })
            .unwrap();
        let task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: "Add storage".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap();
        (std::sync::Mutex::new(storage), task.id)
    }

    #[test]
    fn the_review_time_zone_of_the_server_decides_where_a_period_starts_and_ends() {
        let (storage, _) = storage_with_task();
        let week = |storage: &std::sync::Mutex<Storage>| {
            let entries = review_period(
                State(storage),
                "2026-11-02".to_owned(),
                "2026-11-08".to_owned(),
            )
            .unwrap();
            (entries.time_zone, entries.start.0, entries.end.0)
        };

        let seoul = set_review_time_zone(State(&storage), Some(" Asia/Seoul ".to_owned())).unwrap();
        assert_eq!(
            seoul,
            ReviewTimeZone {
                time_zone: "Asia/Seoul".to_owned(),
                configured: Some("Asia/Seoul".to_owned()),
            }
        );
        assert_eq!(
            week(&storage),
            (
                "Asia/Seoul".to_owned(),
                second("2026-11-01T15:00:00Z"),
                second("2026-11-08T15:00:00Z")
            )
        );

        set_review_time_zone(State(&storage), Some("Europe/Berlin".to_owned())).unwrap();
        assert_eq!(
            week(&storage),
            (
                "Europe/Berlin".to_owned(),
                second("2026-11-01T23:00:00Z"),
                second("2026-11-08T23:00:00Z")
            )
        );
        let report = render_report(
            &lock(&storage),
            ReviewReportRequest {
                period: ReviewPeriodKind::Week,
                date: Some("2026-11-04".to_owned()),
                from: None,
                to: None,
                format: ReportFormat::Csv,
                time_zone: None,
                workspace_id: None,
                label: None,
            },
        )
        .unwrap();
        assert_eq!(
            (report.from.as_str(), report.to.as_str()),
            ("2026-11-02", "2026-11-08")
        );

        let error =
            set_review_time_zone(State(&storage), Some("Mars/Olympus".to_owned())).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        assert!(error.message.contains("Europe/Berlin"));
        assert_eq!(
            get_review_time_zone(State(&storage))
                .unwrap()
                .configured
                .as_deref(),
            Some("Europe/Berlin")
        );

        let server = set_review_time_zone(State(&storage), Some("  ".to_owned())).unwrap();
        assert_eq!(server.configured, None);
        assert_eq!(week(&storage).0, server.time_zone);
    }

    #[test]
    fn a_saved_review_reads_back_unchanged_after_its_task_is_reopened() {
        let (storage, id) = storage_with_task();
        set_review_time_zone(State(&storage), Some("UTC".to_owned())).unwrap();
        let at = |storage: &std::sync::Mutex<Storage>, time: &str| {
            let now = second(time);
            lock(storage).set_clock(move || now);
        };
        at(&storage, "2026-11-03T09:00:00Z");
        lock(&storage)
            .set_task_status(id, TaskStatus::InProgress)
            .unwrap();
        at(&storage, "2026-11-04T09:00:00Z");
        lock(&storage)
            .complete_task(id, Some("Shipped behind a flag"), &[])
            .unwrap();
        at(&storage, "2026-11-05T09:00:00Z");
        let saved = save_review_snapshot(
            State(&storage),
            SaveReviewSnapshotRequest {
                period: ReviewPeriodKind::Week,
                from: "2026-11-02".to_owned(),
                to: None,
                workspace_id: None,
                label: None,
                title: None,
            },
        )
        .unwrap();
        assert_eq!(saved.title, "Week review 2026-11-02 to 2026-11-08");
        assert_eq!((saved.entry_count, saved.time_zone.as_str()), (1, "UTC"));
        let live = || {
            review_period(
                State(&storage),
                "2026-11-02".to_owned(),
                "2026-11-08".to_owned(),
            )
            .unwrap()
            .entries
        };
        let before = live();
        let report = |format| {
            render_report(
                &lock(&storage),
                ReviewReportRequest {
                    period: ReviewPeriodKind::Week,
                    date: None,
                    from: Some("2026-11-02".to_owned()),
                    to: None,
                    format,
                    time_zone: None,
                    workspace_id: None,
                    label: None,
                },
            )
            .unwrap()
        };
        let (markdown, csv) = (report(ReportFormat::Markdown), report(ReportFormat::Csv));

        at(&storage, "2026-11-06T09:00:00Z");
        lock(&storage)
            .reopen_task(id, "Flag broke checkout", "Reopened to fix checkout")
            .unwrap();
        let after = live();
        assert_ne!(after, before, "reopening changes the live review");
        assert_ne!(after[0].outcome, ReviewOutcome::Completed);

        let reopened = get_review_snapshot(State(&storage), saved.id).unwrap();
        assert_eq!(reopened.summary, saved);
        assert_eq!(reopened.entries, serde_json::to_value(&before).unwrap());
        assert_eq!(reopened.markdown, markdown);
        assert_eq!(reopened.csv, csv);
        assert_eq!(
            reopened.workspaces,
            [ReviewWorkspaceName {
                id: WorkspaceId(1),
                name: "toodo".to_owned(),
            }]
        );
        assert_eq!(
            list_review_snapshots(State(&storage)).unwrap(),
            std::slice::from_ref(&saved)
        );

        delete_review_snapshot(State(&storage), saved.id).unwrap();
        let missing = get_review_snapshot(State(&storage), saved.id).unwrap_err();
        assert_eq!(missing.kind, CommandErrorKind::NotFound);
        assert!(missing.message.contains("list_review_snapshots"));
    }
}
