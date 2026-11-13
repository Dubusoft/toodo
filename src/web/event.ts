/**
 * Delivers server events: listeners get the events of
 * `toodo-server`'s event stream (`GET /api/events`), which one connection reads for all
 * of them. When the stream drops, it reconnects after a growing delay with the id of the
 * last event it got (`Last-Event-ID`), and the server replays what was missed meanwhile.
 * When the server cannot, or this stream fell behind, the server sends a `resync` event and
 * `onReconnect` subscribers are told to refetch everything; so are they after a reconnect
 * without an id. It reconnects at once when the server answers again (see `connection.ts`).
 * A token the server rejects is forgotten, so the app asks for it again.
 */
import { onReachable, recoveryCount, serverFetch } from "@/web/connection";
import { credentials, forgetToken, rejectedByServer, subscribeToken } from "@/web/session";

export type Event<T> = { event: string; id: number; payload: T };
export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;

type ServerSentEvent = { event: string; data: string; id?: string };

/** Tells the client it missed events and has to refetch everything. */
const RESYNC = "resync";

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

const handlers = new Map<string, Set<EventCallback<unknown>>>();
const reconnectListeners = new Set<() => void>();
let connection: AbortController | null = null;
let nextId = 0;
/** The id of the last event the server sent, to resume from after a reconnect. */
let lastEventId: string | null = null;

/**
 * Splits server-sent events off the front of `buffer`: complete events and the incomplete
 * rest. Comments (keep-alives) and events without a name are dropped; `id` is set only
 * on events that carry one.
 */
export function parseServerSentEvents(buffer: string): { events: ServerSentEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: ServerSentEvent[] = [];
  for (const block of blocks) {
    let event = "";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      } else if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      }
    }
    if (event) {
      events.push(id === undefined ? { event, data: data.join("\n") } : { event, data: data.join("\n"), id });
    }
  }
  return { events, rest };
}

function deliver({ event, data, id }: ServerSentEvent) {
  if (id !== undefined) lastEventId = id;
  if (event === RESYNC) {
    reconnectListeners.forEach((listener) => listener());
    return;
  }
  const listeners = handlers.get(event);
  if (!listeners) return;
  const payload: unknown = data ? JSON.parse(data) : null;
  for (const listener of listeners) {
    listener({ event, id: nextId++, payload });
  }
}

/** Opens the event stream; resolves once the server accepted it. */
async function open(signedIn: Record<string, string>, signal: AbortSignal): Promise<ReadableStreamDefaultReader<string>> {
  const headers = { ...signedIn, ...(lastEventId === null ? {} : { "Last-Event-ID": lastEventId }) };
  const response = await serverFetch("/api/events", { headers, signal });
  if (await rejectedByServer(response)) {
    // Stops this connection: forgetting the token disconnects.
    forgetToken();
  }
  if (!response.ok || response.body === null) {
    throw new Error(`event stream failed: ${response.status}`);
  }
  return response.body.pipeThrough(new TextDecoderStream()).getReader();
}

async function read(reader: ReadableStreamDefaultReader<string>): Promise<void> {
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const parsed = parseServerSentEvents(buffer + value);
    buffer = parsed.rest;
    parsed.events.forEach(deliver);
  }
}

function connect() {
  const signedIn = credentials();
  if (connection !== null || signedIn === null || handlers.size === 0) return;
  const controller = new AbortController();
  connection = controller;
  void (async () => {
    let delay = FIRST_RETRY_MS;
    let connected = false;
    while (!controller.signal.aborted) {
      const recoveries = recoveryCount();
      try {
        const reader = await open(signedIn, controller.signal);
        // With an id, the server replays what was missed or sends a resync itself.
        if (connected && lastEventId === null) {
          reconnectListeners.forEach((listener) => listener());
        }
        connected = true;
        delay = FIRST_RETRY_MS;
        await read(reader);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("toodo: event stream dropped, reconnecting", error);
      }
      if (recoveryCount() !== recoveries) {
        continue;
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          stop();
          resolve();
        };
        const timer = setTimeout(wake, delay);
        const stop = onReachable(wake);
      });
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  })();
}

function disconnect() {
  connection?.abort();
  connection = null;
}

subscribeToken(() => {
  disconnect();
  connect();
});

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const listeners = handlers.get(event) ?? new Set();
  listeners.add(handler as EventCallback<unknown>);
  handlers.set(event, listeners);
  connect();
  return () => {
    listeners.delete(handler as EventCallback<unknown>);
    if (listeners.size === 0) handlers.delete(event);
    if (handlers.size === 0) disconnect();
  };
}

/** Calls `listener` whenever events may have been missed, so everything has to be refetched. */
export function onReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}
