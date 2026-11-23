use jiff::civil::date;

use super::*;
use crate::commands::types::{
    CommitRecord, LinkedIssue, ReportFormat, TaskId, TaskMilestones, TaskNote, Timestamp,
    WorkspaceId,
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
    assert!(
        markdown.contains(
            "- Changes in completed pull requests: +240/-60 in 5 files (2 pull requests)\n"
        )
    );
    assert!(markdown.contains(
        "- [feat] Task 1 (toodo, 2026-10-13, #12, +120/-30 in 4 files, 2 reviews)\n  - Note: Sign-in is twice as fast for everyone\n"
    ));
    assert!(
        markdown
            .contains("- [feat] Task 2 (toodo, 2026-10-13, #13, +120/-30 in 1 file, 1 review)\n")
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
    assert!(
        markdown(&still_waiting, &[paused]).contains(
            "  - Waiting 2.0d from 2026-12-29, still waiting: Waiting for the API design\n"
        )
    );
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
        markdown.contains("- Estimate vs active time: 4h estimated, 6h active (1 task, 1.50x)\n")
    );
    assert!(markdown.contains("- Due dates met: 0 of 1 (0%)\n"));
    assert!(markdown.contains(
        "## Late (2)\n\n- [feat] Task 2 (due 2026-10-16, still open, 2.0d overdue)\n- [feat] Ship (due 2026-10-14, done 2026-10-15, 10h late)\n"
    ));
    assert!(markdown.contains("- [feat] Ship (toodo, 2026-10-15, estimate 4h, due 2026-10-14)"));
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
fn writes_one_csv_row_per_task_with_local_times_quoted_fields_and_formulas_kept_as_text() {
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
    let mut link = entry(9, ReviewOutcome::Planned);
    link.task.title = "=HYPERLINK(\"https://evil.example\",\"Open\")".to_owned();
    link.task.completion_note = Some("@SUM(1+1)".to_owned());
    link.task.estimate = Some(Estimate {
        unit: EstimateUnit::Days,
        amount: -1.5,
    });
    working.task.timeline = vec![event(TaskStatus::InProgress, at - 1800)];
    // Two hours east of UTC: the times are local to the reader.
    let tz = TimeZone::fixed(jiff::tz::offset(2));
    let entries = [done, working, link];

    let csv = render(&week(), &entries, &tz, at).csv();

    assert_eq!(
        csv,
        "\u{feff}".to_owned()
            + &[
                "Task,Workspace,Type,Title,Outcome,Outcome at,Resolution,Planned,Started,Awaiting completion,Completed,Merged,Pull request,Issue,Commits in period,Active hours,Waiting hours,Estimate,Estimate unit,Due date,Due status,Additions,Deletions,Changed files,Reviews,Completion note",
                "7,toodo,feat,\"Fix \"\"login\"\", then\nlogout\",Completed,2026-10-13 17:00,Not adopted,2026-10-01 11:00,,,2026-10-13 17:00,,https://github.com/acme/toodo/pull/3,https://github.com/acme/toodo/issues/12,0,3,0,2,hours,2026-10-12,Late,120,30,4,2,\"Cut login time in half, finally\"",
                "8,workspace 9,feat,Plan café,Planned,2026-10-13 17:00,,,,,,,,,0,0.5,0,,,,,,,,,",
                "9,toodo,feat,\"'=HYPERLINK(\"\"https://evil.example\"\",\"\"Open\"\")\",Planned,2026-10-13 17:00,,,,,,,,,0,,,-1.5,days,,,,,,,'@SUM(1+1)",
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
