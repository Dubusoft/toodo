// The agent's side of the chat (`src-tauri/src/mcp/tools/chat.rs`): it takes people's
// messages, acknowledges them, replies, and marks them handled, each step a receipt the app
// shows on the message; it offers actions people choose among and attaches files; it keeps
// channels and the threads under them, which may follow a task; and it searches earlier
// messages.

import type * as B from "../../../../src/lib/api.ts";
import { bodyWithFiles } from "../../commands/chat.ts";
import {
  SEARCH_LIMIT,
  attachmentIds,
  channel,
  channelName,
  chatActions,
  message,
  placeOf,
  searchHit,
  searchQuery,
  thread,
  threadEdit,
  threadFilter,
  threadTitle,
} from "../../commands/chat-types.ts";
import { FIRST_CHANNEL, chatChannelId, chatMessageId, chatThreadId } from "../../domain/chat.ts";
import { taskId } from "../../domain/model.ts";
import * as channels from "../../storage/chat-channels.ts";
import type { ChatNotice } from "../../storage/chat-channels.ts";
import { CHAT_PAGE_LIMIT, listChatMessages } from "../../storage/chat-messages.ts";
import { searchChat as findMessages } from "../../storage/chat-search.ts";
import * as threads from "../../storage/chat-threads.ts";
import * as posts from "../../storage/chat.ts";
import type { Storage } from "../../storage/storage.ts";
import type * as R from "./requests.ts";

/** How many messages `search_chat` returns without a limit. */
const DEFAULT_SEARCH = 20;
/** How many messages `list_chat` returns without a limit. */
const DEFAULT_LIST = 50;

export function pendingChat(storage: Storage, take: boolean): B.ChatMessage[] {
  const now = storage.now();
  return posts.pendingChatMessages(storage.db, take, now).map((m) => message(m, now));
}

/** Posts the agent's reply and returns it with how its notification names where it is, or
 * `null` when that channel's notifications are off. */
export function replyInChat(
  storage: Storage,
  request: ReturnType<typeof R.replyInChat>,
): { message: B.ChatMessage; notice: ChatNotice | null } {
  const place = placeOf(request.channel_id, request.thread_id);
  const actions = chatActions(request.actions);
  const attachments = attachmentIds(request.attachments);
  const body = bodyWithFiles(storage, request.body, attachments);
  const now = storage.now();
  const posted = posts.postAgentMessage(
    storage.db,
    { place, body, handles: request.handles.map(chatMessageId), actions, attachments },
    now,
  );
  const notice = channels.chatNotice(storage.db, posted.channelId, posted.threadId);
  return { message: message(posted, now), notice };
}

export function ackChat(storage: Storage, request: ReturnType<typeof R.ackChat>): B.ChatMessage[] {
  const now = storage.now();
  return posts.ackChatMessages(storage.db, request.ids.map(chatMessageId), now).map((m) => message(m, now));
}

export function markChatHandled(storage: Storage, request: ReturnType<typeof R.markChatHandled>): B.ChatMessage {
  const now = storage.now();
  const handled = posts.markChatHandled(
    storage.db,
    {
      message: chatMessageId(request.id),
      reply: request.reply_id === null ? null : chatMessageId(request.reply_id),
      task: request.task_id === null ? null : taskId(request.task_id),
    },
    now,
  );
  return message(handled, now);
}

export function listChat(storage: Storage, request: ReturnType<typeof R.listChat>): B.ChatMessage[] {
  const limit = Math.min(request.limit ?? DEFAULT_LIST, CHAT_PAGE_LIMIT);
  const place = placeOf(request.channel_id, request.thread_id);
  const now = storage.now();
  const page = { place, before: request.before === null ? null : chatMessageId(request.before), limit };
  return listChatMessages(storage.db, page).map((m) => message(m, now));
}

export function searchChat(storage: Storage, request: ReturnType<typeof R.searchChat>): B.ChatSearchHit[] {
  const query = searchQuery(request.query);
  const place = placeOf(request.channel_id, request.thread_id);
  const limit = Math.min(Math.max(request.limit ?? DEFAULT_SEARCH, 1), SEARCH_LIMIT);
  const now = storage.now();
  return findMessages(storage.db, { query, place, limit }).map((hit) => searchHit(hit, now));
}

export function listChannels(storage: Storage): B.ChatChannel[] {
  return channels.listChatChannels(storage.db).map(channel);
}

export function createChannel(storage: Storage, request: ReturnType<typeof R.createChannel>): B.ChatChannel {
  const name = channelName(request.name);
  return channel(channels.createChatChannel(storage.db, name, storage.now()));
}

export function listThreads(storage: Storage, request: ReturnType<typeof R.listThreads>): B.ChatThread[] {
  const filter = threadFilter({ channelId: request.channel_id, taskId: request.task_id, archived: request.include_archived });
  return threads.listChatThreads(storage.db, filter).map(thread);
}

export function createThread(storage: Storage, request: ReturnType<typeof R.createThread>): B.ChatThread {
  const title = threadTitle(request.title);
  const created = threads.createChatThread(
    storage.db,
    {
      channel: request.channel_id === null ? FIRST_CHANNEL : chatChannelId(request.channel_id),
      title,
      task: request.task_id === null ? null : taskId(request.task_id),
    },
    storage.now(),
  );
  return thread(created);
}

export function updateThread(storage: Storage, request: ReturnType<typeof R.updateThread>): B.ChatThread {
  const edit = threadEdit({
    title: request.title,
    status: request.status,
    taskId: request.task_id,
    unlinkTask: request.unlink_task,
  });
  return thread(threads.updateChatThread(storage.db, chatThreadId(request.id), edit, storage.now()));
}
