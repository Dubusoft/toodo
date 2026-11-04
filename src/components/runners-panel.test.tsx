import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunnersPanel } from "@/components/runners-panel";
import { commands, type RunnerHealth } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    runnerHealth: vi.fn(),
  },
}));

const mocked = vi.mocked(commands);

function ok<T>(data: T) {
  return { status: "ok" as const, data };
}

const ready: RunnerHealth = {
  herdr: { installed: true, running: true, version: "0.9.5", message: null },
  tmux: { installed: true, version: "tmux 3.6", message: null },
  tools: [
    { tool: "git", installed: true, ready: true, version: "git version 2.43.0", message: null },
    { tool: "gh", installed: true, ready: true, version: "gh version 2.83.0", message: null },
    { tool: "ssh", installed: true, ready: true, version: "OpenSSH_9.6p1", message: null },
  ],
  agents: [
    { adapter: "claude", installed: true, path: "/usr/local/bin/claude", message: null },
    { adapter: "codex", installed: true, path: "/home/me/.local/bin/codex", message: null },
  ],
};

const herdrMissing =
  "herdr was not found on the server's PATH (No such file or directory (os error 2)); install herdr and start it " +
  "for herdr workspaces, or set the workspace runner to plain to run claude or codex without herdr.";
const herdrStopped =
  "The herdr server is not running; start herdr on the server for herdr workspaces, or set the workspace runner " +
  "to plain to run claude or codex without herdr.";
const codexMissing =
  "codex was not found on the server's PATH; install codex on the server's PATH, or start the run with the claude adapter.";

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RunnersPanel />
    </QueryClientProvider>,
  );
}

const row = (name: string) => screen.getByRole("listitem", { name });

describe("RunnersPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("shows herdr and tmux with their versions and each agent CLI with its path once they are ready", async () => {
    mocked.runnerHealth.mockResolvedValue(ok(ready));
    renderPanel();

    const runners = await screen.findByRole("list", { name: "Runners on this server" });
    expect(within(runners).getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))).toEqual([
      "herdr",
      "tmux",
      "Claude",
      "Codex",
      "git",
      "gh",
      "ssh",
    ]);
    expect(within(row("git")).getByText("Ready")).toBeInTheDocument();
    expect(row("git")).toHaveTextContent("git version 2.43.0");
    expect(within(row("herdr")).getByText("Running")).toBeInTheDocument();
    expect(row("herdr")).toHaveTextContent("v0.9.5");
    expect(within(row("tmux")).getByText("Installed")).toBeInTheDocument();
    expect(row("tmux")).toHaveTextContent("tmux 3.6");
    expect(within(row("Claude")).getByText("Installed")).toBeInTheDocument();
    expect(row("Claude")).toHaveTextContent("/usr/local/bin/claude");
    expect(within(row("Codex")).getByText("Installed")).toBeInTheDocument();
    expect(row("Codex")).toHaveTextContent("/home/me/.local/bin/codex");
    expect(screen.getByRole("region", { name: "Runners" })).toHaveTextContent("Runner plain works without herdr.");
  });

  it("shows gh as not logged in with the step to log in", async () => {
    const loggedOut = "gh is not logged in: run `gh auth login` as the user that runs toodo-server, then retry.";
    mocked.runnerHealth.mockResolvedValue(
      ok({
        ...ready,
        tools: ready.tools.map((tool) => (tool.tool === "gh" ? { ...tool, ready: false, message: loggedOut } : tool)),
      }),
    );
    renderPanel();

    await screen.findByRole("list", { name: "Runners on this server" });
    expect(within(row("gh")).getByText("Not logged in")).toBeInTheDocument();
    expect(row("gh")).toHaveTextContent(loggedOut);
  });

  it("shows the server's next step for each runner that is not ready", async () => {
    mocked.runnerHealth.mockResolvedValue(
      ok({
        herdr: { installed: false, running: false, version: null, message: herdrMissing },
        tmux: { installed: true, version: "tmux 3.6", message: null },
        tools: [
          { tool: "git", installed: true, ready: true, version: "git version 2.43.0", message: null },
          { tool: "gh", installed: true, ready: true, version: "gh version 2.83.0", message: null },
          { tool: "ssh", installed: true, ready: true, version: "OpenSSH_9.6p1", message: null },
        ],
        agents: [ready.agents[0], { adapter: "codex", installed: false, path: null, message: codexMissing }],
      }),
    );
    renderPanel();

    const herdr = await screen.findByRole("listitem", { name: "herdr" });
    expect(within(herdr).getByText("Not installed")).toBeInTheDocument();
    expect(herdr).toHaveTextContent(herdrMissing);
    expect(within(row("Claude")).getByText("Installed")).toBeInTheDocument();
    expect(row("Claude")).not.toHaveTextContent("was not found");
    expect(within(row("Codex")).getByText("Not installed")).toBeInTheDocument();
    expect(row("Codex")).toHaveTextContent(codexMissing);
  });

  it("tells a stopped herdr from a missing one and checks again on Refresh", async () => {
    mocked.runnerHealth
      .mockResolvedValueOnce(ok({ ...ready, herdr: { installed: true, running: false, version: "0.9.5", message: herdrStopped } }))
      .mockResolvedValue(ok(ready));
    renderPanel();

    const herdr = await screen.findByRole("listitem", { name: "herdr" });
    expect(within(herdr).getByText("Not running")).toBeInTheDocument();
    expect(herdr).toHaveTextContent("v0.9.5");
    expect(herdr).toHaveTextContent(herdrStopped);
    fireEvent.click(screen.getByRole("button", { name: "Refresh runners" }));

    await waitFor(() => expect(within(row("herdr")).getByText("Running")).toBeInTheDocument());
    expect(row("herdr")).not.toHaveTextContent(herdrStopped);
    expect(mocked.runnerHealth).toHaveBeenCalledTimes(2);
  });

  it("says why the runners could not be checked and how to check again", async () => {
    mocked.runnerHealth.mockResolvedValue({
      status: "error",
      error: { kind: "internal", code: "internal", message: "the server could not read its PATH" },
    });
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Failed to check the runners: the server could not read its PATH. Press Refresh to check again.",
    );
    expect(screen.queryByRole("list", { name: "Runners on this server" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh runners" })).toBeEnabled();
  });
});
