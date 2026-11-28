import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

const cli = async (home: string, args: string[], env: Record<string, string> = {}) => {
  const preload = join(home, "fake-fetch.js");
  writeFileSync(preload, 'globalThis.fetch = async (u) => { console.log("FAKE_CALL " + u); return new Response(JSON.stringify({ id: "9" }), { status: 200 }); };');
  const child = Bun.spawn(["bun", "--preload", preload, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, DORI_CONFIG: join(home, "missing.json"), DORI_STATE_DIR: join(home, "state"), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

const inState = async (fn: (dir: string) => Promise<void>) => {
  const state = withState();
  try { await fn(state.dir); } finally { state.done(); }
};

for (const command of [["send", "slack", "--to", "toodo", "--text", "x"], ["send", "discord", "--to", "toodo", "--text", "x"]]) {
  test(`dori send ${command[1]} refuses an unknown platform and calls nothing`, () => inState(async (dir) => {
    const r = await cli(dir, command);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`unknown platform ${command[1]}`);
    expect(r.out).not.toContain("FAKE_CALL");
  }));
}

for (const target of ["123", "discord:123/456"]) {
  test(`dori send refuses ${target}, which is no Toodo chat ref, and calls nothing`, () => inState(async (dir) => {
    const r = await cli(dir, ["send", "--to", target, "--text", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`SEND_NOT_POSTED --to ${target}`);
    expect(r.out).not.toContain("FAKE_CALL");
  }));
}
