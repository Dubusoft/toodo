// The chat between the people using Toodo and an agent connected over MCP: its channels and
// the threads under them, who wrote a message, the receipts of the agent's work on a
// person's message, the actions the agent offers on its messages with the one a person
// chose, and the files attached to messages.

import type { TaskId } from "./model.ts";

export type ChatMessageId = number & { readonly __brand: "ChatMessageId" };
export type ChatChannelId = number & { readonly __brand: "ChatChannelId" };
export type ChatThreadId = number & { readonly __brand: "ChatThreadId" };
export type ChatAttachmentId = number & { readonly __brand: "ChatAttachmentId" };

export function chatMessageId(id: number): ChatMessageId {
  return id as ChatMessageId;
}

export function chatChannelId(id: number): ChatChannelId {
  return id as ChatChannelId;
}

export function chatThreadId(id: number): ChatThreadId {
  return id as ChatThreadId;
}

export function chatAttachmentId(id: number): ChatAttachmentId {
  return id as ChatAttachmentId;
}

/** How the button of an action looks: plain, the suggested choice, or a destructive one. */
export type ActionStyle = "default" | "primary" | "danger";

const ACTION_STYLES: readonly ActionStyle[] = ["default", "primary", "danger"];

export function parseActionStyle(stored: string): ActionStyle | null {
  return ACTION_STYLES.find((style) => style === stored) ?? null;
}

/** A choice the agent offers on its message, shown as a button: `key` is what the agent gets
 * back when a person picks it, `label` what the button says. */
export type ChatAction = {
  readonly key: string;
  readonly label: string;
  readonly style: ActionStyle;
};

/** The action a person chose on the agent's message: once chosen, the others are closed. */
export type ChatChoice = {
  readonly key: string;
  readonly at: number;
  /** The person's message that records the choice, which the agent receives. */
  readonly choiceId: ChatMessageId;
};

/** The agent's message and action a person's message chose. */
export type ChoiceOf = {
  readonly messageId: ChatMessageId;
  readonly key: string;
};

/** A file uploaded to the chat, attached to a message once it is sent with one. */
export type ChatAttachment = {
  readonly id: ChatAttachmentId;
  /** Whose upload it is: a person's goes only on a person's message, the agent's only on the
   * agent's. */
  readonly uploader: ChatAuthor;
  readonly name: string;
  readonly contentType: string;
  /** Bytes. */
  readonly size: number;
  readonly messageId: ChatMessageId | null;
  readonly createdAt: number;
};

/** The channel every chat has: the one chat of earlier versions, which cannot be removed. */
export const FIRST_CHANNEL = chatChannelId(1);

/** Where a message is: in a channel itself, or in one of its threads. */
export type ChatPlace =
  | { readonly kind: "channel"; readonly id: ChatChannelId }
  | { readonly kind: "thread"; readonly id: ChatThreadId };

/** A channel of the chat. */
export type ChatChannel = {
  readonly id: ChatChannelId;
  readonly name: string;
  /** Whether the agent's messages in the channel and its threads notify devices. */
  readonly push: boolean;
  readonly createdAt: number;
  /** Messages of the agent and Toodo not read yet, in the channel and its threads that are
   * not archived. */
  readonly unread: number;
};

/** Whether a thread takes messages: `open` takes them; `closed` means its conversation is
 * over, and it takes messages again once reopened; `archived` is closed and put away, left
 * out of the channel's thread list unless asked for. */
export type ThreadStatus = "open" | "closed" | "archived";

const THREAD_STATUSES: readonly ThreadStatus[] = ["open", "closed", "archived"];

export function parseThreadStatus(stored: string): ThreadStatus | null {
  return THREAD_STATUSES.find((status) => status === stored) ?? null;
}

/** A thread under a channel, which may follow a task. */
export type ChatThread = {
  readonly id: ChatThreadId;
  readonly channelId: ChatChannelId;
  readonly title: string;
  readonly taskId: TaskId | null;
  readonly status: ThreadStatus;
  readonly createdAt: number;
  /** Set while it is closed or archived. */
  readonly closedAt: number | null;
  /** Set while it is archived. */
  readonly archivedAt: number | null;
  /** Messages of the agent and Toodo in it not read yet. */
  readonly unread: number;
  /** When its latest message was posted. */
  readonly lastMessageAt: number | null;
};

/** Who wrote a message: a person in the web app (`user`), the agent connected over MCP
 * (`agent`), or Toodo itself (`system`), e.g. the report of a finished task. */
export type ChatAuthor = "user" | "agent" | "system";

const CHAT_AUTHORS: readonly ChatAuthor[] = ["user", "agent", "system"];

/** The stored name. The agent's messages keep the name of the earlier lead chat, so its
 * conversation reads on. */
export function chatAuthorAsStr(author: ChatAuthor): string {
  switch (author) {
    case "user":
      return "user";
    case "agent":
      return "lead";
    case "system":
      return "system";
  }
}

export function parseChatAuthor(stored: string): ChatAuthor | null {
  return CHAT_AUTHORS.find((author) => chatAuthorAsStr(author) === stored) ?? null;
}

/** How long the agent has to acknowledge or handle a person's message before it is overdue,
 * in seconds. */
export const ANSWER_WITHIN = 10 * 60;

/** A message of the chat. The receipts are set only on a person's messages. */
export type ChatMessage = {
  readonly id: ChatMessageId;
  readonly channelId: ChatChannelId;
  readonly threadId: ChatThreadId | null;
  readonly author: ChatAuthor;
  readonly body: string;
  /** Unix seconds, as are the receipts. */
  readonly at: number;
  /** When the agent received the message. */
  readonly deliveredAt: number | null;
  /** When the agent acknowledged it. */
  readonly ackedAt: number | null;
  /** When the agent handled it, with its reply or the task made for it. */
  readonly handledAt: number | null;
  readonly handledReplyId: ChatMessageId | null;
  readonly handledTaskId: TaskId | null;
  /** When the message becomes overdue unless it is handled; `null` for messages stored
   * before receipts existed. */
  readonly dueAt: number | null;
  /** The choices the agent offers on its message, in order. */
  readonly actions: readonly ChatAction[];
  /** The action a person chose among them. */
  readonly chosen: ChatChoice | null;
  /** On a person's message that records a choice: what it chose. */
  readonly choiceOf: ChoiceOf | null;
  readonly attachments: readonly ChatAttachment[];
};

/** Whether the agent let a person's message wait past its due time. */
export function isOverdue(message: ChatMessage, now: number): boolean {
  return message.handledAt === null && message.dueAt !== null && message.dueAt <= now;
}
