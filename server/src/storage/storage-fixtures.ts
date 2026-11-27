import { expect, onTestFinished } from "bun:test";
import type { CommitRecord, Task, TaskId, Workspace } from "../domain/model.ts";
import { StorageError } from "./errors.ts";
import type { StorageFailure } from "./errors.ts";
import { Storage } from "./storage.ts";
import type { NewTask } from "./tasks.ts";
import { openMemoryDatabase } from "./testing.ts";

export function memoryStorage(now = 100): Storage {
  const db = openMemoryDatabase();
  onTestFinished(() => db.close());
  return new Storage(db, () => now);
}

export function workspace(storage: Storage, name = "Toodo"): Workspace {
  return storage.createWorkspace({ name, description: null, repository: null });
}

export function newTask(workspace: Workspace, title: string, fields: Partial<NewTask> = {}): NewTask {
  return {
    workspaceId: workspace.id, taskType: "feat", title, description: "",
    estimate: null, dueDate: null, autopilot: false, criteria: [], ...fields,
  };
}

export function stored(storage: Storage, id: TaskId): Task {
  const task = storage.getTask(id);
  if (task === null) throw new Error(`Missing test task ${id}`);
  return task;
}

export function expectFailure(operation: () => unknown, failure: StorageFailure): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    expect(error.failure).toEqual(failure);
    return;
  }
  throw new Error(`Expected ${failure.kind}`);
}

export function commit(taskId: TaskId, sha: string, committedAt: number): CommitRecord {
  return { taskId, sha, committedAt, author: "Author", message: `Commit ${sha}` };
}

export function seedCommits(storage: Storage, records: readonly CommitRecord[]): void {
  for (const [position, record] of records.entries()) {
    storage.db.run(`INSERT INTO commit_records (task_id, position, sha, message, author, committed_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [record.taskId, position, record.sha, record.message, record.author, record.committedAt]);
  }
}

export function finish(storage: Storage, id: TaskId): void {
  storage.setTaskStatus(id, "in_progress");
  storage.setTaskStatus(id, "in_review");
  storage.setTaskStatus(id, "done");
}
