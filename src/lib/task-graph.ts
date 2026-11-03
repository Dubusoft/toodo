import type { BranchFreshness, Task, TaskId, TaskStatus, Timestamp } from "@/lib/bindings";
import { type WorkState, workSegments } from "@/lib/timeline";
import { dueEnd, dueState, estimatedSeconds, type DueState } from "@/lib/plan";

/** A dependency drawn from the prerequisite (`source`) to the task that waits on it (`target`). */
export type DependencyEdge = { id: string; source: TaskId; target: TaskId };

/**
 * Statuses whose dependencies can change in the app. A new prerequisite that is not done
 * pauses an `in_progress` task and closes its herdr workspace, after the user confirms it.
 */
export const dependencyEditableStatuses: TaskStatus[] = ["planned", "in_progress"];

/** Whether `task` was concluded without merging, so tasks that depend on it cannot build on it. */
export function isNotAdopted(task: Task | undefined): boolean {
  return task?.resolution === "not_adopted";
}

/** Whether every dependency of `task` is done and adopted, so it can be started. */
export function dependenciesDone(task: Task, byId: ReadonlyMap<TaskId, Task>): boolean {
  return task.dependsOn.every((id) => {
    const dependency = byId.get(id);
    return dependency?.status === "done" && !isNotAdopted(dependency);
  });
}

/**
 * Prerequisites a planned task waits on before it can start (or resume): those not done yet.
 * Empty when a prerequisite was not adopted, which blocks the task instead.
 */
export function waitingPrerequisites(task: Task, byId: ReadonlyMap<TaskId, Task>): TaskId[] {
  if (task.status !== "planned" || task.dependsOn.some((id) => isNotAdopted(byId.get(id)))) {
    return [];
  }
  return task.dependsOn.filter((id) => byId.get(id)?.status !== "done");
}

/**
 * What is wrong with the base freshness of a branch, as phrases such as "3 commits behind main",
 * or null when it is up to date with its base and its pull request does not conflict.
 */
export function freshnessWarning(freshness: BranchFreshness): string | null {
  const conflicting = freshness.mergeable === "conflicting";
  if (freshness.behind === 0 && !conflicting) {
    return null;
  }
  const parts: string[] = [];
  if (freshness.behind > 0) {
    parts.push(`${freshness.behind} ${freshness.behind === 1 ? "commit" : "commits"} behind ${freshness.base}`);
  }
  if (conflicting) {
    parts.push("pull request has merge conflicts");
  } else if (freshness.mergeable === "mergeable") {
    parts.push("no merge conflicts");
  }
  return parts.join("; ");
}

/** A planned task that was worked on before: it keeps its branch and worktree. */
export function isPaused(task: Task): boolean {
  return task.status === "planned" && (task.milestones.startedAt !== null || task.branch !== null);
}

/**
 * Whether paused `task` was paused by a new prerequisite: the server records the prerequisites
 * it waits on as a blocker note at the time of the pause.
 */
function pausedByPrerequisite(task: Task, pausedAt: Timestamp): boolean {
  return task.notes.some((note) => note.kind === "blocker" && note.at === pausedAt);
}

/**
 * Whether paused `task` waited on prerequisites that no longer block it: every prerequisite is
 * now done and adopted, and the pause came from a new prerequisite, which was completed since
 * or removed. A task paused by hand had its prerequisites done before it started.
 */
export function prerequisitesResolved(task: Task, byId: ReadonlyMap<TaskId, Task>): boolean {
  const pausedAt = task.milestones.pausedAt;
  return (
    isPaused(task) &&
    pausedAt !== null &&
    dependenciesDone(task, byId) &&
    (pausedByPrerequisite(task, pausedAt) ||
      task.dependsOn.some((id) => (byId.get(id)?.milestones.completedAt ?? -Infinity) >= pausedAt))
  );
}

/** A planned task that has never been worked on. */
function isPending(task: Task): boolean {
  return task.status === "planned" && !isPaused(task);
}

/**
 * When the last dependency of `task` was completed, if all of them are done and adopted; null
 * without dependencies or when one is not done, not adopted, or not in `byId`.
 */
function readyAt(task: Task, byId: ReadonlyMap<TaskId, Task>): Timestamp | null {
  const completed = task.dependsOn.map((id) => {
    const dependency = byId.get(id);
    return isNotAdopted(dependency) ? null : (dependency?.milestones.completedAt ?? null);
  });
  return completed.length === 0 || completed.includes(null) ? null : Math.max(...(completed as Timestamp[]));
}

export function edgeId(source: TaskId, target: TaskId): string {
  return `${source}->${target}`;
}

/** Dependency edges among `tasks`; dependencies on tasks outside the list are skipped. */
export function dependencyEdges(tasks: Task[]): DependencyEdge[] {
  const ids = new Set(tasks.map((task) => task.id));
  return tasks.flatMap((task) =>
    task.dependsOn
      .filter((dependency) => ids.has(dependency))
      .map((dependency) => ({ id: edgeId(dependency, task.id), source: dependency, target: task.id })),
  );
}

/**
 * Whether `target` may gain a dependency on `source`. Cycles are left to the backend,
 * which owns the DAG rules and reports them as a command error.
 */
export function canAddDependency(tasks: Task[], source: TaskId, target: TaskId): boolean {
  if (source === target) {
    return false;
  }
  const from = tasks.find((task) => task.id === source);
  const to = tasks.find((task) => task.id === target);
  return (
    from !== undefined &&
    to !== undefined &&
    dependencyEditableStatuses.includes(to.status) &&
    !to.dependsOn.includes(source)
  );
}

/**
 * `id` with every task it transitively depends on and every task that transitively depends
 * on it, among `tasks`.
 */
export function relatedTasks(tasks: Task[], id: TaskId): Set<TaskId> {
  const related = new Set<TaskId>([id]);
  const walk = (next: (current: TaskId) => TaskId[]) => {
    const pending = [id];
    const seen = new Set<TaskId>([id]);
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      for (const other of next(current)) {
        if (!seen.has(other)) {
          seen.add(other);
          related.add(other);
          pending.push(other);
        }
      }
    }
  };
  const byId = new Map(tasks.map((task) => [task.id, task]));
  walk((current) => byId.get(current)?.dependsOn.filter((other) => byId.has(other)) ?? []);
  walk((current) => tasks.filter((task) => task.dependsOn.includes(current)).map((task) => task.id));
  return related;
}

export type TimelineScale = "hour" | "day" | "week" | "month";

export const timelineScales: TimelineScale[] = ["hour", "day", "week", "month"];

export const pixelsPerDay: Record<TimelineScale, number> = { hour: 960, day: 48, week: 12, month: 3 };

/**
 * Width of the bar of a task that has not started and has no estimate: it has no duration yet,
 * only a place in line. An estimated one is as long as its estimate, but never narrower.
 */
export const timelinePendingWidth = 28;
/** Room kept at the right end of the axis for the label of a narrow bar, which spills past it. */
const timelineLabelRoom = 120;
/** Narrowest bar drawn for a task that has started, so a short task stays visible. */
export const timelineBarMinWidth = 4;
/** Horizontal space kept between a prerequisite's bar and a waiting dependent's bar. */
export const timelineBarGap = 16;
/** Length of the straight runs where a dependency line leaves a bar and enters the next one. */
export const timelineEdgeStub = 8;

type Point = { x: number; y: number };

/**
 * SVG path of a dependency line on the timeline, from the right end of the prerequisite's bar
 * (`source`) to the left end of the dependent's bar (`target`), like a finish-to-start link in
 * a Gantt chart. It leaves to the right, drops into the gap above the target's row, runs along
 * that gap (backwards when the dependent started before the stub's end, as when it started the
 * moment its prerequisite finished), drops to the target and enters it from the left. Every
 * segment stays visible however close the bars are in time; `rowHeight` is the distance
 * between row centers.
 */
export function timelineEdgePath(source: Point, target: Point, rowHeight: number): string {
  const out = source.x + timelineEdgeStub;
  const into = target.x - timelineEdgeStub;
  const gap = target.y - rowHeight / 2;
  return `M ${source.x} ${source.y} H ${out} V ${gap} H ${into} V ${target.y} H ${target.x}`;
}

/** A half-open time range `[start, end)`, in Unix seconds. */
export type Period = { start: Timestamp; end: Timestamp };

export type TimelinePhase = "in_progress" | "in_review";

/** Narrowest pause, in pixels, that cuts a bar in two; a shorter one stays inside its block. */
export const timelinePauseMinWidth = 6;

/** A horizontal stretch of a bar, relative to the bar's `x`. */
export type TimelineSpan = { x: number; width: number };

export type TimelineBar = {
  task: Task;
  /** Row of the bar; every task has its own row, prerequisites above their dependents. */
  row: number;
  x: number;
  width: number;
  /** The task has never started, so its bar waits at the current time (or after its prerequisites). */
  pending: boolean;
  /** Phases in time order, positioned relative to `x` at true scale; a phase may repeat after a pause. */
  phases: { phase: TimelinePhase; x: number; width: number }[];
  /** The solid stretches of the bar, between its pauses; one for a bar without any. */
  blocks: TimelineSpan[];
  /**
   * The pauses cut out of the bar, drawn as dashed lines. A paused task's last one runs
   * past the bar's end, from its pause to now.
   */
  pauses: TimelineSpan[];
  /** The wait before the bar, from `plannedAt` to `x`; null when there was none. */
  lead: TimelineLead | null;
  /** The end of the due day relative to `x`; null without a due date or when it is off the axis. */
  dueX: number | null;
  /** How the task stands against its due date; null without one. */
  dueState: DueState | null;
};

/** Positions relative to the bar's `x`, so all of them are negative. */
export type TimelineLead = {
  /** Left end of the wait: `plannedAt`, or the left edge of the axis when it is earlier. */
  x: number;
  /** Whether `plannedAt` itself is on the axis and gets a marker. */
  planned: boolean;
  /** When the last prerequisite was done, if that happened after `plannedAt` during the wait. */
  readyX: number | null;
};

export type TimelineTick = { at: Timestamp; x: number; label: string };

/** A coarse tick and the right end of the unit it labels. */
export type TimelineMajorTick = TimelineTick & { right: number };

export type TimelineLayout = {
  bars: TimelineBar[];
  /** Tasks that started or closed without a known time, listed beside the timeline. */
  unplaced: Task[];
  rows: number;
  start: Timestamp;
  end: Timestamp;
  width: number;
  scale: TimelineScale;
  /** The period the axis is limited to; null when it runs without end in both directions. */
  period: Period | null;
  /** Position of the current time, or null when it falls outside the range. */
  nowX: number | null;
};

const day = 24 * 60 * 60;

/**
 * The interval a task's bar covers. A task that has never started sits at `now`; a task
 * being worked on runs from `startedAt` to `now`; a done or paused task ends at
 * `completedAt` or `pausedAt`. Null when a started task lacks the milestones to place it.
 */
export function taskInterval(task: Task, now: Timestamp): Period | null {
  const { plannedAt, startedAt, reviewAt, completedAt, pausedAt } = task.milestones;
  if (isPending(task)) {
    return { start: now, end: now };
  }
  const started = startedAt ?? reviewAt;
  if (task.status === "in_progress" || task.status === "in_review") {
    return started === null ? null : { start: Math.min(started, now), end: now };
  }
  // A done or paused task without its closing milestone ends at its last known one.
  const known = [plannedAt, startedAt, reviewAt].filter((at): at is Timestamp => at !== null);
  const end = (task.status === "done" ? completedAt : pausedAt) ?? (known.length > 0 ? Math.max(...known) : null);
  if (end === null) {
    return null;
  }
  return { start: Math.min(started ?? end, end), end };
}

/**
 * The phases of a bar covering `[start, end)`, from the status history; a task without
 * recorded history falls back to its milestones, which know nothing about pauses.
 */
function taskPhases(task: Task, { start, end }: Period): { phase: WorkState; start: Timestamp; end: Timestamp }[] {
  const segments = workSegments(task.timeline);
  const { reviewAt } = task.milestones;
  const phases: { phase: WorkState; start: Timestamp; end: Timestamp }[] =
    segments.length > 0
      ? segments.map((segment) => ({ phase: segment.state, start: segment.start, end: segment.end ?? end }))
      : [
          { phase: "in_progress", start, end: reviewAt ?? end },
          { phase: "in_review", start: reviewAt ?? end, end },
        ];
  return phases
    .map((phase) => ({ ...phase, start: Math.max(phase.start, start), end: Math.min(phase.end, end) }))
    .filter((phase) => phase.end > phase.start);
}

function taskLead(
  task: Task,
  readyAt: Timestamp | null,
  x: number,
  start: Timestamp,
  scaleX: (at: Timestamp) => number,
): TimelineLead | null {
  const { plannedAt } = task.milestones;
  if (plannedAt === null || scaleX(Math.max(plannedAt, start)) >= x) {
    return null;
  }
  const leadX = scaleX(Math.max(plannedAt, start));
  const ready = readyAt !== null && readyAt > plannedAt && readyAt >= start ? scaleX(readyAt) : null;
  return {
    x: leadX - x,
    planned: plannedAt >= start,
    readyX: ready !== null && ready < x ? ready - x : null,
  };
}

/** The stretches of `[0, width)` left between `pauses`, which are in order and do not overlap. */
function barBlocks(width: number, pauses: TimelineSpan[]): TimelineSpan[] {
  const blocks: TimelineSpan[] = [];
  let from = 0;
  for (const pause of pauses) {
    if (pause.x > from) {
      blocks.push({ x: from, width: Math.min(pause.x, width) - from });
    }
    from = Math.max(from, pause.x + pause.width);
  }
  if (from < width) {
    blocks.push({ x: from, width: width - from });
  }
  return blocks;
}

type Placed = { task: Task; interval: Period };

/**
 * Orders tasks so that every task comes after the tasks it depends on; among the tasks
 * whose prerequisites are all placed, the earliest start (then the lowest id) goes first.
 */
function dependencyOrder(placed: Placed[]): Placed[] {
  const ids = new Set(placed.map(({ task }) => task.id));
  const remaining = new Map(placed.map(({ task }) => [task.id, task.dependsOn.filter((id) => ids.has(id)).length]));
  const compare = (a: Placed, b: Placed) => a.interval.start - b.interval.start || a.task.id - b.task.id;
  const done = new Set<TaskId>();
  const ordered: Placed[] = [];
  let available = placed.filter(({ task }) => remaining.get(task.id) === 0);
  while (ordered.length < placed.length) {
    if (available.length === 0) {
      // Only reachable with a cycle, which the backend rejects; fall back to time order.
      available = [placed.filter(({ task }) => !done.has(task.id)).sort(compare)[0]];
    }
    available.sort(compare);
    const next = available.shift()!;
    ordered.push(next);
    done.add(next.task.id);
    for (const item of placed) {
      if (!done.has(item.task.id) && item.task.dependsOn.includes(next.task.id)) {
        const left = remaining.get(item.task.id)! - 1;
        remaining.set(item.task.id, left);
        if (left === 0) {
          available.push(item);
        }
      }
    }
  }
  return ordered;
}

const pad = (value: number) => String(value).padStart(2, "0");

type TickUnit = "hour" | "day" | "week" | "month" | "year";

const tickUnits: Record<TimelineScale, { minor: TickUnit; major: TickUnit }> = {
  hour: { minor: "hour", major: "day" },
  day: { minor: "day", major: "month" },
  week: { minor: "week", major: "month" },
  month: { minor: "month", major: "year" },
};

const minorLabels: Record<TickUnit, (date: Date) => string> = {
  hour: (date) => `${pad(date.getHours())}:00`,
  day: (date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
  week: (date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
  month: (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`,
  year: (date) => String(date.getFullYear()),
};

const majorLabels: Record<TickUnit, (date: Date) => string> = {
  ...minorLabels,
  day: (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
};

/** The local start of the `unit` containing `at`: its hour, midnight, Monday, first of the month, or New Year. */
function startOfUnit(at: Timestamp, unit: TickUnit): Date {
  const date = new Date(at * 1000);
  date.setMinutes(0, 0, 0);
  if (unit !== "hour") {
    date.setHours(0);
  }
  if (unit === "week") {
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  } else if (unit === "month") {
    date.setDate(1);
  } else if (unit === "year") {
    date.setMonth(0, 1);
  }
  return date;
}

/** Moves `date` forward to the start of the next `unit`; `date` must be at the start of one. */
function nextUnit(date: Date, unit: TickUnit): void {
  if (unit === "hour") {
    date.setHours(date.getHours() + 1);
  } else if (unit === "day") {
    date.setDate(date.getDate() + 1);
  } else if (unit === "week") {
    date.setDate(date.getDate() + 7);
  } else if (unit === "month") {
    date.setMonth(date.getMonth() + 1);
  } else {
    date.setFullYear(date.getFullYear() + 1);
  }
}

/**
 * The local starts of every `unit` (hours, midnights, Mondays, firsts of the month, or New
 * Year) that overlaps `[from, to)`, including the one already under way at `from`.
 */
function unitStarts(from: Timestamp, to: Timestamp, unit: TickUnit): Date[] {
  const starts: Date[] = [];
  for (const date = startOfUnit(from, unit); date.getTime() / 1000 < to; nextUnit(date, unit)) {
    starts.push(new Date(date));
  }
  return starts;
}

/**
 * Ticks of the axis header between the flow positions `from` and `to`, usually the part on
 * screen. Without a period the axis has no ends, so any range gets ticks; with one, ticks
 * stop at its edges and a coarse unit that crosses an edge is cut there.
 */
export function timelineAxis(
  layout: TimelineLayout,
  from: number,
  to: number,
): { ticks: TimelineTick[]; majorTicks: TimelineMajorTick[] } {
  const perDay = pixelsPerDay[layout.scale];
  const xAt = (at: Timestamp) => ((at - layout.start) / day) * perDay;
  let fromAt = layout.start + (from / perDay) * day;
  let toAt = layout.start + (to / perDay) * day;
  if (layout.period !== null) {
    fromAt = Math.max(fromAt, layout.period.start);
    toAt = Math.min(toAt, layout.period.end);
  }
  const { minor, major } = tickUnits[layout.scale];
  const ticks = unitStarts(fromAt, toAt, minor)
    .filter((date) => date.getTime() / 1000 >= fromAt)
    .map((date) => ({ at: date.getTime() / 1000, x: xAt(date.getTime() / 1000), label: minorLabels[minor](date) }));
  const majorTicks = unitStarts(fromAt, toAt, major).map((date): TimelineMajorTick => {
    const next = new Date(date);
    nextUnit(next, major);
    let at = date.getTime() / 1000;
    let end = next.getTime() / 1000;
    if (layout.period !== null) {
      at = Math.max(at, layout.period.start);
      end = Math.min(end, layout.period.end);
    }
    return { at, x: xAt(at), right: xAt(end), label: majorLabels[major](date) };
  });
  return { ticks, majorTicks };
}

/** Generous width of an axis header label in its 10px font, left padding included. */
export function axisLabelWidth(text: string): number {
  return text.length * 6 + 6;
}

/**
 * Where the label of a major tick starts, relative to the tick, or null to leave it out. The
 * label of a period that began left of the screen (`viewLeft`) stays at the screen's left edge,
 * and a label that would run into the Now label (`now`) moves past it; either way it must still
 * fit inside its period, or it would be cut off at the edge or collide with the next one.
 */
export function majorLabelOffset(
  tick: TimelineMajorTick,
  width: number,
  viewLeft: number,
  now: { x: number; width: number } | null,
): number | null {
  let left = Math.max(tick.x, viewLeft);
  if (now !== null && left < now.x + now.width && left + width > now.x) {
    left = now.x + now.width;
  }
  return left + width > tick.right ? null : left - tick.x;
}

/**
 * Lays tasks out as a Gantt chart: one row per task, prerequisites before their dependents.
 * A task that has not started waits at `now`, pushed right past the bars of its unfinished
 * prerequisites; a started task is fixed at `startedAt` and grows with `now`; a closed
 * task is fixed at both ends. With a `period`, only tasks overlapping it are drawn, clipped
 * to it; otherwise the axis has no ends, and `start` and `end` only span the days with a
 * bar. The scale sets the pixels per day and the tick units of `timelineAxis`.
 */
export function layoutTimeline(
  tasks: Task[],
  { now, scale, period }: { now: Timestamp; scale: TimelineScale; period: Period | null },
): TimelineLayout {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const unplaced: Task[] = [];
  const placed: Placed[] = [];
  for (const task of tasks) {
    const interval = taskInterval(task, now);
    if (interval === null) {
      unplaced.push(task);
    } else if (period === null || (interval.start < period.end && interval.end >= period.start)) {
      placed.push({ task, interval });
    }
  }

  let start: Timestamp;
  let end: Timestamp;
  if (period !== null) {
    ({ start, end } = period);
  } else {
    const first = placed.map(({ task, interval }) => Math.min(interval.start, task.milestones.plannedAt ?? interval.start));
    const dueEnds = placed.flatMap(({ task }) => (task.dueDate === null ? [] : [dueEnd(task.dueDate)]));
    start = startOfUnit(Math.min(now, ...first, ...dueEnds.map((at) => at - day)), "day").getTime() / 1000;
    const last = Math.max(now, ...placed.map(({ interval }) => interval.end), ...dueEnds.map((at) => at - 1));
    const endDay = startOfUnit(last, "day");
    nextUnit(endDay, "day");
    end = endDay.getTime() / 1000;
  }
  const scaleX = (at: Timestamp) => ((at - start) / day) * pixelsPerDay[scale];

  const rightEdges = new Map<TaskId, number>();
  const bars = dependencyOrder(placed).map(({ task, interval }, row): TimelineBar => {
    const clipped = { start: Math.max(interval.start, start), end: Math.min(interval.end, end) };
    const pending = isPending(task);
    let x: number;
    let width: number;
    let phases: TimelineBar["phases"] = [];
    let pauses: TimelineSpan[] = [];
    if (pending) {
      const after = task.dependsOn.flatMap((id) => {
        // A finished prerequisite no longer holds the task back, so it stays at `now`.
        const dependency = byId.get(id);
        if (dependency?.status === "done" && !isNotAdopted(dependency)) {
          return [];
        }
        const edge = rightEdges.get(id);
        return edge === undefined ? [] : [edge + timelineBarGap];
      });
      x = Math.max(scaleX(clipped.start), ...after);
      const estimate = estimatedSeconds(task.estimate);
      width = Math.max(estimate === null ? 0 : (estimate / day) * pixelsPerDay[scale], timelinePendingWidth);
    } else {
      x = scaleX(clipped.start);
      width = Math.max(scaleX(clipped.end) - x, timelineBarMinWidth);
      for (const phase of taskPhases(task, clipped)) {
        const span = { x: scaleX(phase.start) - x, width: scaleX(phase.end) - scaleX(phase.start) };
        if (phase.phase !== "paused") {
          phases.push({ phase: phase.phase, ...span });
        } else if (span.width >= timelinePauseMinWidth) {
          pauses.push(span);
        }
      }
      const pausedUntil = scaleX(Math.min(now, end)) - x;
      if (isPaused(task) && pausedUntil - width >= timelinePauseMinWidth) {
        pauses = [...pauses, { x: width, width: pausedUntil - width }];
      }
    }
    rightEdges.set(task.id, x + width);
    const due = task.dueDate === null ? null : dueEnd(task.dueDate);
    return {
      task,
      row,
      x,
      width,
      pending,
      phases,
      blocks: barBlocks(width, pauses),
      pauses,
      lead: taskLead(task, readyAt(task, byId), x, start, scaleX),
      dueX: due !== null && due >= start && due <= end ? scaleX(due) - x : null,
      dueState: dueState(task, now),
    };
  });

  return {
    bars,
    unplaced,
    rows: bars.length,
    start,
    end,
    width: Math.max(scaleX(end), ...bars.map((bar) => bar.x + Math.max(bar.width, timelineLabelRoom))),
    scale,
    period,
    nowX: now >= start && now <= end ? scaleX(now) : null,
  };
}

export function yearPeriod(year: number): Period {
  return { start: new Date(year, 0, 1).getTime() / 1000, end: new Date(year + 1, 0, 1).getTime() / 1000 };
}

/** Calendar years from the first planned task to `now`, newest first. */
export function timelineYears(tasks: Task[], now: Timestamp): number[] {
  const last = new Date(now * 1000).getFullYear();
  const planned = tasks.flatMap((task) => (task.milestones.plannedAt === null ? [] : [task.milestones.plannedAt]));
  const first = new Date(Math.min(now, ...planned) * 1000).getFullYear();
  return Array.from({ length: last - first + 1 }, (_, index) => last - index);
}

/**
 * Where the timeline opens. Hour, Day and Week open on the newest work: the last row at the
 * bottom, the Now line at the left edge. Hour needs this most, since its axis is so wide that
 * the end of it, where Month opens, holds none of the work. Month fits the newest end on screen.
 */
export function openingViewport(
  layout: Pick<TimelineLayout, "scale" | "nowX" | "width">,
  panel: { visible: number; panel: number; height: number },
): { x: number; y: number; zoom: 1 } {
  if (layout.scale !== "month" && layout.nowX !== null) {
    return { x: 16 - layout.nowX, y: Math.min(0, panel.panel - panel.height - 8), zoom: 1 };
  }
  return { x: Math.min(16, panel.visible - layout.width - 16), y: 0, zoom: 1 };
}
