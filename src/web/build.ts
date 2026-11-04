/**
 * Tells when the server serves a different build of the web app than the one this tab runs,
 * as after `toodo update`. A built app names its build in `<meta name="toodo-build">` and the
 * server serves the current build's name in `/version.json` (both written by `vite-pwa.ts`);
 * the dev server has neither, so there is nothing to compare. The app checks when it starts,
 * when the event stream reconnects, when the server answers again, and when the tab comes
 * back into view.
 */

/** The file the build names itself in; never cached by the service worker. */
export const BUILD_FILE = "/version.json";

/** The message that asks a waiting service worker to take over; see `vite-pwa.ts`. */
export const SKIP_WAITING = "toodo-skip-waiting";

/** How long a reload waits for a new service worker before reloading anyway. */
const WORKER_WAIT_MS = 5000;

let available: string | null = null;
let dismissed: string | null = null;
let checking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function changed() {
  listeners.forEach((listener) => listener());
}

/** The build this tab runs, or `null` outside a built app. */
export function runningBuild(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="toodo-build"]')?.content || null;
}

export function subscribeNewBuild(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The build the server serves when it differs from this tab's and was not dismissed. */
export function newBuild(): string | null {
  return available !== null && available !== dismissed ? available : null;
}

/** Hides the offer until the server serves yet another build. */
export function dismissNewBuild(): void {
  dismissed = available;
  changed();
}

function buildOf(body: unknown): string | null {
  return typeof body === "object" && body !== null && "build" in body && typeof body.build === "string"
    ? body.build
    : null;
}

/** Asks the server which build it serves; concurrent calls share one request. */
export function checkForNewBuild(): Promise<void> {
  const running = runningBuild();
  if (running === null) {
    return Promise.resolve();
  }
  checking ??= (async () => {
    try {
      const response = await fetch(BUILD_FILE, { cache: "no-store" });
      // A server from before builds were named answers with the app itself, which is no JSON.
      const build = response.ok ? buildOf(await response.json().catch(() => null)) : null;
      if (build === null) {
        return;
      }
      const next = build === running ? null : build;
      if (next !== available) {
        available = next;
        changed();
      }
    } catch (error) {
      // The server is unreachable; the next reconnect checks again.
      console.warn("toodo: could not check for a new build", error);
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** Starts checking for a new build now and whenever the tab comes back into view. */
export function watchBuild(): void {
  void checkForNewBuild();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void checkForNewBuild();
    }
  });
  addEventListener("focus", () => void checkForNewBuild());
}

function within(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Lets the new build's service worker take over, so the next start offline is the new build
 * too, and resolves once it has or after a bounded wait.
 */
async function activateNewWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined) {
    return;
  }
  await registration.update();
  const installing = registration.installing;
  if (installing !== null) {
    await within(
      new Promise((resolve) => {
        const settled = () => installing.state !== "installing" && resolve();
        installing.addEventListener("statechange", settled);
        settled();
      }),
      WORKER_WAIT_MS,
    );
  }
  const waiting = registration.waiting;
  if (waiting === null || navigator.serviceWorker.controller === null) {
    return;
  }
  const tookOver = new Promise<void>((resolve) =>
    navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }),
  );
  waiting.postMessage({ type: SKIP_WAITING });
  await within(tookOver, WORKER_WAIT_MS);
}

/** Reloads the tab into the build the server serves. */
export async function reloadIntoNewBuild(): Promise<void> {
  try {
    await activateNewWorker();
  } catch (error) {
    // The page itself always comes from the network, so the reload still gets the new build.
    console.warn("toodo: could not activate the new service worker", error);
  }
  location.reload();
}
