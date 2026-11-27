import { HEARTBEAT_INTERVAL_MS, type HostToWorker, type WorkerToHost } from "./protocol.ts";

export type WorkerHandle = {
  readonly post: (message: HostToWorker) => void;
  readonly terminate: () => void;
};

export type WorkerEvents = {
  readonly message: (message: WorkerToHost) => void;
  readonly error: (reason: string) => void;
  readonly exit: (code: number) => void;
};

export type Spawn = (events: WorkerEvents) => WorkerHandle;

export type Timers = {
  readonly now: () => number;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export type SupervisorTunables = {
  /** How often the watchdog looks at the last heartbeat. */
  readonly heartbeatIntervalMs: number;
  /** A Worker silent this long is hung: its event loop is blocked or it never started. */
  readonly heartbeatTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** A Worker that ran this long before failing starts the backoff over. */
  readonly stableAfterMs: number;
  /** This many failures within `breakerWindowMs` open the breaker. */
  readonly breakerThreshold: number;
  readonly breakerWindowMs: number;
  /** How long an open breaker waits before it tries one Worker again. */
  readonly breakerCooldownMs: number;
  /** How long a stop waits for the Worker's `stopped` before terminating it. */
  readonly stopDeadlineMs: number;
};

export const DEFAULT_TUNABLES: SupervisorTunables = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: 3 * HEARTBEAT_INTERVAL_MS,
  backoffBaseMs: 1_000,
  backoffMaxMs: 5 * 60_000,
  stableAfterMs: 10 * 60_000,
  breakerThreshold: 5,
  breakerWindowMs: 10 * 60_000,
  breakerCooldownMs: 30 * 60_000,
  // Above the supervisor's own stop deadline (SUPERVISE_STOP_DEADLINE_MS, 15 s), so a clean stop is never cut short.
  stopDeadlineMs: 20_000,
};

export type SupervisorState = "idle" | "starting" | "running" | "backoff" | "open" | "stopping" | "stopped";

export type SupervisorSnapshot = {
  readonly state: SupervisorState;
  /** Workers started so far, the first one included. */
  readonly starts: number;
  readonly lastHeartbeatAt: number | null;
  /** When the next start is due while in `backoff` or `open`. */
  readonly nextStartAt: number | null;
};

export type SupervisorEvent =
  | { readonly kind: "started"; readonly start: number }
  | { readonly kind: "ready"; readonly start: number }
  | { readonly kind: "failed"; readonly start: number; readonly reason: string; readonly retryInMs: number | null }
  | { readonly kind: "breaker-open"; readonly failures: number; readonly retryInMs: number }
  | { readonly kind: "stopped"; readonly start: number; readonly forced: boolean };

/**
 * Runs the supervisor Worker and keeps it running: a heartbeat watchdog, a restart backoff, and a breaker that stops
 * restarting a Worker that keeps failing. The Worker can fail any way it likes; the thread that owns this object only
 * sees messages and exit codes, so the core serving HTTP on it keeps answering.
 */
export class SupervisorHost {
  readonly #spawn: Spawn;
  readonly #timers: Timers;
  readonly #tune: SupervisorTunables;
  readonly #listeners = new Set<(event: SupervisorEvent) => void>();

  #state: SupervisorState = "idle";
  #worker: WorkerHandle | undefined;
  #starts = 0;
  #startedAt = 0;
  #readyAt: number | undefined;
  #lastHeartbeatAt: number | undefined;
  #attempt = 0;
  #failures: number[] = [];
  #halfOpen = false;
  #watchdog: unknown;
  #pending: unknown;
  #nextStartAt: number | undefined;
  #stopping: { readonly done: Promise<void>; readonly finish: (forced: boolean) => void } | undefined;

  constructor(spawn: Spawn, options: { timers?: Timers; tunables?: Partial<SupervisorTunables> } = {}) {
    this.#spawn = spawn;
    this.#timers = options.timers ?? realTimers;
    this.#tune = { ...DEFAULT_TUNABLES, ...options.tunables };
  }

  on(listener: (event: SupervisorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  snapshot(): SupervisorSnapshot {
    return {
      state: this.#state,
      starts: this.#starts,
      lastHeartbeatAt: this.#lastHeartbeatAt ?? null,
      nextStartAt: this.#nextStartAt ?? null,
    };
  }

  start(): void {
    if (this.#state !== "idle") throw new Error(`supervisor already ${this.#state}`);
    this.#launch();
  }

  /** Replaces the Worker with a fresh one that loads the code on disk now; the core is left alone. */
  async reload(): Promise<void> {
    if (this.#state === "stopped") return;
    await this.#stopWorker();
    this.#attempt = 0;
    this.#failures = [];
    this.#halfOpen = false;
    this.#launch();
  }

  async stop(): Promise<void> {
    await this.#stopWorker();
    this.#state = "stopped";
  }

  #emit(event: SupervisorEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #launch(): void {
    this.#clearPending();
    const start = ++this.#starts;
    this.#state = "starting";
    this.#startedAt = this.#timers.now();
    this.#readyAt = undefined;
    // Starting counts as a heartbeat, so a Worker that hangs before its first one is caught by the same watchdog.
    this.#lastHeartbeatAt = this.#startedAt;
    const current = () => this.#starts === start && this.#worker !== undefined;
    this.#worker = this.#spawn({
      message: (message) => { if (current()) this.#onMessage(start, message); },
      error: (reason) => { if (current()) this.#fail(start, `error: ${reason}`); },
      exit: (code) => {
        if (this.#starts !== start) return;
        if (this.#stopping) this.#stopping.finish(false);
        else if (this.#worker !== undefined) this.#fail(start, `exited with code ${code}`);
      },
    });
    this.#armWatchdog(start);
    this.#emit({ kind: "started", start });
  }

  #onMessage(start: number, message: WorkerToHost): void {
    this.#lastHeartbeatAt = this.#timers.now();
    if (message.type === "ready" && this.#state === "starting") {
      this.#state = "running";
      this.#readyAt = this.#lastHeartbeatAt;
      this.#emit({ kind: "ready", start });
    } else if (message.type === "stopped" && this.#stopping) {
      this.#stopping.finish(false);
    }
  }

  #armWatchdog(start: number): void {
    this.#watchdog = this.#timers.setTimeout(() => {
      if (this.#starts !== start || this.#worker === undefined || this.#stopping) return;
      const silent = this.#timers.now() - (this.#lastHeartbeatAt ?? this.#startedAt);
      if (silent >= this.#tune.heartbeatTimeoutMs) this.#fail(start, `no heartbeat for ${silent} ms`);
      else this.#armWatchdog(start);
    }, this.#tune.heartbeatIntervalMs);
  }

  #fail(start: number, reason: string): void {
    // A Worker that dies while being stopped has stopped: restarting it would outlive the stop.
    if (this.#stopping) {
      this.#stopping.finish(false);
      return;
    }
    const now = this.#timers.now();
    this.#dropWorker();
    const stable = this.#readyAt !== undefined && now - this.#readyAt >= this.#tune.stableAfterMs;
    if (stable) {
      this.#attempt = 0;
      this.#failures = [];
      this.#halfOpen = false;
    }
    this.#failures = [...this.#failures.filter((at) => now - at < this.#tune.breakerWindowMs), now];
    if (this.#halfOpen || this.#failures.length >= this.#tune.breakerThreshold) {
      this.#emit({ kind: "failed", start, reason, retryInMs: null });
      this.#openBreaker();
      return;
    }
    const delay = Math.min(this.#tune.backoffBaseMs * 2 ** this.#attempt, this.#tune.backoffMaxMs);
    this.#attempt += 1;
    this.#state = "backoff";
    this.#schedule(delay, () => { this.#launch(); });
    this.#emit({ kind: "failed", start, reason, retryInMs: delay });
  }

  #openBreaker(): void {
    const failures = this.#failures.length;
    this.#state = "open";
    this.#schedule(this.#tune.breakerCooldownMs, () => {
      // Half-open: one Worker gets to prove itself; failing before it is stable opens the breaker again.
      this.#halfOpen = true;
      this.#failures = [];
      this.#attempt = 0;
      this.#launch();
    });
    this.#emit({ kind: "breaker-open", failures, retryInMs: this.#tune.breakerCooldownMs });
  }

  #schedule(ms: number, run: () => void): void {
    this.#clearPending();
    this.#nextStartAt = this.#timers.now() + ms;
    this.#pending = this.#timers.setTimeout(() => {
      this.#pending = undefined;
      this.#nextStartAt = undefined;
      run();
    }, ms);
  }

  #clearPending(): void {
    if (this.#pending !== undefined) this.#timers.clearTimeout(this.#pending);
    this.#pending = undefined;
    this.#nextStartAt = undefined;
  }

  #dropWorker(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    if (this.#watchdog !== undefined) this.#timers.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
    worker?.terminate();
  }

  async #stopWorker(): Promise<void> {
    this.#clearPending();
    const worker = this.#worker;
    if (worker === undefined) return;
    const start = this.#starts;
    this.#state = "stopping";
    let finish: (forced: boolean) => void = () => {};
    const done = new Promise<void>((resolve) => {
      let settled = false;
      finish = (forced) => {
        if (settled) return;
        settled = true;
        this.#timers.clearTimeout(deadline);
        this.#stopping = undefined;
        this.#dropWorker();
        this.#emit({ kind: "stopped", start, forced });
        resolve();
      };
    });
    const deadline = this.#timers.setTimeout(() => { finish(true); }, this.#tune.stopDeadlineMs);
    this.#stopping = { done, finish };
    worker.post({ type: "stop" });
    await done;
  }
}

export const workerSpawner = (entry: URL | string): Spawn => (events) => {
  const worker = new Worker(entry);
  worker.addEventListener("message", (event: MessageEvent<WorkerToHost>) => { events.message(event.data); });
  // Bun puts a source excerpt above the `error: <message>` line; the message alone is what a log line needs.
  worker.addEventListener("error", (event: ErrorEvent) => { events.error(/^error: (.+)$/m.exec(event.message)?.[1] ?? event.message); });
  worker.addEventListener("close", (event: Event) => { events.exit((event as CloseEvent).code); });
  return {
    post: (message) => { worker.postMessage(message); },
    terminate: () => { worker.terminate(); },
  };
};
