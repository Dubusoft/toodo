// Reading tasks: lists, search, details with their links, and the review report
// (`src-tauri/src/mcp/tools/queries.rs`).

import type * as B from "../../../../src/lib/api.ts";
import { invalidInput, rejected } from "../../commands/errors.ts";
import { commitRecord, reviewReport as renderReport } from "../../commands/review.ts";
import { task as taskShape, taskPageLimit } from "../../commands/types.ts";
import type { Task, TaskId } from "../../domain/model.ts";
import type { TaskStatus } from "../../domain/status.ts";
import { taskId, workspaceId } from "../../domain/model.ts";
import { debugString, trim } from "../../domain/rust.ts";
import { StorageError } from "../../storage/errors.ts";
import type { Storage } from "../../storage/storage.ts";
import type * as R from "./requests.ts";
import { taskGuidelines } from "./workspaces.ts";

export function reviewReport(storage: Storage, request: ReturnType<typeof R.reviewReport>): B.ReviewReport {
  return renderReport(storage, {
    period: request.period,
    date: request.date,
    from: request.from,
    to: request.to,
    format: request.format ?? "markdown",
    timeZone: request.time_zone,
    workspaceId: request.workspace_id,
    label: request.label,
  });
}

/** Another task linked to a task. */
export type TaskLink = {
  id: number;
  workspaceId: number;
  title: string;
  status: TaskStatus;
  resolution: B.TaskResolution | null;
};

/** A task as list_tasks returns it, with whether it can start now. */
export type ListedTask = B.Task & {
  /** Whether the task is planned, does not wait until a time, and every task it depends on
   * is done and adopted, so start_task (or resume_task for a paused task) can begin it now. */
  ready: boolean;
  /** The tasks it depends on that keep it from starting: not done yet, or done as
   * not_adopted, which never unblocks it. */
  blockedBy: TaskLink[];
};

export function listTasks(storage: Storage, request: ReturnType<typeof R.listTasks>): ListedTask[] {
  if (request.workspace_id !== null && storage.getWorkspace(workspaceId(request.workspace_id)) === null) {
    throw new StorageError({ kind: "workspace_not_found", workspace: request.workspace_id });
  }
  if (request.limit !== null) taskPageLimit(request.limit);
  let statuses: TaskStatus[] = request.status ?? [];
  if (request.ready === true) {
    // Only a planned task can be ready.
    if (statuses.length > 0 && !statuses.includes("planned")) return [];
    statuses = ["planned"];
  }
  const tasks = storage.queryTasks({
    workspace: request.workspace_id === null ? null : workspaceId(request.workspace_id),
    statuses,
    ids: null,
    before: request.before_id === null ? null : taskId(request.before_id),
    // Readiness is known only once the prerequisites are loaded, so the limit then applies
    // after filtering by it.
    limit: request.ready === null ? request.limit : null,
    autopilot: request.autopilot,
  });
  const known = prerequisites(storage, tasks);
  const listed = tasks
    .map((task) => {
      const blockedBy = blockedByOf(known, task);
      return { ...taskShape(task), ready: isReady(task, blockedBy), blockedBy };
    })
    .filter((item) => request.ready === null || item.ready === request.ready);
  return request.limit === null ? listed : listed.slice(Math.max(0, listed.length - request.limit));
}

/** `tasks` and the tasks they depend on, by ID. */
function prerequisites(storage: Storage, tasks: readonly Task[]): Map<TaskId, Task> {
  const known = new Map(tasks.map((task) => [task.id, task]));
  const missing = [...new Set(tasks.flatMap((task) => [...task.dependsOn]).filter((id) => !known.has(id)))].sort(
    (a, b) => a - b,
  );
  if (missing.length > 0) {
    for (const task of storage.queryTasks({ ids: missing })) known.set(task.id, task);
  }
  return known;
}

/** The tasks `task` depends on that keep it from starting: not done, or done as not
 * adopted. `tasks` holds them by ID. */
function blockedByOf(tasks: ReadonlyMap<TaskId, Task>, task: Task): TaskLink[] {
  return taskLinks(
    tasks,
    [...task.dependsOn].filter((id) => {
      const prerequisite = tasks.get(id);
      return prerequisite !== undefined && (prerequisite.status !== "done" || prerequisite.resolution === "not_adopted");
    }),
  );
}

/** Links to the tasks `ids` of `tasks`. */
function taskLinks(tasks: ReadonlyMap<TaskId, Task>, ids: Iterable<TaskId>): TaskLink[] {
  const links: TaskLink[] = [];
  for (const id of ids) {
    const task = tasks.get(id);
    if (task === undefined) continue;
    links.push({ id: task.id, workspaceId: task.workspaceId, title: task.title, status: task.status, resolution: task.resolution });
  }
  return links;
}

/** Whether `task` can start (or resume) now: it is planned, does not wait until a time, and
 * nothing blocks it. A wait that ends makes it ready again. */
function isReady(task: Task, blockedBy: readonly TaskLink[]): boolean {
  return task.status === "planned" && task.wait === null && blockedBy.length === 0;
}

/** `links` as a list such as "#3 (planned), #4 (done as not_adopted)". */
export function describeLinks(links: readonly TaskLink[]): string {
  return links
    .map((link) => `#${link.id} (${link.resolution === "not_adopted" ? "done as not_adopted" : link.status})`)
    .join(", ");
}

/** What a dependency change means for `details`' task and what to do next. */
export function dependencyMessage(details: TaskDetails, paused: boolean): string {
  const { task } = details;
  const id = task.id;
  const blockers = details.blockedBy;
  const waiting = describeLinks(blockers);
  let message: string;
  if (paused) {
    message = `task ${id} is paused until ${waiting} ${blockers.length === 1 ? "is" : "are"} done; call resume_task once its prerequisites are complete.`;
  } else if (task.status === "in_progress") {
    message = `task ${id} stays in_progress: every task it depends on is done and adopted.`;
  } else if (task.status === "in_review") {
    message = blockers.length === 0
      ? `task ${id} stays in_review: every task it depends on is done and adopted.`
      : `task ${id} is in_review, so it was not paused and can still complete before ${waiting}; call pause_task if it must wait for them.`;
  } else if (task.status === "done") {
    message = `task ${id} is done.`;
  } else if (blockers.length > 0) {
    message = `task ${id} waits for ${waiting} before it can start.`;
  } else if (task.wait !== null) {
    message = `task ${id} no longer waits on any task, but waits until a time: it is ready once that wait ends.`;
  } else if (task.milestones.startedAt !== null) {
    message = `task ${id} is paused and no longer waits on any task: resume_task resumes it.`;
  } else {
    message = `task ${id} is ready: nothing it depends on blocks start_task.`;
  }
  for (const blocker of blockers) {
    if (blocker.resolution === "not_adopted") {
      const prerequisite = blocker.id;
      message += ` #${prerequisite} was not adopted, so it never unblocks task ${id}: call remove_dependency {"task_id": ${id}, "depends_on": ${prerequisite}} if the work can go ahead without it, or conclude_task ${prerequisite} with outcome shipped_with and shipped_with set to the completed task id if another merged pull request shipped it.`;
    }
  }
  return message;
}

export function currentTask(storage: Storage, request: ReturnType<typeof R.currentTask>): B.Task {
  const reference = request.ref === null ? "" : trim(request.ref);
  if (reference === "") {
    throw invalidInput("call current_task with ref set to a task reference, or call get_task with id");
  }
  const matches = storage.listAllTasks().filter((task) => task.refs.includes(reference));
  if (matches.length !== 1) {
    throw rejected(
      `ref ${debugString(reference)} matches ${matches.length} tasks (${matches.map((task) => task.id).join(", ")}); call get_task with the intended id, or current_task with a unique ref`,
    );
  }
  return taskShape(matches[0]);
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

/** A task that search_tasks found, with its links to other tasks. */
export type SearchHit = {
  id: number;
  workspaceId: number;
  /** The name of the task's workspace. */
  workspace: string;
  taskType: B.TaskType;
  title: string;
  status: TaskStatus;
  resolution: B.TaskResolution | null;
  refs: string[];
  /** Tasks this task waits on. */
  dependsOn: number[];
  /** Tasks that wait on this task. */
  dependents: number[];
  /** Related tasks, which neither wait on this task nor block it. */
  related: number[];
};

/** A task with its whole history and its links, as get_task returns it. */
export type TaskDetails = {
  /** The task: description, status timeline, notes, completion note (the conclusion of a
   * task done as not_adopted), and pull request. */
  task: B.Task;
  /** The name of the task's workspace. */
  workspace: string;
  /** The commits recorded for the task, from its branch or its merged pull request. */
  commits: B.CommitRecord[];
  /** Tasks this task waits on. */
  dependsOn: TaskLink[];
  /** Whether the task is planned, does not wait until a time, and every task it depends on
   * is done and adopted, so start_task (or resume_task for a paused task) can begin it now. */
  ready: boolean;
  /** The tasks of `dependsOn` that keep it from starting: not done yet, or done as
   * not_adopted, which never unblocks it. */
  blockedBy: TaskLink[];
  /** Tasks that wait on this task. */
  dependents: TaskLink[];
  /** Related tasks, which neither wait on this task nor block it. */
  related: TaskLink[];
  /** The guidelines of the task's workspace, to read before working on it: rules first, then
   * memories. */
  guidelines: B.Guideline[];
};

const ascending = (ids: Iterable<TaskId>) => [...ids].sort((a, b) => a - b);

/** The links between all tasks: what each task waits on, what waits on it, and what is
 * related to it. */
export class Links {
  readonly tasks: Map<TaskId, Task>;
  readonly #workspaces: Map<number, string>;
  readonly #dependents = new Map<TaskId, Set<TaskId>>();
  readonly #related = new Map<TaskId, Set<TaskId>>();

  constructor(storage: Storage) {
    this.tasks = new Map(storage.listAllTasks().map((task) => [task.id, task]));
    const add = (map: Map<TaskId, Set<TaskId>>, key: TaskId, value: TaskId) => {
      const set = map.get(key) ?? new Set<TaskId>();
      set.add(value);
      map.set(key, set);
    };
    for (const task of this.tasks.values()) {
      for (const prerequisite of task.dependsOn) add(this.#dependents, prerequisite, task.id);
    }
    for (const [a, b] of storage.listRelations()) {
      add(this.#related, a, b);
      add(this.#related, b, a);
    }
    this.#workspaces = new Map(storage.listWorkspaces().map((workspace) => [workspace.id, workspace.name]));
  }

  task(id: TaskId): Task {
    const found = this.tasks.get(id);
    if (found === undefined) throw new StorageError({ kind: "task_not_found", task: id });
    return found;
  }

  workspace(task: Task): string {
    return this.#workspaces.get(task.workspaceId) ?? "";
  }

  dependents(id: TaskId): TaskId[] {
    return ascending(this.#dependents.get(id) ?? []);
  }

  related(id: TaskId): TaskId[] {
    return ascending(this.#related.get(id) ?? []);
  }

  hit(id: TaskId): SearchHit {
    const task = this.task(id);
    return {
      id,
      workspaceId: task.workspaceId,
      workspace: this.workspace(task),
      taskType: task.taskType,
      title: task.title,
      status: task.status,
      resolution: task.resolution,
      refs: [...task.refs],
      dependsOn: [...task.dependsOn],
      dependents: this.dependents(id),
      related: this.related(id),
    };
  }

  /** The tasks `task` depends on that keep it from starting: not done, or done as not
   * adopted. */
  blockedBy(task: Task): TaskLink[] {
    return blockedByOf(this.tasks, task);
  }

  links(ids: Iterable<TaskId>): TaskLink[] {
    return taskLinks(this.tasks, ids);
  }
}

/** The task number a query consists of, e.g. `431` or `#431`. */
function taskNumber(query: string): TaskId | null {
  const trimmed = trim(query);
  const digits = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9]+$/.test(digits)) return null;
  const parsed = BigInt(digits);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? taskId(Number(parsed)) : null;
}

/** Tasks matching the query, best match first, each with its links. A query that is a task
 * number puts that task first, in any workspace, ahead of the text matches. */
export function searchTasks(storage: Storage, request: ReturnType<typeof R.searchTasks>): SearchHit[] {
  if (trim(request.query) === "") throw invalidInput("query must contain a word");
  if (request.workspace_id !== null && storage.getWorkspace(workspaceId(request.workspace_id)) === null) {
    throw new StorageError({ kind: "workspace_not_found", workspace: request.workspace_id });
  }
  const status = request.status;
  const limit = Math.min(request.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  let ids = storage.searchTasks({
    query: request.query,
    workspace: request.workspace_id === null ? null : workspaceId(request.workspace_id),
    status,
    limit,
  });
  const links = new Links(storage);
  const numbered = taskNumber(request.query);
  const found = numbered === null ? undefined : links.tasks.get(numbered);
  if (numbered !== null && found !== undefined && (status === null || found.status === status)) {
    ids = [numbered, ...ids.filter((other) => other !== numbered)].slice(0, limit);
  }
  return ids.map((id) => links.hit(id));
}

/** A task with its history, commits, and the tasks it is linked to. */
export function taskDetails(storage: Storage, id: number): TaskDetails {
  const links = new Links(storage);
  const task = links.task(taskId(id));
  const blockedBy = links.blockedBy(task);
  return {
    task: taskShape(task),
    workspace: links.workspace(task),
    commits: storage.listCommitRecords(task.id).map(commitRecord),
    dependsOn: links.links(task.dependsOn),
    ready: isReady(task, blockedBy),
    blockedBy,
    dependents: links.links(links.dependents(task.id)),
    related: links.links(links.related(task.id)),
    guidelines: taskGuidelines(storage, task.workspaceId),
  };
}

/** Links two tasks as related and returns the first with its links. */
export function addRelated(storage: Storage, request: ReturnType<typeof R.related>): TaskDetails {
  storage.addRelated(taskId(request.task_id), taskId(request.related_id));
  return taskDetails(storage, request.task_id);
}

/** Removes the related link between two tasks and returns the first with its links. */
export function removeRelated(storage: Storage, request: ReturnType<typeof R.related>): TaskDetails {
  storage.removeRelated(taskId(request.task_id), taskId(request.related_id));
  return taskDetails(storage, request.task_id);
}
