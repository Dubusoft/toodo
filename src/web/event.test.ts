import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServerSentEvents } from "@/web/event";

const TOKEN_KEY = "toodo-server-token";

/** A stream that stays open until the test ends, or one that ends at once. */
function eventStream(open: boolean): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (!open) controller.close();
      },
    }),
    { status: 200 },
  );
}

/** A fresh copy of the module, since it keeps one connection for the whole page. */
async function freshEventModule() {
  vi.resetModules();
  return import("@/web/event");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("event stream connection", () => {
  it("tells reconnect listeners only once the server answers again", async () => {
    vi.useFakeTimers();
    localStorage.setItem(TOKEN_KEY, "secret");
    const stream = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(eventStream(false))
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(eventStream(true));
    // The failed connections make the app probe the server (see connection.ts), which stays down.
    vi.stubGlobal("fetch", (path: string) =>
      path === "/api/events" ? stream() : Promise.reject(new TypeError("connection refused")),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { listen, onReconnect } = await freshEventModule();
    const reconnected = vi.fn();
    onReconnect(reconnected);
    const unlisten = await listen("tasks-changed", () => {});

    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(stream).toHaveBeenCalledTimes(3);
    expect(reconnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4000);
    expect(stream).toHaveBeenCalledTimes(4);
    expect(reconnected).toHaveBeenCalledTimes(1);
    unlisten();
  });

  it("reconnects at once when the server answers again", async () => {
    vi.useFakeTimers();
    localStorage.setItem(TOKEN_KEY, "secret");
    const stream = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(eventStream(false))
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(eventStream(true));
    vi.stubGlobal("fetch", (path: string) =>
      path === "/api/events" ? stream() : Promise.resolve(new Response(null, { status: 401 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { listen, onReconnect } = await freshEventModule();
    const reconnected = vi.fn();
    onReconnect(reconnected);
    const unlisten = await listen("tasks-changed", () => {});

    // The second connection fails, the probe it starts gets an answer, and the stream does
    // not wait out its 2 s delay.
    await vi.advanceTimersByTimeAsync(1000);
    expect(stream).toHaveBeenCalledTimes(3);
    expect(reconnected).toHaveBeenCalledTimes(1);
    unlisten();
  });

  it("forgets a token the server rejects and stops retrying", async () => {
    vi.useFakeTimers();
    localStorage.setItem(TOKEN_KEY, "revoked");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { listen } = await freshEventModule();
    const unlisten = await listen("tasks-changed", () => {});

    await vi.advanceTimersByTimeAsync(60_000);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    unlisten();
  });
});

describe("parseServerSentEvents", () => {
  it("returns complete events and keeps the incomplete rest", () => {
    const { events, rest } = parseServerSentEvents(
      'event: tasks-changed\ndata: {"workspaceId":1}\n\n:keep-alive\n\nevent: agent-statuses-changed\ndata: {"sta',
    );
    expect(events).toEqual([{ event: "tasks-changed", data: '{"workspaceId":1}' }]);
    expect(rest).toBe('event: agent-statuses-changed\ndata: {"sta');
  });

  it("joins multi-line data and accepts CRLF line ends", () => {
    const { events, rest } = parseServerSentEvents("event: x\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(events).toEqual([{ event: "x", data: "a\nb" }]);
    expect(rest).toBe("");
  });
});
