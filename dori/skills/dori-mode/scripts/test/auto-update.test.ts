import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventClass } from "../src/event-policy.ts";
import type { Ran, Runner } from "../src/run.ts";
import {
  AUTO_UPDATE_RESULT, AUTO_UPDATE_UNIT, AutoUpdate, noteDevMerge, readAutoUpdateState, writeUpdateResult,
} from "../src/auto-update.ts";

let dir = "";
let calls: string[][] = [];
let unit = "inactive";
let startCode = 0;
let events: [string, string][] = [];
let now = 1_000;

const runner: Runner = async (argv): Promise<Ran> => {
  calls.push([...argv]);
  if (argv[0] === "systemctl") return { code: unit === "active" ? 0 : 3, out: unit, err: "" };
  if (argv[0] === "systemd-run") {
    if (startCode === 0) unit = "active";
    return { code: startCode, out: "", err: startCode ? "Failed to connect to bus" : "" };
  }
  throw new Error(`unexpected ${argv.join(" ")}`);
};
const starts = (): string[][] => calls.filter((c) => c[0] === "systemd-run");
const emit = async (line: string, id: string): Promise<void> => { events.push([id, line]); };
const auto = (env: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/u" }): AutoUpdate => new AutoUpdate({
  stateDir: dir, run: runner, now: () => now, env, log: () => {},
  command: ["/bin/bun", "/dori/src/cli.ts", "update", "--dev"],
});
/** The unit finished: it wrote its result and exited. */
const finish = (code: number, lines: string[]): void => {
  writeUpdateResult(join(dir, AUTO_UPDATE_RESULT), { at: ++now, code, lines });
  unit = "inactive";
};

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dori-auto-update-"));
  calls = []; unit = "inactive"; startCode = 0; events = []; now = 1_000;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("the supervisor's GitHub tokens reach the update unit by name, never by value", async () => {
  noteDevMerge(dir, "Dubusoft/dori-mode#7");
  await auto({ PATH: "/usr/bin", HOME: "/home/u", GH_TOKEN: "gho_secret", GITHUB_TOKEN: "" }).tick(emit);
  expect(starts()).toEqual([[
    "systemd-run", "--user", "--unit", AUTO_UPDATE_UNIT, "--collect", "--quiet", "--setenv=PATH=/usr/bin", "--setenv=HOME=/home/u", "--setenv=GH_TOKEN",
    "--", "/bin/bun", "/dori/src/cli.ts", "update", "--dev", "--result", join(dir, AUTO_UPDATE_RESULT),
  ]]);
});

test("a dev merge starts one detached update unit on the next tick; exit 0 is a digest AUTO_UPDATE_DONE", async () => {
  const a = auto();
  await a.tick(emit);
  expect(starts()).toEqual([]);
  noteDevMerge(dir, "Dubusoft/dori-mode#5");
  await a.tick(emit);
  expect(starts()).toEqual([[
    "systemd-run", "--user", "--unit", AUTO_UPDATE_UNIT, "--collect", "--quiet", "--setenv=PATH=/usr/bin", "--setenv=HOME=/home/u",
    "--", "/bin/bun", "/dori/src/cli.ts", "update", "--dev", "--result", join(dir, AUTO_UPDATE_RESULT),
  ]]);
  // Still running: nothing is started again or reported.
  await a.tick(emit);
  expect(starts()).toHaveLength(1);
  expect(events).toEqual([]);
  finish(0, ["UPDATED dev 1111111..2222222 supervisor=active", "UPDATE_SUMMARY changed: checkout 1111111..2222222, supervisor restarted; failed: none"]);
  // A restarted supervisor (a new instance) reports the result.
  await auto().tick(emit);
  expect(events.map(([, l]) => l)).toEqual(["AUTO_UPDATE_DONE after Dubusoft/dori-mode#5: UPDATED dev 1111111..2222222 supervisor=active; UPDATE_SUMMARY changed: checkout 1111111..2222222, supervisor restarted; failed: none"]);
  expect(eventClass(events[0]![1])).toBe("lead-digest");
  expect(existsSync(join(dir, AUTO_UPDATE_RESULT))).toBe(false);
  expect(readAutoUpdateState(dir)).toEqual({ pending: [] });
  await auto().tick(emit);
  expect(events).toHaveLength(1);
  expect(starts()).toHaveLength(1);
});

test("a failed update wakes the lead with its stop line", async () => {
  noteDevMerge(dir, "Dubusoft/dori-mode#5");
  await auto().tick(emit);
  finish(1, ["UPDATE_STASH_CONFLICT local changes did not reapply on dev; the stash is kept as abc; resolve in /dori; supervisor not restarted"]);
  await auto().tick(emit);
  expect(events).toHaveLength(1);
  expect(events[0]![1]).toStartWith("AUTO_UPDATE_FAILED exit 1 after Dubusoft/dori-mode#5: UPDATE_STASH_CONFLICT local changes did not reapply");
  expect(eventClass(events[0]![1])).toBe("lead-urgent");
});

test("an update a step degraded (exit 2) wakes the lead with its summary", async () => {
  noteDevMerge(dir, "Dubusoft/dori-mode#5");
  await auto().tick(emit);
  finish(2, ["UPDATED dev 1111111..2222222 supervisor=active", "UPDATE_SUMMARY changed: supervisor restarted; failed: runners exit 1"]);
  await auto().tick(emit);
  expect(events[0]![1]).toStartWith("AUTO_UPDATE_FAILED exit 2 after Dubusoft/dori-mode#5: UPDATE_SUMMARY changed: supervisor restarted; failed: runners exit 1");
  expect(eventClass(events[0]![1])).toBe("lead-urgent");
});

test("merges noted before a tick run once together", async () => {
  const a = auto();
  noteDevMerge(dir, "Dubusoft/dori-mode#5");
  noteDevMerge(dir, "Dubusoft/dori-mode#6");
  noteDevMerge(dir, "Dubusoft/dori-mode#6");
  await a.tick(emit);
  await a.tick(emit);
  expect(starts()).toHaveLength(1);
  finish(0, ["UP_TO_DATE dev 2222222", "UPDATE_SUMMARY changed: none; failed: none"]);
  await a.tick(emit);
  expect(events.map(([, l]) => l)).toEqual(["AUTO_UPDATE_DONE after Dubusoft/dori-mode#5, Dubusoft/dori-mode#6: UP_TO_DATE dev 2222222; UPDATE_SUMMARY changed: none; failed: none"]);
  expect(starts()).toHaveLength(1);
});

test("a merge noted while the update runs gets its own run after it", async () => {
  const a = auto();
  noteDevMerge(dir, "Dubusoft/dori-mode#5");
  await a.tick(emit);
  noteDevMerge(dir, "Dubusoft/dori-mode#6");
  await a.tick(emit);
  expect(starts()).toHaveLength(1);
  finish(0, ["UP_TO_DATE dev 2222222"]);
  await a.tick(emit);
  expect(events.map(([, l]) => l)).toEqual(["AUTO_UPDATE_DONE after Dubusoft/dori-mode#5: UP_TO_DATE dev 2222222"]);
  expect(starts()).toHaveLength(2);
  expect(readAutoUpdateState(dir).running?.merges).toEqual(["Dubusoft/dori-mode#6"]);
});

test("a unit that ended without a result, or could not start, wakes the lead", async () => {
  noteDevMerge(dir, "Dubusoft/dori-mode#5");
  await auto().tick(emit);
  unit = "failed";
  await auto().tick(emit);
  expect(events.map(([, l]) => l)).toEqual([`AUTO_UPDATE_FAILED after Dubusoft/dori-mode#5: unit ${AUTO_UPDATE_UNIT} ended without a result; log: journalctl --user -u ${AUTO_UPDATE_UNIT}; run dori update --dev by hand`]);
  expect(eventClass(events[0]![1])).toBe("lead-urgent");
  startCode = 1;
  noteDevMerge(dir, "Dubusoft/dori-mode#6");
  await auto().tick(emit);
  expect(events[1]![1]).toBe("AUTO_UPDATE_FAILED after Dubusoft/dori-mode#6: systemd-run exit 1: Failed to connect to bus; run dori update --dev by hand");
  expect(readAutoUpdateState(dir)).toEqual({ pending: [] });
});

test("a corrupt result is moved aside and its run ends as AUTO_UPDATE_FAILED instead of failing every tick", async () => {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  try {
    noteDevMerge(dir, "Dubusoft/dori-mode#5");
    await auto().tick(emit);
    writeFileSync(join(dir, AUTO_UPDATE_RESULT), '{"at":');
    unit = "failed";
    await auto().tick(emit);
    await auto().tick(emit);
    expect(events.map(([, l]) => l)).toEqual([`AUTO_UPDATE_FAILED after Dubusoft/dori-mode#5: unit ${AUTO_UPDATE_UNIT} ended without a result; log: journalctl --user -u ${AUTO_UPDATE_UNIT}; run dori update --dev by hand`]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith(`AUTO_UPDATE_RESULT_CORRUPT moved ${join(dir, AUTO_UPDATE_RESULT)} to `);
    expect(existsSync(join(dir, AUTO_UPDATE_RESULT))).toBe(false);
  } finally { spy.mockRestore(); }
});

test("a state file left by an older supervisor with lanes recorded as blockers still starts the pending update", async () => {
  writeFileSync(join(dir, "auto-update.json"), JSON.stringify({ pending: ["Dubusoft/dori-mode#5"], blocked: { "lane-a": { since: 1, escalated: true } } }));
  await auto().tick(emit);
  expect(starts()).toHaveLength(1);
  expect(readAutoUpdateState(dir)).toEqual({ pending: [], running: { at: 1_000, merges: ["Dubusoft/dori-mode#5"] } });
});
