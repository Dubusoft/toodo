import type { Database } from "bun:sqlite";
import { taskId, workspaceId } from "../domain/model.ts";
import type { Workspace, WorkspaceId } from "../domain/model.ts";
import { StorageError } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { ensureAcyclic } from "./task-query.ts";
import { LIVE_TASK } from "./task-sql.ts";

export type NewWorkspace = Pick<Workspace, "name" | "description" | "repository"> & { readonly machine?: string | null };

const COLUMNS = "id, name, description, repository, machine, archived_at AS archivedAt";

function ensureArchived(db: Database, id: WorkspaceId): void {
  const row = db.query<Pick<Workspace, "archivedAt">, [WorkspaceId]>(
    "SELECT archived_at AS archivedAt FROM workspaces WHERE id = ?1",
  ).get(id);
  if (row === null) throw new StorageError({ kind: "workspace_not_found", workspace: id });
  if (row.archivedAt === null) throw new StorageError({ kind: "workspace_not_archived", workspace: id });
}

function requireWorkspace(storage: Storage, id: WorkspaceId): Workspace {
  const workspace = getWorkspace(storage, id);
  if (workspace === null) throw new StorageError({ kind: "workspace_not_found", workspace: id });
  return workspace;
}

export function createWorkspace(storage: Storage, input: NewWorkspace): Workspace {
  const result = storage.db.run(
    "INSERT INTO workspaces (name, description, repository, machine) VALUES (?1, ?2, ?3, ?4)",
    [input.name, input.description, input.repository, input.machine ?? null],
  );
  return requireWorkspace(storage, workspaceId(Number(result.lastInsertRowid)));
}

export function getWorkspace(storage: Storage, id: WorkspaceId): Workspace | null {
  return storage.db.query<Workspace, [WorkspaceId]>(`
    SELECT ${COLUMNS} FROM workspaces WHERE id = ?1 AND archived_at IS NULL
  `).get(id);
}

function workspacesWhere(db: Database, filter: "archived_at IS NULL" | "archived_at IS NOT NULL"): Workspace[] {
  return db.query<Workspace, []>(`SELECT ${COLUMNS} FROM workspaces WHERE ${filter} ORDER BY id`).all();
}

export function listWorkspaces(storage: Storage): Workspace[] {
  return workspacesWhere(storage.db, "archived_at IS NULL");
}

export function archivedWorkspaces(storage: Storage): Workspace[] {
  return workspacesWhere(storage.db, "archived_at IS NOT NULL");
}

export function updateWorkspace(storage: Storage, workspace: Workspace): void {
  const result = storage.db.run(`
    UPDATE workspaces SET name = ?2, description = ?3, repository = ?4, machine = ?5
    WHERE id = ?1 AND archived_at IS NULL
  `, [workspace.id, workspace.name, workspace.description, workspace.repository, workspace.machine]);
  if (result.changes === 0) throw new StorageError({ kind: "workspace_not_found", workspace: workspace.id });
}

export function archiveWorkspace(storage: Storage, id: WorkspaceId): void {
  const at = storage.now();
  storage.transaction(() => {
    const live = storage.db.query<{ readonly live: number }, [WorkspaceId]>(`
      SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND archived_at IS NULL) AS live
    `).get(id);
    if (!live?.live) throw new StorageError({ kind: "workspace_not_found", workspace: id });
    const dependent = storage.db.query<
      { readonly task_id: number; readonly depends_on_id: number }, [WorkspaceId]
    >(`
      SELECT d.task_id, d.depends_on_id
      FROM task_dependencies d
      JOIN tasks t ON t.id = d.task_id
      JOIN tasks p ON p.id = d.depends_on_id
      WHERE p.workspace_id = ?1 AND t.workspace_id <> ?1
        AND t.status = 'planned' AND p.archived_at IS NULL AND ${LIVE_TASK}
      ORDER BY d.task_id, d.depends_on_id LIMIT 1
    `).get(id);
    if (dependent !== null) {
      throw new StorageError({
        kind: "workspace_has_dependents", workspace: id,
        task: taskId(dependent.task_id), dependsOn: taskId(dependent.depends_on_id),
      });
    }
    storage.db.run("UPDATE workspaces SET archived_at = ?2 WHERE id = ?1", [id, at]);
  }, "deferred");
}

export function restoreWorkspace(storage: Storage, id: WorkspaceId): Workspace {
  storage.transaction(() => {
    ensureArchived(storage.db, id);
    storage.db.run("UPDATE workspaces SET archived_at = NULL WHERE id = ?1", [id]);
    ensureAcyclic(storage.db);
  }, "deferred");
  return requireWorkspace(storage, id);
}

export function purgeWorkspace(storage: Storage, id: WorkspaceId): void {
  storage.transaction(() => {
    ensureArchived(storage.db, id);
    storage.db.run("DELETE FROM workspaces WHERE id = ?1", [id]);
  }, "deferred");
}
