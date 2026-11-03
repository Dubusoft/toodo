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

/** The sections of the task list, in the order they are shown. */
export const taskGroups = ["attention", "in_progress", "in_review", "ready", "planned", "done"] as const;

export type TaskGroup = (typeof taskGroups)[number];

export const taskGroupNames: Record<TaskGroup, string> = {
  attention: "Needs attention",
  in_progress: "In progress",
  in_review: "Awaiting completion",
  ready: "Ready",
  planned: "Planned",
  done: "Done",
};

function groupOf(task: Task, byId: ReadonlyMap<TaskId, Task>): Exclude<TaskGroup, "attention"> {
  switch (shownStatus(task, byId)) {
    case "in_progress":
      return "in_progress";
    case "in_review":
      return "in_review";
    case "ready":
      return "ready";
    case "planned":
    case "paused":
      return "planned";
    case "done":
    case "not_adopted":
      return "done";
  }
}

/**
 * `tasks` split into the non-empty sections of the task list, active work first. Tasks in
 * `attention` (most urgent first) form the first section whatever their status; the other
 * sections keep the order of `tasks`.
 */
export function groupTasks(
  tasks: Task[],
  byId: ReadonlyMap<TaskId, Task>,
  attention: TaskId[],
): { group: TaskGroup; tasks: Task[] }[] {
  const urgent = tasks
    .filter((task) => attention.includes(task.id))
    .sort((a, b) => attention.indexOf(a.id) - attention.indexOf(b.id));
  return taskGroups
    .map((group) => ({
      group,
      tasks:
        group === "attention"
          ? urgent
          : tasks.filter((task) => !attention.includes(task.id) && groupOf(task, byId) === group),
    }))
    .filter((section) => section.tasks.length > 0);
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
};

export const emptyTaskFilter: TaskFilter = { query: "", statuses: [], type: null };

/** What the timeline opens with: every status but the finished ones, done and not adopted. */
export const defaultTaskFilter: TaskFilter = {
  ...emptyTaskFilter,
  statuses: shownStatuses.filter((status) => status !== "done" && status !== "not_adopted"),
};

export function isFilterActive(filter: TaskFilter): boolean {
  return filter.query.trim() !== "" || filter.statuses.length > 0 || filter.type !== null;
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
  const text = `${task.title}\n${task.description}`.toLocaleLowerCase();
  return filter.query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => text.includes(word));
}
