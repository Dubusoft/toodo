// The events of `GET /api/events`, with ids so a client that reconnects gets what it
// missed. Port of `src-tauri/src/server/event_log.rs`.
//
// Every event gets an id `<epoch>-<sequence>`: `epoch` is random per server start and
// `sequence` counts up from 1. The log keeps the most recent `REPLAY` events. A stream
// opened with a `Last-Event-ID` of this epoch first replays the kept events after it; when
// some of them are gone, or the id is of another server start or not one at all, it starts
// with a `resync` event instead, which tells the client to refetch everything. A stream
// opened without one starts with a `ready` event that carries the current id, so the
// client has an id to resume from even before the first change. A stream whose reader
// falls behind the live events also gets a `resync` and then goes on.

import { randomBytes } from "node:crypto";

/** Tells the client that it missed events and has to refetch everything. */
export const RESYNC = "resync";
/** Opens a stream that resumes nothing, with the id to resume from later. */
export const READY = "ready";

/** Events kept for clients that reconnect, and queued for streams that read slower than
 * events arrive; a stream that falls further behind gets a `resync`. */
export const REPLAY = 256;

/** How often an idle stream gets a comment, so proxies and browsers keep it open (axum's
 * default keep-alive). */
const KEEP_ALIVE_MS = 15_000;

/** An event as sent: its id, name, and JSON data. */
export type SentEvent = { readonly id: string; readonly name: string; readonly data: string };

type Logged = { readonly sequence: number; readonly name: string; readonly data: string };

export class EventLog {
  readonly #epoch: string;
  readonly #capacity: number;
  #last = 0;
  #recent: Logged[] = [];
  readonly #streams = new Set<EventStream>();

  constructor(epoch: string = randomBytes(4).toString("hex"), capacity: number = REPLAY) {
    this.#epoch = epoch;
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** The sequence of the last event; 0 before the first. */
  get last(): number {
    return this.#last;
  }

  id(sequence: number): string {
    return `${this.#epoch}-${sequence}`;
  }

  send(name: string, data: string): void {
    this.#last += 1;
    const event: Logged = { sequence: this.#last, name, data };
    if (this.#recent.length === this.#capacity) this.#recent.shift();
    this.#recent.push(event);
    for (const stream of this.#streams) stream.deliver(event);
  }

  /** The events of a stream opened with `lastEventId`, then the live ones. */
  stream(lastEventId: string | null): EventStream {
    const first =
      lastEventId === null
        ? [this.marker(READY, this.#last)]
        : (this.#missed(lastEventId) ?? [this.marker(RESYNC, this.#last)]);
    const stream = new EventStream(this, first, () => this.#streams.delete(stream));
    this.#streams.add(stream);
    return stream;
  }

  marker(name: string, sequence: number): SentEvent {
    return { id: this.id(sequence), name, data: "" };
  }

  sent(event: Logged): SentEvent {
    return { id: this.id(event.sequence), name: event.name, data: event.data };
  }

  /** The kept events after `id`, or `null` when the client has to refetch instead. */
  #missed(id: string): SentEvent[] | null {
    const trimmed = id.trim();
    const dash = trimmed.lastIndexOf("-");
    if (dash < 0) return null;
    const digits = trimmed.slice(dash + 1);
    if (!/^\+?\d+$/.test(digits)) return null;
    const sequence = Number(digits);
    if (trimmed.slice(0, dash) !== this.#epoch || sequence > this.#last) return null;
    const oldest = this.#recent[0]?.sequence ?? this.#last + 1;
    if (sequence + 1 < oldest) return null;
    return this.#recent.filter((event) => event.sequence > sequence).map((event) => this.sent(event));
  }
}

/** One open stream: the events queued for its reader, which it takes one at a time. */
export class EventStream {
  readonly #log: EventLog;
  /** What the stream opens with, a marker or a replay; never dropped for lagging. */
  readonly #first: SentEvent[];
  /** The live events, at most the log's capacity. */
  #queue: SentEvent[] = [];
  /** Whether live events were dropped since the reader last read; its next read is a
   * `resync` covering every event up to then. */
  #lagged = false;
  #wake: (() => void) | null = null;
  readonly #close: () => void;

  constructor(log: EventLog, first: SentEvent[], close: () => void) {
    this.#log = log;
    this.#first = first;
    this.#close = close;
  }

  deliver(event: Logged): void {
    if (this.#lagged) return;
    if (this.#queue.length >= this.#log.capacity) {
      console.error(`toodo-server: an event stream missed ${this.#queue.length} events; resyncing it`);
      this.#lagged = true;
      this.#queue = [];
    } else {
      this.#queue.push(this.#log.sent(event));
    }
    this.#wake?.();
  }

  /** The live events to read now: a `resync` up to the latest event after a lag. */
  #live(): SentEvent[] {
    if (this.#lagged) {
      this.#lagged = false;
      this.#queue = [this.#log.marker(RESYNC, this.#log.last)];
    }
    return this.#queue;
  }

  /** The events queued now, without waiting for more. */
  ready(): SentEvent[] {
    const ready = [...this.#first.splice(0), ...this.#live()];
    this.#queue = [];
    return ready;
  }

  /** The next event, or `null` once `timeoutMs` passes without one. */
  async next(timeoutMs: number): Promise<SentEvent | null> {
    if (this.#first.length > 0) return this.#first.shift()!;
    if (this.#live().length === 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        timer = setTimeout(resolve, timeoutMs);
      });
      clearTimeout(timer);
      this.#wake = null;
    }
    return this.#live().shift() ?? null;
  }

  close(): void {
    this.#close();
    this.#wake?.();
  }

  /** The stream as a `text/event-stream` body, with a keep-alive comment while idle. */
  body(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const event = await this.next(KEEP_ALIVE_MS);
        controller.enqueue(encoder.encode(event === null ? ":\n\n" : encode(event)));
      },
      cancel: () => this.close(),
    });
  }
}

/** An event in the text of an event stream: `data` gets a line per line it holds. */
export function encode(event: SentEvent): string {
  const data = event.data.split("\n").map((line) => `data: ${line}\n`).join("");
  return `id: ${event.id}\nevent: ${event.name}\n${data}\n`;
}
