import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { replaceFileDurable } from "./durable-write.ts";
import type { Wake } from "./lead-wakes.ts";
import type { Journal, JournalEvent, OutboxItem, Restart } from "./supervise.ts";
import { DAY_MS } from "./time-ms.ts";

/**
 * Where the supervisor journal lives (config `store`): `supervisor.sqlite` (WAL), the only store. Each save writes only
 * the rows that changed, so an enqueue costs one row instead of the whole history. `lead-events.log` stays the lead's
 * transport; the store records each delivery and the log byte offset it has read, so a restart reads only the log tail.
 * A state dir still holding the retired json store's files is converted once when its config loads (store-import.ts).
*/

export const JOURNAL_FILE = "supervisor.json";
export const SQLITE_FILE = "supervisor.sqlite";
/** The converted `supervisor.json`, kept read-only for audit. */
export const PRE_SQLITE_FILE = "supervisor.json.pre-sqlite";
/**
 * The retired json store's files: a state dir holding any of them and no supervisor.sqlite (nor its import marker) is
 * converted once (store-import.ts). The journal, operations, lane reports, lane messages and the GitHub poll state.
 */
const JSON_STORE_FILES: readonly string[] = [JOURNAL_FILE, "operations.json", "lane-reports.json", "lane-messages.json", "github-events.json"];
const holdsJson = (stateDir: string): boolean => JSON_STORE_FILES.some((file) => existsSync(join(stateDir, file)));
/** supervisor.sqlite, or the import marker left when it was made (its database may since be lost). */
const holdsSqlite = (stateDir: string): boolean => existsSync(join(stateDir, SQLITE_FILE)) || existsSync(join(stateDir, PRE_SQLITE_FILE));
/** Whether `stateDir` still holds the retired json store and has not been converted. */
export const jsonStorePending = (stateDir: string): boolean => !holdsSqlite(stateDir) && holdsJson(stateDir);
export const SCHEMA_VERSION = 9;
/** Every row belongs to the single lead today; per-lead rows arrive with Phase 3. */
export const DEFAULT_LEAD = "dori";

export class StoreError extends Error {}

/**
 * Retention per class (sqlite store, Appendix D). Unresolved work is never pruned: undelivered events, the events of
 * a pending restart and open PRs. Delivered event bodies leave after `eventBodyMs` for a dedupe
 * tombstone; event tombstones leave after `tombstoneMs`; GitHub status history (closed PR activity, cached
 * responses no poll used) after `statusHistoryMs`.
 */
export const RETENTION = { eventBodyMs: 7 * DAY_MS, tombstoneMs: 90 * DAY_MS, statusHistoryMs: 30 * DAY_MS } as const;

/** `full`: durable against power loss before returning. `normal`: durable against a process crash (WAL). */
export type Durability = "full" | "normal";

export interface JournalStore {
  /** The stored journal, or undefined when nothing is stored yet. */
  load(): Journal | undefined;
  /** Persist `journal`; a sqlite store writes only what differs from the last load or save. */
  save(journal: Journal, durability: Durability): void;
  /** Delivered event ids the store recorded. */
  deliveredIds(): Set<string> | undefined;
  /** Bytes of lead-events.log already reflected in deliveredIds. */
  logCursor(): number;
  /** Record deliveries appended to the log, and the log offset they reach. */
  recordDeliveries(ids: readonly string[], cursor: number, at: number): void;
  /** Record that the lead took delivered events `ids` at `at` in `session` (a consumed take receipt); the first take wins. */
  recordTakes(ids: readonly string[], at: number, session: string): void;
  /** Whether the store prunes delivered event bodies. */
  readonly retains: boolean;
  /** An event id whose body was pruned: still a duplicate until its tombstone expires. */
  tombstoned(id: string): boolean;
  /** Drop expired event deduplication tombstones. */
  expireTombstones(cutoff: number): void;
  /** Make every earlier normal write durable against power loss too (the supervisor calls it once per loop pass). */
  sync(): void;
  /** Appends an open lead wake. */
  recordWake(wake: Wake): void;
  /** The latest wake while it is still open. */
  openWake(): Wake | undefined;
  /** Closes the open wake started at `at` with its model calls (undefined: not readable). */
  closeWake(at: number, calls: number | undefined): void;
  /** Drops wakes older than `cutoff`. */
  pruneWakes(cutoff: number): void;
  close(): void;
}

/** Rename only after the new contents reach disk; a crash leaves either complete version. */
export const saveJsonFile = (path: string, value: unknown): void => replaceFileDurable(path, JSON.stringify(value), 0o600);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, lead TEXT NOT NULL,
  line TEXT NOT NULL, at INTEGER, at_synthetic INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deliveries (
  event_id TEXT PRIMARY KEY, lead TEXT NOT NULL, generation INTEGER NOT NULL, delivered_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS deliveries_at ON deliveries (delivered_at);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, pos INTEGER NOT NULL, text TEXT NOT NULL, attempts INTEGER, next_at INTEGER);
CREATE TABLE IF NOT EXISTS lead_restarts (
  lead TEXT PRIMARY KEY, session TEXT NOT NULL, events TEXT NOT NULL, "offset" INTEGER NOT NULL, phase TEXT NOT NULL,
  strikes INTEGER, unconfirmed INTEGER, reason TEXT, request TEXT, force INTEGER);
CREATE TABLE IF NOT EXISTS lead_state (
  lead TEXT PRIMARY KEY, models TEXT);
`;

/**
 * Schema changes after version 1, each applied once in order. Two lanes adding a migration take consecutive numbers.
 * 2: dedupe tombstones of pruned events, and the GitHub poll state that was github-events.json.
 * 3: lead wakes with their trigger kinds and model calls (lead-wakes.ts).
 * 4: the lead's take cursor and push state (`inbox`) and the forced restarts of the last hour (supervise-push.ts).
 * 5: lane outcome report obligations (`outcomes`, lane-outcomes.ts).
 * 6: event lane metadata (`events.meta`) and when and in which session the lead took each delivery (event-trace.ts).
 * 7: decision obligations (`pending`, decision-obligations.ts).
 * 8: the head repository of each polled PR (`gh_prs.head_repo`), so a fork PR is never taken for a lane's own.
 */
const MIGRATIONS: readonly (readonly [number, string | ((db: Database) => void)])[] = [[2, `
CREATE TABLE IF NOT EXISTS event_tombstones (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS event_tombstones_at ON event_tombstones (at);
CREATE TABLE IF NOT EXISTS gh_repos (repo TEXT PRIMARY KEY, polled INTEGER NOT NULL DEFAULT 0, issues INTEGER NOT NULL DEFAULT 0, failed_at INTEGER);
CREATE TABLE IF NOT EXISTS gh_prs (
  repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL, sha TEXT NOT NULL, branch TEXT NOT NULL, updated TEXT NOT NULL,
  url TEXT NOT NULL, conflicting INTEGER NOT NULL, checks TEXT NOT NULL, activity TEXT NOT NULL, PRIMARY KEY (repo, number)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gh_issues (
  repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL, reopens INTEGER NOT NULL, PRIMARY KEY (repo, number)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gh_cache (
  repo TEXT NOT NULL, path TEXT NOT NULL, etag TEXT, body TEXT NOT NULL, next TEXT, used_at INTEGER, PRIMARY KEY (repo, path));
CREATE INDEX IF NOT EXISTS gh_cache_used ON gh_cache (used_at);
`], [3, `
CREATE TABLE IF NOT EXISTS lead_wakes (
  seq INTEGER PRIMARY KEY, lead TEXT NOT NULL, at INTEGER NOT NULL, session TEXT NOT NULL, trigger TEXT NOT NULL, kinds TEXT NOT NULL,
  calls INTEGER, closed INTEGER);
CREATE INDEX IF NOT EXISTS lead_wakes_at ON lead_wakes (at);
`], [4, (db) => addColumns(db, "lead_state", ["inbox TEXT", "forced_restarts TEXT"])],
  [5, (db) => addColumns(db, "lead_state", ["outcomes TEXT"])],
  [6, (db) => { addColumns(db, "events", ["meta TEXT"]); addColumns(db, "deliveries", ["taken_at INTEGER", "taken_session TEXT"]); }],
  [7, (db) => addColumns(db, "lead_state", ["pending TEXT"])],
  [8, (db) => addColumns(db, "gh_prs", ["head_repo TEXT"])],
  [9, () => {}]]; // Version 9 only extended a retired table.

/** Whether `table` has `column`: a read-only reader of a store the supervisor has not migrated yet must not name it. */
export const hasColumn = (db: Database, table: string, column: string): boolean =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((info) => info.name === column);

/** ADD COLUMN has no IF NOT EXISTS: a migration replayed over a database that already has a column must skip it. */
const addColumns = (db: Database, table: string, columns: readonly string[]): void => {
  const have = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
  for (const column of columns) if (!have.has(column.split(" ")[0] ?? "")) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
};

/** Recognized only during legacy JSON import; none of these fields has a destination. */
export const RETIRED_TRACKING_FIELDS = ["awaitingAck", "notifications", "noticed", "closedOwners", "leadBusySince", "leadScreen"];

/** Journal scalars kept in lead_state, with their column. */
const LEAD_STATE = [
  ["models", "models"],
  ["inbox", "inbox"], ["forcedRestarts", "forced_restarts"], ["outcomes", "outcomes"],
  ["pending", "pending"],
] as const satisfies readonly (readonly [keyof Journal, string])[];

/** Every Journal field this store maps (Appendix D). An import refuses a journal with any other field. */
export const JOURNAL_FIELDS: readonly string[] = ["events", "restart", "outbox", ...LEAD_STATE.map(([field]) => field)];

type Row = Record<string, string | number | null>;
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : undefined);
const kindOf = (line: string): string => line.split(" ", 1)[0] ?? "";
/**
 * The SQLite journal. It keeps the last journal it loaded or saved and writes the difference in one transaction:
 * events by array position (they only ever append), the outbox by id, scalars by value. The
 * supervisor lock makes it the only writer, so that snapshot is the database's content.
 */
export class SqliteStore implements JournalStore {
  private readonly db: Database;
  private last: Journal = { events: [] };
  /** How many events of `last.events` are stored: the supervisor appends to that array in place. */
  private storedEvents = 0;
  private synthetic = new Set<string>();
  private nextPos = 0;
  private durability?: Durability;
  private journalMarked = false;
  private unsynced = false;
  private readonly stmt;
  private readonly now: () => number;
  readonly retains = true;

  constructor(readonly path: string, options: { readonly create?: boolean; readonly wal?: boolean; readonly now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    if (!options.create && !existsSync(path)) throw new StoreError(`STORE_MISSING ${path}`);
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec(`PRAGMA journal_mode = ${options.wal === false ? "DELETE" : "WAL"}`);
      this.db.exec("PRAGMA busy_timeout = 5000");
      // Checkpoints are the only fsyncs of a normal commit: 4000 pages (about 16 MB of WAL) keeps them rare.
      this.db.exec("PRAGMA wal_autocheckpoint = 4000");
      const check = this.db.query("PRAGMA quick_check").get() as { quick_check?: string } | null;
      if (check?.quick_check !== "ok") throw new StoreError(`STORE_CORRUPT ${path}: ${check?.quick_check ?? "no result"}`);
      this.db.exec(SCHEMA);
      // A version that is not a positive integer would pass both checks below as NaN and silently skip every migration.
      const stored = this.meta("schema_version") ?? "1";
      if (!/^[1-9][0-9]*$/.test(stored)) throw new StoreError(`STORE_SCHEMA ${path}: unreadable version ${JSON.stringify(stored)}`);
      const version = Number(stored);
      if (version > SCHEMA_VERSION) throw new StoreError(`STORE_SCHEMA ${path}: version ${version}, this code reads ${SCHEMA_VERSION}`);
      for (const [to, ddl] of MIGRATIONS) {
        if (to > version) this.db.transaction(() => { if (typeof ddl === "string") this.db.exec(ddl); else ddl(this.db); this.setMeta("schema_version", String(to)); })();
      }
      if (this.meta("schema_version") === undefined) this.setMeta("schema_version", String(SCHEMA_VERSION));
    } catch (e) {
      this.db.close();
      throw e;
    }
    const db = this.db;
    this.stmt = {
      event: db.prepare(`INSERT INTO events (id, kind, lead, line, at, at_synthetic, meta) VALUES ($id, $kind, $lead, $line, $at, $synthetic, $meta)
        ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, line = excluded.line, at = excluded.at, at_synthetic = excluded.at_synthetic, meta = excluded.meta`),
      eventDelete: db.prepare("DELETE FROM events WHERE id = ?"),
      deliveryDelete: db.prepare("DELETE FROM deliveries WHERE event_id = ?"),
      eventTombstone: db.prepare("INSERT OR IGNORE INTO event_tombstones (id, at) VALUES (?, ?)"),
      tombstoned: db.prepare("SELECT 1 AS hit FROM event_tombstones WHERE id = ?"),
      outbox: db.prepare(`INSERT INTO outbox (id, pos, text, attempts, next_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET text = excluded.text, attempts = excluded.attempts, next_at = excluded.next_at`),
      outboxDelete: db.prepare("DELETE FROM outbox WHERE id = ?"),
      restart: db.prepare(`INSERT OR REPLACE INTO lead_restarts (lead, session, events, "offset", phase, strikes, unconfirmed, reason, request, force)
        VALUES ($lead, $session, $events, $offset, $phase, $strikes, $unconfirmed, $reason, $request, $force)`),
      restartDelete: db.prepare("DELETE FROM lead_restarts WHERE lead = ?"),
      leadState: db.prepare(`INSERT OR REPLACE INTO lead_state (lead, ${LEAD_STATE.map(([, column]) => column).join(", ")})
        VALUES ($lead, ${LEAD_STATE.map(([, column]) => `$${column}`).join(", ")})`),
      delivery: db.prepare("INSERT OR IGNORE INTO deliveries (event_id, lead, generation, delivered_at) VALUES (?, ?, 0, ?)"),
      // A take consumed before its delivery row was rewritten (startup recovers the log tail after the takes) stands in as the delivery.
      take: db.prepare(`INSERT INTO deliveries (event_id, lead, generation, delivered_at, taken_at, taken_session) VALUES (?1, ?2, 0, ?3, ?3, ?4)
        ON CONFLICT (event_id) DO UPDATE SET taken_at = coalesce(taken_at, excluded.taken_at), taken_session = coalesce(taken_session, excluded.taken_session)`),
    };
  }

  meta(key: string): string | undefined {
    return (this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  /** A transaction outside save (the import's cursors); `full` syncs before returning. */
  transaction(durability: Durability, body: () => void): void {
    if (this.durability !== durability) {
      this.db.exec(`PRAGMA synchronous = ${durability === "full" ? "FULL" : "NORMAL"}`);
      this.durability = durability;
    }
    this.db.transaction(body)();
    this.unsynced = durability === "normal";
  }

  sync(): void {
    if (!this.unsynced) return;
    // A checkpoint syncs the WAL first, so every normal commit before it survives power loss.
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    this.unsynced = false;
  }

  load(): Journal | undefined {
    const journal = this.read(false);
    this.last = journal;
    this.storedEvents = journal.events.length;
    this.journalMarked = this.meta("journal") !== undefined;
    return this.journalMarked ? journal : undefined;
  }

  /**
   * The stored journal. `raw` gives it as the source file had it: events whose `at` the import synthesized have none.
   * Otherwise those events carry the import time, so a restart does not stamp them again.
   */
  read(raw: boolean): Journal {
    const db = this.db;
    this.synthetic = new Set();
    const events = (db.query("SELECT id, line, at, at_synthetic, meta FROM events ORDER BY seq").all() as Row[]).map((row): JournalEvent => {
      const id = String(row.id);
      if (row.at_synthetic) this.synthetic.add(id);
      const at = num(row.at);
      const meta = json(row.meta) as JournalEvent["meta"];
      return { id, line: String(row.line), ...(at !== undefined && !(raw && row.at_synthetic) ? { at } : {}), ...(meta ? { meta } : {}) };
    });
    const outbox = (db.query("SELECT * FROM outbox ORDER BY pos").all() as Row[]).map((row): OutboxItem => ({
      id: String(row.id), text: String(row.text),
      ...(num(row.attempts) !== undefined ? { attempts: Number(row.attempts) } : {}), ...(num(row.next_at) !== undefined ? { retryAt: Number(row.next_at) } : {}),
    }));
    const restartRow = db.query("SELECT * FROM lead_restarts WHERE lead = ?").get(DEFAULT_LEAD) as Row | null;
    const state = db.query("SELECT * FROM lead_state WHERE lead = ?").get(DEFAULT_LEAD) as Row | null;
    const scalars: Record<string, unknown> = {};
    for (const [field, column] of LEAD_STATE) {
      const value = state?.[column];
      if (value !== null && value !== undefined) scalars[field] = json(value);
    }
    const maxPos = db.query("SELECT max(pos) AS p FROM outbox").get() as { p: number | null };
    this.nextPos = (maxPos.p ?? -1) + 1;
    return {
      events, outbox,
      ...(restartRow ? { restart: restartOf(restartRow) } : {}),
      ...scalars,
    } as Journal;
  }

  save(journal: Journal, durability: Durability): void {
    const prev = this.last;
    if (prev === journal && journal.events.length === this.storedEvents) return;
    const ops: (() => void)[] = [];
    this.diffEvents(prev.events, journal.events, ops);
    this.diffOutbox(prev.outbox ?? [], journal.outbox ?? [], ops);
    if (prev.restart !== journal.restart) {
      const restart = journal.restart;
      ops.push(restart ? () => this.stmt.restart.run(restartRow(restart)) : () => this.stmt.restartDelete.run(DEFAULT_LEAD));
    }
    if (LEAD_STATE.some(([field]) => prev[field] !== journal[field])) {
      const row: Row = { lead: DEFAULT_LEAD };
      for (const [field, column] of LEAD_STATE) {
        const value = journal[field];
        row[column] = value === undefined ? null : JSON.stringify(value);
      }
      ops.push(() => this.stmt.leadState.run(row));
    }
    if (!this.journalMarked) {
      ops.push(() => this.setMeta("journal", "1"));
    }
    if (ops.length) this.transaction(durability, () => { for (const op of ops) op(); });
    // The diff baseline describes committed rows, not an attempted save.
    this.journalMarked = true;
    this.last = journal;
    this.storedEvents = journal.events.length;
  }

  private diffEvents(prev: readonly JournalEvent[], next: readonly JournalEvent[], ops: (() => void)[]): void {
    // `prev` may have grown in place since it was stored: only its first `stored` entries are in the database.
    const stored = this.storedEvents;
    const write = (event: JournalEvent, old: JournalEvent | undefined) => {
      // An event the import stamped keeps its synthetic flag while its time stays the stamped one.
      const synthetic = this.synthetic.has(event.id) && old?.at === event.at;
      ops.push(() => this.stmt.event.run({
        id: event.id, kind: kindOf(event.line), lead: DEFAULT_LEAD, line: event.line, at: event.at ?? null, synthetic: synthetic ? 1 : 0,
        meta: event.meta ? JSON.stringify(event.meta) : null,
      }));
    };
    if (prev === next) {
      // Appended in place: only the tail beyond what is stored is new.
      for (let i = stored; i < next.length; i++) write(next[i] as JournalEvent, undefined);
      return;
    }
    // Pruned (retention): the same event objects in order, some dropped, maybe some appended. One walk, no hashing.
    const removed: JournalEvent[] = [];
    let j = 0;
    for (let i = 0; i < stored; i++) {
      if (j < next.length && prev[i] === next[j]) j++;
      else removed.push(prev[i] as JournalEvent);
    }
    const appended = new Set(next.slice(j).map((event) => event.id));
    if (!removed.some((event) => appended.has(event.id))) {
      for (let k = j; k < next.length; k++) write(next[k] as JournalEvent, undefined);
      for (const event of removed) this.dropEvent(event, ops);
      return;
    }
    // Otherwise (startup mapping) compare by id, so changed events are rewritten and nothing else.
    const before = new Map<string, JournalEvent>();
    for (let i = 0; i < stored; i++) before.set((prev[i] as JournalEvent).id, prev[i] as JournalEvent);
    const keep = new Set<string>();
    for (const event of next) {
      keep.add(event.id);
      const old = before.get(event.id);
      if (old === event || (old && old.line === event.line && old.at === event.at)) continue;
      write(event, old);
    }
    for (const [id, event] of before) if (!keep.has(id)) this.dropEvent(event, ops);
  }

  /** An event that leaves the journal leaves a dedupe tombstone, and its delivery row goes with it. */
  private dropEvent(event: JournalEvent, ops: (() => void)[]): void {
    ops.push(() => { this.stmt.eventDelete.run(event.id); this.stmt.deliveryDelete.run(event.id); this.stmt.eventTombstone.run(event.id, event.at ?? this.now()); });
  }

  private diffOutbox(prev: readonly OutboxItem[], next: readonly OutboxItem[], ops: (() => void)[]): void {
    if (prev === next) return;
    const before = new Map(prev.map((item) => [item.id, item]));
    for (const item of next) {
      if (before.get(item.id) === item) continue;
      ops.push(() => this.stmt.outbox.run(item.id, this.nextPos++, item.text, item.attempts ?? null, item.retryAt ?? null));
    }
    const keep = new Set(next.map((item) => item.id));
    for (const item of prev) if (!keep.has(item.id)) ops.push(() => this.stmt.outboxDelete.run(item.id));
  }

  deliveredIds(): Set<string> {
    return new Set((this.db.query("SELECT event_id FROM deliveries").all() as Row[]).map((row) => String(row.event_id)));
  }

  logCursor(): number { return Number(this.meta("log_offset") ?? 0); }

  tombstoned(id: string): boolean { return this.stmt.tombstoned.get(id) !== null; }

  expireTombstones(cutoff: number): void {
    this.transaction("normal", () => { this.db.query("DELETE FROM event_tombstones WHERE at < ?").run(cutoff); });
  }

  /** The database, for the GitHub poll state that shares it (github-events.ts). */
  get database(): Database { return this.db; }

  recordDeliveries(ids: readonly string[], cursor: number, at: number): void {
    // The log line is already fsynced: a lost row is recovered from the log tail at the next start.
    this.transaction("normal", () => {
      for (const id of ids) this.stmt.delivery.run(id, DEFAULT_LEAD, at);
      this.setMeta("log_offset", String(cursor));
    });
  }

  recordTakes(ids: readonly string[], at: number, session: string): void {
    this.transaction("normal", () => { for (const id of ids) this.stmt.take.run(id, DEFAULT_LEAD, at, session || null); });
  }

  recordWake(wake: Wake): void {
    this.transaction("normal", () => {
      this.db.query("INSERT INTO lead_wakes (lead, at, session, trigger, kinds) VALUES (?, ?, ?, ?, ?)")
        .run(DEFAULT_LEAD, wake.at, wake.session, JSON.stringify(wake.trigger), JSON.stringify(wake.kinds));
    });
  }

  openWake(): Wake | undefined {
    const row = this.db.query("SELECT * FROM lead_wakes WHERE lead = ? ORDER BY seq DESC LIMIT 1").get(DEFAULT_LEAD) as Row | null;
    return row && !row.closed ? wakeOf(row) : undefined;
  }

  closeWake(at: number, calls: number | undefined): void {
    this.transaction("normal", () => {
      this.db.query("UPDATE lead_wakes SET calls = ?, closed = 1 WHERE lead = ? AND at = ? AND closed IS NULL").run(calls ?? null, DEFAULT_LEAD, at);
    });
  }

  pruneWakes(cutoff: number): void {
    this.transaction("normal", () => { this.db.query("DELETE FROM lead_wakes WHERE at < ?").run(cutoff); });
  }

  counts(): Record<string, number> {
    const tables = ["events", "deliveries", "outbox", "lead_restarts", "lead_state",
      "event_tombstones", "gh_repos", "gh_prs", "gh_issues", "gh_cache", "lead_wakes"];
    return Object.fromEntries(tables.map((table) => [table, (this.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]));
  }

  markSynthetic(ids: readonly string[]): void {
    const mark = this.db.prepare("UPDATE events SET at_synthetic = 1 WHERE id = ?");
    this.transaction("normal", () => { for (const id of ids) mark.run(id); });
    for (const id of ids) this.synthetic.add(id);
  }

  close(): void { this.db.close(); }
}

const wakeOf = (row: Row): Wake => ({
  at: Number(row.at), session: String(row.session), trigger: json(row.trigger) as string[], kinds: json(row.kinds) as Record<string, number>,
  ...(row.closed ? { closed: true as const } : {}), ...(num(row.calls) !== undefined ? { calls: Number(row.calls) } : {}),
});

/** Wakes since `since` from this state dir's store on disk, oldest first (read-only; [] when none or unreadable). */
export const readWakes = (stateDir: string, since: number): Wake[] => {
  try {
    const db = new Database(join(stateDir, SQLITE_FILE), { readonly: true });
    try { return (db.query("SELECT * FROM lead_wakes WHERE at >= ? ORDER BY seq").all(since) as Row[]).map(wakeOf); } finally { db.close(); }
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    return [];
  }
};

const restartRow = (restart: Restart): Row => ({
  lead: DEFAULT_LEAD, session: restart.session, events: JSON.stringify(restart.events), offset: restart.offset, phase: restart.phase,
  strikes: restart.strikes ?? null, unconfirmed: restart.unconfirmed ?? null,
  reason: restart.reason ?? null, request: restart.request === undefined ? null : JSON.stringify(restart.request), force: restart.force ? 1 : null,
});

const restartOf = (row: Row): Restart => {
  const value: Record<string, unknown> = {
    session: String(row.session), events: json(row.events), offset: Number(row.offset), phase: String(row.phase),
    strikes: num(row.strikes), unconfirmed: num(row.unconfirmed), reason: str(row.reason),
    request: json(row.request), force: row.force ? true : undefined,
  };
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Restart;
};

/**
 * supervisor.sqlite of `stateDir`, created with its schema when the state dir holds no store at all (a fresh install
 * before the supervisor's first start), as the json store's first write created its file. Never over json files still
 * awaiting their conversion, nor beside an import marker whose database is gone: there the stores stop with STORE_MISSING.
 */
export const storeFile = (stateDir: string): string => {
  const path = join(stateDir, SQLITE_FILE);
  if (!holdsSqlite(stateDir) && !holdsJson(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
    new SqliteStore(path, { create: true }).close();
  }
  return path;
};

/**
 * The supervisor's store, refusing a state dir that still holds a live supervisor.json (its conversion failed or has not
 * run: the store would ignore it) or one whose database is gone after a conversion. */
export const openStore = (stateDir: string, now: () => number = Date.now): JournalStore => {
  const jsonPath = join(stateDir, JOURNAL_FILE);
  const sqlitePath = join(stateDir, SQLITE_FILE);
  if (existsSync(jsonPath)) {
    throw new StoreError(`STORE_IMPORT_PENDING ${jsonPath} exists; its conversion to ${SQLITE_FILE} did not complete (see the STORE_CONVERT_FAILED line of the last config load)`);
  }
  if (!existsSync(sqlitePath) && existsSync(join(stateDir, PRE_SQLITE_FILE))) {
    throw new StoreError(`STORE_MISSING ${sqlitePath} is gone but ${PRE_SQLITE_FILE} shows an import; restore the database before starting`);
  }
  return new SqliteStore(sqlitePath, { create: true, now });
};

/**
 * Read-only views for readers outside the Supervisor (status). Undefined when nothing is stored or it cannot be read.
 */
export const readStoreView = <T>(stateDir: string, view: { readonly sqlite: (db: Database) => T }): T | undefined => {
  try {
    const db = new Database(join(stateDir, SQLITE_FILE), { readonly: true });
    try { return view.sqlite(db); } finally { db.close(); }
  } catch {
    return undefined;
  }
};
