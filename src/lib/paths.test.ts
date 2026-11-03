import { describe, expect, it } from "vitest";
import { normalizePath, shortPath } from "@/lib/paths";

describe("normalizePath", () => {
  it("resolves dot segments and repeated separators in POSIX paths", () => {
    expect(normalizePath("/data/repos/../wt//a/./b/")).toBe("/data/wt/a/b");
    expect(normalizePath("/../x")).toBe("/x");
    expect(normalizePath("a/../../b")).toBe("../b");
  });

  it("keeps the drive or share of Windows paths", () => {
    expect(normalizePath("C:\\dev\\..\\wt\\toodo\\")).toBe("C:\\wt\\toodo");
    expect(normalizePath("D:/wt/../x")).toBe("D:\\x");
    expect(normalizePath("C:\\..\\x")).toBe("C:\\x");
    expect(normalizePath("\\\\server\\share\\a\\..\\b")).toBe("\\\\server\\share\\b");
  });
});

describe("shortPath", () => {
  it("keeps the last two folders after an ellipsis", () => {
    expect(shortPath("/data/repos/worktrees/toodo/../toodo")).toBe("…/worktrees/toodo");
    expect(shortPath("D:\\wt\\toodo\\feat-add-login-1")).toBe("…\\toodo\\feat-add-login-1");
  });

  it("returns short paths whole", () => {
    expect(shortPath("/srv/toodo")).toBe("/srv/toodo");
    expect(shortPath("C:\\toodo")).toBe("C:\\toodo");
  });
});
