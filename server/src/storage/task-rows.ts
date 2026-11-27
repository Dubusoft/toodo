import type { Criterion } from "../domain/criteria.ts";
import { NOTE_KINDS, taskId, workspaceId } from "../domain/model.ts";
import type { Task, TaskId, TaskNote } from "../domain/model.ts";
import { DueDate, Estimate, ESTIMATE_UNITS, InvalidDueDate, InvalidEstimate } from "../domain/plan.ts";
import { debugString } from "../domain/rust.ts";
import { TASK_STATUSES } from "../domain/status.ts";
import type { TaskEvent } from "../domain/timeline.ts";
import { StorageError } from "./errors.ts";

export const TASK_SELECT = `SELECT t.id, t.workspace_id, t.type, t.title, t.description,
  t.status, t.completion_note, t.resolution, t.issue_number, t.issue_url, t.estimate_unit,
  t.estimate_amount, t.due_date, t.refs, t.wait_until, t.wait_status, t.autopilot_at
  FROM tasks t JOIN workspaces w ON w.id = t.workspace_id`;

export type TaskRow = {
  readonly id: number;
  readonly workspace_id: number;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly completion_note: string | null;
  readonly resolution: string | null;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly estimate_unit: string | null;
  readonly estimate_amount: number | null;
  readonly due_date: string | null;
  readonly refs: string;
  readonly wait_until: number | null;
  readonly wait_status: string | null;
  readonly autopilot_at: number | null;
};

export function invalidData(reason: string): StorageError {
  return new StorageError({ kind: "invalid_data", reason });
}

export function parseStoredVariant<T extends string>(variants: readonly T[], raw: string, field: string): T {
  const parsed = variants.find((value) => value === raw);
  if (parsed === undefined) throw invalidData(`unknown ${field} ${debugString(raw)}`);
  return parsed;
}

export function parseTaskStatus(raw: string) {
  return parseStoredVariant(TASK_STATUSES, raw, "task status");
}

export function parseNoteKind(raw: string) {
  return parseStoredVariant(NOTE_KINDS, raw, "note kind");
}

const TYPES = ["feat", "fix", "modify", "refactor", "docs", "test", "chore", "rnd"] as const;
const RESOLUTIONS = ["merged", "completed", "not_adopted"] as const;

function planValue<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof InvalidEstimate || error instanceof InvalidDueDate) throw invalidData(error.message);
    throw error;
  }
}

function parseEstimate(unit: string | null, amount: number | null): Estimate | null {
  if (unit === null && amount === null) return null;
  if (unit === null || amount === null) throw invalidData("estimate unit and amount must be set together");
  const parsed = parseStoredVariant(ESTIMATE_UNITS, unit, "estimate unit");
  return planValue(() => Estimate.of(parsed, amount));
}

function parseRefs(row: TaskRow): string[] {
  const error = () => invalidData(`task ${row.id} has refs that are not a JSON array of strings: ${row.refs}`);
  let refs: unknown;
  try {
    refs = JSON.parse(row.refs);
  } catch (cause) {
    if (cause instanceof SyntaxError) throw error();
    throw cause;
  }
  if (!Array.isArray(refs) || !refs.every((ref): ref is string => typeof ref === "string" && ref.isWellFormed())) {
    throw error();
  }
  return refs;
}

type TaskDetails = {
  readonly dependsOn: readonly TaskId[];
  readonly timeline: readonly TaskEvent[];
  readonly notes: readonly TaskNote[];
  readonly criteria: readonly Criterion[];
  readonly labels: readonly string[];
};

export function taskFromRow(row: TaskRow, details: TaskDetails): Task {
  const refs = parseRefs(row);
  const { wait_until: until, wait_status: status, due_date: due } = row;
  if ((until === null) !== (status === null)) {
    throw invalidData(`task ${row.id} has only one of wait_until and wait_status`);
  }
  const wait = until !== null && status !== null ? { until, status: parseTaskStatus(status) } : null;
  return {
    ...details,
    id: taskId(row.id), workspaceId: workspaceId(row.workspace_id),
    taskType: parseStoredVariant(TYPES, row.type, "task type"),
    title: row.title, description: row.description, status: parseTaskStatus(row.status),
    resolution: row.resolution === null ? null : parseStoredVariant(RESOLUTIONS, row.resolution, "task resolution"),
    dependsOn: new Set([...details.dependsOn].sort((a, b) => a - b)),
    completionNote: row.completion_note,
    issue: row.issue_number === null ? null : { number: row.issue_number, url: row.issue_url ?? "" },
    estimate: parseEstimate(row.estimate_unit, row.estimate_amount),
    dueDate: due === null ? null : planValue(() => DueDate.parse(due)),
    refs, wait, autopilotAt: row.autopilot_at,
  };
}
