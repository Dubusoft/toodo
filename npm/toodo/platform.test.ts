// @vitest-environment node
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import platform from "./lib/platform.js";

const { platformSuffix } = platform;
const original = {
  platform: Object.getOwnPropertyDescriptor(process, "platform")!,
  arch: Object.getOwnPropertyDescriptor(process, "arch")!,
};

function runOn(os: string, arch: string) {
  Object.defineProperty(process, "platform", { ...original.platform, value: os });
  Object.defineProperty(process, "arch", { ...original.arch, value: arch });
}

function libc(glibcVersionRuntime: string | undefined) {
  vi.spyOn(process.report, "getReport").mockReturnValue({ header: { glibcVersionRuntime } } as never);
}

afterEach(() => {
  Object.defineProperty(process, "platform", original.platform);
  Object.defineProperty(process, "arch", original.arch);
  vi.restoreAllMocks();
});

describe("platformSuffix", () => {
  it("names the macOS package by architecture", () => {
    runOn("darwin", "arm64");
    expect(platformSuffix()).toBe("darwin-arm64");
    runOn("darwin", "x64");
    expect(platformSuffix()).toBe("darwin-x64");
  });

  it("names the glibc and musl Linux packages from the process report", () => {
    runOn("linux", "x64");
    libc("2.39");
    expect(platformSuffix()).toBe("linux-x64");
    runOn("linux", "arm64");
    libc(undefined);
    expect(platformSuffix()).toBe("linux-arm64-musl");
  });

  it("falls back to ldd when the process report fails", () => {
    runOn("linux", "x64");
    vi.spyOn(process.report, "getReport").mockImplementation(() => {
      throw new Error("no report");
    });
    const readFileSync = vi.spyOn(fs, "readFileSync").mockReturnValue("musl libc (x86_64)");
    expect(platformSuffix()).toBe("linux-x64-musl");
    expect(readFileSync).toHaveBeenCalledWith("/usr/bin/ldd", "utf8");
    readFileSync.mockReturnValue("ldd (GNU libc) 2.39");
    expect(platformSuffix()).toBe("linux-x64");
  });

  it("has no package for other systems or architectures", () => {
    for (const [os, arch] of [["win32", "x64"], ["freebsd", "x64"], ["linux", "ia32"], ["darwin", "ppc64"]]) {
      runOn(os, arch);
      expect(platformSuffix(), `${os}/${arch}`).toBeNull();
    }
  });
});
