import type { Task, TaskId, TaskNote, Timestamp } from "@/lib/bindings";
import { prerequisitesResolved } from "@/lib/task-graph";

/**
 * The blocker reported on `task` that still stands: its latest note, if that is a blocker. A
 * later progress note means the work got past it; finishing the task, or starting it again
 * after the blocker (resuming a paused task), ends it too. The blocker a pause by a new
 * prerequisite records ends once the prerequisites no longer block the task. `byId` holds the
 * tasks of every workspace, since a prerequisite may belong to another one.
 */
export function openBlocker(task: Task, byId: ReadonlyMap<TaskId, Task>): TaskNote | null {
  const latest = task.notes.at(-1);
  if (task.status === "done" || latest?.kind !== "blocker") {
    return null;
  }
  const resumed = task.timeline.some((event) => event.status === "in_progress" && event.at > latest.at);
  const unblocked = latest.at === task.milestones.pausedAt && prerequisitesResolved(task, byId);
  return resumed || unblocked ? null : latest;
}

/** Why a task waits on the user, most urgent first. */
export const attentionReasons = ["blocker_note", "stalled"] as const;

export type AttentionReason = (typeof attentionReasons)[number];

export type AttentionItem = {
  task: Task;
  reasons: AttentionReason[];
};

/** How long an `in_progress` task may go without a status change or note before it counts as stalled. */
export const stalledAfterSeconds = 7 * 24 * 60 * 60;

/** When `task` last started, changed status, or got a note; `null` when none was recorded. */
function lastActivity(task: Task): Timestamp | null {
  const times = [
    ...(task.milestones.startedAt === null ? [] : [task.milestones.startedAt]),
    ...task.timeline.map((event) => event.at),
    ...task.notes.map((note) => note.at),
  ];
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * Tasks that wait on the user: a blocker reported as the task's latest note, or an
 * `in_progress` task without a status change or note for `stalledAfterSeconds` before `now`.
 * The most urgent come first, then by task ID.
 */
export function needsAttention(
  tasks: Task[],
  now: Timestamp,
  byId: ReadonlyMap<TaskId, Task> = new Map(tasks.map((task) => [task.id, task])),
): AttentionItem[] {
  const rank = (item: AttentionItem) => attentionReasons.indexOf(item.reasons[0]);
  return tasks
    .flatMap((task) => {
      const reasons = attentionReasons.filter((reason) => {
        switch (reason) {
          case "blocker_note":
            return openBlocker(task, byId) !== null;
          case "stalled": {
            const last = lastActivity(task);
            return task.status === "in_progress" && last !== null && now - last > stalledAfterSeconds;
          }
        }
      });
      return reasons.length > 0 ? [{ task, reasons }] : [];
    })
    .sort((a, b) => rank(a) - rank(b) || a.task.id - b.task.id);
}
