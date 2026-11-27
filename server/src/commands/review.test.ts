import { expect, test } from "bun:test";
import type { TaskId } from "../domain/model.ts";
import type { Storage } from "../storage/storage.ts";
import { commit, memoryStorage, newTask, seedCommits, workspace } from "../storage/storage-fixtures.ts";
import type { ReportFormat } from "../../../src/lib/bindings.ts";
import { commandFailure } from "./command-fixtures.ts";
import { getReviewTimeZone, reviewEntries, reviewPeriod, reviewReport, setReviewTimeZone } from "./review.ts";
import { deleteReviewSnapshot, getReviewSnapshot, listReviewSnapshots, saveReviewSnapshot } from "./snapshots.ts";

function second(at: string): number {
  return Temporal.Instant.from(at).epochMilliseconds / 1000;
}

function storageWithTask(): [Storage, TaskId] {
  const storage = memoryStorage();
  return [storage, storage.createTask(newTask(workspace(storage, "toodo"), "Add storage")).id];
}

test("reviews tasks of every workspace and rejects an empty period", () => {
  const storage = memoryStorage(500);
  const started = storage.createTask(newTask(workspace(storage, "toodo"), "Work on toodo")).id;
  const committed = storage.createTask(newTask(workspace(storage, "search"), "Work on search")).id;
  storage.setTaskStatus(started, "in_progress");
  const record = { ...commit(committed, "abc", 1500), message: "Add search", author: "Dev <dev@example.com>" };
  seedCommits(storage, [record]);

  let entries = reviewEntries(storage, 1000, 2000);
  expect(entries.map((entry) => [entry.task.title, entry.outcome, entry.at])).toEqual([["Work on search", "worked_on", 1500]]);
  expect(entries[0]?.commits).toEqual([record]);

  entries = reviewEntries(storage, 0, 1000);
  expect(entries.map((entry) => [entry.task.title, entry.outcome])).toEqual([
    ["Work on toodo", "started"],
    ["Work on search", "planned"],
  ]);

  // Deleting archives the task; its work still counts and is marked archived.
  storage.archiveTask(committed);
  expect(reviewEntries(storage, 1000, 2000).map((entry) => [entry.task.title, entry.archived])).toEqual([["Work on search", true]]);
  storage.purgeTask(committed);
  expect(reviewEntries(storage, 1000, 2000)).toEqual([]);

  expect(commandFailure(() => reviewEntries(storage, 10, 10)).kind).toBe("invalidInput");
});

test("the review time zone of the server decides where a period starts and ends", () => {
  const [storage] = storageWithTask();
  const week = () => {
    const entries = reviewPeriod(storage, "2026-11-02", "2026-11-08");
    return [entries.timeZone, entries.start, entries.end];
  };

  expect(setReviewTimeZone(storage, " Asia/Seoul ")).toEqual({ timeZone: "Asia/Seoul", configured: "Asia/Seoul" });
  expect(week()).toEqual(["Asia/Seoul", second("2026-11-01T15:00:00Z"), second("2026-11-08T15:00:00Z")]);

  setReviewTimeZone(storage, "Europe/Berlin");
  expect(week()).toEqual(["Europe/Berlin", second("2026-11-01T23:00:00Z"), second("2026-11-08T23:00:00Z")]);
  const report = reviewReport(storage, { period: "week", date: "2026-11-04", format: "csv" });
  expect([report.from, report.to]).toEqual(["2026-11-02", "2026-11-08"]);

  const error = commandFailure(() => setReviewTimeZone(storage, "Mars/Olympus"));
  expect(error.kind).toBe("invalidInput");
  expect(error.message).toContain("Europe/Berlin");
  expect(getReviewTimeZone(storage).configured).toBe("Europe/Berlin");

  const server = setReviewTimeZone(storage, "  ");
  expect(server.configured).toBeNull();
  expect(week()[0]).toBe(server.timeZone);
});

test("a zone of the time zone database that ICU leaves out is kept by its name", () => {
  const [storage] = storageWithTask();
  expect(setReviewTimeZone(storage, "est5edt")).toEqual({ timeZone: "EST5EDT", configured: "EST5EDT" });
  const week = reviewPeriod(storage, "2026-11-02", "2026-11-08");
  expect([week.timeZone, week.start, week.end]).toEqual(["EST5EDT", second("2026-11-02T05:00:00Z"), second("2026-11-09T05:00:00Z")]);
});

test("a saved review reads back unchanged after its task is reopened", () => {
  const [storage, id] = storageWithTask();
  setReviewTimeZone(storage, "UTC");
  const at = (time: string) => storage.setClock(() => second(time));
  at("2026-11-03T09:00:00Z");
  storage.setTaskStatus(id, "in_progress");
  at("2026-11-04T09:00:00Z");
  storage.completeTask(id, "Shipped behind a flag", []);
  at("2026-11-05T09:00:00Z");
  const saved = saveReviewSnapshot(storage, { period: "week", from: "2026-11-02" });
  expect(saved.title).toBe("Week review 2026-11-02 to 2026-11-08");
  expect([saved.entryCount, saved.timeZone]).toEqual([1, "UTC"]);
  const live = () => reviewPeriod(storage, "2026-11-02", "2026-11-08").entries;
  const before = live();
  const report = (format: ReportFormat) => reviewReport(storage, { period: "week", from: "2026-11-02", format });
  const [markdown, csv] = [report("markdown"), report("csv")];

  at("2026-11-06T09:00:00Z");
  storage.reopenTask(id, "Flag broke checkout", "Reopened to fix checkout");
  const after = live();
  expect(after).not.toEqual(before);
  expect(after[0]?.outcome).not.toBe("completed");

  const reopened = getReviewSnapshot(storage, saved.id);
  expect(reopened.summary).toEqual(saved);
  expect(reopened.entries).toEqual(before);
  expect(reopened.markdown).toEqual(markdown);
  expect(reopened.csv).toEqual(csv);
  expect(reopened.workspaces).toEqual([{ id: 1, name: "toodo" }]);
  expect(listReviewSnapshots(storage)).toEqual([saved]);

  deleteReviewSnapshot(storage, saved.id);
  const missing = commandFailure(() => getReviewSnapshot(storage, saved.id));
  expect(missing.kind).toBe("notFound");
  expect(missing.message).toContain("list_review_snapshots");
});
