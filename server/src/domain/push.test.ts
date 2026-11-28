import { describe, expect, test } from "bun:test";

import {
  AUTH_LEN,
  DEFAULT_PUSH_SETTINGS,
  MAX_ENDPOINT_LEN,
  P256DH_LEN,
  PushEndpoint,
  PushSubscriptionError,
  type PushSubscriptionProblem,
  allows,
  subscriptionKeys,
} from "./push.ts";

function problemOf(action: () => unknown): PushSubscriptionProblem {
  try {
    action();
  } catch (error) {
    if (error instanceof PushSubscriptionError) return error.problem;
    throw error;
  }
  throw new Error("expected a PushSubscriptionError");
}

describe("push", () => {
  test("endpoints are https urls with a host", () => {
    const endpoint = PushEndpoint.parse("https://fcm.googleapis.com/fcm/send/abc");
    expect(endpoint.origin()).toBe("https://fcm.googleapis.com");
    expect(PushEndpoint.parse("https://push.example:8443?x=1").origin()).toBe(
      "https://push.example:8443",
    );
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https:///path",
      "https://",
      "https://host/a b",
      "ftp://host",
    ]) {
      expect([bad, problemOf(() => PushEndpoint.parse(bad))]).toEqual([bad, "endpoint_not_https"]);
    }
    const long = `https://host/${"a".repeat(MAX_ENDPOINT_LEN)}`;
    expect(problemOf(() => PushEndpoint.parse(long))).toBe("endpoint_too_long");
  });

  test("keys must be an uncompressed point and a 16 byte secret", () => {
    const point = new Uint8Array(P256DH_LEN).fill(7);
    point[0] = 4;
    const secret = new Uint8Array(AUTH_LEN).fill(1);
    expect(() => subscriptionKeys(point, secret)).not.toThrow();
    expect(problemOf(() => subscriptionKeys(point.slice(0, 64), secret))).toBe("bad_p256dh");
    const compressed = Uint8Array.from(point);
    compressed[0] = 2;
    expect(problemOf(() => subscriptionKeys(compressed, secret))).toBe("bad_p256dh");
    expect(problemOf(() => subscriptionKeys(point, new Uint8Array(15).fill(1)))).toBe("bad_auth");
  });

  test("settings filter their kind", () => {
    const kinds = ["important_message", "agent_message", "awaiting_answer", "task_started", "completion", "task_finished"] as const;
    const allowed = (settings: typeof DEFAULT_PUSH_SETTINGS) => kinds.filter((kind) => allows(settings, kind));
    expect(allowed(DEFAULT_PUSH_SETTINGS)).toEqual(["important_message", "agent_message", "awaiting_answer", "completion"]);
    const none = { important: false, messages: false, started: false, completion: false, finished: false };
    expect(allowed(none)).toEqual([]);
    expect(allowed({ ...none, important: true })).toEqual(["important_message", "awaiting_answer"]);
    expect(allowed({ ...none, messages: true })).toEqual(["important_message", "agent_message"]);
    expect(allowed({ ...none, started: true })).toEqual(["task_started"]);
    expect(allowed({ ...none, completion: true })).toEqual(["completion"]);
    expect(allowed({ ...none, finished: true })).toEqual(["task_finished"]);
  });
});
