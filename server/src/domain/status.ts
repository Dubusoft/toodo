// Task states and the transitions allowed between them (see `docs/workflow.md`).
//
// Whether a `planned` task can start is not a state of its own: it follows from its
// dependencies (see `isReady` in `dag.ts`).

/**
 * - `planned`: not being worked on: not started yet, or paused. A paused task keeps its
 *   branch, worktree, commit records, and pull request.
 * - `in_review`: awaiting completion: the task's pull request is open, waiting for its
 *   merge, or every completion criterion is met and one of them is manual, waiting for
 *   someone to confirm it (see `criteria.ts`).
 * - `done`: finished: its criteria were met, or the work was concluded without adoption
 *   (see `TaskResolution`).
 */
export type TaskStatus = "planned" | "in_progress" | "in_review" | "done";

export const TASK_STATUSES: readonly TaskStatus[] = ["planned", "in_progress", "in_review", "done"];

export class TransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`a ${from} task cannot become ${to}`);
    this.name = "TransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionTo(from: TaskStatus, next: TaskStatus): boolean {
  switch (from) {
    case "planned":
      return next === "in_progress";
    // Pausing: work stops until the task is started again.
    case "in_progress":
      return next === "in_review" || next === "planned";
    case "in_review":
      return next === "done" || next === "planned";
    case "done":
      return false;
  }
}

export function transitionTo(from: TaskStatus, next: TaskStatus): TaskStatus {
  if (!canTransitionTo(from, next)) throw new TransitionError(from, next);
  return next;
}

/** Concludes a task without completing it, e.g. research that is not adopted. A `planned`
 * task can be concluded too, so an idea is dropped without starting it first. */
export function conclude(from: TaskStatus): TaskStatus {
  return from === "planned" ? "done" : complete(from);
}

/** Completes a task that is being worked on once its completion criteria are met: a task
 * whose criteria Toodo checks on its own can be done straight from `in_progress`, e.g. a
 * branch merged locally. */
export function complete(from: TaskStatus): TaskStatus {
  switch (from) {
    case "in_progress":
    case "in_review":
      return "done";
    case "planned":
    case "done":
      throw new TransitionError(from, "done");
  }
}

/** Reopens a `done` task, e.g. one completed or concluded by mistake: it becomes `planned`
 * again, paused if it was started, so starting it resumes the work. This is not one of the
 * transitions of `canTransitionTo`, so pausing never reopens a task. */
export function reopen(from: TaskStatus): TaskStatus {
  if (from !== "done") throw new TransitionError(from, "planned");
  return "planned";
}
