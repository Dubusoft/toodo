import { expect, test } from "bun:test";
import { DependencyError, isReady } from "../domain/dag.ts";
import { taskId } from "../domain/model.ts";
import { expectFailure, finish, memoryStorage, newTask, stored, workspace } from "./storage-fixtures.ts";

test("Rejected dependencies write nothing", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b, c] = ["A", "B", "C"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(b, a);
  storage.addDependency(c, b);
  const before = storage.listTasks(ws.id);
  const missing = taskId(999);
  for (const [task, dependsOn, problem] of [
    [a, c, { kind: "cycle", path: [a, c, b, a] }],
    [a, a, { kind: "self_dependency", id: a }],
    [a, missing, { kind: "unknown_task", id: missing }],
    [missing, a, { kind: "unknown_task", id: missing }],
  ] as const) {
    expectFailure(() => storage.addDependency(task, dependsOn), { kind: "dependency", error: new DependencyError(problem) });
  }
  expect(storage.listTasks(ws.id)).toEqual(before);
  expect(storage.db.query("SELECT task_id FROM task_dependencies").all()).toHaveLength(2);
});

test("Dependencies across workspaces share one DAG", () => {
  const storage = memoryStorage();
  const library = workspace(storage, "Library");
  const app = workspace(storage, "App");
  const api = storage.createTask(newTask(library, "Add low level API")).id;
  const ui = storage.createTask(newTask(app, "Build UI on the API")).id;
  const docs = storage.createTask(newTask(library, "Document the UI")).id;
  storage.addDependency(ui, api);
  expect(isReady(storage.listAllTasks(), ui)).toBe(false);
  expect(stored(storage, ui).dependsOn).toEqual(new Set([api]));
  storage.addDependency(docs, ui);
  expectFailure(() => storage.addDependency(api, docs), {
    kind: "dependency", error: new DependencyError({ kind: "cycle", path: [api, docs, ui, api] }),
  });
  const before = storage.listAllTasks();
  expectFailure(() => storage.archiveWorkspace(library.id), {
    kind: "workspace_has_dependents", workspace: library.id, task: ui, dependsOn: api,
  });
  expect(storage.listAllTasks()).toEqual(before);
  storage.setTaskStatus(api, "in_progress");
  storage.setTaskStatus(api, "in_review");
  expect(isReady(storage.listAllTasks(), ui)).toBe(false);
  expect(storage.completeTask(api, null, []).status).toBe("done");
  expect(isReady(storage.listAllTasks(), ui)).toBe(true);
  storage.setTaskStatus(ui, "in_progress");
  storage.archiveWorkspace(library.id);
  expect(storage.getTask(api)).toBeNull();
  expect(stored(storage, ui)).toMatchObject({ status: "in_progress", dependsOn: new Set() });
});

test("Dependency changes decide whether a task can start", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b] = ["A", "B"].map((title) => storage.createTask(newTask(ws, title)).id);
  expect(isReady(storage.listAllTasks(), b)).toBe(true);
  storage.addDependency(b, a);
  storage.addDependency(b, a);
  expect(isReady(storage.listAllTasks(), b)).toBe(false);
  expect(stored(storage, b).status).toBe("planned");
  storage.removeDependency(b, a);
  expect(isReady(storage.listAllTasks(), b)).toBe(true);
  expect(stored(storage, b).dependsOn).toEqual(new Set());
  expect(stored(storage, b).timeline).toEqual([{ status: "planned", at: 100, reason: null }]);
});

test("A prerequisite that is not done pauses a task in progress", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, fix, docs] = ["A", "Fix", "Docs"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.setClock(() => 200);
  const started = storage.setTaskStatus(a, "in_progress");
  storage.setTaskRefs(a, ["branch:feat/a-1"]);
  storage.updateTask(started);
  storage.setClock(() => 300);
  const { task, paused } = storage.addDependencies(a, [fix, docs]);
  expect(paused).toBe(true);
  expect(task).toMatchObject({ status: "planned", dependsOn: new Set([fix, docs]), refs: ["branch:feat/a-1"] });
  const waiting = `#${fix} Fix (planned), #${docs} Docs (planned)`;
  expect(task.timeline).toEqual([
    { status: "planned", at: 100, reason: null },
    { status: "in_progress", at: 200, reason: null },
    { status: "planned", at: 300, reason: `Waiting on ${waiting}` },
  ]);
  expect(task.notes).toEqual([{ kind: "blocker", body: `Paused: waiting on ${waiting}`, at: 300 }]);
});

test("Asking before a pause adds nothing that would pause the task", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, fix, b] = ["A", "Fix", "B"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.setTaskStatus(a, "in_progress");
  expect(storage.addDependenciesWith(a, [fix], "ask")).toEqual({ kind: "needs_pause" });
  expect(stored(storage, a)).toMatchObject({ status: "in_progress", dependsOn: new Set(), notes: [] });
  expect(storage.addDependenciesWith(b, [fix], "ask")).toMatchObject({
    kind: "added", added: { paused: false, task: { dependsOn: new Set([fix]) } },
  });
});

test("A done task cannot wait on new prerequisites", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, base, fix] = ["A", "Base", "Fix"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.setTaskStatus(a, "in_progress");
  storage.setTaskStatus(a, "in_review");
  storage.addDependency(a, base);
  storage.setTaskStatus(a, "done");
  expectFailure(() => storage.addDependency(a, fix), { kind: "prerequisite_of_done_task", task: a, dependsOn: [fix] });
  expectFailure(() => storage.removeDependency(a, base), { kind: "dependency_of_done_task", task: a, dependsOn: base });
  expect(stored(storage, a).dependsOn).toEqual(new Set([base]));
});

test("Removing a dependency or link that does not exist is rejected", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b] = ["A", "B"].map((title) => storage.createTask(newTask(ws, title)).id);
  expectFailure(() => storage.removeDependency(a, b), { kind: "dependency_not_found", task: a, dependsOn: b });
  expectFailure(() => storage.removeRelated(a, b), { kind: "relation_not_found", task: a, related: b });
});

test("A done prerequisite or a task in review is not paused", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [base, a, b, fix] = ["Base", "A", "B", "Fix"].map((title) => storage.createTask(newTask(ws, title)).id);
  finish(storage, base);
  storage.setTaskStatus(a, "in_progress");
  storage.setTaskStatus(b, "in_progress");
  storage.setTaskStatus(b, "in_review");
  expect(storage.addDependencies(a, [base])).toMatchObject({ paused: false, task: { status: "in_progress" } });
  expect(storage.addDependencies(b, [fix])).toMatchObject({ paused: false, task: { status: "in_review" } });
});

test("One rejected prerequisite adds none and keeps the task in progress", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, fix, followUp] = ["A", "Fix", "Follow-up"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(followUp, a);
  storage.setTaskStatus(a, "in_progress");
  expectFailure(() => storage.addDependencies(a, [fix, followUp]), {
    kind: "dependency", error: new DependencyError({ kind: "cycle", path: [a, followUp, a] }),
  });
  expect(stored(storage, a)).toMatchObject({ status: "in_progress", dependsOn: new Set() });
});
