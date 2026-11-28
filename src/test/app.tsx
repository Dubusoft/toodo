import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, expect, vi } from "vitest";
import App from "@/App";
import {
  commands,
  events,
  type CommitRecord,
  type Criterion,
  type ReviewEntry,
  type Task,
  type Workspace,
} from "@/lib/bindings";

// Shared by the App test files (src/App.*.test.tsx): the mocked backend, fixtures, and helpers
// that drive the rendered app. The mocks below apply to every test file importing this module.
vi.mock("@/web/notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@/lib/bindings", () => ({
  commands: {
    appInfo: vi.fn(),
    checkUpdate: vi.fn(),
    getAppLanguage: vi.fn(),
    setAppLanguage: vi.fn(),
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
    listChat: vi.fn(),
    sendChatMessage: vi.fn(),
    markChatRead: vi.fn(),
    listChatChannels: vi.fn(),
    reorderChatChannels: vi.fn(),
    listChatThreads: vi.fn(),
  },
  events: {
    tasksChanged: { listen: vi.fn() },
    workspacesChanged: { listen: vi.fn() },
    guidelinesChanged: { listen: vi.fn() },
    chatChanged: { listen: vi.fn() },
    chatTyping: { listen: vi.fn() },
  },
}));

export const mocked = vi.mocked(commands);
export const mockedEvents = vi.mocked(events, { deep: true });

export const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const localMidnight = (day: string, days = 0) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date + days).getTime() / 1000;
};
/** What review_period answers for the days `from` to `to`, judged in this machine's time zone. */
export const reviewOf = (from: string, to: string, entries: ReviewEntry[]) => ({
  status: "ok" as const,
  data: { from, to, start: localMidnight(from), end: localMidnight(to, 1), timeZone: machineZone, entries },
});

export const toodo: Workspace = {
  id: 1,
  name: "toodo",
  description: null,
  repository: "dev-bokdong/toodo",
  archivedAt: null,
};

export const herdr: Workspace = {
  id: 2,
  name: "herdr",
  description: null,
  repository: null,
  archivedAt: null,
};

export function task(id: number, workspaceId: number, title: string, overrides: Partial<Task> = {}): Task {
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

export function criterion(id: number, text: string, overrides: Partial<Criterion> = {}): Criterion {
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

export function commit(taskId: number, sha: string, message: string): CommitRecord {
  return { taskId, sha, message, author: "Ada <ada@example.com>", committedAt: 1700000000 };
}

export function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

/** Opens the settings dialog on one of its sections. */
export async function openSettings(section: string) {
  fireEvent.click(await screen.findByRole("button", { name: /^Settings/ }));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  fireEvent.click(within(dialog).getByRole("tab", { name: new RegExp(`^${section}`) }));
  return dialog;
}

/** Renders the app and opens one workspace, since the app starts on All workspaces. */
export async function renderWorkspace(name: RegExp = /^toodo/) {
  renderApp();
  // The first render of a test file is slow on a loaded machine.
  fireEvent.click(await screen.findByRole("button", { name }, { timeout: 5000 }));
}

/** Goes one entry back in the browser history and waits for the app to see it. */
export async function goBack() {
  await act(async () => {
    const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    window.history.back();
    await popped;
  });
}

/** The row of the task titled `title` in the list. */
export function row(title: string) {
  return screen.getByRole("button", { name: title }).closest("li") as HTMLElement;
}

/** The list view's tasks, in sections by status. */
export function taskList() {
  return screen.findByRole("region", { name: "Tasks" });
}

/** Opens the details sheet of the task titled `title` from its row in the list. */
export async function openDetails(title: string) {
  fireEvent.click(await within(await taskList()).findByRole("button", { name: title }));
  return screen.findByRole("complementary", { name: "Task details" });
}

/** Whether a button is disabled; Astryx buttons use aria-disabled instead of the native attribute. */
export function isDisabled(element: HTMLElement) {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

/** The option list of an Astryx Selector, opened first if it is closed. */
export function openOptions(combobox: HTMLElement) {
  if (combobox.getAttribute("aria-expanded") !== "true") fireEvent.click(combobox);
  return document.getElementById(combobox.getAttribute("aria-controls")!)!;
}

/** The option labels of an Astryx Selector, which is closed again afterwards. */
export function optionNames(combobox: HTMLElement) {
  const names = within(openOptions(combobox))
    .getAllByRole("option")
    .map((option) => option.textContent);
  fireEvent.click(combobox);
  return names;
}

/** Picks the option named `name` of an Astryx Selector. */
export function chooseOption(combobox: HTMLElement, name: string | RegExp) {
  fireEvent.click(within(openOptions(combobox)).getByRole("option", { name }));
}

/** The app's one alert; Astryx keeps an assertive live region of its own in the page, left out here. */
export function findAlert() {
  return waitFor(() => {
    const alerts = screen.getAllByRole("alert").filter((alert) => !alert.hasAttribute("data-astryx-live-region"));
    expect(alerts).toHaveLength(1);
    return alerts[0];
  });
}

/** Picks `name` from the "More" menu of task `id`, in a row or, given `scope`, in the details sheet. */
export async function chooseAction(id: number, name: string, scope: HTMLElement = document.body) {
  fireEvent.click(await within(scope).findByRole("button", { name: `More actions for #${id}` }));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}


/** Registers the hooks every App test file needs; call it at the top of the file's describe. */
export function setUpApp() {
// The timeline, Markdown, the task details, and the review are lazy-loaded; transform them
// once here so no test pays for that within its timeout.
beforeAll(async () => {
  // jsdom has no modal dialogs; Astryx Dialog opens its <dialog> with showModal.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  // Nor the browser style that hides a closed dialog, such as the settings while they are closed.
  const style = document.createElement("style");
  style.textContent = "dialog:not([open]) { display: none; }";
  document.head.append(style);
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
  mocked.getAppLanguage.mockResolvedValue(null);
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
  mockedEvents.chatChanged.listen.mockResolvedValue(() => {});
  mockedEvents.chatTyping.listen.mockResolvedValue(() => {});
  mocked.listChat.mockResolvedValue({
    status: "ok",
    data: { agent: { name: "Agent", avatarUrl: null }, messages: [], hasEarlier: false, typingUntil: null },
  });
  mocked.listChatChannels.mockResolvedValue({
    status: "ok",
    data: [{ id: 1, name: "general", push: true, createdAt: 1, unread: 0 }],
  });
  mocked.listChatThreads.mockResolvedValue({ status: "ok", data: [] });
  mocked.markChatRead.mockResolvedValue({ status: "ok", data: null });
  mocked.listGuidelines.mockResolvedValue({ status: "ok", data: [] });
});
}
