// Devices that use `toodo-server`: each browser or client gets its own access token, so one
// device can be revoked without changing the token of every other one. The server keeps
// only a hash of each token.

import { charCount, isControl, trim } from "./rust.ts";

/** A device's stable id, for anything kept per device (e.g. notification subscriptions). */
export type DeviceId = number & { readonly __brand: "DeviceId" };

export function deviceId(id: number): DeviceId {
  return id as DeviceId;
}

export type Device = {
  readonly id: DeviceId;
  readonly label: DeviceLabel;
  /** Unix seconds. */
  readonly createdAt: number;
  /** When the device last made a request, to within `LAST_SEEN_PRECISION` seconds. */
  readonly lastSeenAt: number;
  /** Set once the device's token stops working; it never works again. */
  readonly revokedAt: number | null;
  /** When the device's token stops working on its own, in Unix seconds; `null` for a token
   * that does not expire. */
  readonly expiresAt: number | null;
  readonly scope: DeviceScope;
};

/** Whether the token has expired at `at` (Unix seconds). */
export function isExpiredAt(device: Device, at: number): boolean {
  return device.expiresAt !== null && at >= device.expiresAt;
}

/** What a device's token may do: `full` is everything the shared web token may do, except
 * registering devices; `read_only` is only reading: requests that change data are refused. */
export type DeviceScope = "full" | "read_only";

export function deviceScopeAsStr(scope: DeviceScope): string {
  switch (scope) {
    case "full":
      return "full";
    case "read_only":
      return "read";
  }
}

export function parseDeviceScope(stored: string): DeviceScope | null {
  switch (stored) {
    case "full":
      return "full";
    case "read":
      return "read_only";
    default:
      return null;
  }
}

/** How stale a device's last-seen time may get, so that a request writes it at most this
 * often instead of on every request. */
export const LAST_SEEN_PRECISION = 60;

/** How many days a new device's token lasts when its registration does not say. */
export const DEFAULT_LIFETIME_DAYS = 90;

/** The longest lifetime a registration may ask for, in days; longer ones register a token
 * that does not expire instead. */
export const MAX_LIFETIME_DAYS = 3650;

const DAY = 24 * 60 * 60;

/** When a token issued at `at` for `days` days expires; `null` days never expire. */
export function expiry(at: number, days: number | null): number | null {
  return days === null ? null : at + days * DAY;
}

export type DeviceLabelProblem = "empty" | "too_long" | "control_character";

export class DeviceLabelError extends Error {
  readonly problem: DeviceLabelProblem;

  constructor(problem: DeviceLabelProblem) {
    super(deviceLabelMessage(problem));
    this.name = "DeviceLabelError";
    this.problem = problem;
  }
}

function deviceLabelMessage(problem: DeviceLabelProblem): string {
  switch (problem) {
    case "empty":
      return "device name is empty";
    case "too_long":
      return `device name is longer than ${DeviceLabel.MAX_CHARS} characters`;
    case "control_character":
      return "device name must be a single line of text";
  }
}

/** A device's name, as its owner recognizes it: trimmed, not empty, one line, at most
 * `DeviceLabel.MAX_CHARS` characters. */
export class DeviceLabel {
  static readonly MAX_CHARS = 80;

  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  static parse(raw: string): DeviceLabel {
    const label = trim(raw);
    if (label === "") throw new DeviceLabelError("empty");
    if (charCount(label) > DeviceLabel.MAX_CHARS) throw new DeviceLabelError("too_long");
    if ([...label].some(isControl)) throw new DeviceLabelError("control_character");
    return new DeviceLabel(label);
  }
}
