/**
 * The chat's outbox: messages a person sent that the server has not stored yet, kept in
 * localStorage so one sent while the server is unreachable, or before a reload, is not lost.
 * Each keeps the client id it was first sent under, and the server stores a message once per
 * client id, so sending it again (after a lost answer, on reconnect, or from another tab) adds
 * no copy. A message the server refused keeps the reason until it is retried or discarded.
 * The app sends what waits whenever the server answers again (see `main.tsx`).
 *
 * `refresh` reloads the chat: it runs after the server stores a message and before the outbox
 * lets go of it, so the message never vanishes from the chat in between.
 */
import { commands, type ChatAttachment, type ChatPlace } from "@/lib/bindings";
import { CommandFailure, unwrap } from "@/lib/queries";

export type OutboxMessage = {
  clientId: string;
  place: ChatPlace;
  body: string;
  attachments: readonly ChatAttachment[];
  /** Whether sending it could not reach the server, so it waits for the server to answer again. */
  waiting: boolean;
  /** Why the server refused it; it is not sent again until retried. */
  refused: string | null;
};

type Refresh = () => Promise<unknown>;

const storageKey = "toodo-chat-outbox";
const listeners = new Set<() => void>();
/** The messages this tab is sending now, so a reconnect does not send one twice at once. */
const sending = new Set<string>();
/** The last stored value read, so an unchanged outbox gives the same array. */
let cache: { raw: string | null; messages: readonly OutboxMessage[] } = { raw: null, messages: [] };

function isOutboxMessage(value: unknown): value is OutboxMessage {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Record<string, unknown>;
  return (
    typeof stored.clientId === "string" &&
    typeof stored.body === "string" &&
    typeof stored.place === "object" &&
    stored.place !== null &&
    Array.isArray(stored.attachments) &&
    typeof stored.waiting === "boolean" &&
    (stored.refused === null || typeof stored.refused === "string")
  );
}

function parse(raw: string | null): readonly OutboxMessage[] {
  if (raw === null) return [];
  try {
    const stored: unknown = JSON.parse(raw);
    return Array.isArray(stored) ? stored.filter(isOutboxMessage) : [];
  } catch {
    // An unreadable outbox starts over empty.
    return [];
  }
}

/** The messages waiting to be stored, oldest first; the same array while they do not change. */
export function chatOutbox(): readonly OutboxMessage[] {
  const raw = localStorage.getItem(storageKey);
  if (raw !== cache.raw) cache = { raw, messages: parse(raw) };
  return cache.messages;
}

/** Calls `listener` whenever the outbox changes, in this tab or another. */
export function subscribeChatOutbox(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) listener();
  };
  listeners.add(listener);
  addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    removeEventListener("storage", onStorage);
  };
}

function save(messages: readonly OutboxMessage[]) {
  if (messages.length === 0) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, JSON.stringify(messages));
  listeners.forEach((listener) => listener());
}

function change(clientId: string, update: Partial<OutboxMessage>) {
  save(chatOutbox().map((message) => (message.clientId === clientId ? { ...message, ...update } : message)));
}

/** Sends one waiting message; resolves with whether the server stored it. */
async function deliver(clientId: string, refresh: Refresh): Promise<boolean> {
  const message = chatOutbox().find((other) => other.clientId === clientId);
  if (message === undefined || message.refused !== null || sending.has(clientId)) return false;
  sending.add(clientId);
  try {
    await unwrap(
      commands.sendChatMessage(
        message.place,
        message.body,
        message.clientId,
        message.attachments.map((attachment) => attachment.id),
      ),
    );
  } catch (error) {
    if (error instanceof CommandFailure) change(clientId, { waiting: false, refused: error.message });
    else change(clientId, { waiting: true });
    return false;
  } finally {
    sending.delete(clientId);
  }
  await refresh();
  save(chatOutbox().filter((other) => other.clientId !== clientId));
  return true;
}

/** Keeps a new message in the outbox and sends it; resolves with whether the server stored it. */
export function queueChatMessage(
  message: Pick<OutboxMessage, "clientId" | "place" | "body" | "attachments">,
  refresh: Refresh,
): Promise<boolean> {
  save([...chatOutbox(), { ...message, waiting: false, refused: null }]);
  return deliver(message.clientId, refresh);
}

/** Sends a waiting or refused message again under its client id. */
export function retryChatMessage(clientId: string, refresh: Refresh): Promise<boolean> {
  change(clientId, { waiting: false, refused: null });
  return deliver(clientId, refresh);
}

/** Drops a message from the outbox without sending it. */
export function discardChatMessage(clientId: string): void {
  save(chatOutbox().filter((message) => message.clientId !== clientId));
}

/** Sends every message that is not refused; resolves with how many the server stored. */
export async function flushChatOutbox(refresh: Refresh): Promise<number> {
  const waiting = chatOutbox().filter((message) => message.refused === null);
  const stored = await Promise.all(waiting.map((message) => deliver(message.clientId, refresh)));
  return stored.filter(Boolean).length;
}

/** Whether `a` and `b` are the same channel or the same thread. */
export function samePlace(a: ChatPlace, b: ChatPlace): boolean {
  return a.thread !== undefined ? a.thread === b.thread : b.thread === undefined && a.channel === b.channel;
}
