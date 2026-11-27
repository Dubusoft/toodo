import { describe, expect, test } from "bun:test";

import type { TaskStatus } from "./status.ts";
import { type Milestones, type TaskEvent, milestones } from "./timeline.ts";

function events(raw: readonly (readonly [TaskStatus, number])[]): TaskEvent[] {
  return raw.map(([status, at]) => ({ status, at, reason: null }));
}

const NONE: Milestones = {
  plannedAt: null,
  startedAt: null,
  reviewAt: null,
  completedAt: null,
  reopenedAt: null,
  pausedAt: null,
  lastReviewAt: null,
  activeSeconds: 0,
  pauseCount: 0,
};

describe("timeline", () => {
  test("a return to review ends the pause", () => {
    const returned = milestones(
      events([
        ["planned", 10],
        ["in_progress", 20],
        ["in_review", 30],
        ["planned", 40],
        ["in_review", 50],
      ]),
    );
    expect(returned.pausedAt).toBeNull();
    expect(returned.pauseCount).toBe(1);
    expect(returned.lastReviewAt).toBe(50);
  });

  test("a task without history has no milestones", () => {
    expect(milestones([])).toEqual(NONE);
  });

  test("a completed task has every milestone but a pause", () => {
    const timeline = events([
      ["planned", 10],
      ["in_progress", 30],
      ["in_review", 40],
      ["done", 50],
    ]);
    expect(milestones(timeline)).toEqual({
      plannedAt: 10,
      startedAt: 30,
      reviewAt: 40,
      completedAt: 50,
      reopenedAt: null,
      pausedAt: null,
      lastReviewAt: 40,
      activeSeconds: 20,
      pauseCount: 0,
    });
  });

  test("a reopened task is no longer completed until it is done again", () => {
    const timeline = events([
      ["planned", 10],
      ["in_progress", 20],
      ["done", 30],
      ["planned", 40],
    ]);
    const reopened = milestones(timeline);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.reopenedAt).toBe(40);
    expect(reopened.pausedAt).toBe(40);
    expect(reopened.startedAt).toBe(20);

    const done = milestones([
      ...timeline,
      ...events([
        ["in_progress", 50],
        ["done", 60],
      ]),
    ]);
    expect(done.completedAt).toBe(60);
    expect(done.reopenedAt).toBe(40);
    expect(done.pausedAt).toBeNull();
  });

  test("a paused task keeps the milestones it reached", () => {
    const timeline = events([
      ["planned", 10],
      ["in_progress", 20],
      ["planned", 30],
    ]);
    expect(milestones(timeline)).toEqual({
      ...NONE,
      plannedAt: 10,
      startedAt: 20,
      pausedAt: 30,
      activeSeconds: 10,
      pauseCount: 1,
    });
  });

  test("a restarted task is no longer paused and keeps its first start", () => {
    const timeline = events([
      ["planned", 10],
      ["in_progress", 20],
      ["planned", 30],
      ["in_progress", 40],
    ]);
    expect(milestones(timeline).startedAt).toBe(20);
    expect(milestones(timeline).pausedAt).toBeNull();

    const paused = milestones([
      ...timeline,
      ...events([
        ["in_review", 50],
        ["planned", 60],
      ]),
    ]);
    expect(paused.reviewAt).toBe(50);
    expect(paused.pausedAt).toBe(60);
  });

  test("pauses are counted and left out of the active time", () => {
    const reached = milestones(
      events([
        ["planned", 0],
        ["in_progress", 100],
        ["in_review", 150],
        ["planned", 200],
        ["in_progress", 1_000],
        ["in_review", 1_300],
        ["done", 1_400],
      ]),
    );
    expect(reached.activeSeconds).toBe(100 + 400);
    expect(reached.pauseCount).toBe(1);
    expect(reached.reviewAt).toBe(150);
    expect(reached.lastReviewAt).toBe(1_300);
  });
});
