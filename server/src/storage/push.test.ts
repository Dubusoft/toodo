import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { type DeviceId, DeviceLabel, deviceId } from "../domain/device.ts";
import { DEFAULT_PUSH_SETTINGS, PushEndpoint, subscriptionKeys } from "../domain/push.ts";
import { type StorageFailure, StorageError } from "./errors.ts";
import {
  type NewPushSubscription,
  activePushSubscriptions,
  clearPushFailure,
  deletePushEndpoint,
  deletePushSubscription,
  pushSubscription,
  recordPushFailure,
  savePushSubscription,
  setPushSettings,
} from "./push.ts";
import { createDevice, revokeDevice } from "./devices.ts";
import { openMemoryDatabase } from "./testing.ts";

const NOW = 100;

function subscribing(endpoint: string, key: number): NewPushSubscription {
  const p256dh = new Uint8Array(65).fill(key);
  p256dh[0] = 4;
  return {
    endpoint: PushEndpoint.parse(endpoint),
    keys: subscriptionKeys(p256dh, new Uint8Array(16).fill(key)),
  };
}

function addDevice(db: Database, label: string, lifetimeDays: number | null): DeviceId {
  const tokenHash = label.charAt(0).repeat(64);
  return createDevice(db, { label: DeviceLabel.parse(label), tokenHash, scope: "full", lifetimeDays }, NOW).id;
}

function databaseWithDevices(): { db: Database; phone: DeviceId; laptop: DeviceId } {
  const db = openMemoryDatabase();
  const phone = addDevice(db, "Phone", null);
  const laptop = addDevice(db, "Laptop", null);
  return { db, phone, laptop };
}

function activeDevices(db: Database, at: number): DeviceId[] {
  return activePushSubscriptions(db, at).map((subscription) => subscription.device);
}

function failureOf(action: () => unknown): StorageFailure {
  try {
    action();
  } catch (error) {
    if (error instanceof StorageError) {
      return error.failure;
    }
    throw error;
  }
  throw new Error("expected a StorageError");
}

describe("push subscriptions", () => {
  test("resubscribing replaces the keys and keeps the settings", () => {
    const { db, phone } = databaseWithDevices();
    const first = savePushSubscription(db, phone, subscribing("https://push.example/a", 1), NOW);
    expect(first.settings).toEqual(DEFAULT_PUSH_SETTINGS);
    const quiet = { important: false, messages: false, started: true, completion: false, finished: true };
    setPushSettings(db, phone, quiet);

    const second = savePushSubscription(db, phone, subscribing("https://push.example/b", 2), NOW);
    expect(second.endpoint.url).toBe("https://push.example/b");
    expect(second.keys.auth).toEqual(new Uint8Array(16).fill(2));
    expect(second.settings).toEqual(quiet);
    expect(activePushSubscriptions(db, NOW)).toEqual([second]);
  });

  test("the last failure is kept until a delivery or a new subscription", () => {
    const { db, phone } = databaseWithDevices();
    const endpoint = PushEndpoint.parse("https://push.example/a");
    savePushSubscription(db, phone, subscribing(endpoint.url, 1), NOW);
    recordPushFailure(db, { endpoint, message: "refused" }, NOW);
    const failure = () => pushSubscription(db, phone)?.lastFailure;
    expect(failure()).toEqual({ message: "refused", at: 100 });
    clearPushFailure(db, endpoint);
    expect(failure()).toBeNull();

    recordPushFailure(db, { endpoint, message: "refused" }, NOW);
    savePushSubscription(db, phone, subscribing(endpoint.url, 2), NOW);
    expect(failure()).toBeNull();
  });

  test("an endpoint moves to the device that subscribes with it", () => {
    const { db, phone, laptop } = databaseWithDevices();
    savePushSubscription(db, phone, subscribing("https://push.example/a", 1), NOW);
    savePushSubscription(db, laptop, subscribing("https://push.example/a", 1), NOW);
    expect(pushSubscription(db, phone)).toBeNull();
    expect(pushSubscription(db, laptop)).not.toBeNull();
  });

  test("revoked devices get no pushes and cannot subscribe", () => {
    const { db, phone, laptop } = databaseWithDevices();
    savePushSubscription(db, phone, subscribing("https://push.example/a", 1), NOW);
    savePushSubscription(db, laptop, subscribing("https://push.example/b", 2), NOW);
    revokeDevice(db, phone, NOW);
    expect(activeDevices(db, NOW)).toEqual([laptop]);
    expect(pushSubscription(db, phone)).toBeNull();
    expect(
      failureOf(() => savePushSubscription(db, phone, subscribing("https://push.example/a", 1), NOW)),
    ).toEqual({ kind: "device_not_found", device: phone });
    expect(
      failureOf(() => savePushSubscription(db, deviceId(99), subscribing("https://push.example/c", 3), NOW))
        .kind,
    ).toBe("device_not_found");
  });

  test("expired devices get no pushes", () => {
    const db = openMemoryDatabase();
    const expiresAt = NOW + 86400;
    const phone = addDevice(db, "Phone", 1);
    savePushSubscription(db, phone, subscribing("https://push.example/a", 1), NOW);

    expect(activeDevices(db, expiresAt - 1)).toEqual([phone]);
    expect(activeDevices(db, expiresAt)).toEqual([]);
  });

  test("unsubscribing and gone endpoints remove the subscription", () => {
    const { db, phone, laptop } = databaseWithDevices();
    savePushSubscription(db, phone, subscribing("https://push.example/a", 1), NOW);
    savePushSubscription(db, laptop, subscribing("https://push.example/b", 2), NOW);
    expect(deletePushSubscription(db, phone)).toBe(true);
    expect(deletePushSubscription(db, phone)).toBe(false);
    expect(deletePushEndpoint(db, PushEndpoint.parse("https://push.example/b"))).toBe(true);
    expect(activePushSubscriptions(db, NOW)).toEqual([]);
    expect(failureOf(() => setPushSettings(db, phone, DEFAULT_PUSH_SETTINGS))).toEqual({
      kind: "push_subscription_not_found",
      device: phone,
    });
  });
});
