import {
  Suspense,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Bell,
  BellOff,
  Flag,
  Lock,
  MessageCircle,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  SendHorizontal,
  X,
} from "lucide-react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatDictationButton,
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
  type ChatAttachment,
  type ChatChannel,
  type ChatChannelId,
  type ChatMessage,
  type ChatPlace,
  type ChatSearchHit,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadStatus,
  type TaskId,
  type Timestamp,
} from "@/lib/bindings";
import {
  chatOutbox,
  discardChatMessage,
  queueChatMessage,
  retryChatMessage,
  samePlace,
  subscribeChatOutbox,
  type OutboxMessage,
} from "@/lib/chat-outbox";
import {
  chatMessages,
  queryKeys,
  uploadChatAttachment,
  useChat,
  useChatAttachmentUrl,
  useChatChannels,
  useChatThreads,
  useChooseChatAction,
  useCreateChatChannel,
  useCreateChatThread,
  useMarkChatRead,
  useSearchChat,
  useTasks,
  useUpdateChatChannel,
  useUpdateChatThread,
} from "@/lib/queries";
import { laneOf, taskChats, type TaskChat, type TaskChats } from "@/lib/task-chats";
import { formatFull } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { useVoiceInput } from "@/lib/voice";
import { apiRequest } from "@/web/session";

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

/**
 * What a message the outbox holds says under it once sending it failed: that it waits for the
 * server, or why the server refused it, with a retry, and for a refused one a way to drop it.
 */
function OutboxNote({ message, refresh }: { message: OutboxMessage; refresh: () => Promise<unknown> }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span>{message.refused ?? "Not sent yet: it goes out once the server answers."}</span>
      <Button
        variant="ghost"
        size="sm"
        label="Retry"
        changesData
        onClick={() => void retryChatMessage(message.clientId, refresh)}
      />
      {message.refused !== null && (
        <Button variant="ghost" size="sm" label="Discard" onClick={() => discardChatMessage(message.clientId)} />
      )}
    </span>
  );
}

/** The images the server sends inline, which the chat shows in place. */
const inlineImages = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Saves an attachment, fetched signed in, under its name. */
async function download(attachment: ChatAttachment) {
  const blob = await (await apiRequest(`/api/chat/attachments/${attachment.id}`)).blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ImageAttachment({ attachment }: { attachment: ChatAttachment }) {
  const url = useChatAttachmentUrl(attachment.id);
  if (url.data === undefined) return <Thumbnail label={attachment.name} isLoading={url.isPending} />;
  return (
    <a href={url.data} target="_blank" rel="noreferrer" className="block w-fit">
      <img src={url.data} alt={attachment.name} className="max-h-48 max-w-full rounded-md" />
    </a>
  );
}

/** The files of a message: images in place, other files as buttons that download them. */
function Attachments({ attachments }: { attachments: readonly ChatAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="mt-1.5 flex flex-col gap-1.5">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          {inlineImages.includes(attachment.contentType) ? (
            <ImageAttachment attachment={attachment} />
          ) : (
            <button
              type="button"
              className="flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-left text-sm hover:bg-muted"
              onClick={() => void download(attachment).catch((error: unknown) => console.error("toodo: download failed", error))}
            >
              <Paperclip aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{attachment.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatSize(attachment.size)}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The choices the agent offers under its message; one may be chosen, which closes the others. */
function Actions({ message }: { message: ChatMessage }) {
  const choose = useChooseChatAction();
  if (message.actions.length === 0) return null;
  const chosen = message.chosen?.key ?? null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div role="group" aria-label="Choices" className="flex flex-wrap gap-1.5">
        {message.actions.map((action) => (
          <Button
            key={action.key}
            size="sm"
            label={action.label}
            variant={
              chosen === action.key
                ? "primary"
                : chosen !== null
                  ? "ghost"
                  : action.style === "primary"
                    ? "primary"
                    : action.style === "danger"
                      ? "destructive"
                      : "secondary"
            }
            aria-pressed={chosen === action.key}
            isDisabled={chosen !== null || choose.isPending}
            changesData
            onClick={() => choose.mutate({ messageId: message.id, key: action.key, clientId: crypto.randomUUID() })}
          />
        ))}
      </div>
      {choose.isError && (
        <p role="alert" className="text-xs text-destructive">
          {choose.error.message}
        </p>
      )}
    </div>
  );
}

const defaultAgent: ChatAgent = { name: "Dori", avatarUrl: null };

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
              <Attachments attachments={message.attachments} />
              <Actions message={message} />
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
              {message.choiceOf !== null ? (
                <span className="whitespace-pre-wrap break-words">
                  <span className="opacity-80">Chose </span>
                  <strong>{message.body}</strong>
                </span>
              ) : (
                <span className="whitespace-pre-wrap break-words">{message.body}</span>
              )}
              <Attachments attachments={message.attachments} />
            </ChatMessageBubble>
          </Message>
        );
      }
    }
  });
}

/** A file picked for the next message: uploading, uploaded, or failed. */
type Upload = { key: string; file: File; preview: string | null; attachment: ChatAttachment | null; error: string | null };

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
  const queryClient = useQueryClient();
  const refreshChat = () => queryClient.invalidateQueries({ queryKey: queryKeys.chat });
  const markRead = useMarkChatRead();
  const outbox = useSyncExternalStore(subscribeChatOutbox, chatOutbox);
  const [draft, setDraft] = useState("");
  const voice = useVoiceInput(setDraft);
  const [uploads, setUploads] = useState<readonly Upload[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const messages = chat.data === undefined ? [] : chatMessages(chat.data);
  const storedClientIds = new Set(messages.map((message) => message.clientId));
  const outgoing = outbox.filter((message) => samePlace(message.place, place) && !storedClientIds.has(message.clientId));
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
  }, [newest, outgoing.length, typing]);

  useEffect(() => {
    if (newest === undefined || newest === marked.current) return;
    marked.current = newest;
    markRead.mutate({ place, upTo: newest });
  }, [newest]);

  const pick = (files: readonly File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      const preview = inlineImages.includes(file.type) ? URL.createObjectURL(file) : null;
      setUploads((current) => [...current, { key, file, preview, attachment: null, error: null }]);
      const settle = (change: Partial<Upload>) =>
        setUploads((current) => current.map((upload) => (upload.key === key ? { ...upload, ...change } : upload)));
      uploadChatAttachment(file).then(
        (attachment) => settle({ attachment }),
        (error: unknown) => settle({ error: error instanceof Error ? error.message : String(error) }),
      );
    }
  };
  const unpick = (key: string) =>
    setUploads((current) => {
      const removed = current.find((upload) => upload.key === key);
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return current.filter((upload) => upload.key !== key);
    });
  const uploading = uploads.some((upload) => upload.attachment === null && upload.error === null);
  const failedUpload = uploads.find((upload) => upload.error !== null);
  const sendDraft = (value: string) => {
    const body = value.trim();
    const attachments = uploads.flatMap((upload) => (upload.attachment === null ? [] : [upload.attachment]));
    if (uploading || (body === "" && attachments.length === 0)) return;
    // Speech still being recognized would land in the emptied draft.
    voice.speech.abort();
    atBottom.current = true;
    void queueChatMessage({ clientId: crypto.randomUUID(), place, body, attachments }, refreshChat);
    setDraft("");
    for (const upload of uploads) if (upload.preview) URL.revokeObjectURL(upload.preview);
    setUploads([]);
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
        ) : messages.length === 0 && outgoing.length === 0 && !typing ? (
          <p className="m-auto max-w-64 text-center text-sm text-muted-foreground">
            {chat.isPending ? "Loading the chat..." : "Messages here go to the agent connected to Toodo over MCP."}
          </p>
        ) : (
          // New messages start at the bottom, as in other chats.
          <div className="mt-auto">
            <ChatMessageList density="compact">
              <Messages agent={agent} messages={messages} />
              {outgoing.map((item) => (
                <Message key={item.clientId} sender="user">
                  <ChatMessageBubble
                    metadata={
                      <ChatMessageMetadata
                        status={item.refused !== null ? "error" : "sending"}
                        footer={
                          item.refused !== null || item.waiting ? (
                            <OutboxNote message={item} refresh={refreshChat} />
                          ) : undefined
                        }
                      />
                    }
                  >
                    <span className="whitespace-pre-wrap break-words">{item.body}</span>
                    {item.attachments.length > 0 && (
                      <p className="text-xs opacity-80">
                        {item.attachments.map((attachment) => attachment.name).join(", ")}
                      </p>
                    )}
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
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Files to attach"
              onChange={(event) => {
                pick([...(event.currentTarget.files ?? [])]);
                event.currentTarget.value = "";
              }}
            />
            <ChatComposer
              density="compact"
              elevation="none"
              placeholder={`Message ${label}`}
              value={draft}
              onChange={setDraft}
              onSubmit={sendDraft}
              headerActions={
                <IconButton
                  variant="ghost"
                  size="sm"
                  label="Attach files"
                  icon={<Paperclip />}
                  changesData
                  onClick={() => picker.current?.click()}
                />
              }
              headerContext={
                voice.speech.isListening ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {voice.speech.interimTranscript || "Listening..."}
                  </span>
                ) : undefined
              }
              sendActions={<ChatDictationButton dictation={voice.speech} size="sm" label="Voice input" />}
              sendButton={
                // Not paused while the server is unreachable: the outbox keeps the message until it answers.
                <IconButton
                  variant="primary"
                  size="sm"
                  label="Send"
                  icon={<SendHorizontal />}
                  isDisabled={uploading || (draft.trim() === "" && uploads.every((upload) => upload.attachment === null))}
                  onClick={() => sendDraft(draft)}
                />
              }
              drawer={
                uploads.length > 0 ? (
                  <ChatComposerDrawer>
                    <ul aria-label="Files to send" className="flex flex-wrap items-center gap-1.5">
                      {uploads.map((upload) => (
                        <li key={upload.key}>
                          {upload.preview !== null ? (
                            <Thumbnail
                              src={upload.preview}
                              alt={upload.file.name}
                              label={upload.file.name}
                              isLoading={upload.attachment === null && upload.error === null}
                              onRemove={() => unpick(upload.key)}
                            />
                          ) : (
                            <Token
                              size="sm"
                              color={upload.error !== null ? "red" : "default"}
                              label={upload.attachment === null && upload.error === null ? `${upload.file.name} (uploading)` : upload.file.name}
                              onRemove={() => unpick(upload.key)}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </ChatComposerDrawer>
                ) : undefined
              }
              status={
                failedUpload !== undefined
                  ? { type: "error", message: `${failedUpload.file.name} could not be uploaded: ${failedUpload.error}` }
                  : voice.error !== null
                    ? { type: "warning", message: voice.error }
                    : undefined
              }
            />
          </>
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

function placeItem(selected: boolean) {
  return cn(
    "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
    selected && "bg-muted font-semibold",
  );
}

/** A listed task: its number and title, and under them the latest message of its thread. */
function TaskPlace({ chat, selected, onOpen }: { chat: TaskChat; selected: boolean; onOpen: () => void }) {
  const { task, thread } = chat;
  const lane = laneOf(task);
  const status = thread?.lastMessage ?? (task.status === "in_review" ? "In review" : lane !== null ? `lane:${lane}` : "");
  return (
    <li>
      <button type="button" className={placeItem(selected)} aria-current={selected ? "page" : undefined} onClick={onOpen}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-muted-foreground">{`#${task.id}`}</span>
            <span className="min-w-0 truncate">{task.title}</span>
          </span>
          {status !== "" && <span className="truncate text-xs font-normal text-muted-foreground">{status}</span>}
        </span>
        <UnreadBadge count={thread === null || thread.status === "archived" ? 0 : thread.unread} />
      </button>
    </li>
  );
}

/** A group of listed tasks under a heading, left out while it is empty. */
function TaskGroup({
  label,
  icon,
  chats,
  selection,
  onOpenTask,
}: {
  label: string;
  icon?: ReactNode;
  chats: readonly TaskChat[];
  selection: Selection;
  onOpenTask: (chat: TaskChat) => void;
}) {
  if (chats.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 pt-2">
      <h3 className="flex items-center gap-1 px-2 pb-1 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </h3>
      <ul aria-label={label} className="flex flex-col gap-0.5">
        {chats.map((chat) => (
          <TaskPlace
            key={chat.task.id}
            chat={chat}
            selected={chat.thread !== null && selection.thread === chat.thread.id}
            onOpen={() => onOpenTask(chat)}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * The chat's places: the default room first, then the tasks that need an answer and the
 * in-progress tasks a lane works on, each opening its thread, then the other channels. A
 * channel shows the threads under it that follow no task when it is shown; a task's thread
 * opens from the task.
 */
function PlaceList({
  channels,
  threads,
  tasks,
  selection,
  onSelect,
  onOpenTask,
}: {
  channels: readonly ChatChannel[];
  threads: readonly ChatThread[];
  tasks: TaskChats;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onOpenTask: (chat: TaskChat) => void;
}) {
  const [adding, setAdding] = useState<"channel" | "thread" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const createChannel = useCreateChatChannel();
  const createThread = useCreateChatThread();
  const loose = threads.filter((thread) => thread.taskId === null);
  const archived = loose.filter((thread) => thread.status === "archived").length;
  const shown = loose.filter((thread) => showArchived || thread.status !== "archived");
  const defaultRoom = channels.find((channel) => channel.id === firstChannel);
  const others = channels.filter((channel) => channel !== defaultRoom);

  const place = (channel: ChatChannel) => {
    const current = channel.id === selection.channel;
    return (
      <li key={channel.id}>
        <button
          type="button"
          className={placeItem(current && selection.thread === null)}
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
                    className={placeItem(selection.thread === thread.id)}
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
  };

  return (
    <div className="flex flex-col gap-0.5 p-2">
      {defaultRoom !== undefined && (
        <ul aria-label="Default room" className="flex flex-col gap-0.5">
          {place(defaultRoom)}
        </ul>
      )}
      <TaskGroup
        label="Needs answer"
        icon={<Flag aria-hidden className="size-3 text-warning" />}
        chats={tasks.needsAnswer}
        selection={selection}
        onOpenTask={onOpenTask}
      />
      <TaskGroup label="In progress" chats={tasks.inProgress} selection={selection} onOpenTask={onOpenTask} />
      <div className="flex items-center justify-between px-2 pb-1 pt-2">
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
        {others.map(place)}
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

/** Where a hit is: its channel and thread. */
function hitSelection(hit: ChatSearchHit): Selection {
  return { channel: hit.message.channelId, thread: hit.message.threadId };
}

/** Finds earlier messages of every channel and thread; picking one opens where it is. */
export function ChatSearch({ onOpen }: { onOpen: (selection: Selection) => void }) {
  const [query, setQuery] = useState("");
  const searched = useDeferredValue(query);
  const results = useSearchChat(searched, null);
  const hits = results.data ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-2">
        <TextInput label="Search messages" isLabelHidden size="sm" value={query} onChange={setQuery} hasAutoFocus placeholder="Search messages" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {results.isError ? (
          <p role="alert" className="text-sm text-destructive">
            The search failed: {results.error.message}
          </p>
        ) : searched.trim() === "" ? (
          <p className="p-2 text-center text-sm text-muted-foreground">Find messages by the words in them.</p>
        ) : results.isPending ? (
          <p className="p-2 text-center text-sm text-muted-foreground">Searching...</p>
        ) : hits.length === 0 ? (
          <p className="p-2 text-center text-sm text-muted-foreground">No messages match.</p>
        ) : (
          <ul aria-label="Search results" className="flex flex-col gap-1">
            {hits.map((hit) => (
              <li key={hit.message.id}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => onOpen(hitSelection(hit))}
                >
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {`#${hit.channelName}`}
                      {hit.threadTitle !== null && ` / ${hit.threadTitle}`}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{formatFull(hit.message.at)}</span>
                  </span>
                  <span className="line-clamp-2 whitespace-pre-wrap break-words text-sm">{hit.message.body}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ChatPanel({
  onClose,
  onShowTask,
  target,
  onTargetShown,
}: {
  onClose: () => void;
  onShowTask: (id: TaskId) => void;
  target: Selection | null;
  onTargetShown: () => void;
}) {
  const channels = useChatChannels();
  const [selection, setSelection] = useState(() => target ?? storedSelection());
  const [searching, setSearching] = useState(false);
  const threads = useChatThreads({ channelId: selection.channel, archived: true });
  const allThreads = useChatThreads({ archived: true });
  const tasks = useTasks();
  const createThread = useCreateChatThread();
  const listed = taskChats(tasks.data ?? [], allThreads.data ?? []);
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
    setSearching(false);
  };

  // A clicked notification shows its channel or thread, once.
  useEffect(() => {
    if (target === null) return;
    select(target);
    onTargetShown();
  }, [target]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // A listed task without a thread gets one in the default room.
  const openTask = ({ task, thread: taskThread }: TaskChat) => {
    if (taskThread !== null) {
      select({ channel: taskThread.channelId, thread: taskThread.id });
      return;
    }
    createThread.mutate(
      { channelId: firstChannel, title: `#${task.id} ${task.title}`.slice(0, 200), taskId: task.id },
      { onSuccess: (opened) => select({ channel: opened.channelId, thread: opened.id }) },
    );
  };

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
        <IconButton
          variant="ghost"
          size="sm"
          className="ml-auto"
          label={searching ? "Close search" : "Search messages"}
          icon={<Search />}
          aria-pressed={searching}
          onClick={() => {
            setSearching(!searching);
            setListShown(false);
          }}
        />
        <IconButton variant="ghost" size="sm" label="Close chat" icon={<X />} onClick={onClose} />
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
            <PlaceList
              channels={channelList}
              threads={threads.data ?? []}
              tasks={listed}
              selection={selection}
              onSelect={select}
              onOpenTask={openTask}
            />
          )}
        </nav>
        <div className={cn("flex min-w-0 flex-1 flex-col", listShown && "max-md:hidden")}>
          {searching ? (
            <ChatSearch onOpen={select} />
          ) : (
            <>
              <PlaceHeader channel={channel} thread={thread} onBack={() => setListShown(true)} onShowTask={onShowTask} />
              <Conversation
                key={JSON.stringify(place)}
                place={place}
                label={label}
                open={thread === undefined || thread.status === "open"}
              />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The floating chat button, with the count of unread messages in every channel, and the chat
 * it opens. `open` is kept by the app so a clicked notification can open it too, at the channel
 * or thread in `target`, which `onTargetShown` reports the chat took.
 */
export function Chat({
  open,
  onOpenChange,
  onShowTask,
  target = null,
  onTargetShown = () => {},
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowTask: (id: TaskId) => void;
  target?: Selection | null;
  onTargetShown?: () => void;
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
      {open && <ChatPanel onClose={close} onShowTask={onShowTask} target={target} onTargetShown={onTargetShown} />}
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
