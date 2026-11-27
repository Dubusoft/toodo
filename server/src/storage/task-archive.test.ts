import { expect, test } from "bun:test";
import { DependencyError, isReady } from "../domain/dag.ts";
import { workspaceId } from "../domain/model.ts";
import { commit, expectFailure, memoryStorage, newTask, seedCommits, stored, workspace } from "./storage-fixtures.ts";

test("Archived tasks leave the DAG until restored and purge explicitly", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b] = ["A", "B"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(b, a);
  expect(isReady(storage.listAllTasks(), b)).toBe(false);
  expectFailure(() => storage.purgeTask(a), { kind: "task_not_archived", task: a });
  storage.archiveTask(a);
  expect(storage.getTask(a)).toBeNull();
  expect(stored(storage, b).dependsOn).toEqual(new Set());
  expect(isReady(storage.listAllTasks(), b)).toBe(true);
  expect(storage.archivedTasks().map(({ id }) => id)).toEqual([a]);
  expectFailure(() => storage.addDependency(b, a), {
    kind: "dependency", error: new DependencyError({ kind: "unknown_task", id: a }),
  });
  const c = storage.createTask(newTask(ws, "C")).id;
  storage.addDependency(c, b);
  storage.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?1, ?2)", [a, c]);
  expect(() => storage.restoreTask(a)).toThrow("restoring would close the dependency cycle");
  expect(storage.getTask(a)).toBeNull();
  storage.removeDependency(c, b);
  expect(storage.restoreTask(a).id).toBe(a);
  expect(stored(storage, b).dependsOn).toEqual(new Set([a]));
  expectFailure(() => storage.restoreTask(a), { kind: "task_not_archived", task: a });
  storage.archiveTask(a);
  storage.purgeTask(a);
  expectFailure(() => storage.purgeTask(a), { kind: "task_not_found", task: a });
  expect(storage.db.query("SELECT task_id FROM task_dependencies").all()).toEqual([]);
});

test("Archive done tasks archives only the live done tasks of the workspace", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const other = workspace(storage, "Other");
  const [planned, first, second] = ["Planned", "First", "Second"].map((title) => storage.createTask(newTask(ws, title)).id);
  const elsewhere = storage.createTask(newTask(other, "Elsewhere")).id;
  for (const id of [first, second, elsewhere]) {
    storage.setTaskStatus(id, "in_progress");
    storage.concludeTask(id, "Not needed", null);
  }
  expect(storage.archiveDoneTasks(ws.id)).toEqual([first, second]);
  expect(storage.listAllTasks().map(({ id }) => id)).toEqual([planned, elsewhere]);
  expect(storage.archiveDoneTasks(ws.id)).toEqual([]);
  const unknown = workspaceId(ws.id + 100);
  expectFailure(() => storage.archiveDoneTasks(unknown), { kind: "workspace_not_found", workspace: unknown });
});

test("Moving a task changes only the workspace and rejects archived ones", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const general = workspace(storage, "General");
  const archived = workspace(storage, "Old");
  const prerequisite = storage.createTask(newTask(ws, "Prerequisite")).id;
  const id = storage.createTask(newTask(ws, "Move me")).id;
  storage.addDependency(id, prerequisite);
  const before = storage.setTaskRefs(id, ["lane:move"]);
  storage.archiveWorkspace(archived.id);
  const moved = storage.moveTask(id, general.id);
  expect(moved).toEqual({ ...before, workspaceId: general.id });
  expect(storage.listTasks(general.id)).toEqual([moved]);
  for (const invalid of [archived.id, workspaceId(archived.id + 100)]) {
    expectFailure(() => storage.moveTask(id, invalid), { kind: "workspace_not_found", workspace: invalid });
  }
  expect(storage.getTask(id)).toEqual(moved);
});

test("Deleting a task releases its dependents", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b] = ["A", "B"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(b, a);
  seedCommits(storage, [commit(a, "aaa", 1)]);
  storage.deleteTask(a);
  storage.ensureReady(b);
  expect(storage.getTask(a)).toBeNull();
  expect(stored(storage, b).dependsOn).toEqual(new Set());
  expect(storage.listCommitRecords(a)).toEqual([]);
  expectFailure(() => storage.deleteTask(a), { kind: "task_not_found", task: a });
});
