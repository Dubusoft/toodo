import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordOwnerAnswer } from "../src/decision-inbound.ts";
import { DECISIONS_FILE, readDecisions } from "../src/decision-store.ts";
import {
  answeredLine,
  answerOutcomeLines,
  closeOwnerDecision,
  openLaneDecision,
  openOwnerDecision,
  ownerDecisionTick,
  type DecisionContext,
  type DecisionReceipts,
} from "../src/owner-decisions.ts";
import {
  decisionChoicesProblem,
  inputRequestProblem,
  parseDecisionText,
  parseRequestText,
  serializeDecisionText,
  serializeRequestText,
  type DecisionChoices,
} from "../src/runner/decision-text.ts";
import type { ToodoChat, ToodoPlace } from "../src/messenger/toodo-chat.ts";

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

test("decision text serializes and parses, rejecting free text and one option", () => {
  expect(parseDecisionText(serializeDecisionText(choices))).toEqual(choices);
  expect(parseDecisionText("Which path should we take?")).toBeUndefined();
  const oneOption = serializeDecisionText({ ...choices, options: ["Only one"] });
  expect(parseDecisionText(oneOption)).toBeUndefined();
  expect(decisionChoicesProblem({ ...choices, recommend: 3 })).toBe("--recommend must be 1-2");
});

test("request text round-trips, and a long-lived secret is refused unless a file path is named", () => {
  const code = { need: "Device code for gh auth login", reason: "To push the branch", waiting: "Push of the PR", blocking: true };
  expect(parseRequestText(serializeRequestText(code))).toEqual(code);
  const file = { ...code, need: "The npm API token", file: "~/.config/dori/npm-token" };
  expect(parseRequestText(serializeRequestText(file))).toEqual(file);
  expect(parseDecisionText(serializeRequestText(code))).toBeUndefined();
  expect(parseRequestText(serializeDecisionText(choices))).toBeUndefined();
  expect(inputRequestProblem({ ...code, need: "The npm API token" })).toMatch(/^a long-lived secret/);
  expect(inputRequestProblem({ ...code, need: "스토어 계정 비밀번호" })).toMatch(/^a long-lived secret/);
  expect(inputRequestProblem({ ...code, file: "relative/path" })).toMatch(/^--file must be an absolute/);
});

test("a failed Toodo card post drops its reservation", async () => {
  const dir = stateDir();
  const chat = { ...fakeChat().chat, reply: async () => { throw new Error("chat unavailable"); } };
  await expect(open(context(dir, chat))).rejects.toMatchObject({ code: "DECISION_NOT_POSTED" });
  expect(readDecisions(dir).decisions).toEqual([]);
});

test("the same source report opens just one Toodo card", async () => {
  const fake = fakeChat();
  const ctx = context(stateDir(), fake.chat);
  const report = { source: "lane", sourceRef: "report-1", lane: "ap-42-1" } as const;
  await open(ctx, report);
  expect((await open(ctx, report)).decision.id).toBe("d1");
  expect(fake.posts).toHaveLength(1);
});

test("closing an answered card confirms it in the same chat and resolves the answer once", async () => {
  const dir = stateDir();
  const fake = fakeChat();
  const ctx = context(dir, fake.chat);
  const { decision } = await open(ctx, { task: 77 });
  recordOwnerAnswer(dir, "toodo:thread/42", "41", 1_800_000_000_100);
  const closed = await closeOwnerDecision(ctx, decision.id, { text: "Proceed with option one.", choice: 1 });
  expect(closed.decision.state).toBe("closed");
  expect(fake.posts.slice(1)).toEqual([{
    place: { kind: "thread", id: 42 }, body: "[System] d1 결정 반영: 1번(Use the existing API). Proceed with option one.", buttons: [],
  }]);
  const [receipt] = readdirSync(join(dir, "resolved"));
  if (!receipt) throw new Error("missing resolution receipt");
  expect(JSON.parse(readFileSync(join(dir, "resolved", receipt), "utf8"))).toMatchObject({ id: "owner-decision-answered:d1" });
  await expect(closeOwnerDecision(ctx, decision.id, { text: "Again" })).rejects.toMatchObject({ code: "DECISION_ALREADY_CLOSED" });
  expect(fake.posts).toHaveLength(2);
});

test("legacy records remain readable and closable without posting a card or sending receipts", async () => {
  const dir = stateDir();
  const fake = fakeChat();
  const record = { ...choices, id: "d1", source: "lead", channel: "555", thread: "1000", state: "posting", openedAt: 1, archivePending: true,
    answers: [{ channel: "1000", message: "41", at: 1 }] };
  writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ nextSeq: 2, decisions: [record] }));
  const calls: { method: string; args: unknown[] }[] = [];
  const receipts = fakeReceipts(calls);
  const ctx = { ...context(dir, fake.chat), receipts };
  await ownerDecisionTick({ ...ctx, enqueue: () => { throw new Error("unexpected legacy event"); } });
  expect(readDecisions(dir).decisions[0]).toMatchObject({ state: "posting", channel: "555", thread: "1000" });
  expect((await closeOwnerDecision(ctx, "d1", { text: "Retired", cancel: true })).decision.state).toBe("closed");
  expect(fake.posts).toEqual([]);
  expect(calls).toEqual([]);
});

/** Receipts that log each call into `calls` (beside the transport's), with the unseen counts and failures a case sets. */
const fakeReceipts = (calls: { method: string; args: unknown[] }[], failHandled = new Set<string>()) => {
  const receipts: DecisionReceipts = {
    ack: async (channel, message) => { calls.push({ method: "ack", args: [channel, message] }); },
    handled: async (channel, message, tasks) => {
      if (failHandled.delete(`${channel}/${message}`)) throw new Error("disk full");
      calls.push({ method: "handled", args: [channel, message, tasks] });
    },
  };
  return receipts;
};

test("a handled receipt that fails is reported, and closing the closed decision again records only the missing one", async () => {
  const dir = stateDir();
  const fake = fakeChat();
  const calls: { method: string; args: unknown[] }[] = [];
  const ctx: DecisionContext = { ...context(dir, fake.chat), receipts: fakeReceipts(calls, new Set(["toodo:channel/1/41"])) };
  const { decision } = await open(ctx);
  recordOwnerAnswer(dir, "toodo:channel/1", "41", 1_800_000_000_100);
  recordOwnerAnswer(dir, "toodo:channel/1", "42", 1_800_000_000_200);
  const closed = await closeOwnerDecision(ctx, decision.id, { text: "Done.", choice: 1 });
  expect(closed.decision.state).toBe("closed");
  if (!closed.answers) throw new Error("expected answer receipts");
  expect(answerOutcomeLines(closed.answers).find((l) => l.startsWith("DECISION_HANDLED_FAILED")))
    .toBe("DECISION_HANDLED_FAILED toodo:channel/1 41: disk full; run the close again, or dori handled toodo:channel/1 41 --reply");
  const again = await closeOwnerDecision(ctx, decision.id, { text: "Done." }).catch((e: unknown) => e);
  expect(again).toMatchObject({ code: "DECISION_ALREADY_CLOSED", lines: ["DECISION_HANDLED toodo:channel/1 41 coverage=1/1"] });
  expect(calls.filter((call) => call.method === "handled").map((call) => call.args[1])).toEqual(["41"]);
});

test("a close in a shared task thread covers the first answer and only acknowledges the rest", async () => {
  const dir = stateDir();
  const fake = fakeChat();
  const calls: { method: string; args: unknown[] }[] = [];
  const ctx: DecisionContext = { ...context(dir, fake.chat), receipts: fakeReceipts(calls) };
  await openLaneDecision(ctx, { key: "ap-925-1", thread: "toodo:thread/777" }, { id: "row-1", text: serializeDecisionText(choices) });
  recordOwnerAnswer(dir, "toodo:thread/1", "51", 1_800_000_000_100);
  recordOwnerAnswer(dir, "toodo:thread/1", "52", 1_800_000_000_200);
  const closed = await closeOwnerDecision(ctx, "d1", { text: "Option one.", choice: 1 });
  expect(calls.filter((call) => call.method === "ack").map((call) => call.args)).toEqual([["toodo:thread/1", "51"], ["toodo:thread/1", "52"]]);
  expect(calls.filter((call) => call.method === "handled").map((call) => call.args)).toEqual([["toodo:thread/1", "51", 1]]);
  if (!closed.answers) throw new Error("expected answer receipts");
  expect(answerOutcomeLines(closed.answers)).toContain(
    "DECISION_ANSWER_LEFT toodo:thread/1 52: acked, not covered by the close; cover it with dori handled toodo:thread/1 52 --reply|--lane KEY");
});

test("a request with a file tells the owner to write it there with chmod 600 and not to paste it", async () => {
  const dir = stateDir();
  const fake = fakeChat();
  const text = serializeRequestText({ need: "The npm API token", reason: "Publish", file: "~/.config/dori/npm-token", waiting: "Publish", blocking: false });
  await openLaneDecision(context(dir, fake.chat), { key: "lane-x", thread: "none" }, { id: "row-1", text });
  const start = fake.posts[0]?.body;
  expect(start).toContain("chmod 600 ~/.config/dori/npm-token");
  expect(start).toContain("붙여넣지 마시고");
});

test("a lead decision opened with relayTo keeps it: its answer tells the lead the close types --text into the lane, and the owner sees no lane text", async () => {
  const dir = stateDir();
  const fake = fakeChat();
  const ctx = context(dir, fake.chat);
  const { decision } = await open(ctx, { lane: "ap-7-1", relayTo: "ap-7-1" });
  expect(readDecisions(dir).decisions[0]).toMatchObject({ source: "lead", lane: "ap-7-1", relayTo: "ap-7-1" });
  const answer = recordOwnerAnswer(dir, "toodo:channel/1", "41", 1_800_000_000_100);
  if (!answer) throw new Error("expected owner answer");
  expect(answeredLine(answer.decision)).toContain("types --text into lane ap-7-1");
  await closeOwnerDecision(ctx, decision.id, { text: "Lane: use the existing API", choice: 1 });
  const reply = fake.posts.at(-1)?.body;
  expect(reply).toContain("레인 ap-7-1에 전달합니다");
  expect(reply).not.toContain("Lane: use the existing API");
});
