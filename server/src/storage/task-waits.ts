import type { Database } from "bun:sqlite";
import { blockingDependencies } from "../domain/dag.ts";
import { taskId } from "../domain/model.ts";
import type { Task, TaskId, WorkspaceId } from "../domain/model.ts";
import type { Storage } from "./storage.ts";
import { recordEvent } from "./task-events.ts";
import { allTasks, findTask, requireTask, withDependencyErrors } from "./task-query.ts";
import { LIVE_TASK } from "./task-sql.ts";
import { changeStatus } from "./task-status.ts";
import { addNote } from "./tasks.ts";

// Jiff leaves room for its UTC offsets of up to 25:59:59 at both civil-date bounds.
const MAX_OFFSET_SECONDS = 25 * 3600 + 59 * 60 + 59;
const MIN_TIMESTAMP_SECONDS = -377705116800 + MAX_OFFSET_SECONDS;
const MAX_TIMESTAMP_SECONDS = 253402300799 - MAX_OFFSET_SECONDS;

function waitTime(until: number): string {
  if (until < MIN_TIMESTAMP_SECONDS || until > MAX_TIMESTAMP_SECONDS) return String(until);
  return new Date(until * 1000).toISOString().replace(/\.000Z$/, "Z");
}

export function waitTask(storage: Storage, id: TaskId, until: number, reason: string | null): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    const task = requireTask(db, id);
    const prefix = task.wait === null ? "Waiting until" : "Wait changed: waiting until";
    const note = `${prefix} ${waitTime(until)}${reason === null ? "" : `: ${reason}`}`;
    const status = task.wait?.status ?? task.status;
    if (task.wait === null && task.status !== "planned") {
      const paused = changeStatus(task.status, "planned");
      db.run("UPDATE tasks SET status = ?2 WHERE id = ?1", [id, paused]);
      recordEvent(db, { task: id, status: paused, at, reason: note });
    }
    db.run("UPDATE tasks SET wait_until = ?2, wait_status = ?3 WHERE id = ?1", [id, until, status]);
    addNote(db, id, { kind: "progress", body: note, at });
    return requireTask(db, id);
  }, "deferred");
}

function endWait(db: Database, task: Task, ending: { readonly at: number; readonly text: string }): void {
  const { wait, id } = task;
  if (wait === null) return;
  const blockers = wait.status === "in_progress"
    ? withDependencyErrors(() => blockingDependencies(allTasks(db), id)) : [];
  if (wait.status === "planned" || blockers.length > 0) {
    db.run("UPDATE tasks SET wait_until = NULL, wait_status = NULL WHERE id = ?1", [id]);
  } else {
    db.run("UPDATE tasks SET status = ?2 WHERE id = ?1", [id, wait.status]);
    recordEvent(db, { task: id, status: wait.status, at: ending.at, reason: ending.text });
  }
  addNote(db, id, { kind: "progress", body: ending.text, at: ending.at });
  if (blockers.length > 0) {
    const waiting = blockers.map(({ id, status }) => `#${id} (${status})`).join(", ");
    addNote(db, id, { kind: "blocker", body: `The wait ended, but the task stays paused: waiting on ${waiting}`, at: ending.at });
  }
}

export function endTaskWait(storage: Storage, id: TaskId, note: string | null): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    const text = note === null ? "Wait ended early" : `Wait ended early: ${note}`;
    endWait(db, requireTask(db, id), { at, text });
    return requireTask(db, id);
  }, "deferred");
}

export function endDueWaits(storage: Storage): WorkspaceId[] {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    const ids = db.query<{ readonly id: number }, [number]>(`
      SELECT t.id FROM tasks t WHERE t.wait_until IS NOT NULL AND t.wait_until <= ?1 AND ${LIVE_TASK}
      ORDER BY t.wait_until, t.id
    `).all(at);
    const workspaces = new Set<WorkspaceId>();
    for (const { id } of ids) {
      const task = findTask(db, taskId(id));
      if (task === null || task.wait === null) continue;
      endWait(db, task, { at, text: `Wait until ${waitTime(task.wait.until)} ended` });
      workspaces.add(task.workspaceId);
    }
    return [...workspaces];
  }, "deferred");
}
