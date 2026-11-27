import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageCircle, X } from "lucide-react";
import { Avatar } from "@astryxdesign/core/Avatar";
import {
  ChatComposer,
  ChatMessage as Message,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  type ChatMessageStatus,
} from "@astryxdesign/core/Chat";
import { Button, IconButton } from "@/components/button";
import { Markdown } from "@/components/task-common";
import { events, type ChatAgent, type ChatMessage, type Timestamp } from "@/lib/bindings";
import { chatMessages, useChat, useSendChatMessage } from "@/lib/queries";
import { formatFull } from "@/lib/timeline";
import { cn } from "@/lib/utils";

/** The ID of the latest message of the agent or Toodo this device showed, kept across starts. */
const readKey = "toodo-chat-read";

function lastRead(): number | null {
  const stored = localStorage.getItem(readKey);
  return stored === null || !/^\d+$/.test(stored) ? null : Number(stored);
}

/** Messages of the agent and Toodo after the last one this device showed. */
export function unreadCount(messages: readonly ChatMessage[], read: number | null): number {
  return read === null ? 0 : messages.filter((message) => message.author !== "user" && message.id > read).length;
}

/**
 * The receipt a person's message shows: received by the agent (delivered), acknowledged (read),
 * and a note once it is handled, or while it waits too long.
 */
export function receipt(message: ChatMessage): { status: ChatMessageStatus; note: string | null } {
  const status: ChatMessageStatus =
    message.ackedAt !== null ? "read" : message.deliveredAt !== null ? "delivered" : "sent";
  if (message.handledAt !== null) {
    return { status, note: message.handledTaskId !== null ? `Handled in task #${message.handledTaskId}` : "Handled" };
  }
  return { status, note: message.overdue ? "Waiting for an answer" : null };
}

function Time({ at }: { at: Timestamp }) {
  const date = new Date(at * 1000);
  return (
    <time dateTime={date.toISOString()} title={formatFull(at)}>
      {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

/** A message being sent, shown until the chat lists it, or with a retry when sending failed. */
type Pending = { clientId: string; body: string; failed: boolean };

function AgentAvatar({ agent }: { agent: ChatAgent }) {
  return <Avatar size="sm" name={agent.name} src={agent.avatarUrl ?? undefined} tooltip={false} />;
}

function Messages({ agent, messages }: { agent: ChatAgent; messages: readonly ChatMessage[] }) {
  return messages.map((message) => {
    switch (message.author) {
      case "system":
        return <ChatSystemMessage key={message.id}>{message.body}</ChatSystemMessage>;
      case "agent":
        return (
          <Message key={message.id} sender="assistant" avatar={<AgentAvatar agent={agent} />}>
            <ChatMessageBubble metadata={<ChatMessageMetadata timestamp={<Time at={message.at} />} />}>
              <Suspense fallback={<span className="whitespace-pre-wrap break-words">{message.body}</span>}>
                <Markdown source={message.body} />
              </Suspense>
            </ChatMessageBubble>
          </Message>
        );
      case "user": {
        const { status, note } = receipt(message);
        return (
          <Message key={message.id} sender="user">
            <ChatMessageBubble
              metadata={
                <ChatMessageMetadata
                  timestamp={<Time at={message.at} />}
                  status={status}
                  footer={note === null ? undefined : <span className={cn(message.overdue && "text-warning")}>{note}</span>}
                />
              }
            >
              <span className="whitespace-pre-wrap break-words">{message.body}</span>
            </ChatMessageBubble>
          </Message>
        );
      }
    }
  });
}

/** Until when the agent is writing: the chat's answer, then its chat-typing events. */
function useTypingUntil(initial: Timestamp | null | undefined): boolean {
  const [until, setUntil] = useState<Timestamp | null>(null);
  useEffect(() => setUntil(initial ?? null), [initial]);
  useEffect(() => {
    const listening = events.chatTyping.listen((event) => setUntil(event.payload.until));
    return () => void listening.then((unlisten) => unlisten());
  }, []);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (until === null) return;
    const wait = until * 1000 - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now() / 1000), wait);
    return () => clearTimeout(timer);
  }, [until]);
  return until !== null && until > Math.max(now, Date.now() / 1000);
}

function ChatPanel({ onClose }: { onClose: () => void }) {
  const chat = useChat();
  const send = useSendChatMessage();
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const messages = chat.data === undefined ? [] : chatMessages(chat.data);
  const latest = chat.data?.pages[0];
  const agent = latest?.agent ?? { name: "Agent", avatarUrl: null };
  const typing = useTypingUntil(latest?.typingUntil);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const newest = messages.at(-1)?.id;

  // The panel follows new messages while it is scrolled to the bottom, as it opens.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [newest, pending.length, typing]);

  // Everything shown counts as read.
  useEffect(() => {
    const shown = messages.filter((message) => message.author !== "user").at(-1)?.id;
    if (shown !== undefined && shown > (lastRead() ?? 0)) localStorage.setItem(readKey, String(shown));
  }, [newest]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = (item: Pending) => {
    setPending((current) => [...current.filter((other) => other.clientId !== item.clientId), { ...item, failed: false }]);
    atBottom.current = true;
    send.mutate(item, {
      onSuccess: () => setPending((current) => current.filter((other) => other.clientId !== item.clientId)),
      onError: () =>
        setPending((current) =>
          current.map((other) => (other.clientId === item.clientId ? { ...other, failed: true } : other)),
        ),
    });
  };

  return (
    <section
      role="dialog"
      aria-label={`Chat with ${agent.name}`}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden bg-background shadow-xl print:hidden",
        "inset-0 md:inset-auto md:bottom-20 md:right-4 md:h-[min(40rem,calc(100dvh-7rem))] md:w-[26rem] md:rounded-xl md:border",
      )}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <AgentAvatar agent={agent} />
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-sm font-semibold">{agent.name}</h2>
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {typing ? "Writing..." : "Chat"}
          </p>
        </div>
        <IconButton variant="ghost" size="sm" className="ml-auto" label="Close chat" icon={<X />} onClick={onClose} />
      </header>
      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2"
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {chat.hasNextPage && (
          <div className="flex justify-center pb-2">
            <Button
              variant="ghost"
              size="sm"
              label="Show earlier messages"
              isDisabled={chat.isFetchingNextPage}
              onClick={() => {
                atBottom.current = false;
                void chat.fetchNextPage();
              }}
            />
          </div>
        )}
        {chat.isError ? (
          <p role="alert" className="text-sm text-destructive">
            The chat could not be loaded: {chat.error.message}
          </p>
        ) : messages.length === 0 && pending.length === 0 && !typing ? (
          <p className="m-auto max-w-64 text-center text-sm text-muted-foreground">
            {chat.isPending ? "Loading the chat..." : "Messages here go to the agent connected to Toodo over MCP."}
          </p>
        ) : (
          // New messages start at the bottom, as in other chats.
          <div className="mt-auto">
          <ChatMessageList density="compact">
            <Messages agent={agent} messages={messages} />
            {pending.map((item) => (
              <Message key={item.clientId} sender="user">
                <ChatMessageBubble
                  metadata={
                    <ChatMessageMetadata
                      status={item.failed ? "error" : "sending"}
                      footer={
                        item.failed ? (
                          <Button variant="ghost" size="sm" label="Retry" changesData onClick={() => submit(item)} />
                        ) : undefined
                      }
                    />
                  }
                >
                  <span className="whitespace-pre-wrap break-words">{item.body}</span>
                </ChatMessageBubble>
              </Message>
            ))}
            {typing && <ChatSystemMessage>{agent.name} is writing...</ChatSystemMessage>}
          </ChatMessageList>
          </div>
        )}
      </div>
      <div className="border-t p-2">
        <ChatComposer
          density="compact"
          elevation="none"
          placeholder={`Message ${agent.name}`}
          onSubmit={(value) => {
            const body = value.trim();
            if (body !== "") submit({ clientId: crypto.randomUUID(), body, failed: false });
          }}
        />
      </div>
    </section>
  );
}

/**
 * The floating chat button, with the count of unread messages, and the chat it opens. `open`
 * is kept by the app so a clicked notification can open it too.
 */
export function Chat({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const chat = useChat();
  const messages = chat.data === undefined ? [] : chatMessages(chat.data);
  const newest = messages.at(-1)?.id;
  const [read, setRead] = useState(lastRead);
  // A device that never opened the chat starts with what is there as read.
  useEffect(() => {
    if (newest !== undefined && lastRead() === null) localStorage.setItem(readKey, String(newest));
    setRead(lastRead());
  }, [newest, open]);
  const unread = open ? 0 : unreadCount(messages, read);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    onOpenChange(false);
    button.current?.focus();
  };

  return (
    <>
      {open && <ChatPanel onClose={close} />}
      <div className={cn("fixed bottom-4 right-4 z-40 print:hidden", open && "max-md:hidden")}>
        <IconButton
          ref={button}
          variant="primary"
          label={unread > 0 ? `Open chat, ${unread} unread` : open ? "Close chat" : "Open chat"}
          icon={<MessageCircle />}
          aria-expanded={open}
          className="size-12 rounded-full shadow-lg"
          onClick={() => (open ? close() : onOpenChange(true))}
        />
        {unread > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold text-white"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </div>
    </>
  );
}
