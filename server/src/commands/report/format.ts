// How a report writes numbers, durations, and labels, and the stretches of work and waiting
// it reads from a task's history, with Rust's float rounding and printing.

import { compareStrings, displayFloat, trimEnd, trimStart } from "../../domain/rust.ts";
import type {
  Estimate,
  PullRequestSnapshot,
  ReviewOutcome,
  TaskEvent,
  TaskResolution,
  TaskType,
} from "../../../../src/lib/api.ts";

export const OUTCOMES: readonly ReviewOutcome[] = ["completed", "opened_for_review", "started", "worked_on", "planned"];

export function outcomeLabel(outcome: ReviewOutcome): string {
  switch (outcome) {
    case "completed":
      return "Completed";
    case "opened_for_review":
      return "Awaiting completion";
    case "started":
      return "Started";
    case "worked_on":
      return "Worked on";
    case "planned":
      return "Planned";
  }
}

export function typeName(taskType: TaskType): string {
  return taskType;
}

export function resolutionLabel(resolution: TaskResolution | null): string | null {
  switch (resolution) {
    case null:
      return null;
    case "merged":
      return "Merged";
    case "completed":
      return "Completed";
    case "not_adopted":
      return "Not adopted";
  }
}

/** `f64::round`: halves away from zero. */
export function round(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

/** `value` with `digits` decimals, rounding halves up as JavaScript's `toFixed` does for
 * the positive values reports show. */
export function fixed(value: number, digits: number): string {
  const scale = 10 ** digits;
  return (round(value * scale) / scale).toFixed(digits);
}

/** A duration in seconds as hours below a day, otherwise as days with one decimal. */
export function formatDuration(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 1) return "<1h";
  if (round(hours) < 24) return `${displayFloat(round(hours))}h`;
  return `${fixed(hours / 24, 1)}d`;
}

/** [`formatDuration`], with no time at all as `0h` rather than `<1h`. */
export function formatSpan(seconds: number): string {
  return seconds === 0 ? "0h" : formatDuration(seconds);
}

/** The text of a note or completion note on one line, for list items and CSV cells. */
export function oneLine(text: string): string {
  const pieces = text.split("\n");
  const last = pieces.length - 1;
  return pieces
    .map((piece, index) => {
      const start = index > 0 ? trimStart(piece) : piece;
      return index < last ? trimEnd(start) : start;
    })
    .join(" ");
}

export function nonEmpty(text: string | null): string | null {
  return text === null || text === "" ? null : text;
}

export function pullRequestStats(pullRequest: PullRequestSnapshot): string {
  return `#${pullRequest.number}, +${pullRequest.additions}/-${pullRequest.deletions} in ${plural(pullRequest.changedFiles, "file")}, ${plural(pullRequest.reviewCount, "review")}`;
}

export function formatEstimate(estimate: Estimate): string {
  const suffix = { hours: "h", days: "d", weeks: "w", months: "mo" }[estimate.unit];
  return `${displayFloat(round(estimate.amount * 100) / 100)}${suffix}`;
}

/** The estimate in seconds of active work: a day is 24 hours, a week 7 days, a month 30. */
export function estimatedSeconds(estimate: Estimate | null): number | null {
  if (estimate === null) return null;
  const unit = { hours: 3600, days: 24 * 3600, weeks: 7 * 24 * 3600, months: 30 * 24 * 3600 }[estimate.unit];
  return estimate.amount * unit;
}

/** A stretch of a task's history from its first start: work (in progress or in review), or
 * waiting (back in `planned`: paused, blocked by prerequisites, or reopened) with the reason
 * recorded when it began. `end` is `null` while the task is still in it. */
export type Segment = {
  readonly active: boolean;
  readonly start: number;
  end: number | null;
  readonly reason: string | null;
};

export function segmentSeconds(segment: Segment, now: number): number {
  return Math.max((segment.end ?? now) - segment.start, 0);
}

/** The stretches of work and waiting of a task, oldest first; empty when the history
 * records no start. */
export function segments(timeline: readonly TaskEvent[]): Segment[] {
  const stretches: Segment[] = [];
  for (const event of timeline) {
    const last = stretches.at(-1);
    if (last !== undefined) last.end ??= event.at;
    if (event.status === "done" || (event.status === "planned" && stretches.length === 0)) continue;
    stretches.push({ active: event.status !== "planned", start: event.at, end: null, reason: event.reason });
  }
  return stretches;
}

function secondsIn(timeline: readonly TaskEvent[], now: number, active: boolean): number | null {
  const stretches = segments(timeline);
  if (stretches.length === 0) return null;
  return stretches
    .filter((segment) => segment.active === active)
    .reduce((total, segment) => total + segmentSeconds(segment, now), 0);
}

/** Seconds a task spent in progress or in review from its first start, leaving out its
 * pauses; a stretch still under way counts until `now`. `null` when the history records no
 * start. */
export function activeSeconds(timeline: readonly TaskEvent[], now: number): number | null {
  return secondsIn(timeline, now, true);
}

/** Seconds a task spent waiting after its first start: paused, blocked by prerequisites, or
 * reopened, until it was started again; a wait still under way counts until `now`. `null`
 * when the history records no start. */
export function waitingSeconds(timeline: readonly TaskEvent[], now: number): number | null {
  return secondsIn(timeline, now, false);
}

export type DurationStat = { readonly median: number; readonly tasks: number };

export function median(values: number[]): DurationStat | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return { median: value, tasks: sorted.length };
}

export function formatStat(stat: DurationStat | null): string {
  return stat === null ? "no data" : `${formatDuration(stat.median)} (${plural(stat.tasks, "task")})`;
}

/** Counts of `keys`, the most frequent first, then by key. */
export function countBy(keys: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].sort(
    ([a, aCount], [b, bCount]) =>
      bCount - aCount || compareStrings(a.toLowerCase(), b.toLowerCase()) || compareStrings(a, b),
  );
}

export type Changes = {
  readonly pullRequests: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly reviews: number;
  readonly reviewed: number;
};

/** The totals of `pullRequests`; `null` when there are none. */
export function sumChanges(pullRequests: readonly PullRequestSnapshot[]): Changes | null {
  if (pullRequests.length === 0) return null;
  return pullRequests.reduce<Changes>(
    (total, pullRequest) => ({
      pullRequests: total.pullRequests + 1,
      additions: total.additions + pullRequest.additions,
      deletions: total.deletions + pullRequest.deletions,
      changedFiles: total.changedFiles + pullRequest.changedFiles,
      reviews: total.reviews + pullRequest.reviewCount,
      reviewed: total.reviewed + (pullRequest.reviewCount > 0 ? 1 : 0),
    }),
    { pullRequests: 0, additions: 0, deletions: 0, changedFiles: 0, reviews: 0, reviewed: 0 },
  );
}

/** E.g. `+120/-30 in 9 files (3 pull requests)`. */
export function formatChanges(changes: Changes): string {
  return `+${changes.additions}/-${changes.deletions} in ${plural(changes.changedFiles, "file")} (${plural(changes.pullRequests, "pull request")})`;
}
