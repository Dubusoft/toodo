import { afterEach, expect, test } from "bun:test";

import { closeOwnerDecision, type DecisionContext, type DecisionTransport, openLaneDecision, openOwnerDecision } from "../src/owner-decisions.ts";
import { routedDecisionTransport } from "../src/decision-toodo.ts";
import { type DirectRouting } from "../src/decision-inbound.ts";
import { readDecisions, type TargetLane } from "../src/decision-store.ts";
import { SqliteLaneMessages } from "../src/lane-messages.ts";
import { ToodoChat, type ToodoChatMessage } from "../src/messenger/toodo-chat.ts";
import { serializeDecisionText, serializeRequestText } from "../src/runner/decision-text.ts";
import { routeToodoOwnerMessage, toodoAnswerReceipts, toodoDecisionTick } from "../src/decision-toodo-cards.ts";
import { storePath, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const choices = { question: "Which path?", options: ["Keep", "Replace", "Drop"], recommend: 2, reason: "smaller", waiting: "the choice", blocking: true };

type Posted = { id: number; threadId: number | null; body: string; actions: { key: string; label: string; style?: string }[]; handles: number[] };

/** toodo-server's chat tools as Dori calls them, in memory: task threads, posts, the waiting marks, receipts. */
const fakeToodo = () => {
  const threads: { id: number; taskId: number; status: string }[] = [];
  const posts: Posted[] = [];
  const awaiting = new Map<number, boolean>();
  const receipts: string[] = [];
  let ids = 100;
  const chat = new ToodoChat({
    call: async (name: string, args: Record<string, unknown> = {}) => {
      switch (name) {
        case "list_threads": return threads.filter((t) => t.taskId === args.task_id);
        case "create_thread": { const t = { id: threads.length + 1, taskId: args.task_id as number, status: "open" }; threads.push(t); return t; }
        case "reply_in_chat": {
          const post: Posted = { id: ++ids, threadId: (args.thread_id as number | undefined) ?? null, body: args.body as string, actions: (args.actions as Posted["actions"] | undefined) ?? [], handles: args.handles as number[] };
          posts.push(post);
          return { id: post.id, channelId: 1, threadId: post.threadId, author: "agent", body: post.body, attachments: [] };
        }
        case "update_thread": awaiting.set(args.id as number, args.awaiting as boolean); return {};
        case "ack_chat": receipts.push(`ack ${String(args.ids)}`); return [];
        case "mark_chat_handled": receipts.push(`handled ${String(args.id)} reply ${String(args.reply_id)}`); return {};
        default: throw new Error(`unexpected tool ${name}`);
      }
    },
    uploadAttachment: async () => { throw new Error("unexpected upload"); },
    attachment: async () => { throw new Error("unexpected download"); },
  });
  return { chat, threads, posts, awaiting, receipts };
};

/** Lane decisions opened as the supervisor opens them, with the Toodo chat on beside Discord. */
const world = () => {
  const state = withState();
  cleanups.push(state.done);
  const toodo = fakeToodo();
  let threads = 0;
  const transport: DecisionTransport = {
    send: async () => `q${++threads}`, edit: async () => {}, editComponents: async () => {}, content: async () => "", deleteMessage: async () => {},
    messagesAfter: async () => [], startThread: async () => ({ id: `t${++threads}` }), setThread: async () => {},
    threadState: async () => ({ archived: false, parent: "555" }), threadArchived: async () => true,
  };
  const ctx: DecisionContext = { config: { stateDir: state.dir, discordChannels: ["100"], decisionsChannel: "555", alertsChannel: undefined, displayTimeZone: "UTC" }, transport, now: () => 1_000, home: "/home/test" };
  const lanes: TargetLane[] = [];
  const ask = async (key: string, task: number, text = serializeDecisionText(choices)) => {
    const lane = { key, task, thread: "discord:100/222", runner: "mini", lastRecoveryAt: 5, openedAt: "2026-11-13T00:00:00.000Z" };
    if (!lanes.some((l) => l.key === key)) lanes.push(lane);
    const opened = await openLaneDecision(ctx, lane, { id: `row-${key}-${threads}`, text });
    if (!opened) throw new Error("not a decision text");
    return opened.decision;
  };
  const logs: string[] = [];
  const tick = () => toodoDecisionTick({ stateDir: state.dir, chat: () => toodo.chat, home: "/home/test", threadTitle: async (d) => `lane ${d.lane}`, log: (line) => { logs.push(line); } });
  const store = new SqliteLaneMessages(storePath(state.dir));
  const emitted: string[] = [];
  const routing: DirectRouting = { stateDir: state.dir, store: () => store, lanes: async () => lanes, now: () => 2_000, emit: async (_id, line) => { emitted.push(line); }, log: () => {} };
  let owner = 500;
  const say = (thread: number, body: string, choiceOf?: ToodoChatMessage["choiceOf"]): ToodoChatMessage =>
    ({ id: ++owner, place: { kind: "thread", id: thread }, author: "user", body, attachments: [], ...(choiceOf ? { choiceOf } : {}) });
  const route = (m: ToodoChatMessage) => routeToodoOwnerMessage(routing, () => toodo.chat, m);
  const decision = (id: string) => readDecisions(state.dir).decisions.find((d) => d.id === id);
  return { ctx, toodo, ask, tick, logs, store, emitted, say, route, decision, dir: state.dir };
};

test("each open decision gets one card in its task's thread: a question's numbered buttons, a request's none; the thread is marked waiting", async () => {
  const w = world();
  const question = await w.ask("ap-1731-1", 1731);
  await w.ask("ap-1732-1", 1732, serializeRequestText({ need: "the 2FA code", reason: "login", waiting: "deploy", blocking: true }));
  await w.tick();
  await w.tick();
  expect(w.toodo.threads.map((t) => t.taskId)).toEqual([1731, 1732]);
  const [card, request] = w.toodo.posts;
  expect(w.toodo.posts).toHaveLength(2);
  expect(card?.threadId).toBe(1);
  expect(card?.actions).toEqual([
    { key: "d1:1", label: "1. Keep", style: "default" }, { key: "d1:2", label: "2. Replace", style: "primary" }, { key: "d1:3", label: "3. Drop", style: "default" },
  ]);
  expect(card?.body.split("\n\n").slice(0, 3)).toEqual(["[결정 d1] · Toodo #1731 · 레인 ap-1731-1", "질문: Which path?", "1. Keep\n2. Replace ← 추천\n3. Drop"]);
  expect(request?.actions).toEqual([]);
  expect(request?.body.split("\n\n")[1]).toBe("필요한 것: the 2FA code");
  expect(w.decision(question.id)?.toodo).toEqual({ place: "toodo:thread/1", message: card?.id ?? 0, awaiting: true });
  expect([...w.toodo.awaiting]).toEqual([[1, true], [2, true]]);
});

test("pressing button 2 on the card sends the answer straight to the lane and takes the waiting mark off", async () => {
  const w = world();
  const d = await w.ask("ap-1731-1", 1731);
  await w.tick();
  const card = w.toodo.posts[0]!;
  const press = w.say(1, "2. Replace", { message: card.id, key: "d1:2" });
  expect(await w.route(press)).toBe("direct");
  expect(w.store.get("decision-d1-r1")?.text).toBe("[dori] Owner answered d1 (Which path?): 2. Replace. Revision r1. Confirm with: ~/.dori/runner/bin/dori report ack decision-d1-r1");
  expect(w.emitted).toEqual([`DECISION_ANSWER_DIRECT ap-1731-1 d1 r1 choice=2 "Replace" decision-d1-r1 from toodo:thread/1/click:toodo-${press.id} via button: queued for the lane, nothing to do`]);
  expect(w.toodo.posts.at(-1)).toMatchObject({ threadId: 1, body: "[System] d1: 2번으로 기록했습니다. 레인 ap-1731-1에 전달하는 중입니다.", handles: [press.id] });
  // The same press seen again (a restart before the take) adds nothing.
  expect(await w.route(press)).toBe("direct");
  expect(w.toodo.posts).toHaveLength(2);
  await w.tick();
  expect(w.toodo.awaiting.get(1)).toBe(false);
  expect(w.decision(d.id)?.revisions?.map((r) => `r${r.rev}:${r.choice}`)).toEqual(["r1:2"]);
});

test("a reply on the card: a bare number answers the lane directly, any other text is the lead's answer and stays INBOUND", async () => {
  const w = world();
  await w.ask("ap-1731-1", 1731);
  await w.tick();
  const text = w.say(1, "let me think about it");
  expect(await w.route(text)).toBe("lead");
  expect(w.emitted).toHaveLength(1);
  expect(w.emitted[0]).toStartWith("OWNER_DECISION_ANSWERED ap-1731-1 d1 blocking discord:555/t1: Which path?; run dori decision close d1 --text");
  expect(w.decision("d1")?.answers).toEqual([{ channel: "toodo:thread/1", message: String(text.id), at: 2_000 }]);
  await w.tick();
  expect(w.toodo.awaiting.get(1)).toBe(false);

  const v = world();
  await v.ask("ap-1731-1", 1731);
  await v.tick();
  expect(await v.route(v.say(1, "3"))).toBe("direct");
  expect(v.store.get("decision-d1-r1")?.text).toStartWith("[dori] Owner answered d1 (Which path?): 3. Drop. Revision r1.");
  expect(v.toodo.posts.at(-1)?.body).toBe("[System] d1: 3번으로 기록했습니다. 레인 ap-1731-1에 전달하는 중입니다.");
});

test("a request answered by a reply reaches the lead with its value; the close settles the reply in Toodo and posts one close line under the card", async () => {
  const w = world();
  const d = await w.ask("ap-1731-1", 1731, serializeRequestText({ need: "the 2FA code", reason: "login", waiting: "deploy", blocking: true }));
  await w.tick();
  const value = w.say(1, "482913");
  expect(await w.route(value)).toBe("lead");
  expect(w.emitted[0]).toStartWith(`OWNER_DECISION_ANSWERED ap-1731-1 d1 blocking discord:555/t1: [request] the 2FA code; the owner's reply is message toodo:thread/1/${value.id}`);
  const toodo = toodoAnswerReceipts(w.dir, () => w.toodo.chat);
  await closeOwnerDecision({
    ...w.ctx,
    receipts: { unseen: () => ({ count: 0, lines: [] }), acked: () => false, ack: async (_c, m) => { await toodo.ack(m); }, handled: async (c, m) => { await toodo.handled(c, m); } },
  }, d.id, { text: "code 482913" });
  expect(w.toodo.receipts).toEqual([`ack ${value.id}`, `handled ${value.id} reply ${w.toodo.posts[0]?.id}`]);
  await w.tick();
  await w.tick();
  expect(w.toodo.posts.slice(1).map((p) => p.body)).toEqual(["[System] d1 요청 처리. 레인 ap-1731-1에 전달합니다."]);
});

test("a close's --from can name an owner reply in the Toodo chat that no decision recorded: it is acked and handled, and the close does not say the lead decided", async () => {
  const w = world();
  const d = await w.ask("ap-1731-1", 1731);
  await w.tick();
  const reply = w.say(1, "1");
  const toodo = toodoAnswerReceipts(w.dir, () => w.toodo.chat);
  await closeOwnerDecision({
    ...w.ctx,
    receipts: { unseen: () => ({ count: 0, lines: [] }), acked: () => false, ack: async (_c, m) => { await toodo.ack(m); }, handled: async (c, m) => { await toodo.handled(c, m); } },
  }, d.id, { text: "Keep.", choice: 1, from: `toodo:thread/1/${reply.id}` });
  expect(w.toodo.receipts).toEqual([`ack ${reply.id}`, `handled ${reply.id} reply ${w.toodo.posts[0]?.id}`]);
  await w.tick();
  await w.tick();
  expect(w.toodo.posts.slice(1).map((p) => p.body)).toEqual(["[System] d1 결정 반영: 1번(Keep). 레인 ap-1731-1에 전달합니다."]);
});

test("with Discord off the decision's own message is its card: the pass posts no second card and no second close line", async () => {
  const state = withState();
  cleanups.push(state.done);
  const toodo = fakeToodo();
  const transport = routedDecisionTransport(() => { throw new Error("Discord is off"); }, () => toodo.chat);
  const ctx: DecisionContext = {
    config: { stateDir: state.dir, discordChannels: [], decisionsChannel: undefined, alertsChannel: undefined, displayTimeZone: "UTC", platforms: ["toodo"] },
    transport, toodo: () => toodo.chat, now: () => 1_000, home: "/home/test",
  };
  const { decision } = await openOwnerDecision(ctx, { ...choices, source: "lead", task: 7 });
  const tick = () => toodoDecisionTick({ stateDir: state.dir, chat: () => toodo.chat, home: "/home/test", threadTitle: async () => "lane", log: () => {} });
  await tick();
  expect(toodo.posts.map((p) => [p.threadId, p.actions.map((a) => a.key)])).toEqual([[1, ["d1:1", "d1:2", "d1:3"]]]);
  expect(toodo.awaiting.get(1)).toBe(true);
  await closeOwnerDecision(ctx, decision.id, { text: "Go with the replacement.", choice: 2 });
  await tick();
  await tick();
  expect(toodo.posts.map((p) => p.threadId)).toEqual([1, 1]);
  expect(toodo.awaiting.get(1)).toBe(false);
});
