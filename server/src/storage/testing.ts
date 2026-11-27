// Databases for the storage tests: new databases with the current schema, whose `general`
// chat channel is created at time 0.

import { Database } from "bun:sqlite";

import { createDatabase as createDatabaseAt, initializeSchema } from "./database.ts";

/** Creates a database file at `path` with no data of its own, as a new server would. */
export function createDatabase(path: string): void {
  createDatabaseAt(path, 0);
}

/** A private in-memory database with the current schema and foreign keys on. */
export function openMemoryDatabase(): Database {
  const db = new Database(":memory:", { strict: true });
  initializeSchema(db, 0);
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
