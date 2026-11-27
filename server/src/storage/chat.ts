// The chat with the agent connected over MCP: posting messages and the receipts of the
// agent's work on each person's message: received (`delivered_at`, `taken_at`),
// acknowledged (`acked_at`, `seen_at`), and handled; and the choice a person makes among the
// actions on the agent's messages. Port of the writing parts of
// `src-tauri/src/storage/chat.rs`. Every function that writes takes the time it acts at
// (`at`, Unix seconds) from the caller.

import type { Database } from "bun:sqlite";

import {
  ANSWER_WITHIN,
  type ChatAction,
  type ChatAttachmentId,
  type ChatAuthor,
  type ChatMessage,
  type ChatMessageId,
  type ChatPlace,
  FIRST_CHANNEL,
  chatAuthorAsStr,
  chatMessageId,
} from "../domain/chat.ts";
import type { TaskId } from "../domain/model.ts";
import { attach } from "./chat-attachments.ts";
import { agentMessage, personMessage, storedMessage } from "./chat-messages.ts";
import { type Located, messagePlace, openPlace, taskExists } from "./chat-places.ts";
import { debugString } from "../domain/rust.ts";
import { StorageError } from "./errors.ts";

function insert(db: Database, place: Located, author: ChatAuthor, body: string, at: number): ChatMessageId {
  const due = author === "user" ? at + ANSWER_WITHIN : null;
  return chatMessageId(
    Number(
      db.run(
        `INSERT INTO chat_messages (author, body, at, due_at, channel_id, thread_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [chatAuthorAsStr(author), body, at, due, place.channel, place.thread],
      ).lastInsertRowid,
    ),
  );
}

function setClientId(db: Database, id: ChatMessageId, clientId: string): void {
  db.run("UPDATE chat_messages SET client_id = ?2 WHERE id = ?1", [id, clientId]);
}

function messageWithClientId(db: Database, clientId: string): ChatMessageId | null {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM chat_messages WHERE client_id = ?1")
    .get(clientId);
  return row === null ? null : chatMessageId(row.id);
}

/** Marks a person's message received and acknowledged, keeping earlier receipts. */
function acknowledge(db: Database, id: ChatMessageId, at: number): void {
  db.run(
    `UPDATE chat_messages SET
         delivered_at = coalesce(delivered_at, ?2),
         taken_at = coalesce(taken_at, ?2),
         seen_at = coalesce(seen_at, ?2),
         acked_at = coalesce(acked_at, ?2)
     WHERE id = ?1`,
    [id, at],
  );
}

/** What handled a person's message: the agent's reply, a task made for it, or neither. */
export interface ChatHandling {
  message: ChatMessageId;
  reply: ChatMessageId | null;
  task: TaskId | null;
}

function handle(db: Database, handling: ChatHandling, at: number): void {
  personMessage(db, handling.message);
  if (handling.reply !== null) {
    agentMessage(db, handling.reply);
  }
  if (handling.task !== null) {
    taskExists(db, handling.task);
  }
  acknowledge(db, handling.message, at);
  db.run(
    `UPDATE chat_messages SET
         handled_at = coalesce(handled_at, ?2),
         handled_reply_id = coalesce(?3, handled_reply_id),
         handled_task_id = coalesce(?4, handled_task_id)
     WHERE id = ?1`,
    [handling.message, at, handling.reply, handling.task],
  );
}

/** A person's message as a client sends it. */
export interface UserPost {
  place: ChatPlace;
  body: string;
  /** Names the message, so sending it again returns the stored one. */
  clientId: string;
  /** The person's free uploads. */
  attachments: readonly ChatAttachmentId[];
}

/**
 * Stores a person's message in `post.place`, which must exist and, for a thread, be open,
 * with the person's free uploads. A client names each message it sends, so sending it
 * again returns the stored one instead of repeating it.
 */
export function postUserMessage(db: Database, post: UserPost, at: number): ChatMessage {
  return db.transaction(() => {
    let id = messageWithClientId(db, post.clientId);
    if (id === null) {
      id = insert(db, openPlace(db, post.place), "user", post.body, at);
      setClientId(db, id, post.clientId);
      attach(db, id, "user", post.attachments);
    }
    return storedMessage(db, id);
  })();
}

/** The agent's message. */
export interface AgentPost {
  /** Where the first message it answers is, or the first channel, when `null`. */
  place: ChatPlace | null;
  body: string;
  /** The person's messages it answers, which it marks handled. */
  handles: readonly ChatMessageId[];
  /** The choices it offers; keys are unique within the message. */
  actions: readonly ChatAction[];
  /** The agent's free uploads. */
  attachments: readonly ChatAttachmentId[];
}

/**
 * Stores the agent's message, with the actions it offers and its free uploads, and marks
 * the person's messages it answers handled by it, all or nothing. Without a place it goes
 * where the first message it answers is, or to the first channel. Action keys are unique
 * within the message.
 */
export function postAgentMessage(db: Database, post: AgentPost, at: number): ChatMessage {
  return db.transaction(() => {
    const [first] = post.handles;
    let place: ChatPlace;
    if (post.place !== null) {
      place = post.place;
    } else if (first !== undefined) {
      place = messagePlace(personMessage(db, first));
    } else {
      place = { kind: "channel", id: FIRST_CHANNEL };
    }
    const id = insert(db, openPlace(db, place), "agent", post.body, at);
    post.actions.forEach((action, position) => {
      db.run(
        `INSERT INTO chat_actions (message_id, position, key, label, style)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
        [id, position, action.key, action.label, action.style],
      );
    });
    attach(db, id, "agent", post.attachments);
    for (const answered of post.handles) {
      handle(db, { message: answered, reply: id, task: null }, at);
    }
    return storedMessage(db, id);
  })();
}

/** A person's click on an action of the agent's message. */
export interface ChatClick {
  /** The agent's message. */
  message: ChatMessageId;
  /** The action's key. */
  key: string;
  /** Names the click, so sending it again returns the stored choice. */
  clientId: string;
}

/** The person's message that records a choice, and the agent's message with its choice. */
export interface ChosenAction {
  choice: ChatMessage;
  offered: ChatMessage;
}

/**
 * Records that a person chose the action `click.key` on the agent's message
 * `click.message`, as a person's message in the same place whose body is the action's
 * label, so the agent receives it like any other message. A message takes one choice, and
 * only while its place takes messages. `click.clientId` names the click, so sending it
 * again returns the stored choice.
 */
export function chooseChatAction(db: Database, click: ChatClick, at: number): ChosenAction {
  return db.transaction(() => {
    let choiceId = messageWithClientId(db, click.clientId);
    if (choiceId === null) {
      const offered = agentMessage(db, click.message);
      if (offered.chosen !== null) {
        throw new StorageError({ kind: "chat_action_chosen", message: click.message, key: offered.chosen.key });
      }
      const action = offered.actions.find((candidate) => candidate.key === click.key);
      if (action === undefined) {
        throw new StorageError({ kind: "chat_action_not_found", message: click.message, key: click.key });
      }
      choiceId = insert(db, openPlace(db, messagePlace(offered)), "user", action.label, at);
      setClientId(db, choiceId, click.clientId);
      db.run(
        `INSERT INTO chat_choices (message_id, key, choice_id, at)
         VALUES (?1, ?2, ?3, ?4)`,
        [click.message, click.key, choiceId, at],
      );
    }
    const choice = storedMessage(db, choiceId);
    if (choice.choiceOf === null) {
      throw new StorageError({
        kind: "invalid_data",
        reason: `client id ${debugString(click.clientId)} names a message, not a choice`,
      });
    }
    return { choice, offered: storedMessage(db, choice.choiceOf.messageId) };
  })();
}

/**
 * The person's messages the agent has not received yet, in every channel and thread,
 * oldest first. `take` marks them received, so the next call returns only newer ones.
 */
export function pendingChatMessages(db: Database, take: boolean, at: number): ChatMessage[] {
  return db.transaction(() => {
    const ids = db
      .query<{ id: number }, []>(
        `SELECT id FROM chat_messages WHERE author = 'user' AND taken_at IS NULL
         ORDER BY id`,
      )
      .all()
      .map((row) => chatMessageId(row.id));
    if (take) {
      for (const id of ids) {
        db.run(
          `UPDATE chat_messages SET taken_at = ?2, delivered_at = coalesce(delivered_at, ?2)
           WHERE id = ?1`,
          [id, at],
        );
      }
    }
    return ids.map((id) => storedMessage(db, id));
  })();
}

/**
 * Acknowledges a person's messages, all or nothing; acknowledging one again keeps its first
 * receipt.
 */
export function ackChatMessages(db: Database, ids: readonly ChatMessageId[], at: number): ChatMessage[] {
  return db.transaction(() =>
    ids.map((id) => {
      personMessage(db, id);
      acknowledge(db, id, at);
      return storedMessage(db, id);
    }),
  )();
}

/**
 * Marks a person's message handled, by the agent's reply or a task made for it, and
 * acknowledged if it was not yet.
 */
export function markChatHandled(db: Database, handling: ChatHandling, at: number): ChatMessage {
  return db.transaction(() => {
    handle(db, handling, at);
    return storedMessage(db, handling.message);
  })();
}
