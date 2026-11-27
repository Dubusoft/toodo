import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ToodoAttachment, type ToodoClientConfig, type ToodoFetch, type ToodoFile, ToodoMcp, ToodoWriteFailed, toAttachment } from "../toodo-client.ts";
import { guardText } from "./http.ts";

/*
 * The Toodo chat as a Dori platform, beside Discord. Dori is the agent of the chat (toodo-server's MCP chat tools, with
 * the `mcp-token`): it takes the owner's messages, acknowledges them, answers, and keeps one thread per task.
 *
 * A place in the chat is a ref: `toodo:channel/<id>` (the channel itself; channel 1 is the default room every chat has)
 * or `toodo:thread/<id>` (a thread, which may follow a task). `toodo` alone names the default room.
 *
 * Everything Dori writes goes through those tools, so the stored values are the ones the Rust server already reads: the
 * agent's messages are stored with author `lead`, a task thread is a `chat_threads` row with its `task_id`.
 */

export class ToodoChatError extends Error {}

export type ToodoPlace = { readonly kind: "channel" | "thread"; readonly id: number };

/** The chat's first channel, which cannot be removed: the default room. */
export const TOODO_DEFAULT_ROOM: ToodoPlace = { kind: "channel", id: 1 };

export const toodoRef = (place: ToodoPlace): string => `toodo:${place.kind}/${place.id}`;

export const isToodoRef = (ref: string): boolean => ref === "toodo" || ref.startsWith("toodo:");

/** The place a ref names; ToodoChatError for anything else. */
export const parseToodoRef = (ref: string): ToodoPlace => {
  const value = ref.trim();
  if (value === "toodo") return TOODO_DEFAULT_ROOM;
  const m = /^toodo:(channel|thread)\/([1-9]\d*)$/.exec(value);
  const id = m ? Number(m[2]) : NaN;
  if (!m || !Number.isSafeInteger(id)) throw new ToodoChatError(`bad Toodo chat ref "${ref}": use toodo:channel/<id>, toodo:thread/<id> or toodo`);
  return { kind: m[1] as ToodoPlace["kind"], id };
};

const placeArgs = (place: ToodoPlace): Record<string, number> => (place.kind === "channel" ? { channel_id: place.id } : { thread_id: place.id });

/** A chat message as Dori reads it: where it is, who wrote it, its text and its attached files. */
export type ToodoChatMessage = {
  readonly id: number;
  readonly place: ToodoPlace;
  readonly author: "user" | "agent" | "system";
  readonly body: string;
  readonly attachments: readonly ToodoAttachment[];
};

/** The most files one message takes (`attachments` of `reply_in_chat`). */
export const TOODO_FILES_MAX = 10;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

const toMessage = (raw: unknown, tool: string): ToodoChatMessage => {
  const bad = (what: string): never => { throw new ToodoChatError(`toodo-server ${tool} returned a message with ${what}`); };
  if (!isRecord(raw) || !isId(raw.id)) return bad("no id");
  if (!isId(raw.channelId)) return bad(`no channelId (${raw.id})`);
  if (raw.threadId !== null && raw.threadId !== undefined && !isId(raw.threadId)) return bad(`an unreadable threadId (${raw.id})`);
  if (raw.author !== "user" && raw.author !== "agent" && raw.author !== "system") return bad(`author ${JSON.stringify(raw.author)} (${raw.id})`);
  if (typeof raw.body !== "string") return bad(`no body (${raw.id})`);
  const files = Array.isArray(raw.attachments) ? raw.attachments : [];
  return {
    id: raw.id, author: raw.author, body: raw.body,
    place: isId(raw.threadId) ? { kind: "thread", id: raw.threadId } : { kind: "channel", id: raw.channelId },
    attachments: files.map((f) => toAttachment(f) ?? bad(`an unreadable attachment (${raw.id})`)),
  };
};

const toMessages = (raw: unknown, tool: string): ToodoChatMessage[] => {
  if (!Array.isArray(raw)) throw new ToodoChatError(`toodo-server ${tool} did not answer a message list`);
  return raw.map((m) => toMessage(m, tool));
};

const TITLE_MAX = 100;

/** The chat tools Dori calls, over one MCP connection; tests give the connection a fake fetch. */
export class ToodoChat {
  constructor(private readonly mcp: Pick<ToodoMcp, "call" | "uploadAttachment" | "attachment">) {}

  /** People's messages not taken yet, oldest first; `take` also marks them taken and delivered (the app's "read"). */
  async pending(take: boolean): Promise<ToodoChatMessage[]> {
    const tool = take ? "take_pending" : "peek_pending";
    return toMessages(await this.mcp.call(tool, {}), tool);
  }

  /**
   * Posts Dori's message at `place`; `handles` are the people's messages it answers, which it marks handled, and
   * `attachments` the ids of files uploaded for it (`upload`). A message with files may have no text.
   */
  async reply(place: ToodoPlace, body: string, handles: readonly number[] = [], attachments: readonly number[] = []): Promise<ToodoChatMessage> {
    const text = guardText(body).trim();
    if (!text && !attachments.length) throw new ToodoChatError("a Toodo chat message needs text or a file");
    if (attachments.length > TOODO_FILES_MAX) throw new ToodoChatError(`a Toodo chat message takes at most ${TOODO_FILES_MAX} files`);
    return toMessage(await this.mcp.call("reply_in_chat", {
      body: text, ...placeArgs(place), handles: [...handles], ...(attachments.length ? { attachments: [...attachments] } : {}),
    }), "reply_in_chat");
  }

  /** Uploads a file for Dori's next message; `reply` takes the returned id. */
  upload(file: ToodoFile): Promise<ToodoAttachment> {
    return this.mcp.uploadAttachment(file);
  }

  /** The bytes of an attachment of a chat message. */
  download(id: number): Promise<Uint8Array> {
    return this.mcp.attachment(id);
  }

  async ack(ids: readonly number[]): Promise<void> {
    await this.mcp.call("ack_chat", { ids: [...ids] });
  }

  /** Marks a person's message handled by Dori's reply or by the task made or updated for it. */
  async markHandled(id: number, link: { readonly replyId: number } | { readonly taskId: number }): Promise<void> {
    await this.mcp.call("mark_chat_handled", { id, ...("replyId" in link ? { reply_id: link.replyId } : { task_id: link.taskId }) });
  }

  async typing(on: boolean): Promise<void> {
    await this.mcp.call("set_typing", { typing: on });
  }

  /**
   * The thread of task `taskId`: its existing thread (reopened when closed), else a new one titled `title`. A task has
   * one thread (toodo-server refuses a second), so the existing one is looked up first.
   */
  async taskThread(taskId: number, title: string): Promise<ToodoPlace> {
    const threads = await this.mcp.call("list_threads", { task_id: taskId });
    if (!Array.isArray(threads)) throw new ToodoChatError("toodo-server list_threads did not answer a thread list");
    const found = threads.find((t): t is Record<string, unknown> => isRecord(t) && isId(t.id) && t.taskId === taskId);
    if (found) {
      if (found.status !== "open") await this.mcp.call("update_thread", { id: found.id, status: "open" });
      return { kind: "thread", id: found.id as number };
    }
    const created = await this.mcp.call("create_thread", { task_id: taskId, title: (title.trim() || `#${taskId}`).slice(0, TITLE_MAX) });
    if (!isRecord(created) || !isId(created.id)) throw new ToodoChatError("toodo-server create_thread returned no thread id");
    return { kind: "thread", id: created.id };
  }
}

export const toodoChat = (config: ToodoClientConfig, deps: { readonly fetch?: ToodoFetch; readonly timeoutMs?: number } = {}): ToodoChat =>
  new ToodoChat(new ToodoMcp(config, deps));

export const toodoErrorText = (e: unknown): string =>
  (e instanceof ToodoChatError || e instanceof ToodoWriteFailed || e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

/** An owner's attached file as the lead gets it: saved at `path` on this host, or `error` when it could not be saved. */
export type ToodoSavedFile = { readonly attachment: ToodoAttachment } & ({ readonly path: string } | { readonly error: string });

/**
 * A file name safe as one path segment that the INBOUND line can carry as `path=<path>`: no separators, control
 * characters, whitespace, brackets or leading dots, at most 120 characters.
 */
const safeFileName = (name: string): string => {
  const cleaned = name.trim().replace(/[\u0000-\u001f\u007f/\\\s[\]]/g, "_").replace(/^\.+/, "").slice(-120);
  return cleaned || "file";
};

/**
 * Saves the files attached to owner message `m` under `dir/<message id>/<attachment id>-<name>`, so the lead reads them
 * by path (the server serves them only with the MCP token). A file already saved with its size is not fetched again; a
 * failed one is reported with its error instead of failing the message.
 */
export const saveToodoAttachments = async (chat: Pick<ToodoChat, "download">, m: ToodoChatMessage, dir: string): Promise<ToodoSavedFile[]> => {
  const saved: ToodoSavedFile[] = [];
  for (const attachment of m.attachments) {
    const folder = join(dir, String(m.id));
    const path = join(folder, `${attachment.id}-${safeFileName(attachment.name)}`);
    try {
      if (!existsSync(path) || statSync(path).size !== attachment.size) {
        const data = await chat.download(attachment.id);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const partial = `${path}.partial`;
        writeFileSync(partial, data, { mode: 0o600 });
        renameSync(partial, path);
      }
      saved.push({ attachment, path });
    } catch (e) {
      saved.push({ attachment, error: toodoErrorText(e) });
    }
  }
  return saved;
};

/** One ` [attachment name=<file> type=<mime> path=<saved path>]` per file (`error=<why>` when unsaved), as Discord's lines name a url. */
const inboundFiles = (files: readonly ToodoSavedFile[]): string =>
  files.map((f) => {
    const where = "path" in f ? `path=${f.path}` : `id=${f.attachment.id} error=${f.error}`;
    return ` [attachment name=${f.attachment.name.replace(/[\s\]]+/g, "_")} type=${f.attachment.contentType} ${where}]`;
  }).join("");

/**
 * The journal event of an owner's chat message: `INBOUND <ref> <id> owner <text>` like a Discord owner message, with its
 * attached files as saved (saveToodoAttachments). The id `toodo-chat:<id>` differs from the removed Toodo Lead chat's
 * `toodo:chat:<n>`, whose rows an old journal may still hold.
 */
export const toodoInbound = (m: ToodoChatMessage, files: readonly ToodoSavedFile[] = []): { readonly id: string; readonly line: string } => {
  const text = m.body.replace(/\s+/g, " ").trim();
  return { id: `toodo-chat:${m.id}`, line: `INBOUND ${toodoRef(m.place)} ${m.id} owner ${text || "(no text)"}${inboundFiles(files)}` };
};

/** How often the pending messages are read without an event, for a `chat-changed` event the stream missed. */
export const TOODO_CHAT_POLL_MS = 60_000;
/** Event stream events that start a pass: a chat change, and a (re)connect or resync after which changes may be unseen. */
export const TOODO_CHAT_WAKE_EVENTS: ReadonlySet<string> = new Set(["chat-changed", "ready", "resync"]);

export type ToodoChatInboundDeps = {
  readonly chat: () => ToodoChat;
  /** The source registry's enqueue: durable when it returns, and an id already journaled is dropped. */
  readonly enqueue: (id: string, line: string) => void;
  /** Where the owner's attached files are saved for the lead (saveToodoAttachments). */
  readonly attachmentDir: string;
  readonly now: () => number;
  /** Milliseconds between safety passes when no `chat-changed` event wakes one. */
  readonly pollMs: number;
  readonly log: (line: string) => void;
};

/**
 * The owner's chat messages into the journal. A pass peeks the pending messages, journals each, and only then takes
 * them, so a crash before the take leaves them pending and the next pass's repeats are dropped by the journal. The take
 * marks every pending message, one posted after the peek included, so the taken ones are journaled again at once (the
 * journal drops those it already has). A pass runs on every `chat-changed` event (`wake`) and on the safety poll (`tick`).
 */
export const supervisorToodoChat = (deps: ToodoChatInboundDeps) => {
  let running: Promise<void> | undefined;
  let again = false;
  let lastPass = -Infinity;
  const journal = async (chat: ToodoChat, messages: readonly ToodoChatMessage[]): Promise<void> => {
    for (const m of messages) {
      const event = toodoInbound(m, await saveToodoAttachments(chat, m, deps.attachmentDir));
      deps.enqueue(event.id, event.line);
    }
  };
  const pass = (): Promise<void> => {
    again = true;
    if (running) return running;
    running = (async () => {
      while (again) {
        again = false;
        lastPass = deps.now();
        const chat = deps.chat();
        const peeked = await chat.pending(false);
        if (!peeked.length) continue;
        await journal(chat, peeked);
        await journal(chat, await chat.pending(true));
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    /** A pass soon, for a `chat-changed` event; a failure is logged and the safety poll tries again. */
    wake(): void {
      void pass().catch((e: unknown) => { deps.log(`TOODO_CHAT_ERROR ${toodoErrorText(e)}`); });
    },
    /** The safety poll: a pass when none ran for pollMs. A failure reaches the caller. */
    async tick(): Promise<void> {
      if (running) { await running; return; }
      if (deps.now() - lastPass >= deps.pollMs) await pass();
    },
  };
};
