// Connections to the Toodo SQLite database for the TypeScript server (bun:sqlite).
//
// A new database gets the baseline schema of `schema.sql` (version
// `BASELINE_SCHEMA_VERSION`, the last schema of the Rust server this one replaced), and
// the writer brings a database from any version between the baseline and
// `SCHEMA_VERSION` up to date with `MIGRATIONS`. Older databases are refused: the Rust
// releases migrated them up to the baseline.
//
// Every connection gets the same rules: write-ahead logging, a 5 second busy timeout, and
// foreign key enforcement. Writes go through one writer connection; reads go through a
// separate read-only connection, which under WAL reads the last committed data without
// waiting for a write in progress.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/** The schema `schema.sql` creates: the last version the Rust server migrated to. */
export const BASELINE_SCHEMA_VERSION = 56;

/**
 * The schema changes after the baseline, in order: entry `i` takes a database from version
 * `BASELINE_SCHEMA_VERSION + i` to the next. Change the schema by appending one; never
 * edit or remove one that has shipped, since databases already carry its result.
 */
export const MIGRATIONS: readonly string[] = [
  // 57: one chat thread per task. Each task keeps its first thread, which takes the messages
  // of the task's other threads (into its channel), the furthest read point among them, and
  // the most open status (open, else closed, else archived); the others are deleted.
  `UPDATE chat_threads AS k SET read_id = g.read_id, status = g.status, closed_at = g.closed_at,
       archived_at = g.archived_at
   FROM (SELECT min(id) AS keep, max(read_id) AS read_id,
           CASE WHEN max(status = 'open') THEN 'open' WHEN max(status = 'closed') THEN 'closed'
             ELSE 'archived' END AS status,
           CASE WHEN max(status = 'open') THEN NULL ELSE min(closed_at) END AS closed_at,
           CASE WHEN max(status <> 'archived') THEN NULL ELSE max(archived_at) END AS archived_at
         FROM chat_threads WHERE task_id IS NOT NULL GROUP BY task_id HAVING count(*) > 1) AS g
   WHERE k.id = g.keep;
  UPDATE chat_messages AS m SET thread_id = k.id, channel_id = k.channel_id
   FROM chat_threads AS d JOIN chat_threads AS k
     ON k.id = (SELECT min(id) FROM chat_threads WHERE task_id = d.task_id)
   WHERE d.id = m.thread_id AND d.task_id IS NOT NULL AND d.id <> k.id;
  DELETE FROM chat_threads
   WHERE task_id IS NOT NULL
     AND id <> (SELECT min(k.id) FROM chat_threads AS k WHERE k.task_id = chat_threads.task_id);
  DROP INDEX chat_threads_task;
  CREATE UNIQUE INDEX chat_threads_task ON chat_threads (task_id) WHERE task_id IS NOT NULL;`,
  // 58: when the agent started waiting on the people's answer in a thread, unset otherwise.
  "ALTER TABLE chat_threads ADD COLUMN awaiting_at INTEGER",
  // 59: the chat and task notifications a device chooses one by one. Important chat
  // messages are on, as every message was before; task starts and finishes are off.
  `ALTER TABLE push_subscriptions ADD COLUMN important INTEGER NOT NULL DEFAULT 1
       CHECK (important IN (0, 1));
   ALTER TABLE push_subscriptions ADD COLUMN started INTEGER NOT NULL DEFAULT 0
       CHECK (started IN (0, 1));
   ALTER TABLE push_subscriptions ADD COLUMN finished INTEGER NOT NULL DEFAULT 0
       CHECK (finished IN (0, 1));`,
  // 60: the place of each chat channel in the order people set, starting in the order the
  // channels were made.
  `ALTER TABLE chat_channels ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
   UPDATE chat_channels SET position = id;`,
  // 61: the machine a workspace lives on, as Dori names its runner (`local` for the server's
  // host); unset leaves the navigation to place the workspace by its lanes.
  "ALTER TABLE workspaces ADD COLUMN machine TEXT",
];

/** The schema version this server reads and writes. */
export const SCHEMA_VERSION = BASELINE_SCHEMA_VERSION + MIGRATIONS.length;

/** How long a statement waits for a lock held by another connection or process. */
export const BUSY_TIMEOUT_MS = 5000;

const BASELINE_SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** The rows a new database starts with: the `general` chat channel, created at `now`. */
const SEED = "INSERT INTO chat_channels (id, name, read_id, created_at) VALUES (1, 'general', 0, ?)";

/** The database's schema version is outside `BASELINE_SCHEMA_VERSION`..`SCHEMA_VERSION`, or
 * is not `SCHEMA_VERSION` where no migration can run. */
export class SchemaVersionError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(path: string, found: number, oldest = BASELINE_SCHEMA_VERSION) {
    const hint =
      found < BASELINE_SCHEMA_VERSION
        ? "it was written by an older Toodo; migrate it with the last Rust toodo-server release first (docs/host.md)"
        : found < oldest
          ? "open the writer first, which migrates it"
          : "it was written by a newer Toodo";
    const versions = oldest === SCHEMA_VERSION ? `version ${SCHEMA_VERSION} is` : `versions ${oldest} to ${SCHEMA_VERSION} are`;
    super(`${path} has schema version ${found}, but only ${versions} supported: ${hint}`);
    this.name = "SchemaVersionError";
    this.found = found;
    this.supported = SCHEMA_VERSION;
  }
}

/**
 * Creates the database file at `path`, which must not exist yet, with the current schema
 * and no data but the `general` chat channel created at `now` (seconds).
 */
export function createDatabase(path: string, now = Math.floor(Date.now() / 1000)): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    initializeSchema(db, now);
  } finally {
    db.close();
  }
}

/** Gives the empty database `db` the current schema and the rows of a new database. */
export function initializeSchema(db: Database, now: number, migrations: readonly string[] = MIGRATIONS): void {
  db.transaction(() => {
    db.run(BASELINE_SCHEMA);
    db.run(SEED, [now]);
  })();
  migrate(db, migrations);
}

/**
 * Brings `db`, at a version from `BASELINE_SCHEMA_VERSION` up, to the version after
 * `migrations`, one transaction per migration, each committed only when no row is left
 * referring to a missing one. Foreign keys must be off, so a migration can rebuild a table.
 */
export function migrate(db: Database, migrations: readonly string[] = MIGRATIONS): void {
  const latest = BASELINE_SCHEMA_VERSION + migrations.length;
  for (let version = schemaVersion(db); version < latest; version++) {
    db.transaction(() => {
      db.run(migrations[version - BASELINE_SCHEMA_VERSION]!);
      const violation = db.query<{ table: string }, []>("PRAGMA foreign_key_check").get();
      if (violation !== null) {
        throw new Error(`migration to version ${version + 1} left a row of ${violation.table} referring to a row that does not exist`);
      }
      db.run(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}

export function schemaVersion(db: Database): number {
  return pragmaValue(db, "user_version") as number;
}

/**
 * Opens the writer connection to the existing database at `path`, migrates it to
 * `SCHEMA_VERSION`, and switches it to write-ahead logging. A database of a version it
 * cannot migrate is closed unchanged and rejected with `SchemaVersionError`.
 */
export function openWriter(path: string): Database {
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    checkSchemaVersion(db, path, BASELINE_SCHEMA_VERSION);
    migrate(db);
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
 * Opens a read-only connection to the database at `path`, which must already be at
 * `SCHEMA_VERSION` and use write-ahead logging (the writer migrates and switches it).
 * Writes through it fail.
 */
export function openReader(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    checkSchemaVersion(db, path, SCHEMA_VERSION);
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

/** Refuses a database outside `oldest`..`SCHEMA_VERSION`. */
function checkSchemaVersion(db: Database, path: string, oldest: number): void {
  const found = schemaVersion(db);
  if (found < oldest || found > SCHEMA_VERSION) {
    throw new SchemaVersionError(path, found, oldest);
  }
}

function pragmaValue(db: Database, pragma: string): unknown {
  const row = db.query<Record<string, unknown>, []>(`PRAGMA ${pragma}`).get();
  return row === null ? undefined : Object.values(row)[0];
}
