import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type ChatMessage } from "@/lib/bindings";
import {
  chatOutbox,
  discardChatMessage,
  flushChatOutbox,
  queueChatMessage,
  retryChatMessage,
  samePlace,
} from "@/lib/chat-outbox";

vi.mock("@/lib/bindings", () => ({ commands: { sendChatMessage: vi.fn() } }));

const send = vi.mocked(commands.sendChatMessage);
const stored = { status: "ok", data: {} as ChatMessage } as const;
const refusal = {
  status: "error",
  error: { kind: "rejected", code: "rejected", message: "the thread is closed" },
} as const;
const message = { clientId: "c-1", place: { channel: 1 }, body: "Hello", attachments: [] };

beforeEach(() => {
  localStorage.clear();
  send.mockReset();
});

describe("chat outbox", () => {
  it("keeps a message until the server stores it and the chat has reloaded", async () => {
    send.mockResolvedValue(stored);
    const refresh = vi.fn(async () => expect(chatOutbox()).toHaveLength(1));

    expect(await queueChatMessage(message, refresh)).toBe(true);

    expect(send).toHaveBeenCalledWith({ channel: 1 }, "Hello", "c-1", []);
    expect(refresh).toHaveBeenCalledOnce();
    expect(chatOutbox()).toEqual([]);
  });

  it("keeps a message that could not reach the server and sends it once, under its client id, on flush", async () => {
    send.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const refresh = vi.fn(async () => {});
    expect(await queueChatMessage(message, refresh)).toBe(false);
    expect(chatOutbox()).toEqual([{ ...message, waiting: true, refused: null }]);

    let answer!: () => void;
    send.mockImplementation(() => new Promise((resolve) => (answer = () => resolve(stored))));
    const flushes = [flushChatOutbox(refresh), flushChatOutbox(refresh)];
    answer();

    expect(await Promise.all(flushes)).toEqual([1, 0]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual([{ channel: 1 }, "Hello", "c-1", []]);
    expect(chatOutbox()).toEqual([]);
  });

  it("keeps a refused message with the reason, out of flushes, until it is retried or discarded", async () => {
    send.mockResolvedValue(refusal);
    const refresh = vi.fn(async () => {});
    await queueChatMessage(message, refresh);
    await queueChatMessage({ ...message, clientId: "c-2" }, refresh);
    expect(chatOutbox().map((item) => item.refused)).toEqual([expect.stringContaining("closed"), expect.any(String)]);

    expect(await flushChatOutbox(refresh)).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);

    send.mockResolvedValue(stored);
    expect(await retryChatMessage("c-1", refresh)).toBe(true);
    discardChatMessage("c-2");
    expect(chatOutbox()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("starts over empty from an unreadable stored outbox", () => {
    localStorage.setItem("toodo-chat-outbox", "{not json");
    expect(chatOutbox()).toEqual([]);
    localStorage.setItem("toodo-chat-outbox", JSON.stringify([{ clientId: 1 }, { ...message, waiting: true, refused: null }]));
    expect(chatOutbox()).toEqual([{ ...message, waiting: true, refused: null }]);
  });

  it("tells channels and threads apart", () => {
    expect(samePlace({ channel: 1 }, { channel: 1 })).toBe(true);
    expect(samePlace({ channel: 1 }, { channel: 2 })).toBe(false);
    expect(samePlace({ thread: 1 }, { thread: 1 })).toBe(true);
    expect(samePlace({ thread: 1 }, { channel: 1 })).toBe(false);
    expect(samePlace({ channel: 1 }, { thread: 1 })).toBe(false);
  });
});
