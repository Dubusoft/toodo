import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASELINE_SCHEMA_VERSION,
  BUSY_TIMEOUT_MS,
  SchemaVersionError,
  integrityCheck,
  openConnections,
  openReader,
  openWriter,
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
    createDatabase(BASELINE_SCHEMA_VERSION);
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
    createDatabase(BASELINE_SCHEMA_VERSION);
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
    createDatabase(BASELINE_SCHEMA_VERSION);
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
    createDatabase(BASELINE_SCHEMA_VERSION);
    expect(() => openReader(path)).toThrow(/write-ahead logging/);
  });

  test("the writer does not create a missing database", () => {
    expect(() => openWriter(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("schema version guard", () => {
  for (const version of [0, BASELINE_SCHEMA_VERSION - 1, BASELINE_SCHEMA_VERSION + 1]) {
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
        expect((error as SchemaVersionError).supported).toBe(BASELINE_SCHEMA_VERSION);
      }
      expect(journalModeOnDisk()).toBe("delete");
    });
  }

  test("the baseline version opens", () => {
    createDatabase(BASELINE_SCHEMA_VERSION);
    const { writer, close } = openConnections(path);
    try {
      expect(integrityCheck(writer)).toEqual(["ok"]);
    } finally {
      close();
    }
  });
});
