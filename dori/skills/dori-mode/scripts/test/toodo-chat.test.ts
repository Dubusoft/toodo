import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseToodoRef, supervisorToodoChat, ToodoChat, ToodoChatError, toodoInbound } from "../src/messenger/toodo-chat.ts";
import type { ToodoAttachment, ToodoFile, ToodoMcp } from "../src/toodo-client.ts";

const message = (id: number, body: string, thread: number | null = null, attachments: ToodoAttachment[] = []) => ({
  id, channelId: 1, threadId: thread, author: "user", body, attachments,
});

type Mcp = Pick<ToodoMcp, "call" | "uploadAttachment" | "attachment">;

/** An MCP connection whose tools answer `call`; files are refused unless a test overrides them. */
const mcp = (call: Mcp["call"], files: Partial<Pick<Mcp, "uploadAttachment" | "attachment">> = {}): Mcp => ({
  call,
  uploadAttachment: files.uploadAttachment ?? (async () => { throw new Error("unexpected upload"); }),
  attachment: files.attachment ?? (async () => { throw new Error("unexpected download"); }),
});

const fakeChat = (pending: ReturnType<typeof message>[], calls: string[], files: Partial<Pick<Mcp, "attachment">> = {}) => {
  let taken = false;
  return new ToodoChat(mcp(async (name: string) => {
    calls.push(name);
    if (name === "peek_pending") return taken ? [] : pending;
    if (name === "take_pending") { taken = true; return pending; }
    throw new Error(`unexpected tool ${name}`);
  }, files));
};

const dir = (): string => mkdtempSync(join(tmpdir(), "toodo-chat-"));

test("a pass journals the peeked messages before it takes them", async () => {
  const calls: string[] = [];
  const journal: string[] = [];
  const chat = fakeChat([message(4, "hello"), message(5, "in a thread", 9)], calls);
  const inbound = supervisorToodoChat({ chat: () => chat, enqueue: (id, line) => { calls.push(`enqueue ${id}`); journal.push(line); }, attachmentDir: dir(), now: () => 0, pollMs: 1, log: () => {} });
  await inbound.tick();
  expect(calls.slice(0, 4)).toEqual(["peek_pending", "enqueue toodo-chat:4", "enqueue toodo-chat:5", "take_pending"]);
  expect(journal.slice(0, 2)).toEqual(["INBOUND toodo:channel/1 4 owner hello", "INBOUND toodo:thread/9 5 owner in a thread"]);
});

test("a message posted between the peek and the take is journaled from the take", async () => {
  const journal = new Map<string, string>();
  let peeks = 0;
  const chat = new ToodoChat(mcp(async (name: string) => {
    if (name === "peek_pending") return ++peeks === 1 ? [message(4, "first")] : [];
    return [message(4, "first"), message(5, "late")];
  }));
  const inbound = supervisorToodoChat({ chat: () => chat, enqueue: (id, line) => { if (!journal.has(id)) journal.set(id, line); }, attachmentDir: dir(), now: () => 0, pollMs: 1, log: () => {} });
  await inbound.tick();
  expect([...journal.keys()]).toEqual(["toodo-chat:4", "toodo-chat:5"]);
});

test("the typing dots are set at the place the reply goes", async () => {
  const calls: unknown[] = [];
  const chat = new ToodoChat(mcp(async (name: string, args: unknown) => { calls.push([name, args]); return { typing: true }; }));
  await chat.typing(parseToodoRef("toodo:thread/9"), true);
  await chat.typing(parseToodoRef("toodo"), false);
  expect(calls).toEqual([["set_typing", { typing: true, thread_id: 9 }], ["set_typing", { typing: false, channel_id: 1 }]]);
});

test("nothing is taken when journaling fails, so the messages stay pending", async () => {
  const calls: string[] = [];
  const chat = new ToodoChat(mcp(async (name: string) => { calls.push(name); return [message(4, "hello")]; }));
  const inbound = supervisorToodoChat({ chat: () => chat, enqueue: () => { throw new Error("journal unavailable"); }, attachmentDir: dir(), now: () => 0, pollMs: 1, log: () => {} });
  await expect(inbound.tick()).rejects.toThrow("journal unavailable");
  expect(calls).toEqual(["peek_pending"]);
});

test("an owner's attached file is saved for the lead and its INBOUND line names the saved path", async () => {
  const root = dir();
  const photo: ToodoAttachment = { id: 31, name: "../photo 1.png", contentType: "image/png", size: 3 };
  const downloads: number[] = [];
  const chat = fakeChat([message(7, "two\nlines", 3, [photo])], [], { attachment: async (id) => { downloads.push(id); return new Uint8Array([1, 2, 3]); } });
  const journal = new Map<string, string>();
  const inbound = supervisorToodoChat({ chat: () => chat, enqueue: (id, line) => { if (!journal.has(id)) journal.set(id, line); }, attachmentDir: root, now: () => 0, pollMs: 1, log: () => {} });
  await inbound.tick();
  const path = join(root, "7", "31-_photo_1.png");
  expect(journal.get("toodo-chat:7")).toBe(`INBOUND toodo:thread/3 7 owner two lines [attachment name=../photo_1.png type=image/png path=${path}]`);
  expect([...readFileSync(path)]).toEqual([1, 2, 3]);
  // The take repeats the peeked message: the file already saved is not fetched again.
  expect(downloads).toEqual([31]);
});

test("a file that cannot be fetched still journals the message, naming the attachment and the error", async () => {
  const chat = fakeChat([message(8, "", null, [{ id: 32, name: "a.pdf", contentType: "application/pdf", size: 9 }])], [], {
    attachment: async () => { throw new Error("toodo-server attachment 32 answered HTTP 404"); },
  });
  const journal: string[] = [];
  const inbound = supervisorToodoChat({ chat: () => chat, enqueue: (_id, line) => { journal.push(line); }, attachmentDir: dir(), now: () => 0, pollMs: 1, log: () => {} });
  await inbound.tick();
  expect(journal[0]).toBe("INBOUND toodo:channel/1 8 owner (no text) [attachment name=a.pdf type=application/pdf id=32 error=toodo-server attachment 32 answered HTTP 404]");
});

test("Dori's message carries the ids of its uploaded files and may then have no text", async () => {
  const sent: Record<string, unknown>[] = [];
  const uploaded: ToodoFile[] = [];
  const chat = new ToodoChat(mcp(async (name, args) => {
    if (name !== "reply_in_chat") throw new Error(`unexpected tool ${name}`);
    sent.push(args);
    return { id: 50, channelId: 1, threadId: 4, author: "agent", body: "report.md", attachments: [{ id: 41, name: "report.md", contentType: "text/markdown", size: 2 }] };
  }, { uploadAttachment: async (file) => { uploaded.push(file); return { id: 41, name: file.name, contentType: file.contentType, size: file.data.length }; } }));
  const file = await chat.upload({ name: "report.md", data: new Uint8Array([35, 10]), contentType: "text/markdown" });
  const reply = await chat.reply({ kind: "thread", id: 4 }, " ", [], [file.id]);
  expect(uploaded.map((f) => f.name)).toEqual(["report.md"]);
  expect(sent).toEqual([{ body: "", thread_id: 4, handles: [], attachments: [41] }]);
  expect(reply.attachments.map((a) => a.id)).toEqual([41]);
  await expect(chat.reply({ kind: "thread", id: 4 }, " ")).rejects.toThrow(ToodoChatError);
});

test("an INBOUND line without files flattens the text", () => {
  const m = { id: 7, place: { kind: "thread" as const, id: 3 }, author: "user" as const, body: "two\nlines", attachments: [] };
  expect(toodoInbound(m)).toEqual({ id: "toodo-chat:7", line: "INBOUND toodo:thread/3 7 owner two lines" });
});

test("Toodo chat refs name a channel, a thread or the default room", () => {
  expect(parseToodoRef("toodo:channel/1")).toEqual({ kind: "channel", id: 1 });
  expect(parseToodoRef("toodo:thread/42")).toEqual({ kind: "thread", id: 42 });
  expect(parseToodoRef("toodo")).toEqual({ kind: "channel", id: 1 });
  expect(() => parseToodoRef("toodo:thread/0")).toThrow(ToodoChatError);
  expect(() => parseToodoRef("discord:1/2")).toThrow(ToodoChatError);
});
