import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsPanel } from "@/components/runs-panel";
import {
  commands,
  type AgentAdapter,
  type RunEvent,
  type RunLog,
  type RunnerHealth,
  type Task,
  type TaskRun,
} from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listTaskRuns: vi.fn(),
    getRunLog: vi.fn(),
    startPlainRun: vi.fn(),
    stopRun: vi.fn(),
    reconcileRun: vi.fn(),
    runnerHealth: vi.fn(),
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
  labels: [],
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
    lastActivityAt: null,
    usage: null,
  };
}

function event(sequence: number, kind: string, payload: string | null = null): RunEvent {
  return { sequence, kind, payload, observedAt: 1_791_970_000 + sequence };
}

function log(of: TaskRun, events: RunEvent[], stdout = "", stderr = "", attach: string | null = null): RunLog {
  return { run: of, events, stdout, stderr, attach };
}

const launched = (of: TaskRun) => [event(1, "reserved"), event(2, "launched", of.providerRunRef)];

/** The server's message for an agent CLI it did not find, as `runner_health` words it. */
const notFound = (adapter: AgentAdapter) =>
  `${adapter} was not found on the server's PATH; install ${adapter} on the server's PATH, or start the run with ` +
  `the ${adapter === "claude" ? "codex" : "claude"} adapter.`;

/** What the server runs agents with, with the CLIs of `missing` not on its PATH; herdr plays no part. */
function health(missing: AgentAdapter[] = []): RunnerHealth {
  return {
    herdr: { installed: false, running: false, version: null, message: "herdr was not found on the server's PATH." },
    tmux: { installed: true, version: "tmux 3.6", message: null },
    tools: [
      { tool: "git", installed: true, ready: true, version: "git version 2.43.0", message: null },
      { tool: "gh", installed: true, ready: true, version: "gh version 2.83.0", message: null },
      { tool: "ssh", installed: true, ready: true, version: "OpenSSH_9.6p1", message: null },
    ],
    agents: (["claude", "codex"] as const).map((adapter) =>
      missing.includes(adapter)
        ? { adapter, installed: false, path: null, message: notFound(adapter) }
        : { adapter, installed: true, path: `/usr/local/bin/${adapter}`, message: null },
    ),
  };
}

type TodoStep = [text: string, status: "pending" | "in_progress" | "completed"];

/** A todo event with the agent's todo list, in the payload the runner records. */
function todo(sequence: number, steps: TodoStep[]): RunEvent {
  return event(sequence, "todo", JSON.stringify({ items: steps.map(([text, status]) => ({ text, status })) }));
}

function renderPanel(task: Task = inProgress, remote = false) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RunsPanel task={task} remote={remote} />
    </QueryClientProvider>,
  );
}

describe("RunsPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // A live run reloads on an interval; it only ticks when a test moves the clock.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mocked.runnerHealth.mockResolvedValue(ok(health()));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it.each([
    ["working while it wrote output lately", 10, /^Working$/],
    ["idle once it has been quiet for minutes", 600, /^Idle since /],
  ])("shows the agent of a running run %s, with its last output and tokens", async (_, quiet, badge) => {
    const running = {
      ...run(1, "running"),
      lastActivityAt: Math.floor(Date.now() / 1000) - quiet,
      usage: { inputTokens: 12_400, cachedInputTokens: 9_000, outputTokens: 830 },
    };
    mocked.listTaskRuns.mockResolvedValue(ok([running]));
    mocked.getRunLog.mockResolvedValue(ok(log(running, launched(running))));
    renderPanel();

    expect(await screen.findByLabelText("Agent of run 1")).toHaveTextContent(badge);
    expect(screen.getByLabelText("Tokens of run 1")).toHaveTextContent("12,400 in (9,000 cached), 830 out");
    expect(screen.getByText(/^Last output /)).toBeInTheDocument();
  });

  it("shows no working or idle state for an ended run or one without output times", async () => {
    const ended = { ...run(1, "settled"), lastActivityAt: 1_791_970_500 };
    const tmux = { ...run(2, "running"), runnerKind: "tmux" };
    mocked.listTaskRuns.mockResolvedValue(ok([ended, tmux]));
    mocked.getRunLog.mockResolvedValue(ok(log(tmux, launched(tmux))));
    renderPanel();

    await screen.findByRole("list", { name: "Runs of #7" });
    expect(screen.queryByLabelText("Agent of run 1")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agent of run 2")).not.toBeInTheDocument();
  });

  it("shows the command that attaches a terminal to an active tmux run and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const attach = "ssh -t 'devbox' ''\\''tmux'\\'' attach -t '\\''toodo-0123456789ab-run-41'\\'''";
    const running: TaskRun = {
      ...run(1, "running"),
      runnerKind: "tmux",
      requestKey: "tmux-7-1",
      providerRunRef: "tmux:ssh:devbox:toodo-0123456789ab-run-41",
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
      error: { kind: "external", code: "external", message: "ssh devbox: Connection refused; restore SSH connectivity and reconcile again" },
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Reconcile run 1 of #7" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection refused");
    expect(mocked.reconcileRun).toHaveBeenCalledWith(41);
    expect(screen.getByRole("button", { name: "Run 1, Claude, Unknown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconcile run 1 of #7" })).toBeEnabled();
  });

  it("shows the latest todo list of a run with the state of each step", async () => {
    const running = run(1, "running");
    mocked.listTaskRuns.mockResolvedValue(ok([running]));
    mocked.getRunLog.mockResolvedValue(
      ok(
        log(running, [
          ...launched(running),
          todo(3, [
            ["Read the export code", "in_progress"],
            ["Port the CLI", "pending"],
          ]),
          todo(4, [
            ["Read the export code", "completed"],
            ["Port the CLI", "in_progress"],
            ["Add tests for the CLI", "pending"],
          ]),
        ]),
      ),
    );
    renderPanel();

    const list = await screen.findByRole("region", { name: "Todo list of run 1" });
    expect(within(list).getByRole("heading")).toHaveTextContent("Todo list (1 of 3 done)");
    const steps = within(list).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual(["Read the export code", "Port the CLI", "Add tests for the CLI"]);
    expect(steps.map((step) => within(step).getByRole("img").getAttribute("aria-label"))).toEqual([
      "Done",
      "In progress",
      "Pending",
    ]);
  });

  it("sums up each todo list among the events of a run", async () => {
    const running = run(1, "running");
    mocked.listTaskRuns.mockResolvedValue(ok([running]));
    mocked.getRunLog.mockResolvedValue(
      ok(
        log(running, [
          ...launched(running),
          todo(3, [
            ["Read the export code", "in_progress"],
            ["Port the CLI", "pending"],
          ]),
          todo(4, [
            ["Read the export code", "completed"],
            ["Port the CLI", "pending"],
          ]),
          todo(5, [
            ["Read the export code", "completed"],
            ["Port the CLI", "completed"],
          ]),
          todo(6, []),
        ]),
      ),
    );
    renderPanel();

    const events = await screen.findByRole("list", { name: "Events of run 1" });
    const rows = within(events).getAllByRole("listitem").slice(2);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(within(row).getByText("Todo list")).toBeInTheDocument();
    expect(within(rows[0]).getByText("0/2 done; Now: Read the export code")).toBeInTheDocument();
    expect(within(rows[1]).getByText("1/2 done; Next: Port the CLI")).toBeInTheDocument();
    expect(within(rows[2]).getByText("2/2 done; All done")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Empty")).toBeInTheDocument();
    expect(within(events).queryAllByText(/"items"/)).toHaveLength(0);
    // The agent emptied its list last, so no step is left to show.
    const list = screen.getByRole("region", { name: "Todo list of run 1" });
    expect(within(list).queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("shows a todo payload of another shape as it is", async () => {
    const running = run(1, "running");
    const unknownState = '{"items":[{"text":"Port the CLI","status":"blocked"}]}';
    mocked.listTaskRuns.mockResolvedValue(ok([running]));
    mocked.getRunLog.mockResolvedValue(
      ok(log(running, [...launched(running), event(3, "todo", "{not json"), event(4, "todo", unknownState)])),
    );
    renderPanel();

    const events = await screen.findByRole("list", { name: "Events of run 1" });
    expect(within(events).getByText("{not json")).toBeInTheDocument();
    expect(within(events).getByText(unknownState)).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "Todo list of run 1" });
    expect(list).toHaveTextContent(unknownState);
    expect(within(list).queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("tells how a run ended by its last event other than a todo list", async () => {
    const stopped = run(1, "cancelled");
    mocked.listTaskRuns.mockResolvedValue(ok([stopped]));
    mocked.getRunLog.mockResolvedValue(
      ok(
        log(stopped, [
          ...launched(stopped),
          todo(3, [["Port the CLI", "in_progress"]]),
          event(4, "stop_requested", "the run was stopped"),
          // The agent can still change its list until it exits.
          todo(5, [["Port the CLI", "completed"]]),
          event(6, "cancelled"),
        ]),
      ),
    );
    renderPanel();

    const last = await screen.findByRole("note", { name: "Last event of run 1" });
    expect(last).toHaveTextContent("Stop requested");
    expect(last).toHaveTextContent("the run was stopped");
    expect(last).not.toHaveTextContent("Todo list");
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

  it("follows a live run's log every few seconds and stops reloading once no run is live", async () => {
    const running = run(1, "running");
    const settled = run(1, "settled");
    let listed = [running];
    let logged = log(running, launched(running), "first line\n");
    mocked.listTaskRuns.mockImplementation(async () => ok(listed));
    mocked.getRunLog.mockImplementation(async () => ok(logged));
    renderPanel();

    expect(await screen.findByLabelText("stdout of run 1")).toHaveTextContent("first line");
    expect(mocked.listTaskRuns).toHaveBeenCalledTimes(1);
    expect(mocked.getRunLog).toHaveBeenCalledTimes(1);

    logged = log(running, launched(running), "first line\nsecond line\n");
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(screen.getByLabelText("stdout of run 1")).toHaveTextContent("second line"));
    expect(mocked.listTaskRuns).toHaveBeenCalledTimes(2);
    expect(mocked.getRunLog).toHaveBeenCalledTimes(2);

    listed = [settled];
    logged = log(settled, [...launched(running), event(3, "result", "Ported the export CLI"), event(4, "settled")]);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await screen.findByRole("button", { name: "Run 1, Claude, Succeeded" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("note", { name: "Last event of run 1" })).toHaveTextContent("Ported the export CLI"),
    );
    const reloads = [mocked.listTaskRuns.mock.calls.length, mocked.getRunLog.mock.calls.length];

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect([mocked.listTaskRuns.mock.calls.length, mocked.getRunLog.mock.calls.length]).toEqual(reloads);
  });

  it("rules out an agent whose CLI the server did not find, with its message, and starts the other", async () => {
    const started = run(1, "running", "codex");
    mocked.runnerHealth.mockResolvedValue(ok(health(["claude"])));
    mocked.listTaskRuns.mockResolvedValueOnce(ok([])).mockResolvedValue(ok([started]));
    mocked.startPlainRun.mockResolvedValue(ok(started));
    mocked.getRunLog.mockResolvedValue(ok(log(started, launched(started))));
    renderPanel();

    expect(await screen.findByRole("note", { name: "Why Claude is unavailable" })).toHaveTextContent(notFound("claude"));
    const form = screen.getByRole("form", { name: "New run of #7" });
    const claude = within(form).getByRole("button", { name: "Claude" });
    expect(claude).toBeDisabled();
    expect(claude).toHaveAttribute("title", notFound("claude"));
    // The default agent gives way to the one the server has.
    expect(within(form).getByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true");
    expect(within(form).getByRole("button", { name: "Codex" })).toBeEnabled();
    fireEvent.click(within(form).getByRole("button", { name: "Start run of #7" }));

    await waitFor(() => expect(mocked.startPlainRun).toHaveBeenCalledWith(7, "codex", null, true));
    expect(await screen.findByRole("button", { name: "Run 1, Codex, Running" })).toBeInTheDocument();
  });

  it("offers both agents on an SSH machine even when the server lacks their CLIs", async () => {
    const started = run(1, "running", "claude");
    mocked.runnerHealth.mockResolvedValue(ok(health(["claude", "codex"])));
    mocked.listTaskRuns.mockResolvedValueOnce(ok([])).mockResolvedValue(ok([started]));
    mocked.startPlainRun.mockResolvedValue(ok(started));
    mocked.getRunLog.mockResolvedValue(ok(log(started, launched(started))));
    renderPanel(inProgress, true);

    const form = await screen.findByRole("form", { name: "New run of #7" });
    await waitFor(() => expect(mocked.runnerHealth).toHaveBeenCalled());
    expect(within(form).getByRole("button", { name: "Claude" })).toBeEnabled();
    expect(within(form).getByRole("button", { name: "Codex" })).toBeEnabled();
    expect(screen.queryByRole("note", { name: "Why Claude is unavailable" })).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Start run of #7" }));

    await waitFor(() => expect(mocked.startPlainRun).toHaveBeenCalledWith(7, "claude", null, true));
  });

  it("keeps Start run disabled while neither agent CLI is on the server, until Refresh finds one", async () => {
    mocked.runnerHealth.mockResolvedValueOnce(ok(health(["claude", "codex"]))).mockResolvedValue(ok(health(["claude"])));
    mocked.listTaskRuns.mockResolvedValue(ok([]));
    renderPanel();

    expect(await screen.findByRole("note", { name: "Why no run of #7 starts" })).toHaveTextContent(
      "Neither claude nor codex was found on the server's PATH; install one of them there, then press Refresh",
    );
    const form = screen.getByRole("form", { name: "New run of #7" });
    for (const [name, adapter] of [
      ["Claude", "claude"],
      ["Codex", "codex"],
    ] as const) {
      const button = within(form).getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-pressed", "false");
      expect(button).toHaveAttribute("title", notFound(adapter));
    }
    expect(within(form).getByRole("button", { name: "Start run of #7" })).toBeDisabled();
    expect(screen.queryByRole("note", { name: /^Why (Claude|Codex) is unavailable$/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh runs of #7" }));

    await waitFor(() => expect(within(form).getByRole("button", { name: "Start run of #7" })).toBeEnabled());
    expect(within(form).getByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("note", { name: "Why no run of #7 starts" })).not.toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Why Claude is unavailable" })).toHaveTextContent(notFound("claude"));
    expect(mocked.runnerHealth).toHaveBeenCalledTimes(2);
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
