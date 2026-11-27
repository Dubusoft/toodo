// Backups of the database: consistent snapshots written with `VACUUM INTO` and checked
// with `PRAGMA integrity_check`, restores that check a backup before it replaces the live
// data, and the backup directory Toodo keeps automatic and pre-restore backups in. Port
// of `src-tauri/src/storage/backup.rs`.
//
// Unlike the Rust server, which migrates an older backup while staging it, the TypeScript
// server neither migrates nor writes another schema, so it restores only backups at
// `BASELINE_SCHEMA_VERSION`.

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BackupKind, fileName, parseFileName } from "../domain/backup.ts";
import { BASELINE_SCHEMA_VERSION, BUSY_TIMEOUT_MS, integrityCheck, schemaVersion } from "./database.ts";
import { StorageError } from "./errors.ts";
import { liveCycle, replaceWithAttached } from "./restore.ts";

/** A backup Toodo wrote into its backup directory. */
export interface BackupFile {
  path: string;
  kind: BackupKind;
  /** Unix seconds. */
  createdAt: number;
  sizeBytes: number;
}

/** A backup that was read and checked, ready to replace the live data with `restore`. */
export class StagedBackup {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /**
   * Runs `use` while a private copy of the backup is attached to `db` as schema `name`;
   * the copy is deleted afterwards.
   */
  attachTo<T>(db: Database, name: string, use: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), "toodo-staged-"));
    try {
      const file = join(dir, "staged.sqlite3");
      writeFileSync(file, this.#bytes, { mode: 0o600 });
      db.run(`ATTACH DATABASE ? AS ${name}`, [file]);
      try {
        return use();
      } finally {
        db.run(`DETACH DATABASE ${name}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Writes a consistent snapshot of the database of `db` to `path`, replacing any file
 * there. The snapshot is written next to `path` first and checked with
 * `PRAGMA integrity_check`, so a failed or damaged snapshot never takes its place.
 */
export function exportTo(db: Database, path: string): void {
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  db.run("VACUUM INTO ?", [partial]);
  try {
    checkIntegrity(partial);
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

/**
 * Writes a backup of `kind` of the database of `db` into `dir` at time `at`, creating the
 * directory if needed. A backup never replaces an earlier one from the same second; it
 * takes the next free second instead.
 */
export function backupInto(db: Database, dir: string, kind: BackupKind, at: number): BackupFile {
  mkdirSync(dir, { recursive: true });
  let createdAt = at;
  while (existsSync(join(dir, fileName(kind, createdAt)))) {
    createdAt += 1;
  }
  const path = join(dir, fileName(kind, createdAt));
  exportTo(db, path);
  return { path, kind, createdAt, sizeBytes: statSync(path).size };
}

/**
 * Writes a backup of the database file at `database` into `dir` through a connection of
 * its own. The database is in WAL mode, so the backup reads the last committed data
 * without waiting for the writes of other connections, and they do not wait for it.
 */
export function backupDatabase(database: string, dir: string, kind: BackupKind, at: number): BackupFile {
  return withSource(database, (db) => backupInto(db, dir, kind, at));
}

/** Writes a consistent snapshot of the database file at `database` to `path`. */
export function exportDatabase(database: string, path: string): void {
  withSource(database, (db) => exportTo(db, path));
}

/**
 * A connection to read a backup from the existing database file at `database`. It is not
 * read-only: SQLite has to be able to create the WAL index of a database in WAL mode that
 * no other connection has open.
 */
function withSource<T>(database: string, read: (db: Database) => T): T {
  const db = new Database(database, { readwrite: true, create: false, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return read(db);
  } finally {
    db.close();
  }
}

export function checkIntegrity(path: string): void {
  let result: string[];
  try {
    const db = new Database(path, { readonly: true });
    try {
      result = integrityCheck(db);
    } finally {
      db.close();
    }
  } catch (error) {
    throw new StorageError({ kind: "backup_check_failed", reason: `${path}: ${String(error)}` });
  }
  if (result.join("\n") !== "ok") {
    throw new StorageError({ kind: "backup_check_failed", reason: `${path}: ${result.join("\n")}` });
  }
}

/**
 * Reads the backup at `path` into memory and checks it: a Toodo database at
 * `BASELINE_SCHEMA_VERSION`, intact, with valid foreign keys, no task waiting with only
 * one of `wait_until` and `wait_status`, and no loop among the dependencies of its live
 * tasks. Fails with `invalid_backup` otherwise, so the live data stays untouched.
 */
export function stageBackup(path: string): StagedBackup {
  const invalid = (reason: unknown) =>
    new StorageError({ kind: "invalid_backup", reason: `${path}: ${String(reason)}` });
  let bytes: Uint8Array;
  try {
    const source = new Database(path, { readonly: true });
    try {
      const version = schemaVersion(source);
      if (version === 0) {
        throw invalid("not a Toodo database");
      }
      if (version !== BASELINE_SCHEMA_VERSION) {
        throw invalid(
          `schema version ${version}; only version ${BASELINE_SCHEMA_VERSION} can be restored`,
        );
      }
      bytes = source.serialize();
    } finally {
      source.close();
    }
  } catch (error) {
    throw error instanceof StorageError ? error : invalid(error);
  }
  const staged = Database.deserialize(bytes);
  try {
    const integrity = integrityCheck(staged).join("\n");
    if (integrity !== "ok") {
      throw invalid(`integrity check failed: ${integrity}`);
    }
    const violation = staged.query<{ table: string }, []>("PRAGMA foreign_key_check").get();
    if (violation !== null) {
      throw invalid(`a row of ${violation.table} refers to a row that does not exist`);
    }
    const halfWaits = staged
      .query<{ ids: string | null }, []>(
        `SELECT group_concat(id, ', ') AS ids FROM (SELECT id FROM tasks
         WHERE (wait_until IS NULL) <> (wait_status IS NULL) ORDER BY id)`,
      )
      .get()?.ids;
    if (halfWaits !== null && halfWaits !== undefined) {
      throw invalid(`tasks ${halfWaits} have only one of wait_until and wait_status`);
    }
    const cycle = liveCycle(staged);
    if (cycle !== null) {
      throw invalid(`task dependencies loop: ${cycle.join(" -> ")}`);
    }
  } finally {
    staged.close();
  }
  return new StagedBackup(bytes);
}

/** Replaces all data of `db` with a staged backup, in one transaction. */
export function restore(db: Database, staged: StagedBackup): void {
  staged.attachTo(db, "staged", () => replaceWithAttached(db, "staged"));
}

/**
 * Backups in `dir`, newest first. A missing directory has none; files that Toodo did not
 * name as backups are skipped.
 */
export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) {
    return [];
  }
  const backups: BackupFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const parsed = parseFileName(entry.name);
    if (parsed === null || !entry.isFile()) {
      continue;
    }
    const path = join(dir, entry.name);
    backups.push({ path, kind: parsed.kind, createdAt: parsed.at, sizeBytes: statSync(path).size });
  }
  return backups.sort(
    (a, b) => b.createdAt - a.createdAt || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0),
  );
}

/** Deletes all but the newest `keep` backups of `kind` in `dir`; returns the deleted ones. */
export function pruneBackups(dir: string, kind: BackupKind, keep: number): BackupFile[] {
  const expired = listBackups(dir)
    .filter((backup) => backup.kind === kind)
    .slice(keep);
  for (const backup of expired) {
    rmSync(backup.path, { force: true });
  }
  return expired;
}
