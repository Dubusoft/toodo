// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseArgs, SEMVER } from "./npm-args.mjs";

describe("SEMVER", () => {
  it("accepts releases, prereleases, and build metadata", () => {
    for (const version of ["0.0.0", "1.3.2", "10.20.30", "1.3.2-dev.7", "1.0.0-rc-1", "1.0.0+build.5", "1.0.0-beta.2+sha.abc"]) {
      expect(SEMVER.test(version), version).toBe(true);
    }
  });

  it("rejects partial, prefixed, and leading-zero versions", () => {
    for (const version of ["1.3", "v1.3.2", "01.3.2", "1.03.2", "1.3.2-", "1.3.2-dev..7", "1.3.2+", " 1.3.2", "1.3.2.4", ""]) {
      expect(SEMVER.test(version), version).toBe(false);
    }
  });
});

describe("parseArgs", () => {
  const required = ["--version", "1.0.0", "--web", "dist-web", "--out", "dist-npm"];

  it("reads flag and value pairs and collects every --binaries", () => {
    expect(
      parseArgs([...required, "--binaries", "linux-x64=a", "--binaries", "darwin-arm64=b"]),
    ).toEqual({ version: "1.0.0", web: "dist-web", out: "dist-npm", binaries: ["linux-x64=a", "darwin-arm64=b"] });
  });

  it("rejects an unknown flag, a flag without a value, and missing flags", () => {
    expect(() => parseArgs(["--bogus", "x"])).toThrow('unknown argument "--bogus"');
    expect(() => parseArgs(["--version", "--web", "w"])).toThrow("--version needs a value");
    expect(() => parseArgs([...required, "--binaries"])).toThrow("--binaries needs a value");
    expect(() => parseArgs(["--web", "w", "--out", "o", "--binaries", "b"])).toThrow("missing --version");
    expect(() => parseArgs(required)).toThrow("missing --binaries");
  });
});
