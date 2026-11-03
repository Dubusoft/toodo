import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedAppsPanel } from "@/components/connected-apps-panel";
import { commands, type ConnectedApp } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listConnectedApps: vi.fn(),
    revokeConnectedApp: vi.fn(),
  },
}));

const mocked = vi.mocked(commands);

const publicMcpUrl = "https://toodo.example.com/mcp";
const chatgpt: ConnectedApp = {
  grantId: 1,
  clientName: "ChatGPT",
  clientId: "c0ffee",
  scopes: "toodo.read toodo.write",
  createdAt: 1_791_960_000,
  lastUsedAt: 1_791_970_205,
};
const unnamed: ConnectedApp = {
  grantId: 2,
  clientName: null,
  clientId: "https://claude.example.com/oauth/client.json",
  scopes: "toodo.read",
  createdAt: 1_791_965_000,
  lastUsedAt: null,
};

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConnectedAppsPanel />
    </QueryClientProvider>,
  );
}

describe("ConnectedAppsPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocked.listConnectedApps.mockResolvedValue({ status: "ok", data: { publicMcpUrl, apps: [chatgpt, unnamed] } });
  });

  it("shows the public MCP URL and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPanel();

    expect(await screen.findByLabelText("Public MCP URL")).toHaveTextContent(publicMcpUrl);
    fireEvent.click(screen.getByRole("button", { name: "Copy MCP URL" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Copied the MCP URL.");
    expect(writeText).toHaveBeenCalledWith(publicMcpUrl);
  });

  it("names TOODO_PUBLIC_URL when the server is not public and shows that no app is connected", async () => {
    mocked.listConnectedApps.mockResolvedValue({ status: "ok", data: { publicMcpUrl: null, apps: [] } });
    renderPanel();

    expect(await screen.findByText("No apps connected yet.")).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "Connected apps" });
    expect(panel).toHaveTextContent("TOODO_PUBLIC_URL");
    expect(panel).toHaveTextContent("docs/server.md");
    expect(screen.queryByLabelText("Public MCP URL")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy MCP URL" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Apps with access" })).toBeNull();
  });

  it("lists connected apps with their access and last use", async () => {
    renderPanel();

    const list = await screen.findByRole("list", { name: "Apps with access" });
    const named = within(list).getByRole("listitem", { name: "App ChatGPT" });
    expect(named).toHaveTextContent("Read and write access");
    expect(named).toHaveTextContent("Connected");
    expect(named).toHaveTextContent("Last used");
    const byClientId = within(list).getByRole("listitem", { name: `App ${unnamed.clientId}` });
    expect(byClientId).toHaveTextContent("Read access");
    expect(byClientId).toHaveTextContent("Not used yet");
  });

  it("revokes an app only after confirmation and refetches the list", async () => {
    mocked.revokeConnectedApp.mockResolvedValue({ status: "ok", data: null });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke ChatGPT" }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm revoke of ChatGPT" });
    expect(mocked.revokeConnectedApp).not.toHaveBeenCalled();
    mocked.listConnectedApps.mockResolvedValue({ status: "ok", data: { publicMcpUrl, apps: [unnamed] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(screen.queryByRole("listitem", { name: "App ChatGPT" })).toBeNull());
    expect(mocked.revokeConnectedApp).toHaveBeenCalledWith(1);
    expect(screen.getByRole("listitem", { name: `App ${unnamed.clientId}` })).toBeInTheDocument();
  });

  it("keeps an app listed and shows why the server refused to revoke it", async () => {
    mocked.revokeConnectedApp.mockResolvedValue({
      status: "error",
      error: { kind: "notFound", message: "connected app 1 is gone; reopen Settings to see the current apps" },
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke ChatGPT" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" }));

    const app = screen.getByRole("listitem", { name: "App ChatGPT" });
    expect(await within(app).findByRole("alert")).toHaveTextContent("connected app 1 is gone");
    fireEvent.click(within(app).getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
