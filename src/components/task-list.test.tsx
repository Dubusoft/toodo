import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskList, type TaskDraft } from "@/components/task-list";
import { commands, type Task, type TaskId, type Workspace } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listWorkspaces: vi.fn(),
    listTasks: vi.fn(),
    listTaskRelations: vi.fn(),
    createTask: vi.fn(),
    startTask: vi.fn(),
    updateWorkspace: vi.fn(),
    listGuidelines: vi.fn(),
  },
}));

const mocked = vi.mocked(commands);

const app: Workspace = {
  id: 1,
  name: "app",
  description: "The **web** app",
  repository: "acme/app",
  archivedAt: null,
};

const kinds = ["Manual", "URL responds"];

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
    issue: null,
    estimate: null,
    dueDate: null,
    labels: [],
    refs: [],
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
    wait: null,
    ...overrides,
  };
}

const newDraft: TaskDraft = {
  taskType: "feat",
  title: "",
  description: "",
  criteria: [],
  estimate: "",
  estimateUnit: "hours",
  dueDate: "",
  labels: "",
};

/** Renders the tasks of `workspace`, with its new task form. */
function renderTasks(workspace: Workspace, tasks: Task[]) {
  mocked.listWorkspaces.mockResolvedValue(ok([workspace]));
  mocked.listTasks.mockResolvedValue(ok(tasks));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Page() {
    const [draft, setDraft] = useState(newDraft);
    const [selected, setSelected] = useState<TaskId | null>(null);
    return (
      <TaskList
        workspace={workspace}
        selectedTask={selected}
        onSelectTask={setSelected}
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
}

/** The labels of the options of a criterion kind picker. */
function kindOptions(select: HTMLElement) {
  return within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);
}

// The details sheet is lazy-loaded; transform it once here so no test pays for that within its timeout.
beforeAll(async () => {
  await import("@/components/task-details");
});

async function openDetails(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  return screen.findByRole("complementary", { name: "Task details" });
}

async function openMenu(id: number, scope: HTMLElement = document.body) {
  fireEvent.click(await within(scope).findByRole("button", { name: `More actions for #${id}` }));
  return screen.findByRole("menu", { name: `More actions for #${id}` });
}

describe("TaskList of a workspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    mocked.listTaskRelations.mockResolvedValue(ok([]));
    mocked.listGuidelines.mockResolvedValue(ok([]));
  });

  it("starts a ready task with no reason or references", async () => {
    mocked.startTask.mockResolvedValue(ok(task(3, app, "Write outline", { status: "in_progress" })));
    renderTasks(app, [task(3, app, "Write outline")]);

    const start = await screen.findByRole("button", { name: "Start #3" });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(mocked.startTask).toHaveBeenCalledWith(3, null, null));
  });

  it("announces when the tasks finish loading and how many a search leaves in one live region", async () => {
    renderTasks(app, [task(3, app, "Write outline"), task(4, app, "Draft summary")]);

    const status = screen.getByText("Loading tasks...");
    expect(status).toHaveAttribute("role", "status");
    await waitFor(() => expect(status).toHaveTextContent("Showing 2 tasks."));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "outline" } });
    await waitFor(() => expect(status).toHaveTextContent("Showing 1 of 2 tasks."));
  });

  it("shows the workspace repository as a link and saves edits to its details", async () => {
    mocked.updateWorkspace.mockResolvedValue(ok({ ...app, repository: null }));
    renderTasks(app, []);

    expect(screen.getByRole("link", { name: "Repository" })).toHaveAttribute("href", "https://github.com/acme/app");
    fireEvent.click(screen.getByRole("button", { name: "Edit workspace" }));
    const form = screen.getByRole("form", { name: "Workspace details" });
    fireEvent.change(within(form).getByLabelText(/^Repository/), { target: { value: " " } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocked.updateWorkspace).toHaveBeenCalledWith({ ...app, description: "The **web** app", repository: null }),
    );
  });

  it("offers a new task only manual and URL criteria", async () => {
    mocked.createTask.mockResolvedValue(ok(task(9, app, "Write docs")));
    renderTasks(app, []);

    const form = await screen.findByRole("form", { name: "New task" });
    fireEvent.focusIn(within(form).getByLabelText("Task title"));
    fireEvent.change(within(form).getByLabelText("Task title"), { target: { value: "Write docs" } });
    expect(within(form).queryByRole("checkbox", { name: "Done when merged" })).not.toBeInTheDocument();
    expect(within(form).queryByLabelText("Issue number")).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Add criterion" }));
    expect(kindOptions(within(form).getByLabelText("Criterion 1 kind"))).toEqual(kinds);
    fireEvent.change(within(form).getByLabelText("Criterion 1 text"), { target: { value: "Docs reviewed" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add task" }));

    await waitFor(() =>
      expect(mocked.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Write docs",
          criteria: [{ text: "Docs reviewed", kind: "manual", target: null }],
        }),
      ),
    );
  });

  it("offers an edited task only manual and URL criteria", async () => {
    renderTasks(app, [task(5, app, "Write docs")]);

    await openMenu(5);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit #5" }));
    const form = await screen.findByRole("form", { name: "Edit task #5" });
    expect(within(form).queryByRole("checkbox", { name: "Done when merged, #5" })).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Add criterion to #5" }));
    expect(kindOptions(within(form).getByLabelText("Criterion 1 kind of #5"))).toEqual(kinds);
  });

  it("shows a started task's lifecycle actions and its references, without execution details", async () => {
    renderTasks(app, [
      task(4, app, "Draft chapter", { status: "in_progress", refs: ["lane:draft", "pr:https://github.com/acme/app/pull/7"] }),
    ]);

    const details = await openDetails("Draft chapter");
    expect(within(details).getByRole("button", { name: "Complete #4" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Conclude #4 without completing" })).toBeInTheDocument();
    for (const name of ["Open pull request for #4", "Open #4 in herdr", "Restore worktree of #4", "Refresh commits of #4"]) {
      expect(within(details).queryByRole("button", { name })).not.toBeInTheDocument();
    }
    for (const name of ["Branch", "Worktree", "Pull request", "Runs", "Git activity"]) {
      expect(within(details).queryByRole("region", { name })).not.toBeInTheDocument();
    }
    expect(await within(details).findByRole("list", { name: "Refs of #4" })).toHaveTextContent("Lanedraft");
    const menu = await openMenu(4, details);
    expect(within(menu).getByRole("menuitem", { name: "Pause #4" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Link issue to #4" })).not.toBeInTheDocument();
  });
});
