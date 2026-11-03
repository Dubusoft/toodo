import type { Estimate, EstimateUnit, Task, Timestamp } from "@/lib/bindings";

/** Where a task with a due date stands against it. */
export type DueState = "on_time" | "late" | "overdue" | "upcoming";

export const dueStateLabels: Record<DueState, string> = {
  on_time: "On time",
  late: "Late",
  overdue: "Overdue",
  upcoming: "Due",
};

/** The end of local day `day` (`YYYY-MM-DD`): a task completed before it is on time. */
export function dueEnd(day: string): Timestamp {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date + 1).getTime() / 1000;
}

/**
 * How a task stands against its due date at `now`: done before the end of the day is on
 * time, done after it late, and still open after it overdue. Null without a due date, or for
 * a done task whose completion time was not recorded.
 */
export function dueState(task: Task, now: Timestamp): DueState | null {
  if (task.dueDate === null) return null;
  const end = dueEnd(task.dueDate);
  if (task.status === "done") {
    const { completedAt } = task.milestones;
    if (completedAt === null) return null;
    return completedAt < end ? "on_time" : "late";
  }
  return now >= end ? "overdue" : "upcoming";
}

export function isBehindDue(task: Task, now: Timestamp): boolean {
  const state = dueState(task, now);
  return state === "late" || state === "overdue";
}

/** Seconds past the due date: until completion for a late task, until `now` for an overdue one. */
export function secondsPastDue(task: Task, now: Timestamp): number {
  if (task.dueDate === null) return 0;
  const until = task.status === "done" ? (task.milestones.completedAt ?? now) : now;
  return Math.max(until - dueEnd(task.dueDate), 0);
}

function formatAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

const unitSuffixes: Record<EstimateUnit, string> = { hours: "h", days: "d", weeks: "w", months: "mo" };

/** Seconds in one estimate unit: a day is 24 hours, a week 7 days, a month 30 days. */
const unitSeconds: Record<EstimateUnit, number> = {
  hours: 3600,
  days: 24 * 3600,
  weeks: 7 * 24 * 3600,
  months: 30 * 24 * 3600,
};

export function formatEstimate(estimate: Estimate): string {
  return `${formatAmount(estimate.amount)}${unitSuffixes[estimate.unit]}`;
}

/** The estimate in seconds of active work; null without an estimate. */
export function estimatedSeconds(estimate: Estimate | null): number | null {
  return estimate ? estimate.amount * unitSeconds[estimate.unit] : null;
}

/** Text typed into an estimate field as an amount; null when blank, NaN when it is not a valid one. */
export function parseEstimateAmount(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const amount = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  return amount > 0 && amount <= 10_000 ? amount : Number.NaN;
}
