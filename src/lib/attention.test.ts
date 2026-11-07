import { describe, expect, it } from "vitest";
import { needsAttention, openBlocker } from "@/lib/attention";
import type { Task, TaskEvent, TaskNote, TaskStatus } from "@/lib/bindings";

function task(id: number, status: TaskStatus, notes: TaskNote["kind"][] = [], timeline: TaskEvent[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    status,
    notes: notes.map((kind, at) => ({ kind, body: kind, at })),
    timeline,
    dependsOn: [],
    milestones: { plannedAt: null, startedAt: null, reviewAt: null, completedAt: null, pausedAt: null },
  } as unknown as Task;
}

const summary = (items: ReturnType<typeof needsAttention>) =>
  items.map((item) => ({ id: item.task.id, reasons: item.reasons }));

describe("needsAttention", () => {
  const day = 24 * 60 * 60;
  const started = (at: number): TaskEvent[] => [{ status: "in_progress", at, reopened: false, reason: null }];

  it("collects blocker notes and stalled in-progress tasks, blockers first", () => {
    const now = 30 * day;
    const blocked = (id: number, at: number) =>
      ({ ...task(id, "in_progress", [], started(at - day)), notes: [{ kind: "blocker", body: "", at }] }) as Task;
    const tasks = [task(1, "in_progress", [], started(now - 8 * day)), blocked(2, now - day), blocked(3, now - 10 * day)];
    expect(summary(needsAttention(tasks, now))).toEqual([
      { id: 2, reasons: ["blocker_note"] },
      { id: 3, reasons: ["blocker_note", "stalled"] },
      { id: 1, reasons: ["stalled"] },
    ]);
  });

  it("leaves out resolved blockers, finished tasks, recent activity, and tasks that are not in progress", () => {
    const now = 30 * day;
    const tasks = [
      task(1, "in_progress", ["blocker", "progress"], started(now - day)),
      task(2, "done", ["blocker"]),
      task(3, "planned", [], started(now - 20 * day)),
      task(4, "in_review", [], started(now - 20 * day)),
      task(5, "in_progress", [], started(now - 6 * day)),
      task(6, "in_progress"),
    ];
    expect(needsAttention(tasks, now)).toEqual([]);
  });

  it("counts a recent note as activity", () => {
    const now = 30 * day;
    const noted = { ...task(1, "in_progress", [], started(now - 20 * day)), notes: [{ kind: "progress", body: "", at: now - day }] } as Task;
    expect(needsAttention([noted], now)).toEqual([]);
  });

  it("keeps a paused task whose latest note is a blocker", () => {
    expect(summary(needsAttention([task(1, "planned", ["blocker"])], 0))).toEqual([
      { id: 1, reasons: ["blocker_note"] },
    ]);
  });
});

describe("openBlocker", () => {
  it("ends the blocker a pause recorded once the task is resumed after it", () => {
    // The blocker note is at 0, written with the pause.
    const paused = [
      { status: "in_progress" as const, at: -10, reopened: false, reason: null },
      { status: "planned" as const, at: 0, reopened: false, reason: null },
    ];
    expect(openBlocker(task(1, "planned", ["blocker"], paused), new Map())?.kind).toBe("blocker");
    expect(
      openBlocker(task(1, "in_progress", ["blocker"], [...paused, { status: "in_progress", at: 5, reopened: false, reason: null }]), new Map()),
    ).toBeNull();
    // A blocker reported while the task was already in progress stays open.
    expect(openBlocker(task(2, "in_progress", ["blocker"], [{ status: "in_progress", at: -10, reopened: false, reason: null }]), new Map())?.kind).toBe(
      "blocker",
    );
  });

  it("ends the blocker of a pause by a prerequisite once nothing blocks the task", () => {
    const paused = (dependsOn: number[]): Task => ({
      ...task(1, "planned", ["blocker"]),
      dependsOn,
      milestones: { plannedAt: -20, startedAt: -10, reviewAt: null, completedAt: null, pausedAt: 0, reopenedAt: null, lastReviewAt: null, activeSeconds: 10, pauseCount: 1 },
    });
    const prerequisite = task(2, "planned");
    const byId = new Map([[2, prerequisite]]);
    expect(openBlocker(paused([2]), byId)?.kind).toBe("blocker");
    // The dependency was removed.
    expect(openBlocker(paused([]), byId)).toBeNull();
  });
});