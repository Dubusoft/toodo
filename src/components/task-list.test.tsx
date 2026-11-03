import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskList, type TaskDraft } from "@/components/task-list";
import { commands, type Task, type TaskActivity, type Workspace } from "@/lib/bindings";
import { queryKeys } from "@/lib/queries";
import { formatWhen } from "@/lib/timeline";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listWorkspaces: vi.fn(),
    listTasks: vi.fn(),
    listTaskRelations: vi.fn(),
    listCommitRecords: vi.fn(),
    listTaskActivity: vi.fn(),
    listAgentStatuses: vi.fn(),
    listPullRequestStatuses: vi.fn(),
    herdrStatus: vi.fn(),
    getMachineSettings: vi.fn(),
    branchFreshness: vi.fn(),
    createTask: vi.fn(),
    startTask: vi.fn(),
    listTaskRuns: vi.fn(),
    runnerHealth: vi.fn(),
  },
}));

const mocked = vi.mocked(commands);

const github: Workspace = {
  id: 1,
  name: "app",
  location: { kind: "local", path: "/srv/app" },
  defaultBaseBranch: "main",
  agentMerge: "never",
  pathProblem: null,
  source: "github",
  completion: "pr_merge",
  runner: "herdr",
};

const localGit: Workspace = {
  ...github,
  id: 2,
  name: "scripts",
  location: { kind: "local", path: "/srv/scripts" },
  source: "local_git",
  completion: "local_merge",
};

const folder: Workspace = {
  ...github,
  id: 3,
  name: "notes",
  location: { kind: "local", path: "/srv/notes" },
  defaultBaseBranch: "",
  source: "none",
  completion: "manual",
  runner: "none",
};

const plainRunner: Workspace = {
  ...localGit,
  id: 5,
  name: "tools",
  location: { kind: "local", path: "/srv/tools" },
  runner: "plain",
};

const manualGitHub: Workspace = {
  ...github,
  id: 4,
  name: "handbook",
  location: { kind: "local", path: "/srv/handbook" },
  completion: "manual",
};

const allKinds = ["Manual", "URL responds", "Command succeeds", "PR open with green CI"];
const manualKinds = ["Manual", "URL responds", "Command succeeds"];

function ok<T>(data: T) {
  return { status: "ok" as const, data };
}

function task(id: number, workspace: Workspace, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId: workspace.id,
    taskType: "feat",
    title,
    description: "",
    status: "planned",
    resolution: null,
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
    ...overrides,
  };
}

function activity(kind: TaskActivity["kind"], externalRef: string, title: string, occurredAt: number): TaskActivity {
  return {
    kind,
    source: kind === "commit" ? "git_poll" : "github_poll",
    externalRef,
    title,
    author: null,
    occurredAt,
    receivedAt: occurredAt,
    confirmedAt: occurredAt,
  };
}

const newDraft: TaskDraft = {
  taskType: "feat",
  title: "",
  description: "",
  issue: "",
  criteria: [],
  mergeCriterion: true,
  estimate: "",
  estimateUnit: "hours",
  dueDate: "",
};

/** Renders the tasks of `workspace`, with its new task form; returns the query cache. */
function renderTasks(workspace: Workspace, tasks: Task[]) {
  mocked.listWorkspaces.mockResolvedValue(ok([workspace]));
  mocked.listTasks.mockResolvedValue(ok(tasks));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Page() {
    const [draft, setDraft] = useState(newDraft);
    return (
      <TaskList
        workspace={workspace}
        timelineScale="week"
        onTimelineScaleChange={() => {}}
        draft={draft}
        onDraftChange={setDraft}
      />
    );
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** The labels of the options of a criterion kind picker. */
function kindOptions(select: HTMLElement) {
  return within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);
}

async function openDetails(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  return screen.findByRole("complementary", { name: "Task details" });
}

async function openMenu(id: number, scope: HTMLElement = document.body) {
  fireEvent.click(await within(scope).findByRole("button", { name: `More actions for #${id}` }));
  return screen.findByRole("menu", { name: `More actions for #${id}` });
}

describe("TaskList by workspace source, completion, and runner", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    mocked.herdrStatus.mockResolvedValue(ok({ running: false, version: null }));
    mocked.getMachineSettings.mockImplementation(async (machine) => ok({ machine, worktreeRoot: null }));
    mocked.listAgentStatuses.mockResolvedValue([]);
    mocked.listPullRequestStatuses.mockResolvedValue([]);
    mocked.listCommitRecords.mockResolvedValue(ok([]));
    mocked.listTaskActivity.mockResolvedValue(ok([]));
    mocked.listTaskRelations.mockResolvedValue(ok([]));
    mocked.branchFreshness.mockResolvedValue(
      ok({ base: "origin/main", behind: 0, fetchError: null, mergeable: null, mergeableError: null }),
    );
    mocked.runnerHealth.mockResolvedValue(
      ok({
        herdr: { installed: false, running: false, version: null, message: "herdr was not found on the server's PATH." },
        agents: [
          { adapter: "claude", installed: true, path: "/usr/local/bin/claude", message: null },
          { adapter: "codex", installed: true, path: "/usr/local/bin/codex", message: null },
        ],
      }),
    );
  });

  it("starts a plain directory's task without herdr and shows no base branch, agent merge, or worktree root", async () => {
    mocked.startTask.mockResolvedValue(ok(task(3, folder, "Write outline", { status: "in_progress" })));
    const queryClient = renderTasks(folder, [task(3, folder, "Write outline")]);

    const start = await screen.findByRole("button", { name: "Start #3" });
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.herdrStatus)).toEqual({ running: false, version: null }));
    expect(start).toBeEnabled();
    expect(screen.queryByRole("note", { name: "herdr unavailable for #3" })).not.toBeInTheDocument();
    fireEvent.click(start);
    await waitFor(() => expect(mocked.startTask).toHaveBeenCalledWith(3));

    expect(screen.getByRole("button", { name: "Move workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change base branch" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agent merge")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Worktree root" })).not.toBeInTheDocument();
    expect(mocked.getMachineSettings).not.toHaveBeenCalled();
  });

  it("needs herdr to start a GitHub workspace's task and shows its base branch, agent merge, and worktree root", async () => {
    renderTasks(github, [task(1, github, "Ship API")]);

    expect(await screen.findByRole("note", { name: "herdr unavailable for #1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start #1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change base branch" })).toBeInTheDocument();
    expect(screen.getByLabelText("Agent merge")).toBeInTheDocument();
    expect(await screen.findByRole("form", { name: "Worktree root" })).toBeInTheDocument();
  });

  it.each([
    { workspace: folder, merge: false, issue: false, kinds: manualKinds },
    { workspace: localGit, merge: true, issue: false, kinds: manualKinds },
    { workspace: github, merge: true, issue: true, kinds: allKinds },
  ])(
    "offers a new task of a $workspace.source workspace only the criteria its completion allows",
    async ({ workspace, merge, issue, kinds }) => {
      mocked.createTask.mockResolvedValue(ok(task(9, workspace, "Write docs")));
      renderTasks(workspace, []);

      const form = await screen.findByRole("form", { name: "New task" });
      fireEvent.focusIn(within(form).getByLabelText("Task title"));
      fireEvent.change(within(form).getByLabelText("Task title"), { target: { value: "Write docs" } });
      expect(within(form).queryByRole("checkbox", { name: "Done when merged" }) !== null).toBe(merge);
      expect(within(form).queryByLabelText("Issue number") !== null).toBe(issue);
      fireEvent.click(within(form).getByRole("button", { name: "Add criterion" }));
      expect(kindOptions(within(form).getByLabelText("Criterion 1 kind"))).toEqual(kinds);
      fireEvent.change(within(form).getByLabelText("Criterion 1 text"), { target: { value: "Docs reviewed" } });
      fireEvent.click(within(form).getByRole("button", { name: "Add task" }));

      await waitFor(() =>
        expect(mocked.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Write docs",
            criteria: [{ text: "Docs reviewed", kind: "manual", target: null }],
            mergeCriterion: merge,
          }),
        ),
      );
    },
  );

  it.each([
    { workspace: folder, merge: false, kinds: manualKinds },
    { workspace: localGit, merge: true, kinds: manualKinds },
    { workspace: github, merge: true, kinds: allKinds },
  ])(
    "offers an edited task of a $workspace.source workspace only the criteria its completion allows",
    async ({ workspace, merge, kinds }) => {
      renderTasks(workspace, [task(5, workspace, "Write docs")]);

      await openMenu(5);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Edit #5" }));
      const form = await screen.findByRole("form", { name: "Edit task #5" });
      expect(within(form).queryByRole("checkbox", { name: "Done when merged, #5" }) !== null).toBe(merge);
      fireEvent.click(within(form).getByRole("button", { name: "Add criterion to #5" }));
      expect(kindOptions(within(form).getByLabelText("Criterion 1 kind of #5"))).toEqual(kinds);
    },
  );

  it("shows no branch, pull request, issue, or herdr action on a plain directory's started task", async () => {
    renderTasks(folder, [task(4, folder, "Draft chapter", { status: "in_progress" })]);

    const details = await openDetails("Draft chapter");
    expect(within(details).getByRole("button", { name: "Complete #4" })).toBeInTheDocument();
    for (const name of [
      "Open pull request for #4",
      "Push #4 to its pull request",
      "Open #4 in herdr",
      "Restore worktree of #4",
      "Refresh commits of #4",
    ]) {
      expect(within(details).queryByRole("button", { name })).not.toBeInTheDocument();
    }
    for (const name of ["Branch", "Worktree", "Pull request"]) {
      expect(within(details).queryByRole("region", { name })).not.toBeInTheDocument();
    }
    const menu = await openMenu(4, details);
    expect(within(menu).getByRole("menuitem", { name: "Pause #4" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Link issue to #4" })).not.toBeInTheDocument();
    expect(mocked.branchFreshness).not.toHaveBeenCalled();
  });

  it("shows the branch, worktree, pull request, issue, and herdr actions of a GitHub workspace's task in review", async () => {
    mocked.herdrStatus.mockResolvedValue(ok({ running: true, version: "0.9.3" }));
    mocked.listPullRequestStatuses.mockResolvedValue([{ taskId: 2, checks: "passing", review: "pending" }]);
    renderTasks(github, [
      task(2, github, "Review UI", {
        status: "in_review",
        branch: "feat/review-ui-2",
        worktreePath: "/srv/worktrees/review-ui-2",
        herdrWorkspaceId: "w-2",
        pullRequestUrl: "https://github.com/acme/app/pull/7",
      }),
    ]);

    const details = await openDetails("Review UI");
    expect(within(details).getByRole("region", { name: "Branch" })).toHaveTextContent("feat/review-ui-2");
    expect(within(details).getByRole("region", { name: "Worktree" })).toBeInTheDocument();
    expect(within(details).getByRole("region", { name: "Pull request" })).toHaveTextContent(
      "https://github.com/acme/app/pull/7",
    );
    expect(await within(details).findByLabelText("Review of #2")).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Push #2 to its pull request" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Open #2 in herdr" })).toBeInTheDocument();
    expect(within(details).queryByRole("region", { name: "Runs" })).not.toBeInTheDocument();
    await waitFor(() => expect(mocked.branchFreshness).toHaveBeenCalledWith(2));
    const menu = await openMenu(2, details);
    expect(within(menu).getByRole("menuitem", { name: "Link issue to #2" })).toBeInTheDocument();
  });

  it("shows the runs of a plain runner workspace's started task, which needs no herdr", async () => {
    mocked.listTaskRuns.mockResolvedValue(ok([]));
    renderTasks(plainRunner, [
      task(8, plainRunner, "Port CLI", {
        status: "in_progress",
        branch: "feat/port-cli-8",
        worktreePath: "/srv/worktrees/port-cli-8",
      }),
    ]);

    const details = await openDetails("Port CLI");
    const runs = within(details).getByRole("region", { name: "Runs" });
    expect(await within(runs).findByText("No runs yet.")).toBeInTheDocument();
    expect(within(runs).getByRole("button", { name: "Start run of #8" })).toBeEnabled();
    expect(within(details).queryByRole("button", { name: "Open #8 in herdr" })).not.toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "herdr unavailable for #8" })).not.toBeInTheDocument();
    expect(mocked.listTaskRuns).toHaveBeenCalledWith(8);
  });

  it("lists the git activity of a GitHub workspace's task in the order it happened", async () => {
    const pr = "https://github.com/acme/app/pull/7";
    mocked.listTaskActivity.mockResolvedValue(
      ok([
        activity("commit", "1111111aaaa", "Add review form", 1700000000),
        activity("pr_opened", pr, "Review UI", 1700000600),
        activity("checks_failed", "1111111aaaa", "CI failed on 1111111", 1700001200),
        activity("commit", "2222222bbbb", "Fix review layout", 1700086400),
        activity("checks_passed", "2222222bbbb", "CI passed on 2222222", 1700087000),
        activity("pr_merged", pr, "Review UI", 1700172800),
      ]),
    );
    renderTasks(github, [
      task(2, github, "Review UI", { status: "in_review", branch: "feat/review-ui-2", pullRequestUrl: pr }),
    ]);

    const details = await openDetails("Review UI");
    const list = await within(details).findByRole("list", { name: "Git activity of #2" });
    const row = (at: number, ...parts: string[]) => formatWhen(at) + parts.join("");
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      row(1700000000, "Commit", "1111111", "Add review form"),
      row(1700000600, "Pull request opened", "#7", "Review UI"),
      row(1700001200, "CI failed", "1111111", "CI failed on 1111111"),
      row(1700086400, "Commit", "2222222", "Fix review layout"),
      row(1700087000, "CI passed", "2222222", "CI passed on 2222222"),
      row(1700172800, "Merged", "#7", "Review UI"),
    ]);
    const links = within(list).getAllByRole("link", { name: "Pull request #7" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([pr, pr]);
    expect(mocked.listTaskActivity).toHaveBeenCalledWith(2);
  });

  it.each([{ workspace: manualGitHub }, { workspace: folder }])(
    "shows no git activity for a task of a $workspace.source workspace completed by hand",
    async ({ workspace }) => {
      mocked.listCommitRecords.mockResolvedValue(
        ok([{ taskId: 6, sha: "3333333cccc", message: "Draft outline", author: "Ada", committedAt: 1700000000 }]),
      );
      mocked.listTaskActivity.mockResolvedValue(ok([activity("commit", "3333333cccc", "Draft outline", 1700000000)]));
      renderTasks(workspace, [task(6, workspace, "Write outline", { status: "in_progress" })]);

      const details = await openDetails("Write outline");
      // The commits load like the activity would, so the activity had its chance to show.
      expect(await within(details).findByRole("list", { name: "Commits of #6" })).toBeInTheDocument();
      expect(within(details).queryByRole("region", { name: "Git activity" })).not.toBeInTheDocument();
      expect(mocked.listTaskActivity).not.toHaveBeenCalled();
    },
  );
});
