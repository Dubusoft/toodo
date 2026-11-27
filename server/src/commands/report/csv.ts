// The CSV report, one row per reviewed task.

import { displayFloat } from "../../domain/rust.ts";
import type { ReviewEntry } from "../../../../src/lib/api.ts";
import { activeSeconds, oneLine, outcomeLabel, resolutionLabel, round, typeName, waitingSeconds } from "./format.ts";
import type { DueState, Report } from "./report.ts";

const CSV_COLUMNS = [
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

const DUE_STATUS: Record<DueState, string> = {
  on_time: "On time",
  late: "Late",
  overdue: "Overdue",
  upcoming: "Not due yet",
};

/** Seconds as hours with one decimal, for CSV cells. */
function hours(seconds: number): string {
  return displayFloat(round(seconds / 360) / 10);
}

/** A text cell a spreadsheet app would evaluate as a formula (one that starts with `=`,
 * `+`, `-`, `@`, a tab, or a carriage return) gets a leading `'`, so titles and notes written
 * by agents stay text. Numbers, negative ones included, stay as they are: what `f64` parses
 * from digits, `-`, and `.` alone. */
function neutralizeFormula(field: string): string {
  const number = /^-(\d+\.?\d*|\.\d+)$/.test(field);
  return /^[=+\-@\t\r]/.test(field) && !number ? `'${field}` : field;
}

function csvRow(fields: ReadonlyArray<string | null>): string {
  const cells = fields.map((field) => {
    const cell = neutralizeFormula(field ?? "");
    return /["\r\n,]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  });
  return `${cells.join(",")}\r\n`;
}

function row(report: Report, entry: ReviewEntry): Array<string | null> {
  const { task, pullRequest } = entry;
  const time = (at: number | null) => (at === null ? null : report.dateTime(at));
  const { milestones } = task;
  const due = report.dueState(task);
  const active = activeSeconds(task.timeline, report.now);
  const waiting = waitingSeconds(task.timeline, report.now);
  return [
    String(task.id),
    report.workspace(task),
    typeName(task.taskType),
    task.title,
    outcomeLabel(entry.outcome),
    report.dateTime(entry.at),
    resolutionLabel(task.resolution),
    time(milestones.plannedAt),
    time(milestones.startedAt),
    time(milestones.reviewAt),
    time(milestones.completedAt),
    null,
    task.refs.find((ref) => ref.startsWith("pr:"))?.slice(3) ?? null,
    task.issue?.url ?? null,
    String(entry.commits.length),
    active === null ? null : hours(active),
    waiting === null ? null : hours(waiting),
    task.estimate === null ? null : displayFloat(task.estimate.amount),
    task.estimate?.unit ?? null,
    task.dueDate,
    due === null ? null : DUE_STATUS[due],
    pullRequest === null ? null : String(pullRequest.additions),
    pullRequest === null ? null : String(pullRequest.deletions),
    pullRequest === null ? null : String(pullRequest.changedFiles),
    pullRequest === null ? null : String(pullRequest.reviewCount),
    task.completionNote === null ? null : oneLine(task.completionNote),
  ];
}

/** One row per reviewed task as CSV (RFC 4180, CRLF line ends), led by a UTF-8 byte order
 * mark so spreadsheet apps read non-ASCII titles correctly. Active hours of a task still
 * being worked on count until now. */
export function csv(report: Report): string {
  return `\u{feff}${csvRow(CSV_COLUMNS)}${report.entries.map((entry) => csvRow(row(report, entry))).join("")}`;
}
