import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase64Url, listenForOpenTask, pushSupport } from "@/web/push";

const TOKEN_KEY = "toodo-server-token";

// Unpadded base64url with both URL-safe characters, and the bytes it encodes.
const publicKey = "BP8A-_w";
const keyBytes = [4, 255, 0, 251, 252];

const settings = { agent: true, pullRequests: false, completion: true };

/** A fresh copy of the module, since it remembers whether push is on. */
async function freshPush() {
  vi.resetModules();
  return import("@/web/push");
}

function browserSubscription(endpoint: string, key: readonly number[] = keyBytes) {
  return {
    endpoint,
    options: { userVisibleOnly: true, applicationServerKey: new Uint8Array(key).buffer },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "BNcRdreALRFX", auth: "tBHItJI5svbpez7KI4CCXg" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function installServiceWorker(existing: ReturnType<typeof browserSubscription> | null) {
  const created = browserSubscription("https://push.example/new");
  const pushManager = {
    getSubscription: vi.fn(async () => existing),
    subscribe: vi.fn(async (_options: PushSubscriptionOptionsInit) => created),
  };
  const registration = { pushManager };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => registration, ready: Promise.resolve(registration) },
  });
  return { pushManager, created };
}

function serve(routes: Record<string, () => Response>) {
  const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
    const route = routes[`${init.method ?? "GET"} ${path}`];
    if (route === undefined) {
      throw new Error(`unexpected request ${init.method ?? "GET"} ${path}`);
    }
    return route();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function requests(fetch: ReturnType<typeof serve>): string[] {
  return fetch.mock.calls.map(([path, init]) => `${init?.method ?? "GET"} ${path}`);
}

function body(fetch: ReturnType<typeof serve>, index: number): unknown {
  return JSON.parse(String(fetch.mock.calls[index][1]?.body));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("decodeBase64Url", () => {
  it.each([
    { text: "BP8A-_w", bytes: keyBytes },
    { text: "BP8A", bytes: [4, 255, 0] },
  ])("decodes $text", ({ text, bytes }) => {
    expect([...decodeBase64Url(text)]).toEqual(bytes);
  });
});

describe("pushSupport", () => {
  const android =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  const iPhone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
  const mac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const property of ["userAgent", "maxTouchPoints", "standalone", "serviceWorker"]) {
      Reflect.deleteProperty(navigator, property);
    }
  });

  it.each([
    { browser: "a browser with Web Push", userAgent: android, push: true, standalone: false, touchPoints: 5, support: "supported" },
    { browser: "Safari on an iPhone", userAgent: iPhone, push: false, standalone: false, touchPoints: 5, support: "needs-install" },
    { browser: "Safari on an iPad, posing as a Mac", userAgent: mac, push: false, standalone: false, touchPoints: 5, support: "needs-install" },
    { browser: "a Home Screen app before iOS 16.4", userAgent: iPhone, push: false, standalone: true, touchPoints: 5, support: "unsupported" },
    { browser: "a Mac browser without Web Push", userAgent: mac, push: false, standalone: false, touchPoints: 0, support: "unsupported" },
  ])("reports $support for $browser", ({ userAgent, push, standalone, touchPoints, support }) => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touchPoints });
    Object.defineProperty(navigator, "standalone", { configurable: true, value: standalone });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {} });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: standalone && query === "(display-mode: standalone)" }));
    if (push) {
      vi.stubGlobal("PushManager", class {});
      vi.stubGlobal("Notification", class {});
    }

    expect(pushSupport()).toBe(support);
  });
});

describe("push on this device", () => {
  beforeEach(() => {
    localStorage.setItem(TOKEN_KEY, "device-token");
    vi.stubGlobal("Notification", { permission: "granted" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "serviceWorker");
    localStorage.clear();
  });

  it.each([
    { server: "none", known: null },
    { server: "another endpoint", known: { endpoint: "https://push.example/old", settings } },
  ])("sends the browser's subscription again when the server has $server", async ({ known }) => {
    const browser = browserSubscription("https://push.example/a");
    installServiceWorker(browser);
    const fetch = serve({
      "GET /api/push": () => json({ publicKey, subscription: known }),
      "PUT /api/push/subscription": () => json({ endpoint: browser.endpoint, settings }),
    });
    const push = await freshPush();

    const state = await push.getPushState();

    expect(requests(fetch)).toEqual(["GET /api/push", "PUT /api/push/subscription"]);
    expect(body(fetch, 1)).toEqual(browser.toJSON());
    expect(state.subscription).toEqual({ endpoint: browser.endpoint, settings });
    expect(push.pushActive()).toBe(true);
  });

  it("keeps a subscription the server has", async () => {
    const browser = browserSubscription("https://push.example/a");
    installServiceWorker(browser);
    const fetch = serve({
      "GET /api/push": () => json({ publicKey, subscription: { endpoint: browser.endpoint, settings } }),
    });
    const push = await freshPush();

    const state = await push.getPushState();

    expect(requests(fetch)).toEqual(["GET /api/push"]);
    expect(state).toEqual({ publicKey, permission: "granted", subscription: { endpoint: browser.endpoint, settings } });
    expect(push.pushActive()).toBe(true);
  });

  it("drops a browser subscription bound to an earlier key of the server", async () => {
    const stale = browserSubscription("https://push.example/a", [4, 1, 2]);
    installServiceWorker(stale);
    const fetch = serve({
      "GET /api/push": () => json({ publicKey, subscription: { endpoint: stale.endpoint, settings } }),
    });
    const push = await freshPush();

    const state = await push.getPushState();

    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(requests(fetch)).toEqual(["GET /api/push"]);
    expect(state.subscription).toBeNull();
    expect(push.pushActive()).toBe(false);
  });

  it("subscribes with the server's key and registers the subscription", async () => {
    const { pushManager, created } = installServiceWorker(null);
    const fetch = serve({ "PUT /api/push/subscription": () => json({ endpoint: created.endpoint, settings }) });
    const push = await freshPush();

    const subscription = await push.enablePush(Promise.resolve("granted"), publicKey);

    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(keyBytes),
    });
    expect(requests(fetch)).toEqual(["PUT /api/push/subscription"]);
    expect(body(fetch, 0)).toEqual(created.toJSON());
    expect(subscription).toEqual({ endpoint: created.endpoint, settings });
    expect(push.pushActive()).toBe(true);
  });

  it("subscribes nowhere when notifications are not allowed", async () => {
    const { pushManager } = installServiceWorker(null);
    const fetch = serve({});
    const push = await freshPush();

    await expect(push.enablePush(Promise.resolve("denied"), publicKey)).rejects.toThrow("not allowed");

    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(requests(fetch)).toEqual([]);
  });

  it("drops the new subscription when the server refuses it", async () => {
    const { created } = installServiceWorker(null);
    serve({
      "PUT /api/push/subscription": () =>
        json({ kind: "rejected", message: "sign in with a device token to get notifications" }, 403),
    });
    const push = await freshPush();

    await expect(push.enablePush(Promise.resolve("granted"), publicKey)).rejects.toThrow("device token");

    expect(created.unsubscribe).toHaveBeenCalledOnce();
    expect(push.pushActive()).toBe(false);
  });

  it("unsubscribes the browser before telling the server", async () => {
    const browser = browserSubscription("https://push.example/a");
    installServiceWorker(browser);
    const fetch = serve({
      "GET /api/push": () => json({ publicKey, subscription: { endpoint: browser.endpoint, settings } }),
      "DELETE /api/push/subscription": () => json(null),
    });
    const push = await freshPush();
    await push.getPushState();

    await push.disablePush();

    expect(requests(fetch)).toEqual(["GET /api/push", "DELETE /api/push/subscription"]);
    expect(browser.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[1]);
    expect(push.pushActive()).toBe(false);
  });

  it("leaves to the server only the alerts it pushes for this device's settings", async () => {
    const browser = browserSubscription("https://push.example/a");
    installServiceWorker(browser);
    const all = { ...settings, pullRequests: true };
    serve({
      "GET /api/push": () => json({ publicKey, subscription: { endpoint: browser.endpoint, settings } }),
      "PUT /api/push/settings": () => json({ endpoint: browser.endpoint, settings: all }),
      "DELETE /api/push/subscription": () => json(null),
    });
    const push = await freshPush();
    const covered = (...titles: string[]) => titles.map((title) => push.pushCovers(title));
    const titles = ["Agent needs input", "CI failed", "Task awaiting completion", "Task paused by a new prerequisite", "Task done"];

    expect(covered(...titles)).toEqual([false, false, false, false, false]);
    await push.getPushState();
    expect(covered(...titles)).toEqual([true, false, true, false, false]);
    await push.saveSettings(all);
    expect(covered(...titles)).toEqual([true, true, true, false, false]);
    await push.disablePush();
    expect(covered(...titles)).toEqual([false, false, false, false, false]);
  });

  it("saves the settings of this device", async () => {
    const fetch = serve({ "PUT /api/push/settings": () => json({ endpoint: "https://push.example/a", settings }) });
    const push = await freshPush();

    await expect(push.saveSettings(settings)).resolves.toEqual({ endpoint: "https://push.example/a", settings });

    expect(body(fetch, 0)).toEqual(settings);
  });

  it("reports why the test push failed", async () => {
    serve({ "POST /api/push/test": () => new Response("the push service refused the notification", { status: 502 }) });
    const push = await freshPush();

    await expect(push.sendTest()).rejects.toThrow("push service refused");
  });
});

describe("listenForOpenTask", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    history.replaceState(null, "", "/");
  });

  it("opens the task of the address and drops it from there", () => {
    history.replaceState(null, "", "/?task=12&view=all");
    const open = vi.fn();

    listenForOpenTask(open)();

    expect(open.mock.calls).toEqual([[12]]);
    expect(location.search).toBe("?view=all");
  });

  it("opens the task the service worker asks for and ignores other messages", () => {
    const container = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
    const open = vi.fn();
    const stop = listenForOpenTask(open);

    container.dispatchEvent(new MessageEvent("message", { data: { type: "toodo-open-task", taskId: 7 } }));
    container.dispatchEvent(new MessageEvent("message", { data: { type: "other", taskId: 8 } }));

    expect(open.mock.calls).toEqual([[7]]);
    stop();
  });

  it("stops listening when asked", () => {
    const container = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
    const open = vi.fn();
    const stop = listenForOpenTask(open);

    stop();
    container.dispatchEvent(new MessageEvent("message", { data: { type: "toodo-open-task", taskId: 9 } }));

    expect(open).not.toHaveBeenCalled();
  });
});
