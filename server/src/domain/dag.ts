// Rules for the task dependency DAG: edge validation (no self or cyclic edges), readiness,
// and topological order. The DAG spans all workspaces: a task may depend on a task of
// another workspace, such as a library change that an application change needs first.

import type { Task, TaskId, TaskResolution } from "./model.ts";
import type { TaskStatus } from "./status.ts";

/** Why an edge or a stored graph is rejected. In a `cycle`, `path` holds the tasks along
 * the loop, starting and ending with the same task; each depends on the one after it. */
export type DependencyProblem =
  | { readonly kind: "unknown_task"; readonly id: TaskId }
  | { readonly kind: "self_dependency"; readonly id: TaskId }
  | { readonly kind: "cycle"; readonly path: readonly TaskId[] };

export class DependencyError extends Error {
  readonly problem: DependencyProblem;

  constructor(problem: DependencyProblem) {
    super(dependencyMessage(problem));
    this.name = "DependencyError";
    this.problem = problem;
  }
}

function dependencyMessage(problem: DependencyProblem): string {
  switch (problem.kind) {
    case "unknown_task":
      return `unknown task ${problem.id}`;
    case "self_dependency":
      return `task ${problem.id} cannot depend on itself`;
    case "cycle": {
      const message = `dependency cycle: ${problem.path.join(" -> ")}`;
      // Each task depends on the next one, so the last edge is the existing one that
      // closes the loop.
      const waiting = problem.path[problem.path.length - 2];
      const prerequisite = problem.path[problem.path.length - 1];
      if (waiting === undefined || prerequisite === undefined) return message;
      return `${message}; task ${waiting} already depends on ${prerequisite}. task_id is the task that waits, depends_on its prerequisites; did you swap them?`;
    }
  }
}

function ascending(ids: Iterable<TaskId>): TaskId[] {
  return [...ids].sort((a, b) => a - b);
}

function index<T extends DependencyNode>(tasks: readonly T[]): Map<TaskId, T> {
  return new Map(tasks.map((task) => [task.id, task]));
}

/** What ordering tasks by their dependencies reads of a task. */
export type DependencyNode = Pick<Task, "id" | "dependsOn">;

/** A task and a task it depends on. */
export type DependencyEdge = { readonly task: TaskId; readonly dependsOn: TaskId };

/** The tasks and `dependsOn` edges of the DAG without the rest of each task: what checking a
 * new edge needs. Edges are added one at a time, each checked against the ones before it,
 * so a batch of edges is checked against a single load of the graph. */
export class DependencyGraph {
  readonly #dependsOn = new Map<TaskId, Set<TaskId>>();

  /** The graph of `tasks` with `edges`. */
  constructor(tasks: Iterable<TaskId>, edges: Iterable<DependencyEdge>) {
    for (const task of tasks) this.#dependsOn.set(task, new Set());
    for (const edge of edges) this.#dependenciesOf(edge.task).add(edge.dependsOn);
  }

  #dependenciesOf(task: TaskId): Set<TaskId> {
    const existing = this.#dependsOn.get(task);
    if (existing !== undefined) return existing;
    const created = new Set<TaskId>();
    this.#dependsOn.set(task, created);
    return created;
  }

  /** Adds the edge `task -> dependsOn`, rejecting a self edge, an unknown task, and an edge
   * that would close a cycle; a rejected edge leaves the graph as it was. */
  add(task: TaskId, dependsOn: TaskId): void {
    if (task === dependsOn) throw new DependencyError({ kind: "self_dependency", id: task });
    for (const id of [task, dependsOn]) {
      if (!this.#dependsOn.has(id)) throw new DependencyError({ kind: "unknown_task", id });
    }
    const path = this.#dependencyPath(dependsOn, task);
    if (path !== null) throw new DependencyError({ kind: "cycle", path: [task, ...path] });
    this.#dependenciesOf(task).add(dependsOn);
  }

  /** Path from `from` to `to` following `dependsOn` edges, both ends included. */
  #dependencyPath(from: TaskId, to: TaskId): TaskId[] | null {
    const parent = new Map<TaskId, TaskId>();
    const visited = new Set([from]);
    const stack = [from];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      if (current === to) {
        const path = [to];
        for (let node = parent.get(to); node !== undefined; node = parent.get(node)) {
          path.push(node);
        }
        return path.reverse();
      }
      const dependencies = this.#dependsOn.get(current);
      if (dependencies === undefined) continue;
      for (const next of ascending(dependencies)) {
        if (!visited.has(next)) {
          visited.add(next);
          parent.set(next, current);
          stack.push(next);
        }
      }
    }
    return null;
  }
}

/** A dependency that keeps a task from starting. */
export type BlockingDependency = {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly resolution: TaskResolution | null;
};

function blocking(byId: ReadonlyMap<TaskId, Task>, task: Task): BlockingDependency[] {
  const blockers: BlockingDependency[] = [];
  for (const id of ascending(task.dependsOn)) {
    const dependency = byId.get(id);
    if (dependency === undefined) throw new DependencyError({ kind: "unknown_task", id });
    // Merged and completed work can be built on; work not adopted cannot.
    if (dependency.status !== "done" || dependency.resolution === "not_adopted") {
      blockers.push({
        id: dependency.id,
        status: dependency.status,
        resolution: dependency.resolution,
      });
    }
  }
  return blockers;
}

function find(byId: ReadonlyMap<TaskId, Task>, id: TaskId): Task {
  const task = byId.get(id);
  if (task === undefined) throw new DependencyError({ kind: "unknown_task", id });
  return task;
}

/** The dependencies of `task` that keep it from starting: not done, or done as not adopted.
 * Empty when the task is ready. */
export function blockingDependencies(tasks: readonly Task[], task: TaskId): BlockingDependency[] {
  const byId = index(tasks);
  return blocking(byId, find(byId, task));
}

/** Whether all dependencies of `task` are done and none of them was concluded without being
 * adopted, so it can be started. */
export function isReady(tasks: readonly Task[], task: TaskId): boolean {
  return blockingDependencies(tasks, task).length === 0;
}

/** Orders tasks so that every task comes after its dependencies. Ties are broken by task ID,
 * so the order is deterministic. */
export function topologicalOrder(tasks: readonly DependencyNode[]): TaskId[] {
  const byId = index(tasks);
  const pending = new Map<TaskId, number>();
  const dependents = new Map<TaskId, TaskId[]>();
  for (const task of tasks) {
    for (const dependency of ascending(task.dependsOn)) {
      if (!byId.has(dependency)) {
        throw new DependencyError({ kind: "unknown_task", id: dependency });
      }
      const waiting = dependents.get(dependency);
      if (waiting === undefined) dependents.set(dependency, [task.id]);
      else waiting.push(task.id);
    }
    pending.set(task.id, task.dependsOn.size);
  }

  const available = new MinQueue(
    [...pending].filter(([, count]) => count === 0).map(([id]) => id),
  );
  const order: TaskId[] = [];
  for (let id = available.pop(); id !== undefined; id = available.pop()) {
    pending.delete(id);
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const count = (pending.get(dependent) ?? 0) - 1;
      pending.set(dependent, count);
      if (count === 0) available.push(dependent);
    }
  }

  if (pending.size > 0) {
    throw new DependencyError({ kind: "cycle", path: findCycle(byId, pending) });
  }
  return order;
}

/** Walks unordered tasks along unordered dependencies until a task repeats. Every unordered
 * task has at least one unordered dependency, so the walk always loops. */
function findCycle(
  byId: ReadonlyMap<TaskId, DependencyNode>,
  unordered: ReadonlyMap<TaskId, number>,
): TaskId[] {
  const position = new Map<TaskId, number>();
  const walk: TaskId[] = [];
  let current: TaskId | undefined = ascending(unordered.keys())[0];
  while (current !== undefined) {
    const start = position.get(current);
    if (start !== undefined) return [...walk.slice(start), current];
    position.set(current, walk.length);
    walk.push(current);
    current = ascending(byId.get(current)?.dependsOn ?? []).find((dependency) =>
      unordered.has(dependency),
    );
  }
  throw new Error("an unordered task has an unordered dependency");
}

/** Task IDs taken smallest first, as a `BTreeSet`'s `pop_first` takes them. */
class MinQueue {
  readonly #heap: TaskId[] = [];

  constructor(ids: Iterable<TaskId>) {
    for (const id of ids) this.push(id);
  }

  push(id: TaskId): void {
    const heap = this.#heap;
    heap.push(id);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      const [above, below] = [heap[parent], heap[child]];
      if (above === undefined || below === undefined || above <= below) break;
      [heap[parent], heap[child]] = [below, above];
      child = parent;
    }
  }

  pop(): TaskId | undefined {
    const heap = this.#heap;
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined || heap.length === 0) return top;
    heap[0] = last;
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      if ((heap[left] ?? Infinity) < (heap[smallest] ?? Infinity)) smallest = left;
      if ((heap[right] ?? Infinity) < (heap[smallest] ?? Infinity)) smallest = right;
      if (smallest === parent) return top;
      const [above, below] = [heap[parent], heap[smallest]];
      if (above === undefined || below === undefined) return top;
      [heap[parent], heap[smallest]] = [below, above];
      parent = smallest;
    }
  }
}
