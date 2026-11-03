import { describe, expect, it } from "vitest";
import type { Task, TaskMilestones } from "@/lib/bindings";
import {
  canAddDependency,
  dependenciesDone,
  dependencyEdges,
  layoutTimeline,
  majorLabelOffset,
  openingViewport,
  relatedTasks,
  timelineAxis,
  timelineEdgePath,
  timelineYears,
  yearPeriod,
} from "@/lib/task-graph";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId: 1,
    taskType: "feat",
    title: `Task ${id}`,
    description: "",
    status: "planned",
    dependsOn: [],
    branch: null,
    worktreePath: null,
    worktreeMissing: false,
    herdrWorkspaceId: null,
    pullRequestUrl: null,
    issue: null,
    estimate: null,
    dueDate: null,
    pullRequestMergedAt: null,
    pullRequest: null,
    mergedWith: null,
    resolution: null,
    completionNote: null,
    notes: [],
    criteria: [],
    timeline: [],
    milestones: {
      plannedAt: null,
      startedAt: null,
      reviewAt: null,
      completedAt: null,
      reopenedAt: null,
      pausedAt: null,
      lastReviewAt: null,
      activeSeconds: 0,
      pauseCount: 0,
    },
    ...overrides,
  };
}

function jan(day: number, hour = 0): number {
  return new Date(2026, 0, day, hour).getTime() / 1000;
}

function milestones(values: Partial<TaskMilestones>): TaskMilestones {
  return { ...task(0).milestones, ...values };
}

describe("dependencyEdges", () => {
  it("draws edges from prerequisites and skips tasks outside the list", () => {
    const tasks = [task(1), task(2, { dependsOn: [1, 9] })];

    expect(dependencyEdges(tasks)).toEqual([{ id: "1->2", source: 1, target: 2 }]);
  });
});

describe("timelineEdgePath", () => {
  it("runs along the gap above the target row toward a later dependent", () => {
    expect(timelineEdgePath({ x: 100, y: 20 }, { x: 300, y: 60 }, 40)).toBe("M 100 20 H 108 V 40 H 292 V 60 H 300");
  });

  it("turns back for a dependent that started the moment its prerequisite finished", () => {
    expect(timelineEdgePath({ x: 100, y: 20 }, { x: 100, y: 60 }, 40)).toBe("M 100 20 H 108 V 40 H 92 V 60 H 100");
  });
});

describe("relatedTasks", () => {
  it("collects transitive prerequisites and dependents but not siblings", () => {
    // 1 -> 2 -> 3, 1 -> 4, 5 -> 3, 6 alone.
    const tasks = [
      task(1),
      task(2, { dependsOn: [1] }),
      task(3, { dependsOn: [2, 5] }),
      task(4, { dependsOn: [1] }),
      task(5),
      task(6),
    ];

    expect([...relatedTasks(tasks, 2)].sort()).toEqual([1, 2, 3]);
    expect([...relatedTasks(tasks, 1)].sort()).toEqual([1, 2, 3, 4]);
    expect([...relatedTasks(tasks, 6)]).toEqual([6]);
  });
});

describe("dependenciesDone", () => {
  it("waits for every prerequisite to be done and adopted", () => {
    const merged = task(1, { status: "done", resolution: "merged" });
    const notAdopted = task(2, { status: "done", resolution: "not_adopted" });
    const working = task(3, { status: "in_review" });
    const byId = new Map([merged, notAdopted, working].map((each) => [each.id, each]));

    expect(dependenciesDone(task(4, { dependsOn: [1] }), byId)).toBe(true);
    expect(dependenciesDone(task(5, { dependsOn: [1, 2] }), byId)).toBe(false);
    expect(dependenciesDone(task(6, { dependsOn: [3] }), byId)).toBe(false);
  });
});

describe("canAddDependency", () => {
  const tasks = [
    task(1, { status: "done" }),
    task(2, { status: "planned", dependsOn: [1] }),
    task(3, { status: "in_progress" }),
    task(4, { status: "in_review" }),
    task(5),
  ];

  it("allows a new dependency for a planned or in-progress task", () => {
    expect(canAddDependency(tasks, 3, 2)).toBe(true);
    expect(canAddDependency(tasks, 1, 5)).toBe(true);
    expect(canAddDependency(tasks, 5, 3)).toBe(true);
  });

  it("rejects self, duplicate, and locked edges", () => {
    expect(canAddDependency(tasks, 5, 5)).toBe(false);
    expect(canAddDependency(tasks, 1, 2)).toBe(false);
    expect(canAddDependency(tasks, 5, 4)).toBe(false);
    expect(canAddDependency(tasks, 5, 42)).toBe(false);
  });
});

describe("layoutTimeline", () => {
  const now = jan(11);
  const done = task(1, {
    status: "done",
    milestones: milestones({ plannedAt: jan(1), startedAt: jan(3), reviewAt: jan(5), completedAt: jan(6) }),
  });
  const open = task(2, {
    status: "in_progress",
    milestones: milestones({ plannedAt: jan(2, 12), startedAt: jan(4) }),
  });
  const waiting = task(3, { status: "planned", milestones: milestones({ plannedAt: jan(7) }) });
  const unknown = task(4, { status: "in_progress" });

  it("fixes a finished task from its start to its completion", () => {
    const layout = layoutTimeline([done], { now, scale: "day", period: null });

    expect(layout.start).toBe(jan(1));
    expect(layout.bars).toEqual([
      {
        task: done,
        row: 0,
        x: 2 * 48,
        width: 3 * 48,
        pending: false,
        phases: [
          { phase: "in_progress", x: 0, width: 2 * 48 },
          { phase: "in_review", x: 2 * 48, width: 48 },
        ],
        blocks: [{ x: 0, width: 3 * 48 }],
        pauses: [],
        lead: { x: -2 * 48, planned: true, readyX: null },
        dueX: null,
        dueState: null,
      },
    ]);
    expect(layout.nowX).toBe(10 * 48);
    const axis = timelineAxis(layout, 0, layout.width);
    expect(axis.ticks.slice(0, 2)).toEqual([
      { at: jan(1), x: 0, label: "01-01" },
      { at: jan(2), x: 48, label: "01-02" },
    ]);
    expect(axis.majorTicks).toEqual([{ at: jan(1), x: 0, right: 31 * 48, label: "2026-01" }]);
  });

  it("ends a started task at now and puts a task not started at now", () => {
    const layout = layoutTimeline([waiting, unknown, open, done], { now, scale: "day", period: null });

    const bars = new Map(layout.bars.map((bar) => [bar.task.id, bar]));
    expect(layout.bars.map((bar) => [bar.task.id, bar.row])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(bars.get(2)).toMatchObject({ x: 3 * 48, width: 7 * 48, pending: false });
    expect(bars.get(2)!.lead).toEqual({ x: -1.5 * 48, planned: true, readyX: null });
    expect(bars.get(2)!.phases).toEqual([{ phase: "in_progress", x: 0, width: 7 * 48 }]);
    expect(bars.get(3)).toMatchObject({ x: layout.nowX, width: 28, pending: true, phases: [] });
    expect(layout.rows).toBe(3);
    expect(layout.unplaced).toEqual([unknown]);
  });

  it("marks the end of the due day on a bar, widening the axis to reach it, and flags missed ones", () => {
    const late = { ...done, dueDate: "2026-01-04" };
    const overdue = { ...open, dueDate: "2026-01-09" };
    const ahead = { ...waiting, dueDate: "2026-01-20" };

    const layout = layoutTimeline([late, overdue, ahead], { now, scale: "day", period: null });

    const bars = new Map(layout.bars.map((bar) => [bar.task.id, bar]));
    expect(bars.get(1)).toMatchObject({ x: 2 * 48, dueX: 2 * 48, dueState: "late" });
    expect(bars.get(2)).toMatchObject({ x: 3 * 48, dueX: 6 * 48, dueState: "overdue" });
    expect(bars.get(3)).toMatchObject({ dueX: 20 * 48 - layout.nowX!, dueState: "upcoming" });
    expect(layout.end).toBe(jan(21));

    const clipped = layoutTimeline([ahead], { now, scale: "day", period: { start: jan(1), end: jan(15) } });
    expect(clipped.bars[0].dueX).toBeNull();
  });

  it("fixes a paused task from its start to its pause", () => {
    const paused = task(5, {
      branch: "feat/task-5-5",
      milestones: milestones({ plannedAt: jan(1), startedAt: jan(3), pausedAt: jan(5) }),
    });

    const layout = layoutTimeline([paused], { now, scale: "day", period: null });

    expect(layout.bars[0]).toMatchObject({
      x: 2 * 48,
      width: 2 * 48,
      pending: false,
      phases: [{ phase: "in_progress", x: 0, width: 2 * 48 }],
      blocks: [{ x: 0, width: 2 * 48 }],
      // The pause runs on past the bar to now.
      pauses: [{ x: 2 * 48, width: 6 * 48 }],
    });
  });

  it("cuts the bar of a resumed task at its pauses, between its stretches of work", () => {
    const resumed = task(6, {
      status: "done",
      branch: "feat/task-6-6",
      timeline: [
        { status: "planned", at: jan(1), reopened: false },
        { status: "in_progress", at: jan(2), reopened: false },
        { status: "planned", at: jan(3), reopened: false },
        { status: "in_progress", at: jan(5), reopened: false },
        { status: "in_review", at: jan(6), reopened: false },
        { status: "done", at: jan(7), reopened: false },
      ],
      milestones: milestones({ plannedAt: jan(1), startedAt: jan(2), reviewAt: jan(6), completedAt: jan(7) }),
    });

    const layout = layoutTimeline([resumed], { now, scale: "day", period: null });

    expect(layout.bars[0]).toMatchObject({ x: 48, width: 5 * 48 });
    expect(layout.bars[0].phases).toEqual([
      { phase: "in_progress", x: 0, width: 48 },
      { phase: "in_progress", x: 3 * 48, width: 48 },
      { phase: "in_review", x: 4 * 48, width: 48 },
    ]);
    expect(layout.bars[0].pauses).toEqual([{ x: 48, width: 2 * 48 }]);
    expect(layout.bars[0].blocks).toEqual([
      { x: 0, width: 48 },
      { x: 3 * 48, width: 2 * 48 },
    ]);
  });

  it("keeps a bar whole across a pause too short to see at its scale", () => {
    const resumed = task(7, {
      status: "done",
      branch: "feat/task-7-7",
      timeline: [
        { status: "in_progress", at: jan(2), reopened: false },
        { status: "planned", at: jan(3), reopened: false },
        { status: "in_progress", at: jan(4), reopened: false },
        { status: "done", at: jan(7), reopened: false },
      ],
      milestones: milestones({ plannedAt: jan(2), startedAt: jan(2), completedAt: jan(7) }),
    });

    const month = layoutTimeline([resumed], { now, scale: "month", period: null });
    const day = layoutTimeline([resumed], { now, scale: "day", period: null });

    expect(month.bars[0]).toMatchObject({ pauses: [], blocks: [{ x: 0, width: 5 * 3 }] });
    expect(day.bars[0].pauses).toEqual([{ x: 48, width: 48 }]);
  });

  it("moves bars that wait at now along with the current time", () => {
    const at = (time: number) => layoutTimeline([done, waiting], { now: time, scale: "hour", period: null });

    const before = at(jan(11, 9));
    const after = at(jan(11, 10));

    expect(after.nowX! - before.nowX!).toBeCloseTo(40);
    expect(before.bars[1].x).toBe(before.nowX);
    expect(after.bars[1].x).toBe(after.nowX);
    expect(after.bars[0]).toEqual(before.bars[0]);
    const axis = timelineAxis(after, 0, after.width);
    expect(axis.ticks.slice(0, 2).map((tick) => tick.label)).toEqual(["00:00", "01:00"]);
    expect(axis.majorTicks[0]).toEqual({ at: jan(1), x: 0, right: 960, label: "2026-01-01" });
  });

  it("keeps a ready bar at now right after its prerequisite is done", () => {
    const finished = task(1, {
      status: "done",
      milestones: milestones({ plannedAt: jan(9), startedAt: jan(10), completedAt: jan(11) }),
    });
    const ready = task(2, { dependsOn: [1], milestones: milestones({ plannedAt: jan(9) }) });
    const at = (time: number) => layoutTimeline([finished, ready], { now: time, scale: "day", period: null });

    const before = at(jan(11, 2));
    const after = at(jan(11, 4));

    expect(before.bars[1].x).toBe(before.nowX);
    expect(after.bars[1].x).toBe(after.nowX);
  });

  it("draws ticks anywhere on an axis without a period", () => {
    const layout = layoutTimeline([done], { now, scale: "day", period: null });
    const dec = (day: number) => new Date(2025, 11, day).getTime() / 1000;

    const before = timelineAxis(layout, -2 * 48, 0);
    expect(before.ticks.map((tick) => tick.label)).toEqual(["12-30", "12-31"]);
    expect(before.majorTicks).toEqual([{ at: dec(1), x: -31 * 48, right: 0, label: "2025-12" }]);

    const after = timelineAxis(layout, 40 * 48, 41 * 48);
    expect(after.ticks.map((tick) => tick.label)).toEqual(["02-10"]);
    expect(after.majorTicks.map((tick) => tick.label)).toEqual(["2026-02"]);
  });

  it("draws the wait from the planned time through the completion of the last prerequisite", () => {
    const blocked = task(9, {
      dependsOn: [1],
      milestones: milestones({ plannedAt: jan(2) }),
    });

    const layout = layoutTimeline([done, blocked], { now, scale: "day", period: null });

    expect(layout.bars[1]).toMatchObject({ x: 10 * 48, pending: true });
    expect(layout.bars[1].lead).toEqual({ x: -9 * 48, planned: true, readyX: -5 * 48 });
  });

  it("orders dependents after their prerequisites and queues waiting ones behind them", () => {
    const first = task(6, { status: "planned" });
    const second = task(5, { status: "planned", dependsOn: [6] });
    const third = task(7, { dependsOn: [5, 1] });
    const afterDone = task(8, { dependsOn: [1] });

    const layout = layoutTimeline([third, second, afterDone, first, done], { now, scale: "day", period: null });

    expect(layout.bars.map((bar) => bar.task.id)).toEqual([1, 6, 5, 7, 8]);
    const x = new Map(layout.bars.map((bar) => [bar.task.id, bar.x]));
    expect(x.get(6)).toBe(layout.nowX);
    expect(x.get(5)).toBe(layout.nowX! + 28 + 16);
    expect(x.get(7)).toBe(layout.nowX! + 2 * (28 + 16));
    expect(x.get(8)).toBe(layout.nowX);
  });

  it("draws a task not started as long as its estimate, but never narrower than one without", () => {
    const long = task(6, { status: "planned", estimate: { unit: "days", amount: 2 } });
    const short = task(5, { status: "planned", dependsOn: [6], estimate: { unit: "hours", amount: 1 } });
    const next = task(7, { status: "planned", dependsOn: [5] });

    const layout = layoutTimeline([long, short, next], { now, scale: "day", period: null });

    const bars = new Map(layout.bars.map((bar) => [bar.task.id, bar]));
    expect(bars.get(6)).toMatchObject({ x: layout.nowX, width: 2 * 48 });
    expect(bars.get(5)).toMatchObject({ x: layout.nowX! + 2 * 48 + 16, width: 28 });
    expect(bars.get(7)).toMatchObject({ x: layout.nowX! + 2 * 48 + 16 + 28 + 16, width: 28 });
  });

  it("narrows the axis to a period and clips the bars that cross it", () => {
    const crossing = task(7, {
      status: "in_progress",
      milestones: milestones({ plannedAt: new Date(2025, 11, 20).getTime() / 1000, startedAt: jan(2) }),
    });
    const before = task(8, {
      status: "done",
      milestones: milestones({
        plannedAt: new Date(2025, 5, 1).getTime() / 1000,
        startedAt: new Date(2025, 5, 1).getTime() / 1000,
        completedAt: new Date(2025, 5, 2).getTime() / 1000,
      }),
    });

    const layout = layoutTimeline([crossing, before], { now, scale: "month", period: yearPeriod(2026) });

    expect(layout.bars.map((bar) => bar.task.id)).toEqual([7]);
    expect(layout.bars[0].x).toBe(3);
    expect(layout.bars[0].phases).toEqual([{ phase: "in_progress", x: 0, width: 27 }]);
    expect(layout.bars[0].lead).toEqual({ x: -3, planned: false, readyX: null });
    const axis = timelineAxis(layout, -100, 2000);
    expect(axis.ticks.map((tick) => tick.label)).toEqual(
      Array.from({ length: 12 }, (_, month) => `2026-${String(month + 1).padStart(2, "0")}`),
    );
    expect(axis.majorTicks).toEqual([{ at: jan(1), x: 0, right: 365 * 3, label: "2026" }]);
  });
});

describe("majorLabelOffset", () => {
  const tick = { at: 0, x: 0, right: 400, label: "2026-10" };

  it("keeps the label of a period that began off screen at the left edge", () => {
    expect(majorLabelOffset(tick, 50, -100, null)).toBe(0);
    expect(majorLabelOffset(tick, 50, 120, null)).toBe(120);
  });

  it("leaves out a label that would be cut off where its period ends", () => {
    expect(majorLabelOffset(tick, 50, 360, null)).toBeNull();
  });

  it("moves a label that would run into the Now label past it", () => {
    expect(majorLabelOffset(tick, 50, 120, { x: 136, width: 60 })).toBe(196);
    expect(majorLabelOffset(tick, 50, 120, { x: 300, width: 60 })).toBe(120);
  });

  it("leaves out a label that has no room left after the Now label", () => {
    expect(majorLabelOffset(tick, 50, 120, { x: 320, width: 60 })).toBe(120);
    expect(majorLabelOffset(tick, 50, 300, { x: 316, width: 60 })).toBeNull();
  });
});

describe("openingViewport", () => {
  const panel = { visible: 1000, panel: 400, height: 600 };

  it("opens Hour, Day and Week with Now at the left edge and the last row at the bottom", () => {
    for (const scale of ["hour", "day", "week"] as const) {
      expect(openingViewport({ scale, nowX: 50000, width: 96000 }, panel)).toEqual({ x: 16 - 50000, y: -208, zoom: 1 });
    }
  });

  it("opens Month on the newest end of the axis", () => {
    expect(openingViewport({ scale: "month", nowX: 200, width: 3000 }, panel)).toEqual({ x: -2016, y: 0, zoom: 1 });
  });

  it("falls back to the newest end of the axis when Now is outside it", () => {
    expect(openingViewport({ scale: "hour", nowX: null, width: 96000 }, panel)).toEqual({ x: -95016, y: 0, zoom: 1 });
  });
});

describe("timelineYears", () => {
  it("lists years from the first planned task to now, newest first", () => {
    const tasks = [task(1, { milestones: milestones({ plannedAt: new Date(2024, 6, 1).getTime() / 1000 }) }), task(2)];

    expect(timelineYears(tasks, jan(11))).toEqual([2026, 2025, 2024]);
    expect(timelineYears([], jan(11))).toEqual([2026]);
  });
});
