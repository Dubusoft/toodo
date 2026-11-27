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

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SupervisorStatusPanel", () => {
  it("follows the status stream while shown and shows the quota, the lanes with their screens, and /status", async () => {
    localStorage.setItem(TOKEN_KEY, "secret");
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe("/api/supervisor/status");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      return streamOf(snapshot(Date.now()));
    });
    vi.stubGlobal("fetch", fetch);
    render(<SupervisorStatusPanel active />);

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
    render(<SupervisorStatusPanel active={false} />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("Waiting for the supervisor's first report...")).toBeInTheDocument();
  });

  it("says the supervisor stopped reporting when its snapshot is old", async () => {
    localStorage.setItem(TOKEN_KEY, "secret");
    vi.stubGlobal("fetch", async () => streamOf(snapshot(Date.now() - 5 * 60_000)));
    render(<SupervisorStatusPanel active />);
    expect(await screen.findByText(/^The supervisor has not reported for 5 min\./)).toBeInTheDocument();
  });
});
