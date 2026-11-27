import { describe, expect, test } from "bun:test";

import { type CommitRecord, type Task, taskId, workspaceId } from "./model.ts";
import { EmptyPeriod, type Outcome, Period, type TaskReview, review } from "./review.ts";
import type { TaskStatus } from "./status.ts";

const WEEK = Period.of(1000, 2000);

function task(id: number, history: readonly (readonly [TaskStatus, number])[]): Task {
  return {
    id: taskId(id),
    workspaceId: workspaceId(1),
    taskType: "feat",
    title: `Task ${id}`,
    description: "",
    status: history[history.length - 1]?.[0] ?? "planned",
    resolution: null,
    dependsOn: new Set(),
    issue: null,
    estimate: null,
    dueDate: null,
    labels: [],
    refs: [],
    completionNote: null,
    timeline: history.map(([status, at]) => ({ status, at, reason: null })),
    notes: [],
    criteria: [],
    wait: null,
    autopilotAt: null,
  };
}

function commit(task: number, sha: string, committedAt: number): CommitRecord {
  return {
    taskId: taskId(task),
    sha,
    message: `Commit ${sha}`,
    author: "Dev <dev@example.com>",
    committedAt,
  };
}

function outcomes(reviews: readonly TaskReview[]): (readonly [number, Outcome, number])[] {
  return reviews.map((each) => [each.taskId, each.outcome, each.at] as const);
}

describe("review", () => {
  test("a period must end after it starts", () => {
    expect(() => Period.of(10, 10)).toThrow(EmptyPeriod);
    expect(() => Period.of(20, 10)).toThrow(EmptyPeriod);
    const period = Period.of(10, 20);
    expect(period.contains(10)).toBe(true);
    expect(period.contains(20)).toBe(false);
  });

  test("each task gets its most advanced milestone in the period", () => {
    const tasks = [
      task(1, [
        ["planned", 1100],
        ["in_progress", 1200],
        ["in_review", 1300],
        ["done", 1400],
      ]),
      task(2, [
        ["planned", 100],
        ["in_progress", 200],
        ["in_review", 1500],
      ]),
      task(3, [
        ["planned", 100],
        ["in_progress", 1100],
        ["planned", 1150],
      ]),
      task(4, [
        ["planned", 100],
        ["in_progress", 1600],
      ]),
      task(5, [["planned", 1700]]),
      task(6, [
        ["planned", 100],
        ["in_progress", 200],
        ["in_review", 300],
        ["done", 1050],
      ]),
    ];
    expect(outcomes(review(WEEK, tasks, []))).toEqual([
      [6, "completed", 1050],
      [1, "completed", 1400],
      [2, "opened_for_review", 1500],
      [3, "started", 1100],
      [4, "started", 1600],
      [5, "planned", 1700],
    ]);
  });

  test("the period includes its start and excludes its end", () => {
    const tasks = [
      task(1, [
        ["planned", 100],
        ["in_progress", 1000],
      ]),
      task(2, [
        ["planned", 100],
        ["in_progress", 2000],
      ]),
      task(3, [
        ["planned", 999],
        ["in_progress", 1999],
      ]),
    ];
    const commits = [commit(2, "end", 2000), commit(2, "before", 999)];
    expect(outcomes(review(WEEK, tasks, commits))).toEqual([
      [1, "started", 1000],
      [3, "started", 1999],
    ]);
  });

  test("commits alone make a task worked on and keep only the period", () => {
    const tasks = [
      task(1, [
        ["planned", 100],
        ["in_progress", 200],
      ]),
      task(2, [
        ["planned", 100],
        ["in_progress", 1100],
      ]),
      task(3, []),
    ];
    const commits = [
      commit(1, "late", 1800),
      commit(1, "early", 1200),
      commit(1, "old", 500),
      commit(2, "start", 1150),
      commit(3, "legacy", 1300),
      commit(9, "unknown task", 1300),
    ];
    const reviews = review(WEEK, tasks, commits);
    expect(outcomes(reviews)).toEqual([
      [2, "started", 1100],
      [3, "worked_on", 1300],
      [1, "worked_on", 1800],
    ]);
    expect(reviews[2]?.commits.map((each) => each.sha)).toEqual(["early", "late"]);
    expect(reviews[0]?.commits).toHaveLength(1);
  });

  test("tasks without activity in the period are left out", () => {
    const tasks = [
      task(1, [
        ["planned", 100],
        ["in_progress", 200],
        ["in_review", 300],
        ["done", 400],
      ]),
      task(2, [["planned", 2500]]),
      task(3, []),
    ];
    const commits = [commit(1, "old", 300), commit(3, "later", 2100)];
    expect(review(WEEK, tasks, commits)).toEqual([]);
  });
});
