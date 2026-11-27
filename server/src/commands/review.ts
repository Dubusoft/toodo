// Commands for reviewing the work done in a period, such as a week or a year
// (`src-tauri/src/commands/review.rs`); saved reviews are in `snapshots.ts`.

import type * as B from "../../../src/lib/bindings.ts";
import type { CommitRecord, PullRequestSnapshot, Task } from "../domain/model.ts";
import { EmptyPeriod, Period, review, type TaskReview } from "../domain/review.ts";
import { debugString, trim } from "../domain/rust.ts";
import { StorageError } from "../storage/errors.ts";
import * as reviews from "../storage/reviews.ts";
import type { Storage } from "../storage/storage.ts";
import { command, internal, invalidInput } from "./errors.ts";
import { parseDay, systemZone, zoned, zoneName } from "./report/calendar.ts";
import type { Day, TimeZone } from "./report/calendar.ts";
import { csv } from "./report/csv.ts";
import { ReportPeriod } from "./report/period.ts";
import { Report } from "./report/report.ts";
import { task, type Command } from "./types.ts";

function pullRequest(snapshot: PullRequestSnapshot): B.PullRequestSnapshot {
  return {
    number: snapshot.number,
    title: snapshot.title,
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    changedFiles: snapshot.changedFiles,
    mergeCommitSha: snapshot.mergeCommitSha,
    reviewCount: snapshot.reviewCount,
    reviewerCount: snapshot.reviewerCount,
    firstReviewedAt: snapshot.firstReviewedAt,
  };
}

function commitRecord(record: CommitRecord): B.CommitRecord {
  return { taskId: record.taskId, sha: record.sha, message: record.message, author: record.author, committedAt: record.committedAt };
}

function reviewEntry(reviewed: TaskReview, reviewedTask: Task, snapshot: PullRequestSnapshot | null, archived: boolean): B.ReviewEntry {
  return {
    pullRequest: snapshot === null ? null : pullRequest(snapshot),
    task: task(reviewedTask),
    outcome: reviewed.outcome,
    at: reviewed.at,
    commits: reviewed.commits.map(commitRecord),
    archived,
  };
}

/** `value` as `serde_json` writes it, the fields in the order of the Rust structs as the
 * conversions build them: like `JSON.stringify`, except that an estimate amount, the only
 * float the shapes hold, keeps a decimal point (`4.0`). */
export function rustJson(value: unknown): string {
  return JSON.stringify(value).replace(/"amount":(-?\d+)(?=[,}])/g, '"amount":$1.0');
}

/** The time zone reviews are judged in, with its IANA name: the one set, else the server's
 * own, else UTC when the server's has no IANA name to record. */
function effectiveTimeZone(storage: Storage): [TimeZone, string] {
  const name = reviews.reviewTimeZone(storage.db);
  if (name === null) {
    const system = systemZone();
    return [system, system];
  }
  const zone = zoneName(name);
  if (zone === null) {
    throw internal(
      `the review time zone ${debugString(name)} saved on the server is unknown to it; set another one under Settings, Review, or with set_review_time_zone`,
    );
  }
  return [zone, name];
}

/** The IANA name of the time zone a caller named, or an invalid input error. */
function requireZone(name: string): TimeZone {
  const zone = zoneName(name);
  if (zone === null) {
    throw invalidInput(
      `unknown time zone ${debugString(name)}; pass an IANA time zone name such as Europe/Berlin or America/New_York, or leave it out to use the server's`,
    );
  }
  return zone;
}

function reviewTimeZone(storage: Storage): B.ReviewTimeZone {
  return { timeZone: effectiveTimeZone(storage)[1], configured: reviews.reviewTimeZone(storage.db) };
}

/** Every task that reached a milestone or got a commit in `[start, end)`, archived ones
 * included, ordered by outcome, then by time. */
export function reviewEntries(storage: Storage, start: number, end: number): B.ReviewEntry[] {
  let period: Period;
  try {
    period = Period.of(start, end);
  } catch (error) {
    throw error instanceof EmptyPeriod ? invalidInput(error.message) : error;
  }
  const tasks = storage.reviewTasks();
  const live = new Set(storage.listAllTasks().map((t) => t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return review(period, tasks, storage.listCommitRecordsIn(period)).map((reviewed) => {
    const reviewedTask = byId.get(reviewed.taskId);
    if (reviewedTask === undefined) throw new Error("a review entry belongs to a reviewed task");
    return reviewEntry(reviewed, reviewedTask, storage.historicalPullRequest(reviewedTask.id), !live.has(reviewedTask.id));
  });
}

/** A reviewed period with what its report is rendered from. */
export type Reviewed = {
  readonly report: Report;
  readonly timeZoneName: string;
  readonly label: string | null;
};

/** The report of `period` as `format`, with its file name and days. */
export function rendered(period: ReportPeriod, format: B.ReportFormat, contents: string): B.ReviewReport {
  return {
    fileName: period.fileName(format),
    mediaType: format === "markdown" ? "text/markdown" : "text/csv",
    from: period.from.toString(),
    to: period.to.toString(),
    contents,
  };
}

export function render({ report }: Reviewed, format: B.ReportFormat): B.ReviewReport {
  return rendered(report.period, format, format === "markdown" ? report.markdown() : csv(report));
}

/** The period `request` names, in its time zone or else the review time zone, and the
 * tasks reviewed in it that pass its filters. */
export function reviewed(storage: Storage, request: B.ReviewReportRequest): Reviewed {
  const requested = request.timeZone === undefined || request.timeZone === null ? "" : trim(request.timeZone);
  const [timeZone, timeZoneName] = requested === "" ? effectiveTimeZone(storage) : [requireZone(requested), requested];
  const day = (field: string, value: string | null | undefined): Day | null =>
    value === undefined || value === null ? null : parseDay(field, value);
  const date = day("date", request.date);
  const from = day("from", request.from);
  const to = day("to", request.to);
  const now = storage.now();
  const period = ReportPeriod.resolve({ kind: request.period, date, from, to }, zoned(now, timeZone).toPlainDate(), timeZone);
  // Reviews keep the work of deleted workspaces, so they are named and filtered too.
  const workspaces = [...storage.listWorkspaces(), ...storage.archivedWorkspaces()];
  const workspaceId = request.workspaceId ?? null;
  if (workspaceId !== null && !workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new StorageError({ kind: "workspace_not_found", workspace: workspaceId });
  }
  const label = request.label === undefined || request.label === null ? null : trim(request.label) || null;
  const entries = reviewEntries(storage, period.start, period.end).filter(
    (entry) => (workspaceId === null || entry.task.workspaceId === workspaceId) && (label === null || entry.task.labels.includes(label)),
  );
  const names = new Map<number, string>(workspaces.map((workspace) => [workspace.id, workspace.name]));
  return { report: new Report(period, entries, names, timeZone, now), timeZoneName, label };
}

/** Tasks of every workspace that reached a milestone or got a commit from midnight of the
 * day `from` to midnight after the day `to` (both `YYYY-MM-DD`) in the review time zone of
 * the server, archived ones included, ordered by outcome, then by time. */
export const reviewPeriod: Command<"reviewPeriod"> = command((storage, from, to) => {
  const [timeZone, timeZoneName] = effectiveTimeZone(storage);
  const first = parseDay("from", from);
  const period = ReportPeriod.resolve({ kind: "custom", date: null, from: first, to: parseDay("to", to) }, first, timeZone);
  return {
    from: period.from.toString(),
    to: period.to.toString(),
    start: period.start,
    end: period.end,
    timeZone: timeZoneName,
    entries: reviewEntries(storage, period.start, period.end),
  };
});

/** The review of a period rendered as Markdown or CSV, as the web app, the MCP tool
 * `review_report`, and `toodo review` show it. */
export const reviewReport: Command<"reviewReport"> = command((storage, request) =>
  render(reviewed(storage, request), request.format));

/** The time zone reviewed periods are judged in. */
export const getReviewTimeZone: Command<"getReviewTimeZone"> = command((storage) => reviewTimeZone(storage));

/** Sets the IANA time zone (e.g. `Europe/Berlin`) reviewed periods are judged in, on every
 * device and for MCP and `toodo review`; `null` or blank goes back to the server's own. */
export const setReviewTimeZone: Command<"setReviewTimeZone"> = command((storage, timeZone) => {
  const name = timeZone === null ? "" : trim(timeZone);
  reviews.setReviewTimeZone(storage.db, name === "" ? null : requireZone(name));
  return reviewTimeZone(storage);
});
