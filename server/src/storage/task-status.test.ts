import { expect, test } from "bun:test";
import { isReady } from "../domain/dag.ts";
import { taskId } from "../domain/model.ts";
import { TransitionError } from "../domain/status.ts";
import { milestones } from "../domain/timeline.ts";
import { StorageError } from "./errors.ts";
import { expectFailure, memoryStorage, newTask, stored, workspace } from "./storage-fixtures.ts";

test("Status changes follow transitions and wait for dependencies", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b, c] = ["A", "B", "C"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(b, a);
  storage.addDependencies(c, [a, b]);
  expectFailure(() => storage.setTaskStatus(b, "in_progress"), {
    kind: "dependencies_not_done", task: b, blockers: [{ id: a, status: "planned", resolution: null }],
  });
  expectFailure(() => storage.setTaskStatus(a, "planned"), { kind: "transition", error: new TransitionError("planned", "planned") });
  expectFailure(() => storage.setTaskStatus(taskId(999), "done"), { kind: "task_not_found", task: 999 });
  expect(stored(storage, b).status).toBe("planned");
  expect(storage.setTaskStatus(a, "in_progress").status).toBe("in_progress");
  expectFailure(() => storage.setTaskStatus(a, "done"), { kind: "transition", error: new TransitionError("in_progress", "done") });
  storage.setTaskStatus(a, "in_review");
  expect(isReady(storage.listAllTasks(), b)).toBe(false);
  storage.setTaskStatus(a, "done");
  expect(isReady(storage.listAllTasks(), b)).toBe(true);
  expect(isReady(storage.listAllTasks(), c)).toBe(false);
  storage.setTaskStatus(b, "in_progress");
  expect(storage.setTaskStatus(b, "planned").status).toBe("planned");
  expect(isReady(storage.listAllTasks(), c)).toBe(false);
  expectFailure(() => storage.setTaskStatus(b, "done"), { kind: "transition", error: new TransitionError("planned", "done") });
});

test("A paused task keeps its work and starts again once its dependencies are done", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b] = ["A", "B"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.setClock(() => 200);
  const started = storage.setTaskStatus(a, "in_progress");
  storage.setTaskRefs(a, ["branch:feat/a-1"]);
  storage.updateTask(started);
  storage.setClock(() => 300);
  expect(storage.setTaskStatus(a, "planned")).toMatchObject({ status: "planned", refs: ["branch:feat/a-1"] });
  storage.setClock(() => 400);
  storage.addDependency(a, b);
  expectFailure(() => storage.setTaskStatus(a, "in_progress"), {
    kind: "dependencies_not_done", task: a, blockers: [{ id: b, status: "planned", resolution: null }],
  });
  storage.removeDependency(a, b);
  storage.setClock(() => 500);
  expect(storage.setTaskStatus(a, "in_progress").timeline.map(({ status, at }) => [status, at])).toEqual([
    ["planned", 100], ["in_progress", 200], ["planned", 300], ["in_progress", 500],
  ]);
});

test("Every status change of a task is recorded with its time", () => {
  const storage = memoryStorage();
  const task = storage.createTask(newTask(workspace(storage), "Add login"));
  expect(task.timeline).toEqual([{ status: "planned", at: 100, reason: null }]);
  expect(storage.getTask(task.id)).toEqual(task);
  storage.setClock(() => 200);
  storage.startTask(task.id, null, []);
  storage.setClock(() => 300);
  storage.setTaskStatus(task.id, "in_review");
  storage.setClock(() => 350);
  expect(stored(storage, task.id).timeline).toHaveLength(3);
  storage.setClock(() => 400);
  const done = storage.completeTask(task.id, null, []);
  expect(stored(storage, task.id)).toEqual(done);
  expect(done.timeline.map(({ status, at }) => [status, at])).toEqual([
    ["planned", 100], ["in_progress", 200], ["in_review", 300], ["done", 400],
  ]);
  expect(milestones(done.timeline)).toEqual({
    plannedAt: 100, startedAt: 200, reviewAt: 300, completedAt: 400, reopenedAt: null,
    pausedAt: null, lastReviewAt: 300, activeSeconds: 200, pauseCount: 0,
  });
});

test("Dependencies not done names each blocker and its next step", () => {
  const error = new StorageError({
    kind: "dependencies_not_done", task: 2,
    blockers: [
      { id: taskId(1), status: "done", resolution: "not_adopted" },
      { id: taskId(7), status: "planned", resolution: null },
    ],
  });
  expect(error.message).toBe(
    "task 2 cannot start yet: #1 is done as not_adopted (remove_dependency task_id 2 depends_on 1 to unblock, or conclude_task id 1 with outcome shipped_with and shipped_with set to the completed task id); #7 is planned (wait for it); call complete_task for those prerequisite ids first",
  );
});
