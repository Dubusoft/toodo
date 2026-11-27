// The shapes commands exchange with their callers, which are the types of
// `src/lib/bindings.ts`, and their conversion from and to the domain model, as
// `src-tauri/src/commands/types/` does. Inputs are validated when they are converted into
// domain types, with the Rust messages.

import type * as B from "../../../src/lib/bindings.ts";
import type { commands } from "../../../src/lib/bindings.ts";
import {
  InvalidCriterion,
  parseNewCriterion,
  takesTarget,
  type Criterion,
  type NewCriterion,
} from "../domain/criteria.ts";
import type { Guideline, Task, TaskNote, Workspace } from "../domain/model.ts";
import { taskId, workspaceId } from "../domain/model.ts";
import {
  DueDate,
  Estimate,
  InvalidDueDate,
  InvalidEstimate,
  InvalidLabels,
  InvalidRefs,
  labels as planLabels,
  mergeRefs as planMergeRefs,
} from "../domain/plan.ts";
import { charCount, trim } from "../domain/rust.ts";
import { milestones } from "../domain/timeline.ts";
import type { Storage } from "../storage/storage.ts";
import type { TaskQuery } from "../storage/task-query.ts";
import type { NewTask } from "../storage/tasks.ts";
import { invalidInput } from "./errors.ts";

type Bindings = typeof commands;

type Data<Reply> = Reply extends { status: "ok"; data: infer T }
  ? T
  : Reply extends { status: "error" }
    ? never
    : Reply;

/** The arguments the web app passes to the command `Name`. */
export type Args<Name extends keyof Bindings> = Parameters<Bindings[Name]>;

/** The data of the command `Name`'s reply. */
export type Reply<Name extends keyof Bindings> = Data<Awaited<ReturnType<Bindings[Name]>>>;

/** The command `Name` of the bindings as the server runs it: on `storage`, with the
 * arguments the web app passes, returning the data of its reply. Commands that need more
 * state than the storage take it before the arguments, typed with `Args` and `Reply`. */
export type Command<Name extends keyof Bindings> = (storage: Storage, ...args: Args<Name>) => Reply<Name>;

export function workspace(w: Workspace): B.Workspace {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    repository: w.repository,
    archivedAt: w.archivedAt,
  };
}

export function guideline(g: Guideline): B.Guideline {
  return {
    id: g.id,
    workspaceId: g.workspaceId,
    kind: g.kind,
    body: g.body,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

function criterion(c: Criterion): B.Criterion {
  return {
    id: c.id,
    text: c.text,
    kind: c.kind,
    target: c.target,
    state: c.state,
    evidence: c.evidence,
    checkedBy: c.checkedBy,
    checkedAt: c.checkedAt,
  };
}

function note(n: TaskNote): B.TaskNote {
  return { kind: n.kind, body: n.body, at: n.at };
}

export function task(t: Task): B.Task {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    taskType: t.taskType,
    title: t.title,
    description: t.description,
    status: t.status,
    resolution: t.resolution,
    dependsOn: [...t.dependsOn],
    issue: t.issue === null ? null : { number: t.issue.number, url: t.issue.url },
    estimate: t.estimate === null ? null : { unit: t.estimate.unit, amount: t.estimate.amount },
    dueDate: t.dueDate === null ? null : t.dueDate.toString(),
    labels: [...t.labels],
    refs: [...t.refs],
    completionNote: t.completionNote,
    timeline: t.timeline.map((event, index) => ({
      status: event.status,
      at: event.at,
      reopened: index > 0 && t.timeline[index - 1].status === "done" && event.status !== "done",
      reason: event.reason,
    })),
    milestones: milestones(t.timeline),
    notes: t.notes.map(note),
    criteria: t.criteria.map(criterion),
    wait: t.wait === null ? null : { until: t.wait.until, status: t.wait.status },
    autopilot: t.autopilotAt !== null,
    autopilotAt: t.autopilotAt,
  };
}

/** `value` trimmed, which must not be blank; `field` names it in the rejection. */
export function required(field: string, value: string): string {
  const trimmed = trim(value);
  if (trimmed === "") throw invalidInput(`${field} must not be empty`);
  return trimmed;
}

/** The most characters a guideline body may have, after trimming. */
export const GUIDELINE_BODY_LIMIT = 4000;

/** A guideline body, trimmed: non-empty and at most `GUIDELINE_BODY_LIMIT` characters. */
export function guidelineBody(body: string): string {
  const trimmed = trim(body);
  if (trimmed === "") {
    throw invalidInput("guideline body must not be empty; send the rule or memory as Markdown text in body");
  }
  const length = charCount(trimmed);
  if (length > GUIDELINE_BODY_LIMIT) {
    throw invalidInput(
      `guideline body has ${length} characters, more than the limit of ${GUIDELINE_BODY_LIMIT}; shorten it, or split it into several guidelines and add each with its own add_guideline call`,
    );
  }
  return trimmed;
}

/** Runs `parse`, reporting a rejection of the domain rules as invalid input. */
function validated<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (
      error instanceof InvalidEstimate ||
      error instanceof InvalidDueDate ||
      error instanceof InvalidLabels ||
      error instanceof InvalidRefs ||
      error instanceof InvalidCriterion
    ) {
      throw invalidInput(error.message);
    }
    throw error;
  }
}

export function estimate(input: B.Estimate | null): Estimate | null {
  return input === null ? null : validated(() => Estimate.of(input.unit, input.amount));
}

/** Labels of a task, trimmed, sorted, and unique. */
export function labels(raw: readonly string[]): string[] {
  return validated(() => planLabels(raw));
}

/** The references of a task after appending `add` to `current` and dropping `remove`. */
export function mergeRefs(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  return validated(() => planMergeRefs(current, add, remove));
}

/** A due date as `YYYY-MM-DD`; blank means none. */
export function dueDate(raw: string | null): DueDate | null {
  const trimmed = raw === null ? "" : trim(raw);
  return trimmed === "" ? null : validated(() => DueDate.parse(trimmed));
}

/** The most tasks one page of a task list holds, and the most task IDs a list may ask for. */
export const MAX_TASK_PAGE = 500;

/** Checks that `limit` is a page size a task list accepts. */
export function taskPageLimit(limit: number): void {
  if (limit < 1 || limit > MAX_TASK_PAGE) {
    throw invalidInput(
      `limit ${limit} is out of range; pass a limit from 1 to ${MAX_TASK_PAGE}, and pass the lowest task ID of a full page as before to read the next page`,
    );
  }
}

export function taskQuery(filter: B.TaskListFilter | null): TaskQuery {
  const { workspaceId: workspace, statuses, ids, before, limit } = filter ?? {};
  if (limit !== undefined && limit !== null) taskPageLimit(limit);
  if (ids !== undefined && ids !== null && ids.length > MAX_TASK_PAGE) {
    throw invalidInput(
      `ids lists more than ${MAX_TASK_PAGE} tasks; split them into lists of at most ${MAX_TASK_PAGE} IDs and list each`,
    );
  }
  return {
    workspace: workspace === undefined || workspace === null ? null : workspaceId(workspace),
    statuses: statuses ?? [],
    ids: ids === undefined || ids === null ? null : ids.map(taskId),
    before: before === undefined || before === null ? null : taskId(before),
    limit: limit ?? null,
    autopilot: null,
  };
}

/** A new criterion from `input`, which needs its text and kind. */
export function parseCriterion(input: B.CriterionInput): NewCriterion {
  const { text, kind } = input;
  if (text === undefined || text === null || kind === undefined || kind === null) {
    throw invalidInput(
      'a new criterion needs text and kind, e.g. {"text": "Docs updated", "kind": "manual"}; give an existing one by its id instead',
    );
  }
  return validated(() => parseNewCriterion(text, kind, input.target ?? null));
}

/** The criterion an edit of `known` asks for: omitted fields keep the stored values, and the
 * stored target stays only while the kind does. */
export function parseCriterionOver(input: B.CriterionInput, known: Criterion): NewCriterion {
  const kind = input.kind ?? known.kind;
  const text = input.text ?? known.text;
  const target = input.target ?? (kind === known.kind && takesTarget(kind) ? known.target : null);
  return validated(() => parseNewCriterion(text, kind, target));
}

/** The criteria of a new task, which cannot refer to existing ones. */
export function newCriteria(inputs: readonly B.CriterionInput[]): NewCriterion[] {
  return inputs.map((input) => {
    if (input.id !== undefined && input.id !== null) {
      throw invalidInput(`criterion ${input.id} cannot be given by id when creating a task`);
    }
    return parseCriterion(input);
  });
}

export function newTask(input: B.NewTask): NewTask {
  return {
    workspaceId: workspaceId(input.workspaceId),
    taskType: input.taskType,
    title: required("task title", input.title),
    description: input.description,
    estimate: estimate(input.estimate),
    dueDate: dueDate(input.dueDate),
    autopilot: input.autopilot ?? false,
    criteria: newCriteria(input.criteria),
  };
}
