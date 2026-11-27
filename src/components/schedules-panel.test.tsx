import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulesPanel } from "@/components/schedules-panel";
import type { ScheduledJob, ScheduleRequest } from "@/lib/supervisor-schedules";

const TOKEN_KEY = "toodo-server-token";

const digest: ScheduledJob = {
  name: "gmail-digest", kind: "GMAIL_DIGEST", cron: "0 6 * * *", everySec: null, tz: "Asia/Seoul",
  text: null, command: ["sh", "-c", "zele digest"], cwd: null, machine: null, heavy: false, catchUp: "once", paused: false,
  nextRunAt: Date.UTC(2026, 10, 28, 21, 0), lastRunAt: Date.UTC(2026, 10, 27, 21, 0), lastResult: "ok", waiting: null, error: null,
};

const tidy: ScheduledJob = { ...digest, name: "memory-tidy", kind: "MEMORY_TIDY", cron: "0 4 * * *", lastResult: "failed exit 1", error: "memory-tidy exited 1" };

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SchedulesPanel active />
    </QueryClientProvider>,
  );
}

describe("SchedulesPanel", () => {
  it("lists every job with its schedule, next and last run and result, and pauses one", async () => {
    localStorage.setItem(TOKEN_KEY, "secret");
    const posted: ScheduleRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe("/api/supervisor/schedules");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as ScheduleRequest);
        return Response.json({ ok: true, jobs: [{ ...digest, paused: true, nextRunAt: null }, tidy] });
      }
      return Response.json({ ok: true, jobs: [digest, tidy] });
    }));
    renderPanel();

    const row = await screen.findByRole("listitem", { name: "Scheduled job gmail-digest" });
    expect(within(row).getByText("0 6 * * * (Asia/Seoul)")).toBeInTheDocument();
    expect(within(row).getByText("zele digest")).toBeInTheDocument();
    expect(within(row).getByText("ok")).toBeInTheDocument();
    const failing = screen.getByRole("listitem", { name: "Scheduled job memory-tidy" });
    expect(within(failing).getByRole("alert")).toHaveTextContent("memory-tidy exited 1");

    fireEvent.click(within(row).getByRole("button", { name: "Pause gmail-digest" }));
    expect(await within(row).findByRole("button", { name: "Resume gmail-digest" })).toBeInTheDocument();
    expect(within(row).getAllByText("Paused")).toHaveLength(2);
    expect(posted).toEqual([{ op: "pause", name: "gmail-digest" }]);
  });

  it("shows why the supervisor refused a change", async () => {
    localStorage.setItem(TOKEN_KEY, "secret");
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ ok: false, error: 'schedule gmail-digest: cron "0 0 31 2 *" never fires' }, { status: 400 })
        : Response.json({ ok: true, jobs: [digest] })));
    renderPanel();
    const row = await screen.findByRole("listitem", { name: "Scheduled job gmail-digest" });
    fireEvent.click(within(row).getByRole("button", { name: "Edit the schedule of gmail-digest" }));
    const form = within(row).getByRole("form", { name: "Edit the schedule of gmail-digest" });
    fireEvent.change(within(form).getByLabelText(/^Schedule/), { target: { value: "0 0 31 2 *" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("never fires");
  });
});
