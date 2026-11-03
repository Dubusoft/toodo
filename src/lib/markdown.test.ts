import { describe, expect, it } from "vitest";

import { firstParagraph, markdownPreview } from "./markdown";

describe("firstParagraph", () => {
  it("previews the paragraph under the first heading without the headings", () => {
    expect(
      firstParagraph("## Purpose\nMake the timeline\n**readable** on phones.\n\n## Background\nThe bars overlap."),
    ).toBe("Make the timeline readable on phones.");
  });

  it("skips fenced code and rules before the first paragraph", () => {
    expect(firstParagraph("```sh\nnpm test\n```\n---\n- [ ] first step\n- [ ] second step\n\nLater text")).toBe(
      "first step second step",
    );
  });

  it("is empty when the description has only headings", () => {
    expect(firstParagraph("# Title\n\n## Done when\n")).toBe("");
  });
});

describe("markdownPreview", () => {
  it("drops block syntax and joins the lines", () => {
    expect(markdownPreview("## Heading\n\n- [x] done\n1. next\n> quoted\n\n```ts\ncode\n```\n---")).toBe(
      "Heading done next quoted code",
    );
  });

  it("keeps the text of inline syntax", () => {
    expect(
      markdownPreview("Use **bold**, *em*, `code`, ~~old~~, [docs](https://example.com) and ![logo](a.png)"),
    ).toBe("Use bold, em, code, old, docs and logo");
  });

  it("leaves underscores inside words and table cells readable", () => {
    expect(markdownPreview("| a | b |\n| --- | --- |\n| task_id | 2 * 3 |")).toBe("a b task_id 2 * 3");
  });

  it("keeps unpaired markers and link targets with parentheses intact", () => {
    expect(markdownPreview("[bad](javascript:alert(1)) sets window.__pwned and 2*3")).toBe(
      "bad sets window.__pwned and 2*3",
    );
  });

  it("is empty for an empty description", () => {
    expect(markdownPreview("")).toBe("");
    expect(markdownPreview("\n```\n```\n")).toBe("");
  });
});
