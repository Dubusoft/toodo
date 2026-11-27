import type { Task, TaskId, TaskResolution } from "../domain/model.ts";
import { complete, conclude, reopen, transitionTo, TransitionError } from "../domain/status.ts";
import type { TaskStatus } from "../domain/status.ts";
import { StorageError } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { recordAdoption, recordEvent } from "./task-events.ts";
import { ensureTaskReady, requireTask } from "./task-query.ts";
import { invalidData } from "./task-rows.ts";
import { addNote, writeRefs } from "./tasks.ts";

function checkTransition(operation: () => TaskStatus): TaskStatus {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TransitionError) throw new StorageError({ kind: "transition", error });
    throw error;
  }
}

export function changeStatus(from: TaskStatus, to: TaskStatus): TaskStatus {
  return checkTransition(() => transitionTo(from, to));
}

export function startTask(storage: Storage, id: TaskId, reason: string | null, refs: readonly string[]): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    changeStatus(requireTask(db, id).status, "in_progress");
    ensureTaskReady(db, id);
    db.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?1", [id]);
    writeRefs(db, id, refs);
    recordEvent(db, { task: id, status: "in_progress", at, reason });
    return requireTask(db, id);
  }, "deferred");
}

export function completeTask(storage: Storage, id: TaskId, note: string | null, refs: readonly string[]): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    const task = requireTask(db, id);
    checkTransition(() => complete(task.status));
    db.run(`UPDATE tasks SET status = 'done', resolution = 'completed',
      completion_note = COALESCE(?2, completion_note) WHERE id = ?1`, [id, note]);
    writeRefs(db, id, refs);
    recordEvent(db, { task: id, status: "done", at, reason: note });
    return requireTask(db, id);
  }, "deferred");
}

export function concludeTask(storage: Storage, id: TaskId, note: string, shippedWith: TaskId | null): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    const task = requireTask(db, id);
    const changesStatus = task.status !== "done" || task.resolution !== "not_adopted" || shippedWith === null;
    if (changesStatus) checkTransition(() => conclude(task.status));
    if (shippedWith !== null) {
      const target = requireTask(db, shippedWith);
      if (shippedWith === id || target.status !== "done" || target.resolution === "not_adopted") {
        throw invalidData(`task ${shippedWith} has not shipped this work; call complete_task for that task first, then conclude_task with shipped_with ${shippedWith}`);
      }
    }
    db.run(`UPDATE tasks SET status = 'done', resolution = ?2, completion_note = ?3 WHERE id = ?1`,
      [id, shippedWith === null ? "not_adopted" : "completed", note]);
    if (shippedWith !== null) {
      const reference = `task:${shippedWith}`;
      writeRefs(db, id, task.refs.includes(reference) ? task.refs : [...task.refs, reference]);
    }
    if (changesStatus) recordEvent(db, { task: id, status: "done", at, reason: note });
    else recordAdoption(db, id, at);
    return requireTask(db, id);
  }, "deferred");
}

export function reopenTask(storage: Storage, id: TaskId, reason: string, note: string): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    const task = requireTask(db, id);
    const status = checkTransition(() => reopen(task.status));
    db.run("UPDATE tasks SET status = ?2, resolution = NULL, completion_note = NULL WHERE id = ?1", [id, status]);
    recordEvent(db, { task: id, status, at, reason });
    addNote(db, id, { kind: "progress", body: note, at });
    return requireTask(db, id);
  }, "deferred");
}

export function setTaskOutcome(
  storage: Storage, id: TaskId, resolution: TaskResolution, completionNote: string, note: string,
): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    const task = requireTask(db, id);
    if (task.status !== "done") throw invalidData(`task ${id} is ${task.status}; only a done task has an outcome`);
    db.run("UPDATE tasks SET resolution = ?2, completion_note = ?3 WHERE id = ?1", [id, resolution, completionNote]);
    if (task.resolution === "not_adopted" && resolution !== "not_adopted") recordAdoption(db, id, at);
    addNote(db, id, { kind: "progress", body: note, at });
    return requireTask(db, id);
  }, "deferred");
}

export function setCompletionNote(storage: Storage, id: TaskId, note: string | null): Task {
  const { db } = storage;
  return storage.transaction(() => {
    const { changes } = db.run("UPDATE tasks SET completion_note = ?2 WHERE id = ?1", [id, note]);
    if (changes === 0) throw new StorageError({ kind: "task_not_found", task: id });
    return requireTask(db, id);
  }, "deferred");
}

function changeTaskStatus(storage: Storage, id: TaskId, status: TaskStatus, reason: string | null): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    changeStatus(requireTask(db, id).status, status);
    if (status === "in_progress") ensureTaskReady(db, id);
    db.run("UPDATE tasks SET status = ?2, resolution = ?3 WHERE id = ?1",
      [id, status, status === "done" ? "merged" : null]);
    recordEvent(db, { task: id, status, at, reason });
    return requireTask(db, id);
  }, "deferred");
}

export function setTaskStatus(storage: Storage, id: TaskId, status: TaskStatus): Task {
  return changeTaskStatus(storage, id, status, null);
}

export function pauseTask(storage: Storage, id: TaskId, reason: string | null): Task {
  return changeTaskStatus(storage, id, "planned", reason);
}
