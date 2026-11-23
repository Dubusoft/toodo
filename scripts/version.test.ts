// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nextVersion, replaceVersion, usage } from "./version.mjs";

describe("nextVersion", () => {
  it("bumps each part and resets the ones after it", () => {
    expect(nextVersion("1.11.3", "major")).toBe("2.0.0");
    expect(nextVersion("1.11.3", "minor")).toBe("1.12.0");
    expect(nextVersion("1.11.3", "patch")).toBe("1.11.4");
    expect(nextVersion("0.9.9", "patch")).toBe("0.9.10");
  });

  it("takes an explicit X.Y.Z as is", () => {
    expect(nextVersion("1.11.3", "3.0.1")).toBe("3.0.1");
  });

  it("rejects a request that is neither a part nor X.Y.Z", () => {
    for (const request of ["Major", "1.2", "1.2.3-dev.1", "v1.2.3", ""]) {
      expect(() => nextVersion("1.11.3", request)).toThrow(usage);
    }
  });

  it("rejects a current version that is not X.Y.Z", () => {
    expect(() => nextVersion("1.11.3-dev.1", "patch")).toThrow("Current version 1.11.3-dev.1 is not X.Y.Z");
  });
});

describe("replaceVersion", () => {
  const lock = { path: "package-lock.json", pattern: /("version": ")([^"]+)(")/, count: 2 };

  it("replaces exactly the counted occurrences, keeping the rest of the text", () => {
    const text = '{\r\n  "version": "1.0.0",\r\n  "packages": { "": { "version": "1.0.0" } },\r\n  "dep": { "version": "1.0.0" }\r\n}';
    expect(replaceVersion(text, lock, "1.0.0", "1.1.0")).toBe(
      '{\r\n  "version": "1.1.0",\r\n  "packages": { "": { "version": "1.1.0" } },\r\n  "dep": { "version": "1.0.0" }\r\n}',
    );
  });

  it("names the occurrence that is missing or holds another version", () => {
    expect(() => replaceVersion('"version": "1.0.0"', lock, "1.0.0", "1.1.0")).toThrow(
      "package-lock.json: expected version 1.0.0 (occurrence 2 of 2)",
    );
    expect(() => replaceVersion('"version": "0.9.0" "version": "1.0.0"', lock, "1.0.0", "1.1.0")).toThrow(
      "package-lock.json: expected version 1.0.0 (occurrence 1 of 2)",
    );
  });
});
