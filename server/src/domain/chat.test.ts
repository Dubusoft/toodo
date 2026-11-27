import { describe, expect, test } from "bun:test";

import {
  type ActionStyle,
  type ChatAuthor,
  type ChatMessage,
  FIRST_CHANNEL,
  type ThreadStatus,
  chatAuthorAsStr,
  chatMessageId,
  isOverdue,
  parseActionStyle,
  parseChatAuthor,
  parseThreadStatus,
} from "./chat.ts";

describe("chat", () => {
  test("authors round trip their stored names", () => {
    for (const author of ["user", "agent", "system"] satisfies ChatAuthor[]) {
      expect(parseChatAuthor(chatAuthorAsStr(author))).toBe(author);
    }
    expect(chatAuthorAsStr("agent")).toBe("lead");
    expect(parseChatAuthor("agent")).toBeNull();
  });

  test("thread statuses round trip their stored names", () => {
    for (const status of ["open", "closed", "archived"] satisfies ThreadStatus[]) {
      expect(parseThreadStatus(status)).toBe(status);
    }
    expect(parseThreadStatus("deleted")).toBeNull();
  });

  test("action styles round trip their stored names", () => {
    for (const style of ["default", "primary", "danger"] satisfies ActionStyle[]) {
      expect(parseActionStyle(style)).toBe(style);
    }
    expect(parseActionStyle("link")).toBeNull();
  });

  test("only unhandled messages past their due time are overdue", () => {
    const message: ChatMessage = {
      id: chatMessageId(1),
      channelId: FIRST_CHANNEL,
      threadId: null,
      author: "user",
      body: "Hi",
      at: 0,
      deliveredAt: null,
      ackedAt: null,
      handledAt: null,
      handledReplyId: null,
      handledTaskId: null,
      dueAt: 10,
      actions: [],
      chosen: null,
      choiceOf: null,
      attachments: [],
    };
    expect(isOverdue(message, 9)).toBe(false);
    expect(isOverdue(message, 10)).toBe(true);
    expect(isOverdue({ ...message, handledAt: 5, ackedAt: 5 }, 10)).toBe(false);
    expect(isOverdue({ ...message, dueAt: null }, 10)).toBe(false);
  });
});
