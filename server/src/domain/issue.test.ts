import { describe, expect, test } from "bun:test";

import { closesIssue, withClosingReference } from "./issue.ts";

describe("issue", () => {
  test("closing keywords before the issue number are recognized in any case", () => {
    for (const body of [
      "Closes #12",
      "closes #12",
      "Fixes #12.",
      "fixed  #12",
      "RESOLVES: #12",
      "Some text\n\nResolved #12\n",
      "Close #12, close #13",
      "close\t#12",
    ]) {
      expect([body, closesIssue(body, 12)]).toEqual([body, true]);
    }
  });

  test("mentions other numbers and unrelated words are not closing references", () => {
    for (const body of [
      "",
      "#12",
      "See #12",
      "Closes #123",
      "Closes #1",
      "Closes#12",
      "Prefixes #12",
      "fixes_ #12",
      "Closes #13\nmentions #12",
    ]) {
      expect([body, closesIssue(body, 12)]).toEqual([body, false]);
    }
  });

  test("the closing reference is appended as its own paragraph", () => {
    expect(withClosingReference("", 12)).toBe("Closes #12");
    expect(withClosingReference(" \n", 12)).toBe("Closes #12");
    expect(withClosingReference("Adds login.\n", 12)).toBe("Adds login.\n\nCloses #12");
    expect(closesIssue(withClosingReference("Adds login.", 12), 12)).toBe(true);
  });
});
