// Databases for the storage tests: the schema the Rust migrations create at
// `BASELINE_SCHEMA_VERSION`, from `schema.sql`, which `cargo test --lib` regenerates.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/**
 * The rows the Rust migrations add to a new database: the `general` chat channel of
 * version 25, which there carries the time it was migrated at.
 */
const SEED = "INSERT INTO chat_channels (id, name, read_id, created_at) VALUES (1, 'general', 0, 0)";

/** Creates a database file at `path` with no data of its own, as a new Rust server would. */
export function createDatabase(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run(SCHEMA);
    db.run(SEED);
  } finally {
    db.close();
  }
}

/** A private in-memory database with the baseline schema and foreign keys on. */
export function openMemoryDatabase(): Database {
  const db = new Database(":memory:", { strict: true });
  db.run(SCHEMA);
  db.run(SEED);
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

export function insertWorkspace(db: Database, name: string): number {
  return Number(db.run("INSERT INTO workspaces (name) VALUES (?)", [name]).lastInsertRowid);
}

export function insertTask(db: Database, workspaceId: number, title: string): number {
  return Number(
    db.run(
      "INSERT INTO tasks (workspace_id, type, title, status) VALUES (?, 'feat', ?, 'planned')",
      [workspaceId, title],
    ).lastInsertRowid,
  );
}
