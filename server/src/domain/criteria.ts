// Completion criteria: what has to hold for a task to be done (see `docs/workflow.md`,
// Completion Criteria).
//
// Each criterion is checked by hand (`manual`) or by Toodo (every other kind). Once every
// criterion of a task is met, the task awaits completion; a task whose criteria are all
// automatic is done right away, while one with a manual criterion waits for the user (or an
// agent acting for them) to confirm.

import { debugString, isWhitespace, lines, trim, trimStart } from "./rust.ts";

export type CriterionId = number & { readonly __brand: "CriterionId" };

export function criterionId(id: number): CriterionId {
  return id as CriterionId;
}

/** How a criterion is checked: `manual` by the user in the app or by an agent through MCP,
 * with evidence; `url` when a GET of the target URL succeeds. */
export type CheckKind = "manual" | "url";

export const CHECK_KINDS: readonly CheckKind[] = ["manual", "url"];

/** Whether Toodo checks it on its own. */
export function isAutomatic(kind: CheckKind): boolean {
  return kind !== "manual";
}

/** Whether the criterion needs a URL target. */
export function takesTarget(kind: CheckKind): boolean {
  return kind === "url";
}

/** `pending`: not met yet, or not checked yet. `failed`: the last HTTP check failed;
 * completion checks the URL again. */
export type CriterionState = "pending" | "met" | "failed";

export const CRITERION_STATES: readonly CriterionState[] = ["pending", "met", "failed"];

/** Who checked a criterion last: the user in the app, an agent through MCP, or Toodo's
 * automatic check. */
export type CheckedBy = "user" | "agent" | "toodo";

export const CHECKED_BY: readonly CheckedBy[] = ["user", "agent", "toodo"];

export type Criterion = {
  readonly id: CriterionId;
  /** What has to hold, in words. */
  readonly text: string;
  readonly kind: CheckKind;
  /** The HTTP URL to check for a URL criterion; absent for a manual criterion. */
  readonly target: string | null;
  readonly state: CriterionState;
  /** What showed the last check's result: a link, an output, or the reason it failed. */
  readonly evidence: string | null;
  readonly checkedBy: CheckedBy | null;
  /** Time of the last check that changed the state, in seconds since the Unix epoch. */
  readonly checkedAt: number | null;
};

/** A criterion as its author gives it, before Toodo stores it. */
export type NewCriterion = {
  readonly text: string;
  readonly kind: CheckKind;
  readonly target: string | null;
};

export class InvalidCriterion extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCriterion";
  }
}

/** Checks and normalizes a criterion from its author: a non-blank text, an `http(s)` URL
 * for `url`, and no target for `manual`. */
export function parseNewCriterion(
  rawText: string,
  kind: CheckKind,
  rawTarget: string | null,
): NewCriterion {
  const text = trim(rawText);
  if (text === "") throw new InvalidCriterion("a criterion needs a text");
  const trimmedTarget = rawTarget === null ? null : trim(rawTarget);
  const target = trimmedTarget === "" ? null : trimmedTarget;
  switch (kind) {
    case "url":
      if (target === null || !isHttpUrl(target)) {
        throw new InvalidCriterion(
          `url criterion ${debugString(text)} needs an http:// or https:// URL as its target`,
        );
      }
      break;
    case "manual":
      if (target !== null) {
        throw new InvalidCriterion(`${kind} criterion ${debugString(text)} takes no target`);
      }
      break;
  }
  return { text, kind, target };
}

function isHttpUrl(target: string): boolean {
  return (
    (target.startsWith("https://") || target.startsWith("http://")) &&
    ![...target].some(isWhitespace)
  );
}

/** What the criteria of a task being worked on call for:
 * - `wait`: some criterion is not met, or the task has none, which only a confirmation
 *   completes.
 * - `await_confirmation`: every criterion is met and one of them is manual: the task awaits
 *   completion until someone confirms it.
 * - `complete`: every criterion is met and checked by Toodo: the task is done. */
export type Decision = "wait" | "await_confirmation" | "complete";

export function decide(criteria: readonly Criterion[]): Decision {
  if (criteria.length === 0 || !criteria.every(isMet)) return "wait";
  return criteria.every((criterion) => isAutomatic(criterion.kind))
    ? "complete"
    : "await_confirmation";
}

/** Whether confirming completes the task: every criterion is met, or it has none. */
export function canConfirm(criteria: readonly Criterion[]): boolean {
  return criteria.every(isMet);
}

export function isMet(criterion: Criterion): boolean {
  return criterion.state === "met";
}

/** A `- [ ]` or `- [x]` item of the `Done when` section of a description. */
export type DoneWhenItem = { readonly text: string; readonly checked: boolean };

/** The `- [ ]` and `- [x]` items of the `Done when` section of a Markdown description, with
 * whether each was checked, in order. The section runs from a `Done when` heading of any
 * level to the next heading. */
export function doneWhenItems(description: string): DoneWhenItem[] {
  const items: DoneWhenItem[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of lines(description)) {
    const trimmed = trim(line);
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = headingText(trimmed);
    if (heading !== null) {
      inSection = isDoneWhen(heading);
      continue;
    }
    if (!inSection) continue;
    const item = checkbox(trimmed);
    if (item !== null) items.push(item);
  }
  return items;
}

/** `Done when`, in any ASCII letter case, after dropping trailing colons. */
function isDoneWhen(heading: string): boolean {
  return trim(heading.replace(/:+$/, "")).replace(/[A-Z]/g, (c) => c.toLowerCase()) === "done when";
}

/** The text of an ATX heading (`#` to `######` followed by a space). */
function headingText(line: string): string | null {
  const hashes = /^#*/.exec(line)?.[0].length ?? 0;
  if (hashes < 1 || hashes > 6) return null;
  const rest = line.slice(hashes);
  if (rest === "") return "";
  return rest.startsWith(" ") || rest.startsWith("\t") ? trim(rest.slice(1)) : null;
}

/** A task list item: `-`, `*`, or `+`, a space, `[ ]` or `[x]`, and a non-blank text. */
function checkbox(line: string): DoneWhenItem | null {
  const marker = line[0];
  if (marker !== "-" && marker !== "*" && marker !== "+") return null;
  const separator = line[1];
  if (separator !== " " && separator !== "\t") return null;
  const rest = trimStart(line.slice(2));
  let checked: boolean;
  if (rest.startsWith("[ ]")) {
    checked = false;
  } else if (rest.startsWith("[x]") || rest.startsWith("[X]")) {
    checked = true;
  } else {
    return null;
  }
  const text = trim(rest.slice(3));
  return text === "" ? null : { text, checked };
}
