// Devices of the server and the hashes of their access tokens. Every function takes the
// time it acts at (`at`, Unix seconds) from the caller.

import type { Database } from "bun:sqlite";

import {
  type Device,
  type DeviceId,
  DeviceLabel,
  type DeviceScope,
  LAST_SEEN_PRECISION,
  deviceId,
  deviceScopeAsStr,
  expiry,
  isExpiredAt,
  parseDeviceScope,
} from "../domain/device.ts";
import { debugString } from "../domain/rust.ts";
import { StorageError } from "./errors.ts";

const COLUMNS = "id, label, created_at, last_seen_at, revoked_at, expires_at, scope";

interface DeviceRow {
  id: number;
  label: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  expires_at: number | null;
  scope: string;
}

function device(row: DeviceRow): Device {
  let label: DeviceLabel;
  try {
    label = DeviceLabel.parse(row.label);
  } catch (error) {
    throw new StorageError({ kind: "invalid_data", reason: String(error) });
  }
  const scope = parseDeviceScope(row.scope);
  if (scope === null) {
    throw new StorageError({
      kind: "invalid_data",
      reason: `unknown device scope ${debugString(row.scope)}`,
    });
  }
  return {
    id: deviceId(row.id),
    label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    scope,
  };
}

function find(db: Database, id: DeviceId): Device {
  const row = db.query<DeviceRow, [number]>(`SELECT ${COLUMNS} FROM devices WHERE id = ?`).get(id);
  if (row === null) {
    throw new StorageError({ kind: "device_not_found", device: id });
  }
  return device(row);
}

/** What a token hash stands for, see `authenticateDevice`. */
export type DeviceAuth =
  /**
   * The token of an active device. `seenIsStale` tells that its last-seen time is
   * `LAST_SEEN_PRECISION` seconds old, so `markDeviceSeen` should move it.
   */
  | { kind: "active"; device: Device; seenIsStale: boolean }
  /** The token of a device that is not revoked but has expired. */
  | { kind: "expired"; device: Device }
  /** No device that is not revoked has this token. */
  | { kind: "unknown" };

export interface NewDevice {
  label: DeviceLabel;
  tokenHash: string;
  scope: DeviceScope;
  /** Days until the token expires; `null` never. */
  lifetimeDays: number | null;
}

/**
 * Registers a device whose access token hashes to `tokenHash`; it counts as seen at `at`.
 *
 * A device that is not revoked and has the same name is the same browser signing in
 * again, e.g. after it lost its stored token: the most recently seen one keeps its id and
 * takes the new token, scope, and lifetime, so its old token stops working and its push
 * subscription, which belonged to the lost state, is dropped. Any other device that is
 * not revoked and has that name is revoked, so repeated sign-ins leave one.
 */
export function createDevice(db: Database, created: NewDevice, at: number): Device {
  const expiresAt = expiry(at, created.lifetimeDays);
  return db.transaction(() => {
    const namesakes = db
      .query<{ id: number }, [string]>(
        `SELECT id FROM devices WHERE label = ? AND revoked_at IS NULL
         ORDER BY last_seen_at DESC, id DESC`,
      )
      .all(created.label.value)
      .map((row) => row.id);
    const [kept, ...others] = namesakes;
    let id: number;
    if (kept === undefined) {
      id = Number(
        db.run(
          `INSERT INTO devices (label, token_hash, created_at, last_seen_at, expires_at, scope)
           VALUES (?1, ?2, ?3, ?3, ?4, ?5)`,
          [created.label.value, created.tokenHash, at, expiresAt, deviceScopeAsStr(created.scope)],
        ).lastInsertRowid,
      );
    } else {
      db.run(
        `UPDATE devices SET token_hash = ?2, last_seen_at = ?3, expires_at = ?4, scope = ?5
         WHERE id = ?1`,
        [kept, created.tokenHash, at, expiresAt, deviceScopeAsStr(created.scope)],
      );
      for (const other of others) {
        db.run("UPDATE devices SET revoked_at = ?2 WHERE id = ?1", [other, at]);
      }
      for (const namesake of namesakes) {
        db.run("DELETE FROM push_subscriptions WHERE device_id = ?", [namesake]);
      }
      id = kept;
    }
    return find(db, deviceId(id));
  })();
}

/** Every device, revoked ones last, then the most recently seen first. */
export function listDevices(db: Database): Device[] {
  return db
    .query<DeviceRow, []>(
      `SELECT ${COLUMNS} FROM devices
       ORDER BY revoked_at IS NOT NULL, last_seen_at DESC, id DESC`,
    )
    .all()
    .map(device);
}

/**
 * The device whose token hashes to `tokenHash`, as of `at`. It only reads, so it runs on
 * the reader and leaves moving the last-seen time to `markDeviceSeen`.
 */
export function authenticateDevice(db: Database, tokenHash: string, at: number): DeviceAuth {
  const row = db
    .query<DeviceRow, [string]>(
      `SELECT ${COLUMNS} FROM devices WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .get(tokenHash);
  if (row === null) {
    return { kind: "unknown" };
  }
  const found = device(row);
  if (isExpiredAt(found, at)) {
    return { kind: "expired", device: found };
  }
  return { kind: "active", device: found, seenIsStale: at - found.lastSeenAt >= LAST_SEEN_PRECISION };
}

/**
 * Marks the device as seen at `at`, once its last-seen time is `LAST_SEEN_PRECISION`
 * seconds old; requests that race to it write it once.
 */
export function markDeviceSeen(db: Database, id: DeviceId, at: number): void {
  db.run("UPDATE devices SET last_seen_at = ?2 WHERE id = ?1 AND last_seen_at <= ?2 - ?3", [
    id,
    at,
    LAST_SEEN_PRECISION,
  ]);
}

/**
 * Revokes the device's token for good, and drops its push subscription. Revoking it again
 * keeps the first time.
 */
export function revokeDevice(db: Database, id: DeviceId, at: number): Device {
  return db.transaction(() => {
    db.run("UPDATE devices SET revoked_at = coalesce(revoked_at, ?2) WHERE id = ?1", [id, at]);
    db.run("DELETE FROM push_subscriptions WHERE device_id = ?", [id]);
    return find(db, id);
  })();
}
