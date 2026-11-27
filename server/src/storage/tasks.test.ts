import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskId } from "../domain/model.ts";
import { SCHEMA_VERSION, openWriter, schemaVersion } from "./database.ts";
import { Storage } from "./storage.ts";
import { commit, expectFailure, finish, memoryStorage, newTask, seedCommits, stored, workspace } from "./storage-fixtures.ts";
import { createDatabase } from "./testing.ts";

test("Entities survive reopening the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "toodo-storage-"));
  try {
    const path = join(dir, "toodo.sqlite3");
    createDatabase(path);
    const expected = (() => {
      using db = openWriter(path);
      const storage = new Storage(db, () => 100);
      const local = storage.createWorkspace({ name: "Toodo", description: null, repository: "local:C:\\src\\toodo" });
      const remote = storage.createWorkspace({ name: "Server", description: null, repository: "ssh:devbox:/home/me/server" });
      const base = storage.createTask(newTask(local, "Base"));
      const started = storage.createTask(newTask(local, "Login page"));
      const remoteTask = storage.createTask(newTask(remote, "Remote fix"));
      storage.addDependency(started.id, base.id);
      finish(storage, base.id);
      storage.setTaskStatus(started.id, "in_progress");
      storage.updateTask({ ...started, taskType: "fix", description: "Updated task" });
      const commits = [commit(started.id, "bbb", 20), commit(started.id, "aaa", 10)];
      seedCommits(storage, commits);
      return { local, remote, base, started, remoteTask, commits,
        localTasks: storage.listTasks(local.id), remoteTasks: storage.listTasks(remote.id) };
    })();
    using db = openWriter(path);
    const storage = new Storage(db);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(storage.listWorkspaces()).toEqual([expected.local, expected.remote]);
    expect(storage.getWorkspace(expected.remote.id)).toEqual(expected.remote);
    expect(storage.listTasks(expected.local.id)).toEqual(expected.localTasks);
    expect(storage.listTasks(expected.remote.id)).toEqual(expected.remoteTasks);
    expect(storage.listTasks(expected.remote.id)).toEqual([expected.remoteTask]);
    const started = stored(storage, expected.started.id);
    expect(started).toMatchObject({
      status: "in_progress", taskType: "fix", description: "Updated task", dependsOn: new Set([expected.base.id]),
    });
    expect(started.timeline.map(({ status }) => status)).toEqual(["planned", "in_progress"]);
    expect(stored(storage, expected.base.id).status).toBe("done");
    expect(storage.listCommitRecords(expected.started.id)).toEqual(expected.commits);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Task IDs are not reused after deletion", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const first = storage.createTask(newTask(ws, "First"));
  storage.deleteTask(first.id);
  const second = storage.createTask(newTask(ws, "Second"));
  expect(second.id).toBeGreaterThan(first.id);
});

test("Corrupt stored values are reported as errors", () => {
  const storage = memoryStorage();
  const { id } = storage.createTask(newTask(workspace(storage), "A"));
  storage.db.run("UPDATE tasks SET refs = '[123]' WHERE id = ?1", [id]);
  expectFailure(() => storage.getTask(id), {
    kind: "invalid_data", reason: `task ${id} has refs that are not a JSON array of strings: [123]`,
  });
});

test("A linked issue is stored with the task until it is unlinked", () => {
  const storage = memoryStorage();
  const task = storage.createTask(newTask(workspace(storage), "Fix login"));
  const issue = { number: 12, url: "https://github.com/acme/toodo/issues/12" };
  expect(task.issue).toBeNull();
  const linked = storage.setTaskIssue(task.id, issue);
  expect(linked.issue).toEqual(issue);
  expect(storage.getTask(task.id)).toEqual(linked);
  expect(storage.setTaskIssue(task.id, null).issue).toBeNull();
  expectFailure(() => storage.setTaskIssue(taskId(999), issue), { kind: "task_not_found", task: 999 });
});

test("Notes are kept in order with their time and deleted with their task", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [task, other] = ["Login", "Logout"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.setClock(() => 200);
  storage.addTaskNote(task, "progress", "Chose PKCE");
  storage.setClock(() => 300);
  const noted = storage.addTaskNote(task, "blocker", "No test account");
  const expected = [
    { kind: "progress", body: "Chose PKCE", at: 200 },
    { kind: "blocker", body: "No test account", at: 300 },
  ] as const;
  expect(noted.notes).toEqual(expected);
  expect(storage.listAllTasks()[0].notes).toEqual(expected);
  expect(stored(storage, other).notes).toEqual([]);
  expectFailure(() => storage.addTaskNote(taskId(99), "progress", "Missing"), { kind: "task_not_found", task: 99 });
  storage.deleteTask(task);
  expect(storage.db.query("SELECT task_id FROM task_notes").all()).toEqual([]);
});

test("Labels are replaced per task and deleted with their task", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [task, other] = ["Login", "Logout"].map((title) => storage.createTask(newTask(ws, title)).id);
  expect(storage.setTaskLabels(task, ["auth", "q4"]).labels).toEqual(["auth", "q4"]);
  storage.setTaskLabels(other, ["auth"]);
  expect(storage.setTaskLabels(task, ["q4"]).labels).toEqual(["q4"]);
  expect(storage.listAllTasks().map(({ labels }) => labels)).toEqual([["q4"], ["auth"]]);
  expectFailure(() => storage.setTaskLabels(taskId(99), ["auth"]), { kind: "task_not_found", task: 99 });
  storage.deleteTask(task);
  expect(storage.db.query("SELECT task_id, label FROM task_labels").all()).toEqual([{ task_id: other, label: "auth" }]);
});
