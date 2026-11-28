// Channels of the chat, how far people read each channel and thread, and how a notification
// names where a message is.

import type { Database } from "bun:sqlite";

import {
  type ChatChannel,
  type ChatChannelId,
  type ChatMessageId,
  type ChatPlace,
  type ChatThreadId,
  FIRST_CHANNEL,
  chatChannelId,
} from "../domain/chat.ts";
import { channelExists, locate } from "./chat-places.ts";
import { StorageError } from "./errors.ts";

/** Messages of the agent and Toodo count as unread; people's own never do. A channel counts
 * its own and those of its threads that follow no task, which reading it in the chat reaches;
 * a task's thread counts on its own, where the chat lists its task. */
const CHANNEL_SELECT = `SELECT c.id, c.name, c.push, c.created_at,
         (SELECT count(*) FROM chat_messages m
          WHERE m.channel_id = c.id AND m.thread_id IS NULL AND m.author <> 'user'
            AND m.id > c.read_id)
       + (SELECT count(*) FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
          WHERE t.channel_id = c.id AND t.task_id IS NULL AND t.status <> 'archived' AND m.author <> 'user'
            AND m.id > t.read_id) AS unread
     FROM chat_channels c`;

interface ChannelRow {
  id: number;
  name: string;
  push: number;
  created_at: number;
  unread: number;
}

function channel(row: ChannelRow): ChatChannel {
  return {
    id: chatChannelId(row.id),
    name: row.name,
    push: row.push !== 0,
    createdAt: row.created_at,
    unread: row.unread,
  };
}

function findChannel(db: Database, id: ChatChannelId): ChatChannel {
  const row = db.query<ChannelRow, [number]>(`${CHANNEL_SELECT} WHERE c.id = ?1`).get(id);
  if (row === null) {
    throw new StorageError({ kind: "chat_channel_not_found", channel: id });
  }
  return channel(row);
}

/** Refuses a channel name another channel has, ignoring case. */
function nameFree(db: Database, name: string, except: ChatChannelId | null): void {
  const taken = db
    .query<{ 1: number }, [string, number | null]>(
      "SELECT 1 FROM chat_channels WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2",
    )
    .get(name, except);
  if (taken !== null) {
    throw new StorageError({ kind: "chat_channel_name_taken", name });
  }
}

/** What changes on a channel; a field left out is kept. */
export interface ChannelEdit {
  name?: string;
  push?: boolean;
}

/** Every channel in the order they were made, with its unread count. */
export function listChatChannels(db: Database): ChatChannel[] {
  return db.query<ChannelRow, []>(`${CHANNEL_SELECT} ORDER BY c.id`).all().map(channel);
}

/** Makes a channel named `name`, which no other channel has in any case. */
export function createChatChannel(db: Database, name: string, at: number): ChatChannel {
  return db.transaction(() => {
    nameFree(db, name, null);
    const id = Number(
      db.run("INSERT INTO chat_channels (name, created_at) VALUES (?1, ?2)", [name, at]).lastInsertRowid,
    );
    return findChannel(db, chatChannelId(id));
  })();
}

/** Renames a channel or turns its notifications on or off. */
export function updateChatChannel(db: Database, id: ChatChannelId, edit: ChannelEdit): ChatChannel {
  return db.transaction(() => {
    channelExists(db, id);
    if (edit.name !== undefined) {
      nameFree(db, edit.name, id);
    }
    db.run(
      `UPDATE chat_channels SET name = coalesce(?2, name), push = coalesce(?3, push)
       WHERE id = ?1`,
      [id, edit.name ?? null, edit.push ?? null],
    );
    return findChannel(db, id);
  })();
}

/**
 * Deletes a channel other than the default room, keeping what was said in it: its threads
 * move to the default room, and its own messages, if any, into an archived thread there named
 * after it (`#<name>`), which keeps how far people read them.
 */
export function deleteChatChannel(db: Database, id: ChatChannelId, at: number): void {
  db.transaction(() => {
    if (id === FIRST_CHANNEL) {
      throw new StorageError({ kind: "chat_channel_permanent", channel: id });
    }
    const row = db
      .query<{ name: string; read_id: number }, [number]>("SELECT name, read_id FROM chat_channels WHERE id = ?1")
      .get(id);
    if (row === null) {
      throw new StorageError({ kind: "chat_channel_not_found", channel: id });
    }
    const own = db
      .query<{ 1: number }, [number]>("SELECT 1 FROM chat_messages WHERE channel_id = ?1 AND thread_id IS NULL LIMIT 1")
      .get(id);
    if (own !== null) {
      const kept = Number(
        db.run(
          `INSERT INTO chat_threads (channel_id, title, status, created_at, closed_at, archived_at, read_id)
           VALUES (?1, ?2, 'archived', ?3, ?3, ?3, ?4)`,
          [FIRST_CHANNEL, `#${row.name}`, at, row.read_id],
        ).lastInsertRowid,
      );
      db.run("UPDATE chat_messages SET thread_id = ?2 WHERE channel_id = ?1 AND thread_id IS NULL", [id, kept]);
    }
    db.run("UPDATE chat_threads SET channel_id = ?2 WHERE channel_id = ?1", [id, FIRST_CHANNEL]);
    db.run("UPDATE chat_messages SET channel_id = ?2 WHERE channel_id = ?1", [id, FIRST_CHANNEL]);
    db.run("DELETE FROM chat_channels WHERE id = ?1", [id]);
  })();
}

/** Records that people read `place` up to message `upTo`; reading back never lowers it. */
export function markChatRead(db: Database, place: ChatPlace, upTo: ChatMessageId): void {
  db.transaction(() => {
    locate(db, place);
    switch (place.kind) {
      case "channel":
        db.run("UPDATE chat_channels SET read_id = max(read_id, ?2) WHERE id = ?1", [place.id, upTo]);
        break;
      case "thread":
        db.run("UPDATE chat_threads SET read_id = max(read_id, ?2) WHERE id = ?1", [place.id, upTo]);
        break;
    }
  })();
}

/** Where the agent posted, for a notification that names it and opens it, when the
 * channel lets it notify. */
export interface ChatNotice {
  channelId: ChatChannelId;
  channel: string;
  threadId: ChatThreadId | null;
  thread: string | null;
  /** Whether the thread waits on the people's answer; `false` in a channel itself. */
  awaiting: boolean;
}

/**
 * How a notification of a message in `channelId` and `threadId` names where it is, or
 * `null` when that channel's notifications are off.
 */
export function chatNotice(db: Database, channelId: ChatChannelId, threadId: ChatThreadId | null): ChatNotice | null {
  const row = db
    .query<{ name: string; push: number }, [number]>("SELECT name, push FROM chat_channels WHERE id = ?1")
    .get(channelId);
  if (row === null) {
    throw new StorageError({ kind: "chat_channel_not_found", channel: channelId });
  }
  if (row.push === 0) {
    return null;
  }
  if (threadId === null) {
    return { channelId, channel: row.name, threadId: null, thread: null, awaiting: false };
  }
  const thread = db
    .query<{ title: string; awaiting_at: number | null }, [number]>(
      "SELECT title, awaiting_at FROM chat_threads WHERE id = ?1",
    )
    .get(threadId);
  if (thread === null) {
    throw new StorageError({ kind: "chat_thread_not_found", thread: threadId });
  }
  return { channelId, channel: row.name, threadId, thread: thread.title, awaiting: thread.awaiting_at !== null };
}

/** The agent's latest message in thread `threadId`, or `null` before its first. */
export function latestAgentMessage(db: Database, threadId: ChatThreadId): { id: number; body: string } | null {
  return db
    .query<{ id: number; body: string }, [number]>(
      "SELECT id, body FROM chat_messages WHERE thread_id = ?1 AND author = 'lead' ORDER BY id DESC LIMIT 1",
    )
    .get(threadId);
}
