import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decisionAnswerText, decisionDeliveryTick, queueDecisionAnswer, reconcileDecisionDeliveries, reconcileDecisionsAtStart, recordAnswerRevision } from "../src/decision-delivery.ts";
import { decisionTargetOf, readDecisions } from "../src/decision-store.ts";
import { closeOwnerDecision, type DecisionContext, openLaneDecision, openOwnerDecision } from "../src/owner-decisions.ts";
import { serializeDecisionText, type DecisionChoices } from "../src/runner/decision-text.ts";
import { ackLaneMessage, SqliteLaneMessages, updateLaneMessage } from "../src/lane-messages.ts";
import type { ToodoChat, ToodoPlace } from "../src/messenger/toodo-chat.ts";
import { storePath } from "./fakes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "owner-decisions-"));
  dirs.push(dir);
  return dir;
};

const choices: DecisionChoices = {
  question: "Which path should we take?",
  options: ["Use the existing API", "Build a replacement"],
  recommend: 1,
  reason: "It is smaller and already supported.",
  waiting: "The implementation choice",
  blocking: true,
};

/** A Toodo chat that keeps what Dori posts; task 77's thread is thread 42. */
const fakeChat = () => {
  const posts: { place: ToodoPlace; body: string; buttons: string[] }[] = [];
  const chat: Pick<ToodoChat, "reply" | "taskThread"> = {
    reply: async (place, body, _handles, _attachments, actions = []) => {
      posts.push({ place, body, buttons: actions.map((a) => a.key) });
      return { id: 900 + posts.length, place, author: "agent", body, attachments: [] };
    },
    taskThread: async (task) => ({ kind: "thread", id: task === 77 ? 42 : 1 }),
  };
  return { chat, posts };
};

const context = (dir: string, chat = fakeChat().chat): DecisionContext => ({
  config: { stateDir: dir, displayTimeZone: "UTC" }, toodo: () => chat, now: () => 1_800_000_000_000, home: "/home/test",
});

const open = (ctx: DecisionContext, extra: Partial<Parameters<typeof openOwnerDecision>[1]> = {}) =>
  openOwnerDecision(ctx, { ...choices, source: "lead", ...extra });

const laneOf = (key: string, extra: { runner?: string; lastRecoveryAt?: number; openedAt?: string } = {}) =>
  ({ key, thread: "toodo:thread/22", runner: "mini", lastRecoveryAt: 5, openedAt: "2026-11-13T00:00:00.000Z", ...extra });

const openLane = async (ctx: DecisionContext, key: string) => {
  const opened = await openLaneDecision(ctx, laneOf(key), { id: `row-${key}`, text: serializeDecisionText(choices) });
  if (!opened) throw new Error("expected a decision card");
  return opened.decision.id;
};

const answer = (key: string, choice: number | undefined, edit = 0, message = "m1", extra: { lastRecoveryAt?: number } = {}) => ({
  channel: "toodo:thread/1", message, edit, content: choice === undefined ? "" : String(choice), ...(choice !== undefined ? { choice } : {}),
  target: decisionTargetOf(laneOf(key, extra)),
});

test("a lane decision pins its target; answer revisions count from r1, drop a repeat, and refuse what is no direct answer", async () => {
  const dir = stateDir();
  const ctx = context(dir);
  const id = await openLane(ctx, "ap-955-1");
  expect(readDecisions(dir).decisions[0]?.target).toEqual({ lane: "ap-955-1", runner: "mini", generation: 5, openedAt: "2026-11-13T00:00:00.000Z" });
  const r1 = recordAnswerRevision(dir, id, answer("ap-955-1", 1), 10);
  expect(r1).toMatchObject({ kind: "recorded", revision: { rev: 1, choice: 1, delivery: { id: "decision-d1-r1", state: "intended" } } });
  expect(recordAnswerRevision(dir, id, answer("ap-955-1", 1), 11).kind).toBe("duplicate");
  expect(recordAnswerRevision(dir, id, { ...answer("ap-955-1", 1, 1), content: " 1 " }, 11).kind).toBe("duplicate");
  expect(recordAnswerRevision(dir, id, answer("ap-955-1", 3, 2), 12)).toEqual({ kind: "refused", reason: "choice must be 1-2" });
  expect(recordAnswerRevision(dir, id, answer("ap-955-1", 2, 2, "m1", { lastRecoveryAt: 6 }), 12)).toEqual({ kind: "refused", reason: "target changed since the question was asked" });
  expect(recordAnswerRevision(dir, id, answer("ap-955-1", undefined, 0, "m9"), 12).kind).toBe("refused");
  const lead = (await open(ctx, { lane: "ap-955-1", origin: "toodo:thread/22" })).decision.id;
  expect(recordAnswerRevision(dir, lead, answer("ap-955-1", 1), 12)).toEqual({ kind: "refused", reason: "not a lane decision" });
  const r2 = recordAnswerRevision(dir, id, answer("ap-955-1", 2, 2), 13);
  expect(r2).toMatchObject({ kind: "recorded", revision: { rev: 2, choice: 2 }, replaced: { rev: 1 } });
  expect(readDecisions(dir).decisions[0]?.revisions?.map((r) => r.delivery.state)).toEqual(["superseded", "intended"]);
});

test("queueing an answer writes decision-d<ID>-r<n> once, replaces a queued older one, and corrects or withdraws one the lane may have", async () => {
  const dir = stateDir();
  const store = new SqliteLaneMessages(storePath(dir));
  const id = await openLane(context(dir), "ap-955-1");
  recordAnswerRevision(dir, id, answer("ap-955-1", 1), 10);
  const q1 = queueDecisionAnswer(dir, store, id, 20);
  expect(q1).toMatchObject({ kind: "queued", message: { id: "decision-d1-r1", lane: "ap-955-1", state: "queued" } });
  expect(q1.kind === "queued" && q1.message.text).toBe("[dori] Owner answered d1 (Which path should we take?): 1. Use the existing API. Revision r1. Confirm with: ~/.dori/runner/bin/dori report ack decision-d1-r1");
  // A lane on the lead's own runner acks with the dori on its PATH.
  const asked = readDecisions(dir).decisions[0]!;
  const r1 = asked.revisions![0]!;
  expect(decisionAnswerText(asked, { ...r1, target: { ...r1.target, runner: "local" } })).toEndWith("Confirm with: dori report ack decision-d1-r1");
  expect(queueDecisionAnswer(dir, store, id, 21).kind).toBe("none");
  recordAnswerRevision(dir, id, answer("ap-955-1", 2, 1), 30);
  const q2 = queueDecisionAnswer(dir, store, id, 31);
  expect(store.get("decision-d1-r1")?.state).toBe("superseded");
  expect(q2.kind === "queued" && q2.message.text).toStartWith("[dori] Owner answered d1 (Which path should we take?): 2. Build a replacement. Revision r2.");
  updateLaneMessage(store, store.get("decision-d1-r2")!, { state: "delivered", deliveredAt: 32 }, 32);
  recordAnswerRevision(dir, id, answer("ap-955-1", 1, 2), 40);
  const q3 = queueDecisionAnswer(dir, store, id, 41);
  expect(q3).toMatchObject({ kind: "queued", replaces: 2 });
  expect(q3.kind === "queued" && q3.message.text).toContain("1. Use the existing API. Revision r3 replaces r2; follow r3. Confirm with: ~/.dori/runner/bin/dori report ack decision-d1-r3");
  expect(store.get("decision-d1-r2")?.state).toBe("delivered");
  recordAnswerRevision(dir, id, answer("ap-955-1", undefined, 3), 50);
  const q4 = queueDecisionAnswer(dir, store, id, 51);
  expect(q4.kind === "queued" && q4.message.text).toStartWith("[dori] Owner withdrew the answer to d1 (Which path should we take?). Revision r4 replaces r2:");
  expect(store.get("decision-d1-r3")?.state).toBe("superseded");
});

test("a withdrawal before anything reached the lane cancels the queued answer and sends nothing", async () => {
  const dir = stateDir();
  const store = new SqliteLaneMessages(storePath(dir));
  const id = await openLane(context(dir), "ap-955-1");
  recordAnswerRevision(dir, id, answer("ap-955-1", 2), 10);
  queueDecisionAnswer(dir, store, id, 11);
  recordAnswerRevision(dir, id, answer("ap-955-1", undefined, 1), 12);
  expect(queueDecisionAnswer(dir, store, id, 13)).toEqual({ kind: "cancelled", reason: "withdrawn before anything reached the lane" });
  expect(store.list().map((m) => [m.id, m.state])).toEqual([["decision-d1-r1", "superseded"]]);
  expect(readDecisions(dir).decisions[0]?.revisions?.map((r) => r.delivery.state)).toEqual(["superseded", "cancelled"]);
});

test("after a restart the intents are reconciled with the queue: queued once, acked, closed, and undelivered when the lane session is gone", async () => {
  const dir = stateDir();
  const store = new SqliteLaneMessages(storePath(dir));
  const ctx = context(dir);
  const [a, b, c, d, e] = [await openLane(ctx, "ap-1-1"), await openLane(ctx, "ap-2-1"), await openLane(ctx, "ap-3-1"), await openLane(ctx, "ap-4-1"), await openLane(ctx, "ap-5-1")];
  // A crash after the intent, before the queue write (a, b, d); c and e got their message queued.
  for (const [id, key] of [[a, "ap-1-1"], [b, "ap-2-1"], [c, "ap-3-1"], [d, "ap-4-1"], [e, "ap-5-1"]] as const) recordAnswerRevision(dir, id, answer(key, 1), 10);
  queueDecisionAnswer(dir, store, c, 11);
  queueDecisionAnswer(dir, store, e, 11);
  await closeOwnerDecision(ctx, c, { text: "Closed by the lead", choice: 1 });
  // The queue lost e's message (a damaged or switched store): it is never queued again.
  const db = new Database(storePath(dir));
  try { db.query("DELETE FROM lane_messages WHERE id <> ?").run("decision-d3-r1"); } finally { db.close(); }
  const lanes = new Map([
    ["ap-1-1", decisionTargetOf(laneOf("ap-1-1"))],
    ["ap-3-1", decisionTargetOf(laneOf("ap-3-1"))],
    ["ap-4-1", decisionTargetOf(laneOf("ap-4-1", { lastRecoveryAt: 9 }))],
    ["ap-5-1", decisionTargetOf(laneOf("ap-5-1"))],
  ]);
  const first = reconcileDecisionDeliveries(dir, store, lanes, 100);
  expect(first.map((x) => [x.decision, x.action, x.reason])).toEqual([
    [a, "queued", undefined],
    [b, "undelivered", "lane ap-2-1 is closed"],
    [c, "closed", "decision closed"],
    [d, "undelivered", "lane ap-4-1 was relaunched, replaced or moved"],
    [e, "undelivered", "its lane message is missing from the queue"],
  ]);
  expect(store.list().map((m) => [m.id, m.state])).toEqual([["decision-d3-r1", "superseded"], ["decision-d1-r1", "queued"]]);
  expect(reconcileDecisionDeliveries(dir, store, lanes, 101)).toEqual([]);
  expect(store.list()).toHaveLength(2);
  ackLaneMessage(store, "ap-1-1", "decision-d1-r1", 102);
  expect(reconcileDecisionDeliveries(dir, store, lanes, 103).map((x) => [x.decision, x.action])).toEqual([[a, "acked"]]);
  expect(readDecisions(dir).decisions.map((x) => x.revisions?.[0]?.delivery.state)).toEqual(["acked", "undelivered", "superseded", "undelivered", "undelivered"]);
  const events: [string, string][] = [];
  await reconcileDecisionsAtStart(dir, store, [laneOf("ap-1-1")], 104, (id, line) => { events.push([id, line]); }, () => {});
  expect(events.map(([id]) => id)).toEqual(["decision-undelivered:d2:r1", "decision-undelivered:d4:r1", "decision-undelivered:d5:r1"]);
  expect(events[0]?.[1]).toBe("DECISION_ANSWER_UNDELIVERED ap-2-1 d2 r1 decision-d2-r1: lane ap-2-1 is closed; take the answer over with dori decision close d2");
});

const tickOf = (dir: string, chat: ReturnType<typeof fakeChat>["chat"]) => {
  const events: [string, string][] = [];
  return { events, deps: { ...context(dir, chat), enqueue: (id: string, line: string) => { events.push([id, line]); }, log: () => {} } };
};

test("a queued direct answer stays open and the lane acknowledgement closes it once in the chat", async () => {
  const dir = stateDir();
  const store = new SqliteLaneMessages(storePath(dir));
  const fake = fakeChat();
  const { events, deps } = tickOf(dir, fake.chat);
  const lanes = async () => [laneOf("ap-957-1")];
  const id = await openLane(deps, "ap-957-1");
  recordAnswerRevision(dir, id, answer("ap-957-1", 2), 10);
  queueDecisionAnswer(dir, store, id, 11);
  await decisionDeliveryTick(deps, store, lanes);
  expect(readDecisions(dir).decisions[0]?.state).toBe("open");
  expect(fake.posts).toHaveLength(1);
  ackLaneMessage(store, "ap-957-1", "decision-d1-r1", 20);
  await decisionDeliveryTick(deps, store, lanes);
  await decisionDeliveryTick(deps, store, lanes);
  expect(readDecisions(dir).decisions[0]).toMatchObject({ state: "closed", choice: 2, revisions: [{ delivery: { state: "acked" } }] });
  expect(fake.posts.slice(1)).toEqual([{
    place: { kind: "thread", id: 1 }, body: "[System] d1 결정 반영: 2번(Build a replacement). 레인 ap-957-1이 2번을 받았습니다.", buttons: [],
  }]);
  expect(events.map(([id]) => id)).toEqual(["decision-acked:d1:r1"]);
});

test("an acked answer whose close failed is closed by the next round, under the same lead event id", async () => {
  const dir = stateDir();
  const store = new SqliteLaneMessages(storePath(dir));
  const fake = fakeChat();
  let down = true;
  const chat = { ...fake.chat, reply: async (...args: Parameters<typeof fake.chat.reply>) => {
    if (down && args[1].startsWith("[System]")) throw new Error("chat unavailable");
    return fake.chat.reply(...args);
  } };
  const { events, deps } = tickOf(dir, chat);
  const lanes = async () => [laneOf("ap-957-1")];
  const id = await openLane(deps, "ap-957-1");
  recordAnswerRevision(dir, id, answer("ap-957-1", 1), 10);
  queueDecisionAnswer(dir, store, id, 11);
  ackLaneMessage(store, "ap-957-1", "decision-d1-r1", 12);
  await decisionDeliveryTick(deps, store, lanes);
  expect(readDecisions(dir).decisions[0]?.state).toBe("open");
  expect(readDecisions(dir).decisions[0]?.revisions?.[0]?.delivery.state).toBe("acked");
  down = false;
  await decisionDeliveryTick(deps, store, lanes);
  expect(readDecisions(dir).decisions[0]).toMatchObject({ state: "closed", choice: 1 });
  expect(events.map(([eventId]) => eventId)).toEqual(["decision-acked:d1:r1", "decision-acked:d1:r1"]);
});

test("an answer whose lane was relaunched is never delivered: the lead is woken once", async () => {
  const dir = stateDir();
  const store = new SqliteLaneMessages(storePath(dir));
  const fake = fakeChat();
  const { events, deps } = tickOf(dir, fake.chat);
  const id = await openLane(deps, "ap-957-1");
  recordAnswerRevision(dir, id, answer("ap-957-1", 2), 10);
  queueDecisionAnswer(dir, store, id, 11);
  const relaunched = async () => [laneOf("ap-957-1", { lastRecoveryAt: 9 })];
  await decisionDeliveryTick(deps, store, relaunched);
  await decisionDeliveryTick(deps, store, relaunched);
  expect(store.get("decision-d1-r1")?.state).toBe("superseded");
  expect(readDecisions(dir).decisions[0]).toMatchObject({ state: "open", revisions: [{ delivery: { state: "undelivered" } }] });
  expect(events).toEqual([["decision-undelivered:d1:r1", "DECISION_ANSWER_UNDELIVERED ap-957-1 d1 r1 decision-d1-r1: lane ap-957-1 was relaunched, replaced or moved; take the answer over with dori decision close d1"]]);
});
