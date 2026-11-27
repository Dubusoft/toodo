// Databases for the storage tests: the schema the Rust migrations create at
// `BASELINE_SCHEMA_VERSION`, from `schema.sql`, which `cargo test --lib` regenerates.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Creates an empty database file at `path`, as a new Rust server would. */
export function createDatabase(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run(SCHEMA);
  } finally {
    db.close();
  }
}

/** A private in-memory database with the baseline schema and foreign keys on. */
export function openMemoryDatabase(): Database {
  const db = new Database(":memory:", { strict: true });
  db.run(SCHEMA);
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
