import { describe, expect, test } from "bun:test";

import type * as B from "../../../src/lib/api.ts";
import { memoryStorage } from "../storage/storage-fixtures.ts";
import {
  ChatState,
  PAGE,
  TYPING_FOR,
  createChatChannel,
  createChatThread,
  listChat,
  sendChatMessage,
  updateChatChannel,
  updateChatThread,
} from "./chat.ts";
import { commandFailure as failure } from "./command-fixtures.ts";

const GENERAL: B.ChatPlace = { channel: 1 };

function state(): ChatState {
  return new ChatState({ name: "Agent", avatarUrl: null });
}

describe("chat commands", () => {
  test("a page tells whether earlier messages remain", () => {
    const storage = memoryStorage();
    const chat = state();
    for (let n = 0; n <= PAGE; n += 1) {
      sendChatMessage(storage, GENERAL, `m${n}`, `c${n}`, []);
    }
    const latest = listChat(storage, chat, GENERAL, null);
    expect([latest.messages.length, latest.hasEarlier]).toEqual([PAGE, true]);
    const earlier = listChat(storage, chat, GENERAL, latest.messages[0]?.id ?? null);
    expect([earlier.messages.length, earlier.hasEarlier]).toEqual([1, false]);
    expect(earlier.messages[0]?.body).toBe("m0");
  });

  test("typing lasts until it runs out or is turned off", () => {
    const chat = state();
    expect(chat.setTyping(GENERAL, true, 100)).toBe(100 + TYPING_FOR);
    expect(chat.typingUntil(GENERAL, 100 + TYPING_FOR - 1)).toBe(100 + TYPING_FOR);
    expect(chat.typingUntil(GENERAL, 100 + TYPING_FOR)).toBeNull();
    chat.setTyping(GENERAL, true, 100);
    expect(chat.setTyping(GENERAL, false, 101)).toBeNull();
    expect(chat.typingUntil(GENERAL, 101)).toBeNull();
  });

  test("typing shows only in the place the agent writes in", () => {
    const storage = memoryStorage();
    const chat = state();
    const thread = createChatThread(storage, { channelId: 1, title: "Ship", taskId: null });
    const now = storage.now();
    chat.setTyping(GENERAL, true, now);

    expect(listChat(storage, chat, GENERAL, null).typingUntil).toBe(now + TYPING_FOR);
    expect(listChat(storage, chat, { thread: thread.id }, null).typingUntil).toBeNull();
    expect(listChat(storage, chat, { channel: 2 }, null).typingUntil).toBeNull();
    chat.setTyping({ thread: thread.id }, false, now);
    expect(chat.typingUntil(GENERAL, now)).toBe(now + TYPING_FOR);
  });

  test("chat pages return the client id of a stored message", () => {
    const storage = memoryStorage();
    sendChatMessage(storage, GENERAL, "Hello", "owner-1", []);

    const page = listChat(storage, state(), GENERAL, null);

    expect(page.messages[0]).toHaveProperty("clientId", "owner-1");
  });

  test("blank messages and bad client ids are refused", () => {
    const storage = memoryStorage();
    expect(failure(() => sendChatMessage(storage, GENERAL, " ", "c1", [])).code).toBe("invalidInput");
    expect(failure(() => sendChatMessage(storage, GENERAL, "Hi", "", [])).code).toBe("invalidInput");
    expect(sendChatMessage(storage, GENERAL, " Hi ", "c1", []).body).toBe("Hi");
  });

  test("channels and threads are named on one line and threads close", () => {
    const storage = memoryStorage();
    const work = createChatChannel(storage, "#work");
    expect(work.name).toBe("work");
    expect(failure(() => createChatChannel(storage, "a\nb")).code).toBe("invalidInput");
    const thread = createChatThread(storage, { channelId: work.id, title: " Deploy ", taskId: null });
    expect(thread.title).toBe("Deploy");
    const closed = updateChatThread(storage, thread.id, { status: "closed" });
    expect(closed.status).toBe("closed");
    const refused = failure(() => sendChatMessage(storage, { thread: thread.id }, "Hi", "c1", []));
    expect(refused.code).toBe("rejected");
    const quiet = updateChatChannel(storage, work.id, { name: null, push: false });
    expect(quiet.push).toBe(false);
  });
});
