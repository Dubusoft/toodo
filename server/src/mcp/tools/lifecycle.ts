// Moving tasks through their statuses, and deleting and reopening them.

import type * as B from "../../../../src/lib/api.ts";
import { complete, conclude } from "../../commands/completion.ts";
import { invalidInput, rejected } from "../../commands/errors.ts";
import * as tasks from "../../commands/tasks.ts";
import { task } from "../../commands/types.ts";
import { taskId } from "../../domain/model.ts";
import { debugString, trim } from "../../domain/rust.ts";
import type { Storage } from "../../storage/storage.ts";
import { describeLinks, Links, taskDetails, type TaskLink } from "./queries.ts";
import type * as R from "./requests.ts";
import { liveWorkspace, storedTask, taskGuidelines } from "./workspaces.ts";

/** Pauses an `in_progress` or `in_review` task as the app's Pause does and records the
 * reason in its status history and as a progress note. References and criteria stay. */
export function pauseTask(storage: Storage, request: ReturnType<typeof R.pauseTask>): B.Task {
  const reason = trim(request.reason);
  if (reason === "") {
    throw invalidInput('reason must say why the work stops, e.g. {"id": 5, "reason": "Waiting for the API design"}');
  }
  const current = storedTask(storage, request.id);
  if (current.status === "planned") {
    throw rejected(
      `task ${current.id} is planned, so nobody works on it; call resume_task for a paused task or start_task to start it`,
    );
  }
  if (current.status === "done") {
    throw rejected(`task ${current.id} is done; create a follow-up task with create_task for more work`);
  }
  tasks.pause(storage, request.id, reason);
  return task(storage.addTaskNote(current.id, "progress", `Paused: ${reason}`));
}

/** The seconds a `jiff::Timestamp` holds, `Timestamp::MIN` and `Timestamp::MAX`. */
const EARLIEST_TIMESTAMP = -377_705_023_201n;
const LATEST_TIMESTAMP = 253_402_207_200n;

/** `text` as an RFC 3339 time with an offset, in whole seconds since the Unix epoch, as
 * `jiff::Timestamp` reads it; `null` when it is not one. */
function timestamp(text: string): number | null {
  let instant: Temporal.Instant;
  try {
    instant = Temporal.Instant.from(text);
  } catch {
    return null;
  }
  const seconds = instant.epochNanoseconds / 1_000_000_000n;
  return seconds < EARLIEST_TIMESTAMP || seconds > LATEST_TIMESTAMP ? null : Number(seconds);
}

/** Makes a task wait until a time, or moves the time of a task that already waits. */
export function waitTask(storage: Storage, request: ReturnType<typeof R.waitTask>): B.Task {
  const until = timestamp(trim(request.until));
  if (until === null) {
    throw invalidInput(
      `until ${debugString(request.until)} is not an RFC 3339 time with an offset; pass e.g. {"id": ${request.id}, "until": "2026-11-10T09:00:00+09:00"}`,
    );
  }
  return tasks.wait(storage, request.id, until, request.reason);
}

/** Ends the wait of a task now. */
export function endWait(storage: Storage, request: ReturnType<typeof R.endWait>): B.Task {
  return tasks.endTaskWait(storage, request.id, request.note);
}

/** Resumes a previously started, paused task. */
export function resumeTask(storage: Storage, request: ReturnType<typeof R.resumeTask>): B.Task {
  const current = task(storedTask(storage, request.id));
  if (current.status !== "planned" || current.milestones.startedAt === null) {
    throw rejected(
      `task ${request.id} is not paused; call start_task to start a planned task, or pause_task before resuming active work`,
    );
  }
  const resumed = tasks.startTask(storage, request.id, request.note, null);
  const note = request.note === null ? "" : trim(request.note);
  if (note === "") return resumed;
  storage.addTaskNote(taskId(request.id), "progress", `Resumed: ${note}`);
  return task(storedTask(storage, request.id));
}

/** The reply of a tool that changes nothing until it is called again with `confirm: true`. */
export type Confirmation = {
  /** Whether the change was made; false for a call without `confirm: true`. */
  confirmed: boolean;
  /** The task as it is now, or as it was before it was deleted. */
  task: B.Task;
  /** What the change does, or did, and what to do next. */
  message: string;
};

const waitWord = (dependents: readonly TaskLink[]) => (dependents.length === 1 ? "waits" : "wait");

/**
 * Deletes (archives) a `planned` or `done` task as the app's Delete does, but only with
 * `confirm`; without it, nothing changes and the reply says what deleting would do. Tasks
 * being worked on (`in_progress` or `in_review`) are rejected.
 */
export function deleteTask(storage: Storage, request: ReturnType<typeof R.deleteTask>): Confirmation {
  const details = taskDetails(storage, request.id);
  const current = details.task;
  const id = current.id;
  if (current.status === "in_progress" || current.status === "in_review") {
    throw rejected(
      `task ${id} is ${current.status}, so it is being worked on; call pause_task {"id": ${id}, "reason": "..."} first if the work should stop, then delete_task`,
    );
  }
  const dependents = describeLinks(details.dependents);
  const wait = waitWord(details.dependents);
  if (!request.confirm) {
    let message = `Nothing changed yet. Deleting task ${id} "${current.title}" archives it: it leaves the task lists and no longer holds back its dependents, while its history, notes, criteria, ${details.commits.length} recorded commit(s), and ${details.dependsOn.length + details.dependents.length + details.related.length} dependency and related link(s) stay for the reports; the user can restore it, or delete it for good, under Settings > Trash in the Toodo app.`;
    if (dependents !== "") message += ` ${dependents} no longer ${wait} on it.`;
    message += ` To delete it, call delete_task {"id": ${id}, "confirm": true}.`;
    return { confirmed: false, task: current, message };
  }
  storage.archiveTask(taskId(request.id));
  let message = `task ${id} "${current.title}" is deleted and kept in the archive, where the user can restore it in the Toodo app.`;
  if (dependents !== "") message += ` ${dependents} no longer ${wait} on it.`;
  return { confirmed: true, task: current, message };
}

/** The reply of delete_done_tasks, which changes nothing until it is called again with
 * `confirm: true`. */
export type DoneTasksConfirmation = {
  /** Whether the tasks were archived; false for a call without `confirm: true`. */
  confirmed: boolean;
  workspaceId: number;
  /** The done tasks that were archived, or that confirming would archive. */
  taskIds: number[];
  /** What the change does, or did, and what to do next. */
  message: string;
};

/** Deletes (archives) every `done` task of a workspace as `deleteTask` does for one, but
 * only with `confirm`; without it, nothing changes and the reply lists the tasks deleting
 * would archive. */
export function deleteDoneTasks(storage: Storage, request: ReturnType<typeof R.deleteDoneTasks>): DoneTasksConfirmation {
  const stored = liveWorkspace(storage, request.workspace_id);
  const id = request.workspace_id;
  const done = storage.listTasks(stored.id).filter((item) => item.status === "done");
  if (done.length === 0) {
    return {
      confirmed: false,
      workspaceId: id,
      taskIds: [],
      message: `Nothing changed: workspace ${id} "${stored.name}" has no done task to delete; call list_tasks {"workspace_id": ${id}, "status": ["done"]} to check.`,
    };
  }
  if (!request.confirm) {
    return {
      confirmed: false,
      workspaceId: id,
      taskIds: done.map((item) => item.id),
      message: `Nothing changed yet. Deleting the done tasks of workspace ${id} "${stored.name}" archives ${done.length} task(s): ${done.map((item) => `#${item.id} ${item.title}`).join(", ")}. They leave the task lists, while their history, notes, criteria, and commit records stay in review_report; the user can restore them, or delete them for good, under Settings > Trash in the Toodo app. To delete them, call delete_done_tasks {"workspace_id": ${id}, "confirm": true}.`,
    };
  }
  const archived = storage.archiveDoneTasks(stored.id);
  return {
    confirmed: true,
    workspaceId: id,
    taskIds: [...archived],
    message: `${archived.length} done task(s) of workspace ${id} "${stored.name}" are deleted and kept in the archive, where the user can restore them in the Toodo app: ${archived.map((task_) => `#${task_}`).join(", ")}.`,
  };
}

/** Reopens a `done` task as the app's Reopen does, but only with `confirm`; without it, the
 * reopening is checked and the reply says what it would do, and nothing changes. */
export function reopenTask(storage: Storage, request: ReturnType<typeof R.reopenTask>): Confirmation {
  const note = tasks.reopenNote(storage, request.id, request.reason);
  const id = request.id;
  if (!request.confirm) {
    const details = taskDetails(storage, request.id);
    const current = details.task;
    const paused = current.milestones.startedAt !== null ? " (paused on its branch, since it was started)" : "";
    let message = `Nothing changed yet. Reopening task ${id} "${current.title}" makes it planned again${paused}, clears its resolution and completion note, and records this progress note: ${note}`;
    const dependents = describeLinks(details.dependents);
    if (dependents !== "") message += `\n${dependents} ${waitWord(details.dependents)} on it again until it is done.`;
    // `serde_json::json!` keeps the keys of an object sorted.
    const call = JSON.stringify({ confirm: true, id, reason: trim(request.reason) });
    message += `\nTo reopen it, call reopen_task again with the same reason and "confirm": true, e.g. ${call}.`;
    return { confirmed: false, task: current, message };
  }
  const reopened = tasks.reopenTask(storage, request.id, request.reason);
  const next = reopened.milestones.startedAt !== null
    ? "call resume_task to continue it on its branch"
    : "call start_task to start it";
  return { confirmed: true, task: reopened, message: `task ${id} is reopened and planned; ${next} once it is ready.` };
}

/** A started task with the guidelines of its workspace, as start_task returns it. */
export type StartedTask = B.Task & {
  /** The guidelines of the task's workspace, to read before working on it. */
  guidelines: B.Guideline[];
};

/** Records the start of a ready task. */
export function startTask(storage: Storage, request: ReturnType<typeof R.startTask>): StartedTask {
  const started = tasks.startTask(storage, request.id, request.reason, request.refs);
  return { ...started, guidelines: taskGuidelines(storage, started.workspaceId) };
}

/** Completes a task after checking its completion criteria. */
export async function completeTask(storage: Storage, request: ReturnType<typeof R.completeTask>): Promise<B.Task> {
  return task(await complete(storage, taskId(request.id), request.note, request.refs));
}

/** A task concluded without merging, with the tasks that its conclusion leaves blocked. */
export type ConcludedTask = B.Task & {
  /** Tasks that depend on the concluded task and stay blocked by it, since work that was not
   * adopted is not there to build on. */
  blockedDependents: TaskLink[];
  /** What the conclusion means for those tasks and what to do next. */
  message: string;
};

/** Records the outcome and completion note of a task. */
export function concludeTask(storage: Storage, request: ReturnType<typeof R.concludeTask>): ConcludedTask {
  const concluded = conclude(
    storage,
    taskId(request.id),
    request.note,
    request.outcome ?? "not_adopted",
    request.shipped_with === null ? null : taskId(request.shipped_with),
  );
  const links = new Links(storage);
  const notAdopted = concluded.resolution === "not_adopted";
  const blockedDependents = notAdopted
    ? links.links(links.dependents(concluded.id).filter((id) => {
      const dependent = links.tasks.get(id);
      return dependent !== undefined && dependent.status !== "done";
    }))
    : [];
  const message = notAdopted
    ? conclusionMessage(concluded.id, blockedDependents)
    : `task ${concluded.id} is done; call get_task to read its outcome and references`;
  return { ...task(concluded), blockedDependents, message };
}

/** What concluding task `id` means for `dependents`, the tasks that depend on it. */
function conclusionMessage(id: number, dependents: readonly TaskLink[]): string {
  const [first] = dependents;
  if (first === undefined) return `task ${id} is done as not_adopted; no task depends on it.`;
  return `task ${id} is done as not_adopted, which blocks every task that depends on it: ${describeLinks(dependents)}. For each, call remove_dependency (e.g. {"task_id": ${first.id}, "depends_on": ${id}}) if it can go ahead without this work, or conclude_task ${id} with outcome shipped_with and shipped_with set to the completed task id if another merged pull request shipped it.`;
}
