import { describe, expect, it } from "vitest";
import type { TaskEvent, TaskStatus } from "@/lib/bindings";
import {
  activeSeconds,
  formatDate,
  formatFull,
  formatRemaining,
  formatWhen,
  reachedMilestones,
  setDisplayTimeZone,
  waitingSeconds,
  workSegments,
} from "@/lib/timeline";

function history(raw: [TaskStatus, number][]): TaskEvent[] {
  return raw.map(([status, at], index) => ({
    status,
    at,
    reopened: index > 0 && raw[index - 1][0] === "done" && status !== "done",
    reason: null,
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
      { state: "in_progress", start: 100, end: 300, reason: null },
      { state: "paused", start: 300, end: 1000, reason: null },
      { state: "in_progress", start: 1000, end: 1100, reason: null },
      { state: "in_review", start: 1100, end: 1200, reason: null },
    ]);
  });

  it("leaves the current stretch open and ignores the time before the first start", () => {
    expect(workSegments(history([["planned", 0]]))).toEqual([]);
    expect(workSegments(history([["planned", 0], ["in_progress", 50], ["planned", 80]]))).toEqual([
      { state: "in_progress", start: 50, end: 80, reason: null },
      { state: "paused", start: 80, end: null, reason: null },
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
      { state: "in_progress", start: 100, end: 200, reason: null },
      { state: "paused", start: 500, end: 600, reason: null },
      { state: "in_progress", start: 600, end: 700, reason: null },
    ]);
    expect(activeSeconds(reopened, 5000)).toBe(200);
  });
});

describe("waitingSeconds", () => {
  it("counts the pauses after the first start, one under way until now, with their reasons", () => {
    expect(waitingSeconds(resumed, 5000)).toBe(700);
    const waiting = history([["planned", 0], ["in_progress", 50], ["planned", 80]]);
    waiting[2].reason = "Waiting on #3 API (planned)";
    expect(waitingSeconds(waiting, 900)).toBe(820);
    expect(workSegments(waiting).at(-1)?.reason).toBe("Waiting on #3 API (planned)");
    expect(waitingSeconds(history([["planned", 0]]), 90)).toBeNull();
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

describe("formatRemaining", () => {
  const now = 1_000_000;
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;

  it("rounds down to minutes, half hours, and days under two weeks", () => {
    expect(formatRemaining(now - 5, now)).toBe("0m");
    expect(formatRemaining(now + 59 * minute + 59, now)).toBe("59m");
    expect(formatRemaining(now + hour + 29 * minute, now)).toBe("1h");
    expect(formatRemaining(now + hour + 30 * minute, now)).toBe("1.5h");
    expect(formatRemaining(now + 23 * hour + 59 * minute, now)).toBe("23.5h");
    expect(formatRemaining(now + day, now)).toBe("1d");
    expect(formatRemaining(now + 7 * day + 23 * hour, now)).toBe("7d");
    expect(formatRemaining(now + 13 * day + 23 * hour, now)).toBe("13d");
  });

  it("counts whole weeks, months, and years from two weeks on", () => {
    expect(formatRemaining(now + 14 * day, now)).toBe("2w");
    expect(formatRemaining(now + 59 * day, now)).toBe("8w");
    expect(formatRemaining(now + 60 * day, now)).toBe("2mo");
    expect(formatRemaining(now + 364 * day, now)).toBe("12mo");
    expect(formatRemaining(now + 2 * 365 * day + 300 * day, now)).toBe("2y");
  });
});

describe("formatFull", () => {
  it("prints date and time down to the minute", () => {
    expect(formatFull(new Date(2026, 0, 5, 23, 30, 45).getTime() / 1000)).toBe("Jan 5, 2026, 11:30 PM");
  });

  it("shows the time in the display time zone, and in this device's one for a zone it does not know", () => {
    const at = Date.UTC(2026, 0, 5, 14, 30) / 1000;
    try {
      setDisplayTimeZone("Asia/Seoul");
      expect(formatFull(at)).toBe("Jan 5, 2026, 11:30 PM");
      setDisplayTimeZone("America/New_York");
      expect(formatFull(at)).toBe("Jan 5, 2026, 9:30 AM");
      setDisplayTimeZone("Mars/Olympus");
      expect(formatFull(at)).toBe(new Date(at * 1000).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }));
    } finally {
      setDisplayTimeZone(null);
    }
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
