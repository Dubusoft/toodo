// Closing references to a task's GitHub issue in pull request bodies. GitHub closes the
// issue when a pull request whose body says e.g. `Closes #12` is merged into the default
// branch.

import { asciiLowercase, isAlphanumeric, trimEnd } from "./rust.ts";

/** Keywords GitHub accepts before an issue reference to close it on merge. */
const CLOSING_KEYWORDS: readonly string[] = [
  "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
];

/** Whether `body` already has a closing reference to issue `number`, such as `Fixes #12` or
 * `resolves: #12`, in any letter case. */
export function closesIssue(rawBody: string, number: number): boolean {
  const body = asciiLowercase(rawBody);
  const reference = `#${number}`;
  for (
    let start = body.indexOf(reference);
    start !== -1;
    start = body.indexOf(reference, start + reference.length)
  ) {
    const next = body[start + reference.length];
    if (next !== undefined && next >= "0" && next <= "9") continue;
    if (followsClosingKeyword(body.slice(0, start))) return true;
  }
  return false;
}

/** Whether `before`, the text in front of an issue reference, ends with a closing keyword,
 * an optional colon, and at least one space. */
function followsClosingKeyword(before: string): boolean {
  const withoutSpace = before.replace(/[ \t]+$/, "");
  if (withoutSpace.length === before.length) return false;
  const word = withoutSpace.endsWith(":") ? withoutSpace.slice(0, -1) : withoutSpace;
  return CLOSING_KEYWORDS.some((keyword) => {
    if (!word.endsWith(keyword)) return false;
    const previous = [...word.slice(0, word.length - keyword.length)].pop();
    return previous === undefined || !(isAlphanumeric(previous) || previous === "_");
  });
}

/** `body` with a closing reference to issue `number` on its own last paragraph. */
export function withClosingReference(body: string, number: number): string {
  const trimmed = trimEnd(body);
  return trimmed === "" ? `Closes #${number}` : `${trimmed}\n\nCloses #${number}`;
}
