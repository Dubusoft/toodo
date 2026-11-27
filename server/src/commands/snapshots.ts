// Saved reviews: a review as it was when saved, however its tasks change afterwards. Port
// of the snapshot commands of `src-tauri/src/commands/review.rs`.

import { debugString, trim } from "../domain/rust.ts";
import * as reviews from "../storage/reviews.ts";
import type { ReviewSnapshotInfo } from "../storage/reviews.ts";
import type {
  ReviewEntry,
  ReviewPeriodKind,
  ReviewSnapshotId,
  ReviewSnapshotSummary,
  ReviewWorkspaceName,
} from "../../../src/lib/api.ts";
import { command, internal, notFound, type CommandError } from "./errors.ts";
import { readDay } from "./report/calendar.ts";
import { ReportPeriod } from "./report/period.ts";
import { render, rendered, reviewed, rustJson } from "./review.ts";
import type { Command } from "./types.ts";

const PERIOD_KINDS: readonly ReviewPeriodKind[] = ["week", "month", "quarter", "year", "custom"];

function missingSnapshot(id: ReviewSnapshotId): CommandError {
  return notFound(
    `there is no saved review ${id}; list the saved reviews with list_review_snapshots and pass one of their ids`,
  );
}

function snapshotSummary(info: ReviewSnapshotInfo): ReviewSnapshotSummary {
  const period = PERIOD_KINDS.find((kind) => kind === info.period);
  if (period === undefined) {
    throw internal(
      `saved review ${info.id} has an unknown kind of period ${debugString(info.period)}; delete it with delete_review_snapshot and save the review again`,
    );
  }
  return {
    id: info.id,
    title: info.title,
    period,
    from: info.from,
    to: info.to,
    timeZone: info.timeZone,
    workspaceId: info.workspaceId,
    label: info.label,
    start: info.startAt,
    end: info.endAt,
    savedAt: info.createdAt,
    entryCount: info.entryCount,
  };
}

/** Saves the review of a period as it is now: its tasks, the names of their workspaces, and
 * its report as Markdown and CSV, judged in the review time zone. Reopening it later shows
 * the same, however the tasks change afterwards. */
export const saveReviewSnapshot: Command<"saveReviewSnapshot"> = command((storage, request) => {
  const workspaceId = request.workspaceId ?? null;
  const review = reviewed(storage, {
    period: request.period,
    date: null,
    from: request.from,
    to: request.to ?? null,
    format: "markdown",
    timeZone: null,
    workspaceId,
    label: request.label ?? null,
  });
  const { period, entries, workspaceNames, now } = review.report;
  const title = (request.title === undefined || request.title === null ? "" : trim(request.title)) || period.name();
  const workspaces: ReviewWorkspaceName[] = [...workspaceNames]
    .filter(([id]) => id === workspaceId || entries.some((entry) => entry.task.workspaceId === id))
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.id - b.id);
  const info = reviews.saveReviewSnapshot(
    storage.db,
    {
      info: {
        title,
        period: period.kind,
        from: period.from.toString(),
        to: period.to.toString(),
        timeZone: review.timeZoneName,
        workspaceId,
        label: review.label,
        startAt: period.start,
        endAt: period.end,
        entryCount: entries.length,
      },
      entries: rustJson(entries),
      workspaces: rustJson(workspaces),
      markdown: render(review, "markdown").contents,
      csv: render(review, "csv").contents,
    },
    now,
  );
  return snapshotSummary(info);
});

/** The saved reviews, the most recently saved first. */
export const listReviewSnapshots: Command<"listReviewSnapshots"> = command((storage) =>
  reviews.listReviewSnapshots(storage.db).map(snapshotSummary));

/** The saved review `id` exactly as it was saved. */
export const getReviewSnapshot: Command<"getReviewSnapshot"> = command((storage, id) => {
  const snapshot = reviews.reviewSnapshot(storage.db, id);
  if (snapshot === null) throw missingSnapshot(id);
  const summary = snapshotSummary(snapshot.info);
  const damaged = (what: string) =>
    internal(
      `the ${what} of saved review ${id} are damaged; delete it with delete_review_snapshot and save the review again`,
    );
  const parsed = <T>(json: string, what: string): T => {
    try {
      return JSON.parse(json) as T;
    } catch {
      throw damaged(what);
    }
  };
  const entries = parsed<ReviewEntry[]>(snapshot.entries, "tasks");
  const workspaces = parsed<ReviewWorkspaceName[]>(snapshot.workspaces, "workspace names");
  const from = readDay(summary.from);
  const to = readDay(summary.to);
  if (from === null || to === null) throw damaged("days");
  const period = new ReportPeriod(summary.period, from, to, summary.start, summary.end);
  return {
    summary,
    entries,
    workspaces,
    markdown: rendered(period, "markdown", snapshot.markdown),
    csv: rendered(period, "csv", snapshot.csv),
  };
});

export const deleteReviewSnapshot: Command<"deleteReviewSnapshot"> = command((storage, id) => {
  if (!reviews.deleteReviewSnapshot(storage.db, id)) throw missingSnapshot(id);
  return null;
});
