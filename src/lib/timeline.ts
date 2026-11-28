import type { TaskEvent, TaskMilestones, Timestamp } from "@/lib/bindings";
import type { Locale } from "@/lib/i18n";
import { en, type Messages } from "@/locales/en";

const milestoneKeys = ["plannedAt", "startedAt", "reviewAt", "completedAt", "reopenedAt", "pausedAt"] as const satisfies readonly (keyof TaskMilestones)[];

/** Calendar date of `at` in the local time zone, as `YYYY-MM-DD`. */
export function formatDate(at: Timestamp): string {
  const date = new Date(at * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}


const WEEK_SECONDS = 7 * 24 * 3600;

/** The IANA time zone `formatWhen` and `formatFull` show dates in; undefined is this device's. */
let displayTimeZone: string | undefined;

/**
 * Shows dates in `zone` from now on: the Time zone setting (Dori's `displayTimeZone`). A zone
 * this browser does not know, or none, leaves dates in this device's time zone.
 */
export function setDisplayTimeZone(zone: string | null | undefined): void {
  displayTimeZone = zone && knownTimeZone(zone) ? zone : undefined;
}

function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The one way the app shows a moment: relative within 7 days ("5 min. ago"), a short date
 * ("Oct 12", with the year when it is not this one) otherwise. Never shows seconds; pair it
 * with `formatFull` in a tooltip.
 */
export function formatWhen(at: Timestamp, now: Timestamp = Date.now() / 1000, locale: Locale = "en", m: Messages = en): string {
  const diff = at - now;
  const age = Math.abs(diff);
  if (age < 60) return m.details.time.justNow;
  if (age < WEEK_SECONDS) {
    const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
      age < 3600 ? [Math.trunc(diff / 60), "minute"] : age < 86400 ? [Math.trunc(diff / 3600), "hour"] : [Math.trunc(diff / 86400), "day"];
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(value, unit);
  }
  const date = new Date(at * 1000);
  const sameYear = date.getFullYear() === new Date(now * 1000).getFullYear();
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: displayTimeZone, ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * The time left until `at`, rounded down, for a chip: minutes under an hour (`45m`), half hours
 * under a day (`1.5h`, `12h`), days under two weeks (`7d`), then whole weeks (`3w`), months of 30
 * days (`5mo`), and years of 365 days (`2y`). `0m` once `at` has passed.
 */
export function formatRemaining(at: Timestamp, now: Timestamp = Date.now() / 1000, m: Messages = en): string {
  const units = m.details.time;
  const minutes = Math.max(0, Math.floor((at - now) / 60));
  if (minutes < 60) return units.minutes(minutes);
  if (minutes < 24 * 60) return units.hours(Math.floor(minutes / 30) / 2);
  const days = Math.floor(minutes / (24 * 60));
  if (days < 14) return units.days(days);
  if (days < 60) return units.weeks(Math.floor(days / 7));
  if (days < 365) return units.months(Math.floor(days / 30));
  return units.years(Math.floor(days / 365));
}

/** The full local date and time of `at` without seconds, for tooltips and detail views. */
export function formatFull(at: Timestamp, locale: Locale = "en"): string {
  return new Date(at * 1000).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", timeZone: displayTimeZone });
}

export type WorkState = "in_progress" | "in_review" | "paused";

/**
 * A stretch of a task's history in one state; `end` is null while the task is still in it.
 * `reason` says why a paused stretch began: the reason of the pause, the prerequisites the
 * task waits on, or why it was reopened; null when none was recorded.
 */
export type WorkSegment = { state: WorkState; start: Timestamp; end: Timestamp | null; reason: string | null };

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
      segments.push({ state: event.status, start: event.at, end: null, reason: null });
    } else if (segments.length > 0) {
      segments.push({ state: "paused", start: event.at, end: null, reason: event.reason });
    }
  }
  return segments;
}

/**
 * Seconds a task spent in progress or in review, leaving out its pauses; a stretch still
 * under way counts until `now`. Null when the history records no start.
 */
export function activeSeconds(timeline: TaskEvent[], now: Timestamp): number | null {
  return secondsIn(timeline, now, (state) => state !== "paused");
}

/**
 * Seconds a task spent waiting after its first start: paused, blocked by prerequisites, or
 * reopened, until it was started again; a wait still under way counts until `now`. Null
 * when the history records no start.
 */
export function waitingSeconds(timeline: TaskEvent[], now: Timestamp): number | null {
  return secondsIn(timeline, now, (state) => state === "paused");
}

/** Seconds of the segments whose state `counts`, until `now` for one under way. */
function secondsIn(timeline: TaskEvent[], now: Timestamp, counts: (state: WorkState) => boolean): number | null {
  const segments = workSegments(timeline);
  if (segments.length === 0) {
    return null;
  }
  return segments
    .filter((segment) => counts(segment.state))
    .reduce((total, segment) => total + Math.max((segment.end ?? now) - segment.start, 0), 0);
}

/** The milestones a task reached, oldest first, e.g. Completed after Reopened once it is done again. */
export function reachedMilestones(milestones: TaskMilestones, m: Messages = en): { label: string; at: Timestamp }[] {
  return milestoneKeys
    .flatMap((key) => {
      const at = milestones[key];
      return at === null ? [] : [{ label: m.details.milestones[key], at }];
    })
    .sort((a, b) => a.at - b.at);
}
