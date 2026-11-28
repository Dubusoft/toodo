import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as quota from "../src/claude-quota.ts";
import * as memoryCheck from "../src/memory-check.ts";
import { supervise, WATCHDOG_STALL_MS } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, manualPause, newWorld, withState } from "./fakes.ts";

/** The local runner child supervise() starts: here one that runs nothing and exits when killed. */
const idleRunner = () => {
  let exit = (_code: number) => {};
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  return { pid: 4242, exited, kill: () => { exit(0); } };
};


const cleanups: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const T0 = 1_800_000_000_000;
const STALL_MS = 120_000;
const MESSAGE = 42;

/** Resolves once `check` holds, re-checked on each `subscribe` signal; rejects after `ms`. */
const until = (subscribe: (signal: () => void) => () => void, check: () => boolean, ms: number, what: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); reject(new Error(`timed out after ${ms} ms waiting for ${what}`)); }, ms);
    const signal = () => { if (check()) { clearTimeout(timer); stop(); resolve(); } };
    stop = subscribe(signal);
    signal();
  });

const setup = () => {
  const state = withState();
  cleanups.push(state.done);
  const home = process.env.HOME;
  const socket = process.env.NOTIFY_SOCKET;
  process.env.HOME = state.dir;
  delete process.env.NOTIFY_SOCKET;
  cleanups.push(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (socket === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = socket;
  });
  const errors: string[] = [];
  const errorListeners = new Set<() => void>();
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); for (const listener of errorListeners) listener(); };
  cleanups.push(() => { console.error = error; });
  spyOn(quota, "lookupQuotaResults").mockReturnValue(async () => ({ results: [], text: "" }));
  const clock = fakeClock(T0);
  const world = newWorld();
  world.panes.push({ pane_id: "hc:t1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const tokenFile = join(state.dir, "mcp-token");
  writeFileSync(tokenFile, "test-token\n");
  const deps = depsFor(world, clock, state.dir, { toodoWriter: { url: "http://127.0.0.1:47616", tokenFile }, defaultModel: "test/model" });
  // The memory sweep (only the sweeps task runs it) hangs for STALL_MS: the injected sweep stall.
  const stall: { at?: number; release: () => void } = { release: () => {} };
  const stallListeners = new Set<() => void>();
  let ownerPosted = false;
  let taken = false;
  const takeListeners = new Set<() => void>();

  spyOn(memoryCheck, "memorySweep").mockImplementation(() => new Promise<string[]>((resolve) => {
    const timer = setTimeout(() => { stall.release(); }, STALL_MS);
    stall.release = () => { clearTimeout(timer); resolve([]); };
    stall.at = performance.now();
    // The owner writes while the sweep is stuck; the Toodo safety poll is due again on the next pass.
    ownerPosted = true;
    for (const listener of stallListeners) listener();
  }));
  cleanups.push(() => { stall.release(); });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: unknown, init?: RequestInit) => {
    const rpc = JSON.parse(String(init?.body));
    if (ownerPosted && rpc.params?.name === "take_pending") {
      taken = true;
      for (const listener of takeListeners) listener();
    }
    const messages = ownerPosted && ["peek_pending", "take_pending"].includes(rpc.params?.name)
      ? [{ id: MESSAGE, channelId: 1, author: "user", body: "status?", attachments: [] }] : [];
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(messages) }] } });
  }, { preconnect: fetch.preconnect }));
  const notified: string[] = [];
  // Each task's next pass waits for the test, not for real time.
  const pauses = manualPause();
  const parkListeners = new Set<() => void>();
  const pause = (ms: number, signal: AbortSignal) => { const parked = pauses.pause(ms, signal); for (const listener of parkListeners) listener(); return parked; };
  const controller = new AbortController();
  const running = supervise(deps, controller.signal, { spawnRunner: idleRunner }, async (s) => { notified.push(s); return true; }, undefined, pause);
  const log = join(state.dir, "lead-events.log");
  const delivered = () => existsSync(log) && readFileSync(log, "utf8").split("\n").some((line) => line.includes(`"line":"INBOUND toodo:channel/1 ${MESSAGE} owner status?`));
  const onLog = (signal: () => void) => { const watcher = watch(state.dir, signal); return () => { watcher.close(); }; };
  const onError = (signal: () => void) => { errorListeners.add(signal); return () => { errorListeners.delete(signal); }; };
  const onStall = (signal: () => void) => { stallListeners.add(signal); return () => { stallListeners.delete(signal); }; };
  const onTake = (signal: () => void) => { takeListeners.add(signal); return () => { takeListeners.delete(signal); }; };
  const onPark = (signal: () => void) => { parkListeners.add(signal); return () => { parkListeners.delete(signal); }; };
  // Once the five working tasks, the runners, autopilot and status panel tasks (the hub always opens) and the stall check are parked (the sweeps task is stuck), each takes its next pass.
  const next = async () => {
    await until(onPark, () => pauses.parked() === 9, 10_000, "the five working tasks, the runners, autopilot and status panel tasks and the stall check parked");
    pauses.tick();
  };
  const stop = async () => { controller.abort(); stall.release(); await running; };
  return { clock, errors, notified, stall, delivered, onLog, onError, onStall, onTake, taken: () => taken, stop, next };
};

test("an injected 120 s sweep stall still delivers an owner INBOUND to the lead in under 10 s, and the stuck sweep withholds the watchdog", async () => {
  // Given the real supervise() whose machine-guard sweep hangs for 120 s, and an owner message posted once it hangs.
  const s = setup();
  try {
    await until(s.onStall, () => s.stall.at !== undefined, 10_000, "the sweep stall");
    // When the other tasks keep running beside the stuck sweep.
    s.clock.at += 60_000;
    await s.next();
    await until(s.onTake, s.taken, 10_000, "Toodo take_pending after the owner message was journaled");
    s.clock.at += 5_000;
    await s.next();
    await until(s.onLog, s.delivered, 10_000, "INBOUND in lead-events.log");
    // Then the owner's INBOUND reached the lead's delivery log well before the stall ends.
    expect(performance.now() - (s.stall.at ?? 0)).toBeLessThan(10_000);
    // And once the sweep has been stuck past the stall budget, the watchdog names its task even though the others keep turning.
    s.clock.at += WATCHDOG_STALL_MS;
    const petted = s.notified.length;
    await s.next();
    await until(s.onError, () => s.errors.some((line) => line.startsWith("WATCHDOG_WITHHELD task:sweeps ")), 10_000, "WATCHDOG_WITHHELD task:sweeps");
    expect(s.notified.slice(petted)).not.toContain("WATCHDOG=1");
  } finally {
    await s.stop();
  }
}, 30_000);
