import { expect, test } from "bun:test";
import { task as taskShape } from "../../commands/types.ts";
import { taskId } from "../../domain/model.ts";
import { stored, workspace } from "../../storage/storage-fixtures.ts";
import { moveTask } from "./edits.ts";
import { deleteDoneTasks, deleteTask, reopenTask } from "./lifecycle.ts";
import * as R from "./requests.ts";
import { createTaskIn, storageWithWorkspace, toolFailure } from "./tool-fixtures.ts";

test("Moving a done task preserves its record and rejects an archived destination", () => {
  const { storage, ws } = storageWithWorkspace();
  const general = workspace(storage, "General");
  const old = workspace(storage, "Old");
  storage.archiveWorkspace(old.id);
  const { id } = createTaskIn(storage, ws.id)("Sort mail");
  storage.setTaskStatus(taskId(id), "in_progress");
  storage.concludeTask(taskId(id), "Not needed", null);
  const done = taskShape(stored(storage, taskId(id)));
  const move = (workspace_id: number) => moveTask(storage, R.moveTask({ id, workspace_id }));

  const moved = move(general.id);
  expect(moved.fromWorkspaceId).toBe(ws.id);
  expect(moved.task.workspaceId).toBe(general.id);
  expect(moved.task).toEqual({ ...done, workspaceId: general.id });
  expect(moved.message).toContain('"General"');
  const again = move(general.id);
  expect(again.task).toEqual(moved.task);
  expect(again.message).toMatch(/^Nothing changed/);
  expect(toolFailure(() => move(old.id)).code).toBe("workspaceNotFound");
  expect(stored(storage, taskId(id)).workspaceId).toBe(general.id);
});

test("Deleting a planned or done task requires confirmation and rejects active work", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const task = create("Add login");
  const dependent = create("Use login", [task.id]);
  const done = create("Ship login");
  storage.setTaskStatus(taskId(done.id), "in_progress");
  storage.concludeTask(taskId(done.id), "Not needed", null);
  const remove = (id: number, confirm: boolean) => deleteTask(storage, R.deleteTask({ id, confirm }));

  const preview = remove(task.id, false);
  expect(preview.confirmed).toBe(false);
  expect(preview.message).toContain('"confirm": true');
  expect(preview.message).toContain("#2 (planned)");
  expect(storage.getTask(taskId(task.id))).not.toBeNull();
  const deleted = remove(task.id, true);
  expect(deleted.confirmed).toBe(true);
  expect(deleted.task.id).toBe(task.id);
  expect(storage.getTask(taskId(task.id))).toBeNull();
  expect([...stored(storage, taskId(dependent.id)).dependsOn]).toEqual([]);

  expect(remove(done.id, false).confirmed).toBe(false);
  expect(storage.getTask(taskId(done.id))).not.toBeNull();
  expect(remove(done.id, true).confirmed).toBe(true);
  expect(storage.getTask(taskId(done.id))).toBeNull();

  const active = create("Fix login");
  storage.setTaskStatus(taskId(active.id), "in_progress");
  const error = toolFailure(() => remove(active.id, true));
  expect(error.kind).toBe("rejected");
  expect(error.message).toContain("pause_task");
  expect(storage.getTask(taskId(active.id))).not.toBeNull();
});

test("Deleting done tasks archives only the workspace's done tasks after confirmation", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const planned = create("Add login");
  const first = create("Ship login");
  const second = create("Drop signup");
  for (const task of [first, second]) {
    storage.setTaskStatus(taskId(task.id), "in_progress");
    storage.concludeTask(taskId(task.id), "Not needed", null);
  }
  const remove = (confirm: boolean) => deleteDoneTasks(storage, R.deleteDoneTasks({ workspace_id: ws.id, confirm }));

  const preview = remove(false);
  expect(preview.confirmed).toBe(false);
  expect(preview.taskIds).toEqual([first.id, second.id]);
  expect(preview.message).toContain("#2 Ship login, #3 Drop signup");
  expect(preview.message).toContain('"confirm": true');
  expect(storage.getTask(taskId(first.id))).not.toBeNull();
  const deleted = remove(true);
  expect(deleted.confirmed).toBe(true);
  expect(deleted.taskIds).toEqual([first.id, second.id]);
  expect(deleted.message).toContain("#2, #3");
  expect(storage.getTask(taskId(first.id))).toBeNull();
  expect(storage.getTask(taskId(second.id))).toBeNull();
  expect(storage.getTask(taskId(planned.id))).not.toBeNull();

  const none = remove(true);
  expect(none.confirmed).toBe(false);
  expect(none.taskIds).toEqual([]);
  expect(none.message).toContain("list_tasks");
  const error = toolFailure(() => deleteDoneTasks(storage, R.deleteDoneTasks({ workspace_id: 99, confirm: true })));
  expect(error.code).toBe("workspaceNotFound");
  expect(error.message).toContain("list_workspaces");
});

test("Reopening a done task requires confirmation", () => {
  const { storage, ws } = storageWithWorkspace();
  const { id } = createTaskIn(storage, ws.id)("Add login");
  storage.setTaskStatus(taskId(id), "in_progress");
  storage.concludeTask(taskId(id), "Too slow", null);
  const reopen = (reason: string, confirm: boolean) => reopenTask(storage, R.reopenTask({ id, reason, confirm }));

  expect(toolFailure(() => reopen(" ", false)).kind).toBe("invalidInput");
  const preview = reopen("Faster now", false);
  expect(preview.confirmed).toBe(false);
  expect(preview.task.status).toBe("done");
  expect(preview.message).toContain("Reopened: Faster now");
  expect(preview.message).toContain('"confirm":true');
  expect(stored(storage, taskId(id)).status).toBe("done");

  const reopened = reopen("Faster now", true);
  expect(reopened.confirmed).toBe(true);
  expect(reopened.task.status).toBe("planned");
  expect(reopened.task.resolution).toBeNull();
  toolFailure(() => reopen("Faster now", false));
});
