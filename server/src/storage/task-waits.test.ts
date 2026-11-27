import { expect, test } from "bun:test";
import { TransitionError } from "../domain/status.ts";
import { expectFailure, memoryStorage, newTask, stored, workspace } from "./storage-fixtures.ts";

test("A waiting task is paused until its time, then returns to its status", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [active, review, planned] = ["Active", "Review", "Planned"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.setTaskStatus(active, "in_progress");
  storage.setTaskStatus(review, "in_progress");
  storage.setTaskStatus(review, "in_review");
  const before = storage.statusCursor();
  storage.setClock(() => 200);
  expect(storage.waitTask(active, 1_000, "Vendor")).toMatchObject({
    status: "planned", wait: { until: 1_000, status: "in_progress" },
  });
  storage.waitTask(review, 2_000, null);
  storage.waitTask(planned, 500, null);
  expect(storage.waitTask(active, 600, null).wait).toEqual({ until: 600, status: "in_progress" });
  expect(storage.statusChangesAfter(before).changes.map(({ task, from, to }) => [task, from, to])).toEqual([
    [active, "in_progress", "planned"], [review, "in_review", "planned"],
  ]);
  storage.setClock(() => 599);
  expect(storage.endDueWaits()).toEqual([ws.id]);
  expect(stored(storage, planned)).toMatchObject({ wait: null, status: "planned" });
  expect(stored(storage, active).status).toBe("planned");
  const paused = storage.statusCursor();
  storage.setClock(() => 600);
  expect(storage.endDueWaits()).toEqual([ws.id]);
  expect(stored(storage, active)).toMatchObject({ wait: null, status: "in_progress" });
  expect(storage.endTaskWait(review, "Reply came")).toMatchObject({ wait: null, status: "in_review" });
  expect(storage.statusChangesAfter(paused).changes.map(({ task, from, to, at }) => [task, from, to, at])).toEqual([
    [active, "planned", "in_progress", 600], [review, "planned", "in_review", 600],
  ]);
  expect(storage.endDueWaits()).toEqual([]);
});

test("A status change ends a wait and a new prerequisite keeps it paused", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [started, blocked, prerequisite] = ["Started", "Blocked", "Prerequisite"]
    .map((title) => storage.createTask(newTask(ws, title)).id);
  for (const id of [started, blocked]) {
    storage.setTaskStatus(id, "in_progress");
    storage.waitTask(id, 1_000, null);
  }
  expect(storage.setTaskStatus(started, "in_progress").wait).toBeNull();
  storage.waitTask(prerequisite, 1_000, null);
  expect(storage.concludeTask(prerequisite, "Dropped", null).wait).toBeNull();
  expectFailure(() => storage.waitTask(prerequisite, 2_000, null), {
    kind: "transition", error: new TransitionError("done", "planned"),
  });
  const other = storage.createTask(newTask(ws, "Other")).id;
  storage.addDependency(blocked, other);
  storage.setClock(() => 1_000);
  storage.endDueWaits();
  const still = stored(storage, blocked);
  expect(still).toMatchObject({ status: "planned", wait: null });
  expect(still.notes.at(-1)).toEqual({
    kind: "blocker", body: `The wait ended, but the task stays paused: waiting on #${other} (planned)`, at: 1_000,
  });
});

test("An archived waiting task keeps its wait until restored and holds no other wait back", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const other = workspace(storage, "Other");
  const [live, archived] = ["Live", "Archived"].map((title) => storage.createTask(newTask(ws, title)).id);
  const inArchivedWorkspace = storage.createTask(newTask(other, "In archived workspace")).id;
  for (const id of [live, archived, inArchivedWorkspace]) {
    storage.setTaskStatus(id, "in_progress");
    storage.waitTask(id, 1_000, null);
  }
  storage.archiveTask(archived);
  storage.archiveWorkspace(other.id);
  storage.setClock(() => 1_000);
  expect(storage.endDueWaits()).toEqual([ws.id]);
  expect(stored(storage, live)).toMatchObject({ status: "in_progress", wait: null });
  const frozen = { status: "planned", wait: { status: "in_progress", until: 1_000 } };
  expect(storage.archivedTasks()).toMatchObject([{ id: archived, ...frozen }]);
  storage.restoreWorkspace(other.id);
  expect(stored(storage, inArchivedWorkspace)).toMatchObject(frozen);
  storage.restoreTask(archived);
  storage.setClock(() => 1_100);
  expect(storage.endDueWaits()).toEqual([ws.id, other.id]);
  for (const id of [archived, inArchivedWorkspace]) {
    expect(stored(storage, id)).toMatchObject({ status: "in_progress", wait: null });
  }
});
