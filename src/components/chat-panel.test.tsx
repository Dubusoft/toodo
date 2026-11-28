import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Chat, receipt, suggestedTasks, totalUnread } from "@/components/chat-panel";
import { commands, events, type ChatChannel, type ChatMessage, type ChatThread, type ChatTyping, type Task } from "@/lib/bindings";
import { flushChatOutbox } from "@/lib/chat-outbox";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listChat: vi.fn(),
    sendChatMessage: vi.fn(),
    chooseChatAction: vi.fn(),
    searchChat: vi.fn(),
    markChatRead: vi.fn(),
    listChatChannels: vi.fn(),
    listChatThreads: vi.fn(),
    createChatChannel: vi.fn(),
    updateChatChannel: vi.fn(),
    deleteChatChannel: vi.fn(),
    createChatThread: vi.fn(),
    updateChatThread: vi.fn(),
    listTasks: vi.fn(),
  },
  events: { chatTyping: { listen: vi.fn() } },
}));

const mocked = vi.mocked(commands);
const mockedEvents = vi.mocked(events, { deep: true });

function message(id: number, author: ChatMessage["author"], body: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    channelId: 1,
    threadId: null,
    author,
    body,
    at: 1700000000 + id,
    deliveredAt: null,
    ackedAt: null,
    handledAt: null,
    handledReplyId: null,
    handledTaskId: null,
    overdue: false,
    actions: [],
    chosen: null,
    choiceOf: null,
    attachments: [],
    ...overrides,
  };
}

function channel(id: number, name: string, overrides: Partial<ChatChannel> = {}): ChatChannel {
  return { id, name, push: true, createdAt: 1, unread: 0, ...overrides };
}

function thread(id: number, title: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    channelId: 1,
    title,
    taskId: null,
    status: "open",
    createdAt: 1,
    closedAt: null,
    archivedAt: null,
    awaitingAt: null,
    unread: 0,
    lastMessageAt: null,
    lastMessage: null,
    ...overrides,
  };
}

function task(id: number, status: Task["status"], refs: string[] = []): Task {
  return { id, title: `Task ${id}`, status, refs, dependsOn: [], timeline: [], notes: [] } as unknown as Task;
}

/** The open tasks the app loads; it loads no finished ones. */
function serveTasks(tasks: Task[]) {
  mocked.listTasks.mockImplementation(async (filter) => ({
    status: "ok",
    data: filter?.statuses?.includes("done") ? [] : tasks,
  }));
}

function serve(messages: ChatMessage[], channels = [channel(1, "general")], threads: ChatThread[] = []) {
  mocked.listChat.mockResolvedValue({
    status: "ok",
    data: { agent: { name: "Helper", avatarUrl: null }, messages, hasEarlier: false, typingUntil: null },
  });
  mocked.listChatChannels.mockResolvedValue({ status: "ok", data: channels });
  mocked.listChatThreads.mockResolvedValue({ status: "ok", data: threads });
}

function OpenableChat() {
  const [open, setOpen] = useState(false);
  return <Chat open={open} onOpenChange={setOpen} onShowTask={() => {}} />;
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <OpenableChat />
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeAll(() => {
  // jsdom has no modal dialogs; Astryx Dialog opens its <dialog> with showModal.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  localStorage.clear();
  mockedEvents.chatTyping.listen.mockResolvedValue(() => {});
  mocked.markChatRead.mockResolvedValue({ status: "ok", data: null });
  serveTasks([]);
});

/** A stand-in for the browser's speech recognition that the test feeds results to. */
class FakeRecognition {
  static started: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  start() {
    FakeRecognition.started.push(this);
    this.onstart?.();
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
  say(transcript: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
  }
}

describe("voice input", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
    FakeRecognition.started = [];
  });

  it("shows no microphone where the browser has no speech recognition", async () => {
    serve([]);
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    await screen.findByRole("combobox");
    expect(screen.queryByRole("button", { name: "Voice input" })).not.toBeInTheDocument();
  });

  it("writes each phrase the person says after the draft, in the browser's language", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    serve([]);
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    const input = await screen.findByRole("combobox");

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
    const recognition = FakeRecognition.started[0];
    expect(recognition.lang).toBe(navigator.language);
    act(() => recognition.say("call the bank", false));
    expect(await screen.findByText("call the bank")).toBeInTheDocument();
    act(() => recognition.say("call the bank", true));
    await waitFor(() => expect(input).toHaveTextContent("call the bank"));

    // The microphone stays while it listens, so the draft does not turn it into the send button.
    expect(screen.getByRole("button", { name: "Voice input" })).toBeInTheDocument();
    act(() => recognition.say("tomorrow", true));
    await waitFor(() => expect(input).toHaveTextContent("call the bank tomorrow"));
  });

  it("puts the send button in the microphone's place while there is a draft", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    serve([]);
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    const input = await screen.findByRole("combobox");
    expect(screen.getByRole("button", { name: "Voice input" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    fireEvent.input(input, { target: { textContent: "Hi" } });
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Voice input" })).not.toBeInTheDocument();

    fireEvent.input(input, { target: { textContent: "" } });
    expect(await screen.findByRole("button", { name: "Voice input" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("leaves the microphone to speech recognition while it listens", async () => {
    // On Android the microphone serves one capture at a time: a second one leaves recognition deaf.
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    serve([]);
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    await screen.findByRole("combobox");

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
    expect(FakeRecognition.started).toHaveLength(1);
    expect(await screen.findByText("Listening...")).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe("receipts", () => {
  it("go from sent to read, staying sent once delivered, with a note only while overdue", () => {
    expect(receipt(message(1, "user", "Hi"))).toEqual({ status: "sent", note: null });
    expect(receipt(message(1, "user", "Hi", { deliveredAt: 2 })).status).toBe("sent");
    expect(receipt(message(1, "user", "Hi", { deliveredAt: 2, ackedAt: 3 })).status).toBe("read");
    expect(receipt(message(1, "user", "Hi", { overdue: true })).note).toBe("Waiting for an answer");
    expect(receipt(message(1, "user", "Hi", { deliveredAt: 2, ackedAt: 3, handledAt: 4, handledTaskId: 9 }))).toEqual({
      status: "read",
      note: null,
    });
  });
});

describe("suggested tasks", () => {
  const titled = (id: number, title: string) => ({ ...task(id, "planned"), title });
  const tasks = [titled(7, "Fix login"), titled(17, "Tune search"), titled(170, "Fix search"), titled(171, "Docs"), titled(1700, "Ship")];
  const ids = (query: string) => suggestedTasks(tasks, query).map((suggested) => suggested.id);

  it("list the latest tasks, newest first, for a bare #", () => {
    expect(ids("")).toEqual([1700, 171, 170, 17, 7]);
    const many = Array.from({ length: 12 }, (_, index) => titled(index + 1, `Task ${index + 1}`));
    expect(suggestedTasks(many, "").map((suggested) => suggested.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it("match digits against the start of the number, the exact number first, then newest first", () => {
    expect(ids("17")).toEqual([17, 1700, 171, 170]);
    expect(ids("170")).toEqual([170, 1700]);
    expect(ids("9")).toEqual([]);
  });

  it("match other text against the title, ignoring case", () => {
    expect(ids("fix")).toEqual([170, 7]);
  });
});

describe("unread messages", () => {
  it("add up over every channel and the threads of the listed tasks", () => {
    const channels = [channel(1, "general", { unread: 2 }), channel(2, "work", { unread: 3 })];
    const tasks = {
      needsAnswer: [{ task: task(8, "in_review"), thread: thread(5, "#8 Task 8", { taskId: 8, unread: 4 }) }],
      inProgress: [
        { task: task(9, "in_progress", ["lane:ap-9"]), thread: null },
        { task: task(10, "in_progress", ["lane:ap-10"]), thread: thread(6, "#10", { taskId: 10, unread: 7, status: "archived" }) },
      ],
    };
    expect(totalUnread(channels, tasks)).toBe(9);
    expect(totalUnread([], { needsAnswer: [], inProgress: [] })).toBe(0);
  });
});

describe("Chat", () => {
  it("badges every channel's unread messages and marks the shown one read", async () => {
    serve([message(1, "agent", "Earlier"), message(2, "agent", "New reply")], [
      channel(1, "general", { unread: 1 }),
      channel(2, "work", { unread: 2 }),
    ]);
    renderChat();

    fireEvent.click(await screen.findByRole("button", { name: "Open chat, 3 unread" }));

    // The agent's Markdown loads lazily and replaces its fallback, so the text is looked up again.
    await waitFor(() => expect(screen.getByText("New reply")).toBeInTheDocument());
    const channels = await screen.findByRole("list", { name: "Channels" });
    expect(within(channels).getByRole("button", { name: /work/ })).toHaveTextContent("2");
    await waitFor(() => expect(mocked.markChatRead).toHaveBeenCalledWith({ channel: 1 }, 2));
  });

  it("lists tasks waiting for an answer and lanes at work, and opens a task's thread", async () => {
    serve([], undefined, [
      thread(5, "#7 Ship", { taskId: 7, lastMessage: "[progress] ap-7 Tests pass", lastMessageAt: 9 }),
    ]);
    serveTasks([task(7, "in_progress", ["lane:ap-7"]), task(8, "in_review"), task(9, "in_progress")]);
    mocked.createChatThread.mockResolvedValue({ status: "ok", data: thread(6, "#8 Task 8", { taskId: 8 }) });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    const working = await screen.findByRole("list", { name: "In progress" });
    expect(working).toHaveTextContent("#7Task 7[progress] ap-7 Tests pass");
    expect(working).not.toHaveTextContent("#9");
    const waiting = screen.getByRole("list", { name: "Needs answer" });
    expect(waiting).toHaveTextContent("#8Task 8In review");

    fireEvent.click(within(waiting).getByRole("button", { name: /#8/ }));
    await waitFor(() =>
      expect(mocked.createChatThread).toHaveBeenCalledWith({ channelId: 1, title: "#8 Task 8", taskId: 8 }),
    );
    await waitFor(() => expect(mocked.listChat).toHaveBeenCalledWith({ thread: 6 }, null));
  });

  it("flags threads waiting on a decision on the chat button and in the list, apart from the unread count", async () => {
    serve([], [channel(1, "general", { unread: 2 })], [
      thread(5, "#7 Ship", { taskId: 7, awaitingAt: 10, unread: 1 }),
      thread(6, "#9 Docs", { taskId: 9 }),
    ]);
    serveTasks([task(7, "in_progress", ["lane:ap-7"]), task(9, "in_progress", ["lane:ap-9"])]);
    renderChat();

    fireEvent.click(await screen.findByRole("button", { name: "Open chat, 1 waiting on your decision, 3 unread" }));

    const waiting = await screen.findByRole("list", { name: "Needs answer" });
    expect(within(waiting).getByRole("button", { name: /#7/ })).toHaveTextContent("Decision, waiting on your answer1");
    expect(within(screen.getByRole("list", { name: "In progress" })).getByRole("button", { name: /#9/ })).not.toHaveTextContent(
      "Decision",
    );
  });

  it("moves an in-progress chat to the top when a new message arrives in it", async () => {
    serve([], undefined, [
      thread(5, "#7 Ship", { taskId: 7, lastMessageAt: 20 }),
      thread(6, "#9 Docs", { taskId: 9, lastMessageAt: 10 }),
    ]);
    serveTasks([task(7, "in_progress", ["lane:ap-7"]), task(9, "in_progress", ["lane:ap-9"])]);
    const queryClient = renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    const order = () =>
      within(screen.getByRole("list", { name: "In progress" }))
        .getAllByRole("button", { name: /^#\d/ })
        .map((button) => button.textContent?.slice(0, 2));
    await waitFor(() => expect(order()).toEqual(["#7", "#9"]));

    // A new message in #9's thread; a chat change refetches the threads as the server's chat-changed event does.
    mocked.listChatThreads.mockResolvedValue({
      status: "ok",
      data: [
        thread(5, "#7 Ship", { taskId: 7, lastMessageAt: 20 }),
        thread(6, "#9 Docs", { taskId: 9, lastMessageAt: 30, lastMessage: "Done" }),
      ],
    });
    await act(() => queryClient.invalidateQueries({ queryKey: ["chat"] }));

    await waitFor(() => expect(order()).toEqual(["#9", "#7"]));
  });

  it("sends a message to the shown channel under a client id", async () => {
    serve([message(1, "user", "Ship it?", { deliveredAt: 2, ackedAt: 3, handledAt: 4 })]);
    mocked.sendChatMessage.mockResolvedValue({ status: "ok", data: message(2, "user", "Thanks") });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    expect(await screen.findByText("Ship it?")).toBeInTheDocument();
    expect(screen.queryByText("Handled")).not.toBeInTheDocument();
    const input = await screen.findByRole("combobox");
    fireEvent.input(input, { target: { textContent: "Thanks" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mocked.sendChatMessage).toHaveBeenCalledOnce());
    const [place, body, clientId, attachments] = mocked.sendChatMessage.mock.calls[0];
    expect(place).toEqual({ channel: 1 });
    expect(body).toBe("Thanks");
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(attachments).toEqual([]);
  });

  it("shows the agent typing only in the place it is writing in", async () => {
    let announce: (event: { payload: ChatTyping }) => void = () => {};
    mockedEvents.chatTyping.listen.mockImplementation(async (handler) => {
      announce = handler as typeof announce;
      return () => {};
    });
    serve([], [channel(1, "general"), channel(2, "work")]);
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "Channels" })).getByRole("button", { name: /work/ }));
    await waitFor(() => expect(mocked.listChat).toHaveBeenCalledWith({ channel: 2 }, null));
    const until = Math.floor(Date.now() / 1000) + 30;

    act(() => announce({ payload: { place: { channel: 1 }, until } }));
    expect(screen.queryByText("Typing")).not.toBeInTheDocument();
    act(() => announce({ payload: { place: { thread: 9 }, until } }));
    expect(screen.queryByText("Typing")).not.toBeInTheDocument();

    act(() => announce({ payload: { place: { channel: 2 }, until } }));
    expect(await screen.findByText("Typing")).toBeInTheDocument();
  });

  it("starts a new line on Enter from a touch keyboard and leaves sending to the send button", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    onTestFinished(() => {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(document, "execCommand");
    });
    serve([]);
    mocked.sendChatMessage.mockResolvedValue({ status: "ok", data: message(1, "user", "Line one") });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    const input = await screen.findByRole("combobox");
    expect(input).toHaveAttribute("enterkeyhint", "enter");

    fireEvent.input(input, { target: { textContent: "Line one" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(execCommand).toHaveBeenCalledWith("insertLineBreak");
    expect(mocked.sendChatMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocked.sendChatMessage).toHaveBeenCalledOnce());
    expect(mocked.sendChatMessage.mock.calls[0][1]).toBe("Line one");
  });

  it("shows only the server bubble when a message arrives before its send request finishes", async () => {
    const saved = (clientId: string): ChatMessage => ({ ...message(2, "user", "Thanks"), clientId });
    serve([message(1, "user", "Thanks")]);
    mocked.sendChatMessage.mockImplementationOnce(() => new Promise(() => {}));
    const queryClient = renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    const input = await screen.findByRole("combobox");
    fireEvent.input(input, { target: { textContent: "Thanks" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Sending")).toBeInTheDocument();

    const [, , clientId] = mocked.sendChatMessage.mock.calls[0];
    serve([message(1, "user", "Thanks"), saved(clientId)]);
    await act(() => queryClient.invalidateQueries());

    await waitFor(() => expect(screen.getAllByText("Sent")).toHaveLength(2));
    expect(screen.queryByText("Sending")).not.toBeInTheDocument();
    expect(screen.getAllByText("Thanks")).toHaveLength(2);
  });

  it("keeps a message sent while the server is unreachable and sends it once, under its client id, when it answers", async () => {
    serve([]);
    mocked.sendChatMessage.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    const input = await screen.findByRole("combobox");
    fireEvent.input(input, { target: { textContent: "Offline hello" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(/Not sent yet/)).toBeInTheDocument();
    expect(screen.getByText("Offline hello")).toBeInTheDocument();

    mocked.sendChatMessage.mockResolvedValue({ status: "ok", data: message(1, "user", "Offline hello") });
    serve([message(1, "user", "Offline hello")]);
    expect(await flushChatOutbox(async () => {})).toBe(1);

    expect(mocked.sendChatMessage).toHaveBeenCalledTimes(2);
    const [first, second] = mocked.sendChatMessage.mock.calls;
    expect(second[2]).toBe(first[2]);
    await waitFor(() => expect(screen.queryByText(/Not sent yet/)).not.toBeInTheDocument());
  });

  it("chooses one of the agent's actions and shows a chosen one with the others closed", async () => {
    const actions = [
      { key: "approve", label: "Approve", style: "primary" as const },
      { key: "reject", label: "Reject", style: "danger" as const },
    ];
    serve([
      message(1, "agent", "Merge?", { actions }),
      message(2, "agent", "Deploy?", { actions, chosen: { key: "reject", at: 5, choiceId: 3 } }),
      message(3, "user", "Reject", { choiceOf: { messageId: 2, key: "reject" } }),
    ]);
    mocked.chooseChatAction.mockResolvedValue({
      status: "ok",
      data: message(4, "user", "Approve", { choiceOf: { messageId: 1, key: "approve" } }),
    });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    const [open, chosen] = await screen.findAllByRole("group", { name: "Choices" });
    expect(within(chosen).getByRole("button", { name: "Reject" })).toHaveAttribute("aria-pressed", "true");
    expect(within(chosen).getByRole("button", { name: "Approve" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Chose")).toBeInTheDocument();
    fireEvent.click(within(open).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(mocked.chooseChatAction).toHaveBeenCalledOnce());
    const [messageId, key, clientId] = mocked.chooseChatAction.mock.calls[0];
    expect([messageId, key]).toEqual([1, "approve"]);
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("finds earlier messages and opens the thread of the one picked", async () => {
    serve([], undefined, [thread(5, "Deploy")]);
    mocked.searchChat.mockResolvedValue({
      status: "ok",
      data: [{ message: message(9, "agent", "Deployed to staging", { threadId: 5 }), channelName: "general", threadTitle: "Deploy" }],
    });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    fireEvent.click(await screen.findByRole("button", { name: "Search messages" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Search messages" }), { target: { value: "staging" } });
    const results = await screen.findByRole("list", { name: "Search results" });
    expect(mocked.searchChat).toHaveBeenCalledWith("staging", null);
    expect(within(results).getByText("#general / Deploy")).toBeInTheDocument();
    fireEvent.click(within(results).getByRole("button", { name: /Deployed to staging/ }));

    await waitFor(() => expect(mocked.listChat).toHaveBeenCalledWith({ thread: 5 }, null));
    expect(screen.queryByRole("list", { name: "Search results" })).not.toBeInTheDocument();
  });

  it("turns a channel's notifications off from its bell", async () => {
    serve([]);
    mocked.updateChatChannel.mockResolvedValue({ status: "ok", data: channel(1, "general", { push: false }) });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    fireEvent.click(await screen.findByRole("button", { name: "Turn off notifications for #general" }));

    await waitFor(() => expect(mocked.updateChatChannel).toHaveBeenCalledWith(1, { push: false }));
  });

  it("renames a channel and deletes it after asking, but never offers to delete the default room", async () => {
    serve([], [channel(1, "general"), channel(2, "work")]);
    mocked.updateChatChannel.mockResolvedValue({ status: "ok", data: channel(2, "ops") });
    mocked.deleteChatChannel.mockResolvedValue({ status: "ok", data: null });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    expect(await screen.findByRole("button", { name: "Rename #general" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete #general" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New thread" })).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("list", { name: "Channels" })).getByRole("button", { name: /work/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename #work" }));
    const name = screen.getByRole("textbox", { name: "Channel name" });
    expect(name).toHaveValue("work");
    fireEvent.change(name, { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(mocked.updateChatChannel).toHaveBeenCalledWith(2, { name: "ops" }));

    fireEvent.click(await screen.findByRole("button", { name: "Delete #work" }));
    expect(await screen.findByText(/Its threads move to #general/)).toBeInTheDocument();
    expect(mocked.deleteChatChannel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    await waitFor(() => expect(mocked.deleteChatChannel).toHaveBeenCalledWith(2));
  });

  it("lists the channels first and names a task's thread by its task, not its lane", async () => {
    localStorage.setItem("toodo-chat-place", JSON.stringify({ channel: 1, thread: 5 }));
    serve([], undefined, [thread(5, "ap-7-1 lane title", { taskId: 7 })]);
    serveTasks([task(7, "in_progress", ["lane:ap-7-1"])]);
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    const working = await screen.findByRole("list", { name: "In progress" });
    const channels = screen.getByRole("list", { name: "Channels" });
    expect(channels.compareDocumentPosition(working) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "#7 Task 7" })).toBeInTheDocument();
    expect(screen.queryByText(/ap-7-1/)).not.toBeInTheDocument();
  });

  it("lists completed chats beside In progress and opens the one picked", async () => {
    serve([], undefined, [
      thread(5, "ap-7-1 lane title", { taskId: 7, lastMessage: "Merged", lastMessageAt: 20 }),
      thread(6, "Old talk", { status: "closed", closedAt: 10 }),
      thread(8, "Open talk"),
    ]);
    serveTasks([]);
    mocked.listTasks.mockImplementation(async (filter) => ({
      status: "ok",
      data: filter?.ids?.includes(7) ? [{ ...task(7, "done"), title: "Ship" }] : [],
    }));
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    fireEvent.click(await screen.findByRole("button", { name: /^Completed/, expanded: false }));
    const past = await screen.findByRole("list", { name: "Completed" });
    await waitFor(() => expect(within(past).getAllByRole("button").map((b) => b.textContent)).toEqual(["#7 ShipMerged", "Old talkClosed"]));

    fireEvent.click(within(past).getByRole("button", { name: /Old talk/ }));
    await waitFor(() => expect(mocked.listChat).toHaveBeenCalledWith({ thread: 6 }, null));
  });

  it("lists the latest completed chats with the rest behind more, and keeps the section open across starts", async () => {
    serve([], undefined, Array.from({ length: 8 }, (_, i) => thread(10 + i, `Talk ${i}`, { status: "closed", closedAt: i })));
    serveTasks([]);
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    expect(screen.queryByRole("list", { name: "Completed" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /^Completed/, expanded: false }));
    const past = await screen.findByRole("list", { name: "Completed" });
    await waitFor(() => expect(within(past).getAllByRole("listitem")).toHaveLength(5));
    expect(within(past).getAllByRole("listitem")[0]).toHaveTextContent("Talk 7");
    fireEvent.click(screen.getByRole("button", { name: "Show more (3)" }));
    expect(within(past).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.queryByRole("button", { name: /Show more/ })).not.toBeInTheDocument();
    cleanup();

    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    const reopened = await screen.findByRole("list", { name: "Completed" });
    expect(within(reopened).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: /^Completed/, expanded: true }));
    expect(screen.queryByRole("list", { name: "Completed" })).not.toBeInTheDocument();
    expect(localStorage.getItem("toodo-chat-completed-shown")).toBeNull();
  });

  it("closes the shown thread and keeps a closed one from taking messages", async () => {
    localStorage.setItem("toodo-chat-place", JSON.stringify({ channel: 1, thread: 5 }));
    serve([message(3, "agent", "Deployed", { threadId: 5 })], undefined, [thread(5, "Deploy")]);
    mocked.updateChatThread.mockResolvedValue({ status: "ok", data: thread(5, "Deploy", { status: "closed", closedAt: 9 }) });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    // The agent's Markdown loads lazily and replaces its fallback, so the text is looked up again.
    await waitFor(() => expect(screen.getByText("Deployed")).toBeInTheDocument());
    await waitFor(() => expect(mocked.listChat).toHaveBeenCalledWith({ thread: 5 }, null));
    mocked.listChatThreads.mockResolvedValue({
      status: "ok",
      data: [thread(5, "Deploy", { status: "closed", closedAt: 9 })],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(mocked.updateChatThread).toHaveBeenCalledWith(5, { status: "closed" }));
    expect(await screen.findByText("This thread is closed. Reopen it to write in it.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
