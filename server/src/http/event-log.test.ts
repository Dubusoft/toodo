import { describe, expect, test } from "bun:test";

import { encode, EventLog, READY, RESYNC, type EventStream } from "./event-log.ts";

function log(capacity: number): EventLog {
  return new EventLog("ab12", capacity);
}

function send(log: EventLog, data: string) {
  log.send("tasks-changed", data);
}

function ready(stream: EventStream): Array<[string, string, string]> {
  return stream.ready().map((event) => [event.id, event.name, event.data]);
}

const event = (id: string, data: string): [string, string, string] => [id, "tasks-changed", data];
const marker = (id: string, name: string): [string, string, string] => [id, name, ""];

describe("event log", () => {
  test("a new stream starts with the current id and numbers every event", () => {
    const events = log(4);
    send(events, "1");
    const stream = events.stream(null);
    send(events, "2");
    expect(ready(stream)).toEqual([marker("ab12-1", READY), event("ab12-2", "2")]);
  });

  test("a reconnecting stream replays the events it missed", () => {
    const events = log(4);
    for (const data of ["1", "2", "3"]) send(events, data);
    expect(ready(events.stream("ab12-1"))).toEqual([event("ab12-2", "2"), event("ab12-3", "3")]);
    expect(ready(events.stream("ab12-3"))).toEqual([]);
    expect(ready(events.stream("ab12-0"))).toHaveLength(3);
  });

  test("a stream resyncs when missed events are gone or the id is unknown", () => {
    const events = log(2);
    for (const data of ["1", "2", "3", "4"]) send(events, data);
    // Event 2 is gone; 3 and 4 are kept.
    expect(ready(events.stream("ab12-2"))).toHaveLength(2);
    for (const id of ["ab12-1", "ab12-5", "ffff-3", "3", "ab12-x", ""]) {
      expect(ready(events.stream(id))).toEqual([marker("ab12-4", RESYNC)]);
    }
  });

  test("a stream that fell behind resyncs and goes on", async () => {
    const events = log(2);
    const stream = events.stream(null);
    for (const data of ["1", "2", "3", "4"]) send(events, data);
    expect((await stream.next(0))?.id).toBe("ab12-0");
    // Events 1 and 2 were overwritten; the resync covers 3 and 4 too.
    expect(await stream.next(0)).toEqual({ id: "ab12-4", name: RESYNC, data: "" });
    send(events, "5");
    expect((await stream.next(0))?.id).toBe("ab12-5");
  });

  test("a closed stream gets no more events", () => {
    const events = log(4);
    const stream = events.stream(null);
    stream.close();
    send(events, "1");
    expect(ready(stream)).toEqual([marker("ab12-0", READY)]);
  });

  test("an event is sent with its id, name, and a data line per line", () => {
    expect(encode({ id: "ab12-3", name: "chat-changed", data: "null" })).toBe(
      "id: ab12-3\nevent: chat-changed\ndata: null\n\n",
    );
    expect(encode({ id: "ab12-0", name: READY, data: "" })).toBe("id: ab12-0\nevent: ready\ndata: \n\n");
  });
});
