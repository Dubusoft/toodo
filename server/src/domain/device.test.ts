import { describe, expect, test } from "bun:test";

import {
  type Device,
  DeviceLabel,
  DeviceLabelError,
  type DeviceLabelProblem,
  type DeviceScope,
  deviceId,
  deviceScopeAsStr,
  expiry,
  isExpiredAt,
  parseDeviceScope,
} from "./device.ts";

const DAY = 24 * 60 * 60;

function labelProblem(raw: string): DeviceLabelProblem {
  try {
    DeviceLabel.parse(raw);
  } catch (error) {
    if (error instanceof DeviceLabelError) return error.problem;
    throw error;
  }
  throw new Error("expected a DeviceLabelError");
}

describe("device", () => {
  test("a token expires at its expiry and scopes round trip", () => {
    expect(expiry(1_000, null)).toBeNull();
    expect(expiry(1_000, 2)).toBe(1_000 + 2 * DAY);
    const device: Device = {
      id: deviceId(1),
      label: DeviceLabel.parse("Phone"),
      createdAt: 0,
      lastSeenAt: 0,
      revokedAt: null,
      expiresAt: 100,
      scope: "read_only",
    };
    expect(isExpiredAt(device, 99)).toBe(false);
    expect(isExpiredAt(device, 100)).toBe(true);
    expect(isExpiredAt({ ...device, expiresAt: null }, Number.MAX_SAFE_INTEGER)).toBe(false);
    for (const scope of ["full", "read_only"] satisfies DeviceScope[]) {
      expect(parseDeviceScope(deviceScopeAsStr(scope))).toBe(scope);
    }
    expect(parseDeviceScope("admin")).toBeNull();
  });

  test("labels are trimmed single lines of bounded length", () => {
    expect(DeviceLabel.parse("  Phone  ").value).toBe("Phone");
    expect(labelProblem(" \t")).toBe("empty");
    expect(labelProblem("Work\nlaptop")).toBe("control_character");
    const longest = "\u{d3f0}".repeat(DeviceLabel.MAX_CHARS);
    expect(DeviceLabel.parse(longest).value).toBe(longest);
    expect(labelProblem(`${longest}x`)).toBe("too_long");
  });
});
