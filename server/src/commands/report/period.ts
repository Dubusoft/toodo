// The calendar period a report covers. Port of `src-tauri/src/commands/report/period.rs`.

import { invalidInput } from "../errors.ts";
import type { ReportFormat, ReviewPeriodKind } from "../../../../src/lib/bindings.ts";
import { addDays, addMonths, midnight, yearMonth } from "./calendar.ts";
import type { Day, TimeZone } from "./calendar.ts";

const OUT_OF_RANGE = "the period is out of the supported range of days; pick days in the years 1 to 9998";

/** What `resolve` takes: the kind of period and the days that place it. */
export type PeriodRequest = {
  readonly kind: ReviewPeriodKind;
  readonly date: Day | null;
  readonly from: Day | null;
  readonly to: Day | null;
};

function required<T>(value: T | null): T {
  if (value === null) throw invalidInput(OUT_OF_RANGE);
  return value;
}

/** A reviewed period: the calendar days `from` to `to`, both included, and the half-open
 * range `[start, end)` from midnight of `from` to midnight after `to` in its time zone. */
export class ReportPeriod {
  constructor(
    readonly kind: ReviewPeriodKind,
    readonly from: Day,
    readonly to: Day,
    readonly start: number,
    readonly end: number,
  ) {}

  /** The period of the kind that starts on `from` (for a week), contains `from` or `date`
   * (for a month, quarter, or year), or contains `today` when neither is given; a custom
   * period needs `from` and `to`. */
  static resolve({ kind, date, from, to }: PeriodRequest, today: Day, timeZone: TimeZone): ReportPeriod {
    if (date !== null && from !== null) {
      throw invalidInput("give either date (a day inside the period) or from (its first day), not both");
    }
    const [first, last] = days(kind, date, from, to, today);
    return new ReportPeriod(
      kind,
      first,
      last,
      required(midnight(first, timeZone)),
      required(midnight(required(addDays(last, 1)), timeZone)),
    );
  }

  title(): string {
    switch (this.kind) {
      case "week":
        return "Week review";
      case "month":
        return "Month review";
      case "quarter":
        return "Quarter review";
      case "year":
        return "Year review";
      case "custom":
        return "Review";
    }
  }

  /** The title of the period with its label, e.g. `Year review 2026`. */
  name(): string {
    return `${this.title()} ${this.label()}`;
  }

  label(): string {
    switch (this.kind) {
      case "month":
        return yearMonth(this.from);
      case "quarter":
        return `${this.from.year} Q${Math.floor((this.from.month - 1) / 3) + 1}`;
      case "year":
        return String(this.from.year);
      case "week":
      case "custom":
        return `${this.from.toString()} to ${this.to.toString()}`;
    }
  }

  fileName(format: ReportFormat): string {
    return `toodo-review-${this.label().replaceAll(" ", "-")}.${format === "markdown" ? "md" : "csv"}`;
  }

  /** The calendar months the period touches, as `YYYY-MM`. */
  months(): string[] {
    const months: string[] = [];
    let month: Day | null = this.from.with({ day: 1 });
    while (month !== null && Temporal.PlainDate.compare(month, this.to) <= 0) {
      months.push(yearMonth(month));
      month = addMonths(month, 1);
    }
    return months;
  }
}

function days(kind: ReviewPeriodKind, date: Day | null, from: Day | null, to: Day | null, today: Day): [Day, Day] {
  if (kind === "custom") {
    if (date !== null) {
      throw invalidInput(
        "a custom period takes from and to, its first and last day; pass those instead of date, or pick period week, month, quarter, or year",
      );
    }
    if (from === null || to === null) {
      throw invalidInput(
        "a custom period needs from and to, its first and last day as YYYY-MM-DD; or pick period week, month, quarter, or year",
      );
    }
    if (Temporal.PlainDate.compare(to, from) < 0) {
      throw invalidInput(`to ${to.toString()} is before from ${from.toString()}; pass a last day on or after the first`);
    }
    return [from, to];
  }
  if (to !== null) {
    throw invalidInput("to is only for a custom period; pass period custom with from and to, or leave out to");
  }
  if (kind === "week") {
    const day = date ?? today;
    const first = from ?? required(addDays(day, -(day.dayOfWeek - 1)));
    return [first, required(addDays(first, 6))];
  }
  const day = from ?? date ?? today;
  const [firstMonth, months] =
    kind === "month" ? [day.month, 1] : kind === "quarter" ? [day.month - ((day.month - 1) % 3), 3] : [1, 12];
  const first = day.with({ month: firstMonth, day: 1 });
  return [first, required(addDays(required(addMonths(first, months)), -1))];
}
