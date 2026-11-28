import {
  Suspense,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Bell,
  BellOff,
  ChevronDown,
  Flag,
  Lock,
  MessageCircle,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SendHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  ChatComposerInput,
  ChatDictationButton,
  ChatMessage as Message,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  type ChatComposerTrigger,
  type ChatMessageStatus,
} from "@astryxdesign/core/Chat";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button, IconButton } from "@/components/button";
import { detailsSheet } from "@/components/details-sheet";
import { ResizeHandle } from "@/components/resize-handle";
import { Markdown, StatusBadge } from "@/components/task-common";
import doriAvatar from "@/web/dori-avatar.png";
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
  type Task,
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
  listTasks,
  queryKeys,
  uploadChatAttachment,
  useChat,
  useChatAttachmentUrl,
  useChatChannels,
  useChatThreads,
  useChooseChatAction,
  useCreateChatChannel,
  useCreateChatThread,
  useDeleteChatChannel,
  useMarkChatRead,
  useSearchChat,
  useTasks,
  useUpdateChatChannel,
  useUpdateChatThread,
} from "@/lib/queries";
import { awaitsAnswer, taskChats, waitingThreads, type TaskChat, type TaskChats } from "@/lib/task-chats";
import { fill, useI18n, useMessages, type Locale } from "@/lib/i18n";
import { en, type Messages } from "@/locales/en";
import { cn } from "@/lib/utils";
import { useVoiceInput } from "@/lib/voice";
import { apiRequest } from "@/web/session";

/** The channel and thread the chat shows, kept across starts. */
type Selection = { channel: ChatChannelId; thread: ChatThreadId | null };

const selectionKey = "toodo-chat-place";

/** The channel every chat has. */
const firstChannel: ChatChannelId = 1;

/** Whether the chat list's Completed section is open, kept in this browser. */
const completedShownKey = "toodo-chat-completed-shown";

/** How many past chats the open Completed section lists at first, and how many more each "more" adds. */
const recentPast = 5;
const morePast = 20;

function storedCompletedShown(): boolean {
  return localStorage.getItem(completedShownKey) === "true";
}

function storeCompletedShown(shown: boolean) {
  if (shown) localStorage.setItem(completedShownKey, "true");
  else localStorage.removeItem(completedShownKey);
}

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

/** How a task is named in the chat: its number and title. */
export function taskName(task: Pick<Task, "id" | "title">): string {
  return `#${task.id} ${task.title}`;
}

/**
 * How the chat names a thread: a task's thread by its task, whatever title the agent gave it
 * (which may carry the agent's own names, such as a lane key), and any other by its title.
 */
export function threadName(thread: Pick<ChatThread, "title" | "taskId">, tasks: readonly Task[]): string {
  const task = thread.taskId === null ? undefined : tasks.find((candidate) => candidate.id === thread.taskId);
  return task === undefined ? thread.title : taskName(task);
}

/** The unread messages of a thread; an archived thread has none. */
function threadUnread(thread: ChatThread | null): number {
  return thread === null || thread.status === "archived" ? 0 : thread.unread;
}

/**
 * The unread messages the chat lists, which the floating button shows: every channel's, and
 * those of the threads of the tasks it lists. Reading each listed place clears its share.
 */
export function totalUnread(channels: readonly ChatChannel[], tasks: TaskChats): number {
  const threads = [...tasks.needsAnswer, ...tasks.inProgress].map((chat) => threadUnread(chat.thread));
  return [...channels.map((channel) => channel.unread), ...threads].reduce((total, count) => total + count, 0);
}

/**
 * The receipt a person's message shows: sent until the agent acknowledges it (read), and a note
 * while it waits too long. Received by the agent but not yet read stays sent, as in other
 * messengers.
 */
export function receipt(message: ChatMessage, m: Messages = en): { status: ChatMessageStatus; note: string | null } {
  const status: ChatMessageStatus = message.ackedAt !== null ? "read" : "sent";
  return { status, note: message.overdue ? m.chat.waitingForAnswer : null };
}

function fullMessageTime(date: Date, locale: Locale): string {
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

function Time({ at }: { at: Timestamp }) {
  const { locale } = useI18n();
  const date = new Date(at * 1000);
  return (
    <time dateTime={date.toISOString()} title={fullMessageTime(date, locale)}>
      {date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

/**
 * What a message the outbox holds says under it once sending it failed: that it waits for the
 * server, or why the server refused it, with a retry, and for a refused one a way to drop it.
 */
function OutboxNote({ message, refresh }: { message: OutboxMessage; refresh: () => Promise<unknown> }) {
  const m = useMessages();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span>{message.refused ?? m.chat.outboxWaiting}</span>
      <Button
        variant="ghost"
        size="sm"
        label={m.common.retry}
        changesData
        onClick={() => void retryChatMessage(message.clientId, refresh)}
      />
      {message.refused !== null && (
        <Button variant="ghost" size="sm" label={m.chat.discard} onClick={() => discardChatMessage(message.clientId)} />
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
  const m = useMessages();
  if (attachments.length === 0) return null;
  return (
    <ul aria-label={m.chat.attachments} className="mt-1.5 flex flex-col gap-1.5">
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
  const m = useMessages();
  const choose = useChooseChatAction();
  if (message.actions.length === 0) return null;
  const chosen = message.chosen?.key ?? null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div role="group" aria-label={m.chat.choices} className="flex flex-wrap gap-1.5">
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
  return <Avatar size="md" name={agent.name} src={agent.avatarUrl ?? doriAvatar} tooltip={false} />;
}

/**
 * The agent writing a reply: bouncing dots in a bubble beside its avatar.
 */
function TypingMessage({ agent }: { agent: ChatAgent }) {
  const m = useMessages();
  return (
    <Message sender="assistant" avatar={<AgentAvatar agent={agent} />}>
      <ChatMessageBubble metadata={<ChatMessageMetadata footer={m.chat.typing} />}>
        <span role="status" aria-label={m.chat.agentWriting(agent.name)} className="flex h-5 items-center gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              aria-hidden
              className="size-1.5 rounded-full bg-current opacity-60 animate-typing-dot motion-reduce:animate-none"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      </ChatMessageBubble>
    </Message>
  );
}

function Messages({ agent, messages }: { agent: ChatAgent; messages: readonly ChatMessage[] }) {
  const m = useMessages();
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
        const { status, note } = receipt(message, m);
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
                  {fill(m.chat.chose, { choice: <strong>{message.body}</strong> })}
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

/** Whether typing goes through a touch keyboard, where Enter starts a new line and only the send button sends. */
function hasTouchKeyboard(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/** How many tasks the composer's `#` menu lists at most. */
const suggestedTaskCount = 10;

/**
 * The tasks the composer's `#` menu suggests for `query`, the text after the `#`, newest first:
 * for digits, those whose number starts with them, that number itself first; otherwise those
 * whose title holds the text, so a bare `#` lists the latest tasks.
 */
export function suggestedTasks(tasks: readonly Task[], query: string): Task[] {
  const newestFirst = [...tasks].sort((a, b) => b.id - a.id);
  if (/^\d+$/.test(query)) {
    const matching = newestFirst.filter((task) => String(task.id).startsWith(query));
    const exact = matching.filter((task) => String(task.id) === query);
    return [...exact, ...matching.filter((task) => String(task.id) !== query)].slice(0, suggestedTaskCount);
  }
  const text = query.toLocaleLowerCase();
  return newestFirst.filter((task) => task.title.toLocaleLowerCase().includes(text)).slice(0, suggestedTaskCount);
}

/**
 * The composer's `#` menu, which completes a task's number from the tasks `loaded` returns, or
 * from the server for a whole number that is not loaded, such as a task finished long ago.
 */
function taskTrigger(loaded: () => readonly Task[], words: Messages["chat"]): ChatComposerTrigger {
  // The tasks the menu lists, by item ID, with the tasks their status is judged against.
  const listed = new Map<string, { task: Task; byId: ReadonlyMap<TaskId, Task> }>();
  const items = (query: string, tasks: readonly Task[]) => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    listed.clear();
    return suggestedTasks(tasks, query).map((task) => {
      listed.set(String(task.id), { task, byId });
      return { id: String(task.id), label: taskName(task) };
    });
  };
  return {
    character: "#",
    menuLabel: words.taskMenu,
    emptySearchText: words.noMatchingTasks,
    searchSource: {
      bootstrap: () => items("", loaded()),
      search: async (query) => {
        const known = loaded();
        if (!/^[1-9]\d*$/.test(query) || known.some((task) => String(task.id) === query)) return items(query, known);
        // While the server is unreachable the menu still suggests from the loaded tasks.
        const found = await listTasks({ ids: [Number(query)] }).catch(() => []);
        return items(query, [...known, ...found]);
      },
    },
    renderItem: (item) => {
      const entry = listed.get(item.id);
      if (entry === undefined) return item.label;
      return (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 tabular-nums text-muted-foreground">#{entry.task.id}</span>
          <span className="min-w-0 flex-1 truncate">{entry.task.title}</span>
          <StatusBadge task={entry.task} byId={entry.byId} />
        </span>
      );
    },
    onSelect: (item) => `#${item.id} `,
  };
}

/**
 * Opens the composer's `#` menu just above `composer`, the whole input box, at its width, wherever
 * the `#` is typed. Astryx anchors the menu to a span it adds to the page at the caret; this moves
 * that span into the box to cover it, and `index.css` sizes the menu to it.
 */
function useTriggerMenuAboveComposer(composer: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const observer = new MutationObserver((records) => {
      const box = composer.current;
      // Only the conversation being typed in, when a channel and a thread show at once.
      if (box === null || !box.contains(document.activeElement)) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || !node.hasAttribute("data-astryx-trigger-anchor")) continue;
          // The box's border box, which its 1px border puts 1px outside its padding box.
          Object.assign(node.style, { left: "", top: "", width: "", height: "", position: "absolute", inset: "-1px" });
          box.append(node);
        }
      }
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [composer]);
}

/** A file picked for the next message: uploading, uploaded, or failed. */
type Upload = { key: string; file: File; preview: string | null; attachment: ChatAttachment | null; error: string | null };

/** Whether the agent is writing in `place`: the chat's answer, then its chat-typing events
 * for that place. */
function useTyping(place: ChatPlace, initial: Timestamp | null | undefined): boolean {
  const [until, setUntil] = useState<Timestamp | null>(null);
  useEffect(() => setUntil(initial ?? null), [initial]);
  useEffect(() => {
    const listening = events.chatTyping.listen((event) => {
      if (samePlace(event.payload.place, place)) setUntil(event.payload.until);
    });
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
  const { locale, m } = useI18n();
  const chat = useChat(place);
  const queryClient = useQueryClient();
  const refreshChat = () => queryClient.invalidateQueries({ queryKey: queryKeys.chat });
  const markRead = useMarkChatRead();
  const outbox = useSyncExternalStore(subscribeChatOutbox, chatOutbox);
  const [draft, setDraft] = useState("");
  const voice = useVoiceInput(setDraft, m);
  const tasks = useTasks();
  const loadedTasks = useRef<readonly Task[]>([]);
  loadedTasks.current = tasks.data ?? [];
  const triggers = useMemo(() => [taskTrigger(() => loadedTasks.current, m.chat)], [m]);
  const [uploads, setUploads] = useState<readonly Upload[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  useTriggerMenuAboveComposer(composer);
  const messages = chat.data === undefined ? [] : chatMessages(chat.data);
  const storedClientIds = new Set(messages.map((message) => message.clientId));
  const outgoing = outbox.filter((message) => samePlace(message.place, place) && !storedClientIds.has(message.clientId));
  const latest = chat.data?.pages[0];
  const agent = latest?.agent ?? defaultAgent;
  const typing = useTyping(place, latest?.typingUntil);
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
  const failedUpload = uploads.find((upload): upload is Upload & { error: string } => upload.error !== null);
  // As in other messengers, the microphone holds the send button's place until there is something to send,
  // and keeps it while it listens, so dictation can be stopped once its first phrase lands in the draft.
  const showsMicrophone = voice.speech.isSupported && (voice.speech.isListening || (draft.trim() === "" && uploads.length === 0));
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

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        aria-label={m.chat.messagesIn(label)}
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
              label={m.chat.earlierMessages}
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
            {m.chat.loadFailed(chat.error.message)}
          </p>
        ) : messages.length === 0 && outgoing.length === 0 && !typing ? (
          <p className="m-auto max-w-64 text-center text-sm text-muted-foreground">
            {chat.isPending ? (
              m.chat.loading
            ) : (
              <>
                <span className="block">{m.chat.empty}</span>
                <span className="block">{m.chat.emptyHint}</span>
              </>
            )}
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
              {typing && <TypingMessage agent={agent} />}
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
              aria-label={m.chat.filesToAttach}
              onChange={(event) => {
                pick([...(event.currentTarget.files ?? [])]);
                event.currentTarget.value = "";
              }}
            />
            {uploads.length > 0 && (
              <ul aria-label={m.chat.filesToSend} className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
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
                        label={upload.attachment === null && upload.error === null ? m.chat.uploading(upload.file.name) : upload.file.name}
                        onRemove={() => unpick(upload.key)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {voice.speech.isListening && (
              <p className="truncate px-1 pb-1 text-xs text-muted-foreground">
                {voice.speech.interimTranscript || m.chat.listening}
              </p>
            )}
            <div
              ref={composer}
              className="relative flex items-end gap-1 rounded-2xl border border-input bg-background p-1 focus-within:border-ring"
            >
              <IconButton
                variant="ghost"
                size="sm"
                label={m.chat.attachFiles}
                icon={<Plus />}
                changesData
                onClick={() => picker.current?.click()}
              />
              <ChatComposerInput
                className="min-w-0 flex-1 self-center"
                placeholder={m.chat.messageAgent(agent.name)}
                maxRows={6}
                triggers={triggers}
                value={draft}
                onChange={setDraft}
                onSubmit={sendDraft}
                enterKeyHint={hasTouchKeyboard() ? "enter" : "send"}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing || !hasTouchKeyboard()) return;
                  event.preventDefault();
                  // The input's own Enter sends, so the line break is inserted here instead.
                  document.execCommand("insertLineBreak");
                }}
              />
              {showsMicrophone ? (
                <ChatDictationButton dictation={voice.speech} size="sm" label={m.chat.voiceInput} />
              ) : (
                // Not paused while the server is unreachable: the outbox keeps the message until it answers.
                <IconButton
                  variant="primary"
                  size="sm"
                  label={m.chat.send}
                  icon={<SendHorizontal />}
                  isDisabled={uploading || (draft.trim() === "" && uploads.every((upload) => upload.attachment === null))}
                  onClick={() => sendDraft(draft)}
                />
              )}
            </div>
            {failedUpload !== undefined ? (
              <p role="alert" className="px-1 pt-1 text-xs text-destructive">
                {m.chat.uploadFailed(failedUpload.file.name, failedUpload.error)}
              </p>
            ) : (
              voice.error !== null && (
                <p role="status" className="px-1 pt-1 text-xs text-warning">
                  {voice.error}
                </p>
              )
            )}
          </>
        ) : (
          <p className="px-1 py-2 text-center text-xs text-muted-foreground">
            {m.chat.threadClosed}
          </p>
        )}
      </div>
    </div>
  );
  return (
    <InternationalizationProvider locale={locale} overrides={{ [locale]: m.chat.astryx }}>
      {content}
    </InternationalizationProvider>
  );
}

/** A one-line form that names something: a new channel, or a new name for one. */
function NameForm({
  label,
  submitLabel,
  initial = "",
  onSubmit,
  onCancel,
  pending,
  error,
}: {
  label: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
}) {
  const m = useMessages();
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== "") onSubmit(name.trim());
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
        <Button type="submit" size="sm" label={submitLabel} changesData isDisabled={pending || name.trim() === ""} />
        <Button variant="ghost" size="sm" label={m.common.cancel} onClick={onCancel} />
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

/** The fill of everything that marks a decision waiting on the owner, louder than an unread count. */
export const decisionFill = "bg-amber-400 text-amber-950";

/** A filled flag on its own, for the places too small for `DecisionMark`'s word. */
export function DecisionFlag({ className }: { className?: string }) {
  return <Flag aria-hidden className={cn("size-3", className)} fill="currentColor" strokeWidth={2.5} />;
}

/** The mark of a thread waiting on the owner's answer to a decision or request. */
export function DecisionMark() {
  const m = useMessages();
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold", decisionFill)}>
      <DecisionFlag />
      {m.chat.decision}
      <span className="sr-only">{m.chat.decisionHint}</span>
    </span>
  );
}

/** What a listed thread waits on: the decision mark, then its unread count. */
function PlaceMarks({ thread }: { thread: ChatThread | null }) {
  if (thread === null || thread.status === "archived") return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {awaitsAnswer(thread) && <DecisionMark />}
      <UnreadBadge count={threadUnread(thread)} />
    </span>
  );
}


export function ThreadStatusBadge({ status }: { status: ChatThreadStatus }) {
  const m = useMessages();
  if (status === "open") return null;
  return <Badge className="shrink-0" variant={status === "closed" ? "neutral" : "warning"} label={m.chat.threadStatus[status]} />;
}

/**
 * A listed place's look. The shown place carries an accent bar on its start edge and an accent
 * tint, and bold text means unread messages only, so a place that is both shows both.
 */
function placeItem(selected: boolean, { waiting = false, unread = false }: { waiting?: boolean; unread?: boolean } = {}) {
  return cn(
    "relative flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
    waiting && "bg-amber-50 ring-1 ring-amber-300 ring-inset dark:bg-amber-950/60 dark:ring-amber-700",
    selected &&
      "bg-primary/10 hover:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/20 before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-primary",
    unread && "font-semibold",
  );
}

/**
 * A listed place's button. While its `data-place-title` text is cut, a hover or keyboard focus
 * shows the full `title` in the app's tooltip. The tooltip mounts only then and unmounts as it
 * closes, so a long list mounts no tooltips up front. It opens beside the item (to its end, over
 * the conversation, or its start when there is no room there) rather than above it, so it never covers the item above
 * and a pointer moving up or down the list reaches the next item instead of the tooltip.
 */
function PlaceButton({
  title,
  className,
  current,
  onClick,
  children,
}: {
  title: string;
  className: string;
  current: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const pending = useRef<number | undefined>(undefined);
  const [tip, setTip] = useState(false);
  const forget = () => window.clearTimeout(pending.current);
  // Waits as long as the tooltip's own hover delay, so a pointer passing over the list shows nothing.
  const want = (delay: number) => {
    const shown = ref.current?.querySelector("[data-place-title]");
    if (shown == null || shown.scrollWidth <= shown.clientWidth) return;
    forget();
    pending.current = window.setTimeout(() => setTip(true), delay);
  };
  useEffect(() => forget, []);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        aria-current={current ? "page" : undefined}
        onClick={onClick}
        onPointerEnter={(event) => event.pointerType !== "touch" && want(200)}
        onPointerLeave={forget}
        onPointerDown={forget}
        onFocus={(event) => event.currentTarget.matches(":focus-visible") && want(0)}
        onBlur={forget}
      >
        {children}
      </button>
      {tip && (
        <Tooltip anchorRef={ref} content={title} placement="end" isDefaultOpen onOpenChange={(open) => setTip(open)} />
      )}
    </>
  );
}

/** A listed task: its number and title, and under them the latest message of its thread. */
function TaskPlace({ chat, selected, onOpen }: { chat: TaskChat; selected: boolean; onOpen: () => void }) {
  const m = useMessages();
  const { task, thread } = chat;
  const status = thread?.lastMessage ?? (task.status === "in_review" ? m.chat.inReview : "");
  return (
    <li>
      <PlaceButton
        title={`#${task.id} ${task.title}`}
        className={placeItem(selected, {
          waiting: thread !== null && awaitsAnswer(thread),
          unread: threadUnread(thread) > 0,
        })}
        current={selected}
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-muted-foreground">{`#${task.id}`}</span>
            <span data-place-title className="min-w-0 truncate">
              {task.title}
            </span>
          </span>
          {status !== "" && <span className="truncate text-xs font-normal text-muted-foreground">{status}</span>}
        </span>
        <PlaceMarks thread={thread} />
      </PlaceButton>
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
 * The chat's places: the channels, the default room first, then the tasks that need an
 * answer and the in-progress tasks a lane works on, each opening its thread. A channel shows
 * the threads under it that follow no task when it is shown; a task's thread opens from the
 * task. Threads are opened by the agent, or by opening a listed task, never by hand.
 */
function PlaceList({
  channels,
  threads,
  tasks,
  past,
  nameOf,
  selection,
  onSelect,
  onOpenTask,
}: {
  channels: readonly ChatChannel[];
  threads: readonly ChatThread[];
  tasks: TaskChats;
  past: readonly ChatThread[];
  nameOf: (thread: ChatThread) => string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onOpenTask: (chat: TaskChat) => void;
}) {
  const m = useMessages();
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showPast, setShowPast] = useState(storedCompletedShown);
  const createChannel = useCreateChatChannel();
  const loose = threads.filter((thread) => thread.taskId === null);
  const archived = loose.filter((thread) => thread.status === "archived").length;
  const shown = loose.filter((thread) => showArchived || thread.status !== "archived");
  // The default room first, then the others in the order they were made.
  const ordered = [
    ...channels.filter((channel) => channel.id === firstChannel),
    ...channels.filter((channel) => channel.id !== firstChannel),
  ];

  const place = (channel: ChatChannel) => {
    const current = channel.id === selection.channel;
    return (
      <li key={channel.id}>
        <PlaceButton
          title={`#${channel.name}`}
          className={placeItem(current && selection.thread === null, { unread: channel.unread > 0 })}
          current={current && selection.thread === null}
          onClick={() => onSelect({ channel: channel.id, thread: null })}
        >
          <span className="text-muted-foreground">#</span>
          <span data-place-title className="min-w-0 truncate">
            {channel.name}
          </span>
          {!channel.push && <BellOff aria-label={m.chat.notificationsOff} className="size-3 shrink-0 text-muted-foreground" />}
          <UnreadBadge count={channel.unread} />
        </PlaceButton>
        {current && (
          <div className="ml-3 flex flex-col gap-0.5 border-l pl-1">
            <ul aria-label={m.chat.threadsIn(channel.name)} className="flex flex-col gap-0.5">
              {shown.map((thread) => (
                <li key={thread.id}>
                  <PlaceButton
                    title={thread.title}
                    className={placeItem(selection.thread === thread.id, {
                      waiting: awaitsAnswer(thread),
                      unread: threadUnread(thread) > 0,
                    })}
                    current={selection.thread === thread.id}
                    onClick={() => onSelect({ channel: channel.id, thread: thread.id })}
                  >
                    <span
                      data-place-title
                      className={cn("min-w-0 truncate", thread.status !== "open" && "text-muted-foreground")}
                    >
                      {thread.title}
                    </span>
                    {thread.status !== "open" && (
                      <span className="sr-only">{m.chat.threadStatusHint(m.chat.threadStatus[thread.status])}</span>
                    )}
                    {thread.status === "closed" && <Lock aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
                    {thread.status === "archived" && (
                      <Archive aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <PlaceMarks thread={thread} />
                  </PlaceButton>
                </li>
              ))}
            </ul>
            {archived > 0 && (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  label={showArchived ? m.chat.hideArchived : m.chat.showArchived(archived)}
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
      <div className="flex items-center justify-between px-2 pb-1">
        <h3 className="text-xs font-medium text-muted-foreground">{m.chat.channels}</h3>
        <IconButton variant="ghost" size="sm" label={m.chat.newChannel} icon={<Plus />} onClick={() => setAdding(!adding)} />
      </div>
      {adding && (
        <NameForm
          label={m.chat.channelName}
          submitLabel={m.chat.add}
          pending={createChannel.isPending}
          error={createChannel.error?.message ?? null}
          onCancel={() => setAdding(false)}
          onSubmit={(name) =>
            createChannel.mutate(name, {
              onSuccess: (channel) => {
                setAdding(false);
                onSelect({ channel: channel.id, thread: null });
              },
            })
          }
        />
      )}
      <ul aria-label={m.chat.channels} className="flex flex-col gap-0.5">
        {ordered.map(place)}
      </ul>
      <TaskGroup
        label={m.chat.needsAnswer}
        icon={<Flag aria-hidden className="size-3 text-warning" />}
        chats={tasks.needsAnswer}
        selection={selection}
        onOpenTask={onOpenTask}
      />
      <TaskGroup
        label={m.chat.inProgress}
        chats={tasks.inProgress}
        selection={selection}
        onOpenTask={onOpenTask}
      />
      <PastChats
        threads={past}
        open={showPast}
        onToggle={() => {
          storeCompletedShown(!showPast);
          setShowPast(!showPast);
        }}
        nameOf={nameOf}
        selection={selection}
        onSelect={onSelect}
      />
    </div>
  );
}

/**
 * The threads whose conversation is over, latest first, in a section its heading opens and
 * folds. The open section lists the latest few and the rest behind a "more" button; picking a
 * thread shows it.
 */
function PastChats({
  threads,
  open,
  onToggle,
  nameOf,
  selection,
  onSelect,
}: {
  threads: readonly ChatThread[];
  open: boolean;
  onToggle: () => void;
  nameOf: (thread: ChatThread) => string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const m = useMessages();
  const [limit, setLimit] = useState(recentPast);
  const listed = threads.slice(0, limit);
  const hidden = threads.length - listed.length;
  return (
    <div className="flex flex-col gap-0.5 pt-2">
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        <button
          type="button"
          aria-expanded={open}
          className="-mx-1 flex items-center gap-1 rounded-sm px-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            // Opening again starts with the latest few.
            setLimit(recentPast);
            onToggle();
          }}
        >
          <ChevronDown aria-hidden className={cn("size-3 transition-transform", !open && "-rotate-90")} />
          {m.chat.completed}
          <span className="tabular-nums font-normal">{threads.length}</span>
        </button>
      </h3>
      {!open ? null : threads.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">{m.chat.noCompleted}</p>
      ) : (
        <ul aria-label={m.chat.completed} className="flex flex-col gap-0.5">
          {listed.map((thread) => (
            <li key={thread.id}>
              <PlaceButton
                title={nameOf(thread)}
                className={placeItem(selection.thread === thread.id, { unread: threadUnread(thread) > 0 })}
                current={selection.thread === thread.id}
                onClick={() => onSelect({ channel: thread.channelId, thread: thread.id })}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span data-place-title className="min-w-0 truncate">
                    {nameOf(thread)}
                  </span>
                  {thread.lastMessage !== null && (
                    <span className="truncate text-xs font-normal text-muted-foreground">{thread.lastMessage}</span>
                  )}
                </span>
                <ThreadStatusBadge status={thread.status} />
              </PlaceButton>
            </li>
          ))}
        </ul>
      )}
      {open && hidden > 0 && (
        <div>
          <Button variant="ghost" size="sm" label={m.chat.moreCompleted(hidden)} onClick={() => setLimit(limit + morePast)} />
        </div>
      )}
    </div>
  );
}

/**
 * The threads whose conversation is over: closed or archived ones, and those of finished
 * tasks, the latest active first.
 */
export function pastThreads(threads: readonly ChatThread[], tasks: readonly Task[]): ChatThread[] {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  const activity = (thread: ChatThread) => thread.lastMessageAt ?? thread.closedAt ?? thread.createdAt;
  return threads
    .filter((thread) => thread.status !== "open" || (thread.taskId !== null && done.has(thread.taskId)))
    .sort((a, b) => activity(b) - activity(a) || b.id - a.id);
}

/** Closes, archives, or reopens a thread, as its status allows. */
export function ThreadActions({ thread }: { thread: ChatThread }) {
  const m = useMessages();
  const update = useUpdateChatThread();
  const set = (status: ChatThreadStatus) => update.mutate({ id: thread.id, edit: { status } });
  return (
    <>
      {thread.status === "open" ? (
        <IconButton variant="ghost" size="sm" label={m.chat.closeThread} icon={<Lock />} changesData onClick={() => set("closed")} />
      ) : (
        <IconButton
          variant="ghost"
          size="sm"
          label={m.chat.reopenThread}
          icon={<RotateCcw />}
          changesData
          onClick={() => set("open")}
        />
      )}
      {thread.status !== "archived" && (
        <IconButton
          variant="ghost"
          size="sm"
          label={m.chat.archiveThread}
          icon={<Archive />}
          changesData
          onClick={() => set("archived")}
        />
      )}
    </>
  );
}

/**
 * Asks before deleting a channel, saying where what was said in it goes: its threads to the
 * default room, its own messages into an archived thread there named after it.
 */
function DeleteChannelDialog({
  channel,
  defaultRoom,
  onClose,
}: {
  channel: ChatChannel;
  defaultRoom: string;
  onClose: () => void;
}) {
  const { locale, m } = useI18n();
  const remove = useDeleteChatChannel();
  const close = () => {
    if (!remove.isPending) onClose();
  };
  const dialog = (
    <Dialog isOpen onOpenChange={(open) => !open && close()} width={420}>
      <DialogHeader title={m.chat.confirmDeleteChannel(channel.name)} onOpenChange={(open) => !open && close()} />
      <div className="flex flex-col gap-2 py-3 text-sm">
        <p>
          {m.chat.deleteChannelExplanation(defaultRoom, channel.name)}
        </p>
        {remove.isError && (
          <p role="alert" className="text-xs break-words text-destructive">
            {remove.error.message}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t pt-3">
        <Button variant="ghost" label={m.common.cancel} isDisabled={remove.isPending} onClick={close} />
        <Button
          variant="destructive"
          className="ml-auto"
          label={remove.isPending ? m.chat.deleting : m.chat.deleteChannel}
          changesData
          isDisabled={remove.isPending}
          onClick={() => remove.mutate(channel.id, { onSuccess: onClose })}
        />
      </div>
    </Dialog>
  );
  return (
    <InternationalizationProvider locale={locale} overrides={{ [locale]: { "@astryx.dialog.close": m.common.close } }}>
      {dialog}
    </InternationalizationProvider>
  );
}

/** Renames, deletes, or mutes the shown channel; the default room is never deleted. */
function ChannelActions({
  channel,
  defaultRoom,
  onRename,
}: {
  channel: ChatChannel;
  defaultRoom: string;
  onRename: () => void;
}) {
  const m = useMessages();
  const updateChannel = useUpdateChatChannel();
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <IconButton variant="ghost" size="sm" label={m.chat.renameChannel(channel.name)} icon={<Pencil />} changesData onClick={onRename} />
      {channel.id !== firstChannel && (
        <IconButton
          variant="ghost"
          size="sm"
          label={m.chat.deleteNamedChannel(channel.name)}
          icon={<Trash2 />}
          changesData
          onClick={() => setDeleting(true)}
        />
      )}
      <IconButton
        variant="ghost"
        size="sm"
        label={channel.push ? m.chat.muteChannel(channel.name) : m.chat.unmuteChannel(channel.name)}
        icon={channel.push ? <Bell /> : <BellOff />}
        aria-pressed={channel.push}
        changesData
        onClick={() => updateChannel.mutate({ id: channel.id, edit: { push: !channel.push } })}
      />
      {deleting && <DeleteChannelDialog channel={channel} defaultRoom={defaultRoom} onClose={() => setDeleting(false)} />}
    </>
  );
}

/** The name of the shown channel or thread, with what can be done to it. */
function PlaceHeader({
  channel,
  thread,
  threadLabel,
  defaultRoom,
  onBack,
  onShowTask,
}: {
  channel: ChatChannel | undefined;
  thread: ChatThread | undefined;
  threadLabel: string;
  defaultRoom: string;
  onBack: () => void;
  onShowTask: (id: TaskId) => void;
}) {
  const m = useMessages();
  const rename = useUpdateChatChannel();
  const [renaming, setRenaming] = useState(false);
  if (renaming && channel !== undefined && thread === undefined) {
    return (
      <div className="border-b px-1 py-1">
        <NameForm
          key={channel.id}
          label={m.chat.channelName}
          submitLabel={m.chat.rename}
          initial={channel.name}
          pending={rename.isPending}
          error={rename.error?.message ?? null}
          onCancel={() => setRenaming(false)}
          onSubmit={(name) =>
            rename.mutate({ id: channel.id, edit: { name } }, { onSuccess: () => setRenaming(false) })
          }
        />
      </div>
    );
  }
  const taskId = thread?.taskId ?? null;
  return (
    <div className="flex min-h-11 items-center gap-1 border-b px-2 py-1">
      <IconButton variant="ghost" size="sm" className="@2xl:hidden" label={m.chat.channels} icon={<ArrowLeft />} onClick={onBack} />
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <span className="min-w-0 truncate">{thread !== undefined ? threadLabel : `#${channel?.name ?? ""}`}</span>
          {thread !== undefined && <ThreadStatusBadge status={thread.status} />}
        </h3>
        {thread !== undefined && channel !== undefined && (
          <p className="truncate text-xs text-muted-foreground">
            {taskId === null
              ? m.chat.inChannel(channel.name)
              : fill(m.chat.inChannelWithTask, {
                  channel: m.chat.inChannel(channel.name),
                  task: (
                    <button type="button" className="underline" onClick={() => onShowTask(taskId)}>
                      {m.chat.taskLink(taskId)}
                    </button>
                  ),
                })}
          </p>
        )}
      </div>
      {thread !== undefined ? (
        <ThreadActions thread={thread} />
      ) : (
        channel !== undefined && (
          <ChannelActions
            channel={channel}
            defaultRoom={defaultRoom}
            onRename={() => {
              rename.reset();
              setRenaming(true);
            }}
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

/**
 * Finds earlier messages of every channel and thread; picking one opens where it is.
 * `threadLabel` names a hit's thread from its id and stored title.
 */
export function ChatSearch({
  onOpen,
  threadLabel = (_, title) => title,
}: {
  onOpen: (selection: Selection) => void;
  threadLabel?: (id: ChatThreadId, title: string) => string;
}) {
  const { locale, m } = useI18n();
  const [query, setQuery] = useState("");
  const searched = useDeferredValue(query);
  const results = useSearchChat(searched, null);
  const hits = results.data ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-2">
        <TextInput label={m.chat.searchMessages} isLabelHidden size="sm" value={query} onChange={setQuery} hasAutoFocus placeholder={m.chat.searchMessages} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {results.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {m.chat.searchFailed(results.error.message)}
          </p>
        ) : searched.trim() === "" ? (
          <p className="p-2 text-center text-sm text-muted-foreground">{m.chat.searchHint}</p>
        ) : results.isPending ? (
          <p className="p-2 text-center text-sm text-muted-foreground">{m.chat.searching}</p>
        ) : hits.length === 0 ? (
          <p className="p-2 text-center text-sm text-muted-foreground">{m.chat.noSearchResults}</p>
        ) : (
          <ul aria-label={m.chat.searchResults} className="flex flex-col gap-1">
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
                      {hit.threadTitle !== null &&
                        hit.message.threadId !== null &&
                        ` / ${threadLabel(hit.message.threadId, hit.threadTitle)}`}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{fullMessageTime(new Date(hit.message.at * 1000), locale)}</span>
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

/**
 * The chat window. It stays drawn while it closes (`open` false) until its closing animation
 * ends, then reports `onClosed`; with no animation (reduced motion) it reports that at once.
 *
 * From `md` up it is a popup above the floating button, and it stays open beside a task's details,
 * which then float just left of the popup while it narrows to `--chat-beside-details` (see
 * `src/index.css`). On a phone it fills the screen. Narrower than `@2xl` it shows either the
 * channels or one conversation.
 */
function ChatPanel({
  open,
  onClose,
  onClosed,
  onShowTask,
  target,
  onTargetShown,
}: {
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  onShowTask: (id: TaskId) => void;
  target: Selection | null;
  onTargetShown: () => void;
}) {
  const m = useMessages();
  const channels = useChatChannels();
  const [selection, setSelection] = useState(() => target ?? storedSelection());
  const [searching, setSearching] = useState(false);
  const threads = useChatThreads({ channelId: selection.channel, archived: true });
  const allThreads = useChatThreads({ archived: true });
  // The tasks of every thread are loaded, finished ones too, so past chats are named by their task.
  const tasks = useTasks((allThreads.data ?? []).map((candidate) => candidate.taskId));
  const createThread = useCreateChatThread();
  const listed = taskChats(tasks.data ?? [], allThreads.data ?? []);
  const past = pastThreads(allThreads.data ?? [], tasks.data ?? []);
  // A narrow panel shows either the channels or one conversation.
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
    if (!open) return;
    // Beside a task's details, Escape outside the chat is theirs; in the chat it is the chat's.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && document.querySelector(detailsSheet) === null) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  // jsdom has no Web Animations API, so tests close at once as reduced motion does.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open && !panel.current?.getAnimations?.().length) onClosed();
  }, [open]);

  // A listed task without a thread gets one in the default room.
  const openTask = ({ task, thread: taskThread }: TaskChat) => {
    if (taskThread !== null) {
      select({ channel: taskThread.channelId, thread: taskThread.id });
      return;
    }
    createThread.mutate(
      { channelId: firstChannel, title: taskName(task).slice(0, 200), taskId: task.id },
      { onSuccess: (opened) => select({ channel: opened.channelId, thread: opened.id }) },
    );
  };

  const place = placeOf(selection);
  const taskList = tasks.data ?? [];
  const threadLabel = thread === undefined ? "" : threadName(thread, taskList);
  const defaultRoom = channelList.find((candidate) => candidate.id === firstChannel)?.name ?? "general";
  const label = thread !== undefined ? threadLabel : `#${channel?.name ?? defaultRoom}`;
  const searchLabel = (id: ChatThreadId, title: string) => {
    const found = allThreads.data?.find((candidate) => candidate.id === id);
    return found === undefined ? title : threadName(found, taskList);
  };

  return (
    <section
      ref={panel}
      role="dialog"
      aria-label={m.chat.title}
      data-chat=""
      data-state={open ? "open" : "closed"}
      inert={!open}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
      onAnimationEnd={(event) => {
        if (!open && event.target === event.currentTarget) onClosed();
      }}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden bg-background shadow-xl print:hidden",
        // On desktop widths the owner's size, if any (`src/index.css`), replaces the default.
        "inset-0 md:inset-auto md:bottom-20 md:right-4 md:h-[var(--chat-height,min(42rem,calc(100dvh-7rem)))] md:w-[var(--chat-width,46rem)] md:max-w-[calc(100vw-2rem)] md:rounded-xl md:border",
        // Beside a task's details, which float just left of it, it narrows to leave the list in view.
        "md:details-open:w-(--chat-beside-details)",
        // It grows from and shrinks into the floating button's center.
        "origin-[calc(100%-2.5rem)_calc(100%-2.5rem)] md:origin-[calc(100%-1.5rem)_calc(100%+2.5rem)]",
        open ? "motion-safe:animate-chat-in" : "motion-safe:animate-chat-out",
      )}
    >
      <ResizeHandle label={m.chat.resize} width="chat-width" />
      <ResizeHandle label={m.chat.resizeHeight} height="chat-height" />
      <ResizeHandle label={m.chat.resizeBoth} width="chat-width" height="chat-height" />
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{m.chat.title}</h2>
        <IconButton
          variant="ghost"
          size="sm"
          className="ml-auto"
          label={searching ? m.chat.closeSearch : m.chat.searchMessages}
          icon={<Search />}
          aria-pressed={searching}
          onClick={() => {
            setSearching(!searching);
            setListShown(false);
          }}
        />
        <IconButton variant="ghost" size="sm" label={m.chat.close} icon={<X />} onClick={onClose} />
      </header>
      <div className="@container flex min-h-0 flex-1">
        <nav
          aria-label={m.chat.chatChannels}
          className={cn("w-full shrink-0 overflow-y-auto @2xl:w-56 @2xl:border-r", !listShown && "@max-2xl:hidden")}
        >
          {channels.isError ? (
            <p role="alert" className="p-3 text-sm text-destructive">
              {m.chat.channelsFailed(channels.error.message)}
            </p>
          ) : (
            <PlaceList
              channels={channelList}
              threads={threads.data ?? []}
              tasks={listed}
              past={past}
              nameOf={(candidate) => threadName(candidate, taskList)}
              selection={selection}
              onSelect={select}
              onOpenTask={openTask}
            />
          )}
        </nav>
        <div className={cn("flex min-w-0 flex-1 flex-col", listShown && "@max-2xl:hidden")}>
          {searching ? (
            <ChatSearch onOpen={select} threadLabel={searchLabel} />
          ) : (
            <>
              <PlaceHeader
                key={`header ${JSON.stringify(place)}`}
                channel={channel}
                thread={thread}
                threadLabel={threadLabel}
                defaultRoom={defaultRoom}
                onBack={() => setListShown(true)}
                onShowTask={onShowTask}
              />
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
 * it opens. A small chat mark on the button turns into a close mark while the chat is open; on a
 * phone, where the chat fills the screen, the button is hidden then and the chat's own close button
 * closes it.
 * While threads wait on the owner's decision it rings in amber and carries a flag with their
 * count, which stays until they are answered; the chat never opens by itself.
 * The chat opens and closes with an animation. `open` is kept by the app so a clicked notification can open it too, at the channel
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
  const m = useMessages();
  const channels = useChatChannels();
  const threads = useChatThreads({ archived: true });
  const tasks = useTasks();
  const unread = open ? 0 : totalUnread(channels.data ?? [], taskChats(tasks.data ?? [], threads.data ?? []));
  const decisions = open ? 0 : waitingThreads(threads.data ?? []).length;
  const button = useRef<HTMLButtonElement>(null);
  // On a phone the button is hidden while the chat is open, so closing the chat focuses it once it shows again.
  const refocus = useRef(false);
  const close = () => {
    refocus.current = true;
    onOpenChange(false);
  };
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [open]);
  // The panel stays drawn while its closing animation runs.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);

  return (
    <>
      {shown && (
        <ChatPanel
          open={open}
          onClose={close}
          onClosed={() => setShown(false)}
          onShowTask={onShowTask}
          target={target}
          onTargetShown={onTargetShown}
        />
      )}
      <div className={cn("fixed bottom-4 right-4 z-40 print:hidden", open && "max-md:hidden")}>
        <button
          ref={button}
          type="button"
          aria-label={
            open
              ? m.chat.close
              : [
                  m.chat.open,
                  ...(decisions > 0 ? [m.chat.decisionCount(decisions)] : []),
                  ...(unread > 0 ? [m.chat.unreadCount(unread)] : []),
                ].join(", ")
          }
          aria-expanded={open}
          className="relative block size-12 cursor-pointer rounded-full shadow-lg ring-2 ring-background transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          onClick={() => (open ? close() : onOpenChange(true))}
        >
          {decisions > 0 && (
            <span aria-hidden className="absolute -inset-1.5 rounded-full border-4 border-amber-400 motion-safe:animate-pulse" />
          )}
          <img src={doriAvatar} alt="" className="relative size-full rounded-full object-cover" />
          <span
            aria-hidden
            className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full border-2 border-background bg-primary text-primary-foreground"
          >
            {open ? (
              <X key="close" className="size-2.5 motion-safe:animate-chat-icon-turn" strokeWidth={4} />
            ) : (
              <MessageCircle key="chat" className="size-2.5" fill="currentColor" strokeWidth={2} />
            )}
          </span>
        </button>
        {decisions > 0 && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute -left-2 -top-2 flex h-5 items-center gap-0.5 rounded-full border-2 border-background px-1 text-xs font-bold shadow",
              decisionFill,
            )}
          >
            <DecisionFlag />
            {decisions > 9 ? "9+" : decisions}
          </span>
        )}
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
