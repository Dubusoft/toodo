// The chat's shapes in `src/lib/bindings.ts` and the checks on what callers send, as
// `src-tauri/src/commands/types/chat.rs` defines them, with the Rust messages.

import type * as B from "../../../src/lib/bindings.ts";
import {
  type ChatAction,
  type ChatAttachment,
  type ChatAttachmentId,
  type ChatChannel,
  type ChatMessage,
  type ChatPlace,
  type ChatThread,
  chatAttachmentId,
  chatChannelId,
  chatThreadId,
  isOverdue,
} from "../domain/chat.ts";
import { taskId } from "../domain/model.ts";
import { asciiLowercase, charCount, debugString, isControl, trim, trimStart } from "../domain/rust.ts";
import type { ChannelEdit } from "../storage/chat-channels.ts";
import type { ChatHit } from "../storage/chat-search.ts";
import type { ThreadEdit, ThreadFilter } from "../storage/chat-threads.ts";
import { invalidInput } from "./errors.ts";

/** The most characters a chat message may have, after trimming. */
export const CHAT_BODY_LIMIT = 8000;
const CHANNEL_NAME_LIMIT = 50;
const THREAD_TITLE_LIMIT = 200;
const CLIENT_ID_LIMIT = 100;
/** The most actions one message offers. */
export const ACTION_LIMIT = 10;
const ACTION_KEY_LIMIT = 100;
const ACTION_LABEL_LIMIT = 80;
/** The most files one message carries. */
export const ATTACHMENT_LIMIT = 10;
const FILE_NAME_LIMIT = 200;
/** The most messages one search returns. */
export const SEARCH_LIMIT = 100;

function hasControl(text: string): boolean {
  for (const char of text) {
    if (isControl(char)) return true;
  }
  return false;
}

/** One line of text, trimmed and without a leading `#` when `hash` is set: non-empty and at
 * most `limit` characters. */
function line(text: string, what: string, limit: number, hash: boolean): string {
  let trimmed = trim(text);
  if (hash) trimmed = trimStart(trimmed.replace(/^#+/, ""));
  if (trimmed === "" || charCount(trimmed) > limit || hasControl(trimmed)) {
    throw invalidInput(`${what} must be one line of 1 to ${limit} characters`);
  }
  return trimmed;
}

/** A chat message body, trimmed: non-empty and at most `CHAT_BODY_LIMIT` characters. */
export function chatBody(body: string): string {
  const trimmed = trim(body);
  if (trimmed === "") {
    throw invalidInput("chat message body must not be empty; send the message as text in body");
  }
  const length = charCount(trimmed);
  if (length > CHAT_BODY_LIMIT) {
    throw invalidInput(
      `chat message has ${length} characters, more than the limit of ${CHAT_BODY_LIMIT}; split it into several messages`,
    );
  }
  return trimmed;
}

/** A channel name, without the `#` it is shown with. */
export function channelName(name: string): string {
  return line(name, "channel name", CHANNEL_NAME_LIMIT, true);
}

export function threadTitle(title: string): string {
  return line(title, "thread title", THREAD_TITLE_LIMIT, false);
}

/** The ID a client gives a message it sends: one line of at most 100 characters. */
export function clientId(id: string): string {
  if (trim(id) === "" || charCount(id) > CLIENT_ID_LIMIT || hasControl(id)) {
    throw invalidInput(`clientId must be one line of 1 to ${CLIENT_ID_LIMIT} characters`);
  }
  return id;
}

/** A search query: some words, at most 200 characters. */
export function searchQuery(query: string): string {
  if (trim(query) === "" || charCount(query) > 200) {
    throw invalidInput("the search query must have 1 to 200 characters");
  }
  return query;
}

/** The actions of a message to post: at most `ACTION_LIMIT`, each key and label one line,
 * keys unique. */
export function chatActions(actions: readonly B.ChatAction[]): ChatAction[] {
  if (actions.length > ACTION_LIMIT) {
    throw invalidInput(`a message offers at most ${ACTION_LIMIT} actions, not ${actions.length}`);
  }
  const parsed: ChatAction[] = [];
  for (const action of actions) {
    const key = line(action.key, "action key", ACTION_KEY_LIMIT, false);
    if (parsed.some((other) => other.key === key)) {
      throw invalidInput(
        `action key ${debugString(key)} is given twice; each action of a message needs its own key`,
      );
    }
    parsed.push({
      key,
      label: line(action.label, "action label", ACTION_LABEL_LIMIT, false),
      style: action.style ?? "default",
    });
  }
  return parsed;
}

/** The files of a message to post: at most `ATTACHMENT_LIMIT`. */
export function attachmentIds(ids: readonly number[]): ChatAttachmentId[] {
  if (ids.length > ATTACHMENT_LIMIT) {
    throw invalidInput(`a message carries at most ${ATTACHMENT_LIMIT} files, not ${ids.length}`);
  }
  return ids.map(chatAttachmentId);
}

/** The name an upload is kept under: the last part of `name` as a path, one line of at most
 * `FILE_NAME_LIMIT` characters. */
export function fileName(name: string): string {
  return line(name.split(/[/\\]/).pop() ?? "", "file name", FILE_NAME_LIMIT, false);
}

const TOKEN = /^[A-Za-z0-9!#$&\-^_.+]{1,100}$/;

/** The media type an upload is served with: the `type/subtype` of `declared` in lower case,
 * or `application/octet-stream` when it is missing or malformed. */
export function contentType(declared: string | null): string {
  const essence = asciiLowercase(trim((declared ?? "").split(";")[0] ?? ""));
  const slash = essence.indexOf("/");
  if (slash >= 0 && TOKEN.test(essence.slice(0, slash)) && TOKEN.test(essence.slice(slash + 1))) {
    return essence;
  }
  return "application/octet-stream";
}

export function place(place: B.ChatPlace): ChatPlace {
  return "channel" in place && place.channel !== undefined
    ? { kind: "channel", id: chatChannelId(place.channel) }
    : { kind: "thread", id: chatThreadId(place.thread as number) };
}

/** The place an agent names with an optional `channel_id` and `thread_id`: at most one of
 * them, and neither for every place or the default one. */
export function placeOf(channel: number | null, thread: number | null): ChatPlace | null {
  if (channel !== null && thread !== null) {
    throw invalidInput("give channel_id or thread_id, not both; a thread_id already names its channel");
  }
  if (channel !== null) return { kind: "channel", id: chatChannelId(channel) };
  if (thread !== null) return { kind: "thread", id: chatThreadId(thread) };
  return null;
}

export function channelEdit(edit: B.ChatChannelEdit): ChannelEdit {
  const parsed: ChannelEdit = {};
  if (edit.name !== undefined && edit.name !== null) parsed.name = channelName(edit.name);
  if (edit.push !== undefined && edit.push !== null) parsed.push = edit.push;
  return parsed;
}

/** What changes on a thread; `unlinkTask` drops its task and cannot go with `taskId`. */
export function threadEdit(edit: B.ChatThreadEdit): ThreadEdit {
  const linked = edit.taskId !== undefined && edit.taskId !== null;
  const unlink = edit.unlinkTask ?? false;
  if (linked && unlink) {
    throw invalidInput("give taskId to link a task or unlinkTask to drop it, not both");
  }
  const parsed: ThreadEdit = {};
  if (edit.title !== undefined && edit.title !== null) parsed.title = threadTitle(edit.title);
  if (edit.status !== undefined && edit.status !== null) parsed.status = edit.status;
  if (linked) parsed.task = taskId(edit.taskId as number);
  else if (unlink) parsed.task = null;
  return parsed;
}

export function threadFilter(filter: B.ChatThreadFilter): ThreadFilter {
  const parsed: ThreadFilter = { archived: filter.archived ?? false };
  if (filter.channelId !== undefined && filter.channelId !== null) parsed.channel = chatChannelId(filter.channelId);
  if (filter.taskId !== undefined && filter.taskId !== null) parsed.task = taskId(filter.taskId);
  return parsed;
}

function attachment(a: ChatAttachment): B.ChatAttachment {
  return { id: a.id, name: a.name, contentType: a.contentType, size: a.size };
}

/** The message as it stands at `now`, which decides whether it is overdue. */
export function message(m: ChatMessage, now: number): B.ChatMessage {
  return {
    id: m.id,
    channelId: m.channelId,
    threadId: m.threadId,
    author: m.author,
    body: m.body,
    at: m.at,
    deliveredAt: m.deliveredAt,
    ackedAt: m.ackedAt,
    handledAt: m.handledAt,
    handledReplyId: m.handledReplyId,
    handledTaskId: m.handledTaskId,
    overdue: isOverdue(m, now),
    actions: m.actions.map((a) => ({ key: a.key, label: a.label, style: a.style })),
    chosen: m.chosen === null ? null : { key: m.chosen.key, at: m.chosen.at, choiceId: m.chosen.choiceId },
    choiceOf: m.choiceOf === null ? null : { messageId: m.choiceOf.messageId, key: m.choiceOf.key },
    attachments: m.attachments.map(attachment),
  };
}

export function searchHit(hit: ChatHit, now: number): B.ChatSearchHit {
  return { message: message(hit.message, now), channelName: hit.channel, threadTitle: hit.thread };
}

export function channel(c: ChatChannel): B.ChatChannel {
  return { id: c.id, name: c.name, push: c.push, createdAt: c.createdAt, unread: c.unread };
}

export function thread(t: ChatThread): B.ChatThread {
  return {
    id: t.id,
    channelId: t.channelId,
    title: t.title,
    taskId: t.taskId,
    status: t.status,
    createdAt: t.createdAt,
    closedAt: t.closedAt,
    archivedAt: t.archivedAt,
    unread: t.unread,
    lastMessageAt: t.lastMessageAt,
  };
}
