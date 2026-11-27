import type { Database } from "bun:sqlite";
import { CHECK_KINDS, CHECKED_BY, CRITERION_STATES, criterionId, isAutomatic, isMet } from "../domain/criteria.ts";
import type { CheckedBy, Criterion, CriterionId, CriterionState, NewCriterion } from "../domain/criteria.ts";
import { taskId } from "../domain/model.ts";
import type { Task, TaskId } from "../domain/model.ts";
import { StorageError } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { requireTask } from "./task-query.ts";
import { parseStoredVariant } from "./task-rows.ts";
import type { TaskFilter } from "./task-sql.ts";

export type CriterionEdit = {
  readonly id: CriterionId | null;
  readonly criterion: NewCriterion;
};

export type CriterionCheck = {
  readonly id: CriterionId;
  readonly state: CriterionState;
  readonly evidence: string | null;
  readonly target: string | null;
};

type CriterionRow = {
  readonly task_id: number;
  readonly id: number;
  readonly text: string;
  readonly kind: string;
  readonly target: string | null;
  readonly state: string;
  readonly evidence: string | null;
  readonly checked_by: string | null;
  readonly checked_at: number | null;
};

export function loadCriteria(db: Database, filter: TaskFilter): Map<number, Criterion[]> {
  const rows = db.query<CriterionRow, number[]>(`
    SELECT c.task_id, c.id, c.text, c.kind, c.target, c.state, c.evidence, c.checked_by, c.checked_at
    FROM task_criteria c JOIN tasks t ON t.id = c.task_id
    WHERE ${filter.condition} ORDER BY c.task_id, c.position, c.id
  `).all(...filter.parameters);
  const criteria = new Map<number, Criterion[]>();
  for (const row of rows) {
    const criterion: Criterion = {
      id: criterionId(row.id), text: row.text,
      kind: parseStoredVariant(CHECK_KINDS, row.kind, "criterion kind"), target: row.target,
      state: parseStoredVariant(CRITERION_STATES, row.state, "criterion state"), evidence: row.evidence,
      checkedBy: row.checked_by === null ? null : parseStoredVariant(CHECKED_BY, row.checked_by, "criterion checker"),
      checkedAt: row.checked_at,
    };
    const group = criteria.get(row.task_id);
    if (group === undefined) criteria.set(row.task_id, [criterion]);
    else group.push(criterion);
  }
  return criteria;
}

function insertCriterion(db: Database, task: TaskId, position: number, input: NewCriterion): void {
  db.run(`INSERT INTO task_criteria (task_id, position, text, kind, target) VALUES (?1, ?2, ?3, ?4, ?5)`,
    [task, position, input.text, input.kind, input.target]);
}

export function insertCriteria(db: Database, task: TaskId, criteria: readonly NewCriterion[]): void {
  const row = db.query<{ readonly next: number }, [TaskId]>(`
    SELECT coalesce(max(position) + 1, 0) AS next FROM task_criteria WHERE task_id = ?1
  `).get(task);
  if (row === null) throw new StorageError({ kind: "invalid_data", reason: "criterion position query returned no row" });
  for (const [position, input] of criteria.entries()) insertCriterion(db, task, row.next + position, input);
}

function openTask(db: Database, id: TaskId): Task {
  const task = requireTask(db, id);
  if (task.status === "done") throw new StorageError({ kind: "criteria_of_done_task", task: id });
  return task;
}

export function criterionTask(storage: Storage, criterion: CriterionId): TaskId | null {
  const row = storage.db.query<{ readonly task_id: number }, [CriterionId]>(
    "SELECT task_id FROM task_criteria WHERE id = ?1",
  ).get(criterion);
  return row === null ? null : taskId(row.task_id);
}

export function setCriteria(storage: Storage, id: TaskId, edits: readonly CriterionEdit[]): Task {
  const { db } = storage;
  return storage.transaction(() => {
    const task = openTask(db, id);
    const existing = new Map(task.criteria.map((criterion) => [criterion.id, criterion]));
    for (const edit of edits) {
      if (edit.id !== null && !existing.has(edit.id)) {
        throw new StorageError({ kind: "criterion_not_found", task: id, criterion: edit.id });
      }
    }
    const edited = new Set(edits.map(({ id }) => id));
    for (const known of task.criteria) {
      if (!edited.has(known.id)) db.run("DELETE FROM task_criteria WHERE id = ?1", [known.id]);
    }
    for (const [position, { id: editedId, criterion }] of edits.entries()) {
      const known = editedId === null ? undefined : existing.get(editedId);
      if (known === undefined) {
        insertCriterion(db, id, position, criterion);
      } else if (known.kind === criterion.kind && known.target === criterion.target) {
        db.run("UPDATE task_criteria SET position = ?2, text = ?3 WHERE id = ?1",
          [known.id, position, criterion.text]);
      } else {
        db.run(`UPDATE task_criteria
          SET position = ?2, text = ?3, kind = ?4, target = ?5, state = 'pending',
              evidence = NULL, checked_by = NULL, checked_at = NULL
          WHERE id = ?1`, [known.id, position, criterion.text, criterion.kind, criterion.target]);
      }
    }
    return requireTask(db, id);
  }, "deferred");
}

function writeCheck(db: Database, check: {
  readonly id: CriterionId; readonly state: CriterionState; readonly evidence: string | null;
  readonly by: CheckedBy | null; readonly at: number | null;
}): void {
  db.run(`UPDATE task_criteria SET state = ?2, evidence = ?3, checked_by = ?4, checked_at = ?5
    WHERE id = ?1`, [check.id, check.state, check.evidence, check.by, check.at]);
}

export function checkCriterion(
  storage: Storage, id: TaskId, criterion: CriterionId, met: boolean, evidence: string | null, by: CheckedBy,
): Task {
  const at = storage.now();
  const { db } = storage;
  return storage.transaction(() => {
    const task = openTask(db, id);
    const known = task.criteria.find((item) => item.id === criterion);
    if (known === undefined) throw new StorageError({ kind: "criterion_not_found", task: id, criterion });
    if (isAutomatic(known.kind)) {
      throw new StorageError({ kind: "automatic_criterion", task: id, criterion, checkKind: known.kind });
    }
    writeCheck(db, { id: criterion, evidence, state: met ? "met" : "pending", by: met ? by : null, at: met ? at : null });
    return requireTask(db, id);
  }, "deferred");
}

function appliesTo(check: CriterionCheck, known: Criterion): boolean {
  return known.id === check.id && isAutomatic(known.kind) && (check.target === null || check.target === known.target);
}

export function recordCriterionChecks(storage: Storage, id: TaskId, checks: readonly CriterionCheck[]): [Task, boolean] {
  const at = storage.now();
  const { db } = storage;
  return storage.transaction(() => {
    const task = requireTask(db, id);
    if (task.status === "done") return [task, false];
    let changed = false;
    for (const check of checks) {
      const known = task.criteria.find((item) => appliesTo(check, item));
      if (known === undefined || isMet(known) || (known.state === check.state && known.evidence === check.evidence)) continue;
      writeCheck(db, { ...check, by: "toodo", at: known.state === check.state ? known.checkedAt : at });
      changed = true;
    }
    const updated = requireTask(db, id);
    return [updated, changed || updated.status !== task.status];
  }, "deferred");
}

export function recordCriterionRechecks(storage: Storage, id: TaskId, checks: readonly CriterionCheck[]): Task {
  const at = storage.now();
  const { db } = storage;
  return storage.transaction(() => {
    const task = requireTask(db, id);
    if (task.status === "done") return task;
    for (const check of checks) {
      if (check.state === "met" || !task.criteria.some((known) => appliesTo(check, known) && isMet(known))) continue;
      writeCheck(db, { ...check, by: "toodo", at });
    }
    return requireTask(db, id);
  }, "deferred");
}
