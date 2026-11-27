// Status history of a task and the milestones derived from it (see
// `docs/architecture.md`, Task Timeline).

import type { TaskStatus } from "./status.ts";

/** One status change of a task. */
export type TaskEvent = {
  readonly status: TaskStatus;
  /** Time of the change in seconds since the Unix epoch (UTC). */
  readonly at: number;
  /** Why the change happened: on a move back to `planned`, the reason of a pause, the
   * prerequisites the task waits on, or why it was reopened; on a start or completion, the
   * reason or note given with it. `null` when none was recorded. */
  readonly reason: string | null;
};

/** Milestones of a task, in seconds since the Unix epoch. `null` when the task has not
 * reached the milestone or its history does not record it. */
export type Milestones = {
  /** Task creation: the first event. */
  readonly plannedAt: number | null;
  /** The first move to `in_progress`; restarting a paused task keeps it. */
  readonly startedAt: number | null;
  /** The first move to `in_review`, when the pull request was opened. */
  readonly reviewAt: number | null;
  /** The latest move to `done`, unless the task was reopened after it. */
  readonly completedAt: number | null;
  /** The latest reopening: a move out of `done`, which only reopening makes. */
  readonly reopenedAt: number | null;
  /** The latest pause, a move back to `planned` after work started, unless the task was
   * started again after it. */
  readonly pausedAt: number | null;
  /** The latest move to `in_review`; later than `reviewAt` when the task went back to
   * review, e.g. after a pause. */
  readonly lastReviewAt: number | null;
  /** Seconds spent `in_progress` or `in_review` up to the latest status change; the
   * current period of an active task is not counted yet. */
  readonly activeSeconds: number;
  /** How often the task was paused: moves back to `planned` after work started. */
  readonly pauseCount: number;
};

/** Derives the milestones of a task from its status history, oldest event first. */
export function milestones(timeline: readonly TaskEvent[]): Milestones {
  let startedAt: number | null = null;
  let reviewAt: number | null = null;
  let completedAt: number | null = null;
  let reopenedAt: number | null = null;
  let pausedAt: number | null = null;
  let lastReviewAt: number | null = null;
  let activeSeconds = 0;
  let pauseCount = 0;
  // When the current period of work began, while the task is in progress or in review.
  let activeSince: number | null = null;
  for (const event of timeline) {
    if (event.status !== "done" && completedAt !== null) {
      completedAt = null;
      reopenedAt = event.at;
    }
    const active = event.status === "in_progress" || event.status === "in_review";
    if (activeSince === null && active) {
      activeSince = event.at;
    } else if (activeSince !== null && !active) {
      activeSeconds += Math.max(event.at - activeSince, 0);
      activeSince = null;
    }
    switch (event.status) {
      case "planned":
        if (startedAt !== null) {
          pausedAt = event.at;
          pauseCount += 1;
        }
        break;
      case "in_progress":
        startedAt ??= event.at;
        pausedAt = null;
        break;
      case "in_review":
        reviewAt ??= event.at;
        lastReviewAt = event.at;
        // A wait returns a paused task straight to review.
        pausedAt = null;
        break;
      case "done":
        completedAt = event.at;
        break;
    }
  }
  // The open period counts up to the latest change, e.g. in_progress to in_review.
  const last = timeline[timeline.length - 1];
  if (activeSince !== null && last !== undefined) {
    activeSeconds += Math.max(last.at - activeSince, 0);
  }
  return {
    plannedAt: timeline[0]?.at ?? null,
    startedAt,
    reviewAt,
    completedAt,
    reopenedAt,
    pausedAt,
    lastReviewAt,
    activeSeconds,
    pauseCount,
  };
}
