import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoriPanel, highestUsage } from "@/components/dori-panel";
import type { DoriConfigView } from "@/lib/dori-config";
import type { SupervisorStatusSnapshot } from "@/lib/supervisor-status";

const TOKEN_KEY = "toodo-server-token";

const config: DoriConfigView = { path: "/home/a/.dori/config.json", present: true, error: null, entries: [] };

const snapshot = (at: number): SupervisorStatusSnapshot => ({
  at,
  status: ["Dori status page 1"],
  quota: { text: "Claude default: 5h 12% · 7d 40%", fetchedAt: at },
  lanes: [{ key: "ap-1-1", task: 1734, machine: "local", model: null, ageMin: 27, progress: "porting the panel", screen: null }],
});

function stream(snapshots: SupervisorStatusSnapshot[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const s of snapshots) controller.enqueue(new TextEncoder().encode(`event: status\ndata: ${JSON.stringify(s)}\n\n`));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Answers the Dori section's requests: the host's supervisor in `state`, and `snapshots` on the status stream. */
function serve(state: string, snapshots: SupervisorStatusSnapshot[]) {
  vi.stubGlobal("fetch", async (path: string) => {
    if (path === "/api/host") return Response.json({ supervisor: { state, starts: 1, lastHeartbeatAt: null, nextStartAt: null } });
    if (path === "/api/supervisor/status") return stream(snapshots);
    if (path === "/api/dori/config") return Response.json(config);
    return Response.json({ ok: true, jobs: [], timeZone: { name: "Asia/Seoul", label: "KST" } });
  });
}

function renderPanel() {
  localStorage.setItem(TOKEN_KEY, "secret");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DoriPanel active />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("DoriPanel", () => {
  it("sums up a working Dori: its highest usage and its lanes", async () => {
    serve("running", [snapshot(Date.now())]);
    renderPanel();

    expect(await screen.findByText("Working normally")).toBeInTheDocument();
    expect(screen.getByText("Usage up to 40% · 1 lane working")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Lane ap-1-1" })).toHaveTextContent("porting the panel");
  });

  it("says plainly that Dori is off instead of checking on it", async () => {
    serve("off", []);
    renderPanel();

    expect(await screen.findByText("Dori is turned off on this server")).toBeInTheDocument();
    expect(screen.queryByText("Checking on Dori...")).not.toBeInTheDocument();
    expect(await screen.findByText("The scheduled jobs show once Dori is running.")).toBeInTheDocument();
  });
});

describe("highestUsage", () => {
  it("takes the highest percentage the quota names", () => {
    expect(highestUsage({ text: "Claude default: 5h 12% · 7d 40.4%", fetchedAt: null })).toBe(40);
    expect(highestUsage({ text: "no usage read yet", fetchedAt: null })).toBeNull();
    expect(highestUsage({ error: "quota lookup failed" })).toBeNull();
    expect(highestUsage(null)).toBeNull();
  });
});
