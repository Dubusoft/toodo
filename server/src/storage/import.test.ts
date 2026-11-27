import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportTo, stageBackup } from "./backup.ts";
import { IMPORTED_TABLES, SKIPPED_TABLES, importBackup } from "./import.ts";
import { insertTask, insertWorkspace, openMemoryDatabase } from "./testing.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toodo-import-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let exports = 0;

function staged(fill: (other: Database) => void) {
  const other = openMemoryDatabase();
  fill(other);
  exports += 1;
  const file = join(dir, `other-${exports}.sqlite3`);
  exportTo(other, file);
  other.close();
  return stageBackup(file);
}

function count(db: Database, sql: string): number {
  return Object.values(db.query<Record<string, number>, []>(sql).get() ?? {})[0] ?? -1;
}

function titles(db: Database): [number, string][] {
  return db
    .query<{ id: number; title: string }, []>("SELECT id, title FROM tasks ORDER BY id")
    .all()
    .map((row) => [row.id, row.title]);
}

/** The data of the former desktop app's tests, at the baseline schema. */
function desktopData(other: Database): void {
  other.run(
    `INSERT INTO workspaces (id, name, description) VALUES (1, 'app', 'Former directory');
     INSERT INTO tasks (id, workspace_id, type, title, status) VALUES
       (1, 1, 'feat', 'Add storage', 'planned'), (2, 1, 'feat', 'Add sync', 'planned');
     INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (2, 1);
     INSERT INTO task_relations (task_id, related_id) VALUES (1, 2);
     INSERT INTO task_events (task_id, status, at) VALUES (1, 'planned', 0), (2, 'planned', 0);
     INSERT INTO task_notes (task_id, kind, body, at) VALUES (1, 'progress', 'Schema drafted', 0);
     INSERT INTO devices (label, token_hash, created_at, last_seen_at) VALUES ('Browser', printf('%064d', 0), 0, 0);`,
  );
}

test("imported workspaces keep their metadata", () => {
  const server = openMemoryDatabase();
  importBackup(
    server,
    staged((other) =>
      other.run(
        `INSERT INTO workspaces (name, repository) VALUES ('site', 'repository');
         INSERT INTO workspaces (name, description, repository)
           VALUES ('notes', 'Task notes', 'notes:repository');`,
      ),
    ),
  );

  expect(server.query("SELECT name, description, repository FROM workspaces ORDER BY id").all()).toEqual([
    { name: "site", description: null, repository: "repository" },
    { name: "notes", description: "Task notes", repository: "notes:repository" },
  ]);
});

test("imports next to the data here with ids after every used one", () => {
  const server = openMemoryDatabase();
  const site = insertWorkspace(server, "site");
  const kept = insertTask(server, site, "Server task");
  const deleted = insertTask(server, site, "Deleted task");
  server.run("DELETE FROM tasks WHERE id = ?", [deleted]);

  const summary = importBackup(server, staged(desktopData));

  expect(summary).toEqual({ workspaces: 1, tasks: 2, taskIdOffset: 2 });
  expect(titles(server)).toEqual([
    [kept, "Server task"],
    [3, "Add storage"],
    [4, "Add sync"],
  ]);
  expect(count(server, "SELECT workspace_id FROM tasks WHERE id = 3")).toBe(site + 1);
  expect(server.query("SELECT task_id, depends_on_id FROM task_dependencies").all()).toEqual([
    { task_id: 4, depends_on_id: 3 },
  ]);
  expect(server.query("SELECT task_id, related_id FROM task_relations").all()).toEqual([
    { task_id: 3, related_id: 4 },
  ]);
  expect(count(server, "SELECT count(*) FROM task_events WHERE task_id IN (3, 4)")).toBe(2);
  expect(
    server.query("SELECT rowid FROM task_search WHERE task_search MATCH '\"drafted\"'").all(),
  ).toEqual([{ rowid: 3 }]);
  expect(count(server, "SELECT count(*) FROM devices")).toBe(0);
  expect(insertTask(server, site, "Next task")).toBe(5);
});

test("into an empty database tasks keep their numbers", () => {
  const server = openMemoryDatabase();

  const summary = importBackup(server, staged(desktopData));

  expect(summary.taskIdOffset).toBe(0);
  expect(titles(server)).toEqual([
    [1, "Add storage"],
    [2, "Add sync"],
  ]);
});

test("imported history keeps records and remaps task ids", () => {
  const server = openMemoryDatabase();
  const existing = insertTask(server, insertWorkspace(server, "Existing"), "Existing work");

  const summary = importBackup(
    server,
    staged((other) => {
      const task = insertTask(other, insertWorkspace(other, "History"), "Recorded work");
      other.run(
        `INSERT INTO commit_records (task_id, position, sha, message, author, committed_at)
         VALUES (?1, 0, 'recorded', 'Recorded commit', 'Ada', 120)`,
        [task],
      );
      other.run(
        `INSERT INTO pull_request_snapshots (task_id, number, title, additions, deletions,
         changed_files, review_count, reviewer_count)
         VALUES (?1, 7, 'Historical PR', 10, 2, 3, 1, 1)`,
        [task],
      );
      other.run(
        `INSERT INTO task_activity (task_id, dedup_key, kind, source, external_ref, title,
         author, occurred_at, received_at, confirmed_at)
         VALUES (?1, 'historical', 'commit', 'git_poll', 'polled', 'Polled commit',
         'Grace', 150, 160, 160)`,
        [task],
      );
    }),
  );

  expect(summary.taskIdOffset).toBe(existing);
  const imported = summary.taskIdOffset + 1;
  expect(server.query("SELECT task_id, sha FROM commit_records").all()).toEqual([
    { task_id: imported, sha: "recorded" },
  ]);
  expect(server.query("SELECT task_id, title FROM pull_request_snapshots").all()).toEqual([
    { task_id: imported, title: "Historical PR" },
  ]);
  expect(server.query("SELECT task_id, external_ref FROM task_activity").all()).toEqual([
    { task_id: imported, external_ref: "polled" },
  ]);
});

test("shipped-with refs point at the imported task", () => {
  const server = openMemoryDatabase();
  const workspace = insertWorkspace(server, "Existing");
  // Task #1 here has the number the shipping task had in the other database.
  insertTask(server, workspace, "Existing work");
  insertTask(server, workspace, "More existing work");

  const summary = importBackup(
    server,
    staged((other) => {
      const id = insertWorkspace(other, "site");
      insertTask(other, id, "Shipped");
      const concluded = insertTask(other, id, "Concluded");
      other.run("UPDATE tasks SET refs = '[\"task:1\"]' WHERE id = ?", [concluded]);
    }),
  );

  expect(summary.taskIdOffset).toBe(2);
  expect(server.query("SELECT title, refs FROM tasks WHERE id IN (3, 4) ORDER BY id").all()).toEqual([
    { title: "Shipped", refs: "[]" },
    { title: "Concluded", refs: '["task:3"]' },
  ]);
});

test("task refs to tasks missing from the import are dropped and others kept", () => {
  const server = openMemoryDatabase();
  insertTask(server, insertWorkspace(server, "Existing"), "Existing work");

  importBackup(
    server,
    staged((other) => {
      const workspace = insertWorkspace(other, "site");
      const gone = insertTask(other, workspace, "Deleted later");
      const kept = insertTask(other, workspace, "Kept");
      const refers = insertTask(other, workspace, "Refers");
      const refs = ["lane:refers", "pr:https://example.com/pull/1", "task:draft", `task:${kept}`, `task:${gone}`];
      other.run("UPDATE tasks SET refs = ? WHERE id = ?", [JSON.stringify(refs), refers]);
      other.run("DELETE FROM tasks WHERE id = ?", [gone]);
    }),
  );

  expect(server.query("SELECT title, refs FROM tasks WHERE id = 4").get()).toEqual({
    title: "Refers",
    refs: '["lane:refers","pr:https://example.com/pull/1","task:draft","task:3"]',
  });
});

test("connected OAuth apps, settings, and saved reviews stay with the issuing server", () => {
  const server = openMemoryDatabase();

  importBackup(
    server,
    staged((other) => {
      other.run(
        `INSERT INTO oauth_clients (client_id, redirect_uris, auth_method, created_at)
           VALUES ('other-client', '["https://client.example/callback"]', 'none', 1000);
         INSERT INTO oauth_grants (id, owner_key, client_id, scopes, created_at)
           VALUES (1, 'owner', 'other-client', 'toodo.read', 1000);
         INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at)
           VALUES ('other-access-hash', 1, 'access', 2000);
         INSERT INTO settings (key, value) VALUES ('review_time_zone', 'Asia/Seoul');`,
      );
    }),
  );

  for (const table of ["oauth_clients", "oauth_grants", "oauth_tokens", "settings"]) {
    expect(count(server, `SELECT count(*) FROM ${table}`)).toBe(0);
  }
});

// A table a later schema adds has to be imported or skipped on purpose.
test("every table is imported or deliberately skipped", () => {
  const db = openMemoryDatabase();
  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'task_search_%'
       AND name NOT LIKE 'chat_search_%'`,
    )
    .all()
    .map((row) => row.name)
    .sort();
  const handled = [...IMPORTED_TABLES.map(([table]) => table), ...SKIPPED_TABLES].sort();
  expect(tables).toEqual(handled);
});
