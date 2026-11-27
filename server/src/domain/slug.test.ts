import { describe, expect, test } from "bun:test";

import { slugify } from "./slug.ts";

describe("slug", () => {
  test("words are lowercased and joined with single hyphens", () => {
    expect(slugify("Add  Login -- Page!", "task")).toBe("add-login-page");
    expect(slugify("  --leading and trailing--  ", "task")).toBe("leading-and-trailing");
  });

  test("windows invalid characters and trailing dots are removed", () => {
    expect(slugify('a<b>c:d"e/f\\g|h?i*j', "task")).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(slugify("release. . .", "task")).toBe("release");
  });

  test("git ref hazards are removed", () => {
    expect(slugify("..", "task")).toBe("task");
    expect(slugify("config.lock", "task")).toBe("config-lock");
    expect(slugify("main@{1}", "task")).toBe("main-1");
    expect(slugify("a..b~c^d:e", "task")).toBe("a-b-c-d-e");
  });

  test("empty and non ascii inputs fall back", () => {
    expect(slugify("", "task")).toBe("task");
    expect(slugify("\uB85C\uADF8\uC778 \uD398\uC774\uC9C0", "task")).toBe("task");
    expect(slugify("\uB85C\uADF8\uC778 API \uCD94\uAC00", "task")).toBe("api");
  });

  test("windows reserved names get a suffix", () => {
    expect(slugify("CON", "workspace")).toBe("con-workspace");
    expect(slugify("lpt9.", "task")).toBe("lpt9-task");
    expect(slugify("console", "task")).toBe("console");
  });

  test("long inputs are truncated without a trailing hyphen", () => {
    expect(slugify(`${"a".repeat(47)} tail`, "task")).toBe("a".repeat(47));
    expect(slugify("b".repeat(100), "task")).toHaveLength(48);
  });
});
