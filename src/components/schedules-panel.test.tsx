import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { SchedulesPanel } from "@/components/schedules-panel";
import type { ScheduledJob, ScheduleRequest } from "@/lib/supervisor-schedules";
import { chooseOption } from "@/test/app";

const TOKEN_KEY = "toodo-server-token";
const timeZone = { name: "Asia/Seoul", label: "KST" };

const digest: ScheduledJob = {
  name: "gmail-digest", kind: "GMAIL_DIGEST", description: "Gmail digest posted to #daily-reports", cron: "0 6 * * *", everySec: null, tz: "Asia/Seoul",
  text: null, command: ["sh", "-c", "zele digest"], cwd: null, machine: null, heavy: false, catchUp: "once", paused: false,
  nextRunAt: Date.UTC(2026, 10, 28, 21, 0), lastRunAt: Date.UTC(2026, 10, 27, 21, 0), lastResult: "ok", waiting: null, error: null,
};

const tidy: ScheduledJob = { ...digest, name: "memory-tidy", kind: "MEMORY_TIDY", description: null, cron: "0 4 * * *", lastResult: "failed exit 1", error: "memory-tidy exited 1" };

const office: ScheduledJob = { ...digest, name: "office-poll", kind: "OFFICE_POLL", cron: "*/15 9-18 * * 1-5", lastResult: null, error: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** The server: lists `jobs`; a POST is recorded and answered by `answer`. */
function serve(jobs: readonly ScheduledJob[], answer: (request: ScheduleRequest) => Response = () => Response.json({ ok: true, jobs, timeZone })) {
  localStorage.setItem(TOKEN_KEY, "secret");
  const posted: ScheduleRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    expect(path).toBe("/api/supervisor/schedules");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    if (init?.method !== "POST") return Response.json({ ok: true, jobs, timeZone });
    const request = JSON.parse(String(init.body)) as ScheduleRequest;
    posted.push(request);
    return answer(request);
  }));
  return posted;
}

function renderPanel(language = "ko-KR") {
  localStorage.setItem("toodo-locale", language.startsWith("ko") ? "ko" : "en");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <SchedulesPanel active />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("SchedulesPanel", () => {
  it("lists every job with its schedule as a sentence, its description instead of its command, its next and last run and result, and pauses one", async () => {
    const posted = serve([digest, tidy, office], () => Response.json({ ok: true, jobs: [{ ...digest, paused: true, nextRunAt: null }, tidy, office], timeZone }));
    renderPanel();

    const row = await screen.findByRole("listitem", { name: "예약 작업 gmail-digest" });
    expect(within(row).getByText("매일 오전 6:00 (KST)")).toBeInTheDocument();
    expect(within(row).getByText("Gmail digest posted to #daily-reports")).toBeInTheDocument();
    expect(within(row).queryByText("zele digest")).not.toBeInTheDocument();
    expect(within(row).getByText("ok")).toBeInTheDocument();
    const failing = screen.getByRole("listitem", { name: "예약 작업 memory-tidy" });
    expect(within(failing).getByText("매일 오전 4:00 (KST)")).toBeInTheDocument();
    expect(within(failing).getByText("MEMORY_TIDY")).toBeInTheDocument();
    expect(within(failing).getByRole("alert")).toHaveTextContent("memory-tidy exited 1");
    expect(within(screen.getByRole("listitem", { name: "예약 작업 office-poll" })).getByText("*/15 9-18 * * 1-5 (Asia/Seoul)")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "gmail-digest 일시 중지" }));
    expect(await within(row).findByRole("button", { name: "gmail-digest 재개" })).toBeInTheDocument();
    expect(within(row).getAllByText("일시 중지됨")).toHaveLength(2);
    expect(posted).toEqual([{ op: "pause", name: "gmail-digest" }]);
  });

  it("edits a description and a schedule with the pickers, shows the command, and saves the schedule as cron in the display time zone", async () => {
    const posted = serve([digest]);
    renderPanel();
    const row = await screen.findByRole("listitem", { name: "예약 작업 gmail-digest" });
    fireEvent.click(within(row).getByRole("button", { name: "gmail-digest 편집" }));
    const form = within(row).getByRole("form", { name: "gmail-digest 편집" });
    expect(within(form).queryByLabelText(/cron 식/)).not.toBeInTheDocument();
    expect(within(form).getByText("zele digest")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^설명/), { target: { value: " Weekday Gmail digest " } });
    chooseOption(within(form).getByRole("combobox", { name: "반복" }), "매주");
    fireEvent.click(within(form).getByRole("checkbox", { name: "수" }));
    chooseOption(within(form).getByRole("combobox", { name: "시" }), "오전 9시");
    chooseOption(within(form).getByRole("combobox", { name: "분" }), "30분");
    expect(within(form).getByRole("note")).toHaveTextContent("매주 월·수요일 오전 9:30 (KST)");
    fireEvent.click(within(form).getByRole("button", { name: "저장" }));
    await vi.waitFor(() =>
      expect(posted).toEqual([{ op: "edit", name: "gmail-digest", timing: { cron: "30 9 * * 1,3" }, tz: "Asia/Seoul", description: "Weekday Gmail digest" }]),
    );
  });

  it("edits a cron expression the pickers cannot show under Advanced, and shows why the supervisor refused it", async () => {
    const posted = serve([office], () => Response.json({ ok: false, error: 'schedule office-poll: cron "0 0 31 2 *" never fires' }, { status: 400 }));
    renderPanel("en-US");
    const row = await screen.findByRole("listitem", { name: "Scheduled job office-poll" });
    fireEvent.click(within(row).getByRole("button", { name: "Edit office-poll" }));
    const form = within(row).getByRole("form", { name: "Edit office-poll" });
    expect(within(form).queryByRole("combobox", { name: "Repeats" })).not.toBeInTheDocument();
    const raw = within(form).getByLabelText(/^A cron expression/);
    expect(raw).toHaveValue("*/15 9-18 * * 1-5");
    fireEvent.change(raw, { target: { value: "0 0 31 2 *" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("never fires");
    expect(posted).toEqual([{ op: "edit", name: "office-poll", timing: { cron: "0 0 31 2 *" }, tz: "Asia/Seoul", description: "Gmail digest posted to #daily-reports" }]);
  });
});
