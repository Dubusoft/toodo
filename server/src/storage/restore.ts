// What restoring a backup needs beyond reading it: the dependency loop check of
// `stageBackup` and the copy of a checked backup over the live data.

import type { Database } from "bun:sqlite";

import { DependencyError, topologicalOrder } from "../domain/dag.ts";
import { type TaskId, taskId } from "../domain/model.ts";
import { LIVE_PREREQUISITE, LIVE_TASK } from "./task-sql.ts";

/**
 * A loop among the dependencies of live tasks, as the task ids along it with the first
 * repeated at the end (see `topologicalOrder`), or `null`. Edges to archived tasks do not
 * count: they come back only through a restore of those tasks, which checks them then.
 */
export function liveCycle(db: Database): readonly TaskId[] | null {
  const tasks = new Map(
    db
      .query<{ id: number }, []>(`SELECT t.id FROM tasks t WHERE ${LIVE_TASK}`)
      .all()
      .map((row) => [taskId(row.id), new Set<TaskId>()]),
  );
  const edges = db
    .query<{ task_id: number; depends_on_id: number }, []>(
      `SELECT d.task_id, d.depends_on_id
       FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
       WHERE ${LIVE_TASK} AND ${LIVE_PREREQUISITE}`,
    )
    .all();
  for (const edge of edges) {
    tasks.get(taskId(edge.task_id))?.add(taskId(edge.depends_on_id));
  }
  try {
    topologicalOrder([...tasks].map(([id, dependsOn]) => ({ id, dependsOn })));
    return null;
  } catch (error) {
    if (error instanceof DependencyError && error.problem.kind === "cycle") {
      return error.problem.path;
    }
    throw error;
  }
}

/**
 * Replaces every row of `db` with the rows of the database file at `source`, which has the
 * same schema, in one transaction: tables, then the AUTOINCREMENT counters. The search
 * indexes follow through their triggers. Foreign keys are checked when it commits.
 */
export function copyDatabase(source: string, db: Database): void {
  db.run("ATTACH DATABASE ? AS staged", [source]);
  try {
    db.transaction(() => {
      db.run("PRAGMA defer_foreign_keys = ON");
      const tables = db
        .query<{ name: string }, []>(
          `SELECT name FROM pragma_table_list
           WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all()
        .map((row) => row.name);
      for (const table of tables) {
        db.run(`DELETE FROM main."${table}"`);
      }
      for (const table of tables) {
        const columns = db
          .query<{ name: string }, [string]>(
            "SELECT name FROM pragma_table_xinfo(?, 'main') WHERE hidden = 0 ORDER BY cid",
          )
          .all(table)
          .map((row) => `"${row.name}"`)
          .join(", ");
        db.run(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM staged."${table}"`);
      }
      db.run("DELETE FROM main.sqlite_sequence");
      db.run("INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM staged.sqlite_sequence");
    })();
  } finally {
    db.run("DETACH DATABASE staged");
  }
}
