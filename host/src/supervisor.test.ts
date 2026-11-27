import { describe, expect, test } from "bun:test";

import type { HostToWorker } from "./protocol.ts";
import { type Spawn, type SupervisorEvent, SupervisorHost, type SupervisorTunables, type Timers, type WorkerEvents } from "./supervisor.ts";

class FakeTimers implements Timers {
  #now = 0;
  #next = 0;
  #due = new Map<number, { at: number; run: () => void }>();
  now = () => this.#now;
  setTimeout = (run: () => void, ms: number): unknown => {
    const id = ++this.#next;
    this.#due.set(id, { at: this.#now + ms, run });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.#due.delete(handle as number); };
  /** Moves the clock forward by `ms`, running each timer that falls due in order. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      const [id, timer] = [...this.#due].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] ?? [];
      if (id === undefined || !timer) break;
      this.#due.delete(id);
      this.#now = timer.at;
      timer.run();
    }
    this.#now = end;
  }
}

type FakeWorker = { events: WorkerEvents; posted: HostToWorker[]; terminated: boolean };

const setup = (tunables: Partial<SupervisorTunables> = {}) => {
  const timers = new FakeTimers();
  const workers: FakeWorker[] = [];
  const spawn: Spawn = (events) => {
    const worker: FakeWorker = { events, posted: [], terminated: false };
    workers.push(worker);
    return { post: (message) => { worker.posted.push(message); }, terminate: () => { worker.terminated = true; } };
  };
  const host = new SupervisorHost(spawn, {
    timers,
    tunables: {
      heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 90_000, backoffBaseMs: 1_000, backoffMaxMs: 8_000,
      stableAfterMs: 600_000, breakerThreshold: 5, breakerWindowMs: 600_000, breakerCooldownMs: 1_800_000, stopDeadlineMs: 20_000,
      ...tunables,
    },
  });
  const events: SupervisorEvent[] = [];
  host.on((event) => { events.push(event); });
  const latest = (): FakeWorker => {
    const worker = workers.at(-1);
    if (!worker) throw new Error("no worker spawned");
    return worker;
  };
  return { host, timers, workers, events, latest };
};

const retryDelays = (events: SupervisorEvent[]) =>
  events.flatMap((event) => (event.kind === "failed" ? [event.retryInMs] : []));

describe("SupervisorHost", () => {
  test("restarts a failed Worker after a delay that doubles up to the maximum", () => {
    const { host, timers, workers, events, latest } = setup();
    host.start();
    for (let i = 0; i < 4; i++) {
      latest().events.exit(1);
      const delay = retryDelays(events).at(-1) ?? 0;
      timers.advance(delay - 1);
      expect(workers).toHaveLength(i + 1);
      timers.advance(1);
      expect(workers).toHaveLength(i + 2);
    }
    expect(retryDelays(events)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(workers.slice(0, -1).every((worker) => worker.terminated)).toBe(true);
  });

  test("hands a scheduled-jobs request to the running Worker and resolves with its answer", async () => {
    const { host, latest } = setup();
    await expect(host.schedules({ op: "list" })).rejects.toThrow("the supervisor is idle");
    host.start();
    await expect(host.schedules({ op: "list" })).rejects.toThrow("the supervisor is starting");
    latest().events.message({ type: "ready" });
    const answer = host.schedules({ op: "pause", name: "gmail-digest" });
    expect(latest().posted).toEqual([{ type: "schedules", id: 1, request: { op: "pause", name: "gmail-digest" } }]);
    latest().events.message({ type: "schedules", id: 1, reply: { ok: true, jobs: [], timeZone: { name: "Asia/Seoul", label: "KST" } } });
    expect(await answer).toEqual({ ok: true, jobs: [], timeZone: { name: "Asia/Seoul", label: "KST" } });
  });

  test("a scheduled-jobs request fails when the Worker does not answer in time or dies first", async () => {
    const { host, timers, latest } = setup({ requestTimeoutMs: 5_000 });
    host.start();
    latest().events.message({ type: "ready" });
    const silent = host.schedules({ op: "list" });
    timers.advance(5_000);
    await expect(silent).rejects.toThrow("the supervisor did not answer within 5000 ms");
    const pending = host.schedules({ op: "list" });
    latest().events.exit(1);
    await expect(pending).rejects.toThrow("the supervisor stopped before it answered");
  });

  test("treats a Worker with no heartbeat for the timeout as hung and replaces it", () => {
    const { host, timers, workers, events, latest } = setup();
    host.start();
    latest().events.message({ type: "ready" });
    timers.advance(60_000);
    latest().events.message({ type: "heartbeat" });
    timers.advance(60_000);
    expect(workers).toHaveLength(1);
    timers.advance(30_000);
    expect(workers[0]?.terminated).toBe(true);
    expect(events.find((event) => event.kind === "failed")).toMatchObject({ reason: "no heartbeat for 90000 ms", retryInMs: 1_000 });
    timers.advance(1_000);
    expect(workers).toHaveLength(2);
  });

  test("catches a Worker that hangs before its first heartbeat", () => {
    const { host, timers, events } = setup();
    host.start();
    timers.advance(90_000);
    expect(events.find((event) => event.kind === "failed")).toMatchObject({ start: 1, reason: "no heartbeat for 90000 ms" });
  });

  test("opens the breaker after repeated failures and tries one Worker again after the cooldown", () => {
    const { host, timers, workers, events, latest } = setup();
    host.start();
    for (let i = 0; i < 5; i++) {
      latest().events.error("boom");
      timers.advance(retryDelays(events).at(-1) ?? 0);
    }
    expect(events.at(-1)).toEqual({ kind: "breaker-open", failures: 5, retryInMs: 1_800_000 });
    expect(host.snapshot().state).toBe("open");
    expect(workers).toHaveLength(5);
    timers.advance(1_800_000 - 1);
    expect(workers).toHaveLength(5);
    timers.advance(1);
    expect(workers).toHaveLength(6);
    // The half-open Worker fails before it is stable: straight back to open, no backoff restart.
    latest().events.exit(1);
    expect(events.at(-1)).toMatchObject({ kind: "breaker-open", failures: 1 });
    expect(host.snapshot().state).toBe("open");
  });

  test("a Worker that ran stably before failing restarts at the shortest delay", () => {
    const { host, timers, events, latest } = setup();
    host.start();
    latest().events.exit(1);
    timers.advance(1_000);
    latest().events.exit(1);
    timers.advance(2_000);
    latest().events.message({ type: "ready" });
    for (let t = 0; t < 600_000; t += 30_000) {
      timers.advance(30_000);
      latest().events.message({ type: "heartbeat" });
    }
    latest().events.exit(1);
    expect(retryDelays(events)).toEqual([1_000, 2_000, 1_000]);
  });

  test("reload stops the Worker gracefully and starts a new one, resetting the breaker", async () => {
    const { host, timers, workers, events, latest } = setup();
    host.start();
    for (let i = 0; i < 5; i++) {
      latest().events.exit(1);
      timers.advance(retryDelays(events).at(-1) ?? 0);
    }
    expect(host.snapshot().state).toBe("open");
    await host.reload();
    expect(workers).toHaveLength(6);
    expect(host.snapshot().state).toBe("starting");

    latest().events.message({ type: "ready" });
    const reloading = host.reload();
    expect(workers[5]?.posted).toEqual([{ type: "stop" }]);
    workers[5]?.events.message({ type: "stopped" });
    await reloading;
    expect(workers).toHaveLength(7);
    expect(events.filter((event) => event.kind === "stopped")).toEqual([{ kind: "stopped", start: 6, forced: false }]);
  });

  test("stop terminates a Worker that does not stop by the deadline and starts nothing after", async () => {
    const { host, timers, workers, events } = setup();
    host.start();
    const stopping = host.stop();
    timers.advance(20_000);
    await stopping;
    expect(workers[0]?.terminated).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "stopped", start: 1, forced: true });
    workers[0]?.events.exit(0);
    timers.advance(3_600_000);
    expect(workers).toHaveLength(1);
    expect(host.snapshot().state).toBe("stopped");
  });

  test("a Worker that fails while stopping counts as stopped and is not restarted", async () => {
    const { host, timers, workers, events } = setup();
    host.start();
    const stopping = host.stop();
    workers[0]?.events.error("boom");
    await stopping;
    timers.advance(3_600_000);
    expect(workers).toHaveLength(1);
    expect(events.filter((event) => event.kind === "failed")).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "stopped", start: 1, forced: false });
    expect(host.snapshot().state).toBe("stopped");
  });

  test("ignores the exit of a Worker it already replaced", () => {
    const { host, timers, workers, events } = setup();
    host.start();
    workers[0]?.events.error("boom");
    workers[0]?.events.exit(1);
    timers.advance(1_000);
    workers[0]?.events.exit(1);
    expect(events.filter((event) => event.kind === "failed")).toHaveLength(1);
    expect(host.snapshot().state).toBe("starting");
  });
});
