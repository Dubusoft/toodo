// Web Push subscriptions of `toodo-server` devices: where a device's browser receives
// notifications while Toodo is closed, and which kinds of notification it wants.

import type { DeviceId } from "./device.ts";
import { byteLength, isControl, isWhitespace } from "./rust.ts";

/**
 * The kinds of notification the settings turn on and off.
 *
 * Chat, from the agent connected over MCP:
 * - `important_message`: a message that waits on the people: it offers choices, or its
 *   thread waits on their answer. Sent when either `important` or `messages` is on.
 * - `agent_message`: any other message. Sent when `messages` is on.
 * - `awaiting_answer`: a thread started waiting on the people's answer, e.g. the agent
 *   asked for something without offering choices. Sent when `important` is on.
 *
 * Tasks, as their status changes: `task_started` (in progress), `completion` (awaiting
 * completion), and `task_finished` (done: completed or concluded).
 */
export type PushKind =
  | "completion"
  | "agent_message"
  | "important_message"
  | "awaiting_answer"
  | "task_started"
  | "task_finished";

/** Which kinds of notification a device receives. */
export type PushSettings = {
  /** Chat: messages that wait on the people (see `important_message`). */
  readonly important: boolean;
  /** Chat: every message of the agent. */
  readonly messages: boolean;
  /** Tasks: a task started. */
  readonly started: boolean;
  /** Tasks: a task is awaiting completion. */
  readonly completion: boolean;
  /** Tasks: a task was completed or concluded. */
  readonly finished: boolean;
};

/** What a new subscription receives: what devices got before the settings were split,
 * every chat message and tasks awaiting completion, and no other task changes. */
export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  important: true,
  messages: true,
  started: false,
  completion: true,
  finished: false,
};

export function allows(settings: PushSettings, kind: PushKind): boolean {
  switch (kind) {
    case "important_message":
      return settings.important || settings.messages;
    case "agent_message":
      return settings.messages;
    case "awaiting_answer":
      return settings.important;
    case "task_started":
      return settings.started;
    case "completion":
      return settings.completion;
    case "task_finished":
      return settings.finished;
  }
}

/** The length of a subscription's public key: an uncompressed P-256 point. */
export const P256DH_LEN = 65;

/** The length of a subscription's authentication secret. */
export const AUTH_LEN = 16;

/** The longest endpoint URL accepted; push services hand out a few hundred characters. */
export const MAX_ENDPOINT_LEN = 2048;

/** Where and how to reach one device's browser: the push service URL it subscribed at and
 * the keys that encrypt messages for it (RFC 8291). */
export type PushSubscription = {
  readonly device: DeviceId;
  readonly endpoint: PushEndpoint;
  readonly keys: SubscriptionKeys;
  readonly settings: PushSettings;
  /** Unix seconds. */
  readonly createdAt: number;
  /** The last notification that did not reach the device, until one reaches it again. */
  readonly lastFailure: PushFailure | null;
};

/** Why a notification did not reach a device, and when. */
export type PushFailure = {
  readonly message: string;
  /** Unix seconds. */
  readonly at: number;
};

export type PushSubscriptionProblem =
  | "endpoint_not_https"
  | "endpoint_too_long"
  | "bad_p256dh"
  | "bad_auth";

export class PushSubscriptionError extends Error {
  readonly problem: PushSubscriptionProblem;

  constructor(problem: PushSubscriptionProblem) {
    super(pushSubscriptionMessage(problem));
    this.name = "PushSubscriptionError";
    this.problem = problem;
  }
}

function pushSubscriptionMessage(problem: PushSubscriptionProblem): string {
  switch (problem) {
    case "endpoint_not_https":
      return "push endpoint must be an https URL";
    case "endpoint_too_long":
      return `push endpoint is longer than ${MAX_ENDPOINT_LEN} characters`;
    case "bad_p256dh":
      return "push subscription key p256dh must be an uncompressed P-256 public key";
    case "bad_auth":
      return `push subscription key auth must be ${AUTH_LEN} bytes`;
  }
}

const HTTPS = "https://";

/** The length of the host (and port) after `https://`: up to the first `/`, `?`, or `#`. */
function hostLength(afterScheme: string): number {
  const end = afterScheme.search(/[/?#]/);
  return end === -1 ? afterScheme.length : end;
}

/** A push service URL: `https`, one line, at most `MAX_ENDPOINT_LEN` bytes. The server posts
 * to it, so plain HTTP is refused. */
export class PushEndpoint {
  readonly url: string;

  private constructor(url: string) {
    this.url = url;
  }

  static parse(url: string): PushEndpoint {
    if (byteLength(url) > MAX_ENDPOINT_LEN) {
      throw new PushSubscriptionError("endpoint_too_long");
    }
    if (!url.startsWith(HTTPS)) throw new PushSubscriptionError("endpoint_not_https");
    if (
      hostLength(url.slice(HTTPS.length)) === 0 ||
      [...url].some((char) => isWhitespace(char) || isControl(char))
    ) {
      throw new PushSubscriptionError("endpoint_not_https");
    }
    return new PushEndpoint(url);
  }

  /** `https://host[:port]`, the audience of the VAPID token for this endpoint. */
  origin(): string {
    return this.url.slice(0, HTTPS.length + hostLength(this.url.slice(HTTPS.length)));
  }
}

/** A subscription's public key and authentication secret, of the right shape. */
export type SubscriptionKeys = {
  readonly p256dh: Uint8Array;
  readonly auth: Uint8Array;
};

/** Checks the shape of a subscription's keys: the point format and the secret's length.
 * Whether the point is on the curve is checked when a message is encrypted for it. */
export function subscriptionKeys(p256dh: Uint8Array, auth: Uint8Array): SubscriptionKeys {
  if (p256dh.length !== P256DH_LEN || p256dh[0] !== 0x04) {
    throw new PushSubscriptionError("bad_p256dh");
  }
  if (auth.length !== AUTH_LEN) throw new PushSubscriptionError("bad_auth");
  return { p256dh: Uint8Array.from(p256dh), auth: Uint8Array.from(auth) };
}
