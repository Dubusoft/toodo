import { expect, test } from "bun:test";
import { command, CommandError } from "../../commands/errors.ts";
import { task } from "../../commands/types.ts";
import { taskId, workspaceId } from "../../domain/model.ts";
import { newTask, stored, workspace } from "../../storage/storage-fixtures.ts";
import { StorageError } from "../../storage/errors.ts";
import type { NewPlanTask } from "../../storage/tasks.ts";
import { createPlan, createTask } from "./create.ts";
import * as R from "./requests.ts";
import { createTaskIn, storageWithWorkspace, toolFailure } from "./tool-fixtures.ts";

test("Create and start accept a legacy request ID", () => {
  const create = R.createTask({
    workspace_id: 1, task_type: "feat", title: "Add login", request_id: "chat-12/create-1",
  });
  expect(create.title).toBe("Add login");
  const start = R.startTask({ id: 7, request_id: "event-40/start-7" });
  expect(start.id).toBe(7);
});

test("A task is created with its dependencies", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const first = create("Schema");
  const second = create("API", [first.id]);
  expect(second.dependsOn).toEqual([first.id]);
  expect(second.status).toBe("planned");
  expect(task(stored(storage, taskId(second.id)))).toEqual(second);
});

test("An unknown prerequisite or empty title creates nothing", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  expect(toolFailure(() => create("API", [42])).kind).toBe("notFound");
  expect(toolFailure(() => create("  ")).kind).toBe("invalidInput");
  expect(storage.listAllTasks()).toEqual([]);
});

test("Creating a plan creates every task with its links", () => {
  const { storage, ws } = storageWithWorkspace();
  const existing = storage.createTask(newTask(ws, "Earlier work")).id;
  const fields = { workspace_id: ws.id, task_type: "feat" };
  const created = createPlan(storage, R.createPlan({ tasks: [
    { ...fields, key: "ui", title: "UI", depends_on_keys: ["api"], depends_on: [existing], related_keys: ["schema"] },
    { ...fields, key: "schema", title: "Schema", labels: ["search"], criteria: [{ text: "Migrated", kind: "manual" }] },
    { ...fields, key: "api", title: "API", depends_on_keys: ["schema"], related: [existing] },
  ] }));

  expect(created.tasks.map((planned) => planned.key)).toEqual(["ui", "schema", "api"]);
  const [ui, schema, api] = created.tasks;
  expect([...ui.dependsOn].sort((a, b) => a - b)).toEqual([existing, api.id]);
  expect(api.dependsOn).toEqual([schema.id]);
  expect(schema.dependsOn).toEqual([]);
  expect(schema.labels).toEqual(["search"]);
  expect(schema.criteria).toHaveLength(1);
  expect(api.criteria).toEqual([]);
  const pair = (a: number, b: number): [ReturnType<typeof taskId>, ReturnType<typeof taskId>] =>
    [taskId(Math.min(a, b)), taskId(Math.max(a, b))];
  expect([...storage.listRelations()].sort()).toEqual([pair(ui.id, schema.id), pair(api.id, existing)].sort());
});

test("Creating a plan creates nothing when any task fails", () => {
  const { storage, ws } = storageWithWorkspace();
  const fields = { workspace_id: ws.id, task_type: "feat" };
  const first = { ...fields, key: "schema", title: "Schema" };
  const last = (overrides: object) => ({ ...fields, key: "api", title: "API", ...overrides });
  const plan = (tasks: readonly object[]) => createPlan(storage, R.createPlan({ tasks }));
  const cases = [
    ["unknown task", { depends_on: [999] }],
    ["unknown related task", { related: [999] }],
    ["unknown key", { depends_on_keys: ["ui"] }],
    ["own key", { related_keys: ["api"] }],
    ["repeated key", { key: "schema" }],
    ["empty key", { key: " " }],
    ["unknown workspace", { workspace_id: 999 }],
    ["bad label", { labels: ["a,b"] }],
    ["bad due date", { due_date: "tomorrow" }],
    ["empty title", { title: " " }],
  ] as const;

  for (const [name, overrides] of cases) {
    expect(command(() => plan([first, last(overrides)])), name).toThrow(CommandError);
    expect(storage.listAllTasks(), name).toEqual([]);
  }
  const cycle = toolFailure(() => plan([
    first,
    last({ depends_on_keys: ["ui"] }),
    { ...fields, key: "ui", title: "UI", depends_on_keys: ["api", "schema"] },
  ]));
  expect(cycle.message).toContain("`api`, `ui`");
  toolFailure(() => plan([]));
  expect(storage.listAllTasks()).toEqual([]);
});

test("Creating a plan creates nothing in or linked to an archived workspace", () => {
  const { storage, ws } = storageWithWorkspace();
  const old = workspace(storage, "Old");
  const oldTask = createTaskIn(storage, old.id)("Old work");
  storage.archiveWorkspace(old.id);
  const item = (target: typeof ws): NewPlanTask => ({
    task: newTask(target, "Task"), labels: [], refs: [], dependsOn: [], related: [],
  });
  expect(toolFailure(() => storage.createTasks([item(ws), item(old)])).code).toBe("workspaceNotFound");
  const cases = [
    ["archived workspace", { workspace_id: old.id }, "workspaceNotFound"],
    ["archived prerequisite", { depends_on: [oldTask.id] }, "notFound"],
    ["archived related task", { related: [oldTask.id] }, "notFound"],
  ] as const;

  for (const [name, fields, code] of cases) {
    const request = R.createPlan({ tasks: [
      { key: "api", workspace_id: ws.id, task_type: "feat", title: "API", ...fields },
    ] });
    expect(toolFailure(() => createPlan(storage, request)).code, name).toBe(code);
  }
  storage.restoreWorkspace(old.id);
  expect(storage.listAllTasks().map((storedTask) => storedTask.id)).toEqual([taskId(oldTask.id)]);
  expect(storage.listRelations()).toEqual([]);
});

test("Creating tasks rolls back every task on a failure", () => {
  const { storage, ws } = storageWithWorkspace();
  const item = (fields: Partial<NewPlanTask> = {}): NewPlanTask => ({
    task: newTask(ws, "Task"), labels: ["search"], refs: [], dependsOn: [], related: [], ...fields,
  });
  const missingWorkspace = { ...ws, id: workspaceId(999) };

  for (const failing of [
    item({ task: newTask(missingWorkspace, "Task") }),
    item({ dependsOn: [{ kind: "existing", id: taskId(999) }] }),
  ]) {
    expect(() => storage.createTasks([item(), failing])).toThrow(StorageError);
    expect(storage.listAllTasks()).toEqual([]);
  }
});

test("Creating a task writes nothing when a related link fails", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const prerequisite = create("Schema");
  const linked = create("Search");
  const tables = ["tasks", "task_events", "task_labels", "task_dependencies", "task_relations", "task_criteria", "task_notes"];
  const counts = () => tables.map((table) =>
    storage.db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count);
  const before = counts();
  storage.db.run(`
    CREATE TEMP TRIGGER fail_related BEFORE INSERT ON task_relations
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    CREATE TEMP TRIGGER keep_tasks BEFORE DELETE ON tasks
      BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;
  `);
  const request = R.createTask({
    workspace_id: ws.id,
    task_type: "feat",
    title: "API",
    labels: ["search"],
    refs: ["lane:api"],
    depends_on: [prerequisite.id],
    related: [linked.id],
    criteria: [{ text: "Deployed", kind: "manual" }],
  });

  expect(toolFailure(() => createTask(storage, request)).message).toContain("injected failure");
  expect(counts()).toEqual(before);
});
