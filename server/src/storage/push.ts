// Web Push subscriptions of devices and their notification settings. Port of
// `src-tauri/src/storage/push.rs`. Functions that act at a time take it (`at`, Unix
// seconds) from the caller.

import type { Database } from "bun:sqlite";

import { type DeviceId, deviceId } from "../domain/device.ts";
import {
  PushEndpoint,
  type PushSettings,
  type PushSubscription,
  PushSubscriptionError,
  type SubscriptionKeys,
  subscriptionKeys,
} from "../domain/push.ts";
import { StorageError } from "./errors.ts";

const COLUMNS =
  "device_id, endpoint, p256dh, auth, completion, created_at, last_failure, last_failure_at, messages";

interface SubscriptionRow {
  device_id: number;
  endpoint: string;
  p256dh: Uint8Array;
  auth: Uint8Array;
  completion: number;
  created_at: number;
  last_failure: string | null;
  last_failure_at: number | null;
  messages: number;
}

function subscription(row: SubscriptionRow): PushSubscription {
  let endpoint: PushEndpoint;
  let keys: SubscriptionKeys;
  try {
    endpoint = PushEndpoint.parse(row.endpoint);
    keys = subscriptionKeys(row.p256dh, row.auth);
  } catch (error) {
    if (error instanceof PushSubscriptionError) {
      throw new StorageError({ kind: "invalid_data", reason: error.message });
    }
    throw error;
  }
  return {
    device: deviceId(row.device_id),
    endpoint,
    keys,
    settings: { completion: row.completion !== 0, messages: row.messages !== 0 },
    createdAt: row.created_at,
    lastFailure:
      row.last_failure !== null && row.last_failure_at !== null
        ? { message: row.last_failure, at: row.last_failure_at }
        : null,
  };
}

function find(db: Database, device: DeviceId): PushSubscription | null {
  const row = db
    .query<SubscriptionRow, [number]>(`SELECT ${COLUMNS} FROM push_subscriptions WHERE device_id = ?1`)
    .get(device);
  return row === null ? null : subscription(row);
}

function found(db: Database, device: DeviceId): PushSubscription {
  const saved = find(db, device);
  if (saved === null) {
    throw new StorageError({ kind: "push_subscription_not_found", device });
  }
  return saved;
}

/** What a device subscribes with: its push service URL and its keys. */
export interface NewPushSubscription {
  endpoint: PushEndpoint;
  keys: SubscriptionKeys;
}

/**
 * Subscribes the device at `at`, replacing its earlier subscription but keeping its
 * settings. An endpoint another device had (the same browser signed in again as a new
 * device) moves to this one.
 */
export function savePushSubscription(
  db: Database,
  device: DeviceId,
  created: NewPushSubscription,
  at: number,
): PushSubscription {
  return db.transaction(() => {
    const row = db
      .query<{ active: number }, [number]>(
        "SELECT revoked_at IS NULL AS active FROM devices WHERE id = ?1",
      )
      .get(device);
    if (row === null || row.active === 0) {
      throw new StorageError({ kind: "device_not_found", device });
    }
    db.run("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND device_id <> ?2", [
      created.endpoint.url,
      device,
    ]);
    db.run(
      `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint,
           p256dh = excluded.p256dh, auth = excluded.auth,
           created_at = excluded.created_at,
           last_failure = NULL, last_failure_at = NULL`,
      [device, created.endpoint.url, created.keys.p256dh, created.keys.auth, at],
    );
    return found(db, device);
  })();
}

export function pushSubscription(db: Database, device: DeviceId): PushSubscription | null {
  return find(db, device);
}

/** Every subscription of a device that is neither revoked nor expired at `at`. */
export function activePushSubscriptions(db: Database, at: number): PushSubscription[] {
  return db
    .query<SubscriptionRow, [number]>(
      `SELECT ${COLUMNS} FROM push_subscriptions
       WHERE device_id IN (SELECT id FROM devices WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?1))
       ORDER BY device_id`,
    )
    .all(at)
    .map(subscription);
}

/** Unsubscribes the device; `false` when it had no subscription. */
export function deletePushSubscription(db: Database, device: DeviceId): boolean {
  return db.run("DELETE FROM push_subscriptions WHERE device_id = ?1", [device]).changes > 0;
}

/** Drops the subscription at `endpoint`, which its push service reported gone. */
export function deletePushEndpoint(db: Database, endpoint: PushEndpoint): boolean {
  return db.run("DELETE FROM push_subscriptions WHERE endpoint = ?1", [endpoint.url]).changes > 0;
}

/** Why the latest notification did not reach the subscription at `endpoint`, and when. */
export interface PushFailureReport {
  endpoint: PushEndpoint;
  message: string;
}

/** Records why the latest notification did not reach the subscription at `endpoint`. */
export function recordPushFailure(db: Database, failure: PushFailureReport, at: number): void {
  db.run(
    `UPDATE push_subscriptions SET last_failure = ?2, last_failure_at = ?3
     WHERE endpoint = ?1`,
    [failure.endpoint.url, failure.message, at],
  );
}

/** Forgets the last failure of the subscription at `endpoint`: a notification reached it. */
export function clearPushFailure(db: Database, endpoint: PushEndpoint): void {
  db.run(
    `UPDATE push_subscriptions SET last_failure = NULL, last_failure_at = NULL
     WHERE endpoint = ?1`,
    [endpoint.url],
  );
}

export function setPushSettings(
  db: Database,
  device: DeviceId,
  settings: PushSettings,
): PushSubscription {
  return db.transaction(() => {
    db.run("UPDATE push_subscriptions SET completion = ?2, messages = ?3 WHERE device_id = ?1", [
      device,
      settings.completion ? 1 : 0,
      settings.messages ? 1 : 0,
    ]);
    return found(db, device);
  })();
}
