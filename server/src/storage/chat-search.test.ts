import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { type ChatPlace, FIRST_CHANNEL, chatChannelId } from "../domain/chat.ts";
import { createChatChannel } from "./chat-channels.ts";
import { type ChatHit, searchChat } from "./chat-search.ts";
import { createChatThread } from "./chat-threads.ts";
import { postAgentMessage, postUserMessage } from "./chat.ts";
import { openMemoryDatabase } from "./testing.ts";

const GENERAL: ChatPlace = { kind: "channel", id: FIRST_CHANNEL };

function say(db: Database, place: ChatPlace, body: string, clientId: string): void {
  postUserMessage(db, { place, body, clientId, attachments: [] }, 100);
}

function search(db: Database, query: string, place: ChatPlace | null = null): ChatHit[] {
  return searchChat(db, { query, place, limit: 20 });
}

function bodies(hits: ChatHit[]): string[] {
  return hits.map((hit) => hit.message.body);
}

test("every word must match and short words match as substrings", () => {
  const db = openMemoryDatabase();
  say(db, GENERAL, "Deploy the server tonight", "c1");
  postAgentMessage(
    db,
    { place: null, body: "The deploy finished; \uBC30\uD3EC \uC644\uB8CC", handles: [], actions: [], attachments: [] },
    100,
  );
  say(db, GENERAL, "Unrelated", "c2");
  expect(search(db, "DEPLOY")).toHaveLength(2);
  expect(bodies(search(db, "deploy tonight"))).toEqual(["Deploy the server tonight"]);
  // Two-character Korean words cannot use the trigram index.
  expect(bodies(search(db, "\uBC30\uD3EC"))).toEqual(["The deploy finished; \uBC30\uD3EC \uC644\uB8CC"]);
  expect(search(db, "  ")).toEqual([]);
  // Operators are plain text.
  expect(search(db, "deploy OR unrelated")).toEqual([]);
});

test("a channel takes in its threads and hits name where they are", () => {
  const db = openMemoryDatabase();
  const work = createChatChannel(db, "work", 100);
  const thread = createChatThread(db, { channel: work.id, title: "Release", task: null }, 100);
  say(db, { kind: "thread", id: thread.id }, "Ship it", "c1");
  say(db, GENERAL, "Ship later", "c2");
  const hits = search(db, "ship", { kind: "channel", id: work.id });
  expect(bodies(hits)).toEqual(["Ship it"]);
  expect([hits[0]?.channel, hits[0]?.thread]).toEqual(["work", "Release"]);
  const general = search(db, "ship", GENERAL);
  expect([general[0]?.channel, general[0]?.thread]).toEqual(["general", null]);
  expect(search(db, "ship", { kind: "channel", id: chatChannelId(9) })).toEqual([]);
});
