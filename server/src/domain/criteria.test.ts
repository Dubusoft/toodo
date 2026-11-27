import { describe, expect, test } from "bun:test";

import {
  type CheckKind,
  type Criterion,
  type CriterionState,
  InvalidCriterion,
  canConfirm,
  criterionId,
  decide,
  doneWhenItems,
  parseNewCriterion,
} from "./criteria.ts";

function criterion(kind: CheckKind, state: CriterionState): Criterion {
  return {
    id: criterionId(1),
    text: "x",
    kind,
    target: null,
    state,
    evidence: null,
    checkedBy: null,
    checkedAt: null,
  };
}

describe("criteria", () => {
  test("all met automatic criteria complete and a manual one needs confirmation", () => {
    expect(decide([])).toBe("wait");
    expect(decide([criterion("url", "met"), criterion("url", "met")])).toBe("complete");
    expect(decide([criterion("url", "met"), criterion("manual", "met")])).toBe(
      "await_confirmation",
    );
    expect(decide([criterion("url", "met"), criterion("manual", "pending")])).toBe("wait");
    expect(decide([criterion("url", "failed")])).toBe("wait");
    expect(canConfirm([])).toBe(true);
    expect(canConfirm([criterion("manual", "met")])).toBe(true);
    expect(canConfirm([criterion("manual", "met"), criterion("url", "failed")])).toBe(false);
  });

  test("new criteria need a text and a target only where one is checked", () => {
    const parse = (kind: CheckKind, target: string | null) =>
      parseNewCriterion(" Works ", kind, target);
    expect(parse("url", " https://example.com/health ")).toEqual({
      text: "Works",
      kind: "url",
      target: "https://example.com/health",
    });
    expect(parse("manual", "  ").target).toBeNull();
    const rejected: readonly (readonly [CheckKind, string | null])[] = [
      ["url", null],
      ["url", "ftp://example.com"],
      ["url", "https://exa mple.com"],
      ["manual", "x"],
    ];
    for (const [kind, target] of rejected) {
      expect(() => parse(kind, target)).toThrow(InvalidCriterion);
    }
    expect(() => parseNewCriterion(" ", "manual", null)).toThrow(InvalidCriterion);
  });

  test("done when items come from that section only", () => {
    const description =
      "## Purpose\n- [ ] not a criterion\n\n## Done when\n" +
      "- [ ] Tests pass\n  - [x] Docs `updated`\n* [X] Reviewed\n- plain item\n" +
      "```\n- [ ] in a fence\n```\n- [ ]   \n### Done when:\n+ [ ] Deployed\n" +
      "## Notes\n- [ ] later\n";
    expect(doneWhenItems(description)).toEqual([
      { text: "Tests pass", checked: false },
      { text: "Docs `updated`", checked: true },
      { text: "Reviewed", checked: true },
      { text: "Deployed", checked: false },
    ]);
    expect(doneWhenItems("Done when\n- [ ] no heading")).toEqual([]);
    expect(doneWhenItems("#Done when\n- [ ] not a heading")).toEqual([]);
  });
});
