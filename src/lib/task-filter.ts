import type { Task, TaskId, TaskType } from "@/lib/bindings";
import { dependenciesDone, isNotAdopted, isPaused, prerequisitesResolved } from "@/lib/task-graph";

/**
 * The status a task is shown with: its stored status, with paused and not adopted tasks told
 * apart, and a planned task that can be started now (every prerequisite done and adopted, or
 * none) shown as ready. A planned task still waiting on a prerequisite stays planned. A task
 * paused by a new prerequisite is shown as ready again once that prerequisite is done.
 */
export type ShownStatus = "planned" | "ready" | "paused" | "in_progress" | "in_review" | "done" | "not_adopted";

export const shownStatuses: ShownStatus[] = [
  "planned",
  "ready",
  "paused",
  "in_progress",
  "in_review",
  "done",
  "not_adopted",
];

/** `byId` holds the tasks of every workspace, since a prerequisite may belong to another one. */
export function shownStatus(task: Task, byId: ReadonlyMap<TaskId, Task>): ShownStatus {
  if (isNotAdopted(task)) {
    return "not_adopted";
  }
  if (isPaused(task)) {
    return prerequisitesResolved(task, byId) ? "ready" : "paused";
  }
  return task.status === "planned" && dependenciesDone(task, byId) ? "ready" : task.status;
}

/** What the task views are narrowed to; `null` lets every type through. */
export type TaskFilter = {
  /**
   * Text searched for in the title and description, ignoring case. A task number alone, e.g.
   * `431` or `#431`, also finds that task in any workspace (see {@link taskNumber}).
   */
  query: string;
  /** Tasks with any of these statuses pass; an empty list lets every status through. */
  statuses: ShownStatus[];
  type: TaskType | null;
  /** Only tasks marked for autopilot pass when set. */
  autopilot: boolean;
};

export const emptyTaskFilter: TaskFilter = { query: "", statuses: [], type: null, autopilot: false };

/** What the timeline opens with: every status but the finished ones, done and not adopted. */
export const defaultTaskFilter: TaskFilter = {
  ...emptyTaskFilter,
  statuses: shownStatuses.filter((status) => status !== "done" && status !== "not_adopted"),
};

export function isFilterActive(filter: TaskFilter): boolean {
  return filter.query.trim() !== "" || filter.statuses.length > 0 || filter.type !== null || filter.autopilot;
}

/** `statuses` with `status` added, or removed when it is already there, in the order of `shownStatuses`. */
export function toggleStatus(statuses: ShownStatus[], status: ShownStatus): ShownStatus[] {
  return shownStatuses.filter((each) => (each === status) !== statuses.includes(each));
}

/** The task number `query` consists of, e.g. `431` or `#431`; null for any other query. */
export function taskNumber(query: string): TaskId | null {
  const match = /^#?(\d+)$/.exec(query.trim());
  return match === null ? null : Number(match[1]);
}

/** Whether `task` passes `filter`: every word of the query appears in its title or description. */
export function matchesFilter(task: Task, filter: TaskFilter, byId: ReadonlyMap<TaskId, Task>): boolean {
  if (filter.statuses.length > 0 && !filter.statuses.includes(shownStatus(task, byId))) {
    return false;
  }
  if (filter.type !== null && task.taskType !== filter.type) {
    return false;
  }
  if (filter.autopilot && !task.autopilot) {
    return false;
  }
  const text = `${task.title}\n${task.description}`.toLocaleLowerCase();
  return filter.query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => text.includes(word));
}
