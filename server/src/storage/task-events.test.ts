import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReader, openWriter } from "./database.ts";
import { Storage } from "./storage.ts";
import { memoryStorage, newTask, stored, workspace } from "./storage-fixtures.ts";
import { createDatabase } from "./testing.ts";

const origin = { statusChange: 0, adoption: 0 } as const;

test("Status changes after a record name both statuses and the tasks made ready", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b, waitsOnA, waitsOnBoth] = ["A", "B", "Waits on A", "Waits on A and B"]
    .map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(waitsOnA, a);
  storage.addDependencies(waitsOnBoth, [a, b]);
  const created = storage.statusCursor();
  const initial = storage.statusChangesAfter(origin);
  expect(initial.changes.map(({ task, from, to }) => [task, from, to])).toEqual(
    [a, b, waitsOnA, waitsOnBoth].map((task) => [task, null, "planned"]),
  );
  expect(initial.ready).toEqual([]);
  storage.setClock(() => 200);
  storage.setTaskStatus(a, "in_progress");
  storage.completeTask(a, null, []);
  const after = storage.statusChangesAfter(created);
  expect(after.changes.map(({ task, workspace, from, to, at }) => [task, workspace, from, to, at])).toEqual([
    [a, ws.id, "planned", "in_progress", 200], [a, ws.id, "in_progress", "done", 200],
  ]);
  expect(after.ready).toEqual([{ task: waitsOnA, workspace: ws.id, unblockedBy: a, at: 200 }]);
  storage.concludeTask(b, "Not needed", null);
  const concluded = storage.statusChangesAfter(after.cursor);
  expect(concluded.changes.map(({ task, to }) => [task, to])).toEqual([[b, "done"]]);
  expect(concluded.ready).toEqual([]);
  const cursor = storage.statusCursor();
  const empty = { changes: [], ready: [], cursor };
  expect(storage.statusChangesAfter(cursor)).toEqual(empty);
  expect(storage.statusChangesAfter({ statusChange: cursor.statusChange + 5, adoption: cursor.adoption + 5 })).toEqual(empty);
});

test("Adopting work concluded as not adopted makes its dependents ready once", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [corrected, shipped, shipper, open, waitsCorrected, waitsShipped, waitsBoth] = [
    "Corrected", "Shipped with another", "Shipper", "Open", "Waits on corrected", "Waits on shipped", "Waits on both",
  ].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(waitsCorrected, corrected);
  storage.addDependency(waitsShipped, shipped);
  storage.addDependencies(waitsBoth, [corrected, open]);
  storage.setTaskStatus(shipper, "in_progress");
  storage.completeTask(shipper, null, []);
  storage.concludeTask(corrected, "Not needed", null);
  storage.concludeTask(shipped, "Not needed", null);
  const concluded = storage.statusChangesAfter(origin);
  expect(concluded.ready).toEqual([]);
  storage.setClock(() => 200);
  storage.setTaskOutcome(corrected, "completed", "Adopted after all", "Outcome changed");
  const adopted = storage.statusChangesAfter(concluded.cursor);
  expect(adopted.changes).toEqual([]);
  expect(adopted.ready).toEqual([{ task: waitsCorrected, workspace: ws.id, unblockedBy: corrected, at: 200 }]);
  storage.setClock(() => 300);
  storage.concludeTask(shipped, "Shipped with the shipper", shipper);
  const shippedWith = storage.statusChangesAfter(adopted.cursor);
  expect(shippedWith.changes).toEqual([]);
  expect(shippedWith.ready).toEqual([{ task: waitsShipped, workspace: ws.id, unblockedBy: shipped, at: 300 }]);
  const cursor = storage.statusCursor();
  expect(shippedWith.cursor).toEqual(cursor);
  expect(storage.statusChangesAfter(cursor)).toEqual({ changes: [], ready: [], cursor });
});

test("Deleting the task with the latest records hides no later status change or adoption", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [kept, waits, deleted] = ["Kept", "Waits on kept", "Deleted"]
    .map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(waits, kept);
  storage.concludeTask(deleted, "Not needed", null);
  storage.setTaskOutcome(deleted, "completed", "Adopted after all", "Outcome changed");
  const announced = storage.statusCursor();
  storage.deleteTask(deleted);
  storage.setClock(() => 200);
  storage.concludeTask(kept, "Not needed", null);
  storage.setTaskOutcome(kept, "completed", "Adopted after all", "Outcome changed");
  const after = storage.statusChangesAfter(announced);
  expect(after.changes.map(({ task, to }) => [task, to])).toEqual([[kept, "done"]]);
  expect(after.ready).toEqual([{ task: waits, workspace: ws.id, unblockedBy: kept, at: 200 }]);
});

test("Only status changes are recorded and rejected changes record nothing", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const [a, b] = ["A", "B"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.setClock(() => 200);
  storage.addDependency(b, a);
  storage.setClock(() => 250);
  expect(() => storage.addDependency(a, b)).toThrow("dependency cycle");
  expect(() => storage.setTaskStatus(b, "in_progress")).toThrow("cannot start yet");
  expect(() => storage.completeTask(a, null, [])).toThrow("a planned task cannot become done");
  expect(() => storage.setTaskStatus(a, "in_review")).toThrow("a planned task cannot become in_review");
  for (const id of [a, b]) expect(stored(storage, id).timeline).toEqual([{ status: "planned", at: 100, reason: null }]);
  for (const [at, status] of [[300, "in_progress"], [400, "in_review"], [500, "done"]] as const) {
    storage.setClock(() => at);
    storage.setTaskStatus(a, status);
  }
  storage.setClock(() => 600);
  storage.setTaskStatus(b, "in_progress");
  storage.setClock(() => 650);
  expect(storage.setTaskStatus(b, "planned").timeline.map(({ status, at }) => [status, at])).toEqual([
    ["planned", 100], ["in_progress", 600], ["planned", 650],
  ]);
  storage.setClock(() => 700);
  const [c, d] = ["C", "D"].map((title) => storage.createTask(newTask(ws, title)).id);
  storage.addDependency(c, d);
  storage.removeDependency(c, d);
  expect(stored(storage, c).timeline).toEqual([{ status: "planned", at: 700, reason: null }]);
  const eventsBefore = storage.statusChangesAfter(origin).changes.length;
  storage.deleteTask(a);
  expect(storage.statusChangesAfter(origin).changes).toHaveLength(eventsBefore - 4);
});

test("A task is ready only from the finish of its last dependency while others write", () => {
  const dir = mkdtempSync(join(tmpdir(), "toodo-status-"));
  try {
    const path = join(dir, "toodo.sqlite3");
    createDatabase(path);
    using writerDb = openWriter(path);
    const writer = new Storage(writerDb, () => 100);
    const ws = workspace(writer);
    const [a, b, waits] = ["A", "B", "Waits on A and B"].map((title) => writer.createTask(newTask(ws, title)).id);
    writer.addDependencies(waits, [a, b]);
    writer.setTaskStatus(a, "in_progress");
    writer.setTaskStatus(b, "in_progress");
    using readerDb = openReader(path);
    const reader = new Storage(readerDb);
    const announced = reader.statusChangesAfter(origin).cursor;
    writer.completeTask(a, null, []);

    // Commit B between the reader's status-event and task-detail queries, as the
    // rusqlite statement trace does. The two connections still execute real SQL.
    const query = readerDb.query.bind(readerDb);
    let committed = false;
    const trace = spyOn(readerDb, "query");
    trace.mockImplementation((sql) => {
      if (!committed && sql.includes("FROM task_adoptions WHERE id >")) {
        writer.completeTask(b, null, []);
        committed = true;
      }
      return query(sql);
    });
    const first = (() => {
      try {
        return reader.statusChangesAfter(announced);
      } finally {
        trace.mockRestore();
      }
    })();
    expect(committed).toBe(true);
    expect(first.changes.map(({ task, to }) => [task, to])).toEqual([[a, "done"]]);
    expect(first.ready).toEqual([]);
    const second = reader.statusChangesAfter(first.cursor);
    expect(second.changes.map(({ task, to }) => [task, to])).toEqual([[b, "done"]]);
    expect(second.ready).toEqual([{ task: waits, workspace: ws.id, unblockedBy: b, at: 100 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
