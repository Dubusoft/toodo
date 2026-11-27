import { expect, test } from "bun:test";

import { parseToodoRef, supervisorToodoChat, ToodoChat, ToodoChatError, toodoInbound } from "../src/messenger/toodo-chat.ts";

const message = (id: number, body: string, thread: number | null = null) => ({
  id, channelId: 1, threadId: thread, author: "user", body, attachments: [],
});

const fakeChat = (pending: ReturnType<typeof message>[], calls: string[]) => {
  let taken = false;
  return new ToodoChat({
    call: async (name: string) => {
      calls.push(name);
      if (name === "peek_pending") return taken ? [] : pending;
      if (name === "take_pending") { taken = true; return pending; }
      throw new Error(`unexpected tool ${name}`);
    },
  });
};

test("a pass journals the peeked messages before it takes them", async () => {
  const calls: string[] = [];
  const journal: string[] = [];
  const chat = fakeChat([message(4, "hello"), message(5, "in a thread", 9)], calls);
  const inbound = supervisorToodoChat({ chat: () => chat, enqueue: (id, line) => { calls.push(`enqueue ${id}`); journal.push(line); }, now: () => 0, pollMs: 1, log: () => {} });
  await inbound.tick();
  expect(calls.slice(0, 4)).toEqual(["peek_pending", "enqueue toodo-chat:4", "enqueue toodo-chat:5", "take_pending"]);
  expect(journal.slice(0, 2)).toEqual(["INBOUND toodo:channel/1 4 owner hello", "INBOUND toodo:thread/9 5 owner in a thread"]);
});

test("a message posted between the peek and the take is journaled from the take", async () => {
  const journal = new Map<string, string>();
  let peeks = 0;
  const chat = new ToodoChat({
    call: async (name: string) => {
      if (name === "peek_pending") return ++peeks === 1 ? [message(4, "first")] : [];
      return [message(4, "first"), message(5, "late")];
    },
  });
  const inbound = supervisorToodoChat({ chat: () => chat, enqueue: (id, line) => { if (!journal.has(id)) journal.set(id, line); }, now: () => 0, pollMs: 1, log: () => {} });
  await inbound.tick();
  expect([...journal.keys()]).toEqual(["toodo-chat:4", "toodo-chat:5"]);
});

test("nothing is taken when journaling fails, so the messages stay pending", async () => {
  const calls: string[] = [];
  const chat = new ToodoChat({ call: async (name: string) => { calls.push(name); return [message(4, "hello")]; } });
  const inbound = supervisorToodoChat({ chat: () => chat, enqueue: () => { throw new Error("journal unavailable"); }, now: () => 0, pollMs: 1, log: () => {} });
  await expect(inbound.tick()).rejects.toThrow("journal unavailable");
  expect(calls).toEqual(["peek_pending"]);
});

test("an INBOUND line flattens the text and names attached files", () => {
  const m = { id: 7, place: { kind: "thread" as const, id: 3 }, author: "user" as const, body: "two\nlines", attachments: ["a.png", "b.pdf"] };
  expect(toodoInbound(m)).toEqual({ id: "toodo-chat:7", line: "INBOUND toodo:thread/3 7 owner two lines [attachments: a.png, b.pdf]" });
});

test("Toodo chat refs name a channel, a thread or the default room", () => {
  expect(parseToodoRef("toodo:channel/1")).toEqual({ kind: "channel", id: 1 });
  expect(parseToodoRef("toodo:thread/42")).toEqual({ kind: "thread", id: 42 });
  expect(parseToodoRef("toodo")).toEqual({ kind: "channel", id: 1 });
  expect(() => parseToodoRef("toodo:thread/0")).toThrow(ToodoChatError);
  expect(() => parseToodoRef("discord:1/2")).toThrow(ToodoChatError);
});
