import { describe, expect, it } from "vitest";
import { formatWorked, workingSeconds } from "@/components/task-details/activity";

describe("workingSeconds", () => {
  it("counts each working stretch until the next change, and the current one until now", () => {
    const transitions = [
      { status: "working" as const, at: 1_000 },
      { status: "blocked" as const, at: 1_600 },
      { status: "working" as const, at: 2_000 },
      { status: null, at: 2_300 },
      { status: "working" as const, at: 5_000 },
    ];
    expect(workingSeconds(transitions, 5_120)).toBe(600 + 300 + 120);
    expect(workingSeconds([], 5_120)).toBe(0);
  });
});

describe("formatWorked", () => {
  it("shows minutes below an hour and hours with minutes above", () => {
    expect([30, 25 * 60, 3 * 3600 + 5 * 60].map(formatWorked)).toEqual(["<1m", "25m", "3h 5m"]);
  });
});
