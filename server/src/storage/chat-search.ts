// Finding earlier chat messages: full-text search over the `chat_search` index, matched as
// `search_tasks` matches tasks. Port of `src-tauri/src/storage/chat_search.rs`.

import type { Database, SQLQueryBindings } from "bun:sqlite";

import { type ChatMessage, type ChatPlace, chatMessageId } from "../domain/chat.ts";
import { charCount } from "../domain/rust.ts";
import { messagesById } from "./chat-messages.ts";
import { StorageError } from "./errors.ts";
import { TRIGRAM, ftsString, likePattern, splitWhitespace } from "./search.ts";

/**
 * What `searchChat` looks for. Every word of `query` (split on whitespace) must appear in a
 * message, as a case-insensitive substring; the words are taken literally, never as search
 * operators. A channel takes in its threads.
 */
export interface ChatSearch {
  query: string;
  place: ChatPlace | null;
  limit: number;
}

/** A message found, with the names of where it is. */
export interface ChatHit {
  message: ChatMessage;
  channel: string;
  thread: string | null;
}

/**
 * The messages matching `search`, best match first, at most `search.limit`. Words of three
 * or more characters go through the trigram index and rank the results by bm25; when every
 * word is shorter, the newest messages come first. Ties go to the newer message. A query
 * without words matches nothing.
 */
export function searchChat(db: Database, search: ChatSearch): ChatHit[] {
  const words = splitWhitespace(search.query);
  const indexed = words.filter((word) => charCount(word) >= TRIGRAM);
  const short = words.filter((word) => charCount(word) < TRIGRAM);
  if (indexed.length === 0 && short.length === 0) {
    return [];
  }
  const conditions: string[] = [];
  const parameters: SQLQueryBindings[] = [];
  if (indexed.length > 0) {
    conditions.push("chat_search MATCH ?");
    parameters.push(indexed.map(ftsString).join(" "));
  }
  for (const word of short) {
    conditions.push("m.body LIKE ? ESCAPE '\\'");
    parameters.push(likePattern(word));
  }
  if (search.place !== null) {
    switch (search.place.kind) {
      case "channel":
        conditions.push("m.channel_id = ?");
        parameters.push(search.place.id);
        break;
      case "thread":
        conditions.push("m.thread_id = ?");
        parameters.push(search.place.id);
        break;
    }
  }
  parameters.push(search.limit);
  const sql =
    indexed.length === 0
      ? `SELECT m.id FROM chat_messages m WHERE ${conditions.join(" AND ")} ORDER BY m.id DESC LIMIT ?`
      : `SELECT m.id FROM chat_search JOIN chat_messages m ON m.id = chat_search.rowid
         WHERE ${conditions.join(" AND ")} ORDER BY bm25(chat_search), m.id DESC LIMIT ?`;
  const ids = db
    .query<{ id: number }, SQLQueryBindings[]>(sql)
    .all(...parameters)
    .map((row) => chatMessageId(row.id));
  const where = db.query<{ name: string; title: string | null }, [number, number | null]>(
    `SELECT c.name, t.title FROM chat_channels c
     LEFT JOIN chat_threads t ON t.id = ?2
     WHERE c.id = ?1`,
  );
  return messagesById(db, ids).map((message) => {
    const names = where.get(message.channelId, message.threadId);
    if (names === null) {
      throw new StorageError({ kind: "chat_channel_not_found", channel: message.channelId });
    }
    return { message, channel: names.name, thread: names.title };
  });
}
