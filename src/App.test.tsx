import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi, onTestFinished } from "vitest";
import App from "@/App";
import { formatFull, formatWhen } from "@/lib/timeline";
import { periodBounds, periodContaining, weekStarting } from "@/lib/review";
import { isPermissionGranted, sendNotification } from "@/web/notification";
import {
  commands,
  events,
  type CommitRecord,
  type Criterion,
  type HerdrMachine,
  type Task,
  type TaskAgentStatus,
  type Workspace,
} from "@/lib/bindings";

vi.mock("@/web/notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@/lib/bindings", () => ({
  commands: {
    appInfo: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    moveWorkspace: vi.fn(),
    listWorkspaceBranches: vi.fn(),
    createWorkspaceBaseBranch: vi.fn(),
    deleteWorkspace: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    pauseTask: vi.fn(),
    setCompletionNote: vi.fn(),
    checkCriterion: vi.fn(),
    deleteTask: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    listTaskRelations: vi.fn(),
    addTaskRelation: vi.fn(),
    removeTaskRelation: vi.fn(),
    herdrStatus: vi.fn(),
    getMachineSettings: vi.fn(),
    saveMachineSettings: vi.fn(),
    startTask: vi.fn(),
    openTaskInHerdr: vi.fn(),
    focusAgentPane: vi.fn(),
    restoreTaskWorktree: vi.fn(),
    closeTaskWorkspace: vi.fn(),
    listCommitRecords: vi.fn(),
    refreshCommitRecords: vi.fn(),
    branchFreshness: vi.fn(),
    openPullRequest: vi.fn(),
    completeTask: vi.fn(),
    concludeTask: vi.fn(),
    completeTaskMergedWith: vi.fn(),
    reopenTask: vi.fn(),
    setTaskOutcome: vi.fn(),
    linkIssue: vi.fn(),
    createIssue: vi.fn(),
    listHerdrMachines: vi.fn(),
    listSshHosts: vi.fn(),
    addSshHost: vi.fn(),
    listDirectories: vi.fn(),
    listAgentStatuses: vi.fn(),
    listPullRequestStatuses: vi.fn(),
    listBackups: vi.fn(),
    mcpServerInfo: vi.fn(),
    listMcpTunnels: vi.fn(),
    getBackupSettings: vi.fn(),
    saveBackupSettings: vi.fn(),
    restoreBackup: vi.fn(),
    reviewPeriod: vi.fn(),
  },
  events: {
    tasksChanged: { listen: vi.fn() },
    workspacesChanged: { listen: vi.fn() },
    agentStatusesChanged: { listen: vi.fn() },
    pullRequestStatusesChanged: { listen: vi.fn() },
  },
}));

const mocked = vi.mocked(commands);
const mockedEvents = vi.mocked(events, { deep: true });
const weekPeriod = (day: string) => periodBounds(weekStarting(day));

const toodo: Workspace = {
  id: 1,
  name: "toodo",
  location: { kind: "local", path: "C:\\dev\\toodo" },
  defaultBaseBranch: "main",
  agentMerge: "never",
  pathProblem: null,
};

const herdr: Workspace = {
  id: 2,
  name: "herdr",
  location: { kind: "ssh", machine: "devbox", path: "/srv/herdr" },
  defaultBaseBranch: "develop",
  agentMerge: "never",
  pathProblem: null,
};

function task(id: number, workspaceId: number, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId,
    taskType: "feat",
    title,
    description: "",
    status: "planned",
    dependsOn: [],
    branch: null,
    worktreePath: null,
    worktreeMissing: false,
    herdrWorkspaceId: null,
    pullRequestUrl: null,
    issue: null,
    estimate: null,
    dueDate: null,
    pullRequestMergedAt: null,
    pullRequest: null,
    mergedWith: null,
    resolution: null,
    completionNote: null,
    notes: [],
    criteria: [],
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
    ...overrides,
  };
}

function criterion(id: number, text: string, overrides: Partial<Criterion> = {}): Criterion {
  return {
    id,
    text,
    kind: "manual",
    target: null,
    state: "pending",
    evidence: null,
    checkedBy: null,
    checkedAt: null,
    ...overrides,
  };
}

function savedMachine(target: string, enabled = true): HerdrMachine {
  return { id: `m-${target}`, label: target, target, session: "default", enabled };
}

function commit(taskId: number, sha: string, message: string): CommitRecord {
  return { taskId, sha, message, author: "Ada <ada@example.com>", committedAt: 1700000000 };
}

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

/** Opens the settings dialog on one of its sections. */
async function openSettings(section: string) {
  fireEvent.click(await screen.findByRole("button", { name: /^Settings/ }));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  fireEvent.click(within(dialog).getByRole("tab", { name: new RegExp(`^${section}`) }));
  return dialog;
}

/** Renders the app and opens one workspace, since the app starts on All workspaces. */
async function renderWorkspace(name: RegExp = /^toodo/) {
  renderApp();
  // The first render of a test file is slow on a loaded machine.
  fireEvent.click(await screen.findByRole("button", { name }, { timeout: 5000 }));
}

/** The row of the task titled `title` in the list. */
function row(title: string) {
  return screen.getByRole("button", { name: title }).closest("li") as HTMLElement;
}

/** The list view's tasks, in sections by status. */
function taskList() {
  return screen.findByRole("region", { name: "Tasks" });
}

/** Opens the details sheet of the task titled `title` from its row in the list. */
async function openDetails(title: string) {
  fireEvent.click(await within(await taskList()).findByRole("button", { name: title }));
  return screen.findByRole("complementary", { name: "Task details" });
}

/** Picks `name` from the "More" menu of task `id`, in a row or, given `scope`, in the details sheet. */
async function chooseAction(id: number, name: string, scope: HTMLElement = document.body) {
  fireEvent.click(await within(scope).findByRole("button", { name: `More actions for #${id}` }));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("App", () => {
  // The timeline and Markdown are lazy-loaded; transform them once here so no test pays for
  // that within its timeout.
  beforeAll(async () => {
    await Promise.all([import("@/components/task-graph"), import("@/components/markdown")]);
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    // jsdom has no matchMedia; the install banner asks whether the app runs installed.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    mocked.appInfo.mockResolvedValue({ name: "toodo", version: "1.2.3" });
    mocked.herdrStatus.mockResolvedValue({ status: "ok", data: { running: true, version: "0.9.3" } });
    mocked.getMachineSettings.mockImplementation(async (machine) => ({
      status: "ok",
      data: { machine, worktreeRoot: null },
    }));
    mocked.listCommitRecords.mockResolvedValue({ status: "ok", data: [] });
    mocked.listTaskRelations.mockResolvedValue({ status: "ok", data: [] });
    mocked.branchFreshness.mockResolvedValue({
      status: "ok",
      data: { base: "origin/main", behind: 0, fetchError: null, mergeable: null, mergeableError: null },
    });
    mocked.listSshHosts.mockResolvedValue({ status: "ok", data: [] });
    mocked.listHerdrMachines.mockResolvedValue({ status: "ok", data: [] });
    mocked.listAgentStatuses.mockResolvedValue([]);
    mocked.listPullRequestStatuses.mockResolvedValue([]);
    mocked.listBackups.mockResolvedValue({ status: "ok", data: [] });
    mocked.mcpServerInfo.mockResolvedValue({
      url: "http://127.0.0.1:47615/mcp",
      token: "secret",
      error: null,
      instance: "0123456789ab",
      lastRejection: null,
    });
    mocked.listMcpTunnels.mockResolvedValue([]);
    mocked.getBackupSettings.mockResolvedValue({ enabled: true, intervalHours: 24, keep: 7 });
    mockedEvents.tasksChanged.listen.mockResolvedValue(() => {});
    mockedEvents.workspacesChanged.listen.mockResolvedValue(() => {});
    mockedEvents.agentStatusesChanged.listen.mockResolvedValue(() => {});
    mockedEvents.pullRequestStatusesChanged.listen.mockResolvedValue(() => {});
  });

  it("shows the backend version once the app info command resolves", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();

    expect(screen.getByRole("heading", { name: "Toodo" })).toBeInTheDocument();
    expect(await screen.findByText("v1.2.3")).toBeInTheDocument();
    expect(await screen.findByText("No workspaces yet.")).toBeInTheDocument();
  });

  it("flags a workspace whose path the server cannot use in the sidebar and its header", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [{ ...toodo, pathProblem: "foreign" }, herdr] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    expect(await screen.findAllByText("Windows path, not on this server")).toHaveLength(2);
    expect(screen.queryByText("Folder not found on the server")).not.toBeInTheDocument();
  });

  it("lists workspaces and the tasks of the selected one", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", {
          status: "done",
          milestones: { ...task(1, 1, "").milestones, plannedAt: 1760000000, completedAt: 1760500000 },
        }),
        task(2, 1, "Add UI", { status: "planned", dependsOn: [1] }),
        task(3, 2, "Fix ssh"),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    // Done tasks are folded away until asked for.
    expect(within(tasks).queryByText("Add storage")).not.toBeInTheDocument();
    fireEvent.click(within(tasks).getByRole("button", { name: "Done 1" }));
    expect(within(tasks).getByText("Add storage")).toBeInTheDocument();
    // Its only prerequisite is done, so #2 can be started now.
    expect(within(row("Add UI")).getByText("Ready")).toBeInTheDocument();
    expect(within(tasks).queryByText("Fix ssh")).not.toBeInTheDocument();
    let details = await openDetails("Add UI");
    const dependencies = within(details).getByRole("group", { name: "Dependencies of #2" });
    expect(within(dependencies).getByText("#1")).toBeInTheDocument();
    expect(within(details).queryByLabelText("Timeline of #2")).not.toBeInTheDocument();
    details = await openDetails("Add storage");
    const timeline = within(details).getByLabelText("Timeline of #1");
    expect(timeline).toHaveTextContent(`Planned${formatWhen(1760000000)}`);
    expect(timeline).toHaveTextContent(`Completed${formatWhen(1760500000)}`);
    expect(within(timeline).getByText(formatWhen(1760500000))).toHaveAttribute("title", formatFull(1760500000));
    expect(timeline).not.toHaveTextContent("Paused");

    fireEvent.click(screen.getByRole("button", { name: /^herdr/ }));
    expect(await screen.findByText("Fix ssh")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "herdr" })).toBeInTheDocument();
    expect(screen.queryByText("Add storage")).not.toBeInTheDocument();
  });

  it("plans dependencies across workspaces and lists every workspace together", async () => {
    const api = task(1, 1, "Add low level API");
    const ui = task(3, 2, "Build UI");
    const docs = task(4, 2, "Write docs");
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [api, ui, docs] });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "added" });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /^herdr/ }));
    const details = await openDetails("Build UI");
    const add = await within(details).findByRole("combobox", { name: "Add dependency to #3" });
    const groups = within(add).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("label"))).toEqual(["herdr", "toodo"]);
    expect(within(groups[1]).getByRole("option", { name: "#1 Add low level API" })).toBeInTheDocument();

    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [api, { ...ui, status: "planned", dependsOn: [1] }, docs],
    });
    fireEvent.change(add, { target: { value: "1" } });
    const dependencies = await screen.findByRole("group", { name: "Dependencies of #3" });
    await waitFor(() => expect(within(dependencies).getByText("toodo #1")).toBeInTheDocument());
    expect(mocked.addDependency).toHaveBeenCalledWith(3, 1, false);

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    expect(await screen.findByRole("heading", { name: "All workspaces" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const tasks = await taskList();
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(3);
    expect(within(tasks).getByText("Add low level API")).toBeInTheDocument();
    expect(within(tasks).getByText("Write docs")).toBeInTheDocument();
    const all = await openDetails("Build UI");
    expect(within(within(all).getByRole("group", { name: "Dependencies of #3" })).getByText("toodo #1")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument();
  });

  it("reviews the chosen period across workspaces, copies it as Markdown, and downloads it as CSV", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 14, 10));
    const at = new Date(2026, 9, 13, 15).getTime() / 1000;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    const year = periodBounds(periodContaining("year", "2026-10-12"));
    const createObjectURL = vi.fn((_blob: Blob) => "blob:review");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    mocked.reviewPeriod.mockImplementation(async (start) => ({
      status: "ok",
      data:
        start === weekPeriod("2026-10-12").start || start === year.start
          ? [
              {
                task: task(1, 1, "Add storage", {
                  status: "done",
                  pullRequestUrl: "https://github.com/acme/toodo/pull/7",
                }),
                outcome: "completed",
                at,
                commits: [{ ...commit(1, "0123456789", "Add the storage schema\n\nBody"), committedAt: at }],
              },
              { task: task(3, 2, "Fix ssh"), outcome: "worked_on", at, commits: [] },
            ]
          : [],
    }));
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(screen.getByRole("heading", { name: "Week review" })).toBeInTheDocument();
    expect(screen.getByLabelText("Week starting")).toHaveValue("2026-10-12");
    const completed = await screen.findByRole("region", { name: "Completed" });
    expect(within(completed).getByText("Add storage")).toBeInTheDocument();
    expect(within(completed).getByText("toodo ·")).toHaveTextContent(`toodo · ${formatWhen(at)}`);
    const pullRequest = within(completed).getByRole("link", { name: "Pull request #7" });
    expect(pullRequest).toHaveTextContent("#7");
    expect(pullRequest).toHaveAttribute("href", "https://github.com/acme/toodo/pull/7");
    expect(within(completed).getByRole("button", { name: "Open #1 Add storage" })).toBeInTheDocument();
    expect(within(completed).getByRole("list", { name: "Commits of #1 this week" })).toHaveTextContent(
      "0123456Add the storage schema",
    );
    const workedOn = screen.getByRole("region", { name: "Worked on" });
    expect(within(workedOn).getByText("herdr ·")).toHaveTextContent(`herdr · ${formatWhen(at)}`);
    const { start, end } = weekPeriod("2026-10-12");
    expect(mocked.reviewPeriod).toHaveBeenCalledWith(start, end);
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Completed by type").nextSibling).toHaveTextContent("feat 1");
    expect(within(summary).queryByRole("list", { name: "Completed per month" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    expect(await screen.findByText("Copied as Markdown.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        "## Completed (1)\n\n- [feat] Add storage (toodo, 2026-10-13, https://github.com/acme/toodo/pull/7)",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(await screen.findByText("No recorded activity in this week.")).toBeInTheDocument();
    expect(screen.getByLabelText("Week starting")).toHaveValue("2026-10-05");
    expect(mocked.reviewPeriod).toHaveBeenLastCalledWith(weekPeriod("2026-10-05").start, start);

    fireEvent.click(within(screen.getByRole("group", { name: "Review period" })).getByRole("button", { name: "Year" }));
    expect(screen.getByRole("heading", { name: "Year review" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Completed" })).toBeInTheDocument();
    expect(mocked.reviewPeriod).toHaveBeenLastCalledWith(year.start, year.end);
    const months = within(screen.getByRole("region", { name: "Summary" })).getByRole("list", {
      name: "Completed per month",
    });
    expect(within(months).getAllByRole("listitem")).toHaveLength(12);
    expect(within(months).getAllByRole("listitem")[9]).toHaveTextContent("2026-101");

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as CSV" }));
    expect(await screen.findByText("Downloaded toodo-review-2026.csv")).toBeInTheDocument();
    expect(downloads).toEqual(["toodo-review-2026.csv"]);
    expect(await createObjectURL.mock.calls[0][0].text()).toContain(",toodo,feat,Add storage,Completed,");
    click.mockRestore();

    fireEvent.click(screen.getByRole("button", { name: /^toodo/ }));
    expect(await screen.findByRole("heading", { name: "toodo" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Year review" })).not.toBeInTheDocument();
  });

  it("shows the tasks of every workspace on a timeline, narrowed to one workspace on request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const day = 24 * 60 * 60;
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = (at: number) => ({ ...task(0, 1, "").milestones, plannedAt: at });
    const lastYear = new Date(2025, 5, 1).getTime() / 1000;
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(5, 2, "Add herdr API", { status: "planned", dependsOn: [1], milestones: planned(plannedAt + day) }),
        task(1, 1, "Add storage", {
          status: "done",
          milestones: { ...planned(plannedAt), completedAt: plannedAt + 3 * day },
        }),
        task(2, 1, "Add UI", { status: "planned", dependsOn: [1], milestones: planned(plannedAt + day) }),
        task(3, 1, "Write docs", { status: "in_progress" }),
        task(4, 1, "Fix login", {
          status: "done",
          milestones: { ...planned(lastYear), completedAt: lastYear + day },
        }),
      ],
    });
    await renderWorkspace();

    await taskList();
    expect(screen.queryByRole("button", { name: "Timeline" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));

    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    expect(screen.getByRole("button", { name: "Timeline" })).toHaveAttribute("aria-pressed", "true");
    expect(await within(timeline).findByText("Add herdr API")).toBeInTheDocument();
    expect(await within(timeline).findByText("Add UI")).toBeInTheDocument();
    // The timeline leaves finished tasks out until they are asked for.
    expect(within(timeline).queryByText("Add storage")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Done" }));
    expect(await within(timeline).findByText("Add storage")).toBeInTheDocument();
    const unplaced = within(timeline).getByRole("complementary", { name: "Tasks without a planned date" });
    expect(within(unplaced).getByText("Write docs")).toBeInTheDocument();
    expect(within(timeline).getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();

    fireEvent.click(within(timeline).getByRole("button", { name: "Month" }));
    expect(within(timeline).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    const period = within(timeline).getByRole("combobox", { name: "Timeline period" });
    expect(within(period).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "All time",
      "2026",
      "2025",
    ]);
    fireEvent.change(period, { target: { value: "2025" } });
    expect(await within(timeline).findByText("Fix login")).toBeInTheDocument();
    expect(within(timeline).queryByText("Add UI")).not.toBeInTheDocument();
    expect(within(unplaced).getByText("Write docs")).toBeInTheDocument();
    fireEvent.change(period, { target: { value: "all" } });

    const filter = screen.getByRole("combobox", { name: "Timeline workspace" });
    expect(within(filter).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "All workspaces",
      "herdr",
      "toodo",
    ]);
    expect(within(timeline).getByText("Add storage").closest("[data-dimmed]")).toBeNull();
    fireEvent.change(filter, { target: { value: "2" } });
    expect(await within(timeline).findByText("Add herdr API")).toBeInTheDocument();
    expect(within(timeline).queryByText("Add UI")).not.toBeInTheDocument();
    expect(within(timeline).queryByText("Write docs")).not.toBeInTheDocument();
    // The prerequisite in another workspace stays on the timeline, dimmed and labeled.
    const prerequisite = within(timeline).getByText("Add storage").closest("[data-dimmed]");
    expect(prerequisite).not.toBeNull();
    expect(within(prerequisite as HTMLElement).getByText("toodo")).toBeInTheDocument();
    expect(within(timeline).getByText("Add herdr API").closest("[data-dimmed]")).toBeNull();
  });

  it("searches tasks and filters them by status and type in every task view", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = { ...task(0, 1, "").milestones, plannedAt };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { description: "SQLite schema", milestones: planned }),
        task(2, 1, "Fix login", { taskType: "fix", status: "in_progress", milestones: planned }),
        task(3, 2, "Fix ssh", { taskType: "fix", milestones: planned }),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "sqlite" } });
    expect(within(tasks).getByText("Add storage")).toBeInTheDocument();
    expect(within(tasks).queryByText("Fix login")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "In progress" }));
    expect(await screen.findByText("No tasks match the search and filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(within(screen.getByRole("region", { name: "Tasks" })).getAllByRole("listitem")).toHaveLength(2);
    // Selected statuses add up: Ready alone, then Ready and In progress together.
    const statusFilter = screen.getByRole("group", { name: "Status filter" });
    fireEvent.click(within(statusFilter).getByRole("button", { name: "Ready" }));
    expect(within(screen.getByRole("region", { name: "Tasks" })).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(statusFilter).getByRole("button", { name: "In progress" }));
    expect(within(screen.getByRole("region", { name: "Tasks" })).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    expect(await within(timeline).findByText("Add storage")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Type filter" }), { target: { value: "fix" } });
    expect(await within(timeline).findByText("Fix ssh")).toBeInTheDocument();
    expect(within(timeline).getByText("Fix login")).toBeInTheDocument();
    expect(within(timeline).queryByText("Add storage")).not.toBeInTheDocument();

    // The filters stay when switching to the list of every workspace.
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "SSH" } });
    const all = screen.getByRole("region", { name: "Tasks" });
    expect(within(all).getAllByRole("listitem")).toHaveLength(1);
    expect(within(all).getByText("Fix ssh")).toBeInTheDocument();
  });

  it("finds a task by its number in any workspace, first, with the text matches", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage"),
        task(2, 1, "Follow up on 3", { status: "in_progress" }),
        task(3, 2, "Fix ssh"),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    const search = screen.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "#3" } });
    const match = within(tasks).getByRole("list", { name: "Task number match" });
    expect(within(match).getByText("Fix ssh")).toBeInTheDocument();
    expect(within(match).getByText("herdr")).toBeInTheDocument();
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.change(search, { target: { value: "3" } });
    const rows = within(tasks).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-task-row"))).toEqual(["3", "2"]);

    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "In progress" }));
    expect(within(tasks).queryByRole("list", { name: "Task number match" })).not.toBeInTheDocument();
    expect(within(tasks).getByText("Follow up on 3")).toBeInTheDocument();
  });

  it("filters the tasks that can be started now in the list and on the timeline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = { ...task(0, 1, "").milestones, plannedAt };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", {
          status: "done",
          resolution: "merged",
          milestones: { ...planned, completedAt: plannedAt + 3600 },
        }),
        task(2, 1, "Add UI", { dependsOn: [1], milestones: planned }),
        task(3, 1, "Write docs", { dependsOn: [4], milestones: planned }),
        task(4, 2, "Fix ssh", { status: "in_progress", milestones: planned }),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    expect(await within(tasks).findByText("Add UI")).toBeInTheDocument();
    expect(within(row("Add UI")).getByText("Ready")).toBeInTheDocument();
    expect(within(row("Write docs")).getByText("Blocked")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Ready" }));
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(1);
    expect(within(tasks).getByText("Add UI")).toBeInTheDocument();

    // Waiting on a task of another workspace keeps #3 out of the timeline too.
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bars = timeline.querySelector(".react-flow__nodes") as HTMLElement;
    expect(await within(bars).findByText("Write docs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Ready" }));
    expect(await within(bars).findByText("Add UI")).toBeInTheDocument();
    expect(within(bars).getByText("Ready")).toBeInTheDocument();
    expect(within(bars).queryByText("Write docs")).not.toBeInTheDocument();
    expect(within(bars).queryByText("Add storage")).not.toBeInTheDocument();
  });

  it("opens the details of a task clicked on the timeline and fades tasks outside its chain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = { ...task(0, 1, "").milestones, plannedAt };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "done", milestones: { ...planned, completedAt: plannedAt + 3600 } }),
        task(2, 1, "Add UI", { dependsOn: [1], milestones: planned }),
        task(3, 1, "Write docs", { milestones: planned }),
      ],
    });
    await renderWorkspace();

    await taskList();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    // The details panel names other tasks too, as dependency choices; look only at the bars.
    const bar = (title: string) =>
      within(timeline.querySelector(".react-flow__nodes") as HTMLElement)
        .getByText(title)
        .closest(".react-flow__node") as HTMLElement;
    await within(timeline).findByText("Add UI");
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Done" }));
    await within(timeline).findByText("Add storage");
    expect(within(timeline).queryByRole("complementary", { name: "Task details" })).not.toBeInTheDocument();

    fireEvent.click(bar("Add UI"));
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("button", { name: "Start #2" })).toBeInTheDocument();
    expect(within(details).getByRole("heading", { name: "Add UI" })).toBeInTheDocument();
    expect(bar("Write docs").querySelector("[data-dimmed]")).not.toBeNull();
    expect(bar("Add storage").querySelector("[data-dimmed]")).toBeNull();
    expect(bar("Add UI").querySelector("[data-dimmed]")).toBeNull();

    fireEvent.click(bar("Write docs"));
    expect(await within(details).findByRole("button", { name: "Start #3" })).toBeInTheDocument();
    expect(bar("Add UI").querySelector("[data-dimmed]")).not.toBeNull();

    fireEvent.keyDown(within(details).getByRole("button", { name: "Close details" }), { key: "Escape" });
    await waitFor(() =>
      expect(within(timeline).queryByRole("complementary", { name: "Task details" })).not.toBeInTheDocument(),
    );
    expect(bar("Add UI").querySelector("[data-dimmed]")).toBeNull();

    bar("Add UI").focus();
    fireEvent.click(bar("Add UI"));
    expect(
      within(await within(timeline).findByRole("complementary", { name: "Task details" })).getByRole("heading", {
        name: "Task details",
      }),
    ).toHaveFocus();
    fireEvent.click(await within(timeline).findByRole("button", { name: "Close details" }));
    expect(within(timeline).queryByRole("complementary", { name: "Task details" })).not.toBeInTheDocument();
    expect(bar("Add UI")).toHaveFocus();
  });

  it("summarizes a hovered timeline bar and moves between rows with the arrow keys", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = { ...task(0, 1, "").milestones, plannedAt };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "done", milestones: { ...planned, completedAt: plannedAt + 3600 } }),
        task(2, 1, "Add UI", { dependsOn: [1], milestones: planned }),
        task(3, 1, "Write docs", { dependsOn: [2], milestones: planned }),
      ],
    });
    await renderWorkspace();

    await taskList();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bar = (title: string) =>
      within(timeline.querySelector(".react-flow__nodes") as HTMLElement)
        .getByText(title)
        .closest(".react-flow__node") as HTMLElement;
    await within(timeline).findByText("Write docs");
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Done" }));
    await within(timeline).findByText("Add storage");

    fireEvent.mouseEnter(bar("Add storage"));
    const summary = await screen.findByRole("tooltip", { name: "Summary of #1" });
    expect(summary).toHaveTextContent("Add storage");
    expect(summary).toHaveTextContent(`Completed${formatWhen(plannedAt + 3600)}`);
    fireEvent.mouseLeave(bar("Add storage"));
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    // Rows follow the dependency chain: storage, then UI, then docs.
    const heading = async (title: string) =>
      within(await within(timeline).findByRole("complementary", { name: "Task details" })).findByRole("heading", {
        name: title,
      });
    bar("Add storage").focus();
    fireEvent.keyDown(bar("Add storage"), { key: "ArrowDown" });
    expect(await heading("Add UI")).toBeInTheDocument();
    expect(bar("Add UI")).toHaveFocus();
    fireEvent.keyDown(bar("Add UI"), { key: "ArrowDown" });
    expect(await heading("Write docs")).toBeInTheDocument();
    fireEvent.keyDown(bar("Write docs"), { key: "ArrowUp" });
    expect(await heading("Add UI")).toBeInTheDocument();
    fireEvent.keyDown(bar("Add UI"), { key: "Home" });
    expect(await heading("Add storage")).toBeInTheDocument();
    fireEvent.keyDown(bar("Add storage"), { key: "End" });
    expect(await heading("Write docs")).toBeInTheDocument();
    expect(bar("Write docs")).toHaveFocus();
  });

  it("shows the agent status of active tasks on the timeline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const day = 24 * 60 * 60;
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const milestones = { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + day };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "in_progress", herdrWorkspaceId: "w27", milestones }),
        task(2, 1, "Add UI", { status: "done", milestones: { ...milestones, completedAt: plannedAt + 2 * day } }),
      ],
    });
    mocked.listAgentStatuses.mockResolvedValue([
      { taskId: 1, status: "working" },
      { taskId: 2, status: "idle" },
    ]);
    await renderWorkspace();

    await taskList();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    expect(await within(timeline).findByLabelText("Agent of #1")).toHaveTextContent("Agent working");
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Done" }));
    expect(await within(timeline).findByText("Add UI")).toBeInTheDocument();
    expect(within(timeline).queryByLabelText("Agent of #2")).not.toBeInTheDocument();

    const [[onAgentStatuses]] = mockedEvents.agentStatusesChanged.listen.mock.calls;
    act(() => {
      onAgentStatuses({
        event: "agent-statuses-changed",
        id: 1,
        payload: { statuses: [{ taskId: 1, status: "blocked" }] },
      });
    });
    await waitFor(() =>
      expect(within(timeline).getByLabelText("Agent of #1")).toHaveTextContent("Agent needs input"),
    );
  });

  it("shows command errors returned by the backend", async () => {
    mocked.listWorkspaces.mockResolvedValue({
      status: "error",
      error: { kind: "internal", message: "database is locked" },
    });
    renderApp();

    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
  });

  it("groups workspaces under Local and the machines saved in herdr", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listHerdrMachines.mockResolvedValue({
      status: "ok",
      data: [savedMachine("gpu"), savedMachine("lab", false)],
    });
    mocked.listSshHosts.mockResolvedValue({ status: "ok", data: ["unsaved"] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    renderApp();

    const local = await screen.findByRole("region", { name: "Machine Local" });
    expect(within(local).getByText("toodo")).toBeInTheDocument();
    const gpu = await screen.findByRole("region", { name: "Machine gpu" });
    expect(within(gpu).queryByRole("listitem")).toBeNull();
    expect(within(gpu).queryByText(/in herdr/)).toBeNull();
    expect(within(screen.getByRole("region", { name: "Machine lab" })).getByText("Disabled in herdr")).toBeInTheDocument();
    const devbox = screen.getByRole("region", { name: "Machine devbox" });
    expect(within(devbox).getByText("/srv/herdr")).toBeInTheDocument();
    expect(within(devbox).getByText("Not saved in herdr")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Machine unsaved" })).toBeNull();
  });

  it("starts on All workspaces and keeps the timeline scale and task drafts while navigating", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Add storage"), task(3, 2, "Fix ssh")] });
    renderApp();

    expect(await screen.findByRole("heading", { name: "All workspaces" })).toBeInTheDocument();
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    fireEvent.click(within(timeline).getByRole("button", { name: "Day" }));

    fireEvent.click(screen.getByRole("button", { name: /^toodo/ }));
    fireEvent.focusIn(await screen.findByLabelText("Task title"));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Half-written task" } });
    fireEvent.change(screen.getByLabelText("Task type"), { target: { value: "fix" } });
    fireEvent.click(screen.getByRole("button", { name: /^herdr/ }));
    expect(await screen.findByRole("heading", { name: "herdr" })).toBeInTheDocument();
    expect(screen.getByLabelText("Task title")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /^toodo/ }));
    expect(await screen.findByLabelText("Task title")).toHaveValue("Half-written task");
    fireEvent.focusIn(screen.getByLabelText("Task title"));
    expect(screen.getByLabelText("Task type")).toHaveValue("fix");

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    expect(
      within(await screen.findByRole("region", { name: "Task timeline" })).getByRole("button", { name: "Day" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(
      within(await screen.findByRole("region", { name: "Task timeline" })).getByRole("button", { name: "Day" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("removes a workspace from the list only after confirming", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(3, 2, "Fix ssh")],
    });
    mocked.deleteWorkspace
      .mockResolvedValueOnce({ status: "error", error: { kind: "internal", message: "database is locked" } })
      .mockResolvedValueOnce({ status: "ok", data: null });
    await renderWorkspace();

    expect(await screen.findByText("Add storage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove toodo" }));
    expect(mocked.deleteWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("button", { name: "Confirm remove toodo" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove toodo" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove toodo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
    expect(screen.getByRole("region", { name: "Machine Local" })).toHaveTextContent("toodo");

    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [herdr] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove toodo" }));

    expect(await screen.findByText("Fix ssh")).toBeInTheDocument();
    expect(mocked.deleteWorkspace).toHaveBeenLastCalledWith(1);
    expect(within(screen.getByRole("region", { name: "Machine Local" })).queryByRole("listitem")).toBeNull();
    expect(screen.getByRole("heading", { name: "herdr" })).toBeInTheDocument();
  });

  it("opens a repository browsed on the server", async () => {
    const opened: Workspace = { ...toodo, location: { kind: "local", path: "/home/me/toodo" } };
    mocked.listWorkspaces.mockResolvedValueOnce({ status: "ok", data: [] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.createWorkspace.mockResolvedValue({ status: "ok", data: opened });
    mocked.listDirectories.mockImplementation(async (_machine, path) => ({
      status: "ok",
      data:
        path === "/home/me/toodo"
          ? { path: "/home/me/toodo", directories: [] }
          : { path: "/home/me", directories: ["toodo"] },
    }));
    renderApp();

    await screen.findByText("No workspaces yet.");
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [opened] });
    fireEvent.click(screen.getByRole("button", { name: "Open on Local" }));
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/home/me/"));
    fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
    const browser = screen.getByRole("group", { name: "Browse folders on the server" });
    fireEvent.click(await within(browser).findByRole("button", { name: "toodo/" }));
    await within(browser).findByText("No subfolders");
    fireEvent.click(within(browser).getByRole("button", { name: "Select folder" }));
    expect(screen.getByLabelText("Folder")).toHaveValue("/home/me/toodo");
    expect(screen.getByLabelText("Name")).toHaveValue("toodo");
    expect(mocked.listDirectories).toHaveBeenCalledWith({ kind: "local" }, null);
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));

    expect(await screen.findByRole("heading", { name: "toodo" })).toBeInTheDocument();
    expect(mocked.createWorkspace).toHaveBeenCalledWith({
      name: "toodo",
      location: { kind: "local", path: "/home/me/toodo" },
      source: { kind: "open" },
      defaultBaseBranch: null,
    });
  });

  it("makes a local folder a new repository", async () => {
    const notes: Workspace = { ...toodo, id: 3, name: "notes", location: { kind: "local", path: "/home/me/notes" } };
    mocked.listWorkspaces.mockResolvedValueOnce({ status: "ok", data: [] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.createWorkspace.mockResolvedValue({ status: "ok", data: notes });
    mocked.listDirectories.mockResolvedValue({ status: "ok", data: { path: "/home/me", directories: [] } });
    renderApp();

    await screen.findByText("No workspaces yet.");
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [notes] });
    fireEvent.click(screen.getByRole("button", { name: "Init on Local" }));
    const form = screen.getByRole("form", { name: "Init workspace on Local" });
    await waitFor(() => expect(within(form).getByLabelText("Folder")).toHaveValue("/home/me/"));
    fireEvent.change(within(form).getByLabelText("Folder"), { target: { value: "/home/me/notes" } });
    expect(within(form).getByLabelText("Name")).toHaveValue("notes");
    fireEvent.click(within(form).getByRole("button", { name: "Init workspace" }));

    expect(await screen.findByRole("heading", { name: "notes" })).toBeInTheDocument();
    expect(mocked.createWorkspace).toHaveBeenCalledWith({
      name: "notes",
      location: { kind: "local", path: "/home/me/notes" },
      source: { kind: "init" },
      defaultBaseBranch: null,
    });
  });

  it("clones into a folder browsed on an SSH host and selects the workspace", async () => {
    mocked.listWorkspaces.mockResolvedValueOnce({ status: "ok", data: [] });
    mocked.listHerdrMachines.mockResolvedValue({ status: "ok", data: [savedMachine("devbox")] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.createWorkspace.mockResolvedValue({ status: "ok", data: herdr });
    mocked.listDirectories.mockImplementation(async (_machine, path) => ({
      status: "ok",
      data:
        path === null
          ? { path: "/home/me", directories: ["src"] }
          : path === "/home/me/src"
            ? { path: "/home/me/src", directories: [] }
            : { path: "/home", directories: ["me"] },
    }));
    renderApp();

    await screen.findByText("No workspaces yet.");
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [herdr] });
    fireEvent.click(await screen.findByRole("button", { name: "Clone on devbox" }));
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "git@github.com:o/herdr.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
    const browser = screen.getByRole("group", { name: "Browse folders on devbox" });
    await within(browser).findByRole("button", { name: "src/" });
    const folder = within(browser).getByLabelText("Remote folder");
    fireEvent.change(folder, { target: { value: "/home" } });
    fireEvent.keyDown(folder, { key: "Enter" });
    await within(browser).findByRole("button", { name: "me/" });
    expect(mocked.createWorkspace).not.toHaveBeenCalled();
    fireEvent.change(folder, { target: { value: "" } });
    fireEvent.keyDown(folder, { key: "Enter" });
    fireEvent.click(await within(browser).findByRole("button", { name: "src/" }));
    await within(browser).findByText("No subfolders");
    fireEvent.click(within(browser).getByRole("button", { name: "Select folder" }));

    expect(screen.getByLabelText("Parent folder")).toHaveValue("/home/me/src");
    expect(screen.getByText("Clones into /home/me/src/herdr")).toBeInTheDocument();
    expect(mocked.listDirectories).toHaveBeenCalledWith({ kind: "ssh", label: "devbox" }, null);
    fireEvent.click(screen.getByRole("button", { name: "Clone workspace" }));

    expect(await screen.findByRole("heading", { name: "herdr" })).toBeInTheDocument();
    expect(mocked.createWorkspace).toHaveBeenCalledWith({
      name: "herdr",
      location: { kind: "ssh", machine: "devbox", path: "/home/me/src/herdr" },
      source: { kind: "clone", url: "git@github.com:o/herdr.git" },
      defaultBaseBranch: null,
    });
  });

  it("creates a task and reloads the task list", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValueOnce({ status: "ok", data: [] });
    mocked.createTask.mockResolvedValue({ status: "ok", data: task(5, 1, "Write docs") });
    await renderWorkspace();

    await screen.findByText("No tasks in this workspace yet.");
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(5, 1, "Write docs")] });
    expect(screen.queryByLabelText("Task type")).not.toBeInTheDocument();
    fireEvent.focusIn(screen.getByLabelText("Task title"));
    fireEvent.change(screen.getByLabelText("Task type"), { target: { value: "docs" } });
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Write docs" } });
    fireEvent.change(screen.getByLabelText("Estimate"), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Estimate"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Estimate unit"), { target: { value: "weeks" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-11-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByText("Write docs")).toBeInTheDocument();
    expect(mocked.createTask).toHaveBeenCalledWith({
      workspaceId: 1,
      taskType: "docs",
      title: "Write docs",
      description: "",
      estimate: { unit: "weeks", amount: 2.5 },
      dueDate: "2026-11-01",
      criteria: [],
      mergeCriterion: true,
    });
    // The form closes once the task is added, and opens again empty.
    expect(screen.queryByLabelText("Estimate")).not.toBeInTheDocument();
    fireEvent.focusIn(screen.getByLabelText("Task title"));
    expect(screen.getByLabelText("Task title")).toHaveValue("");
    expect(screen.getByLabelText("Estimate")).toHaveValue("");
  });

  it("keeps the new task form to one line until it is used, and keeps its draft when closed", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    const form = await screen.findByRole("form", { name: "New task" });
    const title = within(form).getByLabelText("Task title");
    expect(within(form).queryByLabelText("Description")).not.toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Add task" })).toBeInTheDocument();

    fireEvent.focusIn(title);
    fireEvent.change(title, { target: { value: "Plan the release" } });
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Notes" } });
    expect(within(form).getByText("Markdown supported")).toBeInTheDocument();
    fireEvent.keyDown(title, { key: "Escape" });
    expect(within(form).queryByLabelText("Description")).not.toBeInTheDocument();
    expect(title).toHaveValue("Plan the release");

    fireEvent.focusIn(title);
    expect(within(form).getByLabelText("Description")).toHaveValue("Notes");
    fireEvent.click(within(form).getByRole("button", { name: "Close New task" }));
    expect(within(form).queryByLabelText("Description")).not.toBeInTheDocument();
    expect(title).toHaveFocus();

    fireEvent.focusIn(title);
    fireEvent.click(screen.getByRole("heading", { name: "toodo" }));
    expect(within(form).queryByLabelText("Description")).not.toBeInTheDocument();
  });

  it("creates a task with completion criteria", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.createTask.mockResolvedValue({ status: "ok", data: task(5, 1, "Add search") });
    await renderWorkspace();

    await screen.findByText("No tasks in this workspace yet.");
    const form = screen.getByRole("form", { name: "New task" });
    fireEvent.focusIn(within(form).getByLabelText("Task title"));
    fireEvent.change(within(form).getByLabelText("Task title"), { target: { value: "Add search" } });
    expect(within(form).getByRole("checkbox", { name: "Done when merged" })).toBeChecked();
    const add = within(form).getByRole("button", { name: "Add criterion" });
    fireEvent.click(add);
    fireEvent.change(within(form).getByLabelText("Criterion 1 text"), { target: { value: " Docs reviewed " } });
    fireEvent.click(add);
    fireEvent.change(within(form).getByLabelText("Criterion 2 text"), { target: { value: "Tests pass" } });
    expect(within(form).queryByLabelText("Criterion 2 target")).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Criterion 2 kind"), { target: { value: "command" } });
    // A command criterion cannot be added without its command.
    expect(within(form).getByRole("button", { name: "Add task" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Criterion 2 target"), { target: { value: "npm test" } });
    // A row left blank is not sent.
    fireEvent.click(add);
    fireEvent.click(within(form).getByRole("button", { name: "Add task" }));

    await waitFor(() => expect(within(form).queryByLabelText("Criterion 1 text")).not.toBeInTheDocument());
    expect(mocked.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add search",
        criteria: [
          { text: "Docs reviewed", kind: "manual", target: null },
          { text: "Tests pass", kind: "command", target: "npm test" },
        ],
        mergeCriterion: true,
      }),
    );
  });

  it("links the issue number given with a new task", async () => {
    const issue = { number: 12, url: "https://github.com/acme/toodo/issues/12" };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValueOnce({ status: "ok", data: [] });
    mocked.createTask.mockResolvedValue({ status: "ok", data: task(5, 1, "Fix login") });
    mocked.linkIssue.mockResolvedValue({ status: "ok", data: task(5, 1, "Fix login", { issue }) });
    await renderWorkspace();

    await screen.findByText("No tasks in this workspace yet.");
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(5, 1, "Fix login", { issue })] });
    fireEvent.focusIn(screen.getByLabelText("Task title"));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Fix login" } });
    fireEvent.change(screen.getByLabelText("Issue number"), { target: { value: "#12x" } });
    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Issue number"), { target: { value: "#12" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    const details = await openDetails("Fix login");
    expect(await within(details).findByLabelText("Issue of #5")).toHaveTextContent("#12");
    expect(mocked.linkIssue).toHaveBeenCalledWith(5, 12);
    fireEvent.focusIn(screen.getByLabelText("Task title"));
    expect(screen.getByLabelText("Issue number")).toHaveValue("");
  });

  it("links an issue to a task from its row and unlinks it", async () => {
    const issue = { number: 12, url: "https://github.com/acme/toodo/issues/12" };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Fix login")] });
    mocked.linkIssue
      .mockResolvedValueOnce({ status: "error", error: { kind: "external", message: "issue #9 not found" } })
      .mockResolvedValue({ status: "ok", data: task(1, 1, "Fix login", { issue }) });
    await renderWorkspace();

    await chooseAction(1, "Link issue to #1");
    const number = await screen.findByLabelText("Issue number of #1");
    fireEvent.change(number, { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("issue #9 not found");

    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Fix login", { issue })] });
    fireEvent.change(number, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(screen.queryByLabelText("Issue number of #1")).not.toBeInTheDocument());
    expect(mocked.linkIssue).toHaveBeenLastCalledWith(1, 12);
    const details = await openDetails("Fix login");
    expect(await within(details).findByLabelText("Issue of #1")).toHaveTextContent("#12");

    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Fix login")] });
    fireEvent.click(within(details).getByRole("button", { name: "Unlink issue from #1" }));
    await waitFor(() => expect(within(details).queryByLabelText("Issue of #1")).not.toBeInTheDocument());
    expect(mocked.linkIssue).toHaveBeenLastCalledWith(1, null);
    await chooseAction(1, "Link issue to #1", details);
    expect(within(details).getByLabelText("Issue number of #1")).toBeInTheDocument();
  });

  it("starts a ready task in herdr and shows its worktree", async () => {
    const started = task(1, 1, "Add login", {
      status: "in_progress",
      branch: "feat/add-login-1",
      worktreePath: "D:\\wt\\toodo\\feat-add-login-1",
      herdrWorkspaceId: "w27",
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValueOnce({ status: "ok", data: [task(1, 1, "Add login")] });
    mocked.startTask.mockResolvedValue({ status: "ok", data: started });
    mocked.openTaskInHerdr.mockResolvedValue({ status: "ok", data: null });
    await renderWorkspace();

    const start = await screen.findByRole("button", { name: "Start #1" });
    await waitFor(() => expect(start).toBeEnabled());
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    fireEvent.click(start);

    // Once started, opening a pull request is the next action; herdr is a menu item away.
    expect(await screen.findByRole("button", { name: "Open pull request for #1" })).toBeInTheDocument();
    expect(within(row("Add login")).getByText("In progress")).toBeInTheDocument();
    expect(mocked.startTask).toHaveBeenCalledWith(1);
    const details = await openDetails("Add login");
    expect(within(details).getByText("feat/add-login-1")).toBeInTheDocument();
    expect(within(details).getByText("…\\toodo\\feat-add-login-1")).toHaveAttribute(
      "title",
      "D:\\wt\\toodo\\feat-add-login-1",
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(within(details).getByRole("button", { name: "Copy worktree path of #1" }));
    expect(writeText).toHaveBeenCalledWith("D:\\wt\\toodo\\feat-add-login-1");
    expect(await within(details).findByText("Copied")).toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: "Close details" }));
    await chooseAction(1, "Open #1 in herdr");
    await waitFor(() => expect(mocked.openTaskInHerdr).toHaveBeenCalledWith(1));
  });

  it("follows herdr events: agent statuses of active tasks and task changes", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add login", { status: "in_progress", herdrWorkspaceId: "w27" }),
        task(2, 1, "Add logout", { status: "done" }),
      ],
    });
    mocked.listAgentStatuses.mockResolvedValue([{ taskId: 1, status: "working" }]);
    await renderWorkspace();

    const tasks = await taskList();
    expect(await within(tasks).findByLabelText("Agent of #1")).toHaveTextContent("Agent working");

    const [[onAgentStatuses]] = mockedEvents.agentStatusesChanged.listen.mock.calls;
    const blocked: TaskAgentStatus[] = [
      { taskId: 1, status: "blocked" },
      { taskId: 2, status: "idle" },
    ];
    act(() => {
      onAgentStatuses({ event: "agent-statuses-changed", id: 1, payload: { statuses: blocked } });
    });
    await waitFor(() =>
      expect(within(tasks).getByLabelText("Agent of #1")).toHaveTextContent("Agent needs input"),
    );
    expect(within(tasks).queryByLabelText("Agent of #2")).not.toBeInTheDocument();

    const loads = mocked.listTasks.mock.calls.length;
    const [[onTasksChanged]] = mockedEvents.tasksChanged.listen.mock.calls;
    act(() => {
      onTasksChanged({ event: "tasks-changed", id: 2, payload: { workspaceId: 1 } });
    });
    await waitFor(() => expect(mocked.listTasks.mock.calls.length).toBeGreaterThan(loads));
  });

  it("shows a workspace an agent added once the app hears of it", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    renderApp();
    await screen.findByRole("button", { name: /^toodo/ });
    await waitFor(() => expect(mockedEvents.workspacesChanged.listen).toHaveBeenCalled());

    mocked.listWorkspaces.mockResolvedValue({
      status: "ok",
      data: [toodo, { ...toodo, id: 2, name: "site" }],
    });
    const [[onWorkspacesChanged]] = mockedEvents.workspacesChanged.listen.mock.calls;
    act(() => {
      onWorkspacesChanged({ event: "workspaces-changed", id: 3, payload: null });
    });

    expect(await screen.findByRole("button", { name: /^site/ })).toBeInTheDocument();
  });

  it("notifies once when an agent needs input while the app is in the background", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add login", { status: "in_progress", herdrWorkspaceId: "w27" })],
    });
    mocked.listAgentStatuses.mockResolvedValue([{ taskId: 1, status: "working" }]);
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    const focus = vi.spyOn(document, "hasFocus");
    await renderWorkspace();

    const tasks = await taskList();
    expect(await within(tasks).findByLabelText("Agent of #1")).toHaveTextContent("Agent working");
    const [[onAgentStatuses]] = mockedEvents.agentStatusesChanged.listen.mock.calls;

    focus.mockReturnValue(true);
    act(() => {
      onAgentStatuses({ event: "agent-statuses-changed", id: 1, payload: { statuses: [{ taskId: 1, status: "done" }] } });
    });
    focus.mockReturnValue(false);
    act(() => {
      onAgentStatuses({ event: "agent-statuses-changed", id: 2, payload: { statuses: [{ taskId: 1, status: "working" }] } });
    });
    act(() => {
      onAgentStatuses({ event: "agent-statuses-changed", id: 3, payload: { statuses: [{ taskId: 1, status: "blocked" }] } });
    });

    await waitFor(() => expect(within(tasks).getByLabelText("Agent of #1")).toHaveTextContent("Agent needs input"));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({ title: "Agent needs input", body: "#1 Add login" });
    focus.mockRestore();
  });

  it("shows the CI and review state of pull requests in review and notifies when they need the user", async () => {
    const pullRequestUrl = "https://github.com/acme/toodo/pull/12";
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add login", { status: "in_review", pullRequestUrl }),
        task(2, 1, "Add logout", { status: "in_progress" }),
      ],
    });
    // A stale entry of a task no longer in review is not shown.
    mocked.listPullRequestStatuses.mockResolvedValue([
      { taskId: 1, checks: "pending", review: "pending" },
      { taskId: 2, checks: "failing", review: "pending" },
    ]);
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await renderWorkspace();

    const tasks = await taskList();
    expect(await within(tasks).findByLabelText("CI of #1")).toHaveTextContent("CI running");
    expect(within(tasks).getByLabelText("Review of #1")).toHaveTextContent("Review pending");
    expect(within(tasks).queryByLabelText("CI of #2")).not.toBeInTheDocument();

    const [[onPullRequestStatuses]] = mockedEvents.pullRequestStatusesChanged.listen.mock.calls;
    act(() => {
      onPullRequestStatuses({
        event: "pull-request-statuses-changed",
        id: 1,
        payload: { statuses: [{ taskId: 1, checks: "failing", review: "changes_requested" }] },
      });
    });

    await waitFor(() => expect(within(tasks).getByLabelText("CI of #1")).toHaveTextContent("CI failed"));
    expect(within(tasks).getByLabelText("Review of #1")).toHaveTextContent("Changes requested");
    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
    expect(sendNotification).toHaveBeenCalledWith({ title: "CI failed", body: "#1 Add login" });
    expect(sendNotification).toHaveBeenCalledWith({ title: "Changes requested", body: "#1 Add login" });
    focus.mockRestore();
  });

  it("restores the worktree of an active task that lost it", async () => {
    const lost = task(1, 1, "Add login", { status: "in_progress", branch: "feat/add-login-1" });
    const restored = { ...lost, worktreePath: "D:\\wt\\toodo\\feat-add-login-1", herdrWorkspaceId: "w31" };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [lost] });
    mocked.restoreTaskWorktree.mockImplementation(async () => {
      mocked.listTasks.mockResolvedValue({ status: "ok", data: [restored] });
      return { status: "ok", data: restored };
    });
    await renderWorkspace();

    const restore = await screen.findByRole("button", { name: "Restore worktree of #1" });
    expect(screen.queryByRole("button", { name: "Open pull request for #1" })).not.toBeInTheDocument();
    await waitFor(() => expect(restore).toBeEnabled());
    fireEvent.click(restore);

    expect(await screen.findByRole("button", { name: "Open pull request for #1" })).toBeInTheDocument();
    expect(mocked.restoreTaskWorktree).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("button", { name: "Restore worktree of #1" })).not.toBeInTheDocument();
  });

  it("offers restore when an active task has a missing recorded worktree", async () => {
    const missing = task(1, 1, "Add login", {
      status: "in_progress",
      branch: "feat/add-login-1",
      worktreePath: "D:\\wt\\toodo\\feat-add-login-1",
      worktreeMissing: true,
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [missing] });
    await renderWorkspace();

    expect(await screen.findByRole("button", { name: "Restore worktree of #1" })).toBeInTheDocument();
  });

  it("shows why a task could not be started", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Add login")] });
    mocked.startTask.mockResolvedValue({
      status: "error",
      error: { kind: "invalidInput", message: "worktree root is not set for machine local" },
    });
    await renderWorkspace();

    const start = await screen.findByRole("button", { name: "Start #1" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    expect(await screen.findByRole("alert")).toHaveTextContent("worktree root is not set for machine local");
    expect(within(row("Add login")).getByText("Ready")).toBeInTheDocument();
  });

  it("copies the MCP config for agents", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    await openSettings("Agent access");

    const panel = await screen.findByRole("region", { name: "Agent access" });
    expect(await within(panel).findByLabelText("MCP server URL")).toHaveTextContent("http://127.0.0.1:47615/mcp");
    fireEvent.click(within(panel).getByRole("button", { name: "Copy MCP config" }));
    expect(await within(panel).findByText("Copied the MCP config.")).toBeInTheDocument();
    expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual({
      mcpServers: {
        toodo: {
          type: "http",
          url: "http://127.0.0.1:47615/mcp",
          headers: { Authorization: "Bearer secret" },
        },
      },
    });
  });

  it("tests the MCP connection with the token shown and shows the last rejected agent request", async () => {
    mocked.mcpServerInfo.mockResolvedValue({
      url: "http://127.0.0.1:47615/mcp",
      token: "secret",
      error: null,
      instance: "0123456789ab",
      lastRejection: { reason: "wrong_token", at: Math.floor(Date.now() / 1000) - 120, count: 3 },
    });
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization !== "Bearer secret") return new Response("Toodo MCP: this server does not accept the token.", { status: 401 });
      const body = { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "toodo", title: "Toodo (server instance 0123456789ab)" } } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    onTestFinished(() => void vi.unstubAllGlobals());
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    await openSettings("Agent access");

    const panel = await screen.findByRole("region", { name: "Agent access" });
    expect(await within(panel).findByLabelText("Server instance")).toHaveTextContent("0123456789ab");
    expect(within(panel).getByLabelText("Last rejected agent request")).toHaveTextContent(
      "Last rejected agent request 2 min. ago: a token this server does not accept (old, mistyped, or another server's) (3 since the server started).",
    );
    expect(within(panel).getByRole("button", { name: "Copy MCP token for agents" })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Test connection" }));
    expect(await within(panel).findByRole("status", { name: "Connection test" })).toHaveTextContent(
      "Connected: instance 0123456789ab accepts this token.",
    );
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe("/mcp");
    expect(JSON.parse(init?.body as string)).toMatchObject({ method: "initialize" });
  });

  it("shows the tunnels to remote machines", async () => {
    mocked.listMcpTunnels.mockResolvedValue([
      { machine: "devbox", state: "open", error: null },
      { machine: "gpu", state: "retrying", error: "Error: remote port forwarding failed for listen port 47615" },
    ]);
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    await openSettings("Agent access");

    const panel = await screen.findByRole("region", { name: "Agent access" });
    const devbox = await within(panel).findByRole("listitem", { name: "Tunnel to devbox" });
    expect(devbox).toHaveTextContent("Connected");
    const gpu = within(panel).getByRole("listitem", { name: "Tunnel to gpu" });
    expect(gpu).toHaveTextContent("Retrying");
    expect(gpu).toHaveTextContent("remote port forwarding failed");
    expect(screen.getByRole("tab", { name: /^Agent access/ })).toHaveTextContent("1 tunnel retrying");
    expect(screen.getByRole("button", { name: /^Settings/, hidden: true })).toHaveTextContent("1 tunnel retrying");
  });

  it("shows why the MCP server is not running", async () => {
    mocked.mcpServerInfo.mockResolvedValue({
      url: "http://127.0.0.1:47615/mcp",
      token: "secret",
      error: "could not listen on port 47615: address in use",
      instance: "0123456789ab",
      lastRejection: null,
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    await openSettings("Agent access");

    const panel = await screen.findByRole("region", { name: "Agent access" });
    expect(await within(panel).findByRole("alert")).toHaveTextContent("address in use");
    expect(within(panel).queryByRole("button", { name: "Copy MCP config" })).not.toBeInTheDocument();
  });

  it("groups the settings in a dialog that Escape and a click beside it close", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();
    const settings = await screen.findByRole("button", { name: /^Settings/ });
    expect(screen.queryByRole("region", { name: "Backups" })).not.toBeInTheDocument();

    fireEvent.click(settings);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(settings).toHaveAttribute("aria-expanded", "true");
    const general = within(dialog).getByRole("tab", { name: "General" });
    expect(general).toHaveAttribute("aria-selected", "true");
    expect(general).toHaveFocus();
    expect(within(dialog).getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: "Backups" })).toBeInTheDocument();

    fireEvent.keyDown(general, { key: "ArrowDown" });
    const agents = within(dialog).getByRole("tab", { name: "Agent access" });
    expect(agents).toHaveAttribute("aria-selected", "true");
    expect(agents).toHaveFocus();
    expect(within(dialog).getByRole("region", { name: "Agent access" })).toBeVisible();
    expect(within(dialog).queryByRole("region", { name: "General" })).not.toBeInTheDocument();

    fireEvent.keyDown(agents, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(settings).toHaveFocus();

    fireEvent.click(settings);
    fireEvent.click(document.querySelector("[aria-hidden].bg-black\\/40")!);
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("warns while herdr is not running and blocks starting tasks", async () => {
    mocked.herdrStatus.mockResolvedValue({ status: "ok", data: { running: false, version: null } });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Add login")] });
    await renderWorkspace();

    expect(await screen.findByRole("alert")).toHaveTextContent("herdr is not available");
    const start = await screen.findByRole("button", { name: "Start #1" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("title", expect.stringContaining("herdr is not running"));
    expect(screen.getByRole("note", { name: "herdr unavailable for #1" })).toHaveTextContent("start it there");

    mocked.herdrStatus.mockResolvedValue({ status: "ok", data: { running: true, version: "0.9.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start #1" })).toBeEnabled();
    expect(screen.queryByRole("note", { name: "herdr unavailable for #1" })).not.toBeInTheDocument();
  });

  it("saves the worktree root for the machine of the workspace", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [herdr] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.saveMachineSettings.mockImplementation(async (settings) => ({ status: "ok", data: settings }));
    await renderWorkspace(/^herdr/);

    expect(await screen.findByText("Set a worktree root to start tasks on this machine.")).toBeInTheDocument();
    const root = screen.getByLabelText("Worktree root on devbox");
    await waitFor(() => expect(root).toBeEnabled());
    fireEvent.change(root, { target: { value: " /srv/wt " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.queryByText("Set a worktree root to start tasks on this machine.")).not.toBeInTheDocument(),
    );
    // Once set, the root collapses into a summary line with the trimmed path.
    expect(screen.getByText("/srv/wt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change worktree root" })).toBeInTheDocument();
    expect(mocked.getMachineSettings).toHaveBeenCalledWith({ kind: "ssh", label: "devbox" });
    expect(mocked.saveMachineSettings).toHaveBeenCalledWith({
      machine: { kind: "ssh", label: "devbox" },
      worktreeRoot: "/srv/wt",
    });
  });

  it("changes the base branch of the workspace", async () => {
    let saved = toodo;
    mocked.listWorkspaces.mockImplementation(async () => ({ status: "ok", data: [saved] }));
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.listWorkspaceBranches.mockResolvedValue({
      status: "ok",
      data: { names: ["dev", "main", "release"], fetchError: null },
    });
    mocked.updateWorkspace
      .mockResolvedValueOnce({ status: "error", error: { kind: "rejected", message: "task 3 is in review" } })
      .mockImplementation(async (workspace) => {
        saved = workspace;
        return { status: "ok", data: saved };
      });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Change base branch" }));
    const branch = screen.getByLabelText("Base branch", { selector: "select" });
    expect(branch).toHaveValue("main");
    expect(await within(branch).findByRole("option", { name: "release" })).toBeInTheDocument();
    expect(mocked.listWorkspaceBranches).toHaveBeenCalledWith(1);
    const form = screen.getByRole("form", { name: "Base branch" });
    // The unchanged branch cannot be saved.
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(branch, { target: { value: "dev" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("task 3 is in review");

    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Base branch" })).not.toBeInTheDocument());
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(mocked.updateWorkspace).toHaveBeenLastCalledWith({ ...toodo, defaultBaseBranch: "dev" });

    // Discarding keeps the saved branch.
    fireEvent.click(screen.getByRole("button", { name: "Change base branch" }));
    fireEvent.change(screen.getByLabelText("Base branch", { selector: "select" }), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(mocked.updateWorkspace).toHaveBeenCalledTimes(2);
  });

  it("moves a workspace with a Windows path to the Windows host it lives on, keeping its tasks", async () => {
    let saved: Workspace = { ...toodo, pathProblem: "foreign" };
    mocked.listWorkspaces.mockImplementation(async () => ({ status: "ok", data: [saved] }));
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(7, 1, "Kept task")] });
    mocked.listHerdrMachines.mockResolvedValue({ status: "ok", data: [savedMachine("winpc")] });
    mocked.moveWorkspace
      .mockResolvedValueOnce({ status: "error", error: { kind: "external", message: "not a git repository" } })
      .mockImplementation(async (_id, location) => {
        saved = { ...toodo, location, pathProblem: null };
        return { status: "ok", data: saved };
      });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Move workspace" }));
    const form = screen.getByRole("form", { name: "Move toodo" });
    // The form starts at the current location.
    expect(within(form).getByLabelText("Folder")).toHaveValue("C:\\dev\\toodo");
    fireEvent.change(within(form).getByLabelText("Machine"), { target: { value: "winpc" } });
    fireEvent.change(within(form).getByLabelText("Folder"), { target: { value: "D:\\dev\\toodo" } });
    fireEvent.click(within(form).getByRole("button", { name: "Move workspace" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("not a git repository");

    fireEvent.click(within(form).getByRole("button", { name: "Move workspace" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Move toodo" })).not.toBeInTheDocument());
    expect(mocked.moveWorkspace).toHaveBeenLastCalledWith(1, {
      kind: "ssh",
      machine: "winpc",
      path: "D:\\dev\\toodo",
    });
    expect(await screen.findByRole("region", { name: "Machine winpc" })).toBeInTheDocument();
    expect(screen.queryByText("Windows path, not on this server")).not.toBeInTheDocument();
  });

  it("lets agents of the workspace merge their pull requests after checks pass", async () => {
    let saved = toodo;
    mocked.listWorkspaces.mockImplementation(async () => ({ status: "ok", data: [saved] }));
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.updateWorkspace
      .mockResolvedValueOnce({ status: "error", error: { kind: "invalidInput", message: "database is locked" } })
      .mockImplementation(async (workspace) => {
        saved = workspace;
        return { status: "ok", data: saved };
      });
    await renderWorkspace();

    const setting = await screen.findByRole("combobox", { name: "Agent merge" });
    expect(setting).toHaveValue("never");
    expect(within(setting).getByRole("option", { name: "Into main after checks pass" })).toBeInTheDocument();

    fireEvent.change(setting, { target: { value: "afterChecks" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
    // A failed save shows the saved policy again.
    expect(setting).toHaveValue("never");

    fireEvent.change(setting, { target: { value: "afterChecks" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Agent merge" })).toHaveValue("afterChecks"));
    expect(mocked.updateWorkspace).toHaveBeenLastCalledWith({ ...toodo, agentMerge: "afterChecks" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("creates a new base branch from an existing one", async () => {
    let saved = toodo;
    mocked.listWorkspaces.mockImplementation(async () => ({ status: "ok", data: [saved] }));
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.listWorkspaceBranches.mockResolvedValue({
      status: "ok",
      data: { names: ["dev", "main"], fetchError: "git fetch failed: offline" },
    });
    mocked.createWorkspaceBaseBranch.mockImplementation(async (_id, name) => {
      saved = { ...toodo, defaultBaseBranch: name };
      return { status: "ok", data: saved };
    });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Change base branch" }));
    const form = screen.getByRole("form", { name: "Base branch" });
    expect(await within(form).findByText("Could not fetch origin; showing the branches known locally.")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Base branch", { selector: "select" }), {
      target: { value: ":new" },
    });
    const save = within(form).getByRole("button", { name: "Create and save" });
    const name = within(form).getByRole("textbox", { name: "New branch name" });
    expect(save).toBeDisabled();
    // An existing branch is picked from the list instead.
    fireEvent.change(name, { target: { value: "dev" } });
    expect(save).toBeDisabled();
    fireEvent.change(name, { target: { value: " release " } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Start new branch from" }), {
      target: { value: "dev" },
    });
    fireEvent.click(save);

    await waitFor(() => expect(screen.queryByRole("form", { name: "Base branch" })).not.toBeInTheDocument());
    expect(mocked.createWorkspaceBaseBranch).toHaveBeenCalledWith(1, "release", "dev");
    expect(await screen.findByText("release")).toBeInTheDocument();
    expect(mocked.updateWorkspace).not.toHaveBeenCalled();
  });

  it("locks the base branch while a task of the workspace is in review", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(3, 1, "Login", { status: "in_review" }), task(4, 2, "Other", { status: "in_review" })],
    });
    await renderWorkspace();

    expect(await screen.findByText("Locked while #3 is awaiting completion")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change base branch" })).toBeDisabled();
  });

  it("warns when a started task's branch is behind its base or conflicts with it", async () => {
    const worktree = { branch: "feat/x", worktreePath: "D:\\wt\\toodo\\x", herdrWorkspaceId: "w1" };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Behind", { status: "in_progress", ...worktree }),
        task(2, 1, "Conflicting", {
          status: "in_review",
          ...worktree,
          pullRequestUrl: "https://github.com/acme/toodo/pull/2",
        }),
        task(3, 1, "Fresh", { status: "in_progress", ...worktree }),
      ],
    });
    mocked.branchFreshness.mockImplementation((id) =>
      Promise.resolve({
        status: "ok",
        data: {
          base: "origin/main",
          behind: id === 3 ? 0 : 3,
          fetchError: null,
          mergeable: id === 2 ? "conflicting" : null,
          mergeableError: null,
        },
      }),
    );
    await renderWorkspace();

    expect(await screen.findByRole("note", { name: "Base freshness of #1" })).toHaveTextContent(
      "3 commits behind origin/main",
    );
    expect(await screen.findByRole("note", { name: "Base freshness of #2" })).toHaveTextContent(
      "3 commits behind origin/main; pull request has merge conflicts",
    );
    expect(screen.queryByRole("note", { name: "Base freshness of #3" })).not.toBeInTheDocument();
    expect(mocked.branchFreshness).toHaveBeenCalledWith(3);
  });

  it("rechecks base freshness and marks warned tasks on the timeline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const started = { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + 3600 };
    const worktree = { branch: "feat/x", worktreePath: "D:\\wt\\toodo\\x", herdrWorkspaceId: "w1", milestones: started };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Behind", { status: "in_progress", ...worktree }),
        task(2, 1, "Conflicting", { status: "in_progress", ...worktree }),
        task(3, 1, "Waiting", { dependsOn: [1], milestones: { ...started, startedAt: null } }),
      ],
    });
    let synced = false;
    mocked.branchFreshness.mockImplementation((id) =>
      Promise.resolve({
        status: "ok",
        data: {
          base: "origin/main",
          behind: id === 1 && synced ? 0 : 3,
          fetchError: null,
          mergeable: id === 2 ? "conflicting" : null,
          mergeableError: null,
        },
      }),
    );
    await renderWorkspace();

    expect(await screen.findByRole("note", { name: "Base freshness of #1" })).toHaveTextContent(
      "3 commits behind origin/main",
    );
    // The branch was synced outside Toodo; rechecking clears the warning without waiting.
    const details = await openDetails("Behind");
    synced = true;
    fireEvent.click(within(details).getByRole("button", { name: "Recheck base freshness of #1" }));
    await waitFor(() =>
      expect(screen.queryByRole("note", { name: "Base freshness of #1" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("note", { name: "Base freshness of #2" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bars = timeline.querySelector(".react-flow__nodes") as HTMLElement;
    expect(
      await within(bars).findByRole("img", {
        name: "Warnings of #2: 3 commits behind origin/main; pull request has merge conflicts",
      }),
    ).toHaveAttribute("data-severe", "true");
    expect(within(bars).getByRole("img", { name: "Warnings of #3: Waiting on #1" })).not.toHaveAttribute(
      "data-severe",
    );
    expect(within(bars).queryByRole("img", { name: /^Warnings of #1/ })).not.toBeInTheDocument();
  });

  it("records commits, opens a pull request, and completes the task once it is merged", async () => {
    const started = task(1, 1, "Add login", {
      status: "in_progress",
      criteria: [criterion(1, "Pull request merged into the base branch", { kind: "pr_merged" })],
      branch: "feat/add-login-1",
      worktreePath: "D:\\wt\\toodo\\feat-add-login-1",
      herdrWorkspaceId: "w27",
    });
    const first = commit(1, "1111111aaaa", "Add login form\n\nWith validation");
    const second = commit(1, "2222222bbbb", "Fix login redirect");
    const pr = "https://github.com/acme/toodo/pull/12";
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    mocked.refreshCommitRecords.mockResolvedValue({ status: "ok", data: [first] });
    await renderWorkspace();

    // The details sheet offers every action of the task as a button.
    const details = await openDetails("Add login");
    fireEvent.click(within(details).getByRole("button", { name: "Refresh commits of #1" }));
    const commits = await within(details).findByRole("list", { name: "Commits of #1" });
    expect(within(commits).getByText("1111111")).toBeInTheDocument();
    expect(within(commits).getByText("Add login form")).toBeInTheDocument();
    expect(mocked.refreshCommitRecords).toHaveBeenCalledWith(1);

    expect(screen.queryByRole("button", { name: "Complete #1" })).not.toBeInTheDocument();
    const inReview = { ...started, status: "in_review" as const, pullRequestUrl: pr };
    mocked.openPullRequest.mockResolvedValue({ status: "ok", data: inReview });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [inReview] });
    mocked.listCommitRecords.mockResolvedValue({ status: "ok", data: [first, second] });
    fireEvent.click(within(details).getByRole("button", { name: "Open pull request for #1" }));

    expect(await within(details).findByText(pr)).toBeInTheDocument();
    expect(within(row("Add login")).getByText("Awaiting completion")).toBeInTheDocument();
    expect(await within(details).findByText("Fix login redirect")).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Push #1 to its pull request" })).toBeInTheDocument();
    expect(mocked.openPullRequest).toHaveBeenCalledWith(1);

    // Complete waits until every criterion is met, here once the merge is seen.
    expect(within(details).getByRole("button", { name: "Complete #1" })).toBeDisabled();
    const merged = { ...inReview, criteria: inReview.criteria.map((each) => ({ ...each, state: "met" as const })) };
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [merged] });
    const [[onTasksChanged]] = mockedEvents.tasksChanged.listen.mock.calls;
    act(() => {
      onTasksChanged({ event: "tasks-changed", id: 1, payload: { workspaceId: 1 } });
    });
    await waitFor(() => expect(within(details).getByRole("button", { name: "Complete #1" })).toBeEnabled());

    const done = { ...merged, status: "done" as const };
    mocked.completeTask.mockResolvedValue({ status: "ok", data: done });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    fireEvent.click(within(details).getByRole("button", { name: "Complete #1" }));

    expect(await within(details).findByText("Done")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Tasks" })).getByRole("button", { name: "Done 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete #1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Push #1 to its pull request" })).not.toBeInTheDocument();
    expect(mocked.completeTask).toHaveBeenCalledWith(1);
  });

  it("shows why a pull request could not be opened", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add login", { status: "in_progress", branch: "feat/add-login-1", worktreePath: "D:\\wt\\x" })],
    });
    mocked.openPullRequest.mockResolvedValue({
      status: "error",
      error: { kind: "rejected", message: "branch feat/add-login-1 has no commits that are not on main" },
    });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Open pull request for #1" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("has no commits that are not on main");
    expect(within(row("Add login")).getByText("In progress")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open pull request for #1" })).toBeEnabled();
  });

  it("shows why a task could not be completed", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add login", {
          status: "in_review",
          branch: "feat/add-login-1",
          worktreePath: "D:\\wt\\x",
          pullRequestUrl: "https://github.com/acme/toodo/pull/12",
        }),
      ],
    });
    mocked.completeTask.mockResolvedValue({
      status: "error",
      error: { kind: "rejected", message: "pull request https://github.com/acme/toodo/pull/12 is not merged yet" },
    });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Complete #1" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("is not merged yet");
    expect(within(row("Add login")).getByText("Awaiting completion")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete #1" })).toBeEnabled();
  });

  it("checks a manual criterion with evidence and unchecks it", async () => {
    const docs = criterion(7, "Docs reviewed");
    const started = task(1, 1, "Add search", { status: "in_progress", criteria: [docs] });
    const checked = {
      ...started,
      criteria: [{ ...docs, state: "met" as const, evidence: "Read by Ada", checkedBy: "user" as const, checkedAt: 1760000000 }],
    };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    mocked.checkCriterion.mockResolvedValue({ status: "ok", data: checked });
    await renderWorkspace();

    const details = await openDetails("Add search");
    const criteria = within(details).getByRole("list", { name: "Criteria of #1" });
    const box = () => within(criteria).getByRole("checkbox", { name: "Check criterion 7 of #1" });
    expect(box()).not.toBeChecked();
    fireEvent.click(box());
    // Checking asks for the evidence before anything is saved.
    expect(mocked.checkCriterion).not.toHaveBeenCalled();
    fireEvent.change(within(criteria).getByLabelText("Evidence for criterion 7"), {
      target: { value: " Read by Ada " },
    });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [checked] });
    fireEvent.click(within(criteria).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(within(criteria).queryByLabelText("Evidence for criterion 7")).not.toBeInTheDocument());
    expect(mocked.checkCriterion).toHaveBeenCalledWith(1, 7, true, "Read by Ada");
    expect(box()).toBeChecked();
    expect(within(criteria).getByText(/^Read by Ada · Checked by you/)).toBeInTheDocument();

    // Unchecking saves right away.
    mocked.checkCriterion.mockResolvedValue({ status: "ok", data: started });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    fireEvent.click(box());

    await waitFor(() => expect(box()).not.toBeChecked());
    expect(mocked.checkCriterion).toHaveBeenLastCalledWith(1, 7, false, null);
  });

  it("marks a failed manual criterion as failed beside its checkbox", async () => {
    const failed = task(1, 1, "Add search", {
      status: "in_progress",
      criteria: [
        criterion(7, "Docs reviewed", { state: "failed", checkedBy: "user", checkedAt: 1760000000 }),
        criterion(8, "Demo recorded"),
      ],
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [failed] });
    await renderWorkspace();

    // The row counts the failure; the details sheet marks the criterion.
    await within(await taskList()).findByRole("button", { name: "Add search" });
    expect(row("Add search")).toHaveTextContent("0/2 criteria met1 failed");
    const details = await openDetails("Add search");
    const criteria = within(details).getByRole("list", { name: "Criteria of #1" });
    const [failedItem, pendingItem] = within(criteria).getAllByRole("listitem");
    expect(within(failedItem).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(within(failedItem).getByRole("checkbox")).not.toBeChecked();
    expect(within(pendingItem).queryByRole("img")).not.toBeInTheDocument();
  });

  it("completes a task whose criteria are all met with the enabled green Complete button", async () => {
    const met = { state: "met" as const, checkedAt: 1760000000 };
    const awaiting = task(1, 1, "Add search", {
      status: "in_review",
      criteria: [
        criterion(1, "Branch merged into the base branch locally", {
          ...met,
          kind: "branch_merged_locally",
          checkedBy: "toodo",
        }),
        criterion(2, "Docs reviewed", { ...met, checkedBy: "user", evidence: "Read by Ada" }),
      ],
    });
    const done = { ...awaiting, status: "done" as const, resolution: "merged" as const };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [awaiting] });
    mocked.completeTask.mockResolvedValue({ status: "ok", data: done });
    await renderWorkspace();

    const tasks = await taskList();
    expect(within(row("Add search")).getByText("Awaiting completion")).toBeInTheDocument();
    const complete = within(tasks).getByRole("button", { name: "Complete #1" });
    expect(complete).toBeEnabled();
    expect(complete).toHaveClass("bg-emerald-100");
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    fireEvent.click(complete);

    expect(await within(tasks).findByRole("button", { name: "Done 1" })).toBeInTheDocument();
    expect(mocked.completeTask).toHaveBeenCalledWith(1);
    expect(within(tasks).queryByRole("button", { name: "Complete #1" })).not.toBeInTheDocument();
  });

  it("shows which pull request of another task shipped a done task", async () => {
    const url = "https://github.com/acme/toodo/pull/12";
    const batch = task(1, 1, "Add login", { status: "done", resolution: "merged", pullRequestUrl: url });
    const extra = task(2, 1, "Fix typo", {
      status: "done",
      resolution: "merged",
      mergedWith: { taskId: 1, pullRequestUrl: url },
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [batch, extra] });
    mocked.listCommitRecords.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 2" }));
    let details = await openDetails("Fix typo");
    const shipped = within(details).getByLabelText("Shipped with pull request of #2");
    expect(shipped).toHaveTextContent(url);
    expect(shipped.parentElement).toHaveTextContent(`Shipped with${url}Pull request of #1`);
    details = await openDetails("Add login");
    expect(within(details).queryByLabelText("Shipped with pull request of #1")).not.toBeInTheDocument();
  });

  it("asks for a completion note on a done task and saves it", async () => {
    const done = task(1, 1, "Add login", {
      status: "done",
      branch: "feat/add-login-1",
      pullRequestUrl: "https://github.com/acme/toodo/pull/12",
      pullRequest: {
        number: 12,
        title: "Add login",
        additions: 120,
        deletions: 30,
        changedFiles: 4,
        mergeCommitSha: "abc123",
        reviewCount: 2,
        reviewerCount: 1,
        firstReviewedAt: 1700000000,
      },
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    mocked.listCommitRecords.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    const details = await openDetails("Add login");
    expect(within(details).getByLabelText("Pull request of #1")).toHaveTextContent("#12, +120/-30 in 4 files, 2 reviews");
    await chooseAction(1, "Add completion note to #1", details);
    const save = within(details).getByRole("button", { name: "Save note" });
    expect(save).toBeDisabled();

    const noted = { ...done, completionNote: "Cut sign-in time in half" };
    mocked.setCompletionNote.mockResolvedValue({ status: "ok", data: noted });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [noted] });
    fireEvent.change(screen.getByRole("textbox", { name: "Completion note for #1" }), {
      target: { value: "Cut sign-in time in half" },
    });
    fireEvent.click(save);

    expect(await screen.findByLabelText("Completion note of #1")).toHaveTextContent("Cut sign-in time in half");
    expect(screen.queryByRole("textbox", { name: "Completion note for #1" })).not.toBeInTheDocument();
    expect(mocked.setCompletionNote).toHaveBeenCalledWith(1, "Cut sign-in time in half");
  });

  it("shows work completed without a pull request and its ready dependent", async () => {
    const shipped = task(1, 1, "Deploy configuration", {
      status: "done", resolution: "completed", completionNote: "Deployed directly",
    });
    const dependent = task(2, 1, "Verify configuration", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [shipped, dependent] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));

    expect(within(row("Deploy configuration")).getByText("Completed")).toBeInTheDocument();
    expect(within(row("Verify configuration")).getByText("Ready")).toBeInTheDocument();
  });

  it("shows pull request snapshots and research conclusions in the year in review", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 14, 10));
    const at = new Date(2026, 5, 1, 15).getTime() / 1000;
    const pullRequest = (number: number, additions: number, reviewCount: number) => ({
      number,
      title: `Pull request ${number}`,
      additions,
      deletions: 10,
      changedFiles: 3,
      mergeCommitSha: null,
      reviewCount,
      reviewerCount: reviewCount,
      firstReviewedAt: null,
    });
    const done = (id: number, title: string, overrides: Partial<Task>) =>
      task(id, 1, title, { status: "done", resolution: "merged", ...overrides });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.reviewPeriod.mockResolvedValue({
      status: "ok",
      data: [
        done(1, "Add login", { pullRequest: pullRequest(11, 40, 2) }),
        done(2, "Rewrite storage", { pullRequest: pullRequest(12, 400, 0) }),
        done(3, "Try a cache", { taskType: "rnd", resolution: "not_adopted", completionNote: "Twice as slow" }),
      ].map((task) => ({ task, outcome: "completed" as const, at, commits: [] })),
    });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByRole("region", { name: "Summary" });
    expect(screen.queryByText("Year in review")).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("group", { name: "Review period" })).getByRole("button", { name: "Year" }));

    const year = (await screen.findByText("Year in review")).closest("section")!;
    expect(year).toHaveAccessibleName("Year in review");
    expect(within(year).getByText("Merged pull requests").nextSibling).toHaveTextContent("2");
    expect(within(year).getByText("Lines changed").nextSibling).toHaveTextContent("+440 / -20");
    expect(within(year).getByText("Reviews").nextSibling).toHaveTextContent("2on 1 of 2");
    const largest = within(within(year).getByRole("list", { name: "Largest pull requests" })).getAllByRole("listitem");
    expect(largest.map((item) => item.textContent)).toEqual([
      "featRewrite storage#12, +400/-10 in 3 files, 0 reviews",
      "featAdd login#11, +40/-10 in 3 files, 2 reviews",
    ]);
    const research = within(year).getByRole("list", { name: "Research conclusions" });
    expect(within(research).getByText("Not adopted")).toBeInTheDocument();
    expect(within(research).getByLabelText("Research conclusion of #3")).toHaveTextContent("Twice as slow");
  });

  it("concludes research without merging and keeps its dependents blocked", async () => {
    const research = task(1, 1, "Try a new cache", {
      taskType: "rnd",
      status: "in_review",
      branch: "rnd/try-a-new-cache-1",
      worktreePath: "D:\\wt\\toodo\\rnd-try-a-new-cache-1",
      herdrWorkspaceId: "w1",
      pullRequestUrl: "https://github.com/acme/toodo/pull/12",
    });
    const dependent = task(2, 1, "Use the new cache", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [research, dependent] });
    await renderWorkspace();

    await chooseAction(1, "Conclude #1 without merging");
    const conclude = screen.getByRole("button", { name: "Conclude without merge" });
    expect(conclude).toBeDisabled();

    const concluded: Task = {
      ...research,
      status: "done",
      resolution: "not_adopted",
      herdrWorkspaceId: null,
      completionNote: "Twice as slow as the current cache",
    };
    mocked.concludeTask.mockResolvedValue({ status: "ok", data: concluded });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [concluded, dependent] });
    fireEvent.change(screen.getByRole("textbox", { name: "Conclusion of #1" }), {
      target: { value: "  Twice as slow as the current cache " },
    });
    fireEvent.click(conclude);

    // Concluded research is done, so it moves to the folded Done section.
    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    expect(mocked.concludeTask).toHaveBeenCalledWith(1, "Twice as slow as the current cache");
    expect(within(row("Try a new cache")).getByText("Not adopted")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Blocked prerequisites of #2" })).toHaveTextContent("#1 not adopted");
    expect(screen.getByRole("button", { name: "Start #2" })).toBeDisabled();
    const details = await openDetails("Try a new cache");
    expect(within(details).getByLabelText("Completion note of #1")).toHaveTextContent(
      "Twice as slow as the current cache",
    );
  });

  it("reopens a done task with a reason and shows it paused and reopened", async () => {
    const done = task(1, 1, "Add login", {
      status: "done",
      resolution: "merged",
      branch: "feat/add-login-1",
      milestones: { plannedAt: 100, startedAt: 200, reviewAt: null, completedAt: 300, reopenedAt: null, pausedAt: null, lastReviewAt: null, activeSeconds: 100, pauseCount: 0 },
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    mocked.listCommitRecords.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    const details = await openDetails("Add login");
    await chooseAction(1, "Reopen #1", details);
    const reopen = within(details).getByRole("button", { name: "Reopen" });
    expect(reopen).toBeDisabled();

    const reopened: Task = {
      ...done,
      status: "planned",
      resolution: null,
      milestones: { ...done.milestones, completedAt: null, reopenedAt: 400, pausedAt: 400 },
    };
    mocked.reopenTask.mockResolvedValue({ status: "ok", data: reopened });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [reopened] });
    fireEvent.change(within(details).getByRole("textbox", { name: "Reason to reopen #1" }), {
      target: { value: " Missed the logout case " },
    });
    fireEvent.click(reopen);

    expect(await within(details).findByRole("button", { name: "Resume #1" })).toBeInTheDocument();
    expect(mocked.reopenTask).toHaveBeenCalledWith(1, "Missed the logout case");
    expect(within(details).getByLabelText("Timeline of #1")).toHaveTextContent("Reopened");
  });

  it("corrects the outcome of a done task with a note", async () => {
    const done = task(1, 1, "Add login", { status: "done", resolution: "merged" });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    mocked.listCommitRecords.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    const details = await openDetails("Add login");
    await chooseAction(1, "Change outcome of #1", details);
    const outcome = within(details).getByRole("combobox", { name: "New outcome of #1" });
    expect(within(outcome).queryByRole("option", { name: "Merged" })).not.toBeInTheDocument();

    const corrected: Task = { ...done, resolution: "not_adopted", completionNote: "Reverted the next day" };
    mocked.setTaskOutcome.mockResolvedValue({ status: "ok", data: corrected });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [corrected] });
    fireEvent.change(outcome, { target: { value: "not_adopted" } });
    fireEvent.change(within(details).getByRole("textbox", { name: "Outcome note of #1" }), {
      target: { value: "Reverted the next day" },
    });
    fireEvent.click(within(details).getByRole("button", { name: "Change outcome" }));

    expect(await within(details).findByLabelText("Completion note of #1")).toHaveTextContent("Reverted the next day");
    expect(mocked.setTaskOutcome).toHaveBeenCalledWith(1, "not_adopted", "Reverted the next day");
  });

  it("completes an active task as shipped by another task from the Conclude form", async () => {
    const batch = task(1, 1, "Add login", { status: "done", resolution: "completed" });
    const planned = task(3, 1, "Add logout");
    const extra = task(2, 1, "Fix typo", {
      status: "in_progress",
      branch: "fix/fix-typo-2",
      worktreePath: "D:\\wt\\toodo\\fix-fix-typo-2",
      herdrWorkspaceId: "w2",
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [batch, extra, planned] });
    await renderWorkspace();

    await chooseAction(2, "Conclude #2 without merging");
    fireEvent.click(screen.getByRole("button", { name: "Complete #2 as shipped by another task or pull request" }));
    const shipper = screen.getByRole("combobox", { name: "Task that shipped #2" });
    // Only work that shipped can be named.
    expect(within(shipper).queryByRole("option", { name: "#3 Add logout" })).not.toBeInTheDocument();

    const done: Task = {
      ...extra,
      status: "done",
      resolution: "completed",
      herdrWorkspaceId: null,
      mergedWith: { taskId: 1, pullRequestUrl: null },
    };
    mocked.completeTaskMergedWith.mockResolvedValue({ status: "ok", data: done });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [batch, done, planned] });
    mocked.listCommitRecords.mockResolvedValue({ status: "ok", data: [] });
    fireEvent.change(shipper, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete as shipped" }));

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 2" }));
    expect(mocked.completeTaskMergedWith).toHaveBeenCalledWith(2, 1, null);
    const details = await openDetails("Fix typo");
    expect(within(details).getByLabelText("Shipped with task of #2")).toHaveTextContent("#1");
  });

  it("adds and removes task dependencies", async () => {
    const storage = task(1, 1, "Add storage");
    const ui = task(2, 1, "Add UI");
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [storage, ui] });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "added" });
    await renderWorkspace();

    const details = await openDetails("Add UI");
    const add = within(details).getByRole("combobox", { name: "Add dependency to #2" });
    expect(within(add).getByRole("option", { name: "#1 Add storage" })).toBeInTheDocument();
    expect(within(add).queryByRole("option", { name: "#2 Add UI" })).not.toBeInTheDocument();
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [storage, { ...ui, status: "planned", dependsOn: [1] }],
    });
    fireEvent.change(add, { target: { value: "1" } });

    const remove = await within(details).findByRole("button", { name: "Remove dependency #1 from #2" });
    expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, false);
    expect(within(details).getByRole("button", { name: "Start #2" })).toBeDisabled();
    mocked.removeDependency.mockResolvedValue({ status: "ok", data: null });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [storage, ui] });
    fireEvent.click(remove);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove dependency #1 from #2" })).not.toBeInTheDocument(),
    );
    expect(mocked.removeDependency).toHaveBeenCalledWith(2, 1);
  });

  it("shows why a dependency was rejected", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(2, 1, "Add UI", { status: "planned", dependsOn: [1] })],
    });
    mocked.addDependency.mockResolvedValue({
      status: "error",
      error: { kind: "rejected", message: "dependency would create a cycle: #1 -> #2 -> #1" },
    });
    await renderWorkspace();

    const details = await openDetails("Add storage");
    fireEvent.change(within(details).getByRole("combobox", { name: "Add dependency to #1" }), {
      target: { value: "2" },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("would create a cycle");
    expect(mocked.addDependency).toHaveBeenCalledWith(1, 2, false);
    expect(screen.queryByRole("combobox", { name: "Add dependency to #2" })).not.toBeInTheDocument();
  });

  it("edits the type, title, and description of a task", async () => {
    const original = task(1, 1, "Add login", {
      description: "old",
      estimate: { unit: "hours", amount: 3 },
      dueDate: "2026-11-01",
    });
    const edited = { ...original, taskType: "fix" as const, title: "Add sign-in", description: "new" };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: edited });
    await renderWorkspace();

    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    fireEvent.change(within(form).getByLabelText("Type of #1"), { target: { value: "fix" } });
    fireEvent.change(within(form).getByLabelText("Title of #1"), { target: { value: "  Add sign-in " } });
    fireEvent.change(within(form).getByLabelText("Description of #1"), { target: { value: " new " } });
    expect(within(form).getByLabelText("Estimate of #1")).toHaveValue("3");
    fireEvent.change(within(form).getByLabelText("Estimate of #1"), { target: { value: "" } });
    fireEvent.change(within(form).getByLabelText("Due date of #1"), { target: { value: "2026-12-01" } });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [edited] });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Add sign-in")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();
    expect(mocked.updateTask).toHaveBeenCalledWith({
      id: 1,
      taskType: "fix",
      title: "Add sign-in",
      description: "new",
      estimate: null,
      dueDate: "2026-12-01",
      criteria: null,
      mergeCriterion: false,
    });
  });

  it("puts the merge criterion back on a task without one and removes it again", async () => {
    const bare = task(1, 1, "Add search", { criteria: [criterion(4, "Docs reviewed")] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [bare] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: bare });
    await renderWorkspace();

    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    const merge = within(form).getByLabelText("Done when merged, #1");
    expect(merge).not.toBeChecked();
    fireEvent.click(merge);
    const merged = task(1, 1, "Add search", {
      criteria: [criterion(3, "Pull request merged into the base branch", { kind: "pr_merged" }), criterion(4, "Docs reviewed")],
    });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [merged] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: merged });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument());
    expect(mocked.updateTask).toHaveBeenCalledWith(expect.objectContaining({ criteria: null, mergeCriterion: true }));

    mocked.updateTask.mockClear();
    await chooseAction(1, "Edit #1");
    const again = screen.getByRole("form", { name: "Edit task #1" });
    const checked = within(again).getByLabelText("Done when merged, #1");
    expect(checked).toBeChecked();
    fireEvent.click(checked);
    fireEvent.click(within(again).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocked.updateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          criteria: [{ id: 4, text: "Docs reviewed", kind: "manual", target: null }],
          mergeCriterion: false,
        }),
      ),
    );
  });

  it("edits the criteria of a task and keeps the existing ones by ID", async () => {
    const original = task(1, 1, "Add search", {
      criteria: [
        criterion(3, "Pull request merged into the base branch", { kind: "pr_merged" }),
        criterion(4, "Docs reviewed"),
      ],
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: original });
    await renderWorkspace();

    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    // The merge criterion keeps its kind.
    expect(within(form).getByLabelText("Criterion 1 kind of #1")).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Criterion 2 text of #1"), {
      target: { value: "Docs and changelog reviewed" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add criterion to #1" }));
    fireEvent.change(within(form).getByLabelText("Criterion 3 text of #1"), { target: { value: "Search answers" } });
    fireEvent.change(within(form).getByLabelText("Criterion 3 kind of #1"), { target: { value: "url" } });
    fireEvent.change(within(form).getByLabelText("Criterion 3 target of #1"), {
      target: { value: "https://example.com/search" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument());
    expect(mocked.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        criteria: [
          { id: 3, text: "Pull request merged into the base branch", kind: "pr_merged", target: null },
          { id: 4, text: "Docs and changelog reviewed", kind: "manual", target: null },
          { text: "Search answers", kind: "url", target: "https://example.com/search" },
        ],
      }),
    );
  });

  it("asks before discarding unsaved edits of a task", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Add login")] });
    await renderWorkspace();

    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    const title = within(form).getByLabelText("Title of #1");
    await waitFor(() => expect(title).toHaveFocus());
    fireEvent.click(within(form).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();

    await chooseAction(1, "Edit #1");
    const changed = screen.getByRole("form", { name: "Edit task #1" });
    fireEvent.change(within(changed).getByLabelText("Title of #1"), { target: { value: "Add sign-in" } });
    fireEvent.keyDown(within(changed).getByLabelText("Title of #1"), { key: "Escape" });
    const confirm = within(changed).getByRole("group", { name: "Discard changes to #1" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(within(changed).getByLabelText("Title of #1")).toHaveValue("Add sign-in");

    fireEvent.click(within(changed).getByRole("button", { name: "Discard" }));
    fireEvent.click(within(changed).getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();
    expect(mocked.updateTask).not.toHaveBeenCalled();
  });

  it("closes inline forms on Escape and asks before discarding what was typed", async () => {
    const started = task(1, 1, "Try a new cache", {
      status: "in_progress",
      branch: "feat/try-a-new-cache-1",
      worktreePath: "D:\\wt\\toodo\\feat-try-a-new-cache-1",
      herdrWorkspaceId: "w1",
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    const finished = task(2, 1, "Add storage", { status: "done", resolution: "merged" });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started, finished] });
    await renderWorkspace();

    await chooseAction(1, "Link issue to #1");
    fireEvent.keyDown(screen.getByLabelText("Issue number of #1"), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Issue form of #1" })).not.toBeInTheDocument();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    // The details sheet keeps the note mounted while its form is closed.
    const details = await openDetails("Add storage");
    await chooseAction(2, "Add completion note to #2", details);
    fireEvent.change(screen.getByLabelText("Completion note for #2"), { target: { value: "Shipped" } });
    fireEvent.keyDown(screen.getByLabelText("Completion note for #2"), { key: "Escape" });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Discard note of #2" })).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(screen.queryByRole("form", { name: "Completion note form of #2" })).not.toBeInTheDocument();
    // Opened again, the form starts out empty instead of asking.
    await chooseAction(2, "Add completion note to #2", details);
    expect(screen.getByLabelText("Completion note for #2")).toHaveValue("");
    expect(screen.queryByRole("group", { name: "Discard note of #2" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Completion note for #2"), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Completion note form of #2" })).not.toBeInTheDocument();

    await chooseAction(1, "Conclude #1 without merging");
    const conclusion = screen.getByRole("textbox", { name: "Conclusion of #1" });
    fireEvent.change(conclusion, { target: { value: "Twice as slow" } });
    fireEvent.keyDown(conclusion, { key: "Escape" });
    const question = screen.getByRole("group", { name: "Discard conclusion of #1" });
    expect(within(question).getByRole("button", { name: "Keep editing" })).toHaveFocus();
    // A second Escape goes back to the form with the text kept.
    fireEvent.keyDown(within(question).getByRole("button", { name: "Keep editing" }), { key: "Escape" });
    expect(screen.getByRole("textbox", { name: "Conclusion of #1" })).toHaveValue("Twice as slow");
    expect(screen.getByRole("textbox", { name: "Conclusion of #1" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("form", { name: "Conclude #1" })).not.toBeInTheDocument();
    expect(mocked.concludeTask).not.toHaveBeenCalled();
  });

  it("opens the phone menu as a modal drawer and returns focus when it closes", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    const open = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(open);
    const menu = screen.getByRole("dialog", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-modal", "true");
    expect(within(menu).getByRole("button", { name: "Close menu" })).toHaveFocus();
    expect(open.closest("[inert]")).not.toBeNull();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
    expect(open.closest("[inert]")).toBeNull();
    expect(open).toHaveFocus();
  });

  it("keeps the timeline details open while its edit form has unsaved changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const planned = { ...task(0, 1, "").milestones, plannedAt: new Date(2026, 5, 1).getTime() / 1000 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add UI", { milestones: planned }), task(2, 1, "Write docs", { milestones: planned })],
    });
    await renderWorkspace();
    await taskList();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bar = (title: string) =>
      within(timeline.querySelector(".react-flow__nodes") as HTMLElement)
        .getByText(title)
        .closest(".react-flow__node") as HTMLElement;
    await within(timeline).findByText("Add UI");

    fireEvent.click(bar("Add UI"));
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    await chooseAction(1, "Edit #1", details);
    const field = within(details).getByLabelText("Title of #1");
    fireEvent.change(field, { target: { value: "Add the UI" } });

    // Escape in a field belongs to the form, which asks about its changes; the sheet stays.
    fireEvent.keyDown(field, { key: "Escape" });
    const formConfirm = within(details).getByRole("group", { name: "Discard changes to #1" });
    expect(within(timeline).getByRole("complementary", { name: "Task details" })).toBeInTheDocument();
    fireEvent.click(within(formConfirm).getByRole("button", { name: "Keep editing" }));

    fireEvent.click(within(details).getByRole("button", { name: "Close details" }));
    const unsaved = within(details).getByRole("group", { name: "Unsaved changes" });
    fireEvent.click(bar("Write docs"));
    expect(within(details).getByLabelText("Title of #1")).toHaveValue("Add the UI");
    fireEvent.click(within(unsaved).getByRole("button", { name: "Keep editing" }));
    expect(within(details).queryByRole("group", { name: "Unsaved changes" })).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(
      within(within(details).getByRole("group", { name: "Unsaved changes" })).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() =>
      expect(within(timeline).queryByRole("complementary", { name: "Task details" })).not.toBeInTheDocument(),
    );
  });

  it("previews a Markdown description and shows its plain text in the list", async () => {
    const original = task(1, 1, "Add login", { description: "## Steps\n\n- [x] **form**" });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    await renderWorkspace();

    // The row previews the first paragraph; the heading above it is left out.
    await within(await taskList()).findByRole("button", { name: "Add login" });
    expect(within(row("Add login")).getByText("form")).toBeInTheDocument();
    expect(within(row("Add login")).queryByText(/Steps/)).not.toBeInTheDocument();
    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    fireEvent.click(within(form).getByRole("button", { name: "Preview" }));

    const preview = within(form).getByRole("region", { name: "Preview of Description of #1" });
    expect(await within(preview).findByRole("heading", { name: "Steps" })).toBeInTheDocument();
    expect(within(preview).getByRole("img", { name: "Done" })).toBeInTheDocument();
    expect(within(form).queryByLabelText("Description of #1")).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Write" }));
    expect(within(form).getByLabelText("Description of #1")).toHaveValue("## Steps\n\n- [x] **form**");
  });

  it("waits to resume a task in progress that got a prerequisite", async () => {
    const fix = task(1, 1, "Fix login");
    const started = task(2, 1, "Verify login", {
      status: "in_progress",
      branch: "test/verify-login-2",
      worktreePath: "D:\\wt\\toodo\\test-verify-login-2",
      herdrWorkspaceId: "w27",
      milestones: { ...task(2, 1, "").milestones, plannedAt: 1760000000, startedAt: 1760100000 },
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [fix, started] });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "confirm_pause" });
    await renderWorkspace();

    const details = await openDetails("Verify login");
    const add = within(details).getByRole("combobox", { name: "Add dependency to #2" });
    fireEvent.change(add, { target: { value: "1" } });
    const confirmation = await screen.findByRole("group", { name: "Confirm prerequisite of #2" });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "added" });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [fix, { ...started, status: "planned", herdrWorkspaceId: null, dependsOn: [1] }],
    });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Pause and add" }));

    expect(await within(details).findByRole("note", { name: "Waiting prerequisites of #2" })).toHaveTextContent(
      "Waiting on #1",
    );
    expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, true);
    expect(within(details).getByRole("button", { name: "Resume #2" })).toBeDisabled();
    expect(within(row("Verify login")).getByRole("note", { name: "Waiting prerequisites of #2" })).toBeInTheDocument();
  });

  it("asks whether to close the herdr workspace of a task an agent paused", async () => {
    const fix = task(1, 1, "Fix login");
    const started = task(2, 1, "Verify login", {
      status: "in_progress",
      branch: "test/verify-login-2",
      worktreePath: "D:\\wt\\toodo\\test-verify-login-2",
      herdrWorkspaceId: "w27",
      milestones: { ...task(2, 1, "").milestones, plannedAt: 1760000000, startedAt: 1760100000 },
    });
    const paused = { ...started, status: "planned" as const, dependsOn: [1] };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [fix, started] });
    mocked.closeTaskWorkspace.mockImplementation(async () => {
      mocked.listTasks.mockResolvedValue({ status: "ok", data: [fix, { ...paused, herdrWorkspaceId: null }] });
      return { status: "ok", data: { ...paused, herdrWorkspaceId: null } };
    });
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await renderWorkspace();
    await within(await taskList()).findByRole("button", { name: "Verify login" });

    // An agent adds the prerequisite through MCP, which leaves the workspace open.
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [fix, paused] });
    const [[onTasksChanged]] = mockedEvents.tasksChanged.listen.mock.calls;
    act(() => {
      onTasksChanged({ event: "tasks-changed", id: 1, payload: { workspaceId: 1 } });
    });

    const note = await screen.findByRole("group", { name: "Herdr workspace of paused #2" });
    await waitFor(() =>
      expect(sendNotification).toHaveBeenCalledWith({
        title: "Task paused by a new prerequisite",
        body: "#2 Verify login: close its herdr workspace?",
      }),
    );
    fireEvent.click(within(note).getByRole("button", { name: "Keep herdr workspace of #2 open" }));
    expect(screen.queryByRole("group", { name: "Herdr workspace of paused #2" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close herdr workspace of #2" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Close herdr workspace of #2" })).not.toBeInTheDocument(),
    );
    expect(mocked.closeTaskWorkspace).toHaveBeenCalledWith(2);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    focus.mockRestore();
  });

  it("shows which prerequisites a planned task waits on", async () => {
    const done = task(1, 1, "Add storage", { status: "done", resolution: "merged" });
    const open = task(2, 1, "Add login");
    const blocked = task(3, 1, "Verify login", { dependsOn: [1, 2] });
    const ready = task(4, 1, "Add logout", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done, open, blocked, ready] });
    await renderWorkspace();

    const note = await screen.findByRole("note", { name: "Waiting prerequisites of #3" });
    expect(note).toHaveTextContent(/^Waiting on #2$/);
    expect(note).toHaveClass("text-muted-foreground");
    expect(screen.getByRole("button", { name: "Start #3" })).toBeDisabled();
    expect(screen.queryByRole("note", { name: "Waiting prerequisites of #4" })).not.toBeInTheDocument();
  });

  it("focuses the agent pane of a task from the hover card and the task details", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const milestones = { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + 3600 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "in_progress", herdrWorkspaceId: "w27", milestones }),
        task(2, 1, "Add UI", { status: "in_progress", herdrWorkspaceId: "w28", milestones }),
      ],
    });
    mocked.listAgentStatuses.mockResolvedValue([{ taskId: 1, status: "working" }]);
    mocked.focusAgentPane.mockResolvedValue({ status: "ok", data: null });
    renderApp();

    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bar = async (title: string) =>
      (await within(timeline.querySelector(".react-flow__nodes") as HTMLElement).findByText(title)).closest(
        ".react-flow__node",
      ) as HTMLElement;
    await within(timeline).findByLabelText("Agent of #1");

    // A task without an agent offers nothing to focus.
    fireEvent.mouseEnter(await bar("Add UI"));
    const other = await screen.findByRole("tooltip", { name: "Summary of #2" });
    expect(within(other).queryByRole("button", { name: /Focus agent pane/ })).not.toBeInTheDocument();

    fireEvent.mouseEnter(await bar("Add storage"));
    const summary = await screen.findByRole("tooltip", { name: "Summary of #1" });
    fireEvent.click(within(summary).getByRole("button", { name: "Focus agent pane of #1" }));
    await waitFor(() => expect(mocked.focusAgentPane).toHaveBeenCalledWith(1));

    fireEvent.click(await bar("Add storage"));
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    fireEvent.click(within(details).getByRole("button", { name: "Focus agent pane of #1" }));
    await waitFor(() => expect(mocked.focusAgentPane).toHaveBeenCalledTimes(2));
  });

  it("shows related tasks in the details sheet and links and unlinks them", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage"),
        task(2, 1, "Add UI"),
        task(3, 1, "Write docs"),
      ],
    });
    let relations = [{ taskId: 1, relatedId: 2 }];
    mocked.listTaskRelations.mockImplementation(async () => ({
      status: "ok",
      data: structuredClone(relations),
    }));
    mocked.addTaskRelation.mockImplementation(
      async (taskId: number, relatedId: number) => {
        relations = [
          ...relations,
          {
            taskId: Math.min(taskId, relatedId),
            relatedId: Math.max(taskId, relatedId),
          },
        ];
        return { status: "ok", data: null };
      },
    );
    mocked.removeTaskRelation.mockImplementation(
      async (taskId: number, relatedId: number) => {
        relations = relations.filter(
          (relation) =>
            relation.taskId !== Math.min(taskId, relatedId) ||
            relation.relatedId !== Math.max(taskId, relatedId),
        );
        return { status: "ok", data: null };
      },
    );
    renderApp();

    const timeline = await screen.findByRole("region", {
      name: "Task timeline",
    });
    const bar = async (title: string) =>
      (
        await within(
          timeline.querySelector(".react-flow__nodes") as HTMLElement,
        ).findByText(title)
      ).closest(".react-flow__node") as HTMLElement;
    fireEvent.click(await bar("Add storage"));
    const details = await within(timeline).findByRole("complementary", {
      name: "Task details",
    });
    const related = await within(details).findByRole("list", {
      name: "Related tasks of #1",
    });
    expect(within(related).getAllByRole("listitem")).toHaveLength(1);

    // A chip opens the related task in the sheet.
    fireEvent.click(
      within(related).getByRole("button", { name: "Open related task #2" }),
    );
    expect(
      await within(details).findByRole("heading", { name: "Add UI" }),
    ).toBeInTheDocument();
    // The link shows from both ends, and a task without links has no Related field.
    expect(
      await within(details).findByRole("list", { name: "Related tasks of #2" }),
    ).toBeInTheDocument();

    fireEvent.click(await bar("Write docs"));
    expect(
      await within(details).findByRole("heading", { name: "Write docs" }),
    ).toBeInTheDocument();
    expect(
      within(details).queryByRole("region", { name: "Related" }),
    ).not.toBeInTheDocument();
    fireEvent.change(within(details).getByLabelText("Add related task to #3"), {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(mocked.addTaskRelation).toHaveBeenCalledWith(3, 1),
    );
    const added = await within(details).findByRole("list", {
      name: "Related tasks of #3",
    });
    fireEvent.click(
      within(added).getByRole("button", {
        name: "Remove related task #1 from #3",
      }),
    );
    await waitFor(() =>
      expect(mocked.removeTaskRelation).toHaveBeenCalledWith(3, 1),
    );
    await waitFor(() =>
      expect(
        within(details).queryByRole("list", { name: "Related tasks of #3" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("gathers tasks needing attention in the sidebar and shows one on the timeline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const milestones = { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + 3600 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "in_progress", herdrWorkspaceId: "w27", milestones }),
        task(2, 1, "Fix redirect", {
          status: "in_review",
          pullRequestUrl: "https://github.com/o/r/pull/2",
          milestones,
        }),
        task(3, 1, "Add UI", {
          status: "in_progress",
          milestones,
          notes: [{ kind: "blocker", body: "Need an account", at: plannedAt + 7200 }],
        }),
        task(4, 1, "Write docs", { milestones: { ...milestones, startedAt: null } }),
      ],
    });
    mocked.listAgentStatuses.mockResolvedValue([{ taskId: 1, status: "blocked" }]);
    mocked.listPullRequestStatuses.mockResolvedValue([{ taskId: 2, checks: "failing", review: "changes_requested" }]);
    mocked.focusAgentPane.mockResolvedValue({ status: "ok", data: null });
    renderApp();

    const attention = await screen.findByRole("region", { name: /Needs attention/ });
    const items = await within(attention).findAllByRole("listitem");
    expect(items.map((item) => [...item.querySelectorAll("[data-reason]")].map((reason) => reason.textContent))).toEqual(
      [["Agent needs input"], ["Blocker"], ["CI failed", "Changes requested"]],
    );
    expect(items[0]).toHaveTextContent("#1Add storage");
    expect(within(items[1]).queryByRole("button", { name: /Focus agent pane/ })).not.toBeInTheDocument();

    fireEvent.click(within(items[0]).getByRole("button", { name: "Focus agent pane of #1" }));
    await waitFor(() => expect(mocked.focusAgentPane).toHaveBeenCalledWith(1));

    // The task shows even from the list view, with a filter hiding it.
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Blocked" }));
    expect(screen.queryByRole("region", { name: "Task timeline" })).not.toBeInTheDocument();
    fireEvent.click(within(items[2]).getByRole("button", { name: /Fix redirect/ }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Fix redirect" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Status filter" })).queryAllByRole("button", { pressed: true })).toHaveLength(0);

    // Once the agent is answered and the pull request fixed, the task leaves the group.
    const [[onAgentStatuses]] = mockedEvents.agentStatusesChanged.listen.mock.calls;
    act(() => {
      onAgentStatuses({ event: "agent-statuses-changed", id: 1, payload: { statuses: [] } });
    });
    await waitFor(() => expect(within(attention).getAllByRole("listitem")).toHaveLength(2));
  });

  it("opens the task a clicked notification asks for and drops it from the address", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const milestones = { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + 3600 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "in_progress", milestones }),
        task(2, 1, "Fix redirect", { status: "in_progress", milestones }),
      ],
    });
    window.history.replaceState(null, "", "/?task=2");

    renderApp();

    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Fix redirect" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("puts a task whose agent reported a blocker under Needs attention and shows every note in the task details", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const noted = task(1, 1, "Add login", {
      status: "in_progress",
      milestones: { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + 3600 },
      notes: [
        { kind: "progress", body: "Chose **PKCE** over the implicit flow", at: plannedAt + 7200 },
        { kind: "blocker", body: "Need a test account for the provider", at: plannedAt + 10800 },
      ],
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [noted, task(2, 1, "Add logout")] });
    await renderWorkspace();

    const tasks = await taskList();
    const attention = within(tasks).getByRole("list", { name: "Needs attention" });
    expect(within(attention).getByRole("button", { name: "Add login" })).toBeInTheDocument();
    expect(within(attention).queryByRole("button", { name: "Add logout" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bars = timeline.querySelector(".react-flow__nodes") as HTMLElement;
    fireEvent.click((await within(bars).findByText("Add login")).closest(".react-flow__node") as HTMLElement);
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    const notes = await within(details).findByRole("list", { name: "Notes of #1" });
    const items = within(notes).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("[data-note-kind]")?.textContent)).toEqual(["Progress", "Blocker"]);
    expect(await within(items[0]).findByText("PKCE")).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("Need a test account for the provider");
  });

  it("asks before a prerequisite pauses a started task, whatever its agent does", async () => {
    const fix = task(1, 1, "Fix login");
    const started = task(2, 1, "Verify login", {
      status: "in_progress",
      branch: "test/verify-login-2",
      worktreePath: "D:\\wt\\toodo\\test-verify-login-2",
      herdrWorkspaceId: "w27",
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [fix, started] });
    mocked.listAgentStatuses.mockResolvedValue([{ taskId: 2, status: "idle" }]);
    // The server decides that the prerequisite pauses the task and asks for confirmation.
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "confirm_pause" });
    await renderWorkspace();
    await screen.findByLabelText("Agent of #2");
    const details = await openDetails("Verify login");
    const add = () => within(details).getByRole("combobox", { name: "Add dependency to #2" });

    fireEvent.change(add(), { target: { value: "1" } });
    const confirmation = await screen.findByRole("group", { name: "Confirm prerequisite of #2" });
    expect(confirmation).toHaveTextContent("Adding #1 as a prerequisite pauses #2");
    // The question takes the place of the dependency row instead of pushing the row down.
    expect(screen.queryByRole("group", { name: "Dependencies of #2" })).not.toBeInTheDocument();
    expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, false);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("group", { name: "Confirm prerequisite of #2" })).not.toBeInTheDocument();
    expect(mocked.addDependency).not.toHaveBeenCalledWith(2, 1, true);

    fireEvent.change(add(), { target: { value: "1" } });
    const again = await screen.findByRole("group", { name: "Confirm prerequisite of #2" });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "added" });
    fireEvent.click(within(again).getByRole("button", { name: "Pause and add" }));
    await waitFor(() => expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, true));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Confirm prerequisite of #2" })).not.toBeInTheDocument(),
    );
  });

  it("pauses a started task, then resumes or deletes it", async () => {
    const started = task(1, 1, "Add login", {
      status: "in_progress",
      branch: "feat/add-login-1",
      worktreePath: "D:\\wt\\toodo\\feat-add-login-1",
      herdrWorkspaceId: "w27",
      milestones: { ...task(1, 1, "").milestones, plannedAt: 1760000000, startedAt: 1760100000 },
    });
    const paused: Task = {
      ...started,
      status: "planned",
      milestones: { ...started.milestones, pausedAt: 1760200000 },
    };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    mocked.pauseTask.mockResolvedValue({ status: "ok", data: paused });
    mocked.deleteTask.mockResolvedValue({ status: "ok", data: null });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "More actions for #1" }));
    const pause = await screen.findByRole("menuitem", { name: "Pause #1" });
    expect(screen.queryByRole("menuitem", { name: "Delete #1" })).not.toBeInTheDocument();
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [paused] });
    fireEvent.click(pause);

    expect(await screen.findByRole("button", { name: "Resume #1" })).toBeEnabled();
    expect(mocked.pauseTask).toHaveBeenCalledWith(1);
    expect(within(row("Add login")).getByText("Paused")).toBeInTheDocument();
    expect(row("Add login")).toHaveTextContent(`Paused ${formatWhen(1760200000)}`);

    // Secondary actions sit in the More menu, Delete last and in the destructive style.
    fireEvent.click(screen.getByRole("button", { name: "More actions for #1" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Show details of #1",
      "Link issue to #1",
      "Edit #1",
      "Delete #1",
    ]);
    expect(items.at(-1)).toHaveClass("text-destructive");
    fireEvent.click(items.at(-1) as HTMLElement);
    expect(mocked.deleteTask).not.toHaveBeenCalled();
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete #1" }));

    expect(await screen.findByText("No tasks in this workspace yet.")).toBeInTheDocument();
    expect(mocked.deleteTask).toHaveBeenCalledWith(1, false);
  });

  it("deletes a task with its worktree, forcing it only after a rejection", async () => {
    const finished = task(1, 1, "Add login", {
      status: "done",
      branch: "feat/add-login-1",
      worktreePath: "D:\\wt\\toodo\\feat-add-login-1",
      herdrWorkspaceId: "w27",
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [finished] });
    mocked.deleteTask
      .mockResolvedValueOnce({
        status: "error",
        error: { kind: "rejected", message: "the worktree of task 1 has modified or untracked files" },
      })
      .mockResolvedValueOnce({ status: "ok", data: null });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    await chooseAction(1, "Delete #1");
    expect(mocked.deleteTask).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Delete #1?" })).toHaveTextContent(
      "Its worktree and herdr workspace are removed; the branch is kept.",
    );
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Remove worktree/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force delete #1" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete #1" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("modified or untracked files");
    expect(mocked.deleteTask).toHaveBeenCalledWith(1, false);
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    fireEvent.click(screen.getByRole("button", { name: "Force delete #1" }));
    expect(screen.getByRole("group", { name: "Delete #1?" })).toHaveTextContent(
      "removed with its modified and untracked files",
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm force delete #1" }));

    expect(await screen.findByText("No tasks in this workspace yet.")).toBeInTheDocument();
    expect(mocked.deleteTask).toHaveBeenLastCalledWith(1, true);
  });

  it("groups the list by status, needs attention first, with done work folded away", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Ship v1", { status: "done", resolution: "merged" }),
        task(2, 1, "Plan docs", { dependsOn: [3] }),
        task(3, 1, "Build API", { status: "in_progress" }),
        task(4, 1, "Fix crash", { status: "in_review", pullRequestUrl: "https://github.com/acme/toodo/pull/4" }),
        task(5, 1, "Add search"),
        task(6, 1, "Add UI", {
          status: "in_progress",
          notes: [{ kind: "blocker", body: "Need an account", at: 1760000000 }],
        }),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    expect(within(tasks).getAllByRole("region").map((section) => section.getAttribute("aria-label"))).toEqual([
      "Needs attention",
      "In progress",
      "Awaiting completion",
      "Ready",
      "Planned",
      "Done",
    ]);
    const titles = (name: string) =>
      within(within(tasks).getByRole("list", { name }))
        .getAllByRole("listitem")
        .map((item) => item.querySelector("[data-task-row] button")?.textContent);
    expect(titles("Needs attention")).toEqual(["Add UI"]);
    expect(titles("In progress")).toEqual(["Build API"]);
    expect(titles("Awaiting completion")).toEqual(["Fix crash"]);
    expect(titles("Ready")).toEqual(["Add search"]);
    expect(titles("Planned")).toEqual(["Plan docs"]);

    const done = within(tasks).getByRole("button", { name: "Done 1" });
    expect(done).toHaveAttribute("aria-expanded", "false");
    expect(within(tasks).queryByRole("list", { name: "Done" })).not.toBeInTheDocument();
    fireEvent.click(done);
    expect(done).toHaveAttribute("aria-expanded", "true");
    expect(titles("Done")).toEqual(["Ship v1"]);
  });

  it("keeps base freshness failures off the rows and checks nothing without an origin", async () => {
    const worktree = { status: "in_progress" as const, branch: "feat/x", worktreePath: "D:\\wt\\toodo\\x", herdrWorkspaceId: "w1" };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Fetch fails", worktree), task(2, 1, "No origin", worktree)],
    });
    mocked.branchFreshness.mockImplementation((id) =>
      Promise.resolve(
        id === 1
          ? { status: "error", error: { kind: "external", message: "git rev-list failed" } }
          : { status: "ok", data: null },
      ),
    );
    await renderWorkspace();

    // The failed check is reported once, in the details, not repeated on the row.
    let details = await openDetails("Fetch fails");
    expect(await within(details).findByRole("note", { name: "Base freshness of #1" })).toHaveTextContent(
      "Could not check whether the branch is behind its base",
    );
    expect(within(await taskList()).queryByText(/Could not check/)).not.toBeInTheDocument();
    expect(within(await taskList()).queryByRole("note", { name: "Base freshness of #1" })).not.toBeInTheDocument();

    details = await openDetails("No origin");
    await waitFor(() => expect(mocked.branchFreshness).toHaveBeenCalledWith(2));
    expect(within(details).queryByRole("note", { name: "Base freshness of #2" })).not.toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "Base freshness of #2" })).not.toBeInTheDocument();
  });
});
