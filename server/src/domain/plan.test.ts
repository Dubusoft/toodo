import { describe, expect, test } from "bun:test";

import {
  DueDate,
  Estimate,
  InvalidDueDate,
  InvalidEstimate,
  InvalidLabels,
  type InvalidLabelsReason,
  InvalidRefs,
  type InvalidRefsReason,
  MAX_LABELS,
  MAX_LABEL_CHARS,
  MAX_REFS,
  MAX_REF_CHARS,
  labels,
  mergeRefs,
} from "./plan.ts";

function refsProblem(action: () => unknown): InvalidRefsReason {
  try {
    action();
  } catch (error) {
    if (error instanceof InvalidRefs) return error.reason;
    throw error;
  }
  throw new Error("expected InvalidRefs");
}

function labelsProblem(action: () => unknown): InvalidLabelsReason {
  try {
    action();
  } catch (error) {
    if (error instanceof InvalidLabels) return error.reason;
    throw error;
  }
  throw new Error("expected InvalidLabels");
}

describe("plan", () => {
  test("refs keep their order skip repeats and are bounded", () => {
    const current = ["lane:a", "pr:1"];
    expect(mergeRefs(current, [" discord:9 ", "lane:a", "discord:9"], [])).toEqual([
      "lane:a",
      "pr:1",
      "discord:9",
    ]);
    expect(mergeRefs(current, ["pr:2"], [" lane:a", "gone"])).toEqual(["pr:1", "pr:2"]);
    expect(refsProblem(() => mergeRefs(current, [" "], []))).toEqual({ kind: "empty" });
    expect(refsProblem(() => mergeRefs(current, ["a\nb"], []))).toMatchObject({
      kind: "line_break",
    });
    expect(
      refsProblem(() => mergeRefs(current, ["x".repeat(MAX_REF_CHARS + 1)], [])),
    ).toMatchObject({ kind: "too_long" });
    const many = Array.from({ length: MAX_REFS }, (_, index) => `r:${index}`);
    expect(refsProblem(() => mergeRefs(current, many, []))).toEqual({
      kind: "too_many",
      count: MAX_REFS + 2,
    });
  });

  test("labels are trimmed sorted unique and bounded", () => {
    expect(labels([" toodo ", "goal: speed", "toodo"])).toEqual(["goal: speed", "toodo"]);
    expect(labelsProblem(() => labels([" "]))).toEqual({ kind: "empty" });
    expect(labelsProblem(() => labels(["a,b"]))).toMatchObject({ kind: "separator" });
    expect(() => labels(["é".repeat(MAX_LABEL_CHARS)])).not.toThrow();
    expect(labelsProblem(() => labels(["x".repeat(MAX_LABEL_CHARS + 1)]))).toMatchObject({
      kind: "too_long",
    });
    const many = Array.from({ length: MAX_LABELS + 1 }, (_, n) => String(n));
    expect(labelsProblem(() => labels(many))).toEqual({ kind: "too_many", count: MAX_LABELS + 1 });
  });

  test("estimates must be positive finite and bounded", () => {
    const estimate = Estimate.of("hours", 1.5);
    expect([estimate.unit, estimate.amount]).toEqual(["hours", 1.5]);
    expect(() => Estimate.of("weeks", Estimate.MAX_AMOUNT)).not.toThrow();
    for (const amount of [0, -1, NaN, Infinity, Estimate.MAX_AMOUNT + 1]) {
      expect(() => Estimate.of("days", amount)).toThrow(InvalidEstimate);
    }
  });

  test("due dates are calendar days and round trip", () => {
    for (const raw of ["2026-10-15", "2024-02-29", "2000-02-29", "2026-12-31"]) {
      expect(DueDate.parse(raw).toString()).toBe(raw);
    }
    for (const raw of [
      "",
      "2026-10-5",
      "2026/10/15",
      "2026-13-01",
      "2026-00-10",
      "2026-02-29",
      "1900-02-29",
      "2026-04-31",
      "0000-01-01",
      "2026-10-15T00:00",
      "+026-10-15",
    ]) {
      expect(() => DueDate.parse(raw)).toThrow(InvalidDueDate);
    }
    expect(DueDate.parse("2026-01-31").compare(DueDate.parse("2026-02-01"))).toBeLessThan(0);
  });
});
