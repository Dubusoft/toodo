// Where chat messages go: checks that a task, channel, or thread exists, and that a place
// takes messages.

import type { Database } from "bun:sqlite";

import {
  type ChatChannelId,
  type ChatMessage,
  type ChatPlace,
  type ChatThreadId,
  type ThreadStatus,
  chatChannelId,
  parseThreadStatus,
} from "../domain/chat.ts";
import type { TaskId } from "../domain/model.ts";
import { debugString } from "../domain/rust.ts";
import { StorageError } from "./errors.ts";

/** A channel and, for a message in a thread, that thread. */
export interface Located {
  channel: ChatChannelId;
  thread: ChatThreadId | null;
}

/** Where `message` is: its thread, or its channel when it is in none. */
export function messagePlace(message: ChatMessage): ChatPlace {
  return message.threadId === null
    ? { kind: "channel", id: message.channelId }
    : { kind: "thread", id: message.threadId };
}

export function taskExists(db: Database, task: TaskId): void {
  if (db.query<{ 1: number }, [number]>("SELECT 1 FROM tasks WHERE id = ?1").get(task) === null) {
    throw new StorageError({ kind: "task_not_found", task });
  }
}

export function channelExists(db: Database, channel: ChatChannelId): void {
  const row = db.query<{ 1: number }, [number]>("SELECT 1 FROM chat_channels WHERE id = ?1").get(channel);
  if (row === null) {
    throw new StorageError({ kind: "chat_channel_not_found", channel });
  }
}

export function threadStatus(stored: string): ThreadStatus {
  const status = parseThreadStatus(stored);
  if (status === null) {
    throw new StorageError({ kind: "invalid_data", reason: `unknown thread status ${debugString(stored)}` });
  }
  return status;
}

/** The channel of thread `thread` and its status. */
export function threadPlace(db: Database, thread: ChatThreadId): { channel: ChatChannelId; status: ThreadStatus } {
  const row = db
    .query<{ channel_id: number; status: string }, [number]>(
      "SELECT channel_id, status FROM chat_threads WHERE id = ?1",
    )
    .get(thread);
  if (row === null) {
    throw new StorageError({ kind: "chat_thread_not_found", thread });
  }
  return { channel: chatChannelId(row.channel_id), status: threadStatus(row.status) };
}

/** The channel and thread of `place`, which must exist. */
export function locate(db: Database, place: ChatPlace): Located {
  switch (place.kind) {
    case "channel":
      channelExists(db, place.id);
      return { channel: place.id, thread: null };
    case "thread":
      return { channel: threadPlace(db, place.id).channel, thread: place.id };
  }
}

/**
 * The channel and thread a message may be posted to: an existing channel, or a thread that
 * is open.
 */
export function openPlace(db: Database, place: ChatPlace): Located {
  switch (place.kind) {
    case "channel":
      return locate(db, place);
    case "thread": {
      const { channel, status } = threadPlace(db, place.id);
      switch (status) {
        case "open":
          return { channel, thread: place.id };
        case "closed":
        case "archived":
          throw new StorageError({ kind: "chat_thread_not_open", thread: place.id, status });
      }
    }
  }
}
