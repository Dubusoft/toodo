import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileName } from "../domain/backup.ts";
import {
  backupDatabase,
  backupInto,
  checkIntegrity,
  exportTo,
  listBackups,
  restore,
  stageBackup,
} from "./backup.ts";
import { BASELINE_SCHEMA_VERSION, BUSY_TIMEOUT_MS, openWriter } from "./database.ts";
import { StorageError } from "./errors.ts";
import { createDatabase, insertTask, insertWorkspace, openMemoryDatabase } from "./testing.ts";

let dir: string;
let path: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toodo-backup-"));
  path = join(dir, "toodo.sqlite3");
  createDatabase(path);
  db = openWriter(path);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A workspace named `name` with two tasks, the second depending on the first. */
function addWorkspace(target: Database, name: string): void {
  const workspace = insertWorkspace(target, name);
  const first = insertTask(target, workspace, `${name} first`);
  const second = insertTask(target, workspace, `${name} second`);
  target.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", [second, first]);
}

function snapshot(target: Database): unknown[] {
  return ["workspaces", "tasks", "task_dependencies", "sqlite_sequence"].map((table) =>
    target.query(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
  );
}

function rejection(file: string): StorageError {
  try {
    stageBackup(file);
  } catch (error) {
    if (error instanceof StorageError) {
      return error;
    }
    throw error;
  }
  throw new Error(`${file} was staged`);
}

test("restoring an export brings back the exported data", () => {
  addWorkspace(db, "toodo");
  const exported = snapshot(db);
  const exportPath = join(dir, "export.sqlite3");
  exportTo(db, exportPath);

  addWorkspace(db, "notes");
  expect(snapshot(db)).not.toEqual(exported);
  restore(db, stageBackup(exportPath));

  expect(snapshot(db)).toEqual(exported);
  db.close();
  db = openWriter(path);
  expect(snapshot(db)).toEqual(exported);
  // The ids the restored data had not used yet are free again.
  expect(insertWorkspace(db, "next")).toBe(2);
});

test("exporting replaces an existing file", () => {
  const exportPath = join(dir, "export.sqlite3");
  writeFileSync(exportPath, "old");
  addWorkspace(db, "toodo");

  exportTo(db, exportPath);

  const restored = openMemoryDatabase();
  restore(restored, stageBackup(exportPath));
  expect(snapshot(restored)).toEqual(snapshot(db));
  expect(existsSync(`${exportPath}.partial`)).toBe(false);
});

test("files that are not Toodo databases of the baseline schema are rejected", () => {
  const garbage = join(dir, "garbage.sqlite3");
  writeFileSync(garbage, "plain text, not SQLite ".repeat(300));
  const other = join(dir, "other.sqlite3");
  const otherDb = new Database(other, { create: true });
  otherDb.run("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('hi');");
  otherDb.close();
  const versioned = (version: number) => {
    const file = join(dir, `version-${version}.sqlite3`);
    createDatabase(file);
    const versionedDb = new Database(file);
    versionedDb.run(`PRAGMA user_version = ${version}`);
    versionedDb.close();
    return file;
  };
  const missing = join(dir, "missing.sqlite3");

  for (const file of [garbage, other, versioned(BASELINE_SCHEMA_VERSION + 1), missing]) {
    expect(rejection(file).failure.kind).toBe("invalid_backup");
  }
  expect(rejection(other).message).toContain("not a Toodo database");
  expect(rejection(versioned(BASELINE_SCHEMA_VERSION - 1)).message).toContain(
    `schema version ${BASELINE_SCHEMA_VERSION - 1}; only version ${BASELINE_SCHEMA_VERSION} can be restored`,
  );
  expect(existsSync(missing)).toBe(false);
});

test("a loop through an archived task is staged, a loop among live tasks is rejected", () => {
  addWorkspace(db, "toodo");
  db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (1, 2)");
  db.run("UPDATE tasks SET archived_at = 1 WHERE id = 2");
  const throughArchived = join(dir, "archived.sqlite3");
  exportTo(db, throughArchived);
  const restored = openMemoryDatabase();
  restore(restored, stageBackup(throughArchived));
  expect(snapshot(restored)).toEqual(snapshot(db));

  db.run("UPDATE tasks SET archived_at = NULL WHERE id = 2");
  const live = join(dir, "live.sqlite3");
  exportTo(db, live);
  const error = rejection(live);
  expect(error.failure.kind).toBe("invalid_backup");
  expect(error.message).toContain("task dependencies loop: 1 -> 2 -> 1");
});

test("a backup with half waits is rejected naming its tasks", () => {
  addWorkspace(db, "toodo");
  const before = snapshot(db);
  const tampered = join(dir, "tampered.sqlite3");
  exportTo(db, tampered);
  const tamperedDb = new Database(tampered);
  tamperedDb.run(
    `DROP TRIGGER tasks_wait_pair_inserted;
     DROP TRIGGER tasks_wait_pair_updated;
     UPDATE tasks SET wait_until = 100 WHERE id = 1;
     UPDATE tasks SET wait_status = 'in_progress' WHERE id = 2;`,
  );
  tamperedDb.close();

  const error = rejection(tampered);

  expect(error.failure.kind).toBe("invalid_backup");
  expect(error.message).toContain("tasks 1, 2 have only one of wait_until and wait_status");
  expect(snapshot(db)).toEqual(before);
});

test("a backup with a row that refers to a missing row is rejected", () => {
  addWorkspace(db, "toodo");
  const dangling = join(dir, "dangling.sqlite3");
  exportTo(db, dangling);
  const danglingDb = new Database(dangling);
  danglingDb.run("PRAGMA foreign_keys = OFF");
  danglingDb.run("INSERT INTO task_labels (task_id, label) VALUES (99, 'orphan')");
  danglingDb.close();

  const error = rejection(dangling);

  expect(error.failure.kind).toBe("invalid_backup");
  expect(error.message).toContain("a row of task_labels refers to a row that does not exist");
});

test("a restore keeps the search index in step with the restored tasks", () => {
  addWorkspace(db, "toodo");
  const exportPath = join(dir, "export.sqlite3");
  exportTo(db, exportPath);
  addWorkspace(db, "notes");

  restore(db, stageBackup(exportPath));

  const hits = (term: string) =>
    db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM task_search WHERE task_search MATCH ? ORDER BY rowid")
      .all(term)
      .map((row) => row.rowid);
  expect(hits('"toodo"')).toEqual([1, 2]);
  expect(hits('"notes"')).toEqual([]);
});

test("backups in the same second keep each other", () => {
  const memory = openMemoryDatabase();
  const first = backupInto(memory, dir, "preRestore", 1_000);
  addWorkspace(memory, "toodo");
  const second = backupInto(memory, dir, "preRestore", 1_000);

  expect(first.path).not.toBe(second.path);
  expect(second.createdAt).toBe(1_001);
  const restored = openMemoryDatabase();
  addWorkspace(restored, "before");
  restore(restored, stageBackup(first.path));
  expect(restored.query("SELECT * FROM tasks").all()).toEqual([]);
});

test("a damaged snapshot fails the integrity check", () => {
  for (let index = 0; index < 40; index += 1) {
    addWorkspace(db, `workspace-${index}`);
  }
  const exportPath = join(dir, "export.sqlite3");
  exportTo(db, exportPath);
  checkIntegrity(exportPath);

  const bytes = readFileSync(exportPath);
  const page = 4096;
  expect(bytes.length).toBeGreaterThan(4 * page);
  bytes.fill(0x5a, 2 * page, 3 * page);
  writeFileSync(exportPath, bytes);

  expect(() => checkIntegrity(exportPath)).toThrow(StorageError);
  try {
    checkIntegrity(exportPath);
  } catch (error) {
    expect(error instanceof StorageError && error.failure.kind).toBe("backup_check_failed");
  }
});

test("a backup reads committed data without waiting for an open write", () => {
  addWorkspace(db, "committed");
  const writer = new Database(path);
  writer.run("BEGIN IMMEDIATE");
  writer.run("INSERT INTO workspaces (name) VALUES ('pending')");

  const started = performance.now();
  const saved = backupDatabase(path, join(dir, "backups"), "automatic", 1_000);

  expect(performance.now() - started).toBeLessThan(BUSY_TIMEOUT_MS);
  const restored = openMemoryDatabase();
  restore(restored, stageBackup(saved.path));
  expect(restored.query("SELECT name FROM workspaces").all()).toEqual([{ name: "committed" }]);
  writer.run("COMMIT");
  writer.close();
});

test("listing skips other files and sorts newest first", () => {
  expect(listBackups(join(dir, "none"))).toEqual([]);
  const memory = openMemoryDatabase();
  const backups = join(dir, "backups");
  const older = backupInto(memory, backups, "automatic", 1_000);
  const newer = backupInto(memory, backups, "preRestore", 2_000);
  writeFileSync(join(backups, "notes.txt"), "");
  mkdirSync(join(backups, fileName("automatic", 3_000)));

  expect(listBackups(backups)).toEqual([newer, older]);
});
