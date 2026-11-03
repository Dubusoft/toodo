import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunsPanel } from "@/components/runs-panel";
import { commands, type RunEvent, type RunLog, type Task, type TaskRun } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listTaskRuns: vi.fn(),
    getRunLog: vi.fn(),
    startPlainRun: vi.fn(),
    stopRun: vi.fn(),
    reconcileRun: vi.fn(),
  },
}));

const mocked = vi.mocked(commands);

function ok<T>(data: T) {
  return { status: "ok" as const, data };
}

const inProgress: Task = {
  id: 7,
  workspaceId: 1,
  taskType: "feat",
  title: "Port the export CLI",
  description: "",
  status: "in_progress",
  resolution: null,
  dependsOn: [],
  branch: "feat/port-the-export-cli-7",
  worktreePath: "/srv/worktrees/port-the-export-cli-7",
  worktreeMissing: false,
  herdrWorkspaceId: null,
  pullRequestUrl: null,
  issue: null,
  estimate: null,
  dueDate: null,
  pullRequestMergedAt: null,
  pullRequest: null,
  mergedWith: null,
  completionNote: null,
  timeline: [],
  milestones: {
    plannedAt: null,
    startedAt: null,
    reviewAt: null,
    completedAt: null,
    reopenedAt: null,
    pausedAt: null,
    lastReviewAt: null,
    activeSeconds: 0,
    pauseCount: 0,
  },
  notes: [],
  criteria: [],
};

function run(generation: number, state: TaskRun["state"], adapter = "claude"): TaskRun {
  return {
    id: 40 + generation,
    taskId: 7,
    requestKey: `plain-7-${generation}`,
    generation,
    runnerKind: "plain",
    role: "writer",
    adapter,
    checkoutPath: "/srv/worktrees/port-the-export-cli-7",
    state,
    providerRunRef: `pid:${4000 + generation}`,
    createdAt: 1_791_970_000,
    startedAt: 1_791_970_001,
    endedAt: state === "reserved" || state === "running" ? null : 1_791_970_600,
  };
}

function event(sequence: number, kind: string, payload: string | null = null): RunEvent {
  return { sequence, kind, payload, observedAt: 1_791_970_000 + sequence };
}

function log(of: TaskRun, events: RunEvent[], stdout = "", stderr = "", attach: string | null = null): RunLog {
  return { run: of, events, stdout, stderr, attach };
}

const launched = (of: TaskRun) => [event(1, "reserved"), event(2, "launched", of.providerRunRef)];

function renderPanel(task: Task = inProgress) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RunsPanel task={task} />
    </QueryClientProvider>,
  );
}

describe("RunsPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("starts a run with the picked agent and MCP setting and opens it", async () => {
    const started = run(1, "running", "codex");
    mocked.listTaskRuns.mockResolvedValueOnce(ok([])).mockResolvedValue(ok([started]));
    mocked.startPlainRun.mockResolvedValue(ok(started));
    mocked.getRunLog.mockResolvedValue(ok(log(started, launched(started))));
    renderPanel();

    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "New run of #7" });
    expect(within(form).getByRole("button", { name: "Claude" })).toHaveAttribute("aria-pressed", "true");
    expect(within(form).getByRole("checkbox", { name: "Toodo MCP" })).toBeChecked();
    fireEvent.click(within(form).getByRole("button", { name: "Codex" }));
    fireEvent.click(within(form).getByRole("checkbox", { name: "Toodo MCP" }));
    fireEvent.click(within(form).getByRole("button", { name: "Start run of #7" }));

    await waitFor(() => expect(mocked.startPlainRun).toHaveBeenCalledWith(7, "codex", null, false));
    expect(await screen.findByRole("button", { name: "Run 1, Codex, Running" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await waitFor(() => expect(mocked.getRunLog).toHaveBeenCalledWith(41, null));
    // The new run holds the worktree, so no second run starts until it ends.
    expect(within(form).getByRole("button", { name: "Start run of #7" })).toBeDisabled();
  });

  it("stops a running run only once the stop is confirmed", async () => {
    const running = run(1, "running");
    const stopped: TaskRun = { ...running, state: "cancelled", endedAt: 1_791_970_900 };
    mocked.listTaskRuns.mockResolvedValueOnce(ok([running])).mockResolvedValue(ok([stopped]));
    mocked.getRunLog
      .mockResolvedValueOnce(ok(log(running, launched(running))))
      .mockResolvedValue(
        ok(log(stopped, [...launched(running), event(3, "stop_requested", "the run was stopped"), event(4, "cancelled")])),
      );
    mocked.stopRun.mockResolvedValue(ok(stopped));
    renderPanel();

    await screen.findByRole("button", { name: "Run 1, Claude, Running" });
    expect(screen.getByRole("button", { name: "Start run of #7" })).toBeDisabled();
    expect(screen.getByRole("note", { name: "Why no run of #7 starts" })).toHaveTextContent("Run 1 is still running");
    fireEvent.click(screen.getByRole("button", { name: "Stop run 1 of #7" }));
    const confirmation = screen.getByRole("group", { name: "Stop run 1 of #7?" });
    expect(mocked.stopRun).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm stop run 1 of #7" }));

    await waitFor(() => expect(mocked.stopRun).toHaveBeenCalledWith(41));
    expect(await screen.findByRole("button", { name: "Run 1, Claude, Stopped" })).toBeInTheDocument();
    expect(await screen.findByRole("note", { name: "Last event of run 1" })).toHaveTextContent("Stop requested");
    expect(screen.queryByRole("button", { name: "Stop run 1 of #7" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start run of #7" })).toBeEnabled();
  });

  it("shows the last event of a failed run with its events and the ends of its output", async () => {
    const settled = run(1, "settled");
    const failed = run(2, "failed", "codex");
    mocked.listTaskRuns.mockResolvedValue(ok([settled, failed]));
    mocked.getRunLog.mockResolvedValue(
      ok(
        log(
          failed,
          [...launched(failed), event(3, "result_error", "stream disconnected: rate limit reached"), event(4, "failed")],
          '{"type":"thread.started","thread_id":"th_1"}\n',
          "warning: retrying (1/3)\n",
        ),
      ),
    );
    renderPanel();

    const runs = await screen.findByRole("list", { name: "Runs of #7" });
    // Newest first, and the newest is open.
    const toggles = within(runs).getAllByRole("button", { name: /^Run \d/ });
    expect(toggles.map((toggle) => toggle.getAttribute("aria-label"))).toEqual([
      "Run 2, Codex, Failed",
      "Run 1, Claude, Succeeded",
    ]);
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    const last = await screen.findByRole("note", { name: "Last event of run 2" });
    expect(last).toHaveTextContent("Agent error");
    expect(last).toHaveTextContent("stream disconnected: rate limit reached");
    expect(within(screen.getByRole("list", { name: "Events of run 2" })).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByLabelText("stdout of run 2")).toHaveTextContent('{"type":"thread.started","thread_id":"th_1"}');
    expect(screen.getByLabelText("stderr of run 2")).toHaveTextContent("warning: retrying (1/3)");
    expect(mocked.getRunLog).toHaveBeenCalledWith(42, null);
    expect(screen.queryByRole("button", { name: /^Stop run/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Attach in a terminal" })).not.toBeInTheDocument();
  });

  it("shows the command that attaches a terminal to an active tmux run and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const attach = "ssh -t 'devbox' ''\\''tmux'\\'' attach -t '\\''toodo-run-41'\\'''";
    const running: TaskRun = {
      ...run(1, "running"),
      runnerKind: "tmux",
      requestKey: "tmux-7-1",
      providerRunRef: "tmux:ssh:devbox:toodo-run-41",
    };
    mocked.listTaskRuns.mockResolvedValue(ok([running]));
    mocked.getRunLog.mockResolvedValue(ok(log(running, launched(running), "", "", attach)));
    renderPanel();

    const section = await screen.findByRole("region", { name: "Attach in a terminal" });
    expect(within(section).getByLabelText("Attach command of run 1").textContent).toBe(attach);
    fireEvent.click(within(section).getByRole("button", { name: "Copy the attach command of run 1" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(attach));
    expect(await within(section).findByRole("status")).toHaveTextContent("Copied");
    // A run that is observed needs no reconcile.
    expect(screen.queryByRole("button", { name: "Reconcile run 1 of #7" })).not.toBeInTheDocument();
  });

  it("reconciles a run whose end was not seen, which frees the worktree once it has ended", async () => {
    const unknown = run(1, "unknown");
    const exited: TaskRun = { ...unknown, state: "exited", endedAt: 1_791_970_900 };
    const lost = [...launched(unknown), event(3, "observation_lost", "restore SSH connectivity and reconcile the run")];
    mocked.listTaskRuns.mockResolvedValueOnce(ok([unknown])).mockResolvedValue(ok([exited]));
    mocked.getRunLog
      .mockResolvedValueOnce(ok(log(unknown, [...lost, event(4, "unknown")])))
      .mockResolvedValue(ok(log(exited, [...lost, event(4, "unknown"), event(5, "exit", "exit code 0"), event(6, "exited")])));
    mocked.reconcileRun.mockResolvedValue(ok(exited));
    renderPanel();

    await screen.findByRole("button", { name: "Run 1, Claude, Unknown" });
    expect(screen.getByRole("button", { name: "Start run of #7" })).toBeDisabled();
    expect(screen.getByRole("note", { name: "Why no run of #7 starts" })).toHaveTextContent("reconcile it");
    expect(await screen.findByRole("note", { name: "Last event of run 1" })).toHaveTextContent("Observation lost");
    fireEvent.click(screen.getByRole("button", { name: "Reconcile run 1 of #7" }));

    await waitFor(() => expect(mocked.reconcileRun).toHaveBeenCalledWith(41));
    expect(await screen.findByRole("button", { name: "Run 1, Claude, Exited" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("note", { name: "Last event of run 1" })).toHaveTextContent("exit code 0"));
    expect(screen.queryByRole("button", { name: "Reconcile run 1 of #7" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start run of #7" })).toBeEnabled();
  });

  it("keeps a run unknown and shows why when its host cannot be reached", async () => {
    const unknown = run(1, "unknown");
    mocked.listTaskRuns.mockResolvedValue(ok([unknown]));
    mocked.getRunLog.mockResolvedValue(
      ok(log(unknown, [...launched(unknown), event(3, "server_restarted"), event(4, "unknown")])),
    );
    mocked.reconcileRun.mockResolvedValue({
      status: "error",
      error: { kind: "external", message: "ssh devbox: Connection refused; restore SSH connectivity and reconcile again" },
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Reconcile run 1 of #7" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection refused");
    expect(mocked.reconcileRun).toHaveBeenCalledWith(41);
    expect(screen.getByRole("button", { name: "Run 1, Claude, Unknown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconcile run 1 of #7" })).toBeEnabled();
  });

  it("reloads the runs and the open log on Refresh", async () => {
    const running = run(1, "running");
    mocked.listTaskRuns.mockResolvedValue(ok([running]));
    mocked.getRunLog
      .mockResolvedValueOnce(ok(log(running, launched(running), "first line\n")))
      .mockResolvedValue(ok(log(running, launched(running), "first line\nsecond line\n")));
    renderPanel();

    expect(await screen.findByLabelText("stdout of run 1")).toHaveTextContent("first line");
    fireEvent.click(screen.getByRole("button", { name: "Refresh runs of #7" }));

    await waitFor(() => expect(screen.getByLabelText("stdout of run 1")).toHaveTextContent("second line"));
    expect(mocked.listTaskRuns).toHaveBeenCalledTimes(2);
    expect(mocked.getRunLog).toHaveBeenCalledTimes(2);
  });

  it("lists the runs of a task in review without offering a new one", async () => {
    const settled = run(1, "settled");
    mocked.listTaskRuns.mockResolvedValue(ok([settled]));
    mocked.getRunLog.mockResolvedValue(ok(log(settled, launched(settled))));
    renderPanel({ ...inProgress, status: "in_review" });

    expect(await screen.findByRole("button", { name: "Run 1, Claude, Succeeded" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "New run of #7" })).not.toBeInTheDocument();
  });

  it("shows nothing for a task out of progress that never ran", async () => {
    mocked.listTaskRuns.mockResolvedValue(ok([]));
    renderPanel({ ...inProgress, status: "in_review" });

    // It shows while it loads the runs and goes once there are none.
    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Runs" })).not.toBeInTheDocument());
    expect(mocked.listTaskRuns).toHaveBeenCalledWith(7);
  });
});
