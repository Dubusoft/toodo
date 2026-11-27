// What a task was planned to take: an estimate of its size and the day it is due. Both are
// optional; reviews compare them with the active time and completion day the status
// history records. Labels group tasks by project or goal for those reviews.

import { charCount, compareStrings, debugString, displayFloat, trim } from "./rust.ts";

/** The unit of time an estimate counts, compared with the time a task spent in progress or
 * in review. A day is 24 hours, a week 7 days, and a month 30 days. */
export type EstimateUnit = "hours" | "days" | "weeks" | "months";

export const ESTIMATE_UNITS: readonly EstimateUnit[] = ["hours", "days", "weeks", "months"];

export class InvalidEstimate extends Error {
  readonly amount: number;

  constructor(amount: number) {
    super(
      `estimate must be greater than 0 and at most ${displayFloat(Estimate.MAX_AMOUNT)}, got ${displayFloat(amount)}`,
    );
    this.name = "InvalidEstimate";
    this.amount = amount;
  }
}

/** The expected size of a task. The amount is always finite and positive. */
export class Estimate {
  /** Largest accepted amount, far above any sensible estimate of one task. */
  static readonly MAX_AMOUNT = 10_000;

  readonly unit: EstimateUnit;
  readonly amount: number;

  private constructor(unit: EstimateUnit, amount: number) {
    this.unit = unit;
    this.amount = amount;
  }

  static of(unit: EstimateUnit, amount: number): Estimate {
    if (!(Number.isFinite(amount) && amount > 0 && amount <= Estimate.MAX_AMOUNT)) {
      throw new InvalidEstimate(amount);
    }
    return new Estimate(unit, amount);
  }
}

export class InvalidDueDate extends Error {
  readonly raw: string;

  constructor(raw: string) {
    super(`due date must be a calendar day as YYYY-MM-DD, got ${debugString(raw)}`);
    this.name = "InvalidDueDate";
    this.raw = raw;
  }
}

/** A calendar day, without a time zone: a task is on time when it is completed on or
 * before this day in the user's local time. */
export class DueDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;

  private constructor(year: number, month: number, day: number) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  /** Parses `YYYY-MM-DD`, rejecting days the month does not have. */
  static parse(raw: string): DueDate {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new InvalidDueDate(raw);
    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(5, 7));
    const day = Number(raw.slice(8, 10));
    if (year === 0 || month < 1 || month > 12 || day === 0 || day > daysInMonth(year, month)) {
      throw new InvalidDueDate(raw);
    }
    return new DueDate(year, month, day);
  }

  /** Negative, zero, or positive as this day is before, on, or after `other`. */
  compare(other: DueDate): number {
    return this.year - other.year || this.month - other.month || this.day - other.day;
  }

  toString(): string {
    return `${String(this.year).padStart(4, "0")}-${String(this.month).padStart(2, "0")}-${String(this.day).padStart(2, "0")}`;
  }
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/** The most characters a label has. */
export const MAX_LABEL_CHARS = 40;
/** The most labels a task has. */
export const MAX_LABELS = 20;

export type InvalidLabelsReason =
  | { readonly kind: "empty" }
  | { readonly kind: "separator"; readonly label: string }
  | { readonly kind: "too_long"; readonly label: string }
  | { readonly kind: "too_many"; readonly count: number };

export class InvalidLabels extends Error {
  readonly reason: InvalidLabelsReason;

  constructor(reason: InvalidLabelsReason) {
    super(invalidLabelsMessage(reason));
    this.name = "InvalidLabels";
    this.reason = reason;
  }
}

function invalidLabelsMessage(reason: InvalidLabelsReason): string {
  switch (reason.kind) {
    case "empty":
      return "labels must not be blank; leave out the empty label";
    case "separator":
      return `label ${debugString(reason.label)} has a comma or line break; pass each label as its own list item`;
    case "too_long":
      return `label ${debugString(reason.label)} is longer than ${MAX_LABEL_CHARS} characters; shorten it`;
    case "too_many":
      return `a task has at most ${MAX_LABELS} labels, got ${reason.count}; keep the ones reviews group by`;
  }
}

/** The labels of a task from `raw`: each trimmed, sorted, and without duplicates. A label is
 * non-empty, at most `MAX_LABEL_CHARS` characters, and has no comma or line break, so a
 * comma-separated list can name several. */
export function labels(raw: readonly string[]): string[] {
  const trimmed = raw.map((rawLabel) => {
    const label = trim(rawLabel);
    if (label === "") throw new InvalidLabels({ kind: "empty" });
    if (/[,\n\r]/.test(label)) throw new InvalidLabels({ kind: "separator", label });
    if (charCount(label) > MAX_LABEL_CHARS) throw new InvalidLabels({ kind: "too_long", label });
    return label;
  });
  const sorted = trimmed.sort(compareStrings);
  const unique = sorted.filter((label, index) => index === 0 || label !== sorted[index - 1]);
  if (unique.length > MAX_LABELS) {
    throw new InvalidLabels({ kind: "too_many", count: unique.length });
  }
  return unique;
}

/** The most characters a reference has. */
export const MAX_REF_CHARS = 500;
/** The most references a task has. */
export const MAX_REFS = 50;

export type InvalidRefsReason =
  | { readonly kind: "empty" }
  | { readonly kind: "line_break"; readonly reference: string }
  | { readonly kind: "too_long"; readonly reference: string }
  | { readonly kind: "too_many"; readonly count: number };

export class InvalidRefs extends Error {
  readonly reason: InvalidRefsReason;

  constructor(reason: InvalidRefsReason) {
    super(invalidRefsMessage(reason));
    this.name = "InvalidRefs";
    this.reason = reason;
  }
}

function invalidRefsMessage(reason: InvalidRefsReason): string {
  switch (reason.kind) {
    case "empty":
      return "refs must not be blank; leave out the empty reference";
    case "line_break":
      return `reference ${debugString(reason.reference)} has a line break; pass each reference as its own list item`;
    case "too_long":
      return `reference ${debugString(reason.reference)} is longer than ${MAX_REF_CHARS} characters; shorten it, e.g. to \`pr:<number>\` or a URL`;
    case "too_many":
      return `a task has at most ${MAX_REFS} references, got ${reason.count}; drop old ones with update_task remove_refs`;
  }
}

/** The references of a task after appending `add` to `current` and then dropping `remove`.
 * Toodo keeps references in order and shows them without interpreting them; by convention
 * one reads `<kind>:<value>`, e.g. `lane:search-api` or `pr:123`, or is a URL. Each added
 * reference is trimmed, non-empty, at most `MAX_REF_CHARS` characters, and on one line; one
 * the task already has is not added again, and removing one it does not have changes
 * nothing. */
export function mergeRefs(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const refs = [...current];
  for (const rawReference of add) {
    const reference = trim(rawReference);
    if (reference === "") throw new InvalidRefs({ kind: "empty" });
    if (/[\n\r]/.test(reference)) throw new InvalidRefs({ kind: "line_break", reference });
    if (charCount(reference) > MAX_REF_CHARS) {
      throw new InvalidRefs({ kind: "too_long", reference });
    }
    if (!refs.includes(reference)) refs.push(reference);
  }
  const removed = new Set(remove.map(trim));
  const kept = refs.filter((existing) => !removed.has(existing));
  if (kept.length > MAX_REFS) throw new InvalidRefs({ kind: "too_many", count: kept.length });
  return kept;
}
