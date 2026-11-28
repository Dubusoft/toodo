/**
 * Whether `toodo-server` answers. A request that cannot reach it (a network error, or a proxy
 * in front of it answering for it) starts a check: the app probes the server, and while the
 * server does not answer, the offline screen shows (see `src/components/offline-screen.tsx`)
 * and the probe repeats after a growing delay, and at once when the browser comes back
 * online or the page is shown again. Any answer of the server ends it. A proxy that wants the
 * browser to sign in to it again, such as Cloudflare Access whose session ran out, counts as
 * unreachable too, but only a reload that signs in again ends that; see `signInExpired`. The
 * app reloads itself for it: the service worker loads pages from the network, so the reload
 * follows the proxy to its sign-in page, which returns to the app (see `signInAgain`).
 */
import { activeServer } from "@/web/server";
import type { Messages } from "@/locales/en";

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
/** When the tab last reloaded to sign in again, kept across that reload. */
const SIGN_IN_RELOAD_KEY = "toodo-sign-in-reload-at";
/** A reload that brought no sign-in page waits this long before the next, so it cannot loop. */
const SIGN_IN_RELOAD_INTERVAL_MS = 5 * 60_000;

let state: Reachability = "reachable";
let delay = FIRST_RETRY_MS;
let timer: ReturnType<typeof setTimeout> | undefined;
let recoveries = 0;
type Failure =
  | { readonly kind: "gateway"; readonly status: number }
  | { readonly kind: "signInAgain" | "timedOut" | "disconnected" };

let cause: Failure | null = null;
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
export function unreachableCause(m: Messages): string {
  if (cause === null) return "";
  const copy = m.app.connection;
  return cause.kind === "gateway" ? copy.gateway(cause.status) : copy[cause.kind];
}

/** Whether the server counts as unreachable because a proxy in front of it wants a new sign-in. */
export function signInExpired(): boolean {
  return cause?.kind === "signInAgain";
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
async function ask(timeoutMs: number): Promise<Failure | null> {
  try {
    // Any answer will do: without a token the server answers 401. The server never redirects,
    // but a proxy whose sign-in ran out redirects to its sign-in page on another origin, which
    // a followed fetch reports as a network error; `manual` tells it apart.
    const response = await activeServer.fetch("/api", {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    void response.body?.cancel();
    if (response.type === "opaqueredirect") return { kind: "signInAgain" };
    return isGatewayFailure(response) ? { kind: "gateway", status: response.status } : null;
  } catch (error) {
    return error instanceof DOMException && error.name === "TimeoutError"
      ? { kind: "timedOut" }
      : { kind: "disconnected" };
  }
}

/**
 * Reloads the page so the proxy shows its sign-in, once in a while at most: if the reload
 * comes back without signing in (the page came from elsewhere, or the person went back), the
 * banner's Reload button is left.
 */
function signInAgain() {
  if (document.visibilityState !== "visible") return;
  const last = Number(sessionStorage.getItem(SIGN_IN_RELOAD_KEY));
  if (Date.now() - last < SIGN_IN_RELOAD_INTERVAL_MS) return;
  sessionStorage.setItem(SIGN_IN_RELOAD_KEY, String(Date.now()));
  location.reload();
}

function giveUp() {
  set("unreachable");
  if (signInExpired()) {
    signInAgain();
  }
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
