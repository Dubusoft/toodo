import type { Database } from "bun:sqlite";
import type { NewCriterion } from "../domain/criteria.ts";
import { taskId } from "../domain/model.ts";
import type { LinkedIssue, NoteKind, Task, TaskId } from "../domain/model.ts";
import { insertCriteria } from "./criteria.ts";
import { StorageError } from "./errors.ts";
import { linkRelated } from "./search.ts";
import type { Storage } from "./storage.ts";
import { insertDependency } from "./task-dependencies.ts";
import { recordEvent } from "./task-events.ts";
import { dependencyGraph, requireTask, withDependencyErrors } from "./task-query.ts";

export type NewTask = Pick<Task, "workspaceId" | "taskType" | "title" | "description" | "estimate" | "dueDate"> & {
  readonly autopilot: boolean;
  readonly criteria: readonly NewCriterion[];
};

export type PlanLink =
  | { readonly kind: "existing"; readonly id: TaskId }
  | { readonly kind: "new"; readonly index: number };

export type NewPlanTask = {
  readonly task: NewTask;
  readonly labels: readonly string[];
  readonly refs: readonly string[];
  readonly dependsOn: readonly PlanLink[];
  readonly related: readonly PlanLink[];
};

function insertTask(db: Database, input: NewTask, at: number): TaskId {
  const result = db.run(`INSERT INTO tasks (workspace_id, type, title, description, status,
      estimate_unit, estimate_amount, due_date, autopilot, autopilot_at)
    SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 FROM workspaces
    WHERE id = ?1 AND archived_at IS NULL`,
    [input.workspaceId, input.taskType, input.title, input.description, "planned",
    input.estimate?.unit ?? null, input.estimate?.amount ?? null, input.dueDate?.toString() ?? null,
    Number(input.autopilot), input.autopilot ? at : null]);
  if (result.changes === 0) throw new StorageError({ kind: "workspace_not_found", workspace: input.workspaceId });
  const id = taskId(Number(result.lastInsertRowid));
  recordEvent(db, { task: id, status: "planned", at });
  insertCriteria(db, id, input.criteria);
  return id;
}

export function createTask(storage: Storage, input: NewTask): Task {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => requireTask(db, insertTask(db, input, at)), "deferred");
}

function resolveLink(link: PlanLink, ids: readonly TaskId[]): TaskId {
  switch (link.kind) {
    case "existing": return link.id;
    case "new": {
      const id = ids[link.index];
      if (id === undefined) throw new StorageError({ kind: "plan_link_out_of_range", index: link.index, tasks: ids.length });
      return id;
    }
    default: return link satisfies never;
  }
}

function writeLabels(db: Database, id: TaskId, labels: readonly string[]): void {
  for (const label of labels) {
    db.run("INSERT OR IGNORE INTO task_labels (task_id, label) VALUES (?1, ?2)", [id, label]);
  }
}

export function writeRefs(db: Database, id: TaskId, refs: readonly string[]): void {
  db.run("UPDATE tasks SET refs = ?2 WHERE id = ?1", [id, JSON.stringify(refs)]);
}

export function createTasks(storage: Storage, plan: readonly NewPlanTask[]): Task[] {
  const { db } = storage;
  const at = storage.now();
  return storage.transaction(() => {
    const items = plan.map((item) => {
      const id = insertTask(db, item.task, at);
      writeLabels(db, id, item.labels);
      if (item.refs.length > 0) writeRefs(db, id, item.refs);
      return { item, id };
    });
    const ids = items.map(({ id }) => id);
    const graph = dependencyGraph(db);
    for (const { item, id } of items) {
      for (const link of item.dependsOn) {
        const prerequisite = resolveLink(link, ids);
        withDependencyErrors(() => graph.add(id, prerequisite));
        insertDependency(db, id, prerequisite);
      }
      for (const link of item.related) linkRelated(db, id, resolveLink(link, ids));
    }
    return ids.map((id) => requireTask(db, id));
  }, "deferred");
}

export function updateTask(storage: Storage, task: Task): void {
  const { changes } = storage.db.run(`UPDATE tasks
    SET type = ?2, title = ?3, description = ?4, estimate_unit = ?5, estimate_amount = ?6,
        due_date = ?7, autopilot = ?8, autopilot_at = ?9 WHERE id = ?1`,
    [task.id, task.taskType, task.title, task.description, task.estimate?.unit ?? null,
    task.estimate?.amount ?? null, task.dueDate?.toString() ?? null, Number(task.autopilotAt !== null),
    task.autopilotAt]);
  if (changes === 0) throw new StorageError({ kind: "task_not_found", task: task.id });
}

export function setTaskLabels(storage: Storage, id: TaskId, labels: readonly string[]): Task {
  const { db } = storage;
  return storage.transaction(() => {
    requireTask(db, id);
    db.run("DELETE FROM task_labels WHERE task_id = ?1", [id]);
    writeLabels(db, id, labels);
    return requireTask(db, id);
  }, "deferred");
}

export function setTaskRefs(storage: Storage, id: TaskId, refs: readonly string[]): Task {
  const { db } = storage;
  return storage.transaction(() => {
    requireTask(db, id);
    writeRefs(db, id, refs);
    return requireTask(db, id);
  }, "deferred");
}

export function addNote(db: Database, id: TaskId, note: { readonly kind: NoteKind; readonly body: string; readonly at: number }): void {
  const { changes } = db.run(`INSERT INTO task_notes (task_id, kind, body, at)
    SELECT id, ?2, ?3, ?4 FROM tasks WHERE id = ?1`, [id, note.kind, note.body, note.at]);
  if (changes === 0) throw new StorageError({ kind: "task_not_found", task: id });
}

export function addTaskNote(storage: Storage, id: TaskId, kind: NoteKind, body: string): Task {
  const at = storage.now();
  return storage.transaction(() => {
    addNote(storage.db, id, { kind, body, at });
    return requireTask(storage.db, id);
  }, "deferred");
}

export function setTaskIssue(storage: Storage, id: TaskId, issue: LinkedIssue | null): Task {
  const { db } = storage;
  return storage.transaction(() => {
    const { changes } = db.run("UPDATE tasks SET issue_number = ?2, issue_url = ?3 WHERE id = ?1",
      [id, issue?.number ?? null, issue?.url ?? null]);
    if (changes === 0) throw new StorageError({ kind: "task_not_found", task: id });
    return requireTask(db, id);
  }, "deferred");
}
