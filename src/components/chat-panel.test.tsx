import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, receipt, totalUnread } from "@/components/chat-panel";
import { commands, events, type ChatChannel, type ChatMessage, type ChatThread } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listChat: vi.fn(),
    sendChatMessage: vi.fn(),
    markChatRead: vi.fn(),
    listChatChannels: vi.fn(),
    listChatThreads: vi.fn(),
    createChatChannel: vi.fn(),
    updateChatChannel: vi.fn(),
    createChatThread: vi.fn(),
    updateChatThread: vi.fn(),
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
    unread: 0,
    lastMessageAt: null,
    ...overrides,
  };
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
}

beforeEach(() => {
  localStorage.clear();
  mockedEvents.chatTyping.listen.mockResolvedValue(() => {});
  mocked.markChatRead.mockResolvedValue({ status: "ok", data: null });
});

describe("receipts", () => {
  it("go from sent to delivered to read, with a note once handled or overdue", () => {
    expect(receipt(message(1, "user", "Hi"))).toEqual({ status: "sent", note: null });
    expect(receipt(message(1, "user", "Hi", { deliveredAt: 2 })).status).toBe("delivered");
    expect(receipt(message(1, "user", "Hi", { deliveredAt: 2, ackedAt: 3 })).status).toBe("read");
    expect(receipt(message(1, "user", "Hi", { overdue: true })).note).toBe("Waiting for an answer");
    expect(receipt(message(1, "user", "Hi", { deliveredAt: 2, ackedAt: 3, handledAt: 4, handledTaskId: 9 }))).toEqual({
      status: "read",
      note: "Handled in task #9",
    });
  });
});

describe("unread messages", () => {
  it("add up over every channel", () => {
    expect(totalUnread([channel(1, "general", { unread: 2 }), channel(2, "work", { unread: 3 })])).toBe(5);
    expect(totalUnread([])).toBe(0);
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

  it("sends a message to the shown channel under a client id", async () => {
    serve([message(1, "user", "Ship it?", { deliveredAt: 2, ackedAt: 3, handledAt: 4 })]);
    mocked.sendChatMessage.mockResolvedValue({ status: "ok", data: message(2, "user", "Thanks") });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    expect(await screen.findByText("Handled")).toBeInTheDocument();
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Thanks" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mocked.sendChatMessage).toHaveBeenCalledOnce());
    const [place, body, clientId] = mocked.sendChatMessage.mock.calls[0];
    expect(place).toEqual({ channel: 1 });
    expect(body).toBe("Thanks");
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("turns a channel's notifications off from its bell", async () => {
    serve([]);
    mocked.updateChatChannel.mockResolvedValue({ status: "ok", data: channel(1, "general", { push: false }) });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    fireEvent.click(await screen.findByRole("button", { name: "Turn off notifications for #general" }));

    await waitFor(() => expect(mocked.updateChatChannel).toHaveBeenCalledWith(1, { push: false }));
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
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
