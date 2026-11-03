import { describe, expect, it } from "vitest";
import type { TaskEvent, TaskStatus } from "@/lib/bindings";
import { activeSeconds, formatDate, formatFull, formatWhen, reachedMilestones, workSegments } from "@/lib/timeline";

function history(raw: [TaskStatus, number][]): TaskEvent[] {
  return raw.map(([status, at], index) => ({
    status,
    at,
    reopened: index > 0 && raw[index - 1][0] === "done" && status !== "done",
  }));
}

const resumed = history([
  ["planned", 0],
  ["in_progress", 100],
  ["planned", 300],
  ["in_progress", 1000],
  ["in_review", 1100],
  ["done", 1200],
]);

describe("workSegments", () => {
  it("splits the work from the first start to completion into stretches, pauses included", () => {
    expect(workSegments(resumed)).toEqual([
      { state: "in_progress", start: 100, end: 300 },
      { state: "paused", start: 300, end: 1000 },
      { state: "in_progress", start: 1000, end: 1100 },
      { state: "in_review", start: 1100, end: 1200 },
    ]);
  });

  it("leaves the current stretch open and ignores the time before the first start", () => {
    expect(workSegments(history([["planned", 0]]))).toEqual([]);
    expect(workSegments(history([["planned", 0], ["in_progress", 50], ["planned", 80]]))).toEqual([
      { state: "in_progress", start: 50, end: 80 },
      { state: "paused", start: 80, end: null },
    ]);
  });

  it("goes on after a reopening, which pauses the task until it is resumed", () => {
    const reopened = history([
      ["planned", 0],
      ["in_progress", 100],
      ["done", 200],
      ["planned", 500],
      ["in_progress", 600],
      ["done", 700],
    ]);

    expect(workSegments(reopened)).toEqual([
      { state: "in_progress", start: 100, end: 200 },
      { state: "paused", start: 500, end: 600 },
      { state: "in_progress", start: 600, end: 700 },
    ]);
    expect(activeSeconds(reopened, 5000)).toBe(200);
  });
});

describe("activeSeconds", () => {
  it("counts time in progress and in review but not pauses", () => {
    expect(activeSeconds(resumed, 5000)).toBe(400);
  });

  it("counts a stretch under way until now, and is null without a start", () => {
    expect(activeSeconds(history([["planned", 0], ["in_progress", 50]]), 90)).toBe(40);
    expect(activeSeconds(history([["planned", 0], ["in_progress", 50], ["planned", 80]]), 900)).toBe(30);
    expect(activeSeconds([], 90)).toBeNull();
  });
});

describe("formatDate", () => {
  it("prints the local calendar date", () => {
    const at = new Date(2026, 0, 5, 23, 30).getTime() / 1000;

    expect(formatDate(at)).toBe("2026-01-05");
  });
});

describe("formatWhen", () => {
  const now = new Date(2026, 9, 24, 12, 0, 0).getTime() / 1000;

  it("is relative within 7 days and never shows seconds", () => {
    expect(formatWhen(now - 20, now)).toBe("just now");
    expect(formatWhen(now - 5 * 60 - 30, now)).toBe("5 min. ago");
    expect(formatWhen(now - 3 * 3600, now)).toBe("3 hr. ago");
    expect(formatWhen(now - 6 * 86400, now)).toBe("6 days ago");
  });

  it("is a short date from 7 days on, with the year when it is not this one", () => {
    expect(formatWhen(now - 7 * 86400, now)).toBe("Oct 17");
    expect(formatWhen(new Date(2025, 11, 31, 8, 0).getTime() / 1000, now)).toBe("Dec 31, 2025");
  });
});

describe("formatFull", () => {
  it("prints date and time down to the minute", () => {
    expect(formatFull(new Date(2026, 0, 5, 23, 30, 45).getTime() / 1000)).toBe("Jan 5, 2026, 11:30 PM");
  });
});

describe("reachedMilestones", () => {
  it("lists reached milestones in lifecycle order and skips the rest", () => {
    expect(
      reachedMilestones({
        plannedAt: 10,
        startedAt: 20,
        reviewAt: null,
        completedAt: null,
        reopenedAt: null,
        pausedAt: 30,
        lastReviewAt: null,
        activeSeconds: 0,
        pauseCount: 0,
      }),
    ).toEqual([
      { label: "Planned", at: 10 },
      { label: "Started", at: 20 },
      { label: "Paused", at: 30 },
    ]);
  });

  it("orders them by time, so completing a reopened task again comes last", () => {
    expect(
      reachedMilestones({
        plannedAt: 10,
        startedAt: 20,
        reviewAt: null,
        completedAt: 60,
        reopenedAt: 40,
        pausedAt: null,
        lastReviewAt: null,
        activeSeconds: 0,
        pauseCount: 0,
      }).map(({ label }) => label),
    ).toEqual(["Planned", "Started", "Reopened", "Completed"]);
  });
});
