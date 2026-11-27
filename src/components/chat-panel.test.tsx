import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, receipt, unreadCount } from "@/components/chat-panel";
import { commands, events, type ChatMessage } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: { listChat: vi.fn(), sendChatMessage: vi.fn() },
  events: { chatTyping: { listen: vi.fn() } },
}));

const mocked = vi.mocked(commands);
const mockedEvents = vi.mocked(events, { deep: true });

function message(id: number, author: ChatMessage["author"], body: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    author,
    body,
    at: 1700000000 + id,
    deliveredAt: null,
    ackedAt: null,
    handledAt: null,
    handledReplyId: null,
    handledTaskId: null,
    overdue: false,
    ...overrides,
  };
}

function serve(messages: ChatMessage[]) {
  mocked.listChat.mockResolvedValue({
    status: "ok",
    data: { agent: { name: "Helper", avatarUrl: null }, messages, hasEarlier: false, typingUntil: null },
  });
}

function OpenableChat() {
  const [open, setOpen] = useState(false);
  return <Chat open={open} onOpenChange={setOpen} />;
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
  it("count the agent's and Toodo's messages after the last one shown, none before any was", () => {
    const messages = [message(1, "agent", "a"), message(2, "user", "b"), message(3, "system", "c")];
    expect(unreadCount(messages, null)).toBe(0);
    expect(unreadCount(messages, 1)).toBe(1);
    expect(unreadCount(messages, 0)).toBe(2);
  });
});

describe("Chat", () => {
  it("badges unread replies on the floating button and clears them once opened", async () => {
    localStorage.setItem("toodo-chat-read", "1");
    serve([message(1, "agent", "Earlier"), message(2, "agent", "New reply")]);
    renderChat();

    fireEvent.click(await screen.findByRole("button", { name: "Open chat, 1 unread" }));

    expect(await screen.findByRole("dialog", { name: "Chat with Helper" })).toBeInTheDocument();
    expect(await screen.findByText("New reply")).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("toodo-chat-read")).toBe("2"));
  });

  it("sends a message under a client id and shows the receipts of earlier ones", async () => {
    serve([message(1, "user", "Ship it?", { deliveredAt: 2, ackedAt: 3, handledAt: 4 })]);
    mocked.sendChatMessage.mockResolvedValue({ status: "ok", data: message(2, "user", "Thanks") });
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    expect(await screen.findByText("Handled")).toBeInTheDocument();
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { textContent: "Thanks" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mocked.sendChatMessage).toHaveBeenCalledOnce());
    const [body, clientId] = mocked.sendChatMessage.mock.calls[0];
    expect(body).toBe("Thanks");
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
