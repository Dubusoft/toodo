// Threads under the chat's channels, which may follow a task, and whether each takes
// messages. Functions that write take the time they act at (`at`, Unix seconds) from the
// caller.

import type { Database } from "bun:sqlite";

import {
  type ChatChannelId,
  type ChatThread,
  type ChatThreadId,
  type ThreadStatus,
  chatChannelId,
  chatThreadId,
} from "../domain/chat.ts";
import { type TaskId, taskId } from "../domain/model.ts";
import { channelExists, taskExists, threadPlace, threadStatus } from "./chat-places.ts";
import { StorageError } from "./errors.ts";

const THREAD_SELECT = `SELECT t.id, t.channel_id, t.title, t.task_id, t.status,
         t.created_at, t.closed_at, t.archived_at,
         (SELECT count(*) FROM chat_messages m
          WHERE m.thread_id = t.id AND m.author <> 'user' AND m.id > t.read_id) AS unread,
         (SELECT max(m.at) FROM chat_messages m WHERE m.thread_id = t.id) AS last_at
     FROM chat_threads t`;

interface ThreadRow {
  id: number;
  channel_id: number;
  title: string;
  task_id: number | null;
  status: string;
  created_at: number;
  closed_at: number | null;
  archived_at: number | null;
  unread: number;
  last_at: number | null;
}

function thread(row: ThreadRow): ChatThread {
  return {
    id: chatThreadId(row.id),
    channelId: chatChannelId(row.channel_id),
    title: row.title,
    taskId: row.task_id === null ? null : taskId(row.task_id),
    status: threadStatus(row.status),
    createdAt: row.created_at,
    closedAt: row.closed_at,
    archivedAt: row.archived_at,
    unread: row.unread,
    lastMessageAt: row.last_at,
  };
}

function findThread(db: Database, id: ChatThreadId): ChatThread {
  const row = db.query<ThreadRow, [number]>(`${THREAD_SELECT} WHERE t.id = ?1`).get(id);
  if (row === null) {
    throw new StorageError({ kind: "chat_thread_not_found", thread: id });
  }
  return thread(row);
}

/** Which threads to list. Archived threads are left out unless `archived` is set. */
export interface ThreadFilter {
  channel?: ChatChannelId;
  task?: TaskId;
  archived?: boolean;
}

/** What changes on a thread; a field left out is kept, and `task: null` unlinks its task. */
export interface ThreadEdit {
  title?: string;
  status?: ThreadStatus;
  task?: TaskId | null;
}

/** A thread to open. */
export interface NewChatThread {
  channel: ChatChannelId;
  title: string;
  /** The task it follows, if any. */
  task: TaskId | null;
}

/** The threads `filter` selects, the latest active first. */
export function listChatThreads(db: Database, filter: ThreadFilter): ChatThread[] {
  return db
    .query<ThreadRow, [number | null, number | null, boolean]>(
      `SELECT * FROM (${THREAD_SELECT}
           WHERE (?1 IS NULL OR t.channel_id = ?1) AND (?2 IS NULL OR t.task_id = ?2)
             AND (?3 OR t.status <> 'archived'))
       ORDER BY coalesce(last_at, created_at) DESC, id DESC`,
    )
    .all(filter.channel ?? null, filter.task ?? null, filter.archived ?? false)
    .map(thread);
}

/** Opens a thread titled `created.title` under `created.channel`, following its task if given. */
export function createChatThread(db: Database, created: NewChatThread, at: number): ChatThread {
  return db.transaction(() => {
    channelExists(db, created.channel);
    if (created.task !== null) {
      taskExists(db, created.task);
    }
    const id = Number(
      db.run(
        `INSERT INTO chat_threads (channel_id, title, task_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
        [created.channel, created.title, created.task, at],
      ).lastInsertRowid,
    );
    return findThread(db, chatThreadId(id));
  })();
}

/**
 * Retitles a thread, links or unlinks its task, or opens, closes, or archives it. Closing
 * keeps the time it was first closed, and reopening clears both times.
 */
export function updateChatThread(db: Database, id: ChatThreadId, edit: ThreadEdit, at: number): ChatThread {
  return db.transaction(() => {
    threadPlace(db, id);
    if (edit.task !== undefined && edit.task !== null) {
      taskExists(db, edit.task);
    }
    if (edit.title !== undefined) {
      db.run("UPDATE chat_threads SET title = ?2 WHERE id = ?1", [id, edit.title]);
    }
    if (edit.task !== undefined) {
      db.run("UPDATE chat_threads SET task_id = ?2 WHERE id = ?1", [id, edit.task]);
    }
    if (edit.status !== undefined) {
      db.run(
        `UPDATE chat_threads SET status = ?2,
             closed_at = CASE WHEN ?3 THEN NULL ELSE coalesce(closed_at, ?5) END,
             archived_at = CASE WHEN ?4 THEN coalesce(archived_at, ?5) ELSE NULL END
         WHERE id = ?1`,
        [id, edit.status, edit.status === "open", edit.status === "archived", at],
      );
    }
    return findThread(db, id);
  })();
}
