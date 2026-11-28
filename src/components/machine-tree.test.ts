import { describe, expect, it } from "vitest";
import { machineTree } from "@/components/machine-tree";
import type { Task, TaskId, Workspace } from "@/lib/bindings";
import type { SupervisorLane, SupervisorStatusSnapshot } from "@/lib/supervisor-status";

const workspace = (id: number, name: string) => ({ id, name }) as Workspace;
const task = (id: number, workspaceId: number) => ({ id, workspaceId }) as Task;
const lane = (key: string, machine: string, taskId: number | null): SupervisorLane => ({
  key,
  status: "working",
  task: taskId,
  machine,
  model: null,
  ageMin: 1,
  progress: null,
  screen: null,
});

const snapshot = (lanes: SupervisorLane[], machines?: SupervisorStatusSnapshot["machines"]): SupervisorStatusSnapshot => ({
  at: 0,
  status: [],
  quota: null,
  lanes,
  ...(machines ? { machines } : {}),
});

describe("machineTree", () => {
  it("puts each machine's lanes under their task's workspace, in the workspace list's order, and the rest under no workspace", () => {
    const workspaces = [workspace(1, "toodo"), workspace(2, "dori")];
    const tasks = new Map<TaskId, Task>([
      [10 as TaskId, task(10, 2)],
      [11 as TaskId, task(11, 1)],
    ]);
    const tree = machineTree(
      snapshot(
        [lane("a", "local", 10), lane("b", "local", 11), lane("c", "local", null), lane("d", "local", 99)],
        [
          { label: "local", state: "connected", version: null, sample: null },
          { label: "gpu", state: "offline", version: null, sample: null },
        ],
      ),
      tasks,
      workspaces,
    );
    expect(tree.map((node) => node.label)).toEqual(["local", "gpu"]);
    expect(tree[0]!.workspaces.map((group) => [group.workspace.name, group.lanes.map((l) => l.key)])).toEqual([
      ["toodo", ["b"]],
      ["dori", ["a"]],
    ]);
    expect(tree[0]!.loose.map((l) => l.key)).toEqual(["c", "d"]);
    expect(tree[1]).toMatchObject({ workspaces: [], loose: [] });
  });

  it("lists a machine only a lane names, as from a supervisor that sends no machines", () => {
    const tree = machineTree(snapshot([lane("a", "mac-mini", null)]), new Map(), []);
    expect(tree).toEqual([{ label: "mac-mini", machine: null, workspaces: [], loose: [lane("a", "mac-mini", null)] }]);
  });
});
