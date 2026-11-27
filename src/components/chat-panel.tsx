import { Suspense, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Archive, ArrowLeft, Bell, BellOff, Lock, MessageCircle, Plus, RotateCcw, X } from "lucide-react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import {
  ChatComposer,
  ChatMessage as Message,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  type ChatMessageStatus,
} from "@astryxdesign/core/Chat";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button, IconButton } from "@/components/button";
import { Markdown } from "@/components/task-common";
import {
  events,
  type ChatAgent,
  type ChatChannel,
  type ChatChannelId,
  type ChatMessage,
  type ChatPlace,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadStatus,
  type TaskId,
  type Timestamp,
} from "@/lib/bindings";
import {
  chatMessages,
  useChat,
  useChatChannels,
  useChatThreads,
  useCreateChatChannel,
  useCreateChatThread,
  useMarkChatRead,
  useSendChatMessage,
  useUpdateChatChannel,
  useUpdateChatThread,
} from "@/lib/queries";
import { formatFull } from "@/lib/timeline";
import { cn } from "@/lib/utils";

/** The channel and thread the chat shows, kept across starts. */
type Selection = { channel: ChatChannelId; thread: ChatThreadId | null };

const selectionKey = "toodo-chat-place";

/** The channel every chat has. */
const firstChannel: ChatChannelId = 1;

function storedSelection(): Selection {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(selectionKey) ?? "null");
    if (typeof stored === "object" && stored !== null && "channel" in stored && typeof stored.channel === "number") {
      const thread = "thread" in stored && typeof stored.thread === "number" ? stored.thread : null;
      return { channel: stored.channel, thread };
    }
  } catch {
    // An unreadable value starts over at the first channel.
  }
  return { channel: firstChannel, thread: null };
}

function placeOf(selection: Selection): ChatPlace {
  return selection.thread === null ? { channel: selection.channel } : { thread: selection.thread };
}

/** The unread messages of every channel, which the floating button shows. */
export function totalUnread(channels: readonly ChatChannel[]): number {
  return channels.reduce((total, channel) => total + channel.unread, 0);
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

const defaultAgent: ChatAgent = { name: "Agent", avatarUrl: null };

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

/**
 * The messages of one channel or thread with a composer, which a closed or archived thread
 * replaces with a note. What it shows counts as read. Give it a `key` per place.
 */
export function Conversation({ place, open = true, label }: { place: ChatPlace; open?: boolean; label: string }) {
  const chat = useChat(place);
  const send = useSendChatMessage(place);
  const markRead = useMarkChatRead();
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const messages = chat.data === undefined ? [] : chatMessages(chat.data);
  const latest = chat.data?.pages[0];
  const agent = latest?.agent ?? defaultAgent;
  const typing = useTypingUntil(latest?.typingUntil);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const marked = useRef<number | null>(null);
  const newest = messages.at(-1)?.id;

  // It follows new messages while it is scrolled to the bottom, as it opens.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [newest, pending.length, typing]);

  useEffect(() => {
    if (newest === undefined || newest === marked.current) return;
    marked.current = newest;
    markRead.mutate({ place, upTo: newest });
  }, [newest]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        aria-label={`Messages in ${label}`}
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
        {open ? (
          <ChatComposer
            density="compact"
            elevation="none"
            placeholder={`Message ${label}`}
            onSubmit={(value) => {
              const body = value.trim();
              if (body !== "") submit({ clientId: crypto.randomUUID(), body, failed: false });
            }}
          />
        ) : (
          <p className="px-1 py-2 text-center text-xs text-muted-foreground">
            This thread is closed. Reopen it to write in it.
          </p>
        )}
      </div>
    </div>
  );
}

/** A one-line form that adds something by name, such as a channel or a thread. */
function AddForm({
  label,
  initial = "",
  onAdd,
  onCancel,
  pending,
  error,
}: {
  label: string;
  initial?: string;
  onAdd: (name: string) => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== "") onAdd(name.trim());
  };
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-1 px-2 py-1"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <TextInput label={label} isLabelHidden size="sm" value={name} onChange={setName} hasAutoFocus />
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-1">
        <Button type="submit" size="sm" label="Add" changesData isDisabled={pending || name.trim() === ""} />
        <Button variant="ghost" size="sm" label="Cancel" onClick={onCancel} />
      </div>
    </form>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto flex min-w-5 shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

const statusLabels: Record<ChatThreadStatus, string> = { open: "Open", closed: "Closed", archived: "Archived" };

export function ThreadStatusBadge({ status }: { status: ChatThreadStatus }) {
  if (status === "open") return null;
  return <Badge className="shrink-0" variant={status === "closed" ? "neutral" : "warning"} label={statusLabels[status]} />;
}

/** The channels with their threads under the shown one, where each is picked and added. */
function PlaceList({
  channels,
  threads,
  selection,
  onSelect,
}: {
  channels: readonly ChatChannel[];
  threads: readonly ChatThread[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const [adding, setAdding] = useState<"channel" | "thread" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const createChannel = useCreateChatChannel();
  const createThread = useCreateChatThread();
  const archived = threads.filter((thread) => thread.status === "archived").length;
  const shown = threads.filter((thread) => showArchived || thread.status !== "archived");
  const item = (selected: boolean) =>
    cn(
      "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
      selected && "bg-muted font-semibold",
    );

  return (
    <div className="flex flex-col gap-0.5 p-2">
      <div className="flex items-center justify-between px-2 pb-1">
        <h3 className="text-xs font-medium text-muted-foreground">Channels</h3>
        <IconButton
          variant="ghost"
          size="sm"
          label="New channel"
          icon={<Plus />}
          onClick={() => setAdding(adding === "channel" ? null : "channel")}
        />
      </div>
      {adding === "channel" && (
        <AddForm
          label="Channel name"
          pending={createChannel.isPending}
          error={createChannel.error?.message ?? null}
          onCancel={() => setAdding(null)}
          onAdd={(name) =>
            createChannel.mutate(name, {
              onSuccess: (channel) => {
                setAdding(null);
                onSelect({ channel: channel.id, thread: null });
              },
            })
          }
        />
      )}
      <ul aria-label="Channels" className="flex flex-col gap-0.5">
        {channels.map((channel) => {
          const current = channel.id === selection.channel;
          return (
            <li key={channel.id}>
              <button
                type="button"
                className={item(current && selection.thread === null)}
                aria-current={current && selection.thread === null ? "page" : undefined}
                onClick={() => onSelect({ channel: channel.id, thread: null })}
              >
                <span className="text-muted-foreground">#</span>
                <span className="min-w-0 truncate">{channel.name}</span>
                {!channel.push && <BellOff aria-label="Notifications off" className="size-3 shrink-0 text-muted-foreground" />}
                <UnreadBadge count={channel.unread} />
              </button>
              {current && (
                <div className="ml-3 flex flex-col gap-0.5 border-l pl-1">
                  <ul aria-label={`Threads in #${channel.name}`} className="flex flex-col gap-0.5">
                    {shown.map((thread) => (
                      <li key={thread.id}>
                        <button
                          type="button"
                          className={item(selection.thread === thread.id)}
                          aria-current={selection.thread === thread.id ? "page" : undefined}
                          onClick={() => onSelect({ channel: channel.id, thread: thread.id })}
                        >
                          <span className={cn("min-w-0 truncate", thread.status !== "open" && "text-muted-foreground")}>
                            {thread.title}
                          </span>
                          {thread.status !== "open" && (
                            <span className="sr-only">{`, ${statusLabels[thread.status].toLowerCase()}`}</span>
                          )}
                          {thread.status === "closed" && <Lock aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
                          {thread.status === "archived" && (
                            <Archive aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                          )}
                          <UnreadBadge count={thread.status === "archived" ? 0 : thread.unread} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {adding === "thread" ? (
                    <AddForm
                      label="Thread title"
                      pending={createThread.isPending}
                      error={createThread.error?.message ?? null}
                      onCancel={() => setAdding(null)}
                      onAdd={(title) =>
                        createThread.mutate(
                          { channelId: channel.id, title },
                          {
                            onSuccess: (thread) => {
                              setAdding(null);
                              onSelect({ channel: channel.id, thread: thread.id });
                            },
                          },
                        )
                      }
                    />
                  ) : (
                    <div>
                      <Button variant="ghost" size="sm" label="New thread" onClick={() => setAdding("thread")} />
                    </div>
                  )}
                  {archived > 0 && (
                    <div>
                      <Button
                        variant="ghost"
                        size="sm"
                        label={showArchived ? "Hide archived threads" : `Show archived threads (${archived})`}
                        onClick={() => setShowArchived(!showArchived)}
                      />
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Closes, archives, or reopens a thread, as its status allows. */
export function ThreadActions({ thread }: { thread: ChatThread }) {
  const update = useUpdateChatThread();
  const set = (status: ChatThreadStatus) => update.mutate({ id: thread.id, edit: { status } });
  return (
    <>
      {thread.status === "open" ? (
        <IconButton variant="ghost" size="sm" label="Close thread" icon={<Lock />} changesData onClick={() => set("closed")} />
      ) : (
        <IconButton
          variant="ghost"
          size="sm"
          label="Reopen thread"
          icon={<RotateCcw />}
          changesData
          onClick={() => set("open")}
        />
      )}
      {thread.status !== "archived" && (
        <IconButton
          variant="ghost"
          size="sm"
          label="Archive thread"
          icon={<Archive />}
          changesData
          onClick={() => set("archived")}
        />
      )}
    </>
  );
}

/** The name of the shown channel or thread, with what can be done to it. */
function PlaceHeader({
  channel,
  thread,
  onBack,
  onShowTask,
}: {
  channel: ChatChannel | undefined;
  thread: ChatThread | undefined;
  onBack: () => void;
  onShowTask: (id: TaskId) => void;
}) {
  const updateChannel = useUpdateChatChannel();
  return (
    <div className="flex min-h-11 items-center gap-1 border-b px-2 py-1">
      <IconButton variant="ghost" size="sm" className="md:hidden" label="Channels" icon={<ArrowLeft />} onClick={onBack} />
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <span className="min-w-0 truncate">{thread !== undefined ? thread.title : `#${channel?.name ?? ""}`}</span>
          {thread !== undefined && <ThreadStatusBadge status={thread.status} />}
        </h3>
        {thread !== undefined && channel !== undefined && (
          <p className="truncate text-xs text-muted-foreground">
            {`in #${channel.name}`}
            {thread.taskId !== null && (
              <>
                {" · "}
                <button type="button" className="underline" onClick={() => onShowTask(thread.taskId!)}>
                  {`task #${thread.taskId}`}
                </button>
              </>
            )}
          </p>
        )}
      </div>
      {thread !== undefined ? (
        <ThreadActions thread={thread} />
      ) : (
        channel !== undefined && (
          <IconButton
            variant="ghost"
            size="sm"
            label={channel.push ? `Turn off notifications for #${channel.name}` : `Turn on notifications for #${channel.name}`}
            icon={channel.push ? <Bell /> : <BellOff />}
            aria-pressed={channel.push}
            changesData
            onClick={() => updateChannel.mutate({ id: channel.id, edit: { push: !channel.push } })}
          />
        )
      )}
    </div>
  );
}

function ChatPanel({ onClose, onShowTask }: { onClose: () => void; onShowTask: (id: TaskId) => void }) {
  const channels = useChatChannels();
  const [selection, setSelection] = useState(storedSelection);
  const threads = useChatThreads({ channelId: selection.channel, archived: true });
  // On a phone the panel shows either the channels or one conversation.
  const [listShown, setListShown] = useState(false);
  const channelList = channels.data ?? [];
  const channel = channelList.find((candidate) => candidate.id === selection.channel);
  const thread =
    selection.thread === null ? undefined : threads.data?.find((candidate) => candidate.id === selection.thread);

  // A channel or thread that is gone falls back to the first channel.
  useEffect(() => {
    const channelGone = channels.data !== undefined && channel === undefined;
    const threadGone = selection.thread !== null && threads.data !== undefined && thread === undefined;
    if (channelGone || threadGone) select({ channel: firstChannel, thread: null });
  }, [channels.data, threads.data]);

  const select = (next: Selection) => {
    setSelection(next);
    localStorage.setItem(selectionKey, JSON.stringify(next));
    setListShown(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const place = placeOf(selection);
  const label = thread !== undefined ? thread.title : `#${channel?.name ?? "general"}`;

  return (
    <section
      role="dialog"
      aria-label="Chat"
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden bg-background shadow-xl print:hidden",
        "inset-0 md:inset-auto md:bottom-20 md:right-4 md:h-[min(42rem,calc(100dvh-7rem))] md:w-[46rem] md:max-w-[calc(100vw-2rem)] md:rounded-xl md:border",
      )}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">Chat</h2>
        <IconButton variant="ghost" size="sm" className="ml-auto" label="Close chat" icon={<X />} onClick={onClose} />
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Chat channels"
          className={cn("w-full shrink-0 overflow-y-auto md:w-56 md:border-r", !listShown && "max-md:hidden")}
        >
          {channels.isError ? (
            <p role="alert" className="p-3 text-sm text-destructive">
              The channels could not be loaded: {channels.error.message}
            </p>
          ) : (
            <PlaceList channels={channelList} threads={threads.data ?? []} selection={selection} onSelect={select} />
          )}
        </nav>
        <div className={cn("flex min-w-0 flex-1 flex-col", listShown && "max-md:hidden")}>
          <PlaceHeader channel={channel} thread={thread} onBack={() => setListShown(true)} onShowTask={onShowTask} />
          <Conversation
            key={JSON.stringify(place)}
            place={place}
            label={label}
            open={thread === undefined || thread.status === "open"}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * The floating chat button, with the count of unread messages in every channel, and the chat
 * it opens. `open` is kept by the app so a clicked notification can open it too.
 */
export function Chat({
  open,
  onOpenChange,
  onShowTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowTask: (id: TaskId) => void;
}) {
  const channels = useChatChannels();
  const unread = open ? 0 : totalUnread(channels.data ?? []);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    onOpenChange(false);
    button.current?.focus();
  };

  return (
    <>
      {open && <ChatPanel onClose={close} onShowTask={onShowTask} />}
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
