import { expect, test } from "bun:test";
import type { ReviewPeriodKind } from "../../../../src/lib/api.ts";
import { CommandError } from "../errors.ts";
import { formatDuration } from "./format.ts";
import { ReportPeriod } from "./period.ts";
import { local } from "./report-fixtures.ts";

test("resolves each kind of period and names its file", () => {
  const today = Temporal.PlainDate.from("2026-10-15");
  const day = (text: string | null) => (text === null ? null : Temporal.PlainDate.from(text));
  const resolve = (kind: ReviewPeriodKind, date: string | null, from: string | null, to: string | null) =>
    ReportPeriod.resolve({ kind, date: day(date), from: day(from), to: day(to) }, today, "UTC");
  const days = (period: ReportPeriod) => [period.from.toString(), period.to.toString(), period.fileName("markdown")];

  expect(days(resolve("week", null, null, null))).toEqual(["2026-10-12", "2026-10-18", "toodo-review-2026-10-12-to-2026-10-18.md"]);
  expect(days(resolve("week", null, "2026-10-15", null))).toEqual(["2026-10-15", "2026-10-21", "toodo-review-2026-10-15-to-2026-10-21.md"]);
  expect(days(resolve("month", "2026-02-10", null, null))).toEqual(["2026-02-01", "2026-02-28", "toodo-review-2026-02.md"]);
  expect(days(resolve("quarter", "2026-12-31", null, null))).toEqual(["2026-10-01", "2026-12-31", "toodo-review-2026-Q4.md"]);
  expect(days(resolve("year", null, null, null))).toEqual(["2026-01-01", "2026-12-31", "toodo-review-2026.md"]);
  expect(days(resolve("custom", null, "2026-10-01", "2026-10-03"))).toEqual(["2026-10-01", "2026-10-03", "toodo-review-2026-10-01-to-2026-10-03.md"]);

  const refused: Array<[ReviewPeriodKind, string | null, string | null, string | null]> = [
    ["custom", null, "2026-10-01", null],
    ["custom", null, "2026-10-03", "2026-10-01"],
    ["custom", "2026-10-01", null, null],
    ["month", null, null, "2026-10-01"],
    ["week", "2026-10-01", "2026-10-01", null],
  ];
  for (const [kind, date, from, to] of refused) {
    expect(() => resolve(kind, date, from, to)).toThrow(CommandError);
  }
});

test("a period runs between local midnights across a daylight saving change", () => {
  const day = Temporal.PlainDate.from("2026-10-19");
  const period = ReportPeriod.resolve({ kind: "week", date: null, from: day, to: null }, day, "Europe/Berlin");
  expect(period.start).toBe(local(2026, 10, 18, 22));
  expect(period.end).toBe(local(2026, 10, 25, 23));
});

test("formats durations as hours below a day and days above", () => {
  expect(formatDuration(1800)).toBe("<1h");
  expect(formatDuration(5 * 3600)).toBe("5h");
  expect(formatDuration(23.6 * 3600)).toBe("1.0d");
  expect(formatDuration(30 * 3600)).toBe("1.3d");
});
