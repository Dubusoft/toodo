import type { Database } from "bun:sqlite";
import { taskId } from "../domain/model.ts";
import type { Task, TaskId, WorkspaceId } from "../domain/model.ts";
import { StorageError } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { ensureAcyclic, loadTasks, requireTask } from "./task-query.ts";

type ArchiveRow = { readonly archived_at: number | null };

function requireLiveWorkspace(db: Database, workspace: WorkspaceId): void {
  const row = db.query<ArchiveRow, [WorkspaceId]>("SELECT archived_at FROM workspaces WHERE id = ?1").get(workspace);
  if (row?.archived_at !== null) throw new StorageError({ kind: "workspace_not_found", workspace });
}

export function archiveTask(storage: Storage, id: TaskId): void {
  const at = storage.now();
  storage.transaction(() => {
    requireTask(storage.db, id);
    storage.db.run("UPDATE tasks SET archived_at = ?2 WHERE id = ?1", [id, at]);
  }, "deferred");
}

export function moveTask(storage: Storage, id: TaskId, workspace: WorkspaceId): Task {
  const { db } = storage;
  return storage.transaction(() => {
    requireTask(db, id);
    requireLiveWorkspace(db, workspace);
    db.run("UPDATE tasks SET workspace_id = ?2 WHERE id = ?1", [id, workspace]);
    return requireTask(db, id);
  }, "deferred");
}

export function archiveDoneTasks(storage: Storage, workspace: WorkspaceId): TaskId[] {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    requireLiveWorkspace(db, workspace);
    const ids = db.query<{ readonly id: number }, [WorkspaceId, "done"]>(`
      SELECT id FROM tasks WHERE workspace_id = ?1 AND status = ?2 AND archived_at IS NULL ORDER BY id
    `).all(workspace, "done").map(({ id }) => taskId(id));
    db.run(`UPDATE tasks SET archived_at = ?3
      WHERE workspace_id = ?1 AND status = ?2 AND archived_at IS NULL`, [workspace, "done", at]);
    return ids;
  }, "deferred");
}

export function restoreTask(storage: Storage, id: TaskId): Task {
  const { db } = storage;
  return storage.transaction(() => {
    const row = db.query<ArchiveRow & { readonly workspace_id: number; readonly workspace_archived: number | null }, [TaskId]>(`
      SELECT t.archived_at, t.workspace_id, w.archived_at AS workspace_archived
      FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?1
    `).get(id);
    if (row === null) throw new StorageError({ kind: "task_not_found", task: id });
    if (row.workspace_archived !== null) {
      throw new StorageError({ kind: "workspace_archived", workspace: row.workspace_id, task: id });
    }
    if (row.archived_at === null) throw new StorageError({ kind: "task_not_archived", task: id });
    db.run("UPDATE tasks SET archived_at = NULL WHERE id = ?1", [id]);
    ensureAcyclic(db);
    return requireTask(db, id);
  }, "deferred");
}

export function purgeTask(storage: Storage, id: TaskId): void {
  const { db } = storage;
  storage.transaction(() => {
    const row = db.query<ArchiveRow, [TaskId]>("SELECT archived_at FROM tasks WHERE id = ?1").get(id);
    if (row === null) throw new StorageError({ kind: "task_not_found", task: id });
    if (row.archived_at === null) throw new StorageError({ kind: "task_not_archived", task: id });
    db.run("DELETE FROM tasks WHERE id = ?1", [id]);
  }, "deferred");
}

export function archivedTasks(storage: Storage): Task[] {
  return loadTasks(storage.db, {
    condition: `t.archived_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workspaces aw WHERE aw.id = t.workspace_id AND aw.archived_at IS NOT NULL)`,
    parameters: [],
  }, "all");
}

export function reviewTasks(storage: Storage): Task[] {
  return loadTasks(storage.db, { condition: "1 = 1", parameters: [] }, "all");
}

export function deleteTask(storage: Storage, id: TaskId): void {
  if (storage.db.run("DELETE FROM tasks WHERE id = ?1", [id]).changes === 0) {
    throw new StorageError({ kind: "task_not_found", task: id });
  }
}
