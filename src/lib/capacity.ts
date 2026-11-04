import type { Estimate, EstimateUnit, Task } from "@/lib/bindings";
import { estimatedSeconds, formatEstimate } from "@/lib/plan";
import { periodContaining, periodLabel, shiftPeriod, type ReviewPeriod } from "@/lib/review";
import { isNotAdopted } from "@/lib/task-graph";

/** How the plan view groups tasks by their due date. */
export type PlanScale = "quarter" | "year";

/** How much work fits in a quarter, in estimate units; a year holds four times as much. */
export type Capacity = Estimate;

const quartersPerPeriod: Record<PlanScale, number> = { quarter: 1, year: 4 };

/** The tasks due in one quarter or year and the work they add up to. */
export interface PeriodLoad {
  period: ReviewPeriod;
  label: string;
  /** Tasks due in the period, done ones included, in due date order. */
  tasks: Task[];
  /** The summed estimates of `tasks`, in seconds. */
  estimated: number;
  /** The part of `estimated` that belongs to done tasks. */
  done: number;
  /** How many of `tasks` have no estimate, so `estimated` leaves them out. */
  unestimated: number;
  /** The capacity of the period in seconds; null when no capacity is set. */
  capacity: number | null;
  /** Whether `estimated` is more than `capacity`. */
  overloaded: boolean;
}

export interface PlanLoad {
  /** Every period from the earliest due date to the latest, and the current one, without gaps. */
  periods: PeriodLoad[];
  /** Tasks without a due date, which no period counts. */
  unscheduled: Task[];
  /** The summed estimates of `unscheduled`, in seconds. */
  unscheduledEstimated: number;
}

function sumEstimates(tasks: Task[]): number {
  return tasks.reduce((sum, task) => sum + (estimatedSeconds(task.estimate) ?? 0), 0);
}

/**
 * The work planned per quarter or year: each task counts in the period of its due date,
 * with its estimate. Tasks that were not adopted are left out; done tasks count, since
 * their work filled the period too. `today` (`YYYY-MM-DD`) makes sure the current period
 * is shown even when nothing is due in it.
 */
export function planLoad(tasks: Task[], scale: PlanScale, capacity: Capacity | null, today: string): PlanLoad {
  const planned = tasks.filter((task) => !isNotAdopted(task));
  const scheduled = planned
    .filter((task): task is Task & { dueDate: string } => task.dueDate !== null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id - b.id);
  const unscheduled = planned.filter((task) => task.dueDate === null);
  const byPeriod = new Map<string, Task[]>();
  for (const task of scheduled) {
    const from = periodContaining(scale, task.dueDate).from;
    byPeriod.set(from, [...(byPeriod.get(from) ?? []), task]);
  }
  const current = periodContaining(scale, today);
  const first = scheduled.length > 0 && scheduled[0].dueDate < current.from ? periodContaining(scale, scheduled[0].dueDate) : current;
  const lastDue = scheduled.at(-1)?.dueDate;
  const last = lastDue !== undefined && lastDue > current.to ? periodContaining(scale, lastDue) : current;
  const capacitySeconds = capacity === null ? null : (estimatedSeconds(capacity) ?? 0) * quartersPerPeriod[scale];
  const periods: PeriodLoad[] = [];
  for (let period = first; period.from <= last.from; period = shiftPeriod(period, 1)) {
    const due = byPeriod.get(period.from) ?? [];
    const estimated = sumEstimates(due);
    periods.push({
      period,
      label: periodLabel(period),
      tasks: due,
      estimated,
      done: sumEstimates(due.filter((task) => task.status === "done")),
      unestimated: due.filter((task) => task.estimate === null).length,
      capacity: capacitySeconds,
      overloaded: capacitySeconds !== null && estimated > capacitySeconds,
    });
  }
  return { periods, unscheduled, unscheduledEstimated: sumEstimates(unscheduled) };
}

/** Seconds of work as an amount of `unit`, e.g. `2.5w`. */
export function formatWork(seconds: number, unit: EstimateUnit): string {
  return formatEstimate({ unit, amount: seconds / (estimatedSeconds({ unit, amount: 1 }) ?? 1) });
}

const storageKey = "toodo-plan-capacity";
const units: EstimateUnit[] = ["hours", "days", "weeks", "months"];

/** The capacity saved in this browser, or null when none is set or what is saved is not one. */
export function loadCapacity(): Capacity | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (typeof saved !== "object" || saved === null) return null;
    const { unit, amount } = saved as Record<string, unknown>;
    return units.includes(unit as EstimateUnit) && typeof amount === "number" && amount > 0 && amount <= 10_000
      ? { unit: unit as EstimateUnit, amount }
      : null;
  } catch {
    // Anything else saved under the key is no capacity.
    return null;
  }
}

/** Saves the capacity in this browser; null removes it. */
export function saveCapacity(capacity: Capacity | null) {
  if (capacity === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, JSON.stringify(capacity));
}
