import { expect, test } from "bun:test";
import { DependencyError, isReady } from "../domain/dag.ts";
import type { Workspace } from "../domain/model.ts";
import { memoryStorage, newTask, stored, workspace, expectFailure } from "./storage-fixtures.ts";
import type { TaskQuery } from "./task-query.ts";
import type { NewPlanTask, PlanLink } from "./tasks.ts";

test("Query tasks filters and pages back from the newest", () => {
  const storage = memoryStorage();
  const local = workspace(storage, "Local");
  const remote = workspace(storage, "Remote");
  const [a, b, c, d, e] = ["A", "B", "C", "D", "E"].map((title) =>
    storage.createTask(newTask(title === "B" || title === "D" ? remote : local, title)).id);
  for (const id of [a, b, c]) {
    storage.db.run("UPDATE tasks SET status = 'done', resolution = 'completed' WHERE id = ?1", [id]);
  }
  const ids = (query: TaskQuery) => storage.queryTasks(query).map(({ id }) => id);
  expect(ids({})).toEqual([a, b, c, d, e]);
  expect(ids({ statuses: ["done"], limit: 2 })).toEqual([b, c]);
  expect(ids({ statuses: ["done"], before: b, limit: 2 })).toEqual([a]);
  expect(ids({ workspace: local.id, statuses: ["planned", "in_progress"] })).toEqual([e]);
  expect(ids({ ids: [d, a] })).toEqual([a, d]);
  expect(ids({ ids: [] })).toEqual([]);
  expect(storage.queryTasks({ before: e, limit: 2 })).toEqual([stored(storage, c), stored(storage, d)]);
});

function plan(ws: Workspace, title: string, dependsOn: readonly PlanLink[] = []): NewPlanTask {
  return { task: newTask(ws, title), labels: ["plan"], refs: [], dependsOn, related: [] };
}

test("A plan dependency that closes a cycle with an earlier one writes nothing", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const existing = storage.createTask(newTask(ws, "Existing"));
  const first = plan(ws, "First", [{ kind: "existing", id: existing.id }, { kind: "new", index: 1 }]);
  const second = plan(ws, "Second", [{ kind: "new", index: 0 }]);
  expect(() => storage.createTasks([first, second])).toThrow(
    `dependency cycle: ${existing.id + 2} -> ${existing.id + 1} -> ${existing.id + 2}`,
  );
  expect(storage.listAllTasks()).toEqual([existing]);
  expect(storage.db.query("SELECT task_id FROM task_dependencies").all()).toEqual([]);
  expect(storage.db.query("SELECT task_id FROM task_labels").all()).toEqual([]);
});

test("A plan depends on tasks of other workspaces", () => {
  const storage = memoryStorage();
  const library = workspace(storage, "Library");
  const app = workspace(storage, "App");
  const api = storage.createTask(newTask(library, "Add low level API"));
  const [ui, docs] = storage.createTasks([
    plan(app, "Build UI on the API", [{ kind: "existing", id: api.id }]),
    plan(library, "Document the UI", [{ kind: "new", index: 0 }]),
  ]);
  expect(ui.workspaceId).toBe(app.id);
  expect(ui.dependsOn).toEqual(new Set([api.id]));
  expect(docs.dependsOn).toEqual(new Set([ui.id]));
  expect(isReady(storage.listAllTasks(), ui.id)).toBe(false);
  expectFailure(() => storage.addDependency(api.id, docs.id), {
    kind: "dependency", error: new DependencyError({ kind: "cycle", path: [api.id, docs.id, ui.id, api.id] }),
  });
});

test("A plan link past the end of the plan is rejected and writes nothing", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const link = { kind: "new", index: 2 } as const;
  for (const second of [plan(ws, "Second", [link]), { ...plan(ws, "Related"), related: [link] }]) {
    expectFailure(() => storage.createTasks([plan(ws, "First"), second]),
      { kind: "plan_link_out_of_range", index: 2, tasks: 2 });
    expect(storage.listAllTasks()).toEqual([]);
    expect(storage.db.query("SELECT task_id FROM task_labels").all()).toEqual([]);
  }
});
