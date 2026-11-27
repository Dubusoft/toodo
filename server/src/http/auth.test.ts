import { describe, expect, test } from "bun:test";

import { deviceId } from "../domain/device.ts";
import { ATTEMPT_WINDOW_MS, bearer, FailedAttempts, MAX_FAILURES, peerAddress, readOnlyAllows, sameSecret, tokenHash, tooMany } from "./auth.ts";
import { READ_COMMANDS } from "./rpc.ts";

const PHONE = "192.168.1.2";
const LAPTOP = "192.168.1.3";

describe("failed attempts", () => {
  test("an address is locked out after too many wrong tokens until its window ends", () => {
    let now = 1000;
    const attempts = new FailedAttempts(MAX_FAILURES, () => now);
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) attempts.record(PHONE);
    expect(attempts.lockedOut(PHONE)).toBeNull();
    now += 10_000;
    attempts.record(PHONE);
    expect(attempts.lockedOut(PHONE)).toBe(ATTEMPT_WINDOW_MS - 10_000);
    expect(attempts.lockedOut(LAPTOP)).toBeNull();

    now = 1000 + ATTEMPT_WINDOW_MS;
    expect(attempts.lockedOut(PHONE)).toBeNull();
    // A failure after the window starts counting anew.
    attempts.record(PHONE);
    expect(attempts.lockedOut(PHONE)).toBeNull();
  });

  test("addresses whose window ended are forgotten once many are tracked", () => {
    let now = 0;
    const attempts = new FailedAttempts(MAX_FAILURES, () => now);
    for (let host = 0; host < 1024; host += 1) attempts.record(`10.0.${host >> 8}.${host & 255}`);
    now = ATTEMPT_WINDOW_MS;
    attempts.record(PHONE);
    expect(attempts.size).toBe(1);
  });

  test("the oldest address makes room when every window is still open", () => {
    let now = 0;
    const attempts = new FailedAttempts(MAX_FAILURES, () => now);
    for (let host = 0; host < 1034; host += 1) {
      now = host;
      attempts.record(`10.0.${host >> 8}.${host & 255}`);
    }
    expect(attempts.size).toBe(1024);
    expect(attempts.lockedOut("10.0.0.0")).toBeNull();
  });

  test("the answer says how long to wait", async () => {
    const response = tooMany("API", 1500);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.text()).toContain("too many requests");
  });
});

describe("tokens", () => {
  test("tokens are stored as their sha256", () => {
    expect(tokenHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("the bearer scheme is matched without regard to case", () => {
    const headers = (value: string) => new Headers({ authorization: value });
    expect(bearer(headers("Bearer abc"))).toBe("abc");
    expect(bearer(headers("  bearer   abc  "))).toBe("abc");
    expect(bearer(headers("Basic abc"))).toBe("not_bearer");
    expect(bearer(headers("Bearer "))).toBe("not_bearer");
    expect(bearer(new Headers())).toBe("no_header");
  });

  test("secrets compare equal only when they are the same", () => {
    expect(sameSecret("web", "web")).toBe(true);
    expect(sameSecret("web", "wec")).toBe(false);
    expect(sameSecret("web", "webs")).toBe(false);
  });

  test("an IPv4-mapped address counts as its IPv4 address", () => {
    expect(peerAddress("::ffff:192.168.1.2")).toBe(PHONE);
    expect(peerAddress("::1")).toBe("::1");
    expect(peerAddress(null)).toBe("0.0.0.0");
  });
});

test("a read-only device may read, keep its notifications, and revoke itself", () => {
  const me = deviceId(3);
  const allows = (method: string, path: string) => readOnlyAllows(method, path, me, READ_COMMANDS);
  expect(allows("GET", "/api/events")).toBe(true);
  expect(allows("GET", "/api/backups/export")).toBe(true);
  expect(allows("POST", "/api/rpc/list_tasks")).toBe(true);
  expect(allows("PUT", "/api/push/subscription")).toBe(true);
  expect(allows("POST", "/api/devices/3/revoke")).toBe(true);
  expect(allows("POST", "/api/devices/4/revoke")).toBe(false);
  expect(allows("POST", "/api/rpc/create_task")).toBe(false);
  expect(allows("POST", "/api/rpc/mcp_server_info")).toBe(false);
  expect(allows("POST", "/api/rpc/list%5Ftasks")).toBe(false);
  expect(allows("POST", "/api/backups/restore")).toBe(false);
  expect(allows("POST", "/api/stream-tickets")).toBe(false);
});
