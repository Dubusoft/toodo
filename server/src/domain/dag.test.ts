import { describe, expect, test } from "bun:test";

import {
  type DependencyProblem,
  DependencyError,
  DependencyGraph,
  blockingDependencies,
  isReady,
  topologicalOrder,
} from "./dag.ts";
import { type Task, type TaskResolution, taskId, workspaceId } from "./model.ts";
import type { TaskStatus } from "./status.ts";

function task(
  id: number,
  status: TaskStatus,
  dependsOn: readonly number[],
  resolution: TaskResolution | null = null,
): Task {
  return {
    id: taskId(id),
    workspaceId: workspaceId(1),
    taskType: "feat",
    title: `Task ${id}`,
    description: "",
    status,
    resolution,
    dependsOn: new Set(dependsOn.map(taskId)),
    issue: null,
    estimate: null,
    dueDate: null,
    labels: [],
    refs: [],
    completionNote: null,
    timeline: [],
    notes: [],
    criteria: [],
    wait: null,
    autopilotAt: null,
  };
}

const ids = (raw: readonly number[]) => raw.map(taskId);

function problemOf(action: () => unknown): DependencyProblem {
  try {
    action();
  } catch (error) {
    if (error instanceof DependencyError) return error.problem;
    throw error;
  }
  throw new Error("expected a DependencyError");
}

/** Adds `task -> dependsOn` to the graph of `tasks`. */
function validateDependency(tasks: readonly Task[], from: number, to: number): void {
  const edges = tasks.flatMap((each) =>
    [...each.dependsOn].map((dependsOn) => ({ task: each.id, dependsOn })),
  );
  new DependencyGraph(
    tasks.map((each) => each.id),
    edges,
  ).add(taskId(from), taskId(to));
}

describe("dag", () => {
  test("added edges count toward the next check", () => {
    const graph = new DependencyGraph(ids([1, 2, 3]), [{ task: taskId(2), dependsOn: taskId(1) }]);
    graph.add(taskId(3), taskId(2));
    expect(problemOf(() => graph.add(taskId(1), taskId(3)))).toEqual({
      kind: "cycle",
      path: ids([1, 3, 2, 1]),
    });
    // The rejected edge was not added: the other direction is still fine.
    expect(() => graph.add(taskId(3), taskId(1))).not.toThrow();
  });

  test("valid dependency is accepted", () => {
    const tasks = [task(1, "done", []), task(2, "planned", [1]), task(3, "planned", [])];
    expect(() => validateDependency(tasks, 3, 2)).not.toThrow();
    expect(() => validateDependency(tasks, 3, 1)).not.toThrow();
  });

  test("self dependency is rejected", () => {
    expect(problemOf(() => validateDependency([task(1, "planned", [])], 1, 1))).toEqual({
      kind: "self_dependency",
      id: taskId(1),
    });
  });

  test("direct cycle is rejected", () => {
    const tasks = [task(1, "planned", [2]), task(2, "planned", [])];
    expect(problemOf(() => validateDependency(tasks, 2, 1))).toEqual({
      kind: "cycle",
      path: ids([2, 1, 2]),
    });
  });

  test("indirect cycle is rejected with its path", () => {
    const tasks = [
      task(1, "planned", [2]),
      task(2, "planned", [3]),
      task(3, "planned", []),
      task(4, "planned", [1]),
    ];
    expect(() => validateDependency(tasks, 3, 1)).toThrow(
      "dependency cycle: 3 -> 1 -> 2 -> 3; task 2 already depends on 3. task_id is the task that waits, depends_on its prerequisites; did you swap them?",
    );
    expect(problemOf(() => validateDependency(tasks, 3, 1))).toEqual({
      kind: "cycle",
      path: ids([3, 1, 2, 3]),
    });
  });

  test("blocking dependencies skip merged and completed and list the rest", () => {
    const tasks = [
      task(1, "done", [], "merged"),
      task(2, "done", []),
      task(3, "done", [], "not_adopted"),
      task(4, "planned", []),
      task(5, "planned", [1, 2, 3, 4, 6]),
      task(6, "done", [], "completed"),
      task(7, "planned", [1, 6]),
    ];
    expect(blockingDependencies(tasks, taskId(5))).toEqual([
      { id: taskId(3), status: "done", resolution: "not_adopted" },
      { id: taskId(4), status: "planned", resolution: null },
    ]);
    expect(blockingDependencies(tasks, taskId(4))).toEqual([]);
    expect(isReady(tasks, taskId(7))).toBe(true);
  });

  test("cross workspace dependencies are accepted and unknown ones rejected", () => {
    const other = { ...task(2, "done", []), workspaceId: workspaceId(2) };
    const tasks = [task(1, "planned", []), other];
    expect(() => validateDependency(tasks, 1, 2)).not.toThrow();
    expect(problemOf(() => validateDependency(tasks, 9, 1))).toEqual({
      kind: "unknown_task",
      id: taskId(9),
    });
    expect(problemOf(() => validateDependency(tasks, 1, 9))).toEqual({
      kind: "unknown_task",
      id: taskId(9),
    });
  });

  test("task is ready only when all dependencies are done", () => {
    const tasks = [
      task(1, "done", []),
      task(2, "in_progress", []),
      task(3, "in_review", []),
      task(4, "planned", [1]),
      task(5, "planned", [1, 2]),
      task(6, "planned", [3]),
      task(7, "planned", []),
    ];
    expect([4, 5, 6, 7].map((id) => isReady(tasks, taskId(id)))).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  test("a dependency that was not adopted keeps its dependents waiting", () => {
    const tasks = [
      task(1, "done", [], "merged"),
      task(2, "done", [], "not_adopted"),
      task(3, "planned", [1]),
      task(4, "planned", [1, 2]),
    ];
    expect(isReady(tasks, taskId(3))).toBe(true);
    expect(isReady(tasks, taskId(4))).toBe(false);
  });

  test("topological order puts dependencies first and breaks ties by id", () => {
    const tasks = [
      task(5, "planned", [3, 4]),
      task(4, "planned", [1]),
      task(3, "planned", [1]),
      task(2, "planned", []),
      task(1, "planned", []),
    ];
    expect(topologicalOrder(tasks)).toEqual(ids([1, 2, 3, 4, 5]));
    expect(topologicalOrder([])).toEqual([]);
  });

  test("topological order reports a stored cycle", () => {
    const tasks = [
      task(1, "planned", []),
      task(2, "planned", [1, 4]),
      task(3, "planned", [2]),
      task(4, "planned", [3]),
      task(5, "planned", [4]),
    ];
    expect(problemOf(() => topologicalOrder(tasks))).toEqual({
      kind: "cycle",
      path: ids([2, 4, 3, 2]),
    });
    expect(problemOf(() => topologicalOrder([task(1, "planned", [7])]))).toEqual({
      kind: "unknown_task",
      id: taskId(7),
    });
  });
});
