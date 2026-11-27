// Database files: consistent read-only copies of a live database, and a dump of everything in
// one in the shape of sqlite3's `.dump` (schema, then every row as an INSERT), ordered so two
// databases with the same content dump the same.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Copies the database at `source` to `target` without writing to `source`: it is opened
 * read-only and copied with `VACUUM INTO`, which reads one consistent snapshot even while
 * a server writes to it.
 */
export function copyDatabase(source: string, target: string) {
  if (!existsSync(source)) throw new Error(`no database at ${source}`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}

/**
 * Removes what would make a copy reach outside: its push subscriptions are real devices,
 * which a server on the copy would notify.
 */
export function isolateCopy(path: string) {
  const db = new DatabaseSync(path);
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'push_subscriptions'").get();
    if (hasTable) db.exec("DELETE FROM push_subscriptions");
  } finally {
    db.close();
  }
}

export function userVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
}

/** The rows of `PRAGMA integrity_check`: `["ok"]` for a sound database. */
export function integrityCheck(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("PRAGMA integrity_check").all().map((row) => String(Object.values(row)[0]));
  } finally {
    db.close();
  }
}

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string };

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Every schema entry and row of the database as SQL text, like sqlite3's `.dump`. Rows are
 * in rowid order (primary key order for a table without rowid). The internal tables of a
 * full-text index are left out and the index's own rows dumped instead: their pages depend
 * on how SQLite merged segments, not on what the index holds.
 */
export function dumpDatabase(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type = 'table' DESC, name")
      .all() as SchemaRow[];
    const virtual = schema.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql)).map((row) => row.name);
    const shadow = (name: string) => virtual.some((table) => name.startsWith(`${table}_`));
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const lines = [`PRAGMA user_version = ${version};`];
    for (const entry of schema) {
      if (shadow(entry.name)) continue;
      lines.push(`${entry.sql};`);
    }
    const tables = schema.filter((row) => row.type === "table" && !shadow(row.name)).map((row) => row.name);
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get()) tables.push("sqlite_sequence");
    for (const table of tables) {
      const columns = (db.prepare(`SELECT name, pk FROM pragma_table_info(?)`).all(table) as Array<{ name: string; pk: number }>);
      const isVirtual = virtual.includes(table);
      const withoutRowid = schema.some((row) => row.name === table && /WITHOUT\s+ROWID/i.test(row.sql));
      const keyColumns = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      const order = table === "sqlite_sequence"
        ? "name"
        : withoutRowid
          ? keyColumns.map((c) => quoteIdent(c.name)).join(", ")
          : "rowid";
      const values = (isVirtual ? ["rowid", ...columns.map((c) => quoteIdent(c.name))] : columns.map((c) => quoteIdent(c.name)))
        .map((column) => `quote(${column})`)
        .join(" || ',' || ");
      const rows = db.prepare(`SELECT ${values} AS row FROM ${quoteIdent(table)} ORDER BY ${order}`).all() as Array<{ row: string }>;
      for (const { row } of rows) lines.push(`INSERT INTO ${quoteIdent(table)} VALUES(${row});`);
    }
    return lines;
  } finally {
    db.close();
  }
}
