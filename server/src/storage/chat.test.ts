import { type Database, SQLiteError } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  ANSWER_WITHIN,
  type ChatAction,
  type ChatPlace,
  FIRST_CHANNEL,
  chatAttachmentId,
  chatChannelId,
  chatMessageId,
  chatThreadId,
  isOverdue,
} from "../domain/chat.ts";
import { taskId } from "../domain/model.ts";
import { chatAttachment, createChatAttachment, removeStaleChatAttachments } from "./chat-attachments.ts";
import {
  chatNotice,
  createChatChannel,
  deleteChatChannel,
  listChatChannels,
  markChatRead,
  reorderChatChannels,
  updateChatChannel,
} from "./chat-channels.ts";
import { listChatMessages } from "./chat-messages.ts";
import { createChatThread, listChatThreads, updateChatThread } from "./chat-threads.ts";
import {
  type AgentPost,
  ackChatMessages,
  chooseChatAction,
  markChatHandled,
  pendingChatMessages,
  postAgentMessage,
  postUserMessage,
} from "./chat.ts";
import { StorageError, type StorageFailure } from "./errors.ts";
import { insertTask, insertWorkspace, openMemoryDatabase } from "./testing.ts";

const GENERAL: ChatPlace = { kind: "channel", id: FIRST_CHANNEL };

function say(db: Database, place: ChatPlace, body: string, clientId: string, at = 100) {
  return postUserMessage(db, { place, body, clientId, attachments: [] }, at);
}

function reply(db: Database, post: Partial<AgentPost> & { body: string }, at = 100) {
  return postAgentMessage(db, { place: null, handles: [], actions: [], attachments: [], ...post }, at);
}

function allMessages(db: Database, place: ChatPlace | null = null) {
  return listChatMessages(db, { place, before: null, limit: 50 });
}

function failure(action: () => unknown): StorageFailure {
  try {
    action();
  } catch (error) {
    if (error instanceof StorageError) {
      return error.failure;
    }
    throw error;
  }
  throw new Error("expected a StorageError");
}

function yesNo(): ChatAction[] {
  return [
    { key: "yes", label: "Yes", style: "primary" },
    { key: "no", label: "No", style: "default" },
  ];
}

describe("chat messages", () => {
  test("a resent message is stored once and gets a due time", () => {
    const db = openMemoryDatabase();
    const first = say(db, GENERAL, "Hi", "c1");
    const again = say(db, GENERAL, "Hi", "c1");
    expect(again).toEqual(first);
    expect(first.author).toBe("user");
    expect([first.channelId, first.threadId]).toEqual([FIRST_CHANNEL, null]);
    expect(first.dueAt).toBe(100 + ANSWER_WITHIN);
    expect(allMessages(db)).toEqual([first]);
  });

  test("taking pending messages marks them received once", () => {
    const db = openMemoryDatabase();
    const hi = say(db, GENERAL, "Hi", "c1");
    reply(db, { body: "Hello" });
    const peeked = pendingChatMessages(db, false, 100);
    expect(peeked.map((m) => m.id)).toEqual([hi.id]);
    expect(peeked[0]?.deliveredAt).toBeNull();
    const taken = pendingChatMessages(db, true, 100);
    expect(taken[0]?.deliveredAt).toBe(100);
    expect(pendingChatMessages(db, true, 100)).toEqual([]);
  });

  test("a reply handles the messages it answers and acknowledges them", () => {
    const db = openMemoryDatabase();
    const hi = say(db, GENERAL, "Hi", "c1");
    const answer = reply(db, { body: "Hello", handles: [hi.id] });
    expect(answer.author).toBe("agent");
    expect(answer.dueAt).toBeNull();
    const [handled] = allMessages(db);
    if (handled === undefined) {
      throw new Error("the message is gone");
    }
    expect([handled.ackedAt, handled.handledAt, handled.handledReplyId]).toEqual([100, 100, answer.id]);
    expect(isOverdue(handled, 100 + ANSWER_WITHIN)).toBe(false);
  });

  test("receipts go only on existing messages of people", () => {
    const db = openMemoryDatabase();
    const hi = say(db, GENERAL, "Hi", "c1");
    const answer = reply(db, { body: "Hello" });
    expect(failure(() => ackChatMessages(db, [hi.id, answer.id], 100))).toEqual({
      kind: "not_a_persons_message",
      message: answer.id,
    });
    // The batch failed as a whole, so the first message stays unacknowledged.
    expect(allMessages(db)[0]?.ackedAt).toBeNull();
    expect(failure(() => markChatHandled(db, { message: chatMessageId(99), reply: null, task: null }, 100))).toEqual({
      kind: "chat_message_not_found",
      message: 99,
    });
    expect(failure(() => markChatHandled(db, { message: hi.id, reply: hi.id, task: null }, 100))).toEqual({
      kind: "not_an_agents_message",
      message: hi.id,
    });
    expect(failure(() => markChatHandled(db, { message: hi.id, reply: null, task: taskId(42) }, 100))).toEqual({
      kind: "task_not_found",
      task: 42,
    });
    expect(failure(() => reply(db, { body: "Hello", handles: [chatMessageId(99)] })).kind).toBe("chat_message_not_found");
    expect(allMessages(db)).toHaveLength(2);
  });

  test("acknowledging again keeps the first receipt", () => {
    const db = openMemoryDatabase();
    const hi = say(db, GENERAL, "Hi", "c1");
    ackChatMessages(db, [hi.id], 100);
    const [again] = ackChatMessages(db, [hi.id], 200);
    expect([again?.deliveredAt, again?.ackedAt]).toEqual([100, 100]);
    const handled = markChatHandled(db, { message: hi.id, reply: null, task: null }, 200);
    expect([handled.ackedAt, handled.handledAt]).toEqual([100, 200]);
  });

  test("pages hold the latest messages before a message, oldest first", () => {
    const db = openMemoryDatabase();
    const ids = [0, 1, 2, 3, 4].map((n) => say(db, GENERAL, `m${n}`, `c${n}`).id);
    const latest = listChatMessages(db, { place: GENERAL, before: null, limit: 2 });
    expect(latest.map((m) => m.id)).toEqual(ids.slice(3));
    const earlier = listChatMessages(db, { place: GENERAL, before: ids[3] ?? null, limit: 2 });
    expect(earlier.map((m) => m.id)).toEqual(ids.slice(1, 3));
  });

  test("messages of the earlier lead chat read as the agent and the system", () => {
    const db = openMemoryDatabase();
    db.run("INSERT INTO chat_messages (author, body, at) VALUES ('lead', 'Earlier', 1)");
    db.run("INSERT INTO chat_messages (author, body, at) VALUES ('system', 'Task #1 done', 2)");
    expect(allMessages(db, GENERAL).map((m) => m.author)).toEqual(["agent", "system"]);
  });
});

describe("chat channels and threads", () => {
  test("channels have unique names in any case and keep their own messages", () => {
    const db = openMemoryDatabase();
    const work = createChatChannel(db, "work", 100);
    expect(failure(() => createChatChannel(db, "WORK", 100))).toEqual({
      kind: "chat_channel_name_taken",
      name: "WORK",
    });
    expect(failure(() => updateChatChannel(db, work.id, { name: "General" })).kind).toBe(
      "chat_channel_name_taken",
    );
    // Renaming a channel to another case of its own name is fine.
    expect(updateChatChannel(db, work.id, { name: "Work" }).name).toBe("Work");
    const here: ChatPlace = { kind: "channel", id: work.id };
    const hi = say(db, here, "Hi", "c1");
    say(db, GENERAL, "Elsewhere", "c2");
    expect(hi.channelId).toBe(work.id);
    expect(allMessages(db, here)).toEqual([hi]);
    // A reply without a place goes where the message it answers is.
    const answer = reply(db, { body: "Hello", handles: [hi.id] });
    expect([answer.channelId, answer.threadId]).toEqual([work.id, null]);
    expect(listChatChannels(db).map((c) => [c.name, c.unread])).toEqual([
      ["general", 0],
      ["Work", 1],
    ]);
    expect(failure(() => say(db, { kind: "channel", id: chatChannelId(9) }, "Hi", "c3"))).toEqual({
      kind: "chat_channel_not_found",
      channel: 9,
    });
  });

  test("channels keep the order people set, with new ones last and unnamed ones after the named", () => {
    const db = openMemoryDatabase();
    const work = createChatChannel(db, "work", 100);
    const ops = createChatChannel(db, "ops", 100);
    const names = () => listChatChannels(db).map((c) => c.name);
    expect(names()).toEqual(["general", "work", "ops"]);

    expect(reorderChatChannels(db, [ops.id, FIRST_CHANNEL, work.id]).map((c) => c.name)).toEqual(["ops", "general", "work"]);
    expect(names()).toEqual(["ops", "general", "work"]);
    createChatChannel(db, "docs", 100);
    expect(names()).toEqual(["ops", "general", "work", "docs"]);
    // A channel made on another device after the order was read keeps its place after the others.
    reorderChatChannels(db, [work.id, ops.id]);
    expect(names()).toEqual(["work", "ops", "general", "docs"]);

    expect(failure(() => reorderChatChannels(db, [work.id, chatChannelId(9)]))).toEqual({
      kind: "chat_channel_not_found",
      channel: 9,
    });
    expect(names()).toEqual(["work", "ops", "general", "docs"]);
  });

  test("deleting a channel moves its threads and messages to the default room", () => {
    const db = openMemoryDatabase();
    const ship = taskId(insertTask(db, insertWorkspace(db, "toodo"), "Ship"));
    const work = createChatChannel(db, "work", 100);
    const here: ChatPlace = { kind: "channel", id: work.id };
    const read = reply(db, { place: here, body: "Read" });
    markChatRead(db, here, read.id);
    const unread = reply(db, { place: here, body: "Unread" });
    const thread = createChatThread(db, { channel: work.id, title: "Deploy", task: ship }, 100);
    const inThread = reply(db, { place: { kind: "thread", id: thread.id }, body: "In thread" });

    deleteChatChannel(db, work.id, 300);

    expect(listChatChannels(db).map((c) => c.name)).toEqual(["general"]);
    const threads = listChatThreads(db, { archived: true });
    const kept = threads.find((t) => t.title === "#work");
    expect(kept).toMatchObject({ channelId: FIRST_CHANNEL, status: "archived", archivedAt: 300, taskId: null, unread: 1 });
    expect(allMessages(db, { kind: "thread", id: kept!.id }).map((m) => m.id)).toEqual([read.id, unread.id]);
    // The task's thread keeps its id, so the agent's ref to it still works.
    expect(threads.find((t) => t.id === thread.id)).toMatchObject({ channelId: FIRST_CHANNEL, taskId: ship });
    expect(allMessages(db, { kind: "thread", id: thread.id }).map((m) => m.id)).toEqual([inThread.id]);
    expect(allMessages(db, GENERAL)).toEqual([]);

    // A channel without messages of its own leaves no thread behind.
    const quiet = createChatChannel(db, "quiet", 100);
    deleteChatChannel(db, quiet.id, 300);
    expect(listChatThreads(db, { archived: true }).filter((t) => t.title === "#quiet")).toEqual([]);

    expect(failure(() => deleteChatChannel(db, FIRST_CHANNEL, 300))).toEqual({
      kind: "chat_channel_permanent",
      channel: FIRST_CHANNEL,
    });
    expect(failure(() => deleteChatChannel(db, work.id, 300))).toEqual({
      kind: "chat_channel_not_found",
      channel: work.id,
    });
  });

  test("threads keep their messages out of the channel and follow a task", () => {
    const db = openMemoryDatabase();
    const ship = taskId(insertTask(db, insertWorkspace(db, "toodo"), "Ship"));
    const thread = createChatThread(db, { channel: FIRST_CHANNEL, title: "Deploy", task: ship }, 100);
    expect([thread.status, thread.taskId, thread.closedAt, thread.lastMessageAt]).toEqual([
      "open",
      ship,
      null,
      null,
    ]);
    const place: ChatPlace = { kind: "thread", id: thread.id };
    const hi = say(db, place, "Ready?", "c1");
    expect([hi.channelId, hi.threadId]).toEqual([FIRST_CHANNEL, thread.id]);
    expect(allMessages(db, GENERAL)).toEqual([]);
    expect(allMessages(db, place)).toEqual([hi]);
    const linked = listChatThreads(db, { task: ship });
    expect(linked.map((t) => t.id)).toEqual([thread.id]);
    expect(linked[0]?.lastMessageAt).toBe(100);
    expect(
      failure(() => createChatThread(db, { channel: FIRST_CHANNEL, title: "Again", task: ship }, 100)),
    ).toEqual({ kind: "chat_thread_task_taken", task: ship, thread: thread.id });
    const loose = createChatThread(db, { channel: FIRST_CHANNEL, title: "Loose", task: null }, 100);
    expect(failure(() => updateChatThread(db, loose.id, { task: ship }, 100))).toEqual({
      kind: "chat_thread_task_taken",
      task: ship,
      thread: thread.id,
    });
    expect(updateChatThread(db, thread.id, { task: ship }, 100).taskId).toBe(ship);
    expect(
      failure(() => createChatThread(db, { channel: FIRST_CHANNEL, title: "Other", task: taskId(99) }, 100)),
    ).toEqual({ kind: "task_not_found", task: 99 });
    expect(updateChatThread(db, thread.id, { task: null }, 100).taskId).toBeNull();
  });

  test("a thread shows its latest message on one line", () => {
    const db = openMemoryDatabase();
    const thread = createChatThread(db, { channel: FIRST_CHANNEL, title: "Deploy", task: null }, 100);
    const place: ChatPlace = { kind: "thread", id: thread.id };
    const shown = () => listChatThreads(db, {})[0];
    expect(shown()?.lastMessage).toBeNull();
    reply(db, { place, body: "[progress] lane-1\nTests  pass" });
    expect(shown()?.lastMessage).toBe("[progress] lane-1 Tests pass");
    reply(db, { place, body: "x".repeat(300) });
    expect(shown()?.lastMessage).toBe(`${"x".repeat(197)}...`);
    const question = reply(db, { place, body: "Ship it?", actions: yesNo() });
    chooseChatAction(db, { message: question.id, key: "yes", clientId: "c1" }, 200);
    expect(shown()?.lastMessage).toBe("Yes");
  });

  test("waiting threads lead by their first waiting time until cleared", () => {
    using db = openMemoryDatabase();
    const older = createChatThread(db, { channel: FIRST_CHANNEL, title: "Deploy", task: null }, 100);
    const other = createChatThread(db, { channel: FIRST_CHANNEL, title: "Review", task: null }, 200);
    const recent = createChatThread(db, { channel: FIRST_CHANNEL, title: "Release", task: null }, 300);
    const listed = () => listChatThreads(db, {}).map(({ id, awaitingAt }) => [id, awaitingAt]);

    updateChatThread(db, other.id, { awaiting: true }, 400);
    updateChatThread(db, older.id, { awaiting: true }, 500);
    updateChatThread(db, other.id, { awaiting: true }, 600);
    expect(listed()).toEqual([[older.id, 500], [other.id, 400], [recent.id, null]]);

    updateChatThread(db, older.id, { awaiting: false }, 700);
    updateChatThread(db, other.id, { awaiting: false }, 800);
    expect(listed()).toEqual([[recent.id, null], [other.id, null], [older.id, null]]);
  });

  test("closed and archived threads refuse messages until reopened", () => {
    const db = openMemoryDatabase();
    const thread = createChatThread(db, { channel: FIRST_CHANNEL, title: "Deploy", task: null }, 100);
    const place: ChatPlace = { kind: "thread", id: thread.id };
    const closed = updateChatThread(db, thread.id, { status: "closed" }, 200);
    expect([closed.status, closed.closedAt, closed.archivedAt]).toEqual(["closed", 200, null]);
    expect(failure(() => say(db, place, "Hi", "c1"))).toMatchObject({
      kind: "chat_thread_not_open",
      status: "closed",
    });
    const archived = updateChatThread(db, thread.id, { status: "archived" }, 300);
    expect([archived.status, archived.closedAt, archived.archivedAt]).toEqual(["archived", 200, 300]);
    expect(failure(() => reply(db, { place, body: "Hi" }))).toMatchObject({
      kind: "chat_thread_not_open",
      status: "archived",
    });
    expect(listChatThreads(db, {})).toEqual([]);
    expect(listChatThreads(db, { archived: true })).toHaveLength(1);
    const reopened = updateChatThread(db, thread.id, { status: "open" }, 300);
    expect([reopened.closedAt, reopened.archivedAt]).toEqual([null, null]);
    say(db, place, "Hi", "c1");
  });

  test("unread counts the agent's messages after the last read one", () => {
    const db = openMemoryDatabase();
    const thread = createChatThread(db, { channel: FIRST_CHANNEL, title: "Deploy", task: null }, 100);
    const place: ChatPlace = { kind: "thread", id: thread.id };
    say(db, GENERAL, "Mine", "c1");
    const first = reply(db, { place: GENERAL, body: "One" });
    reply(db, { place: GENERAL, body: "Two" });
    const inThread = reply(db, { place, body: "Three" });
    const unread = () => listChatChannels(db)[0]?.unread;
    expect(unread()).toBe(3);
    markChatRead(db, GENERAL, first.id);
    expect(unread()).toBe(2);
    markChatRead(db, place, inThread.id);
    // Reading back never lowers the mark.
    markChatRead(db, place, chatMessageId(1));
    expect(unread()).toBe(1);
    expect(listChatThreads(db, {})[0]?.unread).toBe(0);
    reply(db, { place, body: "Four" });
    expect(unread()).toBe(2);
    // An archived thread no longer counts toward its channel.
    updateChatThread(db, thread.id, { status: "archived" }, 100);
    expect(unread()).toBe(1);
    // A task's thread counts on its own, not toward its channel.
    const ship = taskId(insertTask(db, insertWorkspace(db, "toodo"), "Ship"));
    const followed = createChatThread(db, { channel: FIRST_CHANNEL, title: "#1 Ship", task: ship }, 100);
    reply(db, { place: { kind: "thread", id: followed.id }, body: "Five" });
    expect(unread()).toBe(1);
    expect(listChatThreads(db, { task: ship })[0]?.unread).toBe(1);
    expect(failure(() => markChatRead(db, { kind: "thread", id: chatThreadId(9) }, first.id))).toEqual({
      kind: "chat_thread_not_found",
      thread: 9,
    });
  });

  test("a notice names the channel and thread unless the channel is quiet", () => {
    const db = openMemoryDatabase();
    const thread = createChatThread(db, { channel: FIRST_CHANNEL, title: "Deploy", task: null }, 100);
    expect(chatNotice(db, FIRST_CHANNEL, thread.id)).toEqual({
      channelId: FIRST_CHANNEL,
      channel: "general",
      threadId: thread.id,
      thread: "Deploy",
      awaiting: false,
    });
    updateChatThread(db, thread.id, { awaiting: true }, 101);
    expect(chatNotice(db, FIRST_CHANNEL, thread.id)?.awaiting).toBe(true);
    expect(chatNotice(db, FIRST_CHANNEL, null)).toEqual({
      channelId: FIRST_CHANNEL,
      channel: "general",
      threadId: null,
      thread: null,
      awaiting: false,
    });
    updateChatChannel(db, FIRST_CHANNEL, { push: false });
    expect(chatNotice(db, FIRST_CHANNEL, thread.id)).toBeNull();
    expect(listChatChannels(db)[0]?.push).toBe(false);
  });
});

describe("chat actions and attachments", () => {
  test("a choice is recorded once as a person's message where the question is", () => {
    const db = openMemoryDatabase();
    const thread = createChatThread(db, { channel: FIRST_CHANNEL, title: "Deploy", task: null }, 100);
    const place: ChatPlace = { kind: "thread", id: thread.id };
    const asked = reply(db, { place, body: "Deploy now?", actions: yesNo() });
    expect(asked.actions.map((a) => a.key)).toEqual(["yes", "no"]);
    const { choice, offered } = chooseChatAction(db, { message: asked.id, key: "no", clientId: "k1" }, 200);
    expect([choice.author, choice.body, choice.threadId]).toEqual(["user", "No", thread.id]);
    expect(choice.choiceOf).toEqual({ messageId: asked.id, key: "no" });
    expect(choice.dueAt).toBe(200 + ANSWER_WITHIN);
    expect(offered.chosen).toEqual({ key: "no", at: 200, choiceId: choice.id });
    // The agent receives the choice like any other message of a person.
    const taken = pendingChatMessages(db, true, 200);
    expect(taken.map((m) => [m.id, m.choiceOf])).toEqual([[choice.id, choice.choiceOf]]);
    // Sending the same click again returns it; another click is refused.
    expect(chooseChatAction(db, { message: asked.id, key: "no", clientId: "k1" }, 200).choice.id).toBe(choice.id);
    expect(failure(() => chooseChatAction(db, { message: asked.id, key: "yes", clientId: "k2" }, 200))).toEqual({
      kind: "chat_action_chosen",
      message: asked.id,
      key: "no",
    });
    const other = reply(db, { place, body: "And?", actions: yesNo() });
    expect(failure(() => chooseChatAction(db, { message: other.id, key: "maybe", clientId: "k3" }, 200)).kind).toBe(
      "chat_action_not_found",
    );
    expect(failure(() => chooseChatAction(db, { message: choice.id, key: "no", clientId: "k4" }, 200)).kind).toBe(
      "not_an_agents_message",
    );
    updateChatThread(db, thread.id, { status: "closed" }, 200);
    expect(failure(() => chooseChatAction(db, { message: other.id, key: "yes", clientId: "k5" }, 200)).kind).toBe(
      "chat_thread_not_open",
    );
    const [yes] = yesNo();
    if (yes === undefined) {
      throw new Error("yesNo offers no actions");
    }
    expect(() => reply(db, { place: GENERAL, body: "Twice", actions: [yes, yes] })).toThrow(SQLiteError);
  });

  test("uploads go once on a message of their own side and stale ones are dropped", () => {
    const db = openMemoryDatabase();
    const upload = (fileKey: string, uploader: "user" | "agent", name: string, at: number) =>
      createChatAttachment(db, { fileKey, uploader, name, contentType: "text/plain", size: 3 }, at);
    const mine = upload("k-mine", "user", "shot.png", 100);
    const agents = upload("k-agent", "agent", "log.txt", 100);
    expect(failure(() => reply(db, { body: "Here", attachments: [mine.id] }))).toEqual({
      kind: "chat_attachment_not_free",
      attachment: mine.id,
    });
    const sent = postUserMessage(db, { place: GENERAL, body: "See", clientId: "c1", attachments: [mine.id] }, 100);
    expect(sent.attachments.map((a) => [a.name, a.messageId])).toEqual([["shot.png", sent.id]]);
    expect(allMessages(db, GENERAL)[0]?.attachments).toEqual(sent.attachments);
    expect(
      failure(() => postUserMessage(db, { place: GENERAL, body: "Again", clientId: "c2", attachments: [mine.id] }, 100))
        .kind,
    ).toBe("chat_attachment_not_free");
    expect(
      failure(() => postUserMessage(db, { place: GENERAL, body: "None", clientId: "c3", attachments: [chatAttachmentId(99)] }, 100)),
    ).toEqual({ kind: "chat_attachment_not_found", attachment: 99 });
    // The failed messages were not stored.
    expect(allMessages(db)).toHaveLength(1);
    const found = chatAttachment(db, mine.id);
    expect([found?.attachment.uploader, found?.fileKey]).toEqual(["user", "k-mine"]);
    upload("k-new", "user", "new.txt", 200);
    // Only the free upload made before the cutoff goes; the new one and the sent one stay.
    expect(removeStaleChatAttachments(db, 101)).toEqual(["k-agent"]);
    expect(chatAttachment(db, agents.id)).toBeNull();
    expect(chatAttachment(db, mine.id)).not.toBeNull();
  });
});
