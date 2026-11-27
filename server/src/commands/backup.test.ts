import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { type BackupSettings, DEFAULT_BACKUP_SETTINGS, fileName } from "../domain/backup.ts";
import { backupInto, exportTo, listBackups as listBackupFiles } from "../storage/backup.ts";
import { openWriter } from "../storage/database.ts";
import { StorageError } from "../storage/errors.ts";
import { Storage } from "../storage/storage.ts";
import { createDatabase } from "../storage/testing.ts";
import {
  Backups,
  exportSnapshot,
  getBackupStatus,
  importFile,
  listBackups,
  restoreBackup,
  restoreFile,
  runDueBackup,
  saveBackupSettings,
} from "./backup.ts";
import { commandFailure as failure } from "./command-fixtures.ts";

const HOUR = 3_600;

let dataDir: string;
let storage: Storage;
let clock: number;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "toodo-backup-commands-"));
  const path = join(dataDir, "toodo.sqlite3");
  createDatabase(path);
  clock = 1_791_970_205;
  storage = new Storage(openWriter(path), () => clock);
});

afterEach(() => {
  storage.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function addWorkspace(name: string): void {
  storage.createWorkspace({ name, description: null, repository: null });
}

function workspaceNames(): string[] {
  return storage.listWorkspaces().map((workspace) => workspace.name);
}

function settings(enabled: boolean, intervalHours: number, keep: number): BackupSettings {
  return { enabled, intervalHours, keep, directory: null };
}

function due(backups: Backups) {
  const written = runDueBackup(storage, backups);
  if (written === null) throw new Error("no backup was due");
  return written;
}

/** Writes a backup to `path` with three tasks over two workspaces, each depending on the
 * next; `closeLoop` adds the edge from the last back to the first, which only an edit of the
 * file outside Toodo can make. */
function writeChainBackup(path: string, closeLoop: boolean): void {
  createDatabase(path);
  const other = new Storage(openWriter(path));
  try {
    const tasks = ([["app", "first"], ["site", "second"], ["app", "third"]] as const).map(([name, title]) => {
      const workspace = other.listWorkspaces().find((existing) => existing.name === name)
        ?? other.createWorkspace({ name, description: null, repository: null });
      return other.createTask({
        workspaceId: workspace.id, taskType: "feat", title, description: "",
        estimate: null, dueDate: null, autopilot: false, criteria: [],
      }).id;
    });
    other.addDependency(tasks[0], tasks[1]);
    other.addDependency(tasks[1], tasks[2]);
    if (closeLoop) {
      other.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", [tasks[2], tasks[0]]);
    }
  } finally {
    other.db.close();
  }
}

describe("backup commands", () => {
  test("automatic backups follow the interval and keep the newest", () => {
    const backups = Backups.load(dataDir);
    backups.saveSettings(settings(true, 2, 2));
    addWorkspace("toodo");

    const first = due(backups);
    expect(existsSync(first.path)).toBe(true);
    clock += HOUR;
    expect(runDueBackup(storage, backups)).toBeNull();
    clock += HOUR;
    const second = due(backups);
    clock += 2 * HOUR;
    const third = due(backups);

    expect(listBackupFiles(backups.dir()).map((file) => file.path)).toEqual([third.path, second.path]);
    expect(existsSync(first.path)).toBe(false);
  });

  test("disabled automatic backups write nothing", () => {
    const backups = Backups.load(dataDir);
    backups.saveSettings(settings(false, 1, 7));
    expect(runDueBackup(storage, backups)).toBeNull();
    expect(listBackupFiles(backups.dir())).toEqual([]);
  });

  test("pruning keeps pre-restore backups", () => {
    const backups = Backups.load(dataDir);
    backups.saveSettings(settings(true, 1, 1));
    const exported = join(dataDir, "export.sqlite3");
    exportTo(storage.db, exported);
    const safety = restoreFile(storage, backups, exported);
    clock += HOUR;
    due(backups);
    clock += HOUR;
    const latest = due(backups);

    expect(listBackupFiles(backups.dir()).map((file) => file.path)).toEqual([latest.path, safety.path]);
  });

  test("restore saves the current data first", () => {
    const backups = Backups.load(dataDir);
    addWorkspace("before");
    const exported = join(dataDir, "export.sqlite3");
    exportTo(storage.db, exported);
    addWorkspace("after");

    const safety = restoreFile(storage, backups, exported);

    expect(safety.kind).toBe("preRestore");
    expect(workspaceNames()).toEqual(["before"]);
    restoreFile(storage, backups, safety.path);
    expect(workspaceNames()).toEqual(["before", "after"]);
  });

  test("an invalid backup leaves data and backups alone", () => {
    const backups = Backups.load(dataDir);
    addWorkspace("toodo");
    const garbage = join(dataDir, "garbage.sqlite3");
    writeFileSync(garbage, "not a database at all, just some bytes".repeat(200));

    const error = failure(() => restoreFile(storage, backups, garbage));

    expect(error.code).toBe("invalidInput");
    expect(error.message.startsWith("invalid backup ")).toBe(true);
    expect(workspaceNames()).toEqual(["toodo"]);
    expect(listBackupFiles(backups.dir())).toEqual([]);
  });

  test("a backup whose dependencies loop leaves data and backups alone", () => {
    const backups = Backups.load(dataDir);
    addWorkspace("toodo");
    const looping = join(dataDir, "looping.sqlite3");
    writeChainBackup(looping, true);

    const restored = failure(() => restoreFile(storage, backups, looping));
    let imported: unknown;
    try {
      importFile(storage, backups, looping);
    } catch (error) {
      imported = error;
    }

    expect(restored.code).toBe("invalidInput");
    expect(restored.message.endsWith("task dependencies loop: 1 -> 2 -> 3 -> 1")).toBe(true);
    expect(imported).toBeInstanceOf(StorageError);
    expect((imported as StorageError).message.endsWith("task dependencies loop: 1 -> 2 -> 3 -> 1")).toBe(true);
    expect(workspaceNames()).toEqual(["toodo"]);
    expect(storage.listAllTasks()).toEqual([]);
    expect(listBackupFiles(backups.dir())).toEqual([]);
  });

  test("dependencies across workspaces are imported and restored", () => {
    const backups = Backups.load(dataDir);
    addWorkspace("toodo");
    const chain = join(dataDir, "chain.sqlite3");
    writeChainBackup(chain, false);
    const dependsOn = () => storage.listAllTasks().map((task) => [Number(task.id), [...task.dependsOn].map(Number)]);

    const { summary } = importFile(storage, backups, chain);

    expect(summary.tasks).toBe(3);
    expect(workspaceNames()).toEqual(["toodo", "app", "site"]);
    expect(dependsOn()).toEqual([[1, [2]], [2, [3]], [3, []]]);
    restoreFile(storage, backups, chain);
    expect(workspaceNames()).toEqual(["app", "site"]);
    expect(dependsOn()).toEqual([[1, [2]], [2, [3]], [3, []]]);
  });

  test("settings are saved to a file and read back", () => {
    expect(Backups.load(dataDir).settings).toEqual(DEFAULT_BACKUP_SETTINGS);
    Backups.load(dataDir).saveSettings(settings(false, 6, 3));
    expect(Backups.load(dataDir).settings).toEqual(settings(false, 6, 3));

    writeFileSync(join(dataDir, "backup-settings.json"), '{"enabled":true,"intervalHours":0,"keep":3}');
    expect(Backups.load(dataDir).settings).toEqual(DEFAULT_BACKUP_SETTINGS);
  });

  test("backups are restored by name from the backup directory only", () => {
    const backups = Backups.load(dataDir);
    addWorkspace("before");
    const saved = backupInto(storage.db, backups.dir(), "automatic", storage.now());
    addWorkspace("after");

    const safety = restoreBackup(storage, backups, basename(saved.path));

    expect(safety.kind).toBe("preRestore");
    expect(workspaceNames()).toEqual(["before"]);
    const database = join(dataDir, "toodo.sqlite3");
    for (const name of ["toodo.sqlite3", "../toodo.sqlite3", database, fileName("automatic", 0)]) {
      expect(failure(() => restoreBackup(storage, backups, name)).kind).toBe("notFound");
    }
    expect(workspaceNames()).toEqual(["before"]);
  });

  test("snapshots are not listed as backups", () => {
    const backups = Backups.load(dataDir);
    addWorkspace("toodo");
    const snapshot = exportSnapshot(storage, backups);
    expect(snapshot.startsWith(backups.dir())).toBe(true);
    expect(listBackupFiles(backups.dir())).toEqual([]);
    restoreFile(storage, backups, snapshot);
    expect(workspaceNames()).toEqual(["toodo"]);
  });

  test("backups go to the configured directory", () => {
    const backups = Backups.load(dataDir);
    const elsewhere = mkdtempSync(join(tmpdir(), "toodo-backup-elsewhere-"));
    try {
      const directory = join(elsewhere, "toodo");
      addWorkspace("toodo");

      const saved = saveBackupSettings(storage, backups, {
        enabled: true, intervalHours: 24, keep: 7, directory: `  ${directory}  `,
      });

      expect(saved.directory).toBe(directory);
      const listed = listBackups(backups);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.path.startsWith(directory)).toBe(true);
      expect(existsSync(join(dataDir, "backups"))).toBe(false);
      expect(Backups.load(dataDir).settings.directory).toBe(directory);
      const safety = restoreBackup(storage, backups, basename(listed[0]?.path ?? ""));
      expect(safety.path.startsWith(directory)).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("unusable backup directories are refused", () => {
    const backups = Backups.load(dataDir);
    const file = join(dataDir, "a-file");
    writeFileSync(file, "");
    for (const directory of ["relative/backups", file]) {
      const error = failure(() => saveBackupSettings(storage, backups, {
        enabled: true, intervalHours: 24, keep: 7, directory,
      }));
      expect(error.kind).toBe("invalidInput");
    }
    expect(backups.settings).toEqual(DEFAULT_BACKUP_SETTINGS);
  });

  test("a failed automatic backup is reported until one succeeds", () => {
    const backups = Backups.load(dataDir);
    const file = join(dataDir, "a-file");
    writeFileSync(file, "");
    expect(getBackupStatus(backups)).toEqual({ lastFailure: null });
    backups.saveSettings({ ...settings(true, 1, 7), directory: join(file, "backups") });

    expect(() => runDueBackup(storage, backups)).toThrow();

    const failed = getBackupStatus(backups).lastFailure;
    expect(failed?.at).toBe(storage.now());
    expect(failed?.message).toContain(`could not back up into ${join(file, "backups")}: file error: Not a directory (os error`);
    backups.saveSettings(settings(true, 1, 7));
    due(backups);
    expect(getBackupStatus(backups)).toEqual({ lastFailure: null });
  });
});
