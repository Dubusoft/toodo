import { GUIDELINE_KINDS, guidelineId, workspaceId } from "../domain/model.ts";
import type { Guideline, GuidelineId, GuidelineKind, WorkspaceId } from "../domain/model.ts";
import { debugString } from "../domain/rust.ts";
import { StorageError } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { getWorkspace } from "./workspaces.ts";

export type NewGuideline = Pick<Guideline, "workspaceId" | "kind" | "body">;

type GuidelineRow = {
  readonly id: number;
  readonly workspace_id: number;
  readonly kind: string;
  readonly body: string;
  readonly created_at: number;
  readonly updated_at: number;
};

const COLUMNS = "id, workspace_id, kind, body, created_at, updated_at";

function guideline(row: GuidelineRow): Guideline {
  const kind = GUIDELINE_KINDS.find((known) => known === row.kind);
  if (kind === undefined) {
    throw new StorageError({ kind: "invalid_data", reason: `unknown guideline kind ${debugString(row.kind)}` });
  }
  return {
    id: guidelineId(row.id), workspaceId: workspaceId(row.workspace_id), kind,
    body: row.body, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function ensureLiveWorkspace(storage: Storage, workspace: WorkspaceId): void {
  if (getWorkspace(storage, workspace) === null) {
    throw new StorageError({ kind: "workspace_not_found", workspace });
  }
}

export function listGuidelines(storage: Storage, workspace: WorkspaceId): Guideline[] {
  ensureLiveWorkspace(storage, workspace);
  return storage.db.query<GuidelineRow, [WorkspaceId]>(`
    SELECT ${COLUMNS} FROM workspace_guidelines WHERE workspace_id = ?1
    ORDER BY kind = 'memory', id
  `).all(workspace).map(guideline);
}

export function getGuideline(storage: Storage, id: GuidelineId): Guideline | null {
  const row = storage.db.query<GuidelineRow, [GuidelineId]>(`
    SELECT ${COLUMNS} FROM workspace_guidelines WHERE id = ?1
  `).get(id);
  return row === null ? null : guideline(row);
}

function requireGuideline(storage: Storage, id: GuidelineId): Guideline {
  const result = getGuideline(storage, id);
  if (result === null) throw new StorageError({ kind: "guideline_not_found", guideline: id });
  return result;
}

export function addGuideline(storage: Storage, input: NewGuideline): Guideline {
  ensureLiveWorkspace(storage, input.workspaceId);
  const result = storage.db.run(`
    INSERT INTO workspace_guidelines (workspace_id, kind, body, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?4)
  `, [input.workspaceId, input.kind, input.body, storage.now()]);
  return requireGuideline(storage, guidelineId(Number(result.lastInsertRowid)));
}

export function updateGuideline(
  storage: Storage, id: GuidelineId, kind: GuidelineKind, body: string,
): Guideline {
  const result = storage.db.run(`
    UPDATE workspace_guidelines SET kind = ?2, body = ?3, updated_at = ?4 WHERE id = ?1
  `, [id, kind, body, storage.now()]);
  if (result.changes === 0) throw new StorageError({ kind: "guideline_not_found", guideline: id });
  return requireGuideline(storage, id);
}

export function deleteGuideline(storage: Storage, id: GuidelineId): Guideline {
  const row = storage.transaction(() => {
    const deleted = storage.db.query<GuidelineRow, [GuidelineId]>(`
      DELETE FROM workspace_guidelines WHERE id = ?1 RETURNING ${COLUMNS}
    `).get(id);
    if (deleted === null) throw new StorageError({ kind: "guideline_not_found", guideline: id });
    return deleted;
  }, "deferred");
  return guideline(row);
}
