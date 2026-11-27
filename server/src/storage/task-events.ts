import type { Database } from "bun:sqlite";
import { isReady } from "../domain/dag.ts";
import { taskId, workspaceId } from "../domain/model.ts";
import type { TaskId, WorkspaceId } from "../domain/model.ts";
import type { TaskStatus } from "../domain/status.ts";
import type { Storage } from "./storage.ts";
import { allTasks, requireTask, withDependencyErrors } from "./task-query.ts";
import { invalidData, parseTaskStatus } from "./task-rows.ts";

export type StatusCursor = { readonly statusChange: number; readonly adoption: number };
export type StatusChange = {
  readonly id: number; readonly task: TaskId; readonly workspace: WorkspaceId;
  readonly from: TaskStatus | null; readonly to: TaskStatus; readonly at: number;
};
export type ReadyTask = {
  readonly task: TaskId; readonly workspace: WorkspaceId; readonly unblockedBy: TaskId; readonly at: number;
};
export type StatusChanges = {
  readonly changes: readonly StatusChange[]; readonly ready: readonly ReadyTask[]; readonly cursor: StatusCursor;
};

export function minStatusCursor(a: StatusCursor, b: StatusCursor): StatusCursor {
  return { statusChange: Math.min(a.statusChange, b.statusChange), adoption: Math.min(a.adoption, b.adoption) };
}

export function recordEvent(db: Database, event: {
  readonly task: TaskId; readonly status: TaskStatus; readonly at: number; readonly reason?: string | null;
}): void {
  db.run("INSERT INTO task_events (task_id, status, at, reason) VALUES (?1, ?2, ?3, ?4)",
    [event.task, event.status, event.at, event.reason ?? null]);
  db.run("UPDATE tasks SET wait_until = NULL, wait_status = NULL WHERE id = ?1 AND wait_until IS NOT NULL",
    [event.task]);
}

export function recordAdoption(db: Database, task: TaskId, at: number): void {
  db.run("INSERT INTO task_adoptions (task_id, at) VALUES (?1, ?2)", [task, at]);
}

export function setLatestEventReason(storage: Storage, id: TaskId, status: TaskStatus, reason: string) {
  const { db } = storage;
  return storage.transaction(() => {
    const { changes } = db.run(`UPDATE task_events SET reason = ?3
      WHERE id = (SELECT max(id) FROM task_events WHERE task_id = ?1) AND status = ?2`, [id, status, reason]);
    const task = requireTask(db, id);
    if (changes === 0) throw invalidData(`the latest status change of task ${id} is not a move to ${status}`);
    return task;
  }, "deferred");
}

export function statusCursor(storage: Storage): StatusCursor {
  const row = storage.db.query<StatusCursor, []>(`
    SELECT (SELECT coalesce(max(id), 0) FROM task_events) AS statusChange,
           (SELECT coalesce(max(id), 0) FROM task_adoptions) AS adoption
  `).get();
  if (row === null) throw invalidData("status cursor query returned no row");
  return row;
}

type EventRow = {
  readonly id: number; readonly task_id: number; readonly workspace_id: number;
  readonly status: string; readonly at: number; readonly previous: string | null;
};
type AdoptionRow = { readonly id: number; readonly task_id: number; readonly at: number };
type Finish = { readonly at: number; readonly kind: 0 | 1; readonly id: number; readonly task: TaskId };

function compareFinishes(a: Finish, b: Finish): number {
  return a.at - b.at || a.kind - b.kind || a.id - b.id;
}

export function statusChangesAfter(storage: Storage, after: StatusCursor): StatusChanges {
  const { db } = storage;
  return storage.transaction(() => {
    const cursor = statusCursor(storage);
    const changes = db.query<EventRow, [number]>(`
      SELECT e.id, e.task_id, t.workspace_id, e.status, e.at,
             (SELECT p.status FROM task_events p WHERE p.task_id = e.task_id
              AND p.id < e.id ORDER BY p.id DESC LIMIT 1) AS previous
      FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.id > ?1 ORDER BY e.id
    `).all(after.statusChange).map(({ id, task_id, workspace_id, status, at, previous }): StatusChange => ({
      id, task: taskId(task_id), workspace: workspaceId(workspace_id),
      from: previous === null ? null : parseTaskStatus(previous), to: parseTaskStatus(status), at,
    }));
    const adoptions = db.query<AdoptionRow, [number]>(`
      SELECT id, task_id, at FROM task_adoptions WHERE id > ?1 ORDER BY id
    `).all(after.adoption);
    const finished = new Map<TaskId, Finish>();
    for (const finish of [
      ...changes.filter(({ to }) => to === "done").map(({ task, at, id }) => ({ task, at, id, kind: 0 } as const)),
      ...adoptions.map(({ task_id, at, id }) => ({ task: taskId(task_id), at, id, kind: 1 } as const)),
    ]) {
      const previous = finished.get(finish.task);
      if (previous === undefined || compareFinishes(finish, previous) > 0) finished.set(finish.task, finish);
    }
    if (finished.size === 0) return { changes, ready: [], cursor };
    const tasks = allTasks(db);
    const ready: { readonly finish: Finish; readonly readyTask: ReadyTask }[] = [];
    for (const task of tasks) {
      if (task.status !== "planned") continue;
      let last: Finish | undefined;
      for (const prerequisite of task.dependsOn) {
        const finish = finished.get(prerequisite);
        if (finish !== undefined && (last === undefined || compareFinishes(finish, last) > 0)) last = finish;
      }
      if (last !== undefined && withDependencyErrors(() => isReady(tasks, task.id))) {
        ready.push({ finish: last, readyTask: {
          task: task.id, workspace: task.workspaceId, unblockedBy: last.task, at: last.at,
        } });
      }
    }
    ready.sort((a, b) => compareFinishes(a.finish, b.finish) || a.readyTask.task - b.readyTask.task);
    return { changes, ready: ready.map(({ readyTask }) => readyTask), cursor };
  }, "deferred");
}
