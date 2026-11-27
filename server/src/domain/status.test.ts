import { describe, expect, test } from "bun:test";

import {
  TASK_STATUSES,
  type TaskStatus,
  TransitionError,
  canTransitionTo,
  complete,
  conclude,
  reopen,
  transitionTo,
} from "./status.ts";

function outcome(action: () => TaskStatus): TaskStatus | null {
  try {
    return action();
  } catch (error) {
    if (error instanceof TransitionError) return null;
    throw error;
  }
}

describe("status", () => {
  test("only documented transitions are allowed", () => {
    const allowed = [
      "planned->in_progress",
      "in_progress->in_review",
      "in_progress->planned",
      "in_review->done",
      "in_review->planned",
    ];
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect([`${from}->${to}`, canTransitionTo(from, to)]).toEqual([
          `${from}->${to}`,
          allowed.includes(`${from}->${to}`),
        ]);
      }
    }
  });

  test("only an unfinished task can be concluded", () => {
    for (const from of TASK_STATUSES) {
      expect([from, outcome(() => conclude(from))]).toEqual([from, from === "done" ? null : "done"]);
    }
    expect(() => conclude("done")).toThrow("a done task cannot become done");
  });

  test("only a task being worked on can be completed", () => {
    for (const from of TASK_STATUSES) {
      const expected = from === "in_progress" || from === "in_review" ? "done" : null;
      expect([from, outcome(() => complete(from))]).toEqual([from, expected]);
    }
    expect(() => complete("planned")).toThrow("a planned task cannot become done");
  });

  test("only a done task can be reopened", () => {
    for (const from of TASK_STATUSES) {
      expect([from, outcome(() => reopen(from))]).toEqual([from, from === "done" ? "planned" : null]);
    }
  });

  test("illegal transition reports both states", () => {
    let error: unknown;
    try {
      transitionTo("planned", "in_review");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TransitionError);
    expect(error).toMatchObject({ from: "planned", to: "in_review" });
    expect(() => transitionTo("done", "planned")).toThrow("a done task cannot become planned");
    expect(transitionTo("planned", "in_progress")).toBe("in_progress");
  });
});
