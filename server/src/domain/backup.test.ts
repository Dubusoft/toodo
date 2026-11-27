import { describe, expect, test } from "bun:test";

import {
  BACKUP_KINDS,
  BackupSettingsError,
  type BackupSettings,
  type BackupSettingsProblem,
  DEFAULT_BACKUP_SETTINGS,
  exportFileName,
  fileName,
  isDue,
  parseFileName,
  validateBackupSettings,
} from "./backup.ts";

function problemOf(settings: BackupSettings): BackupSettingsProblem {
  try {
    validateBackupSettings(settings);
  } catch (error) {
    if (error instanceof BackupSettingsError) return error.problem;
    throw error;
  }
  throw new Error("expected a BackupSettingsError");
}

describe("backup", () => {
  test("export names carry the utc date and are not backup names", () => {
    const name = exportFileName(1_791_970_205);
    expect(name).toBe("toodo-backup-2026-10-14.sqlite3");
    expect(parseFileName(name)).toBeNull();
  });

  test("file names carry kind and utc time", () => {
    const at = 1_791_970_205;
    expect(fileName("automatic", at)).toBe("toodo-auto-20261014-093005.sqlite3");
    expect(fileName("preRestore", 0)).toBe("toodo-pre-restore-19700101-000000.sqlite3");
    expect(fileName("automatic", 951_782_400)).toBe("toodo-auto-20000229-000000.sqlite3");
    expect(fileName("preMigration", 0)).toBe("toodo-pre-migration-19700101-000000.sqlite3");
  });

  test("file names parse back", () => {
    for (const kind of BACKUP_KINDS) {
      for (const at of [0, 951_782_400, 1_791_970_205, 4_102_444_799]) {
        expect(parseFileName(fileName(kind, at))).toEqual({ kind, at });
      }
    }
  });

  test("other file names are not backups", () => {
    for (const name of [
      "toodo.sqlite3",
      "toodo-auto-20261014-093005.sqlite3.partial",
      "toodo-auto-20261014-093005.db",
      "toodo-manual-20261014-093005.sqlite3",
      "toodo-auto-2026101-0930050.sqlite3",
      "toodo-auto-20261314-093005.sqlite3",
      "toodo-auto-20260230-093005.sqlite3",
      "toodo-auto-20261014-253005.sqlite3",
      "toodo-auto-2026+014-093005.sqlite3",
      "notes.txt",
    ]) {
      expect([name, parseFileName(name)]).toEqual([name, null]);
    }
  });

  test("a backup is due once the interval has passed", () => {
    expect(isDue(null, 0, 24)).toBe(true);
    expect(isDue(1_000, 1_000 + 24 * 3_600 - 1, 24)).toBe(false);
    expect(isDue(1_000, 1_000 + 24 * 3_600, 24)).toBe(true);
    expect(isDue(1_000, 1_000 + 3_600, 1)).toBe(true);
    expect(isDue(1_000, 999, 24)).toBe(true);
  });

  test("settings are bounded", () => {
    expect(validateBackupSettings(DEFAULT_BACKUP_SETTINGS)).toEqual(DEFAULT_BACKUP_SETTINGS);
    const settings = (intervalHours: number, keep: number): BackupSettings => ({
      enabled: true,
      intervalHours,
      keep,
      directory: null,
    });
    expect(problemOf(settings(0, 7))).toEqual({ kind: "interval", hours: 0 });
    expect(problemOf(settings(721, 7))).toEqual({ kind: "interval", hours: 721 });
    expect(problemOf(settings(24, 0))).toEqual({ kind: "keep", count: 0 });
    expect(problemOf(settings(24, 101))).toEqual({ kind: "keep", count: 101 });
    expect(() => validateBackupSettings(settings(720, 100))).not.toThrow();
    const inDirectory = (directory: string): BackupSettings => ({
      ...DEFAULT_BACKUP_SETTINGS,
      directory,
    });
    expect(problemOf(inDirectory("backups"))).toEqual({ kind: "directory", directory: "backups" });
    expect(() => validateBackupSettings(inDirectory("/mnt/backup/toodo"))).not.toThrow();
  });
});
