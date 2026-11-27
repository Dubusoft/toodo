// Commands for database backups (`src-tauri/src/commands/backup.rs`): restore, the automatic
// backup schedule and the timer that writes automatic backups, and the export and import of
// a database file. The TypeScript server never migrates a database, so it takes no backup
// before a migration.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type * as B from "../../../src/lib/bindings.ts";
import {
  type BackupSettings,
  DEFAULT_BACKUP_SETTINGS,
  BackupSettingsError,
  exportFileName as exportName,
  isDue,
  parseFileName,
  validateBackupSettings,
} from "../domain/backup.ts";
import { debugString, trim } from "../domain/rust.ts";
import {
  type BackupFile,
  backupDatabase,
  backupInto,
  exportDatabase,
  exportTo,
  listBackups as listBackupFiles,
  pruneBackups,
  restore as restoreStaged,
  stageBackup,
} from "../storage/backup.ts";
import { type ImportSummary, importBackup } from "../storage/import.ts";
import type { Storage } from "../storage/storage.ts";
import { command, internal, invalidInput, ioMessage, notFound, storageMessage } from "./errors.ts";
import type { Args, Reply } from "./types.ts";

const BACKUP_DIR = "backups";
const SETTINGS_FILE = "backup-settings.json";

/** How often the timer checks whether an automatic backup is due. */
const CHECK_PERIOD_MS = 10 * 60 * 1000;

/** The automatic backup settings as the web app sends them, checked: the directory trimmed,
 * with blank meaning none. */
function parseSettings(settings: B.BackupSettings): BackupSettings {
  const directory = trim(settings.directory ?? "");
  try {
    return validateBackupSettings({
      enabled: settings.enabled,
      intervalHours: settings.intervalHours,
      keep: settings.keep,
      directory: directory === "" ? null : directory,
    });
  } catch (error) {
    if (error instanceof BackupSettingsError) throw invalidInput(error.message);
    throw error;
  }
}

function settingsReply(settings: BackupSettings): B.BackupSettings {
  return {
    enabled: settings.enabled,
    intervalHours: settings.intervalHours,
    keep: settings.keep,
    directory: settings.directory,
  };
}

function entry(file: BackupFile): B.BackupEntry {
  return { path: file.path, kind: file.kind, createdAt: file.createdAt, sizeBytes: file.sizeBytes };
}

function isU32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

/** The settings saved at `path`: the defaults when there is no file. */
function readSettings(path: string): BackupSettings {
  let json: string;
  try {
    json = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return DEFAULT_BACKUP_SETTINGS;
    throw new Error(ioMessage(error));
  }
  const saved: unknown = JSON.parse(json);
  if (typeof saved !== "object" || saved === null) throw new Error("expected the backup settings as an object");
  const { enabled, intervalHours, keep, directory } = saved as Record<string, unknown>;
  if (typeof enabled !== "boolean") throw new Error("missing or invalid field `enabled`");
  if (!isU32(intervalHours)) throw new Error("missing or invalid field `intervalHours`");
  if (!isU32(keep)) throw new Error("missing or invalid field `keep`");
  if (directory !== undefined && directory !== null && typeof directory !== "string") {
    throw new Error("invalid field `directory`");
  }
  return parseSettings({ enabled, intervalHours, keep, directory: directory ?? null });
}

/** Creates `dir` if needed and checks that a file can be written into it. */
function ensureWritable(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, ".toodo-write-test");
  writeFileSync(probe, "");
  rmSync(probe);
}

/** Toodo's backup directory and automatic backup settings. The settings live in a file next
 * to the database rather than in it, so a restore does not change them. */
export class Backups {
  /** `<dataDir>/backups`: the backup directory unless the settings name another, and where
   * files on their way in or out are staged. */
  readonly defaultDir: string;
  readonly settingsPath: string;
  #settings: BackupSettings;
  #status: B.BackupStatus = { lastFailure: null };

  private constructor(dataDir: string, settings: BackupSettings) {
    this.defaultDir = join(dataDir, BACKUP_DIR);
    this.settingsPath = join(dataDir, SETTINGS_FILE);
    this.#settings = settings;
  }

  /** Uses the backup directory and the settings saved in `dataDir`; missing or unreadable
   * settings fall back to the defaults. */
  static load(dataDir: string): Backups {
    const path = join(dataDir, SETTINGS_FILE);
    let settings = DEFAULT_BACKUP_SETTINGS;
    try {
      settings = readSettings(path);
    } catch (error) {
      console.error(`toodo: ignoring backup settings in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new Backups(dataDir, settings);
  }

  get settings(): BackupSettings {
    return this.#settings;
  }

  get status(): B.BackupStatus {
    return this.#status;
  }

  set status(status: B.BackupStatus) {
    this.#status = status;
  }

  /** The directory backups are written to and listed from: the one the settings name, or
   * `<dataDir>/backups`. */
  dir(): string {
    return this.#settings.directory ?? this.defaultDir;
  }

  /** The backup named `name` in the backup directory, as `listBackups` lists it. Any other
   * name, such as a path, is not found. */
  backupPath(name: string): string {
    const missing = () => notFound(`no backup named ${debugString(name)}`);
    if (parseFileName(name) === null) throw missing();
    const path = join(this.dir(), name);
    let file = false;
    try {
      file = statSync(path).isFile();
    } catch {
      // A backup that cannot be read is not there.
    }
    if (!file) throw missing();
    return path;
  }

  /** A new path in `<dataDir>/backups` for a file on its way in or out, such as an uploaded
   * backup; `listBackups` does not list it. The caller removes it. */
  scratchPath(purpose: string): string {
    mkdirSync(this.defaultDir, { recursive: true });
    return join(this.defaultDir, `.${purpose}-${randomBytes(8).toString("hex")}.sqlite3`);
  }

  saveSettings(settings: BackupSettings): void {
    writeFileSync(this.settingsPath, JSON.stringify(settingsReply(settings), null, 2));
    this.#settings = settings;
  }
}

/** The database file of `storage`, or `null` for an in-memory database, which no other
 * connection can read. */
function databaseFile(storage: Storage): string | null {
  const file = storage.db.filename;
  return file === "" || file === ":memory:" ? null : file;
}

export function getBackupSettings(backups: Backups): Reply<"getBackupSettings"> {
  return settingsReply(backups.settings);
}

/** Whether the latest automatic backup failed, and why. */
export function getBackupStatus(backups: Backups): Reply<"getBackupStatus"> {
  return backups.status;
}

/** Saves the automatic backup settings, then writes an automatic backup if one is now due. A
 * backup directory in the settings is created if needed and must be writable. */
export const saveBackupSettings: (
  storage: Storage,
  backups: Backups,
  ...args: Args<"saveBackupSettings">
) => Reply<"saveBackupSettings"> = command((storage, backups, input) => {
  const settings = parseSettings(input);
  if (settings.directory !== null) {
    try {
      ensureWritable(settings.directory);
    } catch (error) {
      throw invalidInput(
        `cannot write backups to ${settings.directory}: ${ioMessage(error)}; pick a directory the toodo-server user can create and write, or leave it empty to keep backups in ${backups.defaultDir}`,
      );
    }
  }
  try {
    backups.saveSettings(settings);
  } catch (error) {
    throw internal(`failed to save backup settings: ${ioMessage(error)}`);
  }
  runDueBackup(storage, backups);
  return settingsReply(settings);
});

/** Backups in Toodo's backup directory, newest first. */
export const listBackups: (backups: Backups) => Reply<"listBackups"> = command((backups) =>
  listBackupFiles(backups.dir()).map(entry));

/** Replaces all data with the backup named `name` in Toodo's backup directory (see
 * `listBackups`). The current data is first saved as a pre-restore backup, which is
 * returned. */
export const restoreBackup: (
  storage: Storage,
  backups: Backups,
  ...args: Args<"restoreBackup">
) => Reply<"restoreBackup"> = command((storage, backups, name) =>
  entry(restore(storage, backups, backups.backupPath(name))));

/** Replaces all data with the Toodo database at `path`, after saving the current data as a
 * pre-restore backup, which is returned. */
export const restoreFile: (storage: Storage, backups: Backups, path: string) => B.BackupEntry = command(
  (storage, backups, path) => entry(restore(storage, backups, path)),
);

function restore(storage: Storage, backups: Backups, path: string): BackupFile {
  const staged = stageBackup(path);
  const safety = backupInto(storage.db, backups.dir(), "preRestore", storage.now());
  restoreStaged(storage.db, staged);
  return safety;
}

/** Writes a consistent snapshot of the database to a new file in the backup directory and
 * returns its path; the caller removes it. It reads the database file through a connection of
 * its own, so requests do not wait for it. */
export const exportSnapshot: (storage: Storage, backups: Backups) => string = command((storage, backups) => {
  let path: string;
  try {
    path = backups.scratchPath("export");
  } catch (error) {
    throw internal(`cannot export: ${ioMessage(error)}`);
  }
  const database = databaseFile(storage);
  if (database !== null) exportDatabase(database, path);
  else exportTo(storage.db, path);
  return path;
});

/** The file name a snapshot of the database is saved under, with today's date (UTC). */
export function exportFileName(storage: Storage): string {
  return exportName(storage.now());
}

/** Adds the workspaces and tasks of the Toodo database at `path` to the data, after saving
 * the current data as a pre-restore backup, which is returned with what was added. */
export function importFile(
  storage: Storage,
  backups: Backups,
  path: string,
): { safety: BackupFile; summary: ImportSummary } {
  const staged = stageBackup(path);
  const safety = backupInto(storage.db, backups.dir(), "preRestore", storage.now());
  return { safety, summary: importBackup(storage.db, staged) };
}

/**
 * Writes an automatic backup when the settings enable it and the interval has passed since
 * the latest one, then deletes the automatic backups beyond the number kept. The outcome is
 * kept for `getBackupStatus`.
 */
export function runDueBackup(storage: Storage, backups: Backups): BackupFile | null {
  const settings = backups.settings;
  if (!settings.enabled) return null;
  const now = storage.now();
  const dir = backups.dir();
  let written: BackupFile | null;
  try {
    written = writeDueBackup(storage, dir, now, settings);
  } catch (error) {
    backups.status = {
      lastFailure: {
        at: now,
        message: `could not back up into ${dir}: ${storageMessage(error)}; make that directory writable for the toodo-server user, or choose another one under Settings > Backups`,
      },
    };
    throw error;
  }
  if (written !== null) backups.status = { lastFailure: null };
  return written;
}

function writeDueBackup(storage: Storage, dir: string, now: number, settings: BackupSettings): BackupFile | null {
  const latest = listBackupFiles(dir).find((file) => file.kind === "automatic")?.createdAt ?? null;
  if (!isDue(latest, now, settings.intervalHours)) return null;
  const database = databaseFile(storage);
  const file = database !== null
    ? backupDatabase(database, dir, "automatic", now)
    : backupInto(storage.db, dir, "automatic", now);
  pruneBackups(dir, "automatic", settings.keep);
  return file;
}

/** Writes automatic backups while the server runs: now, then whenever one is due. Returns
 * what stops it. */
export function startAutomaticBackups(storage: Storage, backups: Backups): () => void {
  const run = () => {
    try {
      runDueBackup(storage, backups);
    } catch (error) {
      console.error(`toodo: automatic backup failed: ${storageMessage(error)}`);
    }
  };
  run();
  const timer = setInterval(run, CHECK_PERIOD_MS);
  return () => clearInterval(timer);
}
