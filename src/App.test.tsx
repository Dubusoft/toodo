import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi, onTestFinished } from "vitest";
import App from "@/App";
import { formatFull, formatWhen } from "@/lib/timeline";
import {
  commands,
  events,
  type CommitRecord,
  type Criterion,
  type ReviewEntry,
  type Task,
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
    checkUpdate: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    listArchive: vi.fn(),
    listGuidelines: vi.fn(),
    addGuideline: vi.fn(),
    updateGuideline: vi.fn(),
    deleteGuideline: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    pauseTask: vi.fn(),
    waitTask: vi.fn(),
    endWait: vi.fn(),
    setCompletionNote: vi.fn(),
    checkCriterion: vi.fn(),
    deleteTask: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    listTaskRelations: vi.fn(),
    addTaskRelation: vi.fn(),
    removeTaskRelation: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
    concludeTask: vi.fn(),
    reopenTask: vi.fn(),
    setTaskOutcome: vi.fn(),
    listBackups: vi.fn(),
    mcpServerInfo: vi.fn(),
    getBackupSettings: vi.fn(),
    getBackupStatus: vi.fn(),
    saveBackupSettings: vi.fn(),
    restoreBackup: vi.fn(),
    reviewPeriod: vi.fn(),
    reviewReport: vi.fn(),
    getReviewTimeZone: vi.fn(),
    setReviewTimeZone: vi.fn(),
    saveReviewSnapshot: vi.fn(),
    listReviewSnapshots: vi.fn(),
    getReviewSnapshot: vi.fn(),
    deleteReviewSnapshot: vi.fn(),
  },
  events: {
    tasksChanged: { listen: vi.fn() },
    workspacesChanged: { listen: vi.fn() },
    guidelinesChanged: { listen: vi.fn() },
  },
}));

const mocked = vi.mocked(commands);
const mockedEvents = vi.mocked(events, { deep: true });

const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const localMidnight = (day: string, days = 0) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date + days).getTime() / 1000;
};
/** What review_period answers for the days `from` to `to`, judged in this machine's time zone. */
const reviewOf = (from: string, to: string, entries: ReviewEntry[]) => ({
  status: "ok" as const,
  data: { from, to, start: localMidnight(from), end: localMidnight(to, 1), timeZone: machineZone, entries },
});

const toodo: Workspace = {
  id: 1,
  name: "toodo",
  description: null,
  repository: "dev-bokdong/toodo",
  archivedAt: null,
};

const herdr: Workspace = {
  id: 2,
  name: "herdr",
  description: null,
  repository: null,
  archivedAt: null,
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
    issue: null,
    estimate: null,
    dueDate: null,
    labels: [],
    refs: [],
    resolution: null,
    completionNote: null,
    notes: [],
    criteria: [],
    wait: null,
    autopilot: false,
    autopilotAt: null,
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

/** Goes one entry back in the browser history and waits for the app to see it. */
async function goBack() {
  await act(async () => {
    const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    window.history.back();
    await popped;
  });
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
  // The timeline, Markdown, the task details, and the review are lazy-loaded; transform them
  // once here so no test pays for that within its timeout.
  beforeAll(async () => {
    await Promise.all([
      import("@/components/task-graph"),
      import("@/components/markdown"),
      import("@/components/task-details"),
      import("@/components/review"),
    ]);
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    // The route lives in the address, which jsdom keeps from one test to the next.
    window.history.replaceState(null, "", "/");
    // jsdom has no matchMedia; the install banner asks whether the app runs installed.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    mocked.appInfo.mockResolvedValue({ name: "toodo", version: "1.2.3" });
    mocked.checkUpdate.mockResolvedValue({ current: "1.2.3", channel: "latest", latest: "1.2.3", newer: false, error: null });
    mocked.listTaskRelations.mockResolvedValue({ status: "ok", data: [] });
    mocked.listBackups.mockResolvedValue({ status: "ok", data: [] });
    mocked.listArchive.mockResolvedValue({ status: "ok", data: { workspaces: [], tasks: [] } });
    mocked.getReviewTimeZone.mockResolvedValue({ status: "ok", data: { timeZone: machineZone, configured: null } });
    mocked.listReviewSnapshots.mockResolvedValue({ status: "ok", data: [] });
    mocked.mcpServerInfo.mockResolvedValue({
      url: "http://127.0.0.1:47615/mcp",
      token: "secret",
      error: null,
      instance: "0123456789ab",
      lastRejection: null,
    });
    mocked.getBackupSettings.mockResolvedValue({ enabled: true, intervalHours: 24, keep: 7, directory: null });
    mocked.getBackupStatus.mockResolvedValue({ lastFailure: null });
    mockedEvents.tasksChanged.listen.mockResolvedValue(() => {});
    mockedEvents.workspacesChanged.listen.mockResolvedValue(() => {});
    mockedEvents.guidelinesChanged.listen.mockResolvedValue(() => {});
    mocked.listGuidelines.mockResolvedValue({ status: "ok", data: [] });
  });

  it("shows the backend version once the app info command resolves", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    renderApp();

    expect(screen.getByRole("heading", { name: "Toodo" })).toBeInTheDocument();
    expect(await screen.findByText("v1.2.3")).toBeInTheDocument();
    expect(await screen.findByText("No workspaces yet.")).toBeInTheDocument();
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

  it("names reviewed tasks without a plan and adds an estimate from the review", async () => {
    const at = Date.now() / 1000 - 60;
    const unplanned = task(1, 1, "Add storage", { status: "done" });
    const estimated = { ...unplanned, estimate: { unit: "hours" as const, amount: 2 } };
    let reviewed = unplanned;
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.reviewPeriod.mockImplementation(async (from, to) =>
      reviewOf(from, to, [{ task: reviewed, outcome: "completed", at, commits: [], archived: false, pullRequest: null }]),
    );
    mocked.updateTask.mockImplementation(async () => {
      reviewed = estimated;
      return { status: "ok", data: estimated };
    });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const plan = await screen.findByRole("region", { name: "Plan vs actual" });
    expect(plan).toHaveTextContent("No reviewed task has an estimate or a due date");
    expect(within(plan).getByText("Missing plan").nextSibling).toHaveTextContent(
      "1 task without an estimate, 1 task without a due date; add them from the marks on the tasks below",
    );
    const completed = screen.getByRole("region", { name: "Completed" });
    fireEvent.click(within(completed).getByRole("button", { name: "Edit plan of #1: no estimate or due date" }));
    const form = within(completed).getByRole("form", { name: "Edit task #1" });
    expect(within(form).getByLabelText("Estimate of #1")).toHaveFocus();
    fireEvent.change(within(form).getByLabelText("Estimate of #1"), { target: { value: "2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await within(completed).findByRole("button", { name: "Edit plan of #1: no due date" })).toBeInTheDocument();
    expect(within(completed).queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();
    expect(mocked.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, estimate: { unit: "hours", amount: 2 }, dueDate: null, criteria: null }),
    );
  });

  it("saves the review as a snapshot and reopens it as it was saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 14, 10));
    const at = new Date(2026, 9, 13, 15).getTime() / 1000;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    // Since the review was saved, its completed task was reopened.
    mocked.reviewPeriod.mockImplementation(async (from, to) =>
      reviewOf(from, to, [{ task: task(1, 1, "Add storage"), outcome: "started", at, commits: [], archived: false, pullRequest: null }]),
    );
    const summary = {
      id: 7,
      title: "Week review 2026-10-12 to 2026-10-18",
      period: "week" as const,
      from: "2026-10-12",
      to: "2026-10-18",
      timeZone: "Asia/Seoul",
      workspaceId: null,
      label: null,
      start: localMidnight("2026-10-12"),
      end: localMidnight("2026-10-19"),
      savedAt: at + 3600,
      entryCount: 1,
    };
    mocked.saveReviewSnapshot.mockImplementation(async () => {
      mocked.listReviewSnapshots.mockResolvedValue({ status: "ok", data: [summary] });
      return { status: "ok", data: summary };
    });
    const report = (fileName: string, contents: string) => ({
      fileName,
      mediaType: "text/markdown",
      from: "2026-10-12",
      to: "2026-10-18",
      contents,
    });
    mocked.getReviewSnapshot.mockResolvedValue({
      status: "ok",
      data: {
        summary,
        entries: [{ task: task(1, 1, "Add storage", { status: "done" }), outcome: "completed", at, commits: [], archived: false, pullRequest: null }],
        workspaces: [{ id: 1, name: "toodo before renaming" }],
        markdown: report("toodo-review-2026-10-12-to-2026-10-18.md", "# Saved week\n"),
        csv: report("toodo-review-2026-10-12-to-2026-10-18.csv", "Task\r\n"),
      },
    });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByRole("region", { name: "Started" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change time zone" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as snapshot" }));
    expect(
      await screen.findByText('Saved "Week review 2026-10-12 to 2026-10-18" with 1 task; reopen it from Saved reviews.'),
    ).toBeInTheDocument();
    expect(mocked.saveReviewSnapshot).toHaveBeenCalledWith({
      period: "week",
      from: "2026-10-12",
      to: null,
      workspaceId: null,
      label: null,
      title: null,
    });

    fireEvent.change(await screen.findByRole("combobox", { name: "Saved reviews" }), { target: { value: "7" } });
    expect(await screen.findByRole("heading", { name: "Week review 2026-10-12 to 2026-10-18" })).toBeInTheDocument();
    expect(mocked.getReviewSnapshot).toHaveBeenCalledWith(7);
    expect(screen.getByText(/with days in Asia\/Seoul; it stays as it was when saved/)).toBeInTheDocument();
    const completed = await screen.findByRole("region", { name: "Completed" });
    expect(within(completed).getByText("toodo before renaming ·")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Started" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Week starting")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.queryByRole("menuitem", { name: "Save as snapshot" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    expect(await screen.findByText("Copied as Markdown.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("# Saved week\n");
    expect(mocked.reviewReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to the live review" }));
    expect(await screen.findByRole("region", { name: "Started" })).toBeInTheDocument();
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
    const createObjectURL = vi.fn((_blob: Blob) => "blob:review");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    mocked.reviewPeriod.mockImplementation(async (from, to) =>
      reviewOf(
        from,
        to,
        from === "2026-10-12" || from === "2026-01-01"
          ? [
              {
                task: task(1, 1, "Add storage", {
                  status: "done",
                  refs: ["pr:https://github.com/acme/toodo/pull/7"],
                }),
                outcome: "completed",
                at,
                commits: [{ ...commit(1, "0123456789", "Add the storage schema\n\nBody"), committedAt: at }],
                archived: false,
                pullRequest: null,
              },
              { task: task(3, 2, "Fix ssh", { labels: ["infra"] }), outcome: "worked_on", at, commits: [], archived: false, pullRequest: null },
            ]
          : [],
      ),
    );
    mocked.reviewReport.mockImplementation(async ({ format }) => ({
      status: "ok",
      data:
        format === "csv"
          ? { fileName: "toodo-review-2026.csv", mediaType: "text/csv", from: "2026-01-01", to: "2026-12-31", contents: "\uFEFFTask\r\n1,toodo\r\n" }
          : {
              fileName: "toodo-review-2026-10-12-to-2026-10-18.md",
              mediaType: "text/markdown",
              from: "2026-10-12",
              to: "2026-10-18",
              contents: "# Week review: 2026-10-12 to 2026-10-18\n",
            },
    }));
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(await screen.findByRole("heading", { name: "Week review" })).toBeInTheDocument();
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
    expect(mocked.reviewPeriod).toHaveBeenCalledWith("2026-10-12", "2026-10-18");
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Completed by type").nextSibling).toHaveTextContent("feat 1");
    expect(within(summary).queryByRole("list", { name: "Completed per month" })).not.toBeInTheDocument();
    expect(within(workedOn).getByRole("list", { name: "Labels of #3" })).toHaveTextContent("infra");

    fireEvent.change(screen.getByRole("combobox", { name: "Workspace" }), { target: { value: "2" } });
    expect(screen.queryByRole("region", { name: "Completed" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Worked on" })).toBeInTheDocument();
    expect(screen.getByText(/to 2026-10-18 in herdr\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Label" }), { target: { value: "infra" } });
    expect(screen.queryByRole("region", { name: "Completed" })).not.toBeInTheDocument();
    expect(screen.getByText(/across all workspaces, labelled infra\./)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace" }), { target: { value: "1" } });
    expect(screen.getByText("No recorded activity in this week matches the filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("region", { name: "Completed" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    expect(await screen.findByText("Copied as Markdown.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("# Week review: 2026-10-12 to 2026-10-18\n");
    expect(mocked.reviewReport).toHaveBeenLastCalledWith({
      period: "week",
      date: null,
      from: "2026-10-12",
      to: null,
      format: "markdown",
      timeZone: null,
      workspaceId: null,
      label: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(await screen.findByText("No recorded activity in this week.")).toBeInTheDocument();
    expect(screen.getByLabelText("Week starting")).toHaveValue("2026-10-05");
    expect(mocked.reviewPeriod).toHaveBeenLastCalledWith("2026-10-05", "2026-10-11");

    fireEvent.click(within(screen.getByRole("group", { name: "Review period" })).getByRole("button", { name: "Year" }));
    expect(screen.getByRole("heading", { name: "Year review" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Completed" })).toBeInTheDocument();
    expect(mocked.reviewPeriod).toHaveBeenLastCalledWith("2026-01-01", "2026-12-31");
    const months = within(screen.getByRole("region", { name: "Summary" })).getByRole("list", {
      name: "Completed per month",
    });
    expect(within(months).getAllByRole("listitem")).toHaveLength(12);
    expect(within(months).getAllByRole("listitem")[9]).toHaveTextContent("2026-101");

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as CSV" }));
    expect(await screen.findByText("Downloaded toodo-review-2026.csv")).toBeInTheDocument();
    expect(downloads).toEqual(["toodo-review-2026.csv"]);
    const saved = [...new Uint8Array(await createObjectURL.mock.calls[0][0].arrayBuffer())];
    expect(saved).toEqual([...new TextEncoder().encode("\uFEFFTask\r\n1,toodo\r\n")]);
    expect(mocked.reviewReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ period: "year", from: "2026-01-01", to: null, format: "csv" }),
    );
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

  it("loads a finished task older than the loaded pages when a search names its number", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    const old = task(3, 1, "Old storage work", { status: "done", resolution: "completed" });
    mocked.listTasks.mockImplementation(async (filter) => ({
      status: "ok",
      data: filter?.ids ? [old].filter((entry) => filter.ids?.includes(entry.id)) : filter?.statuses?.includes("planned") ? [task(9, 1, "Add search")] : [],
    }));
    await renderWorkspace();

    const tasks = await taskList();
    expect(within(tasks).queryByText("Old storage work")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "#3" } });
    const match = await screen.findByRole("list", { name: "Task number match" });
    expect(within(match).getByText("Old storage work")).toBeInTheDocument();
    expect(mocked.listTasks).toHaveBeenCalledWith({ ids: [3] });
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

  it("jumps to a task and runs actions from the command palette opened with Ctrl+K or Cmd+K", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(2, 2, "Ship pane events")],
    });
    await renderWorkspace();
    await taskList();

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const search = within(palette).getByRole("combobox", { name: "Search actions and tasks" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "#2" } });
    expect(within(palette).getByRole("option", { selected: true })).toHaveTextContent("#2 Ship pane events");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "herdr" })).toBeInTheDocument();
    const details = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(details).getByText("Ship pane events")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    const again = screen.getByRole("combobox", { name: "Search actions and tasks" });
    fireEvent.change(again, { target: { value: "show review" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "true");

    // Escape closes the palette without running anything.
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search actions and tasks" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("moves between tasks with j and k and opens their details without the mouse, but not while typing", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(2, 1, "Add UI"), task(3, 1, "Write docs")],
    });
    await renderWorkspace();
    const list = await taskList();
    const titles = () => [...list.querySelectorAll<HTMLElement>("[data-task-title]")];
    await waitFor(() => expect(titles()).toHaveLength(3));
    const [first, second, third] = titles();

    fireEvent.keyDown(document.body, { key: "j" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "j" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "j" });
    fireEvent.keyDown(third, { key: "k" });
    expect(second).toHaveFocus();

    // Enter on the focused title presses it, which opens the details; j then shows the next task's.
    fireEvent.click(second);
    const details = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(details).getByText(second.textContent!)).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "j" });
    expect(await within(details).findByText(third.textContent!)).toBeInTheDocument();
    expect(third).toHaveFocus();

    // Typed into a field, the letters stay text.
    const searchField = screen.getByRole("searchbox", { name: "Search tasks" });
    searchField.focus();
    fireEvent.keyDown(searchField, { key: "k" });
    fireEvent.keyDown(searchField, { key: "?" });
    expect(searchField).toHaveFocus();
    expect(within(details).getByText(third.textContent!)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();

    third.focus();
    fireEvent.keyDown(third, { key: "/" });
    expect(searchField).toHaveFocus();
    searchField.blur();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveTextContent("Open the command palette");
  });

  it("moves the timeline selection with j and k from anywhere on the page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const planned = { ...task(0, 1, "").milestones, plannedAt: new Date(2026, 5, 1).getTime() / 1000 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { milestones: planned }),
        task(2, 1, "Add UI", { dependsOn: [1], milestones: planned }),
      ],
    });
    renderApp();
    const timeline = await screen.findByRole("region", { name: "Task timeline" }, { timeout: 5000 });
    await within(timeline).findByText("Add UI");
    const heading = async (title: string) =>
      within(await within(timeline).findByRole("complementary", { name: "Task details" })).findByRole("heading", {
        name: title,
      });

    fireEvent.keyDown(document.body, { key: "j" });
    expect(await heading("Add storage")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "j" });
    expect(await heading("Add UI")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "k" });
    expect(await heading("Add storage")).toBeInTheDocument();
  });

  it("shows command errors returned by the backend", async () => {
    mocked.listWorkspaces.mockResolvedValue({
      status: "error",
      error: { kind: "internal", code: "internal", message: "database is locked" },
    });
    renderApp();

    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
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
      .mockResolvedValueOnce({ status: "error", error: { kind: "internal", code: "internal", message: "database is locked" } })
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
    expect(screen.getByRole("region", { name: "Workspaces" })).toHaveTextContent("toodo");

    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [herdr] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove toodo" }));

    expect(await screen.findByText("Fix ssh")).toBeInTheDocument();
    expect(mocked.deleteWorkspace).toHaveBeenLastCalledWith(1);
    expect(within(screen.getByRole("region", { name: "Workspaces" })).queryByRole("button", { name: /^toodo/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "herdr" })).toBeInTheDocument();
  });

  it("creates a task and reloads the task list", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
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
    fireEvent.change(screen.getByLabelText("Labels"), { target: { value: " q4, docs ,, q4" } });
    fireEvent.click(screen.getByLabelText("Autopilot"));
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByText("Write docs")).toBeInTheDocument();
    expect(mocked.createTask).toHaveBeenCalledWith({
      workspaceId: 1,
      taskType: "docs",
      title: "Write docs",
      description: "",
      estimate: { unit: "weeks", amount: 2.5 },
      dueDate: "2026-11-01",
      labels: ["docs", "q4"],
      autopilot: true,
      criteria: [],
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
    const add = within(form).getByRole("button", { name: "Add criterion" });
    fireEvent.click(add);
    fireEvent.change(within(form).getByLabelText("Criterion 1 text"), { target: { value: " Docs reviewed " } });
    fireEvent.click(add);
    fireEvent.change(within(form).getByLabelText("Criterion 2 text"), { target: { value: "Tests pass" } });
    expect(within(form).queryByLabelText("Criterion 2 target")).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Criterion 2 kind"), { target: { value: "url" } });
    // A URL criterion cannot be added without an http(s) URL.
    expect(within(form).getByRole("button", { name: "Add task" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Criterion 2 target"), { target: { value: "https://example.com/health" } });
    // A row left blank is not sent.
    fireEvent.click(add);
    fireEvent.click(within(form).getByRole("button", { name: "Add task" }));

    await waitFor(() => expect(within(form).queryByLabelText("Criterion 1 text")).not.toBeInTheDocument());
    expect(mocked.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add search",
        criteria: [
          { text: "Docs reviewed", kind: "manual", target: null },
          { text: "Tests pass", kind: "url", target: "https://example.com/health" },
        ],
      }),
    );
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

  it("shows a guideline an agent added to the open workspace once the app hears of it", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();
    const guidelines = await screen.findByRole("region", { name: "Guidelines" });
    expect(await within(guidelines).findByText(/agents read them/)).toBeInTheDocument();
    await waitFor(() => expect(mockedEvents.guidelinesChanged.listen).toHaveBeenCalled());

    mocked.listGuidelines.mockResolvedValue({
      status: "ok",
      data: [{ id: 1, workspaceId: 1, kind: "rule", body: "Write English.", createdAt: 1700000000, updatedAt: 1700000000 }],
    });
    const [[onGuidelinesChanged]] = mockedEvents.guidelinesChanged.listen.mock.calls;
    act(() => {
      onGuidelinesChanged({ event: "guidelines-changed", id: 4, payload: { workspaceId: 1 } });
    });

    expect(await within(guidelines).findByRole("button", { name: "Guidelines 1 rule" })).toBeInTheDocument();
    expect(mocked.listGuidelines).toHaveBeenLastCalledWith(1);
  });

  it("shows why a task could not be started", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Add login")] });
    mocked.startTask.mockResolvedValue({
      status: "error",
      error: { kind: "invalidInput", code: "invalidInput", message: "worktree root is not set for machine local" },
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

  it("flags a failed automatic backup on the Settings button and the Backups tab", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    mocked.getBackupStatus.mockResolvedValue({ lastFailure: { at: 1_791_970_205, message: "file error: disk full" } });
    renderApp();

    const settings = await screen.findByRole("button", { name: /^Settings.*Backup failed$/ });
    fireEvent.click(settings);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("tab", { name: /^Backups.*Backup failed/ })).toBeInTheDocument();
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

  it("shows a newer version of the server in the general settings", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [] });
    mocked.checkUpdate.mockResolvedValue({ current: "1.2.3", channel: "latest", latest: "1.3.0", newer: true, error: null });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Settings/ }));
    const general = within(screen.getByRole("dialog", { name: "Settings" })).getByRole("region", { name: "General" });
    expect(await within(general).findByRole("status")).toHaveTextContent(
      "v1.3.0 is available on the latest channel. Update the server with toodo update.",
    );
  });

  it("shows why a task could not be completed", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add login", {
          status: "in_review",
        }),
      ],
    });
    mocked.completeTask.mockResolvedValue({
      status: "error",
      error: { kind: "rejected", code: "rejected", message: "pull request https://github.com/acme/toodo/pull/12 is not merged yet" },
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
        criterion(1, "Health check answers", {
          ...met,
          kind: "url",
          target: "https://example.com/health",
          checkedBy: "toodo",
        }),
        criterion(2, "Docs reviewed", { ...met, checkedBy: "user", evidence: "Read by Ada" }),
      ],
    });
    const done = { ...awaiting, status: "done" as const, resolution: "completed" as const };
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
    expect(mocked.completeTask).toHaveBeenCalledWith(1, null, null);
    expect(within(tasks).queryByRole("button", { name: "Complete #1" })).not.toBeInTheDocument();
  });

  it("asks for a completion note on a done task and saves it", async () => {
    const done = task(1, 1, "Add login", { status: "done" });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    const details = await openDetails("Add login");
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
    mocked.reviewPeriod.mockImplementation(async (from, to) =>
      reviewOf(from, to, [
        { task: done(1, "Add login", {}), pullRequest: pullRequest(11, 40, 2) },
        { task: done(2, "Rewrite storage", {}), pullRequest: pullRequest(12, 400, 0) },
        { task: done(3, "Try a cache", { taskType: "rnd", resolution: "not_adopted", completionNote: "Twice as slow" }), pullRequest: null },
      ].map(({ task, pullRequest }) => ({ task, pullRequest, outcome: "completed" as const, at, commits: [], archived: false }))),
    );
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
    });
    const dependent = task(2, 1, "Use the new cache", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [research, dependent] });
    await renderWorkspace();

    await chooseAction(1, "Conclude #1 without completing");
    const conclude = screen.getByRole("button", { name: "Conclude as not adopted" });
    expect(conclude).toBeDisabled();

    const concluded: Task = {
      ...research,
      status: "done",
      resolution: "not_adopted",
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
    expect(mocked.concludeTask).toHaveBeenCalledWith(1, "Twice as slow as the current cache", "not_adopted", null);
    expect(within(row("Try a new cache")).getByText("Not adopted")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Blocked prerequisites of #2" })).toHaveTextContent("#1 not adopted");
    expect(screen.getByRole("button", { name: "Start #2" })).toBeDisabled();
    const details = await openDetails("Try a new cache");
    expect(within(details).getByLabelText("Completion note of #1")).toHaveTextContent(
      "Twice as slow as the current cache",
    );
  });

  it("concludes a planned task as not adopted without starting it", async () => {
    const prerequisite = task(1, 1, "Pick a cache");
    const idea = task(2, 1, "Try a second cache", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [prerequisite, idea] });
    await renderWorkspace();

    await chooseAction(2, "Conclude #2 without completing");
    const concluded: Task = { ...idea, status: "done", resolution: "not_adopted", completionNote: "Not needed" };
    mocked.concludeTask.mockResolvedValue({ status: "ok", data: concluded });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [prerequisite, concluded] });
    fireEvent.change(screen.getByRole("textbox", { name: "Conclusion of #2" }), { target: { value: "Not needed" } });
    fireEvent.click(screen.getByRole("button", { name: "Conclude as not adopted" }));

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    expect(mocked.concludeTask).toHaveBeenCalledWith(2, "Not needed", "not_adopted", null);
    expect(mocked.startTask).not.toHaveBeenCalled();
    expect(within(row("Try a second cache")).getByText("Not adopted")).toBeInTheDocument();
  });

  it("reopens a done task with a reason and shows it paused and reopened", async () => {
    const done = task(1, 1, "Add login", {
      status: "done",
      resolution: "merged",
      milestones: { plannedAt: 100, startedAt: 200, reviewAt: null, completedAt: 300, reopenedAt: null, pausedAt: null, lastReviewAt: null, activeSeconds: 100, pauseCount: 0 },
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
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
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [batch, extra, planned] });
    await renderWorkspace();

    await chooseAction(2, "Conclude #2 without completing");
    fireEvent.click(screen.getByRole("button", { name: "Complete #2 as shipped by another task" }));
    const shipper = screen.getByRole("combobox", { name: "Task that shipped #2" });
    // Only work that shipped can be named.
    expect(within(shipper).queryByRole("option", { name: "#3 Add logout" })).not.toBeInTheDocument();

    const done: Task = {
      ...extra,
      status: "done",
      resolution: "completed",
      completionNote: "Fixed in #1",
      refs: ["task:1"],
    };
    mocked.concludeTask.mockResolvedValue({ status: "ok", data: done });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [batch, done, planned] });
    fireEvent.change(shipper, { target: { value: "1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Shipped note of #2" }), { target: { value: "Fixed in #1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete as shipped" }));

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 2" }));
    expect(mocked.concludeTask).toHaveBeenCalledWith(2, "Fixed in #1", "shipped_with", 1);
    const details = await openDetails("Fix typo");
    expect(await within(details).findByRole("list", { name: "Refs of #2" })).toHaveTextContent("task:1");
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

  it("does not offer a dependency that would close a cycle and shows why one was rejected", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage"),
        task(2, 1, "Add UI", { status: "planned", dependsOn: [1] }),
        task(3, 1, "Add docs", { status: "planned", dependsOn: [2] }),
        task(4, 1, "Add search"),
      ],
    });
    mocked.addDependency.mockResolvedValue({
      status: "error",
      error: { kind: "rejected", code: "rejected", message: "dependency would create a cycle: #1 -> #4 -> #1" },
    });
    await renderWorkspace();

    const details = await openDetails("Add storage");
    const add = within(details).getByRole("combobox", { name: "Add dependency to #1" });
    expect(within(add).queryByRole("option", { name: "#2 Add UI" })).not.toBeInTheDocument();
    expect(within(add).queryByRole("option", { name: "#3 Add docs" })).not.toBeInTheDocument();
    // The server checks the whole DAG, also edges the app has not loaded yet.
    fireEvent.change(add, { target: { value: "4" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("would create a cycle");
    expect(mocked.addDependency).toHaveBeenCalledWith(1, 4, false);
    expect(screen.queryByRole("combobox", { name: "Add dependency to #2" })).not.toBeInTheDocument();
  });

  it("edits the type, title, and description of a task", async () => {
    const original = task(1, 1, "Add login", {
      description: "old",
      estimate: { unit: "hours", amount: 3 },
      dueDate: "2026-11-01",
      labels: ["auth"],
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
    expect(within(form).getByLabelText("Labels of #1")).toHaveValue("auth");
    fireEvent.change(within(form).getByLabelText("Labels of #1"), { target: { value: "q4, auth" } });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [edited] });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Add sign-in")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();
    expect(mocked.updateTask).toHaveBeenCalledWith({
      status: null,
      id: 1,
      taskType: "fix",
      title: "Add sign-in",
      description: "new",
      estimate: null,
      dueDate: "2026-12-01",
      labels: ["auth", "q4"],
      autopilot: null,
      criteria: null,
    });
  });

  it("turns autopilot on and off from the details sheet", async () => {
    const original = task(1, 1, "Add sign-in", { dueDate: "2026-12-01" });
    const marked = { ...original, autopilot: true, autopilotAt: 1_794_441_600 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: marked });
    await renderWorkspace();

    const sheet = await openDetails("Add sign-in");
    const toggle = await within(sheet).findByRole("button", { name: "Autopilot of #1" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [marked] });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(mocked.updateTask).toHaveBeenLastCalledWith({
      status: null,
      id: 1,
      taskType: original.taskType,
      title: "Add sign-in",
      description: original.description,
      estimate: null,
      dueDate: "2026-12-01",
      autopilot: true,
      criteria: null,
    });

    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(mocked.updateTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, autopilot: false }));
  });

  it("marks tasks missing an estimate or due date and opens the edit form at the missing field", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add login", { dueDate: "2026-11-01" }),
        task(2, 1, "Add search", { estimate: { unit: "days", amount: 2 } }),
        task(3, 1, "Add export", { estimate: { unit: "hours", amount: 3 }, dueDate: "2026-11-01" }),
      ],
    });
    await renderWorkspace();

    const noEstimate = await screen.findByRole("button", { name: "Edit plan of #1: no estimate" });
    expect(noEstimate).toHaveTextContent("No estimate");
    expect(screen.getByRole("button", { name: "Edit plan of #2: no due date" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit plan of #3/ })).not.toBeInTheDocument();

    fireEvent.click(noEstimate);
    const form = screen.getByRole("form", { name: "Edit task #1" });
    expect(within(form).getByLabelText("Estimate of #1")).toHaveFocus();
    fireEvent.click(within(form).getByRole("button", { name: "Discard" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit plan of #2: no due date" }));
    expect(within(screen.getByRole("form", { name: "Edit task #2" })).getByLabelText("Due date of #2")).toHaveFocus();
  });

  it("edits the criteria of a task and keeps the existing ones by ID", async () => {
    const original = task(1, 1, "Add search", {
      criteria: [
        criterion(3, "Health check answers", { kind: "url", target: "https://example.com/health" }),
        criterion(4, "Docs reviewed"),
      ],
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: original });
    await renderWorkspace();

    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
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
          { id: 3, text: "Health check answers", kind: "url", target: "https://example.com/health" },
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
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    const finished = task(2, 1, "Add storage", { status: "done", resolution: "merged" });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started, finished] });
    await renderWorkspace();

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

    await chooseAction(1, "Conclude #1 without completing");
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
      data: [fix, { ...started, status: "planned", dependsOn: [1] }],
    });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Pause and add" }));

    expect(await within(details).findByRole("note", { name: "Waiting prerequisites of #2" })).toHaveTextContent(
      "Waiting on #1",
    );
    expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, true);
    expect(within(details).getByRole("button", { name: "Resume #2" })).toBeDisabled();
    expect(within(row("Verify login")).getByRole("note", { name: "Waiting prerequisites of #2" })).toBeInTheDocument();
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
        task(1, 1, "Add storage", { status: "in_progress", milestones }),
        task(2, 1, "Fix redirect", {
          status: "in_review",
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
    renderApp();

    const attention = await screen.findByRole("region", { name: /Needs attention/ });
    const items = await within(attention).findAllByRole("listitem");
    expect(items.map((item) => [...item.querySelectorAll("[data-reason]")].map((reason) => reason.textContent))).toEqual(
      [["Blocker", "Stalled"], ["Stalled"]],
    );
    expect(items[0]).toHaveTextContent("#3Add UI");
    expect(items[1]).toHaveTextContent("#1Add storage");

    // The task shows even from the list view, with a filter hiding it.
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Blocked" }));
    expect(screen.queryByRole("region", { name: "Task timeline" })).not.toBeInTheDocument();
    fireEvent.click(within(items[1]).getByRole("button", { name: /Add storage/ }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Add storage" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Status filter" })).queryAllByRole("button", { pressed: true })).toHaveLength(0);
  });

  it("opens the task a clicked notification asks for and keeps it in the address", async () => {
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
    expect(window.location.search).toBe("?task=2");
  });

  it("keeps the workspace, view, and selected task in the address for back, forward, and reload", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(2, 1, "Fix redirect")],
    });
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <App />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^toodo/ }, { timeout: 5000 }));
    expect(window.location.search).toBe("?workspace=1");
    let details = await openDetails("Fix redirect");
    expect(window.location.search).toBe("?workspace=1&task=2");
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "List" }));
    expect(window.location.search).toBe("?view=list");

    // Back returns to the All workspaces timeline, then to the workspace with its task open.
    await goBack();
    expect(window.location.search).toBe("");
    expect(await screen.findByRole("button", { name: "Timeline", pressed: true })).toBeInTheDocument();
    await goBack();
    details = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Fix redirect" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "toodo" })).toBeInTheDocument();

    // A reload, or the copied address opened anew, shows the same workspace and task.
    unmount();
    renderApp();
    details = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Fix redirect" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "toodo" })).toBeInTheDocument();
  });

  it("marks a task whose agent reported a blocker in the list and shows every note in the task details", async () => {
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
    expect(within(tasks).getByRole("note", { name: "Blocker on #1: Need a test account for the provider" })).toBeInTheDocument();
    expect(within(row("Add logout")).queryByText("Blocker")).not.toBeInTheDocument();

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
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [fix, started] });
    // The server decides that the prerequisite pauses the task and asks for confirmation.
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "confirm_pause" });
    await renderWorkspace();
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

  it("makes a started task wait until a time, moves the time, and ends the wait", async () => {
    const started = task(1, 1, "Add login", {
      status: "in_progress",
      milestones: { ...task(1, 1, "").milestones, plannedAt: 1760000000, startedAt: 1760100000 },
    });
    const until = new Date(2030, 0, 2, 9, 30).getTime() / 1000;
    const waiting: Task = {
      ...started,
      status: "planned",
      milestones: { ...started.milestones, pausedAt: 1760200000 },
      wait: { until, status: "in_progress" },
    };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    mocked.waitTask.mockResolvedValue({ status: "ok", data: waiting });
    mocked.endWait.mockResolvedValue({ status: "ok", data: started });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "More actions for #1" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Wait #1" }));
    const form = await screen.findByRole("form", { name: "Wait #1" });
    fireEvent.change(within(form).getByLabelText("Wait #1 until"), { target: { value: "2030-01-02T09:30" } });
    fireEvent.change(within(form).getByLabelText("Reason #1 waits"), { target: { value: " Vendor reply " } });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [waiting] });
    fireEvent.click(within(form).getByRole("button", { name: "Wait" }));
    await waitFor(() => expect(mocked.waitTask).toHaveBeenCalledWith(1, until, "Vendor reply"));
    expect(await screen.findByRole("note", { name: "Wait of #1" })).toHaveTextContent(
      `Waiting until ${formatFull(until)}, then in progress`,
    );

    // A waiting task opens the form with its time, to move it.
    fireEvent.click(screen.getByRole("button", { name: "More actions for #1" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Change wait of #1" }));
    const change = await screen.findByRole("form", { name: "Wait #1" });
    expect(within(change).getByLabelText("Wait #1 until")).toHaveValue("2030-01-02T09:30");
    fireEvent.click(within(change).getByRole("button", { name: "Back" }));

    fireEvent.click(screen.getByRole("button", { name: "More actions for #1" }));
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    fireEvent.click(await screen.findByRole("menuitem", { name: "End wait of #1" }));
    await waitFor(() => expect(mocked.endWait).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.queryByRole("note", { name: "Wait of #1" })).not.toBeInTheDocument());
  });

  it("pauses a started task, then resumes or deletes it", async () => {
    const started = task(1, 1, "Add login", {
      status: "in_progress",
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
      "Conclude #1 without completing",
      "Edit #1",
      "Wait #1",
      "Delete #1",
    ]);
    expect(items.at(-1)).toHaveClass("text-destructive");
    fireEvent.click(items.at(-1) as HTMLElement);
    expect(mocked.deleteTask).not.toHaveBeenCalled();
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete #1" }));

    expect(await screen.findByText("No tasks in this workspace yet.")).toBeInTheDocument();
    expect(mocked.deleteTask).toHaveBeenCalledWith(1);
  });

  it("lists tasks in the timeline's order, oldest first, with done work folded away", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const day = (n: number) => new Date(2026, 5, n).getTime() / 1000;
    const milestones = (startedAt: number, extra: Partial<Task["milestones"]> = {}) => ({
      ...task(0, 1, "").milestones,
      plannedAt: day(1),
      startedAt,
      ...extra,
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Ship v1", { status: "done", resolution: "merged", milestones: milestones(day(2), { completedAt: day(3) }) }),
        task(2, 1, "Plan docs", { dependsOn: [3], milestones: { ...task(0, 1, "").milestones, plannedAt: day(1) } }),
        task(3, 1, "Build API", { status: "in_progress", milestones: milestones(day(4)) }),
        task(4, 1, "Fix crash", { status: "in_review", milestones: milestones(day(6), { reviewAt: day(7) }) }),
        task(5, 1, "Add search", { milestones: { ...task(0, 1, "").milestones, plannedAt: day(1) } }),
        task(6, 1, "Add UI", { status: "in_progress", milestones: milestones(day(5)) }),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    const titles = () =>
      within(within(tasks).getByRole("list", { name: "Task list" }))
        .getAllByRole("listitem")
        .map((item) => item.querySelector("[data-task-row] button")?.textContent);
    expect(titles()).toEqual(["Build API", "Add UI", "Fix crash", "Plan docs", "Add search"]);

    const done = within(tasks).getByRole("button", { name: "Done 1" });
    expect(done).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(done);
    expect(done).toHaveAttribute("aria-expanded", "true");
    expect(titles()).toEqual(["Ship v1", "Build API", "Add UI", "Fix crash", "Plan docs", "Add search"]);
  });
});
