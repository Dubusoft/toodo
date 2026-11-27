// Editing tasks: fields, criteria, workspace, dependencies, and notes
// (`src-tauri/src/mcp/tools/edits.rs`).

import type * as B from "../../../../src/lib/api.ts";
import { invalidInput, rejected } from "../../commands/errors.ts";
import * as tasks from "../../commands/tasks.ts";
import { mergeRefs, task } from "../../commands/types.ts";
import { taskId, workspaceId, type NoteKind } from "../../domain/model.ts";
import { trim } from "../../domain/rust.ts";
import { StorageError } from "../../storage/errors.ts";
import type { Storage } from "../../storage/storage.ts";
import { dependencyMessage, taskDetails, type TaskDetails } from "./queries.ts";
import type * as R from "./requests.ts";
import { liveWorkspace, storedTask } from "./workspaces.ts";

/** Edits a task as `update_task` does. A done task is part of the record reviews are built
 * on, so agents add to it instead. */
export function updateTask(storage: Storage, request: R.UpdateTask): B.Task {
  const current = task(storedTask(storage, request.id));
  if (current.status === "done") {
    throw rejected(
      `task ${request.id} is done, so update_task leaves its record as it was finished; record a correction with add_progress_note task_id ${request.id}, or call reopen_task to work on it again`,
    );
  }
  const refs = request.refs === null && request.remove_refs === null
    ? null
    : mergeRefs(current.refs, request.refs ?? [], request.remove_refs ?? []);
  const edited = tasks.updateTask(storage, {
    status: request.status,
    id: request.id,
    taskType: request.task_type ?? current.taskType,
    title: request.title ?? current.title,
    description: request.description ?? current.description,
    estimate: request.estimate === undefined ? current.estimate : request.estimate,
    dueDate: request.due_date === undefined ? current.dueDate : request.due_date,
    labels: request.labels,
    autopilot: request.autopilot,
    criteria: request.criteria,
  });
  if (refs === null) return edited;
  storage.setTaskRefs(taskId(request.id), refs);
  return task(storedTask(storage, request.id));
}

/** An edit of task `id` that replaces its criteria with `criteria` and keeps the rest. */
function criteriaEdit(id: number, criteria: B.CriterionInput[]): R.UpdateTask {
  return {
    id,
    task_type: null,
    status: null,
    title: null,
    description: null,
    estimate: undefined,
    due_date: undefined,
    labels: null,
    refs: null,
    remove_refs: null,
    autopilot: null,
    criteria,
  };
}

/** The input that keeps criterion `id` as it is. */
const keep = (id: number): B.CriterionInput => ({ id, text: null, kind: null, target: null });

/** The reply of move_task. */
export type MovedTask = {
  /** The task in its new workspace. */
  task: B.Task;
  /** The workspace the task was in before the move. */
  fromWorkspaceId: number;
  /** What the move kept and what to do next. */
  message: string;
};

/** Moves a task, in any status, into another live workspace. Only its workspace changes:
 * refs (branches, lanes, pull requests) stay as recorded, since Toodo does not interpret
 * them, and the task follows the guidelines of its new workspace from then on. */
export function moveTask(storage: Storage, request: ReturnType<typeof R.moveTask>): MovedTask {
  const current = task(storedTask(storage, request.id));
  const from = liveWorkspace(storage, current.workspaceId);
  const to = liveWorkspace(storage, request.workspace_id);
  const id = request.id;
  if (from.id === to.id) {
    return {
      task: current,
      fromWorkspaceId: request.workspace_id,
      message: `Nothing changed: task ${id} is already in workspace ${to.id} "${to.name}".`,
    };
  }
  const moved = storage.moveTask(taskId(request.id), workspaceId(request.workspace_id));
  return {
    task: task(moved),
    fromWorkspaceId: from.id,
    message: `Moved task ${id} from workspace ${from.id} "${from.name}" to workspace ${to.id} "${to.name}". Its id, status and history, notes, criteria, refs, and dependency and related links are unchanged; refs such as branch: or lane: still name what they named before, so update them with update_task refs and remove_refs if the executor moves that work. Read get_guidelines {"workspace_id": ${to.id}} before working on it again.`,
  };
}

/** Adds one criterion, pending, after the task's criteria, which stay as they are. */
export function addCriterion(storage: Storage, request: ReturnType<typeof R.addCriterion>): B.Task {
  const current = task(storedTask(storage, request.task_id));
  const criteria = current.criteria.map((criterion) => keep(criterion.id));
  criteria.push({ id: null, text: request.text, kind: request.kind, target: request.target });
  return updateTask(storage, criteriaEdit(request.task_id, criteria));
}

/** Deletes one criterion of a task that is not done with its evidence; the others stay as
 * they are. */
export function removeCriterion(storage: Storage, request: ReturnType<typeof R.removeCriterion>): B.Task {
  const owner = tasks.criterionOwner(storage, request.task_id, request.criterion_id, "remove_criterion");
  const current = task(storedTask(storage, owner));
  const criteria = current.criteria
    .filter((criterion) => criterion.id !== request.criterion_id)
    .map((criterion) => keep(criterion.id));
  return updateTask(storage, criteriaEdit(owner, criteria));
}

/** Checks or unchecks a manual criterion as the agent; checking needs evidence. */
export function checkCriterion(storage: Storage, request: ReturnType<typeof R.checkCriterion>): B.Task {
  const met = request.met ?? true;
  const evidence = request.evidence === null ? "" : trim(request.evidence);
  if (met && evidence === "") throw invalidInput("evidence must say what shows the criterion holds");
  return tasks.check(storage, request.task_id, request.criterion_id, met, evidence, "agent");
}

/** The dependent task after add_dependency or remove_dependency, with what the change means
 * for it. */
export type DependencyReply = {
  /** The dependent task with its links; `dependsOn` names each prerequisite's workspace,
   * title, and status. */
  task: TaskDetails;
  /** Whether this change paused the task. */
  paused: boolean;
  /** What the change means for the task and what to do next. */
  message: string;
};

/** Adds the edges in one step and returns the dependent task. Self and cyclic edges and
 * `done` dependent tasks are rejected, and one rejected edge adds none. An `in_progress`
 * task that a prerequisite blocks is paused until the prerequisites are complete. */
export function addDependencies(storage: Storage, request: ReturnType<typeof R.addDependencies>): DependencyReply {
  if (request.depends_on.length === 0) throw invalidInput("depends_on must name at least one task");
  const added = storage.addDependencies(taskId(request.task_id), request.depends_on.map(taskId));
  const details = taskDetails(storage, request.task_id);
  return { task: details, paused: added.paused, message: dependencyMessage(details, added.paused) };
}

/** Removes the edges to every task of `depends_on` and returns the dependent task. An edge
 * that does not exist is rejected, and then none is removed. */
export function removeDependency(storage: Storage, request: ReturnType<typeof R.dependency>): DependencyReply {
  if (request.depends_on.length === 0) {
    throw invalidInput('depends_on must name at least one task, e.g. {"task_id": 5, "depends_on": 3}');
  }
  const current = task(storedTask(storage, request.task_id));
  const missing = request.depends_on.find((id) => !current.dependsOn.includes(id));
  if (missing !== undefined) {
    throw new StorageError({ kind: "dependency_not_found", task: request.task_id, dependsOn: missing });
  }
  for (const prerequisite of request.depends_on) {
    storage.removeDependency(taskId(request.task_id), taskId(prerequisite));
  }
  const details = taskDetails(storage, request.task_id);
  return { task: details, paused: false, message: dependencyMessage(details, false) };
}

/** Appends a note of `kind` to the task's history and returns the task with its notes. */
export function addNote(storage: Storage, kind: NoteKind, request: R.AddNote): B.Task {
  const note = trim(request.note);
  if (note === "") throw invalidInput("note must not be empty");
  return task(storage.addTaskNote(taskId(request.task_id), kind, note));
}
