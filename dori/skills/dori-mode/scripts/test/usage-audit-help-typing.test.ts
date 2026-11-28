import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

const cli = async (home: string, args: string[]) => {
  const preload = join(home, "fake-fetch.js");
  writeFileSync(preload, 'globalThis.fetch = async (u) => { console.log("FAKE_CALL " + u); return new Response(JSON.stringify({}), { status: 200 }); };');
  const child = Bun.spawn(["bun", "--preload", preload, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      DORI_CONFIG: join(home, "missing.json"),
      DORI_STATE_DIR: join(home, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

const inState = async (fn: (dir: string) => Promise<void>) => {
  const state = withState();
  try { await fn(state.dir); } finally { state.done(); }
};

for (const flag of ["--help", "-h"]) {
  test(`dori launch ${flag} prints only launch usage and exits successfully`, () => inState(async (dir) => {
    const r = await cli(dir, ["launch", flag]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  launch <key>");
    expect(r.out).toContain("                [--mode ulw|mass-ulw]");
    expect(r.out).not.toContain("  adopt ");
    expect(r.err).toBe("");
  }));
}

test("dori typing takes only a Toodo chat ref and calls nothing for a Discord channel", () => inState(async (dir) => {
  for (const args of [["typing", "123"], ["typing", "discord", "123"]]) {
    const r = await cli(dir, args);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/usage: dori typing REF \[--off\]|bad Toodo chat ref "123"/);
    expect(r.out).not.toContain("FAKE_CALL");
  }
}));

test("dori setup --help prints setup-specific help and exits successfully", () => inState(async (dir) => {
  const r = await cli(dir, ["setup", "--help"]);
  expect(r.code).toBe(0);
  expect(r.out).toStartWith("dori setup [options]");
  expect(r.out).toContain("--advanced");
  expect(r.err).toBe("");
}));
