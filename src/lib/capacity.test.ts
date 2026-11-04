import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@/lib/bindings";
import { formatWork, loadCapacity, planLoad, saveCapacity } from "@/lib/capacity";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    workspaceId: 1,
    taskType: "feat",
    title: "Add storage",
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
    labels: [],
    pullRequestMergedAt: null,
    pullRequest: null,
    mergedWith: null,
    resolution: null,
    completionNote: null,
    notes: [],
    criteria: [],
    timeline: [],
    milestones: { plannedAt: null, startedAt: null, reviewAt: null, completedAt: null, reopenedAt: null, pausedAt: null, lastReviewAt: null, activeSeconds: 0, pauseCount: 0 },
    ...overrides,
  };
}

const week = 7 * 24 * 3600;

describe("planLoad", () => {
  const tasks = [
    task({ id: 1, dueDate: "2026-11-20", estimate: { unit: "weeks", amount: 2 } }),
    task({ id: 2, dueDate: "2026-12-31", estimate: { unit: "days", amount: 7 }, status: "done", resolution: "merged" }),
    task({ id: 3, dueDate: "2027-02-01", estimate: { unit: "weeks", amount: 5 } }),
    task({ id: 4, dueDate: "2027-05-10" }),
    task({ id: 5, dueDate: "2026-10-01", estimate: { unit: "weeks", amount: 9 }, status: "done", resolution: "not_adopted" }),
    task({ id: 6, estimate: { unit: "weeks", amount: 1 } }),
  ];

  it("sums estimates per quarter of the due date and flags quarters over capacity", () => {
    const { periods, unscheduled, unscheduledEstimated } = planLoad(tasks, "quarter", { unit: "weeks", amount: 4 }, "2026-11-05");
    expect(periods.map((load) => [load.label, load.estimated / week, load.overloaded])).toEqual([
      ["2026 Q4", 3, false],
      ["2027 Q1", 5, true],
      ["2027 Q2", 0, false],
    ]);
    expect(periods[0].done).toBe(week);
    expect(periods[0].capacity).toBe(4 * week);
    expect(periods[2].unestimated).toBe(1);
    expect(unscheduled.map((entry) => entry.id)).toEqual([6]);
    expect(unscheduledEstimated).toBe(week);
  });

  it("gives a year four quarters of capacity", () => {
    const { periods } = planLoad(tasks, "year", { unit: "weeks", amount: 1 }, "2026-11-05");
    expect(periods.map((load) => [load.label, load.estimated / week, load.capacity! / week, load.overloaded])).toEqual([
      ["2026", 3, 4, false],
      ["2027", 5, 4, true],
    ]);
  });

  it("shows the current period and every period up to it without capacity", () => {
    const { periods } = planLoad([task({ dueDate: "2026-02-01", estimate: { unit: "hours", amount: 3 } })], "quarter", null, "2026-08-01");
    expect(periods.map((load) => [load.label, load.overloaded, load.capacity])).toEqual([
      ["2026 Q1", false, null],
      ["2026 Q2", false, null],
      ["2026 Q3", false, null],
    ]);
  });
});

describe("formatWork", () => {
  it("writes seconds in the given unit", () => {
    expect(formatWork(10 * 24 * 3600, "weeks")).toBe("1.43w");
  });
});

describe("capacity storage", () => {
  afterEach(() => localStorage.clear());

  it("reads back a saved capacity and nothing after it is cleared", () => {
    saveCapacity({ unit: "days", amount: 40 });
    expect(loadCapacity()).toEqual({ unit: "days", amount: 40 });
    saveCapacity(null);
    expect(loadCapacity()).toBeNull();
  });

  it("ignores a saved value that is not a capacity", () => {
    for (const saved of ["{", '{"unit":"years","amount":3}', '{"unit":"days","amount":-1}', "12"]) {
      localStorage.setItem("toodo-plan-capacity", saved);
      expect(loadCapacity()).toBeNull();
    }
  });
});
