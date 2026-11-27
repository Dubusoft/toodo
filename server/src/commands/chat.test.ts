import { describe, expect, test } from "bun:test";

import type * as B from "../../../src/lib/bindings.ts";
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
    expect(chat.setTyping(true, 100)).toBe(100 + TYPING_FOR);
    expect(chat.typingUntil(100 + TYPING_FOR - 1)).toBe(100 + TYPING_FOR);
    expect(chat.typingUntil(100 + TYPING_FOR)).toBeNull();
    chat.setTyping(true, 100);
    expect(chat.setTyping(false, 101)).toBeNull();
    expect(chat.typingUntil(101)).toBeNull();
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
