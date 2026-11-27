// Rules for database backups: file names of the backups Toodo writes on its own, when the
// next automatic backup is due, and the automatic backup settings.

import { isAbsolute } from "node:path";

import { divEuclid, padNumber, remEuclid } from "./rust.ts";

/** Why Toodo wrote a backup into its backup directory: on the `automatic` schedule, right
 * before a restore replaced the data (`preRestore`), or right before a newer Toodo migrated
 * the database to its schema (`preMigration`). */
export type BackupKind = "automatic" | "preRestore" | "preMigration";

export const BACKUP_KINDS: readonly BackupKind[] = ["automatic", "preRestore", "preMigration"];

function tag(kind: BackupKind): string {
  switch (kind) {
    case "automatic":
      return "auto";
    case "preRestore":
      return "pre-restore";
    case "preMigration":
      return "pre-migration";
  }
}

const PREFIX = "toodo-";
const EXTENSION = ".sqlite3";
const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

/** File name of a backup of `kind` taken at `at` (seconds since the Unix epoch), e.g.
 * `toodo-auto-20261014-093000.sqlite3`. The time is UTC. */
export function fileName(kind: BackupKind, at: number): string {
  const { year, month, day } = civilFromDays(divEuclid(at, SECONDS_PER_DAY));
  const seconds = remEuclid(at, SECONDS_PER_DAY);
  const hour = Math.trunc(seconds / SECONDS_PER_HOUR);
  const minute = Math.trunc((seconds % SECONDS_PER_HOUR) / 60);
  return `${PREFIX}${tag(kind)}-${padNumber(year, 4)}${padNumber(month, 2)}${padNumber(day, 2)}-${padNumber(hour, 2)}${padNumber(minute, 2)}${padNumber(seconds % 60, 2)}${EXTENSION}`;
}

/** File name a snapshot exported at `at` is saved under, e.g.
 * `toodo-backup-2026-10-14.sqlite3`. The date is UTC. It is not a backup name that
 * `parseFileName` accepts, so an export saved into the backup directory is not listed. */
export function exportFileName(at: number): string {
  const { year, month, day } = civilFromDays(divEuclid(at, SECONDS_PER_DAY));
  return `${PREFIX}backup-${padNumber(year, 4)}-${padNumber(month, 2)}-${padNumber(day, 2)}${EXTENSION}`;
}

/** A backup Toodo wrote: its kind and when it was taken. */
export type BackupFile = { readonly kind: BackupKind; readonly at: number };

/** Kind and time of a backup named by `fileName`; `null` for any other file. */
export function parseFileName(name: string): BackupFile | null {
  if (!name.startsWith(PREFIX)) return null;
  const afterPrefix = name.slice(PREFIX.length);
  if (!afterPrefix.endsWith(EXTENSION)) return null;
  const rest = afterPrefix.slice(0, afterPrefix.length - EXTENSION.length);
  for (const kind of BACKUP_KINDS) {
    const prefix = `${tag(kind)}-`;
    if (!rest.startsWith(prefix)) continue;
    const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(rest.slice(prefix.length));
    if (match === null) return null;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined
    ) {
      return null;
    }
    const at =
      daysFromCivil(year, month, day) * SECONDS_PER_DAY +
      hour * SECONDS_PER_HOUR +
      minute * 60 +
      second;
    // Out-of-range fields such as month 13 or 25 o'clock do not survive the round trip.
    return fileName(kind, at) === name ? { kind, at } : null;
  }
  return null;
}

/** Whether an automatic backup is due at `now`, given the time of the latest one. A latest
 * backup from the future means the clock was turned back, so one is due. */
export function isDue(latest: number | null, now: number, intervalHours: number): boolean {
  return latest === null || now < latest || now - latest >= intervalHours * SECONDS_PER_HOUR;
}

export type BackupSettings = {
  readonly enabled: boolean;
  /** Hours between automatic backups. */
  readonly intervalHours: number;
  /** Number of automatic backups kept; older ones are deleted. */
  readonly keep: number;
  /** Absolute path of the directory backups are written to, e.g. on another disk; `null`
   * keeps them in the data directory. */
  readonly directory: string | null;
};

export const MAX_INTERVAL_HOURS = 24 * 30;
export const MAX_KEEP = 100;

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: true,
  intervalHours: 24,
  keep: 7,
  directory: null,
};

export type BackupSettingsProblem =
  | { readonly kind: "interval"; readonly hours: number }
  | { readonly kind: "keep"; readonly count: number }
  | { readonly kind: "directory"; readonly directory: string };

export class BackupSettingsError extends Error {
  readonly problem: BackupSettingsProblem;

  constructor(problem: BackupSettingsProblem) {
    super(backupSettingsMessage(problem));
    this.name = "BackupSettingsError";
    this.problem = problem;
  }
}

function backupSettingsMessage(problem: BackupSettingsProblem): string {
  switch (problem.kind) {
    case "interval":
      return `backup interval must be between 1 and ${MAX_INTERVAL_HOURS} hours, not ${problem.hours}`;
    case "keep":
      return `number of kept backups must be between 1 and ${MAX_KEEP}, not ${problem.count}`;
    case "directory":
      return `backup directory ${problem.directory} is not an absolute path; enter a full path such as /mnt/backup/toodo, or leave it empty to keep backups in the data directory`;
  }
}

export function validateBackupSettings(settings: BackupSettings): BackupSettings {
  if (settings.intervalHours < 1 || settings.intervalHours > MAX_INTERVAL_HOURS) {
    throw new BackupSettingsError({ kind: "interval", hours: settings.intervalHours });
  }
  if (settings.keep < 1 || settings.keep > MAX_KEEP) {
    throw new BackupSettingsError({ kind: "keep", count: settings.keep });
  }
  if (settings.directory !== null && !isAbsolute(settings.directory)) {
    throw new BackupSettingsError({ kind: "directory", directory: settings.directory });
  }
  return settings;
}

/** A proleptic Gregorian date. */
export type CivilDate = { readonly year: number; readonly month: number; readonly day: number };

/** Proleptic Gregorian date of a day counted from 1970-01-01 (Howard Hinnant's algorithm). */
export function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = divEuclid(z, 146_097);
  const doe = remEuclid(z, 146_097);
  const yoe = Math.trunc(
    (doe - Math.trunc(doe / 1_460) + Math.trunc(doe / 36_524) - Math.trunc(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const day = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

function daysFromCivil(civilYear: number, month: number, day: number): number {
  const year = month <= 2 ? civilYear - 1 : civilYear;
  const era = divEuclid(year, 400);
  const yoe = remEuclid(year, 400);
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.trunc((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}
