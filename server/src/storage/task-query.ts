import type { Database } from "bun:sqlite";
import { blockingDependencies, DependencyError, DependencyGraph, topologicalOrder } from "../domain/dag.ts";
import { taskId } from "../domain/model.ts";
import type { Task, TaskId, WorkspaceId } from "../domain/model.ts";
import type { TaskStatus } from "../domain/status.ts";
import { loadCriteria } from "./criteria.ts";
import { StorageError } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { parseNoteKind, parseTaskStatus, taskFromRow, TASK_SELECT } from "./task-rows.ts";
import type { TaskRow } from "./task-rows.ts";
import { LIVE_PREREQUISITE, LIVE_TASK } from "./task-sql.ts";
import type { TaskFilter } from "./task-sql.ts";

type Edge = { readonly task_id: number; readonly depends_on_id: number };
type Event = { readonly task_id: number; readonly status: string; readonly at: number; readonly reason: string | null };
type Note = { readonly task_id: number; readonly kind: string; readonly body: string; readonly at: number };
type Label = { readonly task_id: number; readonly label: string };
const EVERY_TASK = { condition: "1 = 1", parameters: [] } as const;

function groupRows<Row extends { readonly task_id: number }, Value>(
  rows: readonly Row[], read: (row: Row) => Value,
): Map<number, Value[]> {
  const groups = new Map<number, Value[]>();
  for (const row of rows) {
    const values = groups.get(row.task_id);
    const value = read(row);
    if (values === undefined) groups.set(row.task_id, [value]);
    else values.push(value);
  }
  return groups;
}

export function loadTasks(db: Database, filter: TaskFilter, scope: "live" | "all" = "live"): Task[] {
  const condition = scope === "live" ? `(${filter.condition}) AND ${LIVE_TASK}` : filter.condition;
  const edges = scope === "live" ? `AND ${LIVE_PREREQUISITE}` : "";
  const p = filter.parameters;
  const rows = db.query<TaskRow, number[]>(`${TASK_SELECT} WHERE ${condition} ORDER BY t.id`).all(...p);
  const dependencies = groupRows(db.query<Edge, number[]>(`
    SELECT d.task_id, d.depends_on_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
    WHERE ${condition} ${edges}
  `).all(...p), (row) => taskId(row.depends_on_id));
  const timelines = groupRows(db.query<Event, number[]>(`
    SELECT e.task_id, e.status, e.at, e.reason FROM task_events e JOIN tasks t ON t.id = e.task_id
    WHERE ${condition} ORDER BY e.id
  `).all(...p), ({ status, at, reason }) => ({ status: parseTaskStatus(status), at, reason }));
  const notes = groupRows(db.query<Note, number[]>(`
    SELECT n.task_id, n.kind, n.body, n.at FROM task_notes n JOIN tasks t ON t.id = n.task_id
    WHERE ${condition} ORDER BY n.id
  `).all(...p), ({ kind, body, at }) => ({ kind: parseNoteKind(kind), body, at }));
  const criteria = loadCriteria(db, { condition, parameters: p });
  const labels = groupRows(db.query<Label, number[]>(`
    SELECT l.task_id, l.label FROM task_labels l JOIN tasks t ON t.id = l.task_id
    WHERE ${condition} ORDER BY l.label
  `).all(...p), ({ label }) => label);
  return rows.map((row) => taskFromRow(row, {
    dependsOn: dependencies.get(row.id) ?? [],
    timeline: timelines.get(row.id) ?? [],
    notes: notes.get(row.id) ?? [],
    criteria: criteria.get(row.id) ?? [],
    labels: labels.get(row.id) ?? [],
  }));
}

export function findTask(db: Database, id: TaskId): Task | null {
  return loadTasks(db, { condition: "t.id = ?", parameters: [id] })[0] ?? null;
}

export function requireTask(db: Database, id: TaskId): Task {
  const task = findTask(db, id);
  if (task === null) throw new StorageError({ kind: "task_not_found", task: id });
  return task;
}

export function getTask(storage: Storage, id: TaskId): Task | null {
  return findTask(storage.db, id);
}

export function listTasks(storage: Storage, workspace: WorkspaceId): Task[] {
  return loadTasks(storage.db, { condition: "t.workspace_id = ?", parameters: [workspace] });
}

export function allTasks(db: Database): Task[] {
  return loadTasks(db, EVERY_TASK);
}

export function listAllTasks(storage: Storage): Task[] {
  return allTasks(storage.db);
}

export type TaskQuery = {
  readonly workspace?: WorkspaceId | null;
  readonly statuses?: readonly TaskStatus[];
  readonly ids?: readonly TaskId[] | null;
  readonly before?: TaskId | null;
  readonly limit?: number | null;
  readonly autopilot?: boolean | null;
};

export function queryTasks(storage: Storage, query: TaskQuery): Task[] {
  const { db } = storage;
  const conditions: string[] = [];
  const parameters: number[] = [];
  if (query.workspace != null) {
    conditions.push("t.workspace_id = ?");
    parameters.push(query.workspace);
  }
  if (query.statuses?.length) {
    conditions.push(`t.status IN (${query.statuses.map((status) => `'${parseTaskStatus(status)}'`).join(", ")})`);
  }
  if (query.ids != null) {
    if (query.ids.length === 0) return [];
    conditions.push(`t.id IN (${query.ids.map(() => "?").join(", ")})`);
    parameters.push(...query.ids);
  }
  if (query.before != null) {
    conditions.push("t.id < ?");
    parameters.push(query.before);
  }
  if (query.autopilot != null) {
    conditions.push("t.autopilot = ?");
    parameters.push(Number(query.autopilot));
  }
  const filter = conditions.join(" AND ") || EVERY_TASK.condition;
  if (query.limit == null) return loadTasks(db, { condition: filter, parameters });
  const selected = db.query<{ readonly id: number }, number[]>(`
    SELECT t.id FROM tasks t WHERE ${filter} AND ${LIVE_TASK} ORDER BY t.id DESC LIMIT ?
  `).all(...parameters, query.limit);
  const highest = selected[0];
  const lowest = selected.at(-1);
  if (highest === undefined || lowest === undefined) return [];
  return loadTasks(db, {
    condition: `${filter} AND t.id BETWEEN ? AND ?`,
    parameters: [...parameters, lowest.id, highest.id],
  });
}

export function dependencyGraph(db: Database): DependencyGraph {
  const tasks = db.query<{ readonly id: number }, []>(`SELECT t.id FROM tasks t WHERE ${LIVE_TASK}`).all();
  const edges = db.query<Edge, []>(`
    SELECT d.task_id, d.depends_on_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
    WHERE ${LIVE_TASK} AND ${LIVE_PREREQUISITE}
  `).all();
  return new DependencyGraph(
    tasks.map(({ id }) => taskId(id)),
    edges.map((edge) => ({ task: taskId(edge.task_id), dependsOn: taskId(edge.depends_on_id) })),
  );
}

export function withDependencyErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DependencyError) throw new StorageError({ kind: "dependency", error });
    throw error;
  }
}

export function liveCycle(db: Database): readonly TaskId[] | null {
  const tasks = allTasks(db);
  return withDependencyErrors(() => {
    try {
      topologicalOrder(tasks);
      return null;
    } catch (error) {
      if (error instanceof DependencyError && error.problem.kind === "cycle") return error.problem.path;
      throw error;
    }
  });
}

export function ensureAcyclic(db: Database): void {
  const path = liveCycle(db);
  if (path !== null) throw new StorageError({ kind: "restore_closes_cycle", path });
}

export function ensureTaskReady(db: Database, task: TaskId): void {
  const tasks = allTasks(db);
  const blockers = withDependencyErrors(() => blockingDependencies(tasks, task));
  if (blockers.length > 0) throw new StorageError({ kind: "dependencies_not_done", task, blockers });
}

export function ensureReady(storage: Storage, task: TaskId): void {
  ensureTaskReady(storage.db, task);
}
