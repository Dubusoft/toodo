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
    branch: null,
    milestones: { plannedAt: null, startedAt: null, reviewAt: null, completedAt: null, pausedAt: null },
  } as unknown as Task;
}

const summary = (items: ReturnType<typeof needsAttention>) =>
  items.map((item) => ({ id: item.task.id, reasons: item.reasons }));

describe("needsAttention", () => {
  it("collects blocked agents, blocker notes, failed CI and requested changes, most urgent first", () => {
    const tasks = [
      task(1, "in_review"),
      task(2, "in_progress", ["progress", "blocker"]),
      task(3, "in_review"),
      task(4, "in_progress"),
      task(5, "in_review", ["blocker"]),
    ];
    const items = needsAttention(
      tasks,
      [
        { taskId: 4, status: "blocked" },
        { taskId: 5, status: "blocked" },
      ],
      [
        { taskId: 1, checks: "passing", review: "changes_requested" },
        { taskId: 3, checks: "failing", review: "pending" },
        { taskId: 5, checks: "failing", review: "approved" },
      ],
    );
    expect(summary(items)).toEqual([
      { id: 4, reasons: ["agent_blocked"] },
      { id: 5, reasons: ["agent_blocked", "blocker_note", "ci_failed"] },
      { id: 2, reasons: ["blocker_note"] },
      { id: 3, reasons: ["ci_failed"] },
      { id: 1, reasons: ["changes_requested"] },
    ]);
    expect(items[0].agentStatus).toBe("blocked");
  });

  it("leaves out resolved blockers, finished tasks, and stale statuses", () => {
    const tasks = [
      task(1, "in_progress", ["blocker", "progress"]),
      task(2, "done", ["blocker"]),
      task(3, "planned"),
      task(4, "in_progress"),
      task(5, "in_progress"),
    ];
    const items = needsAttention(
      tasks,
      [
        { taskId: 3, status: "blocked" },
        { taskId: 5, status: "working" },
      ],
      [{ taskId: 4, checks: "failing", review: "changes_requested" }],
    );
    expect(items).toEqual([]);
  });

  it("keeps a paused task whose latest note is a blocker", () => {
    expect(summary(needsAttention([task(1, "planned", ["blocker"])], [], []))).toEqual([
      { id: 1, reasons: ["blocker_note"] },
    ]);
  });
});

describe("openBlocker", () => {
  it("ends the blocker a pause recorded once the task is resumed after it", () => {
    // The blocker note is at 0, written with the pause.
    const paused = [
      { status: "in_progress" as const, at: -10, reopened: false },
      { status: "planned" as const, at: 0, reopened: false },
    ];
    expect(openBlocker(task(1, "planned", ["blocker"], paused), new Map())?.kind).toBe("blocker");
    expect(
      openBlocker(task(1, "in_progress", ["blocker"], [...paused, { status: "in_progress", at: 5, reopened: false }]), new Map()),
    ).toBeNull();
    // A blocker reported while the task was already in progress stays open.
    expect(openBlocker(task(2, "in_progress", ["blocker"], [{ status: "in_progress", at: -10, reopened: false }]), new Map())?.kind).toBe(
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
