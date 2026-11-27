// Web Push notifications for the devices of `toodo-server`, so a phone or desktop hears
// about its tasks while Toodo is closed. Each device subscribes its browser with the
// server's VAPID public key (the `push-key` file the Rust server created, read as is);
// the server watches the changes it announces to the frontend (see `alerts.ts`) and
// posts an encrypted message to every subscription that wants it. Port of the delivery
// half of `src-tauri/src/server/push/mod.rs`; its HTTP routes come with the HTTP surface.
//
// Messages the push service could not take for a while (no connection, 429, 5xx) are
// tried again after `RETRY_DELAYS_MS` first. Up to `CONCURRENT_DELIVERIES` devices get
// their messages at once, and a device's messages of one change get
// `DELIVERY_DEADLINE_MS`, so a slow push service holds up neither the other devices nor
// the next change.
//
// Push services are on the public internet, so the server posts only there: an endpoint
// with credentials, a fragment, or a host that is not a public address is refused when a
// device subscribes and before every message, and redirects are not followed.

import type { Database } from "bun:sqlite";
import { join } from "node:path";

import type { DeviceId } from "../domain/device.ts";
import {
  PushEndpoint,
  type PushSubscription,
  PushSubscriptionError,
  allows,
  subscriptionKeys,
} from "../domain/push.ts";
import { isPublic, literalIp, publicAddresses } from "../net.ts";
import { StorageError } from "../storage/errors.ts";
import {
  type NewPushSubscription,
  activePushSubscriptions,
  clearPushFailure,
  deletePushEndpoint,
  pushSubscription,
  recordPushFailure,
} from "../storage/push.ts";
import { type Alert, type WatchedTask, Watch, alertPayload, testAlert } from "./alerts.ts";
import { VapidKey, base64url, encrypt, fromBase64url, isValidPublicKey } from "./crypto.ts";

/** The file in the data directory that holds the VAPID key. */
export const KEY_FILE = "push-key";

/** The contact push services see in every request, unless `TOODO_PUSH_SUBJECT` sets one. */
export const DEFAULT_SUBJECT = "https://github.com/Dubusoft/toodo";

/** How long a push service keeps a message for a device that is offline, in seconds. */
const TIME_TO_LIVE = 24 * 60 * 60;

/** How long a VAPID token is valid, in seconds; push services accept at most 24 hours. */
const TOKEN_LIFETIME = 12 * 60 * 60;

/** How much of a refusal's body is kept to show the device, in bytes. */
const MAX_FAILURE_BODY = 1024;

/** How long to wait before each new try of a message that failed for a while, doubling. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/** How many subscriptions get their messages at the same time. */
export const CONCURRENT_DELIVERIES = 8;

/** How long one subscription's messages of a change may take, retries included; a push
 * service that has not taken them by then counts as unreachable. */
export const DELIVERY_DEADLINE_MS = 30_000;

export type PushRequest = {
  readonly endpoint: string;
  readonly authorization: string;
  readonly urgency: "high" | "normal";
  readonly ttl: number;
  readonly body: Uint8Array;
};

export type PushResponse = {
  readonly status: number;
  readonly body: string;
};

/** Posts messages to push services; faked in tests. */
export interface Transport {
  /** Posts `request`; rejects with the reason when the push service cannot be reached.
   * `signal` aborts a post whose delivery ran out of time. */
  post(request: PushRequest, signal: AbortSignal): Promise<PushResponse>;
  /** Resolves when the host name `host` resolves to a public address; rejects otherwise. */
  admit(host: string): Promise<void>;
}

/** The URL of `endpoint` when its form lets the server post to it: no credentials, no
 * fragment, and no address outside the public internet. A host name is checked when it
 * is resolved. Returns the reason otherwise. */
function publicUrl(endpoint: PushEndpoint): URL | string {
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    return "push endpoint is not a valid URL";
  }
  if (url.username !== "" || url.password !== "" || endpoint.url.includes("#")) {
    return "push endpoint must not carry credentials or a fragment";
  }
  const literal = literalIp(url);
  if (literal !== null && !isPublic(literal)) {
    return "push endpoint must be on a public address";
  }
  return url;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Posts over HTTPS to public addresses only, without following redirects. */
export class Http implements Transport {
  async post(request: PushRequest, signal: AbortSignal): Promise<PushResponse> {
    const url = new URL(request.endpoint);
    if (literalIp(url) === null) await this.admit(url.hostname);
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: "POST",
        headers: {
          Authorization: request.authorization,
          TTL: String(request.ttl),
          Urgency: request.urgency,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
        },
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch (error) {
      throw new Error(errorMessage(error));
    }
    return { status: response.status, body: response.ok ? "" : await failureBody(response) };
  }

  async admit(host: string): Promise<void> {
    try {
      await publicAddresses(host);
    } catch {
      throw new Error(`push endpoint host ${host} has no public address`);
    }
  }
}

/** The first `MAX_FAILURE_BODY` bytes of a refusal's body, as text. */
async function failureBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < MAX_FAILURE_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } catch {
    // A body cut off midway still tells what arrived.
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_FAILURE_BODY).toString("utf8");
}

/** Why a message did not reach a device. */
export type SendError =
  /** The push service no longer knows the subscription (404 or 410); it is dropped. */
  | { readonly kind: "gone" }
  /** The push service refused the message. */
  | { readonly kind: "refused"; readonly response: PushResponse }
  /** The push service could not be reached. */
  | { readonly kind: "unreachable"; readonly message: string }
  /** The message could not be built. */
  | { readonly kind: "failed"; readonly message: string };

/** Whether the same message may get through when tried again a little later. */
export function isTransient(error: SendError): boolean {
  switch (error.kind) {
    case "unreachable":
      return true;
    case "refused":
      return error.response.status === 429 || error.response.status >= 500;
    case "gone":
    case "failed":
      return false;
  }
}

export function describeSendError(error: SendError): string {
  switch (error.kind) {
    case "gone":
      return "the push service no longer knows this subscription";
    case "refused":
      return `the push service refused the notification (${error.response.status}): ${error.response.body.trim()}`;
    case "unreachable":
      return `cannot reach the push service: ${error.message}`;
    case "failed":
      return error.message;
  }
}

export type PushOptions = {
  readonly retryDelaysMs?: readonly number[];
  readonly deliveryDeadlineMs?: number;
  /** The current time in Unix seconds. */
  readonly now?: () => number;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms === 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

const NEVER = new AbortController().signal;

/** The server's push identity: its key, contact, and the way it posts. */
export class Push {
  readonly #key: VapidKey;
  readonly #subject: string;
  readonly #transport: Transport;
  readonly retryDelaysMs: readonly number[];
  readonly deliveryDeadlineMs: number;
  readonly now: () => number;

  constructor(key: VapidKey, subject: string, transport: Transport, options: PushOptions = {}) {
    this.#key = key;
    this.#subject = subject;
    this.#transport = transport;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.deliveryDeadlineMs = options.deliveryDeadlineMs ?? DELIVERY_DEADLINE_MS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Loads (or creates) the key in `dataDir` and posts over HTTP. */
  static async load(dataDir: string, subject: string): Promise<Push> {
    return new Push(await VapidKey.loadOrCreate(join(dataDir, KEY_FILE)), subject, new Http());
  }

  /** The `applicationServerKey` browsers subscribe with, as base64url. */
  publicKey(): string {
    return base64url(this.#key.publicKey);
  }

  /** Checks that the server may post to `endpoint`: its form, then where its host name
   * resolves. Returns the reason when it may not. */
  async admit(endpoint: PushEndpoint): Promise<string | null> {
    const url = publicUrl(endpoint);
    if (typeof url === "string") return url;
    if (literalIp(url) !== null) return null;
    try {
      await this.#transport.admit(url.hostname);
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /** Encrypts `alert` for `subscription` and posts it, unless its endpoint is not one the
   * server posts to. `null` when the push service took it. */
  async send(subscription: PushSubscription, alert: Alert, signal: AbortSignal = NEVER): Promise<SendError | null> {
    const url = publicUrl(subscription.endpoint);
    if (typeof url === "string") return { kind: "failed", message: url };
    let body: Uint8Array;
    try {
      const payload = new TextEncoder().encode(JSON.stringify(alertPayload(alert)));
      body = await encrypt(subscription.keys.p256dh, subscription.keys.auth, payload);
    } catch {
      return { kind: "failed", message: "cannot encrypt for this subscription's key" };
    }
    const request: PushRequest = {
      endpoint: subscription.endpoint.url,
      authorization: await this.#key.authorization(
        subscription.endpoint.origin(),
        this.#subject,
        this.now() + TOKEN_LIFETIME,
      ),
      urgency: alert.urgent ? "high" : "normal",
      ttl: TIME_TO_LIVE,
      body,
    };
    let response: PushResponse;
    try {
      response = await this.#transport.post(request, signal);
    } catch (error) {
      return { kind: "unreachable", message: errorMessage(error) };
    }
    if (response.status >= 200 && response.status <= 299) return null;
    if (response.status === 404 || response.status === 410) return { kind: "gone" };
    return { kind: "refused", response };
  }

  /** Sends like `send`, trying a transient failure again after each retry delay. */
  async sendWithRetry(
    subscription: PushSubscription,
    alert: Alert,
    signal: AbortSignal = NEVER,
  ): Promise<SendError | null> {
    for (let attempt = 0; ; attempt += 1) {
      const error = await this.send(subscription, alert, signal);
      const delay = this.retryDelaysMs[attempt];
      if (error === null || !isTransient(error) || delay === undefined || signal.aborted) return error;
      await sleep(delay, signal);
      if (signal.aborted) return error;
    }
  }
}

/** Keeps the outcome of the latest message to `subscription`: a failure is shown to the
 * device until a message reaches it again. */
function recordOutcome(db: Database, subscription: PushSubscription, error: SendError | null, at: number): void {
  try {
    if (error === null) {
      if (subscription.lastFailure !== null) clearPushFailure(db, subscription.endpoint);
    } else {
      recordPushFailure(db, { endpoint: subscription.endpoint, message: describeSendError(error) }, at);
    }
  } catch (failure) {
    console.error(`toodo-server: cannot record a push delivery outcome: ${errorMessage(failure)}`);
  }
}

/** What one subscription's messages of a change came to. */
type Delivery = {
  readonly subscription: PushSubscription;
  sent: number;
  /** The outcome of its latest message (`null`: delivered); `undefined` when none was
   * sent or it is gone. */
  latest: SendError | null | undefined;
  gone: boolean;
};

/** Sends the alerts `subscription` allows, one after another, within the deadline. */
async function deliverTo(push: Push, subscription: PushSubscription, alerts: readonly Alert[]): Promise<Delivery> {
  const delivery: Delivery = { subscription, sent: 0, latest: undefined, gone: false };
  const deadline = new AbortController();
  const sending = (async () => {
    for (const alert of alerts) {
      if (alert.kind !== null && !allows(subscription.settings, alert.kind)) continue;
      const error = await push.sendWithRetry(subscription, alert, deadline.signal);
      if (deadline.signal.aborted) return;
      if (error === null) {
        delivery.sent += 1;
        delivery.latest = null;
      } else if (error.kind === "gone") {
        delivery.gone = true;
        delivery.latest = undefined;
        return;
      } else {
        console.error(`toodo-server: push to device ${subscription.device} failed: ${describeSendError(error)}`);
        delivery.latest = error;
        if (isTransient(error)) return;
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    sending.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), push.deliveryDeadlineMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    deadline.abort();
    const error: SendError = {
      kind: "unreachable",
      message: `no answer within ${push.deliveryDeadlineMs / 1000} seconds`,
    };
    console.error(`toodo-server: push to device ${subscription.device} failed: ${describeSendError(error)}`);
    delivery.latest = error;
  }
  return delivery;
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the input order. */
async function eachLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/**
 * Sends every alert to every subscription whose settings allow it, records the outcome
 * of each subscription's latest message, and drops the subscriptions their push service
 * reports gone. Subscriptions get their alerts side by side, `CONCURRENT_DELIVERIES` at a
 * time; a subscription whose push service stays unreachable or misses the deadline gets
 * no further alerts this time. Returns how many messages were sent.
 */
export async function deliver(db: Database, push: Push, alerts: readonly Alert[]): Promise<number> {
  if (alerts.length === 0) return 0;
  let subscriptions: PushSubscription[];
  try {
    subscriptions = activePushSubscriptions(db, push.now());
  } catch (error) {
    console.error(`toodo-server: cannot read push subscriptions: ${errorMessage(error)}`);
    return 0;
  }
  const deliveries = await eachLimited(subscriptions, CONCURRENT_DELIVERIES, (subscription) =>
    deliverTo(push, subscription, alerts),
  );
  let sent = 0;
  for (const delivery of deliveries) {
    sent += delivery.sent;
    if (delivery.gone) {
      try {
        deletePushEndpoint(db, delivery.subscription.endpoint);
      } catch (error) {
        console.error(`toodo-server: cannot drop a gone push subscription: ${errorMessage(error)}`);
      }
    } else if (delivery.latest !== undefined) {
      recordOutcome(db, delivery.subscription, delivery.latest, push.now());
    }
  }
  return sent;
}

/** A change the worker turns into notifications. */
type Change =
  | { readonly kind: "tasks" }
  /** The tasks changed through the app; the baseline moves without notifications. */
  | { readonly kind: "tasks_seen" }
  /** A notification to send as it is, such as the agent's chat message. */
  | { readonly kind: "alert"; readonly alert: Alert };

/** Turns announced changes into notifications, one batch at a time. */
export class PushWorker {
  readonly #db: Database;
  readonly #push: Push;
  readonly #listTasks: () => Iterable<WatchedTask>;
  readonly #watch = new Watch();
  #pending: Change[] = [];
  #running: Promise<void> | null = null;

  /** Starts watching: the tasks `listTasks` returns now are the baseline. */
  constructor(db: Database, push: Push, listTasks: () => Iterable<WatchedTask>) {
    this.#db = db;
    this.#push = push;
    this.#listTasks = listTasks;
    this.#watchTasks();
  }

  tasksChanged(): void {
    this.#changed({ kind: "tasks" });
  }

  tasksSeen(): void {
    this.#changed({ kind: "tasks_seen" });
  }

  alert(alert: Alert): void {
    this.#changed({ kind: "alert", alert });
  }

  /** Resolves once every change announced so far is delivered. */
  async idle(): Promise<void> {
    while (this.#running !== null) await this.#running;
  }

  #changed(change: Change): void {
    this.#pending.push(change);
    if (this.#running === null) {
      this.#running = this.#drain().finally(() => {
        this.#running = null;
      });
    }
  }

  // The changes announced while the last ones were delivered are read once. A batch
  // notifies when any of its changes did not come from the app, so an agent's change is
  // never folded into the baseline unannounced.
  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const batch = this.#pending;
      this.#pending = [];
      let notify = false;
      const sent: Alert[] = [];
      for (const change of batch) {
        if (change.kind === "tasks") notify = true;
        else if (change.kind === "alert") sent.push(change.alert);
      }
      const alerts = this.#watchTasks();
      await deliver(this.#db, this.#push, [...(notify ? alerts : []), ...sent]);
    }
  }

  #watchTasks(): Alert[] {
    try {
      return this.#watch.tasks(this.#listTasks());
    } catch (error) {
      console.error(`toodo-server: cannot read tasks for notifications: ${errorMessage(error)}`);
      return [];
    }
  }
}

/** Why a test notification did not reach the asking device. */
export class PushTestError extends Error {
  /** `not_found`: the push service forgot the subscription, which is dropped;
   * `external`: the push service refused it or could not be reached. */
  readonly kind: "not_found" | "external";

  constructor(kind: "not_found" | "external", message: string) {
    super(message);
    this.name = "PushTestError";
    this.kind = kind;
  }
}

/** Sends the test notification to `device` and records the outcome as a delivery would.
 * Throws a `StorageError` when the device has no subscription. */
export async function sendTest(db: Database, push: Push, device: DeviceId): Promise<void> {
  const subscription = pushSubscription(db, device);
  if (subscription === null) throw new StorageError({ kind: "push_subscription_not_found", device });
  const error = await push.sendWithRetry(subscription, testAlert());
  if (error === null) {
    recordOutcome(db, subscription, null, push.now());
    return;
  }
  if (error.kind === "gone") {
    deletePushEndpoint(db, subscription.endpoint);
    throw new PushTestError(
      "not_found",
      "the push service no longer knows this device's subscription; turn notifications on again",
    );
  }
  recordOutcome(db, subscription, error, push.now());
  throw new PushTestError(
    "external",
    `${describeSendError(error)}; send a test notification again later, or disable and enable notifications on this device to subscribe it anew`,
  );
}

/** The JSON of a browser's `PushSubscription`; `expirationTime` is ignored. */
export type SubscriptionInput = {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
};

/** A subscription a device sent that cannot be stored. */
export class PushInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushInputError";
  }
}

/** Checks a browser's subscription: an https endpoint, base64url keys of the right
 * shape, and a public key on P-256. Whether the server may post to the endpoint is
 * `Push.admit`. */
export async function parseSubscription(input: SubscriptionInput): Promise<NewPushSubscription> {
  const decode = (name: string, text: string) => {
    const bytes = fromBase64url(text);
    if (bytes === null) throw new PushInputError(`push subscription key ${name} is not base64url`);
    return bytes;
  };
  let created: NewPushSubscription;
  try {
    const endpoint = PushEndpoint.parse(input.endpoint);
    created = { endpoint, keys: subscriptionKeys(decode("p256dh", input.keys.p256dh), decode("auth", input.keys.auth)) };
  } catch (error) {
    if (error instanceof PushSubscriptionError) throw new PushInputError(error.message);
    throw error;
  }
  if (!(await isValidPublicKey(created.keys.p256dh))) {
    throw new PushInputError("push subscription key p256dh is not a point on P-256");
  }
  return created;
}
