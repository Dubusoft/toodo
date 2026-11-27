// Reading chat messages: their rows with the actions, choices, and attachments that go with
// them, and pages of the chat.

import type { Database } from "bun:sqlite";

import {
  type ChatAction,
  type ChatAttachment,
  type ChatChoice,
  type ChatMessage,
  type ChatMessageId,
  type ChatPlace,
  type ChoiceOf,
  chatChannelId,
  chatMessageId,
  chatThreadId,
  parseActionStyle,
  parseChatAuthor,
} from "../domain/chat.ts";
import { taskId } from "../domain/model.ts";
import { debugString } from "../domain/rust.ts";
import { ATTACHMENT_COLUMNS, type AttachmentRow, storedAttachment } from "./chat-attachments.ts";
import { StorageError } from "./errors.ts";

const COLUMNS = `id, author, body, at, delivered_at, acked_at, handled_at,
  handled_reply_id, handled_task_id, due_at, channel_id, thread_id, client_id`;

/** The most messages one page of the chat holds. */
export const CHAT_PAGE_LIMIT = 200;

interface MessageRow {
  readonly client_id: string | null;
  id: number;
  author: string;
  body: string;
  at: number;
  delivered_at: number | null;
  acked_at: number | null;
  handled_at: number | null;
  handled_reply_id: number | null;
  handled_task_id: number | null;
  due_at: number | null;
  channel_id: number;
  thread_id: number | null;
}

function message(row: MessageRow): ChatMessage {
  const author = parseChatAuthor(row.author);
  if (author === null) {
    throw new StorageError({ kind: "invalid_data", reason: `unknown chat author ${debugString(row.author)}` });
  }
  return {
    id: chatMessageId(row.id),
    clientId: row.client_id,
    channelId: chatChannelId(row.channel_id),
    threadId: row.thread_id === null ? null : chatThreadId(row.thread_id),
    author,
    body: row.body,
    at: row.at,
    deliveredAt: row.delivered_at,
    ackedAt: row.acked_at,
    handledAt: row.handled_at,
    handledReplyId: row.handled_reply_id === null ? null : chatMessageId(row.handled_reply_id),
    handledTaskId: row.handled_task_id === null ? null : taskId(row.handled_task_id),
    dueAt: row.due_at,
    actions: [],
    chosen: null,
    choiceOf: null,
    attachments: [],
  };
}

/** What `decorate` gathers for one message. */
interface Decoration {
  actions: ChatAction[];
  chosen: ChatChoice | null;
  choiceOf: ChoiceOf | null;
  attachments: ChatAttachment[];
}

/** `messages` with their actions, choices, and attachments filled in. */
function decorate(db: Database, messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) {
    return messages;
  }
  const ids = JSON.stringify(messages.map((m) => m.id));
  const decorations = new Map<number, Decoration>();
  for (const m of messages) {
    decorations.set(m.id, { actions: [], chosen: null, choiceOf: null, attachments: [] });
  }
  const actions = db
    .query<{ message_id: number; key: string; label: string; style: string }, [string]>(
      `SELECT message_id, key, label, style FROM chat_actions
       WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY message_id, position`,
    )
    .all(ids);
  for (const row of actions) {
    const style = parseActionStyle(row.style);
    if (style === null) {
      throw new StorageError({ kind: "invalid_data", reason: `unknown action style ${debugString(row.style)}` });
    }
    decorations.get(row.message_id)?.actions.push({ key: row.key, label: row.label, style });
  }
  const choices = db
    .query<{ message_id: number; key: string; choice_id: number; at: number }, [string]>(
      `SELECT message_id, key, choice_id, at FROM chat_choices
       WHERE message_id IN (SELECT value FROM json_each(?1))
          OR choice_id IN (SELECT value FROM json_each(?1))`,
    )
    .all(ids);
  for (const row of choices) {
    const offered = decorations.get(row.message_id);
    if (offered !== undefined) {
      offered.chosen = { key: row.key, at: row.at, choiceId: chatMessageId(row.choice_id) };
    }
    const choice = decorations.get(row.choice_id);
    if (choice !== undefined) {
      choice.choiceOf = { messageId: chatMessageId(row.message_id), key: row.key };
    }
  }
  const attachments = db
    .query<AttachmentRow, [string]>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM chat_attachments
       WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY id`,
    )
    .all(ids);
  for (const row of attachments) {
    const { attachment } = storedAttachment(row);
    if (attachment.messageId !== null) {
      decorations.get(attachment.messageId)?.attachments.push(attachment);
    }
  }
  return messages.map((m) => ({ ...m, ...decorations.get(m.id) }));
}

function messageRow(db: Database, id: ChatMessageId): MessageRow | null {
  return db.query<MessageRow, [number]>(`SELECT ${COLUMNS} FROM chat_messages WHERE id = ?1`).get(id);
}

/** The messages with IDs `ids`, decorated, in that order. */
export function messagesById(db: Database, ids: readonly ChatMessageId[]): ChatMessage[] {
  return decorate(
    db,
    ids.map((id) => {
      const row = messageRow(db, id);
      if (row === null) {
        throw new StorageError({ kind: "chat_message_not_found", message: id });
      }
      return message(row);
    }),
  );
}

export function findMessage(db: Database, id: ChatMessageId): ChatMessage | null {
  const row = messageRow(db, id);
  if (row === null) {
    return null;
  }
  const [found] = decorate(db, [message(row)]);
  return found ?? null;
}

/** Message `id`, which a write in the same transaction has just stored or changed. */
export function storedMessage(db: Database, id: ChatMessageId): ChatMessage {
  const found = findMessage(db, id);
  if (found === null) {
    throw new StorageError({ kind: "chat_message_not_found", message: id });
  }
  return found;
}

/** A person's message, the only kind that gets receipts. */
export function personMessage(db: Database, id: ChatMessageId): ChatMessage {
  const found = findMessage(db, id);
  if (found === null) {
    throw new StorageError({ kind: "chat_message_not_found", message: id });
  }
  switch (found.author) {
    case "user":
      return found;
    case "agent":
    case "system":
      throw new StorageError({ kind: "not_a_persons_message", message: id });
  }
}

/** The agent's message, the only kind a reply or a choice of a person can point at. */
export function agentMessage(db: Database, id: ChatMessageId): ChatMessage {
  const found = findMessage(db, id);
  if (found === null) {
    throw new StorageError({ kind: "chat_message_not_found", message: id });
  }
  switch (found.author) {
    case "agent":
      return found;
    case "user":
    case "system":
      throw new StorageError({ kind: "not_an_agents_message", message: id });
  }
}

/** Which page of the chat to read. */
export interface ChatPage {
  /** A channel or thread; every channel and thread when `null`. */
  place: ChatPlace | null;
  /** The message the page ends before; the latest messages when `null`. */
  before: ChatMessageId | null;
  /** Capped at `CHAT_PAGE_LIMIT`. */
  limit: number;
}

/**
 * The latest messages in `page.place` before `page.before`, oldest first, at most
 * `page.limit` (capped at `CHAT_PAGE_LIMIT`). A channel holds its own messages, not those
 * of its threads.
 */
export function listChatMessages(db: Database, page: ChatPage): ChatMessage[] {
  const limit = Math.min(Math.max(page.limit, 1), CHAT_PAGE_LIMIT);
  let channel: number | null = null;
  let thread: number | null = null;
  if (page.place !== null) {
    switch (page.place.kind) {
      case "channel":
        channel = page.place.id;
        break;
      case "thread":
        thread = page.place.id;
        break;
    }
  }
  const messages = db
    .query<MessageRow, [number | null, number | null, number | null, number]>(
      `SELECT ${COLUMNS} FROM chat_messages
       WHERE (?1 IS NULL OR id < ?1)
         AND (?2 IS NULL OR (channel_id = ?2 AND thread_id IS NULL))
         AND (?3 IS NULL OR thread_id = ?3)
       ORDER BY id DESC LIMIT ?4`,
    )
    .all(page.before, channel, thread, limit)
    .map(message)
    .reverse();
  return decorate(db, messages);
}
