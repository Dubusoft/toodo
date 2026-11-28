// Helpers for the push tests: a browser's side of a subscription, a push service that
// records what it is sent, and subscribed devices in a test database.

import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceLabel } from "../domain/device.ts";
import { AUTH_LEN, DEFAULT_PUSH_SETTINGS, PushEndpoint, type PushSettings, subscriptionKeys } from "../domain/push.ts";
import { createDevice } from "../storage/devices.ts";
import { savePushSubscription, setPushSettings } from "../storage/push.ts";
import { VapidKey, base64url, bytes, contentKeys } from "./crypto.ts";
import { KEY_FILE, Push, type PushRequest, type PushResponse, RETRY_DELAYS_MS, type Transport } from "./push.ts";

/** The time the push tests act at, in Unix seconds. */
export const NOW = 100;

/** A browser's side of a subscription: the key it decrypts with and its secret. */
export class Browser {
  private constructor(
    private readonly pair: CryptoKeyPair,
    readonly publicKey: Uint8Array,
    readonly auth: Uint8Array,
  ) {}

  static async create(): Promise<Browser> {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return new Browser(pair, publicKey, new Uint8Array(AUTH_LEN).fill(7));
  }

  /** The JSON of the browser's `PushSubscription` at `endpoint`. */
  json(endpoint: string): { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } } {
    return {
      endpoint,
      expirationTime: null,
      keys: { p256dh: base64url(this.publicKey), auth: base64url(this.auth) },
    };
  }

  /** Decrypts a message as the browser would, checking the last record delimiter. */
  async decrypt(message: Uint8Array): Promise<Uint8Array> {
    const keyLength = message[20]!;
    const asPublic = message.slice(21, 21 + keyLength);
    const sender = await crypto.subtle.importKey("raw", bytes(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const secret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, this.pair.privateKey, 256),
    );
    const { cek, nonce } = await contentKeys(secret, this.publicKey, asPublic, this.auth, message.slice(0, 16));
    const key = await crypto.subtle.importKey("raw", bytes(cek), "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(nonce) }, key, message.slice(21 + keyLength)),
    );
    if (plain[plain.length - 1] !== 2) throw new Error("the message does not end with the last record delimiter");
    return plain.slice(0, -1);
  }

  /** Decrypts a message and parses its JSON. */
  async decryptJson(message: Uint8Array): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(await this.decrypt(message)));
  }
}

/**
 * Records every request and answers each with the next status queued for its endpoint,
 * else the next one queued for any (201 when none is queued); a queued 0 fails as an unreachable push service. A stalled endpoint never
 * answers. Host names resolve to public addresses, except `private.example`.
 */
export class FakeTransport implements Transport {
  readonly requests: PushRequest[] = [];
  readonly statuses: number[] = [];
  readonly statusesFor = new Map<string, number[]>();
  readonly stalled = new Set<string>();

  post(request: PushRequest): Promise<PushResponse> {
    this.requests.push(request);
    if (this.stalled.has(request.endpoint)) return new Promise(() => {});
    const status = this.statusesFor.get(request.endpoint)?.shift() ?? this.statuses.shift() ?? 201;
    if (status === 0) return Promise.reject(new Error("connection refused"));
    return Promise.resolve({ status, body: "nope" });
  }

  admit(host: string): Promise<void> {
    if (host === "private.example") {
      return Promise.reject(new Error(`push endpoint host ${host} has no public address`));
    }
    return Promise.resolve();
  }
}

/** A push identity with a fresh key, `transport`, no retry delays, and the clock at `NOW`. */
export async function testPush(transport: Transport, deliveryDeadlineMs?: number): Promise<Push> {
  const key = await VapidKey.loadOrCreate(join(mkdtempSync(join(tmpdir(), "toodo-push-")), KEY_FILE));
  return new Push(key, "mailto:toodo@example.com", transport, {
    retryDelaysMs: RETRY_DELAYS_MS.map(() => 0),
    deliveryDeadlineMs,
    now: () => NOW,
  });
}

/** Creates a device named `label` subscribed at `endpoint` with `settings`. */
export async function subscribed(
  db: Database,
  label: string,
  endpoint: string,
  settings: PushSettings = DEFAULT_PUSH_SETTINGS,
): Promise<Browser> {
  const browser = await Browser.create();
  const device = createDevice(
    db,
    { label: DeviceLabel.parse(label), tokenHash: new Bun.CryptoHasher("sha256").update(label).digest("hex"), scope: "full", lifetimeDays: null },
    NOW,
  ).id;
  savePushSubscription(
    db,
    device,
    { endpoint: PushEndpoint.parse(endpoint), keys: subscriptionKeys(browser.publicKey, browser.auth) },
    NOW,
  );
  setPushSettings(db, device, settings);
  return browser;
}
