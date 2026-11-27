// Commands for tasks, their dependency DAG, and their related links.

import type * as B from "../../../src/lib/api.ts";
import { criterionId, type CheckedBy } from "../domain/criteria.ts";
import { taskId, workspaceId, type Task, type TaskId, type TaskResolution } from "../domain/model.ts";
import { transitionTo, TransitionError } from "../domain/status.ts";
import { milestones } from "../domain/timeline.ts";
import { trim } from "../domain/rust.ts";
import type { CriterionEdit } from "../storage/criteria.ts";
import { StorageError } from "../storage/errors.ts";
import type { Storage } from "../storage/storage.ts";
import { command, invalidInput, notFound, rejected } from "./errors.ts";
import {
  dueDate,
  estimate,
  labels,
  mergeRefs,
  newTask,
  parseCriterion,
  parseCriterionOver,
  task,
  taskQuery,
  type Command,
} from "./types.ts";

function storedTask(storage: Storage, id: number): Task {
  const found = storage.getTask(taskId(id));
  if (found === null) throw new StorageError({ kind: "task_not_found", task: id });
  return found;
}

/** `text` trimmed, or `null` when it is absent or blank. */
function trimmedOrNull(text: string | null): string | null {
  const trimmed = text === null ? "" : trim(text);
  return trimmed === "" ? null : trimmed;
}

/** Tasks ordered by ID, each with its dependencies, which may belong to another workspace:
 * every task without a filter, else those the filter selects. With a limit, the matching
 * tasks with the highest IDs; pass the lowest ID of a full page as `before` to read the
 * next. */
export const listTasks: Command<"listTasks"> = command((storage, filter) =>
  storage.queryTasks(taskQuery(filter)).map(task));

export const getTask: Command<"getTask"> = command((storage, id) => task(storedTask(storage, id)));

/** Creates a `planned` task without dependencies, with its completion criteria. */
export const createTask: Command<"createTask"> = command((storage, input) => {
  const taskLabels = labels(input.labels ?? []);
  const created = storage.createTask(newTask(input));
  return task(taskLabels.length === 0 ? created : storage.setTaskLabels(created.id, taskLabels));
});

export const updateTask: Command<"updateTask"> = command((storage, edit) => {
  const status = edit.status ?? null;
  if (status !== null) {
    if (status !== "in_review") {
      throw rejected(
        "call update_task with status in_review; use start_task, pause_task, complete_task, or conclude_task for other status changes",
      );
    }
    const current = storedTask(storage, edit.id);
    try {
      transitionTo(current.status, "in_review");
    } catch (error) {
      if (error instanceof TransitionError) throw new StorageError({ kind: "transition", error });
      throw error;
    }
  }
  const title = trim(edit.title);
  if (title === "") throw invalidInput("task title must not be empty");
  const current = storedTask(storage, edit.id);
  const edited: Task = {
    ...current,
    taskType: edit.taskType,
    title,
    description: edit.description,
    estimate: estimate(edit.estimate),
    dueDate: dueDate(edit.dueDate),
    autopilotAt: edit.autopilot === undefined || edit.autopilot === null
      ? current.autopilotAt
      : edit.autopilot ? current.autopilotAt ?? storage.now() : null,
  };
  const newLabels = edit.labels === undefined || edit.labels === null ? null : labels(edit.labels);
  if (edit.criteria !== null) {
    if (current.status === "done") throw new StorageError({ kind: "criteria_of_done_task", task: current.id });
    storage.setCriteria(current.id, criterionEdits(storage, current, edit.criteria));
  }
  storage.updateTask(edited);
  if (status !== null) storage.setTaskStatus(current.id, status);
  if (newLabels !== null) storage.setTaskLabels(current.id, newLabels);
  return task(storedTask(storage, current.id));
});

/** The criteria `inputs` ask `current` to have, in order. An input with an `id` is an
 * existing criterion of the task whose omitted fields keep their stored values; each one
 * appears once. */
function criterionEdits(storage: Storage, current: Task, inputs: readonly B.CriterionInput[]): CriterionEdit[] {
  const edits: CriterionEdit[] = [];
  for (const input of inputs) {
    if (input.id === undefined || input.id === null) {
      edits.push({ id: null, criterion: parseCriterion(input) });
      continue;
    }
    const id = criterionId(input.id);
    if (edits.some((edit) => edit.id === id)) {
      throw invalidInput(`criterion ${id} appears twice; send each criterion once`);
    }
    const known = current.criteria.find((criterion) => criterion.id === id);
    if (known === undefined) {
      const owner = storage.criterionTask(id);
      const problem = owner === null
        ? `criterion ${id} does not exist`
        : `criterion ${id} belongs to task ${owner}, not task ${current.id}`;
      throw invalidInput(
        `${problem}; call get_task ${current.id} for the ids of its criteria, or leave out id to add a new criterion`,
      );
    }
    edits.push({ id, criterion: parseCriterionOver(input, known) });
  }
  return edits;
}

/** Checks (`met`) or unchecks a manual completion criterion of a task that is not done, with
 * what shows it; blank evidence is none. A task in progress whose criteria are then all met
 * awaits completion until it is completed. */
export const checkCriterion: Command<"checkCriterion"> = command((storage, task_, criterion, met, evidence) =>
  check(storage, task_, criterion, met, evidence, "user"));

/** Checks a manual criterion as `checkCriterion` does, as `by`. Without `taskId`, the task
 * is the one the criterion belongs to; with one, it must be that task. */
export function check(
  storage: Storage,
  task_: number | null,
  criterion: number,
  met: boolean,
  evidence: string | null,
  by: CheckedBy,
): B.Task {
  const owner = criterionOwner(storage, task_, criterion, "check_criterion");
  return task(storage.checkCriterion(owner, criterionId(criterion), met, trimmedOrNull(evidence), by));
}

/** The task `criterion` belongs to, which must be `task_` when that is given; `tool` names
 * the call to repeat in the rejection. */
export function criterionOwner(storage: Storage, task_: number | null, criterion: number, tool: string): TaskId {
  const owner = storage.criterionTask(criterionId(criterion));
  if (owner === null) {
    throw notFound(`criterion ${criterion} does not exist; call get_task on your task for the ids of its criteria`);
  }
  if (task_ !== null && task_ !== owner) {
    throw invalidInput(
      `criterion ${criterion} belongs to task ${owner}, not task ${task_}; call ${tool} with task_id ${owner}, or without task_id`,
    );
  }
  return owner;
}

/** Pauses an `in_progress` or `in_review` task by returning it to `planned`. */
export const pauseTask: Command<"pauseTask"> = command((storage, id) => pause(storage, id, null));

/** [`pauseTask`], recording `reason`, why the work stops, in the task's status history. */
export function pause(storage: Storage, id: number, reason: string | null): B.Task {
  const current = storedTask(storage, id);
  if (current.status === "planned") throw rejected(`task ${current.id} is not being worked on`);
  return task(storage.pauseTask(current.id, reason));
}

/** The range of seconds a Rust `jiff::Timestamp` holds: years -9999 to 9999. */
const EARLIEST_TIMESTAMP = -377_705_116_800;
const LATEST_TIMESTAMP = 253_402_207_200;

/** `seconds` as RFC 3339 in UTC, as a `jiff::Timestamp` prints it. */
function rfc3339(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/** Makes a `planned`, `in_progress`, or `in_review` task wait until `until`: it is paused
 * (`planned`) until then and returns on its own to the status it had, also after a restart
 * of the server. A task that already waits gets the new time. `reason`, if given, is kept
 * with the progress note the wait records. */
export const waitTask: Command<"waitTask"> = command((storage, id, until, reason) => wait(storage, id, until, reason));

/** [`waitTask`] for a caller that already holds the storage. */
export function wait(storage: Storage, id: number, until: number, reason: string | null): B.Task {
  const current = storedTask(storage, id);
  if (current.status === "done") {
    throw rejected(`task ${current.id} is done, so it cannot wait; reopen it first if more work on it has to wait`);
  }
  const now = storage.now();
  const valid = until >= EARLIEST_TIMESTAMP && until <= LATEST_TIMESTAMP;
  if (!valid || until <= now) {
    throw invalidInput(`the wait must end in the future, after ${rfc3339(now)}; choose a later time`);
  }
  return task(storage.waitTask(current.id, until, trimmedOrNull(reason)));
}

/** Ends the wait of a task now: it returns to the status it had when the wait began, as
 * when the time passes. */
export const endWait: Command<"endWait"> = command((storage, id) => endTaskWait(storage, id, null));

/** [`endWait`], recording `note`, why the wait ends early, with the progress note. */
export function endTaskWait(storage: Storage, id: number, note: string | null): B.Task {
  const current = storedTask(storage, id);
  if (current.wait === null) {
    throw rejected(`task ${current.id} does not wait; call wait_task to make it wait until a time`);
  }
  return task(storage.endTaskWait(current.id, trimmedOrNull(note)));
}

/** Reopens a `done` task that was completed or concluded by mistake: it becomes `planned`
 * again, paused if it was started. Its resolution, completion note, and `merged_with` are
 * cleared; `reason`, required, is kept as a progress note with the earlier outcome, and the
 * timeline records the reopening. Rejected while a task that depends on it has started: it
 * built on the outcome, which Set outcome corrects instead. */
export const reopenTask: Command<"reopenTask"> = command((storage, id, reason) => {
  const note = reopenNote(storage, id, reason);
  return task(storage.reopenTask(taskId(id), trim(reason), note));
});

/** Checks that task `id` can be reopened without changing anything, and returns the progress
 * note reopening it records. */
export function reopenNote(storage: Storage, id: number, rawReason: string): string {
  const reason = trim(rawReason);
  if (reason === "") throw invalidInput("say why the task is reopened; the reason is kept as a progress note");
  const current = storedTask(storage, id);
  if (current.status !== "done") {
    throw rejected(
      `task ${current.id} is ${current.status}; only a done task can be reopened, and this one is still open: continue it, or pause it to stop working on it`,
    );
  }
  const started = storage
    .listAllTasks()
    .filter((other) => other.dependsOn.has(current.id)
      && (other.status !== "planned" || milestones(other.timeline).startedAt !== null))
    .map((other) => `#${other.id} (${other.status})`);
  if (started.length > 0) {
    throw rejected(
      `task ${current.id} cannot be reopened: ${started.join(", ")} already started on its outcome; correct how it ended with Set outcome instead, or remove those dependencies first`,
    );
  }
  let note = `Reopened: ${reason}`;
  if (current.resolution !== null) {
    note += `\nIt was done as ${current.resolution}`;
    note += current.completionNote === null ? "." : `: ${current.completionNote}`;
  }
  return note;
}

/** Corrects how a `done` task ended without reopening it: `resolution` replaces its
 * resolution and `note`, required, its completion note; the earlier outcome is kept as a
 * progress note. Not adopted keeps its dependents waiting. */
export const setTaskOutcome: Command<"setTaskOutcome"> = command((storage, id, resolution, rawNote) => {
  const note = trim(rawNote);
  if (note === "") throw invalidInput("say why the outcome changes; the note becomes the task's completion note");
  const current = storedTask(storage, id);
  const outcome: TaskResolution | null = current.status === "done" ? current.resolution : null;
  if (outcome === null) {
    throw rejected(
      `task ${current.id} is ${current.status}; only a done task has an outcome to correct: complete or conclude it first`,
    );
  }
  if (outcome === resolution) {
    throw rejected(`task ${current.id} is already done as ${resolution}; edit its completion note to change what it says`);
  }
  if (resolution === "merged") {
    throw rejected("call set_task_outcome with resolution completed or not_adopted; new outcomes do not record merges");
  }
  let record = `Outcome changed from ${outcome} to ${resolution}: ${note}`;
  if (current.completionNote !== null) record += `\nEarlier completion note: ${current.completionNote}`;
  return task(storage.setTaskOutcome(current.id, resolution, note, record));
});

/** Stores what the user wrote about the outcome of a `done` task, for reviews. The note is
 * trimmed; an empty one clears it, except for a task that was not adopted, whose note is its
 * required conclusion. */
export const setCompletionNote: Command<"setCompletionNote"> = command((storage, id, rawNote) => {
  const current = storedTask(storage, id);
  if (current.status !== "done") {
    throw rejected(`task ${current.id} is ${current.status}; only a done task has a completion note`);
  }
  const note = trimmedOrNull(rawNote);
  if (note === null && current.resolution === "not_adopted") {
    throw invalidInput("the conclusion of work that was not adopted cannot be cleared");
  }
  return task(storage.setCompletionNote(current.id, note));
});

/** Archives the task while preserving its history. */
export const deleteTask: Command<"deleteTask"> = command((storage, id) => {
  storage.archiveTask(taskId(id));
  return null;
});

/** Moves a task, in any status, into another live workspace, keeping its ID, history,
 * notes, criteria, refs, and links. */
export const moveTask: Command<"moveTask"> = command((storage, id, workspace) =>
  task(storage.moveTask(taskId(id), workspaceId(workspace))));

/** Archives every `done` task of a live workspace in one go, as `deleteTask` does for one
 * task, keeping their history; returns how many were archived. */
export const deleteDoneTasks: Command<"deleteDoneTasks"> = command((storage, workspace) =>
  storage.archiveDoneTasks(workspaceId(workspace)).length);

/** Brings an archived task of a live workspace back with its dependencies. */
export const restoreTask: Command<"restoreTask"> = command((storage, id) =>
  task(storage.restoreTask(taskId(id))));

/** Deletes an archived task for good with its history, commit records, and links; a task
 * that is not archived is rejected. */
export const purgeTask: Command<"purgeTask"> = command((storage, id) => {
  storage.purgeTask(taskId(id));
  return null;
});

/** Adds a prerequisite, pausing a blocked active task when confirmed. */
export const addDependency: Command<"addDependency"> = command((storage, task_, dependsOn, confirmPause) => {
  const change = storage.addDependenciesWith(taskId(task_), [taskId(dependsOn)], confirmPause ? "pause" : "ask");
  return change.kind === "needs_pause" ? "confirm_pause" : "added";
});

export const removeDependency: Command<"removeDependency"> = command((storage, task_, dependsOn) => {
  storage.removeDependency(taskId(task_), taskId(dependsOn));
  return null;
});

/** Every related link between tasks, which neither block nor wait on each other. */
export const listTaskRelations: Command<"listTaskRelations"> = command((storage) =>
  storage.listRelations().map(([task_, related]) => ({ taskId: task_, relatedId: related })));

/** Links two tasks, from any workspaces, as related; linking twice keeps one link. */
export const addTaskRelation: Command<"addTaskRelation"> = command((storage, task_, related) => {
  storage.addRelated(taskId(task_), taskId(related));
  return null;
});

/** Removes the related link between two tasks, given in either order. */
export const removeTaskRelation: Command<"removeTaskRelation"> = command((storage, task_, related) => {
  storage.removeRelated(taskId(task_), taskId(related));
  return null;
});

/** Starts a ready task and records the supplied reason and references. */
export const startTask: Command<"startTask"> = command((storage, id, rawReason, refs) => {
  const reason = rawReason === null ? null : trim(rawReason);
  if (reason === "") {
    throw invalidInput("reason is blank; call start_task with a non-empty reason or omit reason");
  }
  const current = storedTask(storage, id);
  return task(storage.startTask(current.id, reason, mergeRefs(current.refs, refs ?? [], [])));
});
