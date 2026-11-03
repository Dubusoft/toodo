/**
 * Whether `toodo-server` answers. A request that cannot reach it (a network error, or a proxy
 * in front of it answering for it) starts a check: the app probes the server, and while the
 * server does not answer, the offline screen shows (see `src/components/offline-screen.tsx`)
 * and the probe repeats after a growing delay, and at once when the browser comes back
 * online or the page is shown again. Any answer of the server ends it.
 */
import { activeServer } from "@/web/server";

/**
 * `checking`: a request failed and the probe that tells a blip from an outage runs.
 * `retrying`: the server is unreachable and a probe runs again.
 */
export type Reachability = "reachable" | "checking" | "unreachable" | "retrying";

const FIRST_RETRY_MS = 2000;
const MAX_RETRY_MS = 30_000;
/** How long a probe waits for an answer: a host that went away may never refuse it. */
const PROBE_TIMEOUT_MS = 10_000;
/** How often an idle app asks the server whether it is still there. */
const HEARTBEAT_MS = 5000;
/** The heartbeat gives up sooner than a probe, so an outage shows within 10 s. */
const HEARTBEAT_TIMEOUT_MS = 3000;

let state: Reachability = "reachable";
let delay = FIRST_RETRY_MS;
let timer: ReturnType<typeof setTimeout> | undefined;
let recoveries = 0;
let cause = "";
const listeners = new Set<() => void>();
const reachableListeners = new Set<() => void>();

function set(next: Reachability) {
  if (state === next) return;
  state = next;
  listeners.forEach((listener) => listener());
}

export function reachability(): Reachability {
  return state;
}

export function subscribeReachability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Why the server counts as unreachable, for the person looking at the banner. */
export function unreachableCause(): string {
  return cause;
}

/** How often the server answered again after it was unreachable, to tell a recovery that came before a wait. */
export function recoveryCount(): number {
  return recoveries;
}

/** Calls `listener` whenever the server answers again after it was unreachable. */
export function onReachable(listener: () => void): () => void {
  reachableListeners.add(listener);
  return () => reachableListeners.delete(listener);
}

/**
 * Whether `response` comes from a proxy that could not reach the server, such as a tunnel's
 * error page. The server's own command errors (502 for a failed external tool) are JSON.
 */
export function isGatewayFailure(response: Response): boolean {
  const { status } = response;
  const gateway = status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
  return gateway && !(response.headers.get("Content-Type") ?? "").includes("application/json");
}

function reachable() {
  clearTimeout(timer);
  timer = undefined;
  delay = FIRST_RETRY_MS;
  if (state === "reachable") return;
  recoveries += 1;
  set("reachable");
  reachableListeners.forEach((listener) => listener());
}

function unreachable() {
  if (state === "reachable") {
    void probe("checking");
  }
}

async function probe(running: "checking" | "retrying") {
  clearTimeout(timer);
  timer = undefined;
  set(running);
  const failure = await ask(PROBE_TIMEOUT_MS);
  const answered = failure === null;
  if (state !== running) {
    // Another request reached the server meanwhile.
    return;
  }
  if (answered) {
    reachable();
    return;
  }
  cause = failure;
  giveUp();
}

/** Asks the server for any answer; returns why it did not give one, or null. */
async function ask(timeoutMs: number): Promise<string | null> {
  try {
    // Any answer will do: without a token the server answers 401.
    const response = await activeServer.fetch("/api", { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    void response.body?.cancel();
    return isGatewayFailure(response) ? `A gateway in front of the server answered ${response.status}.` : null;
  } catch (error) {
    return error instanceof DOMException && error.name === "TimeoutError"
      ? "The server did not answer in time."
      : "No connection to the server.";
  }
}

function giveUp() {
  set("unreachable");
  timer = setTimeout(() => void probe("retrying"), delay);
  delay = Math.min(delay * 2, MAX_RETRY_MS);
}

/** A quiet check of an app that sends no requests: an outage shows without waiting for one. */
async function heartbeat() {
  if (state !== "reachable" || document.visibilityState !== "visible") return;
  const failure = await ask(HEARTBEAT_TIMEOUT_MS);
  if (failure === null) return;
  if (state === "reachable") {
    cause = failure;
    giveUp();
  }
}

export function retryNow(): void {
  if (state === "unreachable") {
    void probe("retrying");
  }
}

/**
 * `fetch` for `path` on the server, which tracks whether it answers. Aborted requests
 * tell nothing.
 */
export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await activeServer.fetch(path, init);
  } catch (error) {
    if (error instanceof TypeError) {
      unreachable();
    }
    throw error;
  }
  if (isGatewayFailure(response)) {
    unreachable();
  } else {
    reachable();
  }
  return response;
}

/** Checks the server when the browser goes offline, and probes again when it comes back or the page is shown. */
export function watchConnection(): void {
  addEventListener("offline", unreachable);
  addEventListener("online", retryNow);
  setInterval(() => void heartbeat(), HEARTBEAT_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      retryNow();
    }
  });
}
