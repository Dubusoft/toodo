// Commands for the chat with the agent connected over MCP: the app keeps its channels and
// threads, reads the latest messages of one, marks them read, and sends a person's
// messages.

import type * as B from "../../../src/lib/api.ts";
import { type ChatAttachmentId, chatChannelId, chatMessageId, chatThreadId } from "../domain/chat.ts";
import { taskId } from "../domain/model.ts";
import { trim } from "../domain/rust.ts";
import { chatAttachment } from "../storage/chat-attachments.ts";
import * as channels from "../storage/chat-channels.ts";
import { listChatMessages } from "../storage/chat-messages.ts";
import * as chatSearch from "../storage/chat-search.ts";
import * as threads from "../storage/chat-threads.ts";
import * as posts from "../storage/chat.ts";
import { StorageError } from "../storage/errors.ts";
import type { Storage } from "../storage/storage.ts";
import {
  SEARCH_LIMIT,
  attachmentIds,
  channel,
  channelEdit,
  channelName,
  chatBody,
  clientId,
  message,
  place,
  searchHit,
  searchQuery,
  thread,
  threadEdit,
  threadFilter,
  threadTitle,
} from "./chat-types.ts";
import { command } from "./errors.ts";
import type { Args, Command, Reply } from "./types.ts";

/** How many messages the app loads at a time. */
export const PAGE = 50;

/** How long the agent counts as writing after it says so, in seconds, unless it says so
 * again or posts. */
export const TYPING_FOR = 30;

/** What the server keeps about the chat besides its messages: how the app shows the agent,
 * and until when the agent said it is writing. */
export class ChatState {
  readonly agent: B.ChatAgent;
  #typingUntil: number | null = null;

  constructor(agent: B.ChatAgent) {
    this.agent = agent;
  }

  /** Records whether the agent is writing, as of `now`, and returns until when. */
  setTyping(typing: boolean, now: number): number | null {
    this.#typingUntil = typing ? now + TYPING_FOR : null;
    return this.#typingUntil;
  }

  typingUntil(now: number): number | null {
    return this.#typingUntil !== null && this.#typingUntil > now ? this.#typingUntil : null;
  }
}

/** The latest messages of `place` before `before` (the latest of all without it), and what
 * the agent is doing. */
export const listChat: (storage: Storage, chat: ChatState, ...args: Args<"listChat">) => Reply<"listChat"> = command(
  (storage, chat, at, before) => {
    const now = storage.now();
    // One more than a page tells whether earlier messages remain.
    const messages = listChatMessages(storage.db, {
      place: place(at),
      before: before === null ? null : chatMessageId(before),
      limit: PAGE + 1,
    });
    const hasEarlier = messages.length > PAGE;
    if (hasEarlier) messages.shift();
    return {
      agent: chat.agent,
      messages: messages.map((m) => message(m, now)),
      hasEarlier,
      typingUntil: chat.typingUntil(now),
    };
  },
);

/** The body of a message sent with `attachments`: `body` as given, or the names of the files
 * when it is blank, so a message of files alone reads (and is found) by them. */
export function bodyWithFiles(storage: Storage, body: string, attachments: readonly ChatAttachmentId[]): string {
  if (trim(body) !== "" || attachments.length === 0) return chatBody(body);
  const names = attachments.map((id) => {
    const stored = chatAttachment(storage.db, id);
    if (stored === null) throw new StorageError({ kind: "chat_attachment_not_found", attachment: id });
    return stored.attachment.name;
  });
  return chatBody(names.join(", "));
}

/** Sends a person's message to the agent in `place`, a channel or an open thread, with the
 * files uploaded for it (`POST /api/chat/attachments`); `body` may be blank when there are
 * files. `clientId` names it, so sending it again after a lost answer stores it once. */
export const sendChatMessage: Command<"sendChatMessage"> = command((storage, at, body, client, files) => {
  const id = clientId(client);
  const attachments = attachmentIds(files);
  const text = bodyWithFiles(storage, body, attachments);
  const sent = posts.postUserMessage(
    storage.db,
    { place: place(at), body: text, clientId: id, attachments },
    storage.now(),
  );
  return message(sent, storage.now());
});

/** Chooses the action `key` on the agent's message `messageId`: the agent gets the choice as
 * a person's message with the action's label. A message takes one choice. `clientId` names
 * the click, so sending it again stores it once. Returns the person's message. */
export const chooseChatAction: Command<"chooseChatAction"> = command((storage, messageId, key, client) => {
  const id = clientId(client);
  const { choice } = posts.chooseChatAction(
    storage.db,
    { message: chatMessageId(messageId), key, clientId: id },
    storage.now(),
  );
  return message(choice, storage.now());
});

/** The event announcing `choice`, a person's message that records a choice. */
export function chosenEvent(choice: B.ChatMessage): B.ChatActionChosen | null {
  if (choice.choiceOf === null) return null;
  return {
    messageId: choice.choiceOf.messageId,
    key: choice.choiceOf.key,
    label: choice.body,
    choiceId: choice.id,
    channelId: choice.channelId,
    threadId: choice.threadId,
    at: choice.at,
  };
}

/** The messages matching `query` (every word, as a case-insensitive substring), best match
 * first; `place` keeps to a channel with its threads, or one thread. */
export const searchChat: Command<"searchChat"> = command((storage, query, at) => {
  const hits = chatSearch.searchChat(storage.db, {
    query: searchQuery(query),
    place: at === null ? null : place(at),
    limit: SEARCH_LIMIT,
  });
  const now = storage.now();
  return hits.map((hit) => searchHit(hit, now));
});

/** Records that people read `place` up to message `upTo`, which clears its unread count. */
export const markChatRead: Command<"markChatRead"> = command((storage, at, upTo) => {
  channels.markChatRead(storage.db, place(at), chatMessageId(upTo));
  return null;
});

/** Every channel, in the order they were made, with its unread count. */
export const listChatChannels: Command<"listChatChannels"> = command((storage) =>
  channels.listChatChannels(storage.db).map(channel));

/** Makes a channel; its name is shown after `#`, which it may start with. */
export const createChatChannel: Command<"createChatChannel"> = command((storage, name) =>
  channel(channels.createChatChannel(storage.db, channelName(name), storage.now())));

/** Renames a channel or turns its notifications on or off. */
export const updateChatChannel: Command<"updateChatChannel"> = command((storage, id, edit) =>
  channel(channels.updateChatChannel(storage.db, chatChannelId(id), channelEdit(edit))));

/** Deletes a channel other than the default room; its threads and messages move to the
 * default room. */
export const deleteChatChannel: Command<"deleteChatChannel"> = command((storage, id) => {
  channels.deleteChatChannel(storage.db, chatChannelId(id), storage.now());
  return null;
});

/** The threads `filter` selects, the latest active first. */
export const listChatThreads: Command<"listChatThreads"> = command((storage, filter) =>
  threads.listChatThreads(storage.db, threadFilter(filter)).map(thread));

/** Opens a thread under a channel, following a task if one is given. */
export const createChatThread: Command<"createChatThread"> = command((storage, created) => {
  const title = threadTitle(created.title);
  const task = created.taskId === undefined || created.taskId === null ? null : taskId(created.taskId);
  return thread(threads.createChatThread(
    storage.db,
    { channel: chatChannelId(created.channelId), title, task },
    storage.now(),
  ));
});

/** Retitles a thread, links or unlinks its task, or opens, closes, or archives it. */
export const updateChatThread: Command<"updateChatThread"> = command((storage, id, edit) =>
  thread(threads.updateChatThread(storage.db, chatThreadId(id), threadEdit(edit), storage.now())));
