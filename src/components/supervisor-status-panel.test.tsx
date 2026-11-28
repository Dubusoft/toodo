import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupervisorStatusPanel } from "@/components/supervisor-status-panel";
import type { SupervisorStatusSnapshot } from "@/lib/supervisor-status";

const TOKEN_KEY = "toodo-server-token";

function streamOf(snapshot: SupervisorStatusSnapshot): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const snapshot = (at: number): SupervisorStatusSnapshot => ({
  at,
  status: ["Dori status page 1", "Dori status page 2"],
  quota: { text: "Claude default: 5h 12% · 7d 40%", fetchedAt: at },
  lanes: [
    { key: "ap-1-1", task: 1734, machine: "local", model: "claude-opus", ageMin: 27, progress: "porting the panel", screen: { text: "$ bun test\n 12 pass" } },
    { key: "ap-2-1", task: null, machine: "mac-mini", model: null, ageMin: 3, progress: null, screen: { error: "RUNNER_UNAVAILABLE" } },
  ],
});

/** The host's answer to `GET /api/host` with the supervisor in `state`. */
const host = (state: string) => Response.json({ supervisor: { state, starts: 1, lastHeartbeatAt: null, nextStartAt: null } });

function renderPanel(active: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SupervisorStatusPanel active={active} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SupervisorStatusPanel", () => {
  it("follows the status stream while shown and shows the quota, the lanes with their screens, and /status", async () => {
    localStorage.setItem(TOKEN_KEY, "secret");
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/host") return host("running");
      expect(path).toBe("/api/supervisor/status");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      return streamOf(snapshot(Date.now()));
    });
    vi.stubGlobal("fetch", fetch);
    renderPanel(true);

    expect(await screen.findByText("Claude default: 5h 12% · 7d 40%")).toBeInTheDocument();
    const lane = screen.getByRole("listitem", { name: "Lane ap-1-1" });
    expect(within(lane).getByText("#1734")).toBeInTheDocument();
    expect(within(lane).getByText("porting the panel")).toBeInTheDocument();
    fireEvent.click(within(lane).getByText("Recent screen"));
    expect(within(lane).getByLabelText("Recent screen of ap-1-1")).toHaveTextContent("$ bun test 12 pass");
    expect(within(screen.getByRole("listitem", { name: "Lane ap-2-1" })).getByRole("alert")).toHaveTextContent(
      "The screen could not be read: RUNNER_UNAVAILABLE",
    );
    expect(screen.getByLabelText("Status page 2")).toHaveTextContent("Dori status page 2");
    expect(screen.getByRole("status")).toHaveTextContent(/^Updated \d+ s ago\.$/);
  });

  it("opens no stream while hidden", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderPanel(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("Waiting for the supervisor's first report...")).toBeInTheDocument();
  });

  it("says the supervisor stopped reporting when its snapshot is old", async () => {
    localStorage.setItem(TOKEN_KEY, "secret");
    vi.stubGlobal("fetch", async (path: string) => (path === "/api/host" ? host("running") : streamOf(snapshot(Date.now() - 5 * 60_000))));
    renderPanel(true);
    expect(await screen.findByText(/^The supervisor has not reported for 5 min\./)).toBeInTheDocument();
  });

  it("says Dori is off instead of waiting when the host runs without the supervisor", async () => {
    localStorage.setItem(TOKEN_KEY, "secret");
    // Without a supervisor the stream opens and never sends a snapshot.
    const silent = () => new Response(new ReadableStream<Uint8Array>(), { status: 200, headers: { "content-type": "text/event-stream" } });
    vi.stubGlobal("fetch", async (path: string) => (path === "/api/host" ? host("off") : silent()));
    renderPanel(true);
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Dori is off: .*TOODO_SUPERVISOR=off/);
    expect(screen.queryByText("Waiting for the supervisor's first report...")).not.toBeInTheDocument();
  });
});
