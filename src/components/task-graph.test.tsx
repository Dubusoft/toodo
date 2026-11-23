import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactFlowProps } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskGraph } from "@/components/task-graph";
import { commands, type DependencyOutcome, type Task } from "@/lib/bindings";

vi.mock("@/lib/bindings", () => ({
  commands: {
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
  },
}));

// jsdom cannot lay out the React Flow canvas, so a stand-in takes its place: it lists the edges
// with their selection, and the tests draw or select edges through the props it was given, the
// way a drag or a click on the canvas would.
let flow: ReactFlowProps;
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  ReactFlow: (props: ReactFlowProps) => {
    flow = props;
    return (
      <ul aria-label="Edges">
        {props.edges?.map((edge) => (
          <li key={edge.id} aria-selected={edge.selected}>
            {edge.id}
          </li>
        ))}
      </ul>
    );
  },
}));

const mocked = vi.mocked(commands);

function task(id: number, dependsOn: number[] = []): Task {
  return {
    id,
    workspaceId: 1,
    taskType: "feat",
    title: `Task ${id}`,
    description: "",
    status: "planned",
    dependsOn,
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
  };
}

function renderGraph(tasks: Task[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TaskGraph
        tasks={tasks}
        allTasks={tasks}
        dimmed={new Set()}
        workspaceLabel={() => null}
        statusLabel={() => "Planned"}
        statusStyle={() => ""}
        ready={() => true}
        scale="day"
        onScaleChange={() => {}}
        selectedTaskId={null}
        onSelectedTaskChange={() => {}}
        renderDetail={() => null}
      />
    </QueryClientProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("TaskGraph", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps an edge that failed to be removed selected, with its error", async () => {
    mocked.removeDependency.mockImplementation(async (_taskId, dependsOn) =>
      dependsOn === 1
        ? ({ status: "error", error: { kind: "rejected", code: "rejected", message: "task #3 is done" } } as never)
        : { status: "ok", data: null },
    );
    renderGraph([task(1), task(2), task(3, [1, 2])]);

    act(() =>
      flow.onEdgesChange?.([
        { type: "select", id: "1->3", selected: true },
        { type: "select", id: "2->3", selected: true },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove #1 \u2192 #3, #2 \u2192 #3" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove #1 \u2192 #3: task #3 is done");
    expect(mocked.removeDependency).toHaveBeenCalledTimes(2);
    const edges = within(screen.getByRole("list", { name: "Edges" }));
    expect(edges.getByText("1->3")).toHaveAttribute("aria-selected", "true");
    expect(edges.getByText("2->3")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Remove #1 \u2192 #3" })).toBeInTheDocument();
  });

  it("asks to confirm each of two edges drawn in quick succession that would pause a task", async () => {
    const first = deferred<{ status: "ok"; data: DependencyOutcome }>();
    const second = deferred<{ status: "ok"; data: DependencyOutcome }>();
    mocked.addDependency.mockImplementation((taskId, _dependsOn, confirmPause) =>
      confirmPause ? Promise.resolve({ status: "ok", data: "added" }) : taskId === 3 ? first.promise : second.promise,
    );
    renderGraph([task(1), task(2), task(3), task(4)]);

    act(() => {
      flow.onConnect?.({ source: "1", target: "3", sourceHandle: null, targetHandle: null });
      flow.onConnect?.({ source: "2", target: "4", sourceHandle: null, targetHandle: null });
    });
    await act(async () => {
      first.resolve({ status: "ok", data: "confirm_pause" });
      second.resolve({ status: "ok", data: "confirm_pause" });
    });

    const firstConfirmation = screen.getByRole("group", { name: "Confirm prerequisite of #3" });
    fireEvent.click(within(firstConfirmation).getByRole("button", { name: "Pause and add" }));

    expect(await screen.findByRole("group", { name: "Confirm prerequisite of #4" })).toBeInTheDocument();
    expect(mocked.addDependency).toHaveBeenCalledWith(3, 1, true);
    expect(screen.queryByRole("group", { name: "Confirm prerequisite of #3" })).not.toBeInTheDocument();
  });
});
