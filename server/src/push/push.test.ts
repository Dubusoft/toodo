import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { deviceId } from "../domain/device.ts";
import { taskId } from "../domain/model.ts";
import type { TaskStatus } from "../domain/status.ts";
import { StorageError } from "../storage/errors.ts";
import { activePushSubscriptions, pushSubscription } from "../storage/push.ts";
import { openMemoryDatabase } from "../storage/testing.ts";
import { type WatchedTask, Watch, agentMessageAlert, testAlert } from "./alerts.ts";
import {
  Http,
  PushInputError,
  PushTestError,
  PushWorker,
  RETRY_DELAYS_MS,
  deliver,
  parseSubscription,
  sendTest,
} from "./push.ts";
import { Browser, FakeTransport, subscribed, testPush } from "./testing.ts";

function failures(db: Database): (string | null)[] {
  return activePushSubscriptions(db, 100).map((subscription) => subscription.lastFailure?.message ?? null);
}

function endpoints(db: Database): string[] {
  return activePushSubscriptions(db, 100).map((subscription) => subscription.endpoint.url);
}

async function errorOf(action: Promise<unknown>): Promise<Error> {
  try {
    await action;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("push delivery", () => {
  test("transient failures are retried and the latest failure is kept", async () => {
    const transport = new FakeTransport();
    const push = await testPush(transport);
    const db = openMemoryDatabase();
    await subscribed(db, "Phone", "https://push.example/phone");

    // A busy push service, then an unreachable one, then the message gets through.
    transport.statuses.push(503, 0);
    expect(await deliver(db, push, [testAlert()])).toBe(1);
    expect(transport.requests.length).toBe(3);
    expect(failures(db)).toEqual([null]);

    // A refusal that would not change is not tried again, and is kept.
    transport.statuses.push(400);
    expect(await deliver(db, push, [testAlert()])).toBe(0);
    expect(transport.requests.length).toBe(4);
    expect(failures(db)).toEqual(["the push service refused the notification (400): nope"]);

    // An unreachable push service gets every retry, and the device's other alerts wait.
    transport.statuses.push(...new Array<number>(RETRY_DELAYS_MS.length + 1).fill(0));
    expect(await deliver(db, push, [testAlert(), testAlert()])).toBe(0);
    expect(transport.requests.length).toBe(4 + RETRY_DELAYS_MS.length + 1);
    expect(failures(db)).toEqual(["cannot reach the push service: connection refused"]);

    // The next message that gets through clears it.
    expect(await deliver(db, push, [testAlert()])).toBe(1);
    expect(failures(db)).toEqual([null]);
  });

  test("a stalled push service holds up neither other devices nor the next change", async () => {
    const deadline = 200;
    const transport = new FakeTransport();
    transport.stalled.add("https://push.example/stalled");
    const push = await testPush(transport, deadline);
    const db = openMemoryDatabase();
    // The stalled device comes first, as serial delivery would reach it first.
    await subscribed(db, "Stalled", "https://push.example/stalled");
    await subscribed(db, "Phone", "https://push.example/phone");

    const start = performance.now();
    expect(await deliver(db, push, [testAlert()])).toBe(1);
    const took = performance.now() - start;
    expect(took).toBeGreaterThanOrEqual(deadline - 1);
    expect(took).toBeLessThan(deadline + 1000);
    expect(transport.requests.map((request) => request.endpoint)).toEqual([
      "https://push.example/stalled",
      "https://push.example/phone",
    ]);
    expect(failures(db)).toEqual(["cannot reach the push service: no answer within 0.2 seconds", null]);

    // The next change reaches the phone again; the stalled device holds it up no longer
    // than the deadline.
    expect(await deliver(db, push, [testAlert()])).toBe(1);
    expect(transport.requests.filter((request) => request.endpoint === "https://push.example/phone").length).toBe(2);
  });

  test("nothing is posted to an endpoint off the public internet", async () => {
    const transport = new FakeTransport();
    const push = await testPush(transport);
    const db = openMemoryDatabase();
    // Subscriptions stored before endpoints were checked.
    await subscribed(db, "Metadata", "https://169.254.169.254/latest");
    await subscribed(db, "Loopback", "https://[::1]:8443/push");

    expect(await deliver(db, push, [testAlert()])).toBe(0);
    expect(transport.requests).toEqual([]);
    const refused = "push endpoint must be on a public address";
    expect(failures(db)).toEqual([refused, refused]);
  });

  test("http resolves push services to public addresses only", async () => {
    const http = new Http();
    expect(await errorOf(http.admit("localhost"))).toHaveProperty(
      "message",
      "push endpoint host localhost has no public address",
    );
    // A service listening on loopback never sees a connection.
    let connections = 0;
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open: () => void (connections += 1), data: () => {} },
    });
    try {
      const posted = http.post(
        {
          endpoint: `https://localhost:${listener.port}/push`,
          authorization: "",
          urgency: "normal",
          ttl: 0,
          body: new Uint8Array(),
        },
        new AbortController().signal,
      );
      expect(await errorOf(posted)).toBeInstanceOf(Error);
      expect(connections).toBe(0);
    } finally {
      listener.stop(true);
    }
  });

  test("alerts reach the subscriptions that want them and gone ones are dropped", async () => {
    const transport = new FakeTransport();
    const push = await testPush(transport);
    const db = openMemoryDatabase();
    const phone = await subscribed(db, "Phone", "https://push.example/phone");
    await subscribed(db, "Laptop", "https://push.example/laptop", { completion: false, messages: true });
    const watch = new Watch();
    watch.tasks([{ id: taskId(4), status: "in_progress", title: "Task" }]);
    const alerts = watch.tasks([{ id: taskId(4), status: "in_review", title: "Task" }]);

    expect(await deliver(db, push, alerts)).toBe(1);
    const request = transport.requests.shift()!;
    expect(request.endpoint).toBe("https://push.example/phone");
    expect(request.urgency).toBe("normal");
    expect(request.ttl).toBe(86_400);
    expect(request.authorization.startsWith("vapid t=")).toBe(true);
    expect(await phone.decryptJson(request.body)).toEqual({
      title: "Task awaiting completion",
      body: "#4 Task",
      tag: "task-4-completion",
      taskId: 4,
    });

    // The laptop's push service forgot it: it is dropped, and the phone keeps going.
    transport.statusesFor.set("https://push.example/laptop", [410]);
    expect(await deliver(db, push, [testAlert()])).toBe(1);
    expect(endpoints(db)).toEqual(["https://push.example/phone"]);
  });
});

describe("push test notifications", () => {
  test("a test notification reaches the device and clears its last failure", async () => {
    const transport = new FakeTransport();
    const push = await testPush(transport);
    const db = openMemoryDatabase();
    const phone = await subscribed(db, "Phone", "https://push.example/phone");
    const device = deviceId(1);

    transport.statuses.push(400);
    const refused = await errorOf(sendTest(db, push, device));
    expect(refused).toBeInstanceOf(PushTestError);
    expect((refused as PushTestError).kind).toBe("external");
    expect(refused.message).toBe(
      "the push service refused the notification (400): nope; send a test notification again later, or disable and enable notifications on this device to subscribe it anew",
    );
    expect(pushSubscription(db, device)?.lastFailure?.message).toBe(
      "the push service refused the notification (400): nope",
    );

    await sendTest(db, push, device);
    expect(pushSubscription(db, device)?.lastFailure).toBeNull();
    const request = transport.requests.at(-1)!;
    expect(request.urgency).toBe("high");
    expect(await phone.decryptJson(request.body)).toEqual({
      title: "Toodo notifications are on",
      body: "This device will get notifications even while Toodo is closed.",
      tag: "test",
      taskId: null,
    });
  });

  test("a gone subscription is dropped and a device without one is told so", async () => {
    const transport = new FakeTransport();
    const push = await testPush(transport);
    const db = openMemoryDatabase();
    await subscribed(db, "Phone", "https://push.example/phone");

    transport.statuses.push(410);
    const gone = await errorOf(sendTest(db, push, deviceId(1)));
    expect((gone as PushTestError).kind).toBe("not_found");
    expect(pushSubscription(db, deviceId(1))).toBeNull();
    const missing = await errorOf(sendTest(db, push, deviceId(1)));
    expect(missing).toBeInstanceOf(StorageError);
    expect((missing as StorageError).failure).toEqual({ kind: "push_subscription_not_found", device: 1 });
  });
});

describe("push subscriptions from browsers", () => {
  test("a browser's subscription is checked before it is stored", async () => {
    const browser = await Browser.create();
    const parsed = await parseSubscription(browser.json("https://push.example/phone"));
    expect(parsed.endpoint.url).toBe("https://push.example/phone");
    expect(parsed.keys.p256dh).toEqual(browser.publicKey);

    const input = browser.json("https://push.example/phone");
    const messageOf = async (changed: typeof input) => (await errorOf(parseSubscription(changed))).message;
    expect(await messageOf({ ...input, endpoint: "http://push.example/phone" })).toBe(
      "push endpoint must be an https URL",
    );
    expect(await messageOf({ ...input, keys: { ...input.keys, auth: "not base64!" } })).toBe(
      "push subscription key auth is not base64url",
    );
    const offCurve = new Uint8Array(65).fill(1);
    offCurve[0] = 4;
    expect(await messageOf({ ...input, keys: { ...input.keys, p256dh: Buffer.from(offCurve).toString("base64url") } })).toBe(
      "push subscription key p256dh is not a point on P-256",
    );
    expect(await errorOf(parseSubscription({ ...input, endpoint: "ftp://x" }))).toBeInstanceOf(PushInputError);
  });

  test("only endpoints the server may post to are admitted", async () => {
    const push = await testPush(new FakeTransport());
    const admit = async (url: string) => push.admit((await parseSubscription((await Browser.create()).json(url))).endpoint);
    expect(await admit("https://fcm.googleapis.com/fcm/send/abc")).toBeNull();
    expect(await admit("https://private.example/push")).toBe("push endpoint host private.example has no public address");
    expect(await admit("https://user:pw@push.example/push")).toBe(
      "push endpoint must not carry credentials or a fragment",
    );
    expect(await admit("https://push.example/push#x")).toBe("push endpoint must not carry credentials or a fragment");
    expect(await admit("https://10.0.0.1/push")).toBe("push endpoint must be on a public address");
  });
});

describe("push worker", () => {
  test("changes from agents notify, changes from the app only move the baseline", async () => {
    const transport = new FakeTransport();
    const push = await testPush(transport);
    const db = openMemoryDatabase();
    const phone = await subscribed(db, "Phone", "https://push.example/phone");
    let tasks: WatchedTask[] = [{ id: taskId(1), status: "in_progress", title: "Ship" }];
    const set = (status: TaskStatus) => {
      tasks = [{ id: taskId(1), status, title: "Ship" }];
    };
    const worker = new PushWorker(db, push, () => tasks);

    set("in_review");
    worker.tasksSeen();
    await worker.idle();
    expect(transport.requests).toEqual([]);

    set("in_progress");
    worker.tasksSeen();
    set("in_review");
    worker.tasksChanged();
    worker.alert(agentMessageAlert("Helper", { channel: "work", thread: null }, 9, "Done"));
    await worker.idle();
    expect(transport.requests.length).toBe(2);
    const tags = [];
    for (const request of transport.requests) {
      tags.push(((await phone.decryptJson(request.body)) as { tag: string }).tag);
    }
    expect(tags).toEqual(["task-1-completion", "chat-9"]);
  });
});
