/**
 * Web Push on this device. The browser subscribes with the server's public key, the server
 * keeps the subscription under this device's token and pushes alerts to it even while Toodo
 * is closed, and the service worker (see `vite-pwa.ts`) shows them and opens their task.
 */
import type { TaskId } from "@/lib/bindings";
import { isAppleMobile, runsInstalled } from "@/web/install";
import { apiRequest } from "@/web/session";

export interface PushSettings {
  readonly completion: boolean;
  /** Chat messages of the agent connected over MCP. */
  readonly messages: boolean;
}

/** Why the latest notification did not reach this device; `at` is in Unix seconds. */
export interface PushFailure {
  readonly message: string;
  readonly at: number;
}

export interface ServerSubscription {
  readonly endpoint: string;
  readonly settings: PushSettings;
  /** Kept until a notification reaches this device again. */
  readonly lastFailure: PushFailure | null;
}

export interface PushState {
  /** The key the server signs pushes with, base64url-encoded; subscriptions are bound to it. */
  readonly publicKey: string;
  readonly permission: NotificationPermission;
  /** This device's subscription, null while the server does not push to this device. */
  readonly subscription: ServerSubscription | null;
}

/**
 * Whether this browser can get pushes. iOS and iPadOS (16.4 or later) offer them only to web
 * apps added to the Home Screen, so there Toodo has to be installed first.
 */
export type PushSupport = "supported" | "needs-install" | "unsupported";

export function pushSupport(): PushSupport {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) {
    return "supported";
  }
  return isAppleMobile() && !runsInstalled() ? "needs-install" : "unsupported";
}

/** The settings of this device's subscription, null while the server does not push to it. */
let pushed: PushSettings | null = null;

/** Whether the server pushes alerts to this device. */
export function pushActive(): boolean {
  return pushed !== null;
}

/**
 * The titles of the alerts the page also raises, by the setting that has the server push them
 * (see `server/src/push/alerts.ts`). Every other alert only the page shows.
 */
const pushedTitles: Record<keyof PushSettings, readonly string[]> = {
  completion: ["Task awaiting completion"],
  // The page raises no alerts for chat messages; the chat shows them.
  messages: [],
};

/** Whether the server pushes the alert titled `title` to this device, so the page need not show it as well. */
export function pushCovers(title: string): boolean {
  return (
    pushed !== null &&
    (Object.keys(pushedTitles) as (keyof PushSettings)[]).some(
      (kind) => pushed?.[kind] === true && pushedTitles[kind].includes(title),
    )
  );
}

export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/**
 * Whether `subscription` is bound to `key`: push services refuse pushes signed with another
 * one. A browser that does not tell is trusted.
 */
function boundTo(subscription: PushSubscription, key: Uint8Array): boolean {
  const bound = subscription.options.applicationServerKey;
  return (
    bound === null ||
    (bound.byteLength === key.length && new Uint8Array(bound).every((byte, index) => byte === key[index]))
  );
}

/** The service worker, which the built app installs; `npm run dev` has none. */
function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration();
}

/** This browser's subscription for `key`; one bound to an earlier key of the server is dropped. */
async function browserSubscription(key: Uint8Array): Promise<PushSubscription | null> {
  const subscription = (await (await registration())?.pushManager.getSubscription()) ?? null;
  if (subscription === null || boundTo(subscription, key)) {
    return subscription;
  }
  await subscription.unsubscribe();
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSettings(value: unknown): value is PushSettings {
  return isRecord(value) && typeof value.completion === "boolean" && typeof value.messages === "boolean";
}

function isFailure(value: unknown): value is PushFailure {
  return isRecord(value) && typeof value.message === "string" && typeof value.at === "number";
}

function isSubscription(value: unknown): value is ServerSubscription {
  return (
    isRecord(value) &&
    typeof value.endpoint === "string" &&
    isSettings(value.settings) &&
    (value.lastFailure === null || isFailure(value.lastFailure))
  );
}

function isServerPush(value: unknown): value is { publicKey: string; subscription: ServerSubscription | null } {
  return (
    isRecord(value) &&
    typeof value.publicKey === "string" &&
    (value.subscription === null || isSubscription(value.subscription))
  );
}

/**
 * The body of the server's answer to `request`, which has to be JSON that `expected` accepts.
 * Anything else, such as a proxy's HTML page or an older server's shape, is rejected with an
 * error that says so instead of failing later on a missing field.
 */
async function answer<T>(request: string, response: Response, expected: (value: unknown) => value is T): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `The answer to ${request} is not JSON; a proxy in front of the Toodo server may have answered instead.`,
    );
  }
  if (!expected(body)) {
    throw new Error(
      `The answer to ${request} is not the push data this app expects; the Toodo server may be older or newer than the app. Reload the app.`,
    );
  }
  return body;
}

async function sendSubscription(subscription: PushSubscription): Promise<ServerSubscription> {
  const response = await apiRequest("/api/push/subscription", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  return answer("PUT /api/push/subscription", response, isSubscription);
}

/**
 * Push on this device. A subscription of this browser that the server does not have, such as
 * one the browser renewed while Toodo was closed, is sent to it again.
 */
export async function getPushState(): Promise<PushState> {
  const server = await answer("GET /api/push", await apiRequest("/api/push"), isServerPush);
  const browser = await browserSubscription(decodeBase64Url(server.publicKey));
  const subscription =
    browser === null
      ? null
      : browser.endpoint === server.subscription?.endpoint
        ? server.subscription
        : await sendSubscription(browser);
  pushed = subscription?.settings ?? null;
  return { publicKey: server.publicKey, permission: Notification.permission, subscription };
}

/** How long turning push on waits for the service worker to become active. */
const workerReadyMs = 10_000;

/**
 * The registration once its service worker is active. A worker that never activates, such as
 * one whose install failed, would otherwise keep `navigator.serviceWorker.ready` pending forever.
 */
async function activeWorker(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `The service worker did not become active within ${workerReadyMs / 1000} seconds. Reload the app and try again.`,
          ),
        ),
      workerReadyMs,
    );
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns push on for this device. `permission` is the answer to `Notification.requestPermission()`,
 * which the click that turns push on has to ask itself: browsers only prompt during a user gesture.
 */
export async function enablePush(
  permission: Promise<NotificationPermission>,
  publicKey: string,
): Promise<ServerSubscription> {
  if ((await permission) !== "granted") {
    throw new Error("Notifications were not allowed.");
  }
  if ((await registration()) === undefined) {
    throw new Error("Notifications need the service worker, which only the built app installs.");
  }
  const { pushManager } = await activeWorker();
  const key = decodeBase64Url(publicKey);
  const subscription =
    (await browserSubscription(key)) ??
    (await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  try {
    const sent = await sendSubscription(subscription);
    pushed = sent.settings;
    return sent;
  } catch (error) {
    // A subscription the server refused would be sent again, and refused, on every start.
    await subscription.unsubscribe();
    throw error;
  }
}

/**
 * Turns push off for this device. The browser drops its subscription first, so the device
 * stops getting pushes even when the server cannot be told.
 */
export async function disablePush(): Promise<void> {
  const subscription = await (await registration())?.pushManager.getSubscription();
  await subscription?.unsubscribe();
  pushed = null;
  await apiRequest("/api/push/subscription", { method: "DELETE" });
}

export async function saveSettings(settings: PushSettings): Promise<ServerSubscription> {
  const response = await apiRequest("/api/push/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const saved = await answer("PUT /api/push/settings", response, isSubscription);
  pushed = saved.settings;
  return saved;
}

export async function sendTest(): Promise<void> {
  await apiRequest("/api/push/test", { method: "POST" });
}

/** The message the service worker sends a page that is open when a notification is clicked. */
const openTaskMessage = "toodo-open-task";

/** The message the service worker sends an open page when a chat notification is clicked. */
const openChatMessage = "toodo-open-chat";

/**
 * Calls `open` each time a clicked chat notification asks an open page to show the chat. A page
 * the service worker opens gets `?chat` in its address instead. Returns the function that stops
 * listening.
 */
export function listenForOpenChat(open: () => void): () => void {
  if (!("serviceWorker" in navigator)) {
    return () => {};
  }
  const container = navigator.serviceWorker;
  const onMessage = ({ data }: MessageEvent<unknown>) => {
    if (typeof data === "object" && data !== null && "type" in data && data.type === openChatMessage) {
      open();
    }
  };
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}

/**
 * Calls `open` for each task a clicked notification asks for in the service worker's messages
 * to a page that was open already. A page the service worker opens gets the task in its
 * address, which the app's route reads. Returns the function that stops listening.
 */
export function listenForOpenTask(open: (id: TaskId) => void): () => void {
  // Pages outside a secure context have no service workers.
  if (!("serviceWorker" in navigator)) {
    return () => {};
  }
  const container = navigator.serviceWorker;
  const onMessage = ({ data }: MessageEvent<unknown>) => {
    if (
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === openTaskMessage &&
      "taskId" in data &&
      typeof data.taskId === "number"
    ) {
      open(data.taskId);
    }
  };
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}
