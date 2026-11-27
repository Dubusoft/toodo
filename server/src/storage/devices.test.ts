import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { type Device, DeviceLabel, LAST_SEEN_PRECISION, deviceId } from "../domain/device.ts";
import {
  authenticateDevice,
  createDevice,
  listDevices,
  markDeviceSeen,
  revokeDevice,
} from "./devices.ts";
import { StorageError } from "./errors.ts";
import { openMemoryDatabase } from "./testing.ts";

const PHONE = "0000000000000000000000000000000000000000000000000000000000000001";
const LAPTOP = "0000000000000000000000000000000000000000000000000000000000000002";
const DAY = 86_400;

let db: Database;

beforeEach(() => {
  db = openMemoryDatabase();
});

function add(name: string, tokenHash: string, at = 1_000): Device {
  return createDevice(
    db,
    { label: DeviceLabel.parse(name), tokenHash, scope: "full", lifetimeDays: null },
    at,
  );
}

function active(tokenHash: string, at: number): Device | null {
  const auth = authenticateDevice(db, tokenHash, at);
  return auth.kind === "active" ? auth.device : null;
}

test("a device authenticates by its token hash until it is revoked", () => {
  const phone = add("Phone", PHONE);
  const laptop = add("Laptop", LAPTOP);
  expect([phone.createdAt, phone.lastSeenAt, phone.revokedAt]).toEqual([1_000, 1_000, null]);
  expect([phone.expiresAt, phone.scope]).toEqual([null, "full"]);

  expect(authenticateDevice(db, PHONE, 1_000)).toEqual({
    kind: "active",
    device: phone,
    seenIsStale: false,
  });
  expect(authenticateDevice(db, "f".repeat(64), 1_000)).toEqual({ kind: "unknown" });

  const revoked = revokeDevice(db, phone.id, 2_000);
  expect(revoked.revokedAt).toBe(2_000);
  expect(authenticateDevice(db, PHONE, 2_000)).toEqual({ kind: "unknown" });
  expect(active(LAPTOP, 2_000)?.id).toBe(laptop.id);

  expect(revokeDevice(db, phone.id, 3_000).revokedAt).toBe(2_000);
  expect(() => revokeDevice(db, deviceId(99), 3_000)).toThrow(
    new StorageError({ kind: "device_not_found", device: 99 }),
  );
});

test("a token stops working once its lifetime is over", () => {
  const phone = createDevice(
    db,
    { label: DeviceLabel.parse("Phone"), tokenHash: PHONE, scope: "read_only", lifetimeDays: 2 },
    1_000,
  );
  expect(phone.expiresAt).toBe(1_000 + 2 * DAY);
  expect(phone.scope).toBe("read_only");
  expect(listDevices(db)).toEqual([phone]);

  expect(active(PHONE, 1_000 + 2 * DAY - 1)?.id).toBe(phone.id);
  expect(authenticateDevice(db, PHONE, 1_000 + 2 * DAY)).toEqual({
    kind: "expired",
    device: phone,
  });
});

test("last seen moves only once it is stale", () => {
  const phone = add("Phone", PHONE);

  const fresh = 1_000 + LAST_SEEN_PRECISION - 1;
  expect(authenticateDevice(db, PHONE, fresh)).toMatchObject({ kind: "active", seenIsStale: false });
  markDeviceSeen(db, phone.id, fresh);
  expect(listDevices(db)[0]?.lastSeenAt).toBe(1_000);

  const stale = 1_000 + LAST_SEEN_PRECISION;
  expect(authenticateDevice(db, PHONE, stale)).toMatchObject({ kind: "active", seenIsStale: true });
  markDeviceSeen(db, phone.id, stale);
  const seen = active(PHONE, stale);
  expect(seen?.lastSeenAt).toBe(stale);
  expect(listDevices(db)).toEqual([seen as Device]);

  // A second request that saw the same stale time does not move it again.
  markDeviceSeen(db, phone.id, stale + 1);
  expect(listDevices(db)[0]?.lastSeenAt).toBe(stale);
});

test("devices are listed active first, then by last seen", () => {
  const phone = add("Phone", PHONE);
  const laptop = add("Laptop", LAPTOP, 1_100);
  const names = () => listDevices(db).map((device) => device.label.value);
  expect(names()).toEqual(["Laptop", "Phone"]);
  revokeDevice(db, laptop.id, 1_100);
  expect(names()).toEqual(["Phone", "Laptop"]);
  expect(listDevices(db)[0]?.id).toBe(phone.id);
});

test("signing in again under the same name reuses the device", () => {
  const phone = add("Phone", PHONE);
  const laptop = add("Laptop", LAPTOP);

  const again = createDevice(
    db,
    { label: DeviceLabel.parse("Phone"), tokenHash: "3".repeat(64), scope: "read_only", lifetimeDays: 1 },
    2_000,
  );
  expect(again.id).toBe(phone.id);
  expect([again.createdAt, again.lastSeenAt]).toEqual([1_000, 2_000]);
  expect([again.expiresAt, again.scope]).toEqual([2_000 + DAY, "read_only"]);
  expect(authenticateDevice(db, PHONE, 2_000)).toEqual({ kind: "unknown" });
  expect(active("3".repeat(64), 2_000)?.id).toBe(phone.id);
  expect(active(LAPTOP, 2_000)?.id).toBe(laptop.id);
  expect(listDevices(db)).toHaveLength(2);

  // A revoked device stays revoked: signing in again under its name adds a device.
  revokeDevice(db, laptop.id, 2_000);
  const fresh = add("Laptop", "4".repeat(64), 2_000);
  expect(fresh.id).not.toBe(laptop.id);
  expect(listDevices(db)).toHaveLength(3);
});

test("signing in again revokes the other devices of that name", () => {
  // Devices registered before names were reused may share one.
  for (const [at, hash] of [
    [1_000, PHONE],
    [1_100, LAPTOP],
  ] as const) {
    db.run(
      `INSERT INTO devices (label, token_hash, created_at, last_seen_at, scope)
       VALUES ('Chrome on Windows', ?1, ?2, ?2, 'full')`,
      [hash, at],
    );
  }
  const newest = active(LAPTOP, 1_100);

  const again = add("Chrome on Windows", "3".repeat(64), 2_000);
  expect(newest?.id).toBe(again.id);
  expect(listDevices(db).map((device) => [device.id === again.id, device.revokedAt])).toEqual([
    [true, null],
    [false, 2_000],
  ]);
  expect(authenticateDevice(db, PHONE, 2_000)).toEqual({ kind: "unknown" });
});

test("a token hash belongs to one device", () => {
  add("Phone", PHONE);
  expect(() => add("Other", PHONE)).toThrow(/UNIQUE constraint failed: devices.token_hash/);
  expect(listDevices(db)).toHaveLength(1);
});

test("signing in again drops the push subscription of the lost state", () => {
  const phone = add("Phone", PHONE);
  const subscribe = (deviceId: number) =>
    db.run(
      `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
       VALUES (?, 'https://push.example/1', zeroblob(65), zeroblob(16), 1000)`,
      [deviceId],
    );
  const subscriptions = () =>
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM push_subscriptions").get()?.n;
  subscribe(phone.id);

  add("Phone", LAPTOP, 2_000);
  expect(subscriptions()).toBe(0);

  subscribe(phone.id);
  revokeDevice(db, phone.id, 3_000);
  expect(subscriptions()).toBe(0);
});
