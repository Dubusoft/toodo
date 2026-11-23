import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/bindings";
import { edgeId } from "@/lib/task-graph";
import { useDependencyEditing } from "@/components/timeline/use-dependency-editing";

const add = { mutateAsync: vi.fn<(variables: unknown) => Promise<string>>(), isPending: false };
const remove = { mutateAsync: vi.fn<(variables: unknown) => Promise<null>>(), isPending: false };

vi.mock("@/lib/queries", () => ({
  useAddDependency: () => add,
  useRemoveDependency: () => remove,
}));

const tasks = [
  { id: 1, status: "done" },
  { id: 2, status: "in_progress" },
  { id: 3, status: "done" },
  { id: 4, status: "in_progress" },
] as Task[];
const dependencies = [
  { id: edgeId(1, 2), source: 1, target: 2 },
  { id: edgeId(2, 3), source: 2, target: 3 },
  { id: edgeId(1, 4), source: 1, target: 4 },
];
const line = (source: number, target: number) => ({
  source: String(source),
  target: String(target),
  sourceHandle: null,
  targetHandle: null,
});

/** Runs `action` and lets the mutations it starts settle. */
async function settled(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

beforeEach(() => {
  add.mutateAsync.mockReset();
  remove.mutateAsync.mockReset();
});

describe("useDependencyEditing", () => {
  it("asks before adding prerequisites that would pause a started task, one at a time, then adds each confirmed", async () => {
    add.mutateAsync.mockResolvedValue("confirm_pause");
    const { result } = renderHook(() => useDependencyEditing(tasks, dependencies));

    await settled(() => result.current.connect(line(1, 2)));
    await settled(() => result.current.connect(line(3, 4)));
    expect(add.mutateAsync).toHaveBeenCalledWith({ id: 2, dependsOn: 1, confirmPause: false });
    expect(result.current.confirmingEdge).toEqual({ id: 2, dependsOn: 1 });

    add.mutateAsync.mockResolvedValue("added");
    await settled(() => result.current.confirmEdge(result.current.confirmingEdge!));
    expect(add.mutateAsync).toHaveBeenLastCalledWith({ id: 2, dependsOn: 1, confirmPause: true });
    expect(result.current.confirmingEdge).toEqual({ id: 4, dependsOn: 3 });

    await settled(() => result.current.dropConfirmation(result.current.confirmingEdge!));
    expect(result.current.confirmingEdge).toBeNull();
    expect(add.mutateAsync).toHaveBeenCalledTimes(3);
  });

  it("adds any other prerequisite without asking, and shows why one could not be added", async () => {
    add.mutateAsync.mockResolvedValue("added");
    const { result } = renderHook(() => useDependencyEditing(tasks, dependencies));

    await settled(() => result.current.connect(line(1, 2)));
    expect(result.current.confirmingEdge).toBeNull();
    expect(result.current.errors).toEqual([]);

    add.mutateAsync.mockRejectedValue(new Error("would close a cycle"));
    await settled(() => result.current.connect(line(2, 1)));
    expect(result.current.errors).toEqual(["would close a cycle"]);
  });

  it("removes each line asked for, keeping those that fail selected with their errors", async () => {
    const { result } = renderHook(() => useDependencyEditing(tasks, dependencies));
    await settled(() =>
      result.current.selectEdges(
        dependencies.map((edge) => ({ type: "select" as const, id: edge.id, selected: true })),
      ),
    );
    // A line into a done task cannot change, so it is not offered for removal.
    expect(result.current.removable.map((edge) => edge.id)).toEqual([edgeId(1, 2), edgeId(1, 4)]);

    remove.mutateAsync.mockImplementation(async (variables) => {
      if ((variables as { id: number }).id === 4) throw new Error("server unreachable");
      return null;
    });
    await settled(() => result.current.removeEdges([line(1, 2), line(1, 4)]));

    expect(remove.mutateAsync.mock.calls).toEqual([[{ id: 2, dependsOn: 1 }], [{ id: 4, dependsOn: 1 }]]);
    expect(result.current.removable.map((edge) => edge.id)).toEqual([edgeId(1, 4)]);
    expect(result.current.errors).toEqual(["Could not remove #1 \u2192 #4: server unreachable"]);
  });
});
