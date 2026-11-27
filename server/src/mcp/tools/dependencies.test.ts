import { expect, test } from "bun:test";
import { taskId } from "../../domain/model.ts";
import { finish, stored } from "../../storage/storage-fixtures.ts";
import { ArgumentError } from "../args.ts";
import { addDependencies, removeDependency } from "./edits.ts";
import * as R from "./requests.ts";
import { createTaskIn, storageWithWorkspace, toolFailure } from "./tool-fixtures.ts";

test("A dependency that closes a cycle is rejected", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const first = create("Schema");
  const second = create("API", [first.id]);
  const request = R.addDependencies({ task_id: first.id, depends_on: [second.id] });

  const error = toolFailure(() => addDependencies(storage, request));
  expect(error.kind).toBe("rejected");
  expect(error.message).toContain("cycle");
  expect([...stored(storage, taskId(first.id)).dependsOn]).toEqual([]);

  const removed = removeDependency(storage, R.dependency({ task_id: second.id, depends_on: [first.id] }));
  expect(removed.task.task.dependsOn).toEqual([]);
  expect(removed.task.ready).toBe(true);
  expect(addDependencies(storage, request).task.task.dependsOn).toEqual([second.id]);
});

test("Removing a missing dependency removes none of the requested dependencies", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const first = create("Schema");
  const other = create("Docs");
  const second = create("API", [first.id]);
  const request = R.dependency({ task_id: second.id, depends_on: [first.id, other.id] });

  const error = toolFailure(() => removeDependency(storage, request));
  expect(error.kind).toBe("notFound");
  expect(error.message.startsWith(`task ${second.id} does not depend on ${other.id}; get_task ${second.id}`)).toBe(true);
  expect([...stored(storage, taskId(second.id)).dependsOn]).toEqual([taskId(first.id)]);
});

test("Adding prerequisites accepts several at once and requires at least one", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const task = create("Verify");
  const fix = create("Fix login");
  const docs = create("Fix docs");
  const add = (depends_on: number[]) => addDependencies(storage, R.addDependencies({ task_id: task.id, depends_on }));

  expect(toolFailure(() => add([])).kind).toBe("invalidInput");
  const updated = add([fix.id, docs.id]);
  expect(updated.task.task.dependsOn).toEqual([fix.id, docs.id]);
  expect(updated.paused).toBe(false);
  expect(updated.message).toBe(`task ${task.id} waits for #${fix.id} (planned), #${docs.id} (planned) before it can start.`);
});

test("A done task gets no new prerequisites", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const task = create("Verify");
  const fix = create("Fix login");
  finish(storage, taskId(task.id));
  const request = R.addDependencies({ task_id: task.id, depends_on: [fix.id] });

  const error = toolFailure(() => addDependencies(storage, request));
  expect(error.kind).toBe("rejected");
  expect(error.message.endsWith(`create a follow-up task with create_task and depends_on [${fix.id}]`)).toBe(true);
  expect([...stored(storage, taskId(task.id)).dependsOn]).toEqual([]);
});

test("Adding a prerequisite to a task in review does not pause it and says so", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const task = create("Verify");
  const fix = create("Fix login");
  storage.setTaskStatus(taskId(task.id), "in_progress");
  storage.setTaskStatus(taskId(task.id), "in_review");

  const reply = addDependencies(storage, R.addDependencies({ task_id: task.id, depends_on: [fix.id] }));
  expect(reply.paused).toBe(false);
  expect(reply.task.task.status).toBe("in_review");
  expect(reply.message).toContain("not paused");
  expect(reply.message).toContain("call pause_task");
});

test("A blocking prerequisite pauses the task and history allows resuming", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const task = create("Verify");
  const fix = create("Fix login");
  storage.setTaskStatus(taskId(task.id), "in_progress");

  const reply = addDependencies(storage, R.addDependencies({ task_id: task.id, depends_on: [fix.id] }));
  const paused = stored(storage, taskId(task.id));
  expect(paused.status).toBe("planned");
  expect(reply.paused).toBe(true);
  expect(reply.task.ready).toBe(false);
  expect(reply.task.dependsOn[0]?.title).toBe("Fix login");
  expect(reply.task.blockedBy).toEqual(reply.task.dependsOn);
  expect(reply.message.startsWith(`task ${task.id} is paused until #${fix.id} (planned) is done`)).toBe(true);
  expect(reply.task.blockedBy[0]?.status).toBe("planned");

  storage.updateTask({ ...paused, description: "Verification work" });
  const removed = removeDependency(storage, R.dependency({ task_id: task.id, depends_on: [fix.id] }));
  expect(removed.task.ready).toBe(true);
  expect(removed.message).toMatch(/resume_task resumes it\.$/);
});

test("The depends_on argument takes one task ID or an array", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const task = create("Verify");
  const fix = create("Fix login");
  const docs = create("Fix docs");
  const add = (depends_on: number | number[]) =>
    addDependencies(storage, R.addDependencies({ task_id: task.id, depends_on }));
  const remove = (depends_on: number | number[]) =>
    removeDependency(storage, R.dependency({ task_id: task.id, depends_on }));

  add(fix.id);
  expect(add([docs.id]).task.task.dependsOn).toEqual([fix.id, docs.id]);
  expect(remove(fix.id).task.task.dependsOn).toEqual([docs.id]);
  add(fix.id);
  expect(remove([fix.id, docs.id]).task.task.dependsOn).toEqual([]);
  expect(() => R.dependency({ task_id: 1, depends_on: "2" })).toThrow(ArgumentError);
  expect(() => R.dependency({ task_id: 1, depends_on: "2" })).toThrow("a task id or an array of task ids");
});
