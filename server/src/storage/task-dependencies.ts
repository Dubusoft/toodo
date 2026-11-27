import type { Database } from "bun:sqlite";
import { blockingDependencies } from "../domain/dag.ts";
import type { Task, TaskId } from "../domain/model.ts";
import { StorageError } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { recordEvent } from "./task-events.ts";
import { allTasks, dependencyGraph, requireTask, withDependencyErrors } from "./task-query.ts";
import { changeStatus } from "./task-status.ts";

export type AddedDependencies = { readonly task: Task; readonly paused: boolean };
export type PauseRule = "pause" | "ask";
export type DependencyChange =
  | { readonly kind: "added"; readonly added: AddedDependencies }
  | { readonly kind: "needs_pause" };

/** Rolls back tentative edges when the caller wants to confirm a pause first. */
class NeedsPause extends Error {}

export function insertDependency(db: Database, task: TaskId, dependsOn: TaskId): void {
  db.run("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?1, ?2)", [task, dependsOn]);
}

export function addDependency(storage: Storage, task: TaskId, dependsOn: TaskId): void {
  addDependencies(storage, task, [dependsOn]);
}

export function addDependencies(storage: Storage, task: TaskId, dependsOn: readonly TaskId[]): AddedDependencies {
  const change = addDependenciesWith(storage, task, dependsOn, "pause");
  if (change.kind === "added") return change.added;
  throw new TypeError("The pause rule must add the dependencies");
}

export function addDependenciesWith(
  storage: Storage, task: TaskId, dependsOn: readonly TaskId[], rule: PauseRule,
): DependencyChange {
  const { db } = storage;
  const at = storage.now();
  try {
    return storage.transaction(() => {
      const graph = dependencyGraph(db);
      for (const prerequisite of dependsOn) {
        withDependencyErrors(() => graph.add(task, prerequisite));
        insertDependency(db, task, prerequisite);
      }
      const current = requireTask(db, task);
      if (current.status === "done") {
        throw new StorageError({ kind: "prerequisite_of_done_task", task, dependsOn: [...dependsOn] });
      }
      const tasks = allTasks(db);
      const blockers = withDependencyErrors(() => blockingDependencies(tasks, task));
      const paused = current.status === "in_progress" && blockers.length > 0;
      if (paused) {
        if (rule === "ask") throw new NeedsPause();
        const status = changeStatus(current.status, "planned");
        db.run("UPDATE tasks SET status = ?2 WHERE id = ?1", [task, status]);
        const titles = new Map(tasks.map(({ id, title }) => [id, title]));
        const waiting = blockers.map(({ id, status }) => `#${id} ${titles.get(id) ?? ""} (${status})`).join(", ");
        recordEvent(db, { task, status, at, reason: `Waiting on ${waiting}` });
        db.run("INSERT INTO task_notes (task_id, kind, body, at) VALUES (?1, ?2, ?3, ?4)",
          [task, "blocker", `Paused: waiting on ${waiting}`, at]);
      }
      return { kind: "added", added: { task: requireTask(db, task), paused } };
    }, "deferred");
  } catch (error) {
    if (error instanceof NeedsPause) return { kind: "needs_pause" };
    throw error;
  }
}

export function removeDependency(storage: Storage, task: TaskId, dependsOn: TaskId): void {
  const { db } = storage;
  storage.transaction(() => {
    const current = requireTask(db, task);
    if (current.status === "done" && current.dependsOn.has(dependsOn)) {
      throw new StorageError({ kind: "dependency_of_done_task", task, dependsOn });
    }
    const { changes } = db.run("DELETE FROM task_dependencies WHERE task_id = ?1 AND depends_on_id = ?2", [task, dependsOn]);
    if (changes === 0) throw new StorageError({ kind: "dependency_not_found", task, dependsOn });
  }, "deferred");
}
