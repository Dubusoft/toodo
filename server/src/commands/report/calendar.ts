// Calendar days and time zones as the Rust server's `jiff` reads them. Temporal follows the
// same ISO 8601 grammar and the same `compatible` rule for local times a time zone change
// skips or repeats; this adds jiff's narrower ranges of days and instants.

import { debugString, trim } from "../../domain/rust.ts";
import { invalidInput } from "../errors.ts";

export type Day = Temporal.PlainDate;

/** An IANA time zone name, or a fixed offset such as `+02:00` in tests. */
export type TimeZone = string;

/** `jiff::Timestamp::MIN` and `MAX`, in seconds. */
export const TIMESTAMP_MIN = -377_705_023_201;
export const TIMESTAMP_MAX = 253_402_207_200;

const FIRST_DAY = Temporal.PlainDate.from("-009999-01-01");
const LAST_DAY = Temporal.PlainDate.from("9999-12-31");

/** Days jiff represents. */
export function inRange(day: Day): boolean {
  return Temporal.PlainDate.compare(day, FIRST_DAY) >= 0 && Temporal.PlainDate.compare(day, LAST_DAY) <= 0;
}

/** `value` read as a day the way `str::parse::<jiff::civil::Date>` reads it; `null` when it
 * is not one. */
export function readDay(value: string): Day | null {
  try {
    const day = Temporal.PlainDate.from(value);
    return inRange(day) ? day : null;
  } catch {
    return null;
  }
}

/** `value`, trimmed, as a day, or an invalid input error naming `field`. */
export function parseDay(field: string, value: string): Day {
  const day = readDay(trim(value));
  if (day === null) {
    throw invalidInput(
      `${field} ${debugString(value)} is not a day; pass it as YYYY-MM-DD, e.g. 2026-10-12`,
    );
  }
  return day;
}

/** Zones of the time zone database that Temporal's ICU data leaves out, with the zones they
 * link to since tzdb 2024b. */
const LINKS: Readonly<Record<string, string>> = {
  CST6CDT: "America/Chicago",
  EST5EDT: "America/New_York",
  MST7MDT: "America/Denver",
  PST8PDT: "America/Los_Angeles",
};

/** The zone Temporal computes `timeZone` with. */
function temporalZone(timeZone: TimeZone): string {
  return LINKS[timeZone] ?? timeZone;
}

/** The IANA name of time zone `name` with the case its database gives it; `null` when there
 * is no such zone. Offsets are not zone names. */
export function zoneName(name: string): string | null {
  if (/^[+-]/.test(name)) return null;
  const link = Object.keys(LINKS).find((zone) => zone.toLowerCase() === name.toLowerCase());
  if (link !== undefined) return link;
  try {
    return new Temporal.ZonedDateTime(0n, name).timeZoneId;
  } catch {
    return null;
  }
}

/** The server's own time zone, or `UTC` when it has no IANA name. */
export function systemZone(): TimeZone {
  return zoneName(Temporal.Now.timeZoneId()) ?? "UTC";
}

/** Seconds of the first moment of `day` in `timeZone`, or `null` beyond jiff's instants. */
export function midnight(day: Day, timeZone: TimeZone): number | null {
  if (!inRange(day)) return null;
  const at = day.toZonedDateTime({ timeZone: temporalZone(timeZone), plainTime: new Temporal.PlainTime() }).epochMilliseconds / 1000;
  return at < TIMESTAMP_MIN || at > TIMESTAMP_MAX ? null : at;
}

/** The local date and time of `at` in `timeZone`, clamped into jiff's instants. */
export function zoned(at: number, timeZone: TimeZone): Temporal.ZonedDateTime {
  const clamped = Math.min(Math.max(at, TIMESTAMP_MIN), TIMESTAMP_MAX);
  return Temporal.Instant.fromEpochMilliseconds(clamped * 1000).toZonedDateTimeISO(temporalZone(timeZone));
}

export function yearMonth(day: Day): string {
  return day.toPlainYearMonth().toString();
}

/** `day` moved by `days`, or `null` beyond jiff's days. */
export function addDays(day: Day, days: number): Day | null {
  const moved = day.add({ days });
  return inRange(moved) ? moved : null;
}

/** `day` moved by `months`, or `null` beyond jiff's days. */
export function addMonths(day: Day, months: number): Day | null {
  const moved = day.add({ months });
  return inRange(moved) ? moved : null;
}
