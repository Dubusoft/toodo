/**
 * The host's hc event subscription (`hc events --json`): what tells the runner that a lane's terminal changed, instead of
 * a timer. hc writes one JSON line per message:
 * - a snapshot `{"channel":null,"seq":<n>,"terminals":[...]}` first, and again after `missed` when this subscriber fell
 *   behind (events whose seq is not above the snapshot's are already in it);
 * - `{"jsonrpc":"2.0","method":"event","params":{"type":..,"terminal":..,"seq":..,"data":..}}` per fact change;
 * - `{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":<n>}}` every 15 s.
 * seq is the core's own counter across every terminal, so a gap only means another terminal's event; it is never read
 * as a loss.
 *
 * Each snapshot and each event of a type that can change what the runner observes (STATE_EVENTS: a terminal appearing,
 * ending or going away, its agent's reported status or turn, its foreground process) calls `onChange`; a title, label,
 * size or document change does not. A subscription that ends (hc exited, the core restarted) or stays silent for
 * HC_EVENTS_SILENT_MS (three missed heartbeats; its process is killed) is not live until a new one has delivered its
 * snapshot: it is started again after HC_EVENTS_RETRY_MIN_MS, doubling to HC_EVENTS_RETRY_MAX_MS while it keeps failing.
 * The new snapshot resynchronises the runner: it calls `onChange` like any change.
 */

export const HC_EVENTS_ARGV: readonly string[] = ["hc", "events", "--json"];
export const STATE_EVENTS: ReadonlySet<string> = new Set(["created", "lost", "restarted", "finished", "removed", "status", "turn", "foreground"]);
/** Three of hc's 15 s heartbeats. */
export const HC_EVENTS_SILENT_MS = 45_000;
export const HC_EVENTS_RETRY_MIN_MS = 2_000;
export const HC_EVENTS_RETRY_MAX_MS = 60_000;

export type EventStream = { readonly lines: AsyncIterable<string>; readonly exited: Promise<number>; readonly kill: () => void };

export type HcEventsDeps = {
  readonly spawn: (argv: readonly string[]) => EventStream;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly every: (ms: number, tick: () => void) => () => void;
  readonly log: (line: string) => void;
};

export type HcWatch = {
  /** A subscription has delivered its snapshot and has not ended since. */
  readonly live: () => boolean;
  readonly stop: () => void;
};

type Message = {
  readonly seq?: unknown; readonly terminals?: unknown; readonly method?: unknown;
  readonly params?: { readonly type?: unknown; readonly seq?: unknown };
  readonly error?: { readonly message?: unknown };
};

const parse = (line: string): Message | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Message : undefined;
  } catch {
    return undefined;
  }
};

export const watchHcEvents = (deps: HcEventsDeps, onChange: () => void): HcWatch => {
  let stopped = false;
  let live = false;
  let current: EventStream | undefined;
  let wake: (() => void) | undefined;

  const follow = async (stream: EventStream): Promise<boolean> => {
    let snapshotSeq = -1;
    let heard = deps.now();
    let snapshot = false;
    const stopCheck = deps.every(HC_EVENTS_SILENT_MS / 3, () => {
      if (deps.now() - heard < HC_EVENTS_SILENT_MS) return;
      deps.log(`HC_EVENTS_SILENT no line for ${Math.round((deps.now() - heard) / 1000)} s; subscribing again`);
      stream.kill();
    });
    try {
      for await (const line of stream.lines) {
        heard = deps.now();
        const message = parse(line);
        if (!message) continue;
        if (Array.isArray(message.terminals) && typeof message.seq === "number") {
          snapshotSeq = message.seq;
          if (!live) deps.log(`HC_EVENTS_LIVE seq=${message.seq}`);
          live = snapshot = true;
          onChange();
        } else if (message.method === "missed") {
          deps.log("HC_EVENTS_MISSED the subscription fell behind; a fresh snapshot follows");
        } else if (message.method === "event") {
          const seq = message.params?.seq;
          if (typeof seq === "number" && seq <= snapshotSeq) continue;
          const type = message.params?.type;
          if (typeof type === "string" && STATE_EVENTS.has(type)) onChange();
        } else if (typeof message.error?.message === "string") {
          deps.log(`HC_EVENTS_ERROR ${message.error.message}`);
        }
      }
    } finally {
      stopCheck();
    }
    return snapshot;
  };

  const loop = async (): Promise<void> => {
    let failures = 0;
    while (!stopped) {
      let delivered = false;
      let code: number | string = "spawn failed";
      try {
        const stream = deps.spawn(HC_EVENTS_ARGV);
        current = stream;
        delivered = await follow(stream);
        code = await stream.exited;
      } catch (error) {
        code = error instanceof Error ? error.message : String(error);
      }
      current = undefined;
      const was = live;
      live = false;
      if (stopped) return;
      failures = delivered ? 1 : failures + 1;
      const wait = Math.min(HC_EVENTS_RETRY_MAX_MS, HC_EVENTS_RETRY_MIN_MS * 2 ** (failures - 1));
      deps.log(`HC_EVENTS_LOST exit=${code}; subscribing again in ${Math.round(wait / 1000)} s`);
      // What changed while nobody listened is read now; the next snapshot reads it again.
      if (was) onChange();
      await Promise.race([deps.sleep(wait), new Promise<void>((resolve) => { wake = resolve; })]);
      wake = undefined;
    }
  };

  void loop().catch((error: unknown) => { deps.log(`HC_EVENTS_FAILED ${error instanceof Error ? error.message : String(error)}`); });
  return {
    live: () => live,
    stop: () => {
      stopped = true;
      live = false;
      current?.kill();
      wake?.();
    },
  };
};

/** Splits a byte stream into its lines (the last one only when it ended with a newline or the stream ended). */
async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let end = buffered.indexOf("\n");
    while (end >= 0) {
      yield buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered) yield buffered;
}

/** `hc events` as a child of this process (stderr dropped: hc answers its errors as JSON on stdout). */
export const spawnHcEvents = (argv: readonly string[]): EventStream => {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore", ...(process.platform === "win32" ? { windowsHide: true } : {}) });
  return { lines: linesOf(child.stdout), exited: child.exited, kill: () => { child.kill(); } };
};
