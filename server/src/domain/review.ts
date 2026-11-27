// Review of the work done in a period such as a week, derived from the recorded task
// milestones and commit records (see `docs/architecture.md`, Week Review).

import type { CommitRecord, Task, TaskId } from "./model.ts";
import { milestones } from "./timeline.ts";

export class EmptyPeriod extends Error {
  constructor() {
    super("a review period must end after it starts");
    this.name = "EmptyPeriod";
  }
}

/** A half-open time range `[start, end)` in seconds since the Unix epoch. */
export class Period {
  readonly start: number;
  readonly end: number;

  private constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }

  static of(start: number, end: number): Period {
    if (start >= end) throw new EmptyPeriod();
    return new Period(start, end);
  }

  contains(at: number): boolean {
    return this.start <= at && at < this.end;
  }
}

/** What happened to a task during a period: the most advanced milestone it reached in the
 * period. `worked_on` means no milestone in the period, but commits were made. */
export type Outcome = "completed" | "opened_for_review" | "started" | "worked_on" | "planned";

/** Outcomes from most to least advanced. */
export const OUTCOMES: readonly Outcome[] = [
  "completed",
  "opened_for_review",
  "started",
  "worked_on",
  "planned",
];

/** A task that had activity in a period. */
export type TaskReview = {
  readonly taskId: TaskId;
  readonly outcome: Outcome;
  /** Time of the outcome: the milestone, or the latest commit for `worked_on`. */
  readonly at: number;
  /** Commits of the task made in the period, oldest first. */
  readonly commits: readonly CommitRecord[];
};

/** Reviews `tasks` over `period`: every task that reached a milestone or got a commit in
 * the period, ordered by outcome, then by time, then by task ID. Commits of tasks not in
 * `tasks` are ignored. Tasks without status history are reviewed by their commits alone;
 * their milestones are not guessed. */
export function review(
  period: Period,
  tasks: readonly Task[],
  commits: readonly CommitRecord[],
): TaskReview[] {
  const reviews: TaskReview[] = [];
  for (const task of tasks) {
    const taskCommits = commits
      .filter((commit) => commit.taskId === task.id && period.contains(commit.committedAt))
      .sort((a, b) => a.committedAt - b.committedAt);
    const reached = milestones(task.timeline);
    const inPeriod = (at: number | null) => (at !== null && period.contains(at) ? at : null);
    const candidates: readonly (readonly [Outcome, number | null])[] = [
      ["completed", inPeriod(reached.completedAt)],
      ["opened_for_review", inPeriod(reached.reviewAt)],
      ["started", inPeriod(reached.startedAt)],
      ["worked_on", taskCommits[taskCommits.length - 1]?.committedAt ?? null],
      ["planned", inPeriod(reached.plannedAt)],
    ];
    for (const [outcome, at] of candidates) {
      if (at !== null) {
        reviews.push({ taskId: task.id, outcome, at, commits: taskCommits });
        break;
      }
    }
  }
  return reviews.sort(
    (a, b) =>
      OUTCOMES.indexOf(a.outcome) - OUTCOMES.indexOf(b.outcome) ||
      a.at - b.at ||
      a.taskId - b.taskId,
  );
}
