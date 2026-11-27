import { expect, test } from "bun:test";
import { Period } from "../domain/review.ts";
import { commit, memoryStorage, newTask, seedCommits, workspace } from "./storage-fixtures.ts";

test("Commit records in a period span every task oldest first", () => {
  const storage = memoryStorage();
  const a = storage.createTask(newTask(workspace(storage), "A"));
  const b = storage.createTask(newTask(workspace(storage, "Server"), "B"));
  seedCommits(storage, [commit(a.id, "a-end", 200), commit(a.id, "a-in", 150)]);
  seedCommits(storage, [commit(b.id, "b-start", 100), commit(b.id, "b-before", 99)]);
  expect(storage.listCommitRecordsIn(Period.of(100, 200))).toEqual([
    commit(b.id, "b-start", 100), commit(a.id, "a-in", 150),
  ]);
});

test("Commits in a period include historical activity without duplicates", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const recorded = storage.createTask(newTask(ws, "Recorded"));
  const polled = storage.createTask(newTask(ws, "Polled"));
  const stored = commit(recorded.id, "rec", 120);
  seedCommits(storage, [stored]);
  for (const [id, sha, title, at] of [
    [recorded.id, "rec", "Recorded", 120],
    [polled.id, "new", "Fix login", 150],
    [polled.id, "old", "Before", 50],
  ] as const) {
    storage.db.run(`INSERT INTO task_activity
      (task_id, dedup_key, kind, source, external_ref, title, author, occurred_at, received_at, confirmed_at)
      VALUES (?1, ?2, 'commit', 'git_poll', ?2, ?3, ?4, ?5, 300, 300)`,
      [id, sha, title, `${title} author`, at]);
  }
  expect(storage.listCommitRecordsIn(Period.of(100, 200))).toEqual([
    stored, { taskId: polled.id, sha: "new", message: "Fix login", author: "Fix login author", committedAt: 150 },
  ]);
});
