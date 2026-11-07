import type {
  PullRequestSnapshot,
  ReviewEntry,
  ReviewOutcome,
  Task,
  TaskType,
  Timestamp,
  Workspace,
  WorkspaceId,
} from "@/lib/bindings";
import { activeSeconds, formatDate } from "@/lib/timeline";
import {
  dueEnd,
  dueState,
  estimatedSeconds,
  secondsPastDue,
} from "@/lib/plan";
import { statusNames } from "@/lib/status-styles";

export const outcomeLabels: Record<ReviewOutcome, string> = {
  completed: "Completed",
  opened_for_review: statusNames.in_review,
  started: "Started",
  worked_on: "Worked on",
  planned: "Planned",
};

const outcomeOrder = Object.keys(outcomeLabels) as ReviewOutcome[];

export type PeriodKind = "week" | "month" | "quarter" | "year" | "custom";

/**
 * A reviewed period: the calendar days `from` to `to`, both included, as `YYYY-MM-DD`. The server
 * judges them in its review time zone, so a period covers the same time on every device.
 */
export interface ReviewPeriod {
  kind: PeriodKind;
  from: string;
  to: string;
}

export const periodNouns: Record<PeriodKind, string> = {
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
  custom: "period",
};

export const periodTitles: Record<PeriodKind, string> = {
  week: "Week review",
  month: "Month review",
  quarter: "Quarter review",
  year: "Year review",
  custom: "Review",
};

function parseDay(day: string): [number, number, number] {
  const [year, month, date] = day.split("-").map(Number);
  return [year, month - 1, date];
}

function localMidnight(day: string, days = 0): Date {
  const [year, month, date] = parseDay(day);
  return new Date(year, month, date + days);
}

function dayOf(date: Date): string {
  return formatDate(date.getTime() / 1000);
}

/** The Monday of the week containing `date`, as `YYYY-MM-DD` in the local time zone. */
export function startOfWeek(date: Date): string {
  const sinceMonday = (date.getDay() + 6) % 7;
  return dayOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday));
}

export function addDays(day: string, days: number): string {
  return dayOf(localMidnight(day, days));
}

export function weekStarting(day: string): ReviewPeriod {
  return { kind: "week", from: day, to: addDays(day, 6) };
}

const monthsPerPeriod = { month: 1, quarter: 3, year: 12 } as const;

function monthsPeriod(kind: "month" | "quarter" | "year", year: number, firstMonth: number): ReviewPeriod {
  const months = monthsPerPeriod[kind];
  return {
    kind,
    from: dayOf(new Date(year, firstMonth, 1)),
    to: dayOf(new Date(year, firstMonth + months, 0)),
  };
}

/**
 * The week (from its Monday), month, quarter, or year containing the day `day`. A custom
 * period becomes the single day.
 */
export function periodContaining(kind: PeriodKind, day: string): ReviewPeriod {
  const [year, month] = parseDay(day);
  switch (kind) {
    case "week":
      return weekStarting(startOfWeek(localMidnight(day)));
    case "month":
      return monthsPeriod(kind, year, month);
    case "quarter":
      return monthsPeriod(kind, year, month - (month % 3));
    case "year":
      return monthsPeriod(kind, year, 0);
    case "custom":
      return { kind, from: day, to: day };
  }
}

/** The period `steps` periods later (earlier when negative); a custom period moves by its length. */
export function shiftPeriod(period: ReviewPeriod, steps: number): ReviewPeriod {
  switch (period.kind) {
    case "week":
      return weekStarting(addDays(period.from, 7 * steps));
    case "month":
    case "quarter":
    case "year": {
      const [year, month] = parseDay(period.from);
      return monthsPeriod(period.kind, year, month + monthsPerPeriod[period.kind] * steps);
    }
    case "custom": {
      const length = periodDays(period);
      return { kind: "custom", from: addDays(period.from, length * steps), to: addDays(period.to, length * steps) };
    }
  }
}

function periodDays(period: ReviewPeriod): number {
  return Math.round((localMidnight(period.to, 1).getTime() - localMidnight(period.from).getTime()) / 86_400_000);
}

/** The day of `at` as `YYYY-MM-DD` in the IANA time zone `timeZone`. */
export function dayIn(at: Timestamp, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at * 1000);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function periodLabel(period: ReviewPeriod): string {
  const [year, month] = parseDay(period.from);
  switch (period.kind) {
    case "month":
      return period.from.slice(0, 7);
    case "quarter":
      return `${year} Q${Math.floor(month / 3) + 1}`;
    case "year":
      return String(year);
    case "week":
    case "custom":
      return `${period.from} to ${period.to}`;
  }
}

/** Entries grouped by outcome, most advanced first; outcomes without entries are left out. */
export function groupByOutcome(entries: ReviewEntry[]): { outcome: ReviewOutcome; entries: ReviewEntry[] }[] {
  return outcomeOrder.flatMap((outcome) => {
    const matching = entries.filter((entry) => entry.outcome === outcome);
    return matching.length === 0 ? [] : [{ outcome, entries: matching }];
  });
}

export function commitSubject(message: string): string {
  return message.split("\n", 1)[0];
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** The pull request number of a GitHub pull request URL. */
export function pullRequestNumber(url: string): string | null {
  return /\/pull\/(\d+)/.exec(url)?.[1] ?? null;
}

/** The number, size, and reviews of a merged pull request, e.g. `#12, +10/-3 in 2 files, 1 review`. */
export function pullRequestStats(pullRequest: PullRequestSnapshot): string {
  return `#${pullRequest.number}, +${pullRequest.additions}/-${pullRequest.deletions} in ${plural(
    pullRequest.changedFiles,
    "file",
  )}, ${plural(pullRequest.reviewCount, "review")}`;
}

/** Size of the merged pull requests of completed tasks, summed. */
export interface ChangeStat {
  pullRequests: number;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** The median of durations in seconds over the tasks that reached both milestones. */
export interface DurationStat {
  median: number;
  tasks: number;
}

export interface ReviewSummary {
  outcomes: { outcome: ReviewOutcome; count: number }[];
  commits: number;
  completedByType: { taskType: TaskType; count: number }[];
  completedByWorkspace: { workspace: string; count: number }[];
  /** Planned to completed. */
  leadTime: DurationStat | null;
  /** Started to completed. */
  cycleTime: DurationStat | null;
  /** Time spent in progress or in review, leaving out pauses. */
  activeTime: DurationStat | null;
  /** Opened for review to merged, or to completed when the merge time is unknown. */
  reviewTime: DurationStat | null;
  /** Tasks completed in each calendar month of the period; `null` for a period within one month. */
  completedPerMonth: { month: string; count: number }[] | null;
  /** Merged pull requests of completed tasks; `null` when none was recorded. */
  changes: ChangeStat | null;
  /** Completed tasks that were concluded without merging, e.g. research that was not adopted. */
  notAdopted: number;
}

function median(values: number[]): DurationStat | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median: value, tasks: sorted.length };
}

function countBy<K extends string>(keys: K[]): { key: K; count: number }[] {
  const counts = new Map<K, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function durations(entries: ReviewEntry[], span: (entry: ReviewEntry) => [Timestamp | null, Timestamp | null]) {
  return entries.flatMap((entry) => {
    const [from, to] = span(entry);
    return from === null || to === null ? [] : [to - from];
  });
}

/** The pull request URL a task references as `pr:<url>`, or `null` when it has none. */
export function pullRequestRef(task: Pick<Task, "refs">): string | null {
  for (const ref of task.refs) {
    if (ref.startsWith("pr:") && /^https?:\/\//.test(ref.slice(3))) return ref.slice(3);
  }
  return null;
}

/**
 * Counts and durations of the reviewed period, from the recorded milestones of its entries;
 * completions are counted per month in `timeZone`, the one the period was judged in.
 */
export function summarize(
  period: ReviewPeriod,
  entries: ReviewEntry[],
  workspaces: Pick<Workspace, "id" | "name">[],
  timeZone: string,
): ReviewSummary {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const completed = entries.filter((entry) => entry.outcome === "completed");
  const months = periodMonths(period);
  const pullRequests = completed.flatMap(({ pullRequest }) => (pullRequest ? [pullRequest] : []));
  return {
    outcomes: groupByOutcome(entries).map((group) => ({ outcome: group.outcome, count: group.entries.length })),
    commits: entries.reduce((total, entry) => total + entry.commits.length, 0),
    completedByType: countBy(completed.map((entry) => entry.task.taskType)).map(({ key, count }) => ({
      taskType: key,
      count,
    })),
    completedByWorkspace: countBy(
      completed.map((entry) => names.get(entry.task.workspaceId) ?? `workspace ${entry.task.workspaceId}`),
    ).map(({ key, count }) => ({ workspace: key, count })),
    leadTime: median(durations(completed, ({ task, at }) => [task.milestones.plannedAt, at])),
    cycleTime: median(durations(completed, ({ task, at }) => [task.milestones.startedAt, at])),
    activeTime: median(
      completed.flatMap(({ task, at }) => {
        const active = activeSeconds(task.timeline, at);
        return active === null ? [] : [active];
      }),
    ),
    reviewTime: median(
      durations(completed, ({ task, at }) => [task.milestones.reviewAt, at]),
    ),
    completedPerMonth:
      months.length < 2
        ? null
        : months.map((month) => ({
            month,
            count: completed.filter((entry) => dayIn(entry.at, timeZone).startsWith(month)).length,
          })),
    changes:
      pullRequests.length === 0
        ? null
        : pullRequests.reduce(
            (total, pullRequest) => ({
              pullRequests: total.pullRequests + 1,
              additions: total.additions + pullRequest.additions,
              deletions: total.deletions + pullRequest.deletions,
              changedFiles: total.changedFiles + pullRequest.changedFiles,
            }),
            { pullRequests: 0, additions: 0, deletions: 0, changedFiles: 0 },
          ),
    notAdopted: completed.filter(({ task }) => task.resolution === "not_adopted").length,
  };
}

/** A task that was done after its due date, or was still open after it. */
export interface LateTask {
  task: Task;
  dueDate: string;
  done: boolean;
  /** Seconds from the end of the due day to completion, or to the end of the period for an open task. */
  secondsLate: number;
}

/** How the work of a period went against its plan: estimates and due dates. */
export interface PlanVsActual {
  /** Completed tasks with an estimate and a recorded active time; durations in seconds. */
  time: { tasks: number; estimated: number; actual: number } | null;
  /** Completed tasks with a due date, and how many of them were done by it. */
  dueDates: { tasks: number; onTime: number } | null;
  /** Completed tasks done late and open tasks past their due date, the latest first. */
  late: LateTask[];
}

/**
 * Estimates and due dates of the reviewed tasks against what happened. An open task counts
 * as late when its due date passed before `periodEnd`, the end of the period, or before `now`
 * while the period is still under way. Null when no reviewed task has an estimate or a due date.
 */
export function planVsActual(periodEnd: Timestamp, entries: ReviewEntry[], now: Timestamp): PlanVsActual | null {
  const cutoff = Math.min(now, periodEnd);
  const completed = entries.filter((entry) => entry.outcome === "completed");
  const timed = completed.flatMap(({ task, at }) => {
    const estimated = estimatedSeconds(task.estimate);
    const actual = activeSeconds(task.timeline, at);
    return estimated === null || actual === null ? [] : [{ estimated, actual }];
  });
  const due = completed.flatMap(({ task }) => {
    const state = dueState(task, now);
    return state === "on_time" || state === "late" ? [state] : [];
  });
  const late = entries
    .flatMap(({ task, outcome }): LateTask[] => {
      if (task.dueDate === null) return [];
      if (task.status === "done") {
        return outcome === "completed" && dueState(task, now) === "late"
          ? [{ task, dueDate: task.dueDate, done: true, secondsLate: secondsPastDue(task, now) }]
          : [];
      }
      const end = dueEnd(task.dueDate);
      return cutoff >= end ? [{ task, dueDate: task.dueDate, done: false, secondsLate: cutoff - end }] : [];
    })
    .sort((a, b) => b.secondsLate - a.secondsLate || a.task.id - b.task.id);
  const planned = entries.some(({ task }) => task.estimate !== null || task.dueDate !== null);
  if (!planned) return null;
  return {
    time:
      timed.length === 0
        ? null
        : {
            tasks: timed.length,
            estimated: timed.reduce((total, { estimated }) => total + estimated, 0),
            actual: timed.reduce((total, { actual }) => total + actual, 0),
          },
    dueDates:
      due.length === 0 ? null : { tasks: due.length, onTime: due.filter((state) => state === "on_time").length },
    late,
  };
}

/** Estimated against active time, e.g. `12h estimated, 15h active (4 tasks, 1.25x)`. */
export function formatEstimateAccuracy(time: NonNullable<PlanVsActual["time"]>): string {
  return `${formatDuration(time.estimated)} estimated, ${formatDuration(time.actual)} active (${plural(
    time.tasks,
    "task",
  )}, ${(time.actual / time.estimated).toFixed(2)}x)`;
}

/** Share of due dates met, e.g. `3 of 4 (75%)`. */
export function formatDueRate(dueDates: NonNullable<PlanVsActual["dueDates"]>): string {
  return `${dueDates.onTime} of ${dueDates.tasks} (${Math.round((dueDates.onTime / dueDates.tasks) * 100)}%)`;
}

/** Why a late task is late, e.g. `due 2026-10-10, done 2026-10-12, 1.5d late`. */
export function lateDetails({ task, dueDate, done, secondsLate }: LateTask): string {
  const completedAt = task.milestones.completedAt;
  const finish = done && completedAt !== null ? `done ${formatDate(completedAt)}` : "still open";
  return `due ${dueDate}, ${finish}, ${formatDuration(secondsLate)} ${done ? "late" : "overdue"}`;
}

/** Merged pull requests of completed tasks with their size and reviews, summed. */
export interface PullRequestTotals extends ChangeStat {
  /** Submitted reviews by anyone but the author, over all pull requests. */
  reviews: number;
  /** Pull requests with at least one such review. */
  reviewed: number;
}

/** A completed research (`rnd`) task and whether its result was adopted. */
export interface ResearchConclusion {
  task: Task;
  at: Timestamp;
  adopted: boolean;
}

/** A completed task that took more active time than its estimate; durations in seconds. */
export interface Overrun {
  task: Task;
  estimated: number;
  actual: number;
}

/** The highlights of a year: merged pull request snapshots, research conclusions, and estimate overruns. */
export interface YearInReview {
  /** `null` when no completed task recorded a pull request snapshot. */
  pullRequests: PullRequestTotals | null;
  /** The merged pull requests with the most changed lines, largest first, at most three. */
  largest: { task: Task; pullRequest: PullRequestSnapshot }[];
  /** Completed research tasks, oldest first. */
  research: ResearchConclusion[];
  /** The tasks that overran their estimate the most, largest first, at most three. */
  overruns: Overrun[];
}

const largestPullRequests = 3;
const largestOverruns = 3;

/**
 * Pull request snapshots, research conclusions, and estimate overruns of the tasks
 * completed in `entries`; `null` when there are none.
 */
export function yearInReview(entries: ReviewEntry[]): YearInReview | null {
  const completed = entries.filter((entry) => entry.outcome === "completed");
  const merged = completed.flatMap(({ task, pullRequest }) => (pullRequest ? [{ task, pullRequest }] : []));
  const research = completed
    .filter(({ task }) => task.taskType === "rnd")
    .map(({ task, at }) => ({ task, at, adopted: task.resolution !== "not_adopted" }))
    .sort((a, b) => a.at - b.at || a.task.id - b.task.id);
  const overruns = completed
    .flatMap(({ task, at }) => {
      const estimated = estimatedSeconds(task.estimate);
      const actual = activeSeconds(task.timeline, at);
      return estimated === null || actual === null || actual <= estimated ? [] : [{ task, estimated, actual }];
    })
    .sort((a, b) => b.actual - b.estimated - (a.actual - a.estimated) || a.task.id - b.task.id)
    .slice(0, largestOverruns);
  if (merged.length === 0 && research.length === 0 && overruns.length === 0) return null;
  const size = ({ pullRequest }: (typeof merged)[number]) => pullRequest.additions + pullRequest.deletions;
  return {
    pullRequests:
      merged.length === 0
        ? null
        : merged.reduce(
            (total, { pullRequest }) => ({
              pullRequests: total.pullRequests + 1,
              additions: total.additions + pullRequest.additions,
              deletions: total.deletions + pullRequest.deletions,
              changedFiles: total.changedFiles + pullRequest.changedFiles,
              reviews: total.reviews + pullRequest.reviewCount,
              reviewed: total.reviewed + (pullRequest.reviewCount > 0 ? 1 : 0),
            }),
            { pullRequests: 0, additions: 0, deletions: 0, changedFiles: 0, reviews: 0, reviewed: 0 },
          ),
    largest: [...merged]
      .sort((a, b) => size(b) - size(a) || a.task.id - b.task.id)
      .slice(0, largestPullRequests),
    research,
    overruns,
  };
}

/** Reviews of merged pull requests, e.g. `5 reviews on 3 of 4 pull requests`. */
export function formatReviews(totals: PullRequestTotals): string {
  return `${plural(totals.reviews, "review")} on ${totals.reviewed} of ${plural(totals.pullRequests, "pull request")}`;
}

/** The summed size of merged pull requests, e.g. `+120/-30 in 9 files (3 pull requests)`. */
export function formatChanges(changes: ChangeStat): string {
  return `+${changes.additions}/-${changes.deletions} in ${plural(changes.changedFiles, "file")} (${plural(
    changes.pullRequests,
    "pull request",
  )})`;
}

function periodMonths(period: ReviewPeriod): string[] {
  const [year, month] = parseDay(period.from);
  const last = period.to.slice(0, 7);
  const months: string[] = [];
  for (let index = 0; ; index += 1) {
    const current = dayOf(new Date(year, month + index, 1)).slice(0, 7);
    months.push(current);
    if (current >= last) return months;
  }
}

/** A duration in seconds as hours below a day, otherwise as days with one decimal. */
export function formatDuration(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 1) return "<1h";
  if (Math.round(hours) < 24) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export const durationKeys = ["leadTime", "cycleTime", "activeTime", "reviewTime"] as const;

export const durationLabels = {
  leadTime: "Median lead time (planned to completed)",
  cycleTime: "Median cycle time (started to completed)",
  activeTime: "Median active time (started to completed, without pauses)",
  reviewTime: "Median review time (awaiting completion to merged)",
} as const;

/** Which reviewed tasks to show: those of one workspace and with one label; `null` for any. */
export type ReviewFilter = { workspaceId: WorkspaceId | null; label: string | null };

export const noReviewFilter: ReviewFilter = { workspaceId: null, label: null };

export function filterEntries(entries: ReviewEntry[], filter: ReviewFilter): ReviewEntry[] {
  return entries.filter(
    ({ task }) =>
      (filter.workspaceId === null || task.workspaceId === filter.workspaceId) &&
      (filter.label === null || task.labels.includes(filter.label)),
  );
}

/** The labels of the reviewed tasks, sorted, to filter them by. */
export function reviewLabels(entries: ReviewEntry[]): string[] {
  return [...new Set(entries.flatMap(({ task }) => task.labels))].sort();
}
