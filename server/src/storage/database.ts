// Connections to the Toodo SQLite database for the TypeScript server (bun:sqlite).
//
// The file and its schema are the ones the Rust server (`src-tauri/`) creates and
// migrates; this module neither creates a database nor migrates one. It opens only a
// database whose `PRAGMA user_version` is exactly `BASELINE_SCHEMA_VERSION`.
//
// Every connection gets the same rules: write-ahead logging, a 5 second busy timeout, and
// foreign key enforcement. Writes go through one writer connection; reads go through a
// separate read-only connection, which under WAL reads the last committed data without
// waiting for a write in progress.

import { Database } from "bun:sqlite";

/**
 * The schema version the TypeScript server reads and writes: the Rust `LATEST_VERSION`
 * (`src-tauri/src/storage/migrations/mod.rs`) when the TypeScript storage work started.
 * The Rust schema is frozen at this version (see `AGENTS.md`); it moves only once the
 * Rust server is gone.
 */
export const BASELINE_SCHEMA_VERSION = 56;

/** How long a statement waits for a lock held by another connection or process. */
export const BUSY_TIMEOUT_MS = 5000;

/** The database's schema version is not `BASELINE_SCHEMA_VERSION`. */
export class SchemaVersionError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(path: string, found: number) {
    const hint =
      found < BASELINE_SCHEMA_VERSION
        ? "it was written by an older Toodo; start the current toodo-server on it once to migrate it"
        : "it was written by a newer Toodo";
    super(
      `${path} has schema version ${found}, but only version ${BASELINE_SCHEMA_VERSION} is supported: ${hint}`,
    );
    this.name = "SchemaVersionError";
    this.found = found;
    this.supported = BASELINE_SCHEMA_VERSION;
  }
}

export function schemaVersion(db: Database): number {
  return pragmaValue(db, "user_version") as number;
}

/**
 * Opens the writer connection to the existing database at `path` and switches it to
 * write-ahead logging. A database of another schema version is closed unchanged and
 * rejected with `SchemaVersionError`.
 */
export function openWriter(path: string): Database {
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    checkSchemaVersion(db, path);
    const mode = pragmaValue(db, "journal_mode = WAL");
    if (mode !== "wal") {
      throw new Error(`${path} could not be switched to write-ahead logging (journal mode ${mode})`);
    }
    // The switch creates the -wal and -shm files only on the next read. A read-only
    // connection cannot create them and fails to open until they exist.
    db.query("SELECT count(*) FROM sqlite_master").get();
    db.run("PRAGMA foreign_keys = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Opens a read-only connection to the database at `path`, which must already use
 * write-ahead logging (the writer switches it). Writes through it fail.
 */
export function openReader(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    checkSchemaVersion(db, path);
    const mode = pragmaValue(db, "journal_mode");
    if (mode !== "wal") {
      throw new Error(
        `${path} does not use write-ahead logging (journal mode ${mode}); open the writer first`,
      );
    }
    db.run("PRAGMA foreign_keys = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface Connections {
  writer: Database;
  reader: Database;
  close(): void;
}

export function openConnections(path: string): Connections {
  const writer = openWriter(path);
  let reader: Database;
  try {
    reader = openReader(path);
  } catch (error) {
    writer.close();
    throw error;
  }
  return {
    writer,
    reader,
    close() {
      reader.close();
      writer.close();
    },
  };
}

/** The rows of `PRAGMA integrity_check`: `["ok"]` for an intact database. */
export function integrityCheck(db: Database): string[] {
  return db
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
    .all()
    .map((row) => row.integrity_check);
}

function checkSchemaVersion(db: Database, path: string): void {
  const found = schemaVersion(db);
  if (found !== BASELINE_SCHEMA_VERSION) {
    throw new SchemaVersionError(path, found);
  }
}

function pragmaValue(db: Database, pragma: string): unknown {
  const row = db.query<Record<string, unknown>, []>(`PRAGMA ${pragma}`).get();
  return row === null ? undefined : Object.values(row)[0];
}
