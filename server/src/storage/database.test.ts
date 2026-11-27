import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASELINE_SCHEMA_VERSION,
  BUSY_TIMEOUT_MS,
  MIGRATIONS,
  SCHEMA_VERSION,
  SchemaVersionError,
  createDatabase as createNewDatabase,
  initializeSchema,
  integrityCheck,
  migrate,
  openConnections,
  openReader,
  openWriter,
  schemaVersion,
} from "./database.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toodo-storage-"));
  path = join(dir, "toodo.sqlite3");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A database with a parent/child foreign key, at `version`, in rollback journal mode. */
function createDatabase(version: number): void {
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE parents (id INTEGER PRIMARY KEY)");
  db.run("CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents (id))");
  db.run("INSERT INTO parents (id) VALUES (1)");
  db.run(`PRAGMA user_version = ${version}`);
  db.close();
}

function pragma(db: Database, name: string): unknown {
  return Object.values(db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get()!)[0];
}

function journalModeOnDisk(): unknown {
  const db = new Database(path, { readonly: true });
  try {
    return pragma(db, "journal_mode");
  } finally {
    db.close();
  }
}

describe("connection rules", () => {
  test("the writer uses WAL, the busy timeout, and foreign keys", () => {
    createDatabase(SCHEMA_VERSION);
    const writer = openWriter(path);
    try {
      expect(pragma(writer, "journal_mode")).toBe("wal");
      expect(pragma(writer, "busy_timeout")).toBe(BUSY_TIMEOUT_MS);
      expect(pragma(writer, "foreign_keys")).toBe(1);
      expect(() => writer.run("INSERT INTO children (parent_id) VALUES (2)")).toThrow(/FOREIGN KEY/);
    } finally {
      writer.close();
    }
  });

  test("the reader uses WAL, the busy timeout, and foreign keys, and cannot write", () => {
    createDatabase(SCHEMA_VERSION);
    const { reader, close } = openConnections(path);
    try {
      expect(pragma(reader, "journal_mode")).toBe("wal");
      expect(pragma(reader, "busy_timeout")).toBe(BUSY_TIMEOUT_MS);
      expect(pragma(reader, "foreign_keys")).toBe(1);
      expect(() => reader.run("INSERT INTO parents (id) VALUES (2)")).toThrow(/readonly/);
    } finally {
      close();
    }
  });

  test("the reader reads committed data while the writer holds a write transaction", () => {
    createDatabase(SCHEMA_VERSION);
    const { writer, reader, close } = openConnections(path);
    try {
      writer.run("BEGIN IMMEDIATE");
      writer.run("INSERT INTO parents (id) VALUES (2)");
      expect(reader.query("SELECT count(*) AS n FROM parents").get()).toEqual({ n: 1 });
      writer.run("COMMIT");
      expect(reader.query("SELECT count(*) AS n FROM parents").get()).toEqual({ n: 2 });
    } finally {
      close();
    }
  });

  test("the reader refuses a database that does not use WAL", () => {
    createDatabase(SCHEMA_VERSION);
    expect(() => openReader(path)).toThrow(/write-ahead logging/);
  });

  test("the writer does not create a missing database", () => {
    expect(() => openWriter(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("schema version guard", () => {
  for (const version of [0, BASELINE_SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
    test(`version ${version} is rejected and the file is left unchanged`, () => {
      createDatabase(version);
      for (const open of [openWriter, openReader]) {
        let error: unknown;
        try {
          open(path).close();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(SchemaVersionError);
        expect((error as SchemaVersionError).found).toBe(version);
        expect((error as SchemaVersionError).supported).toBe(SCHEMA_VERSION);
      }
      expect(journalModeOnDisk()).toBe("delete");
    });
  }

  test("the baseline version opens, migrated to the current one", () => {
    const db = new Database(path, { create: true, strict: true });
    initializeSchema(db, 0, []);
    db.close();
    const { writer, close } = openConnections(path);
    try {
      expect(schemaVersion(writer)).toBe(SCHEMA_VERSION);
      expect(integrityCheck(writer)).toEqual(["ok"]);
    } finally {
      close();
    }
  });
});

describe("schema creation and migrations", () => {
  /** An in-memory database at the baseline schema, before any migration. */
  function baseline(): Database {
    const db = new Database(":memory:", { strict: true });
    initializeSchema(db, 0, []);
    return db;
  }

  test("a new database has the current schema and the general channel created at the given time", () => {
    createNewDatabase(path, 1234);
    const { writer, close } = openConnections(path);
    try {
      expect(schemaVersion(writer)).toBe(SCHEMA_VERSION);
      expect(writer.query("SELECT id, name, created_at FROM chat_channels").all()).toEqual([
        { id: 1, name: "general", created_at: 1234 },
      ]);
      expect(integrityCheck(writer)).toEqual(["ok"]);
    } finally {
      close();
    }
  });

  test("the migration after the baseline brings it to the next version, once", () => {
    const db = baseline();
    const migrations = ["CREATE TABLE read_marks (id INTEGER PRIMARY KEY)"];
    expect(schemaVersion(db)).toBe(BASELINE_SCHEMA_VERSION);
    migrate(db, migrations);
    expect(schemaVersion(db)).toBe(BASELINE_SCHEMA_VERSION + 1);
    migrate(db, migrations);
    expect(schemaVersion(db)).toBe(BASELINE_SCHEMA_VERSION + 1);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'read_marks'").all()).toEqual([{ name: "read_marks" }]);
    db.close();
  });

  test("version 57 merges each task's chat threads into its first, which makes them unique", () => {
    const db = baseline();
    db.run("INSERT INTO workspaces (name) VALUES ('toodo')");
    for (const title of ["Ship", "Docs", "Old"]) {
      db.run("INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'feat', ?1, 'planned')", [title]);
    }
    db.run("INSERT INTO chat_channels (id, name, created_at) VALUES (2, 'lanes', 0)");
    const thread = (channel: number, task: number | null, status: string, closed: number | null, archived: number | null, read: number) =>
      Number(
        db.run(
          `INSERT INTO chat_threads (channel_id, title, task_id, status, created_at, closed_at, archived_at, read_id)
           VALUES (?1, 'Thread', ?2, ?3, 0, ?4, ?5, ?6)`,
          [channel, task, status, closed, archived, read],
        ).lastInsertRowid,
      );
    const say = (channel: number, thread: number) =>
      db.run("INSERT INTO chat_messages (author, body, at, channel_id, thread_id) VALUES ('user', 'Hi', 0, ?1, ?2)", [channel, thread]);
    const ship = [thread(1, 1, "closed", 10, null, 0), thread(2, 1, "archived", 20, 30, 3), thread(1, 1, "open", null, null, 1)];
    const docs = thread(1, 2, "closed", 5, null, 0);
    const old = [thread(1, 3, "archived", 40, 50, 0), thread(1, 3, "archived", 30, 60, 0)];
    const loose = [thread(1, null, "open", null, null, 0), thread(1, null, "open", null, null, 0)];
    say(1, ship[0]!);
    say(2, ship[1]!);
    say(2, ship[1]!);
    say(1, ship[2]!);
    say(1, docs);
    say(1, loose[1]!);
    const before = db.query("SELECT count(*) AS n FROM chat_messages").get();

    migrate(db, MIGRATIONS);

    expect(schemaVersion(db)).toBe(57);
    expect(
      db.query("SELECT id, channel_id, task_id, status, closed_at, archived_at, read_id FROM chat_threads ORDER BY id").all(),
    ).toEqual([
      { id: ship[0], channel_id: 1, task_id: 1, status: "open", closed_at: null, archived_at: null, read_id: 3 },
      { id: docs, channel_id: 1, task_id: 2, status: "closed", closed_at: 5, archived_at: null, read_id: 0 },
      { id: old[0], channel_id: 1, task_id: 3, status: "archived", closed_at: 30, archived_at: 60, read_id: 0 },
      { id: loose[0], channel_id: 1, task_id: null, status: "open", closed_at: null, archived_at: null, read_id: 0 },
      { id: loose[1], channel_id: 1, task_id: null, status: "open", closed_at: null, archived_at: null, read_id: 0 },
    ]);
    expect(db.query("SELECT count(*) AS n FROM chat_messages").get()).toEqual(before);
    expect(db.query("SELECT channel_id, thread_id, count(*) AS n FROM chat_messages GROUP BY 1, 2 ORDER BY 2").all()).toEqual([
      { channel_id: 1, thread_id: ship[0], n: 4 },
      { channel_id: 1, thread_id: docs, n: 1 },
      { channel_id: 1, thread_id: loose[1], n: 1 },
    ]);
    expect(() => thread(1, 2, "open", null, null, 0)).toThrow("UNIQUE constraint failed: chat_threads.task_id");
    thread(1, null, "open", null, null, 0);
    expect(integrityCheck(db)).toEqual(["ok"]);
    db.close();
  });

  test("a migration that leaves a dangling reference is rolled back", () => {
    const db = baseline();
    expect(() =>
      migrate(db, ["INSERT INTO tasks (workspace_id, type, title, status) VALUES (999, 'feat', 'orphan', 'planned')"]),
    ).toThrow(`migration to version ${BASELINE_SCHEMA_VERSION + 1} left a row of tasks referring to a row that does not exist`);
    expect(schemaVersion(db)).toBe(BASELINE_SCHEMA_VERSION);
    expect(db.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    db.close();
  });
});
