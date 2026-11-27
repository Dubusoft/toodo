import { describe, expect, test } from "bun:test";

import type * as B from "../../../src/lib/bindings.ts";
import { FIRST_CHANNEL, type ChatMessage, chatAttachmentId, chatMessageId, chatThreadId } from "../domain/chat.ts";
import {
  ACTION_LIMIT,
  CHAT_BODY_LIMIT,
  channelName,
  chatActions,
  chatBody,
  clientId,
  contentType,
  fileName,
  message,
  place,
  placeOf,
  threadEdit,
  threadTitle,
} from "./chat-types.ts";

describe("chat shapes", () => {
  test("bodies are trimmed and limited", () => {
    expect(chatBody("  Hi \n")).toBe("Hi");
    expect(() => chatBody(" \n ")).toThrow();
    const longest = "é".repeat(CHAT_BODY_LIMIT);
    expect(chatBody(longest)).toBe(longest);
    expect(() => chatBody(`${longest}x`)).toThrow();
  });

  test("channel names drop their hash and titles stay single lines", () => {
    expect(channelName(" #work ")).toBe("work");
    for (const bad of ["#", " ", "a\nb", "x".repeat(51)]) {
      expect(() => channelName(bad)).toThrow();
    }
    expect(threadTitle(" #12 Deploy ")).toBe("#12 Deploy");
    expect(() => threadTitle("a\nb")).toThrow();
  });

  test("places and thread edits refuse two answers at once", () => {
    expect(() => placeOf(1, 2)).toThrow();
    expect(placeOf(null, 2)).toEqual({ kind: "thread", id: chatThreadId(2) });
    expect(placeOf(null, null)).toBeNull();
    expect(() => threadEdit({ taskId: 1, unlinkTask: true })).toThrow();
    expect(threadEdit({ unlinkTask: true }).task).toBeNull();
    expect(place({ thread: 3 })).toEqual({ kind: "thread", id: chatThreadId(3) });
  });

  test("client ids are short single lines", () => {
    expect(clientId("c-1")).toBe("c-1");
    for (const bad of ["", " ", "a\nb", "x".repeat(101)]) {
      expect(() => clientId(bad)).toThrow();
    }
  });

  test("messages use camel case keys and snake case authors", () => {
    const stored: ChatMessage = {
      id: chatMessageId(3),
      channelId: FIRST_CHANNEL,
      threadId: chatThreadId(2),
      author: "agent",
      body: "Hello",
      at: 5,
      deliveredAt: null,
      ackedAt: null,
      handledAt: null,
      handledReplyId: null,
      handledTaskId: null,
      dueAt: null,
      actions: [{ key: "ok", label: "OK", style: "primary" }],
      chosen: { key: "ok", at: 6, choiceId: chatMessageId(4) },
      choiceOf: null,
      attachments: [{
        id: chatAttachmentId(7),
        uploader: "agent",
        name: "log.txt",
        contentType: "text/plain",
        size: 12,
        messageId: chatMessageId(3),
        createdAt: 5,
      }],
    };
    expect(JSON.parse(JSON.stringify(message(stored, 5)))).toEqual({
      id: 3, channelId: 1, threadId: 2, author: "agent", body: "Hello",
      at: 5, deliveredAt: null,
      ackedAt: null, handledAt: null, handledReplyId: null,
      handledTaskId: null, overdue: false,
      actions: [{ key: "ok", label: "OK", style: "primary" }],
      chosen: { key: "ok", at: 6, choiceId: 4 },
      choiceOf: null,
      attachments: [{ id: 7, name: "log.txt", contentType: "text/plain", size: 12 }],
    });
  });

  test("actions are limited single lines with unique keys", () => {
    const action = (key: string, label: string): B.ChatAction => ({ key, label, style: "default" });
    expect(chatActions([action(" yes ", " Yes "), action("no", "No")]).map((a) => [a.key, a.label])).toEqual([
      ["yes", "Yes"],
      ["no", "No"],
    ]);
    expect(() => chatActions([action("a", "A"), action("a", "B")])).toThrow();
    expect(() => chatActions([action("a", "")])).toThrow();
    expect(() => chatActions([action("a\nb", "A")])).toThrow();
    const many = Array.from({ length: ACTION_LIMIT + 1 }, (_, n) => action(String(n), "A"));
    expect(() => chatActions(many)).toThrow();
    expect(chatActions([{ key: "k", label: "L" } as B.ChatAction])[0]?.style).toBe("default");
  });

  test("uploads keep the base name and a well formed media type", () => {
    expect(fileName("C:\\shots\\a b.png")).toBe("a b.png");
    expect(fileName("../../etc/passwd")).toBe("passwd");
    for (const bad of ["", "dir/", "a\nb"]) {
      expect(() => fileName(bad)).toThrow();
    }
    expect(contentType("Image/PNG; q=1")).toBe("image/png");
    for (const bad of [null, "", "png", "text/ html", "a/b/c", "te\u212At/plain"]) {
      expect(contentType(bad)).toBe("application/octet-stream");
    }
  });
});
