// The time zone reviews are judged in, kept in `settings`, and saved reviews, kept in
// `review_snapshots` exactly as they were rendered when saved. Port of
// `src-tauri/src/storage/reviews.rs`.

import type { Database } from "bun:sqlite";

const REVIEW_TIME_ZONE = "review_time_zone";

/** What describes a saved review, without its contents. */
export interface ReviewSnapshotInfo {
  id: number;
  title: string;
  /** The kind of period, as the review report names it (`week`, `month`, ...). */
  period: string;
  /** The first and last day of the period, as `YYYY-MM-DD` in `timeZone`. */
  from: string;
  to: string;
  /** The IANA time zone the period was judged in. */
  timeZone: string;
  workspaceId: number | null;
  label: string | null;
  /** The period as `[startAt, endAt)` in Unix seconds. */
  startAt: number;
  endAt: number;
  createdAt: number;
  entryCount: number;
}

/**
 * A saved review: what describes it, the reviewed entries and the names of their
 * workspaces as JSON, and the report as Markdown and CSV.
 */
export interface ReviewSnapshot {
  info: ReviewSnapshotInfo;
  entries: string;
  workspaces: string;
  markdown: string;
  csv: string;
}

/** A review to save; storage assigns its id and the time it was saved. */
export interface NewReviewSnapshot extends Omit<ReviewSnapshot, "info"> {
  info: Omit<ReviewSnapshotInfo, "id" | "createdAt">;
}

const INFO_COLUMNS = `id, title, period, from_day, to_day, time_zone, workspace_id, label,
     start_at, end_at, created_at, entry_count`;

interface InfoRow {
  id: number;
  title: string;
  period: string;
  from_day: string;
  to_day: string;
  time_zone: string;
  workspace_id: number | null;
  label: string | null;
  start_at: number;
  end_at: number;
  created_at: number;
  entry_count: number;
}

function info(row: InfoRow): ReviewSnapshotInfo {
  return {
    id: row.id,
    title: row.title,
    period: row.period,
    from: row.from_day,
    to: row.to_day,
    timeZone: row.time_zone,
    workspaceId: row.workspace_id,
    label: row.label,
    startAt: row.start_at,
    endAt: row.end_at,
    createdAt: row.created_at,
    entryCount: row.entry_count,
  };
}

/** The IANA time zone set for reviews, or `null` to use the server's. */
export function reviewTimeZone(db: Database): string | null {
  return (
    db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?1")
      .get(REVIEW_TIME_ZONE)?.value ?? null
  );
}

/** Sets the time zone reviews are judged in; `null` goes back to the server's. */
export function setReviewTimeZone(db: Database, timeZone: string | null): void {
  if (timeZone === null) {
    db.run("DELETE FROM settings WHERE key = ?1", [REVIEW_TIME_ZONE]);
  } else {
    db.run(
      `INSERT INTO settings (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [REVIEW_TIME_ZONE, timeZone],
    );
  }
}

/** Saves `snapshot` as saved at `at` and returns what describes it. */
export function saveReviewSnapshot(
  db: Database,
  snapshot: NewReviewSnapshot,
  at: number,
): ReviewSnapshotInfo {
  const saved = snapshot.info;
  const { lastInsertRowid } = db.run(
    `INSERT INTO review_snapshots (title, period, from_day, to_day, time_zone,
         workspace_id, label, start_at, end_at, created_at, entry_count, entries,
         workspaces, markdown, csv)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    [
      saved.title,
      saved.period,
      saved.from,
      saved.to,
      saved.timeZone,
      saved.workspaceId,
      saved.label,
      saved.startAt,
      saved.endAt,
      at,
      saved.entryCount,
      snapshot.entries,
      snapshot.workspaces,
      snapshot.markdown,
      snapshot.csv,
    ],
  );
  return { ...saved, id: Number(lastInsertRowid), createdAt: at };
}

/** The saved reviews, the most recently saved first. */
export function listReviewSnapshots(db: Database): ReviewSnapshotInfo[] {
  return db
    .query<InfoRow, []>(
      `SELECT ${INFO_COLUMNS} FROM review_snapshots ORDER BY created_at DESC, id DESC`,
    )
    .all()
    .map(info);
}

/** The saved review `id`, or `null` when there is none. */
export function reviewSnapshot(db: Database, id: number): ReviewSnapshot | null {
  const row = db
    .query<InfoRow & Omit<ReviewSnapshot, "info">, [number]>(
      `SELECT ${INFO_COLUMNS}, entries, workspaces, markdown, csv
       FROM review_snapshots WHERE id = ?1`,
    )
    .get(id);
  return row === null
    ? null
    : {
        info: info(row),
        entries: row.entries,
        workspaces: row.workspaces,
        markdown: row.markdown,
        csv: row.csv,
      };
}

/** Deletes the saved review `id`; `false` when there was none. */
export function deleteReviewSnapshot(db: Database, id: number): boolean {
  return db.run("DELETE FROM review_snapshots WHERE id = ?1", [id]).changes > 0;
}
