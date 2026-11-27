import { expect, test } from "bun:test";
import { type EventStream, HC_EVENTS_ARGV, HC_EVENTS_RETRY_MIN_MS, HC_EVENTS_SILENT_MS, watchHcEvents } from "../src/runtime/hc-events.ts";

/**
 * A scripted `hc events`: the test pushes its lines and ends it; `kill` ends it like a killed process. `idle()` holds
 * while the reader waits on an empty queue, so every pushed line has been handled (`onIdle` says when).
 */
const scriptedStream = (onIdle: () => void) => {
  const queue: (string | null)[] = [];
  let wake: (() => void) | undefined;
  let exit: (code: number) => void = () => {};
  let killed = false;
  let idle = false;
  const push = (line: string | null): void => { queue.push(line); idle = false; wake?.(); };
  async function* lines(): AsyncIterable<string> {
    for (;;) {
      while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; idle = true; onIdle(); });
      const line = queue.shift();
      if (line === null || line === undefined) return;
      yield line;
    }
  }
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  const stream: EventStream = { lines: lines(), exited, kill: () => { killed = true; push(null); exit(143); } };
  return { stream, push, end: (code: number) => { push(null); exit(code); }, killed: () => killed, idle: () => idle };
};

const snapshot = (seq: number): string => JSON.stringify({ channel: null, seq, terminals: [] });
const event = (seq: number, type: string): string => JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq, terminal: "t1", type, data: {} } });

/** A watch on scripted streams, its waits and silence checks driven by the test; `until(test)` resolves once `test` holds. */
const harness = () => {
  const streams: ReturnType<typeof scriptedStream>[] = [];
  const spawned: (readonly string[])[] = [];
  const sleeps: { readonly ms: number; readonly resolve: () => void }[] = [];
  const checks: (() => void)[] = [];
  const clock = { at: 0 };
  let changes = 0;
  const waiters: { readonly test: () => boolean; readonly resolve: () => void }[] = [];
  const log: string[] = [];
  const settle = (): void => { for (const w of [...waiters]) if (w.test()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };
  const until = (test: () => boolean): Promise<void> => new Promise<void>((resolve) => { waiters.push({ test, resolve }); settle(); });
  const watch = watchHcEvents({
    spawn: (argv) => { spawned.push(argv); const s = scriptedStream(settle); streams.push(s); settle(); return s.stream; },
    now: () => clock.at,
    sleep: (ms) => new Promise<void>((resolve) => { sleeps.push({ ms, resolve }); settle(); }),
    every: (_ms, tick) => { checks.push(tick); return () => { checks.splice(checks.indexOf(tick), 1); }; },
    log: (line) => { log.push(line); settle(); },
  }, () => { changes++; settle(); });
  return { watch, streams, spawned, sleeps, checks, clock, log, until, changes: () => changes };
};

test("watchHcEvents calls onChange for the snapshot and state events only, and skips events the snapshot already holds", async () => {
  const h = harness();
  await h.until(() => h.streams.length === 1);
  expect(h.spawned).toEqual([HC_EVENTS_ARGV]);
  const s = h.streams[0]!;
  expect(h.watch.live()).toBe(false);
  const handled = async (): Promise<number> => { await h.until(() => s.idle()); return h.changes(); };
  s.push(snapshot(10));
  expect(await handled()).toBe(1);
  expect(h.watch.live()).toBe(true);
  s.push(event(9, "status"));
  s.push(event(12, "title"));
  s.push(JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 12 } }));
  s.push("not json");
  s.push(event(13, "status"));
  expect(await handled()).toBe(2);
  for (const type of ["created", "lost", "restarted", "finished", "removed", "turn", "foreground"]) s.push(event(20, type));
  expect(await handled()).toBe(9);
  // A subscriber that fell behind gets missed and a fresh snapshot; events it already holds are skipped again.
  s.push(JSON.stringify({ jsonrpc: "2.0", method: "missed", params: {} }));
  s.push(snapshot(40));
  s.push(event(35, "status"));
  s.push(event(41, "turn"));
  expect(await handled()).toBe(11);
  expect(h.log.filter((l) => l.startsWith("HC_EVENTS_MISSED"))).toHaveLength(1);
  h.watch.stop();
  expect(s.killed()).toBe(true);
});

test("watchHcEvents subscribes again after hc exits, backing off while it keeps failing, and the new snapshot resyncs", async () => {
  const h = harness();
  await h.until(() => h.streams.length === 1);
  h.streams[0]!.push(snapshot(1));
  await h.until(() => h.changes() === 1);
  h.streams[0]!.end(1);
  // The live subscription ended: not live, one read for what changed meanwhile, then a retry after the minimum wait.
  await h.until(() => h.sleeps.length === 1);
  expect(h.watch.live()).toBe(false);
  expect(h.changes()).toBe(2);
  expect(h.sleeps[0]!.ms).toBe(HC_EVENTS_RETRY_MIN_MS);
  expect(h.log.at(-1)).toStartWith("HC_EVENTS_LOST exit=1");
  h.sleeps[0]!.resolve();
  await h.until(() => h.streams.length === 2);
  // A subscription that ends before its snapshot doubles the wait, and calls no onChange.
  h.streams[1]!.end(2);
  await h.until(() => h.sleeps.length === 2);
  expect(h.sleeps[1]!.ms).toBe(2 * HC_EVENTS_RETRY_MIN_MS);
  expect(h.changes()).toBe(2);
  h.sleeps[1]!.resolve();
  await h.until(() => h.streams.length === 3);
  h.streams[2]!.push(snapshot(9));
  await h.until(() => h.changes() === 3);
  expect(h.watch.live()).toBe(true);
  h.watch.stop();
});

test("watchHcEvents kills a subscription that stays silent past HC_EVENTS_SILENT_MS", async () => {
  const h = harness();
  await h.until(() => h.streams.length === 1);
  h.streams[0]!.push(snapshot(1));
  await h.until(() => h.changes() === 1);
  expect(h.checks).toHaveLength(1);
  h.clock.at = HC_EVENTS_SILENT_MS - 1;
  h.checks[0]!();
  expect(h.streams[0]!.killed()).toBe(false);
  h.clock.at = HC_EVENTS_SILENT_MS;
  h.checks[0]!();
  expect(h.streams[0]!.killed()).toBe(true);
  await h.until(() => h.sleeps.length === 1);
  expect(h.watch.live()).toBe(false);
  expect(h.log.some((l) => l.startsWith("HC_EVENTS_SILENT"))).toBe(true);
  h.watch.stop();
});
