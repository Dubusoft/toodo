import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/bindings";
import { emptyTaskFilter, groupTasks, isFilterActive, matchesFilter, toggleStatus, type TaskFilter } from "@/lib/task-filter";

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

const noTasks = new Map<number, Task>();

describe("groupTasks", () => {
  it("puts tasks needing attention first, then active, ready, planned, and finished work", () => {
    const tasks = [
      task({ id: 1, status: "done", resolution: "merged" }),
      task({ id: 2, status: "done", resolution: "not_adopted" }),
      task({ id: 3, status: "planned" }),
      task({ id: 4, status: "planned", dependsOn: [6] }),
      task({ id: 5, status: "planned", branch: "feat/paused-5", dependsOn: [6] }),
      task({ id: 6, status: "in_progress" }),
      task({ id: 7, status: "in_review" }),
      task({ id: 8, status: "in_progress" }),
      task({ id: 9, status: "in_review" }),
    ];
    const byId = new Map(tasks.map((each) => [each.id, each]));
    const groups = groupTasks(tasks, byId, [9, 8]);
    expect(groups.map(({ group, tasks }) => [group, tasks.map((each) => each.id)])).toEqual([
      ["attention", [9, 8]],
      ["in_progress", [6]],
      ["in_review", [7]],
      ["ready", [3]],
      ["planned", [4, 5]],
      ["done", [1, 2]],
    ]);
  });

  it("leaves out empty sections", () => {
    expect(groupTasks([task()], noTasks, []).map(({ group }) => group)).toEqual(["ready"]);
  });
});

describe("matchesFilter", () => {
  it("finds every word of the query in the title or description, ignoring case", () => {
    const storage = task({ title: "Add SQLite storage", description: "Use rusqlite with migrations" });
    expect(matchesFilter(storage, { ...emptyTaskFilter, query: "sqlite" }, noTasks)).toBe(true);
    expect(matchesFilter(storage, { ...emptyTaskFilter, query: "  storage   MIGRATIONS " }, noTasks)).toBe(true);
    expect(matchesFilter(storage, { ...emptyTaskFilter, query: "storage timeline" }, noTasks)).toBe(false);
  });

  it("tells paused and not adopted tasks apart from their stored status", () => {
    const paused = task({ branch: "feat/add-storage-1" });
    const notAdopted = task({ status: "done", resolution: "not_adopted" });
    expect(matchesFilter(paused, { ...emptyTaskFilter, statuses: ["paused"] }, noTasks)).toBe(true);
    expect(matchesFilter(paused, { ...emptyTaskFilter, statuses: ["planned"] }, noTasks)).toBe(false);
    expect(matchesFilter(paused, { ...emptyTaskFilter, statuses: ["ready"] }, noTasks)).toBe(false);
    expect(matchesFilter(notAdopted, { ...emptyTaskFilter, statuses: ["done"] }, noTasks)).toBe(false);
    expect(matchesFilter(notAdopted, { ...emptyTaskFilter, statuses: ["not_adopted"] }, noTasks)).toBe(true);
  });

  it("tells planned tasks that can be started now apart from those waiting on a prerequisite", () => {
    const done = task({ id: 1, status: "done", resolution: "merged" });
    const working = task({ id: 2, status: "in_progress" });
    const notAdopted = task({ id: 3, status: "done", resolution: "not_adopted" });
    const byId = new Map([done, working, notAdopted].map((each) => [each.id, each]));
    const ready: TaskFilter = { ...emptyTaskFilter, statuses: ["ready"] };
    const planned: TaskFilter = { ...emptyTaskFilter, statuses: ["planned"] };

    expect(matchesFilter(task({ id: 4 }), ready, byId)).toBe(true);
    expect(matchesFilter(task({ id: 5, dependsOn: [1] }), ready, byId)).toBe(true);
    expect(matchesFilter(task({ id: 5, dependsOn: [1] }), planned, byId)).toBe(false);
    expect(matchesFilter(task({ id: 6, dependsOn: [1, 2] }), ready, byId)).toBe(false);
    expect(matchesFilter(task({ id: 6, dependsOn: [1, 2] }), planned, byId)).toBe(true);
    expect(matchesFilter(task({ id: 7, dependsOn: [3] }), ready, byId)).toBe(false);
    expect(matchesFilter(working, ready, byId)).toBe(false);
  });

  it("shows a task paused by a new prerequisite as ready once that prerequisite is done", () => {
    const milestones = { plannedAt: 10, startedAt: 20, reviewAt: null, completedAt: null, reopenedAt: null, pausedAt: 30, lastReviewAt: null, activeSeconds: 10, pauseCount: 1 };
    const pausedTask = (dependsOn: number[]) =>
      task({ id: 9, branch: "feat/add-storage-9", dependsOn, milestones });
    const doneAt = (id: number, at: number) =>
      task({ id, status: "done", resolution: "merged", milestones: { ...milestones, completedAt: at, reopenedAt: null, pausedAt: null } });
    const byId = new Map([doneAt(1, 5), doneAt(2, 40), task({ id: 3, status: "in_progress" })].map((each) => [each.id, each]));
    const ready: TaskFilter = { ...emptyTaskFilter, statuses: ["ready"] };
    const paused: TaskFilter = { ...emptyTaskFilter, statuses: ["paused"] };

    // Prerequisite #2 was added while the task ran and completed after the pause.
    expect(matchesFilter(pausedTask([1, 2]), ready, byId)).toBe(true);
    expect(matchesFilter(pausedTask([1, 2]), paused, byId)).toBe(false);
    // Still waiting on #3.
    expect(matchesFilter(pausedTask([2, 3]), paused, byId)).toBe(true);
    // Paused by hand: its prerequisites were done before it started.
    expect(matchesFilter(pausedTask([1]), paused, byId)).toBe(true);
    expect(matchesFilter(pausedTask([]), paused, byId)).toBe(true);
  });

  it("shows a task paused by a prerequisite as ready once that dependency is removed", () => {
    const milestones = { plannedAt: 10, startedAt: 20, reviewAt: null, completedAt: null, pausedAt: 30, reopenedAt: null, lastReviewAt: null, activeSeconds: 10, pauseCount: 1 };
    // The server records the prerequisites a pause waits on as a blocker note at the pause.
    const pausedTask = (kind: "blocker" | "progress") =>
      task({ id: 9, branch: "feat/add-storage-9", milestones, notes: [{ kind, body: "Paused: waiting on #3", at: 30 }] });
    const ready: TaskFilter = { ...emptyTaskFilter, statuses: ["ready"] };
    const paused: TaskFilter = { ...emptyTaskFilter, statuses: ["paused"] };

    expect(matchesFilter(pausedTask("blocker"), ready, noTasks)).toBe(true);
    // Paused by hand through MCP, which records the reason as a progress note.
    expect(matchesFilter(pausedTask("progress"), paused, noTasks)).toBe(true);
  });

  it("lets tasks of any selected status through", () => {
    const filter: TaskFilter = { ...emptyTaskFilter, statuses: ["in_progress", "done"] };
    expect(matchesFilter(task({ status: "in_progress" }), filter, noTasks)).toBe(true);
    expect(matchesFilter(task({ status: "done", resolution: "merged" }), filter, noTasks)).toBe(true);
    expect(matchesFilter(task({ status: "in_review" }), filter, noTasks)).toBe(false);
  });

  it("narrows to one task type", () => {
    expect(matchesFilter(task({ taskType: "fix" }), { ...emptyTaskFilter, type: "fix" }, noTasks)).toBe(true);
    expect(matchesFilter(task(), { ...emptyTaskFilter, type: "fix" }, noTasks)).toBe(false);
  });

  it("counts a blank query as no filter", () => {
    expect(isFilterActive({ ...emptyTaskFilter, query: "   " })).toBe(false);
    expect(isFilterActive({ ...emptyTaskFilter, type: "docs" })).toBe(true);
    expect(isFilterActive({ ...emptyTaskFilter, statuses: ["done"] })).toBe(true);
  });
});

describe("toggleStatus", () => {
  it("adds a status in the order statuses are shown, and removes one already selected", () => {
    expect(toggleStatus(["done"], "in_progress")).toEqual(["in_progress", "done"]);
    expect(toggleStatus(["in_progress", "done"], "done")).toEqual(["in_progress"]);
  });
});
