import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArchivePanel } from "@/components/archive-panel";
import { commands, type Task, type Workspace } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    listArchive: vi.fn(),
    restoreWorkspace: vi.fn(),
    purgeWorkspace: vi.fn(),
    restoreTask: vi.fn(),
    purgeTask: vi.fn(),
  },
}));

const mocked = vi.mocked(commands);

const workspace: Workspace = {
  id: 2,
  name: "herdr",
  location: { kind: "ssh", machine: "devbox", path: "/srv/herdr" },
  defaultBaseBranch: "main",
  agentMerge: "never",
  pathProblem: null,
  source: "github",
  completion: "pr_merge",
  runner: "herdr",
};

const task = { id: 7, workspaceId: 1, title: "Drop the old parser", status: "done" } as Task;

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ArchivePanel />
    </QueryClientProvider>,
  );
}

describe("ArchivePanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocked.listArchive.mockResolvedValue({ status: "ok", data: { workspaces: [workspace], tasks: [task] } });
  });

  it("restores an archived task", async () => {
    mocked.restoreTask.mockResolvedValue({ status: "ok", data: task });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Restore #7 Drop the old parser" }));

    await vi.waitFor(() => expect(mocked.restoreTask).toHaveBeenCalledWith(7));
    expect(mocked.purgeTask).not.toHaveBeenCalled();
  });

  it("purges an archived workspace only after confirmation", async () => {
    mocked.purgeWorkspace.mockResolvedValue({ status: "ok", data: null });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Delete herdr permanently" }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm permanent delete" });
    expect(dialog).toHaveTextContent("herdr and its tasks");
    expect(mocked.purgeWorkspace).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await vi.waitFor(() => expect(mocked.purgeWorkspace).toHaveBeenCalledWith(2));
    expect(mocked.restoreWorkspace).not.toHaveBeenCalled();
  });

  it("shows why a restore was rejected", async () => {
    mocked.restoreTask.mockResolvedValue({
      status: "error",
      error: { kind: "rejected", code: "rejected", message: "restoring would close the dependency cycle 7 -> 8 -> 7" },
    } as never);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Restore #7 Drop the old parser" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("restoring would close the dependency cycle");
  });
});
