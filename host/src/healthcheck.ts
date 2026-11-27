// Pings healthchecks.io from the host, so an outage of the one process reaches the owner without Discord. The checks are
// the ones the host-healthcheck.timer script pinged before the host ran Toodo and Dori in one process:
// - toodo: the core answers HTTP on its port: any status below 500 pings HC_TOODO_URL, none or a 5xx pings its /fail;
// - dori: the supervisor's gateway heartbeat (~/.dori/state/gateway-status.json, `at` in ms) is at most DORI_MAX_AGE_MS
//   old: HC_DORI_URL, else its /fail.
// The ping URLs are secrets of a kind (anyone holding one can ping), so they are read from their file and never logged.
// This runs on the main thread, so it makes no *Sync calls (sync-check.test.ts).
import { homedir } from "node:os";
import { join } from "node:path";

export const PING_FILE = join(".config", "host-healthcheck.env");
export const PING_INTERVAL_MS = 60_000;
export const DORI_MAX_AGE_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;
const SEND_TIMEOUT_MS = 10_000;
/** Tries per ping, as `curl --retry 3` made: the first and three more. */
const SEND_TRIES = 4;

export type CheckName = "toodo" | "dori";

/** The ping URL of each check; a check without one is not pinged. */
export type PingUrls = Readonly<Record<CheckName, string | undefined>>;

const KEYS: Readonly<Record<CheckName, string>> = { toodo: "HC_TOODO_URL", dori: "HC_DORI_URL" };

/** The ping URLs of the env file text: `KEY=value` lines, `export` and quotes allowed, blank values unset. */
export const parsePingFile = (text: string): PingUrls => {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[2]!;
    const value = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
    if (value) values.set(match[1]!, value);
  }
  return { toodo: values.get(KEYS.toodo), dori: values.get(KEYS.dori) };
};

export const readPingFile = async (path: string): Promise<PingUrls> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return { toodo: undefined, dori: undefined };
  return parsePingFile(await file.text());
};

export type Probe = () => Promise<string | null>;

export const httpProbe = (url: URL | string): Probe => async () => {
  try {
    const reply = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "manual" });
    await reply.body?.cancel();
    return reply.status >= 500 ? `HTTP ${reply.status}` : null;
  } catch (e) {
    return `no answer: ${errorName(e)}`;
  }
};

export const gatewayProbe = (path: string, maxAgeMs: number, now: () => number = Date.now): Probe => async () => {
  let at: unknown;
  try {
    at = ((await Bun.file(path).json()) as { at?: unknown }).at;
  } catch {
    return `no gateway heartbeat in ${path}`;
  }
  if (typeof at !== "number") return `no gateway heartbeat time in ${path}`;
  const age = now() - at;
  return age <= maxAgeMs ? null : `gateway heartbeat is ${Math.round(age / 1000)} s old`;
};

/** POSTs `body` to `url`, retrying a failed try; throws with a reason that names no URL. */
export const sendPing = async (url: string, body: string): Promise<void> => {
  let reason = "";
  for (let attempt = 0; attempt < SEND_TRIES; attempt++) {
    try {
      const reply = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      await reply.body?.cancel();
      if (reply.ok) return;
      reason = `HTTP ${reply.status}`;
    } catch (e) {
      reason = errorName(e);
    }
  }
  throw new Error(reason);
};

// A fetch error's message can quote the URL; its code or name never does.
const errorName = (e: unknown): string =>
  (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined) ??
  (e instanceof Error ? e.name : "error");

export type HealthcheckDeps = {
  readonly probes: Readonly<Record<CheckName, Probe>>;
  readonly send?: (url: string, body: string) => Promise<void>;
  readonly log: (line: string) => void;
};

/**
 * Runs every check with a ping URL now and every `intervalMs` after: a healthy one pings its URL, a failing one its
 * `/fail` with the reason as the body. Logs a check's state when it changes and a ping that could not be sent. Returns
 * the stop function, and `round` for running one round at once.
 */
export const startHealthcheck = (urls: PingUrls, deps: HealthcheckDeps, intervalMs = PING_INTERVAL_MS) => {
  const send = deps.send ?? sendPing;
  const last = new Map<CheckName, string | null>();
  const checks = (Object.keys(KEYS) as CheckName[]).filter((name) => urls[name] !== undefined);
  const round = async (): Promise<void> => {
    await Promise.all(checks.map(async (name) => {
      const url = urls[name]!;
      const problem = await deps.probes[name]();
      if (!last.has(name) || last.get(name) !== problem) {
        deps.log(problem === null ? `HOST_HEALTHCHECK ${name} ok` : `HOST_HEALTHCHECK ${name} failing: ${problem}`);
      }
      last.set(name, problem);
      try {
        await send(problem === null ? url : `${url.replace(/\/+$/, "")}/fail`, problem ?? "");
      } catch (e) {
        deps.log(`HOST_HEALTHCHECK_SEND_FAILED ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  };
  let running: Promise<void> = round();
  const timer = setInterval(() => { running = running.then(round); }, intervalMs);
  return {
    round: () => (running = running.then(round)),
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
};

/** Where the host reads its ping URLs and the gateway heartbeat: `TOODO_HEALTHCHECK_FILE` and `HOME` move them. */
export const healthcheckPaths = (env: Readonly<Record<string, string | undefined>>) => {
  const home = env.HOME || homedir();
  return {
    pingFile: env.TOODO_HEALTHCHECK_FILE || join(home, PING_FILE),
    gatewayStatus: join(home, ".dori", "state", "gateway-status.json"),
  };
};

/** `DORI_MAX_AGE_MS` as the timer script read it, else {@link DORI_MAX_AGE_MS}. */
export const doriMaxAge = (value: string | undefined): number => {
  const ms = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(ms) && ms > 0 ? ms : DORI_MAX_AGE_MS;
};
