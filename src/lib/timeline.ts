import type { TaskEvent, TaskMilestones, Timestamp } from "@/lib/bindings";
import { statusNames } from "@/lib/status-styles";

const milestoneLabels: [keyof TaskMilestones, string][] = [
  ["plannedAt", "Planned"],
  ["startedAt", "Started"],
  ["reviewAt", statusNames.in_review],
  ["completedAt", "Completed"],
  ["reopenedAt", "Reopened"],
  ["pausedAt", statusNames.paused],
];

/** Calendar date of `at` in the local time zone, as `YYYY-MM-DD`. */
export function formatDate(at: Timestamp): string {
  const date = new Date(at * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
const WEEK_SECONDS = 7 * 24 * 3600;

/**
 * The one way the app shows a moment: relative within 7 days ("5 min. ago"), a short date
 * ("Oct 12", with the year when it is not this one) otherwise. Never shows seconds; pair it
 * with `formatFull` in a tooltip.
 */
export function formatWhen(at: Timestamp, now: Timestamp = Date.now() / 1000): string {
  const diff = at - now;
  const age = Math.abs(diff);
  if (age < 60) return "just now";
  if (age < WEEK_SECONDS) {
    const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
      age < 3600 ? [Math.trunc(diff / 60), "minute"] : age < 86400 ? [Math.trunc(diff / 3600), "hour"] : [Math.trunc(diff / 86400), "day"];
    return relativeFormat.format(value, unit);
  }
  const date = new Date(at * 1000);
  const sameYear = date.getFullYear() === new Date(now * 1000).getFullYear();
  return date.toLocaleDateString("en", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** The full local date and time of `at` without seconds, for tooltips and detail views. */
export function formatFull(at: Timestamp): string {
  return new Date(at * 1000).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}

export type WorkState = "in_progress" | "in_review" | "paused";

/** A stretch of a task's history in one state; `end` is null while the task is still in it. */
export type WorkSegment = { state: WorkState; start: Timestamp; end: Timestamp | null };

/**
 * The history of a task from its first start to its latest completion, oldest first: the
 * stretches it spent in progress, in review, and paused (back in `planned` after it started,
 * which includes a reopening after it was done). Empty when the history records no start.
 */
export function workSegments(timeline: TaskEvent[]): WorkSegment[] {
  const segments: WorkSegment[] = [];
  for (const event of timeline) {
    const last = segments.at(-1);
    if (last !== undefined && last.end === null) {
      last.end = event.at;
    }
    if (event.status === "done") {
      continue;
    }
    if (event.status !== "planned") {
      segments.push({ state: event.status, start: event.at, end: null });
    } else if (segments.length > 0) {
      segments.push({ state: "paused", start: event.at, end: null });
    }
  }
  return segments;
}

/**
 * Seconds a task spent in progress or in review, leaving out its pauses; a stretch still
 * under way counts until `now`. Null when the history records no start.
 */
export function activeSeconds(timeline: TaskEvent[], now: Timestamp): number | null {
  const segments = workSegments(timeline);
  if (segments.length === 0) {
    return null;
  }
  return segments
    .filter((segment) => segment.state !== "paused")
    .reduce((total, segment) => total + Math.max((segment.end ?? now) - segment.start, 0), 0);
}

/** The milestones a task reached, oldest first, e.g. Completed after Reopened once it is done again. */
export function reachedMilestones(milestones: TaskMilestones): { label: string; at: Timestamp }[] {
  return milestoneLabels
    .flatMap(([key, label]) => {
      const at = milestones[key];
      return at === null ? [] : [{ label, at }];
    })
    .sort((a, b) => a.at - b.at);
}
