// Merging another Toodo database into this one. Port of `src-tauri/src/storage/import.rs`.
//
// Workspaces and tasks with their history are added next to the data already here.
// Imported rows get IDs after every ID this database has used, so nothing here changes;
// references between imported rows move along. Devices, push subscriptions, connected
// OAuth apps, settings, saved reviews, and the chat of the other database are not
// imported: they belong to the server that kept them.

import type { Database } from "bun:sqlite";

import type { StagedBackup } from "./backup.ts";
import { StorageError } from "./errors.ts";

/** What `importBackup` added. */
export interface ImportSummary {
  workspaces: number;
  tasks: number;
  /** Task #N of the imported database is task #(N + offset) here. */
  taskIdOffset: number;
}

const SOURCE = "import_source";

/**
 * How a column of an imported table gets its value: the expression to select, in which
 * `{w}` and `{t}` are the workspace and task ID offsets, or `null` to leave it to its
 * default (a new row ID, for example).
 */
type Columns = Record<string, string | null>;

/** The imported tables in the order they are inserted, with the columns not copied as they are. */
export const IMPORTED_TABLES: readonly (readonly [string, Columns])[] = [
  ["workspaces", { id: "id + {w}" }],
  ["workspace_guidelines", { id: null, workspace_id: "workspace_id + {w}" }],
  ["tasks", { id: "id + {t}", workspace_id: "workspace_id + {w}" }],
  ["task_dependencies", { task_id: "task_id + {t}", depends_on_id: "depends_on_id + {t}" }],
  ["commit_records", { task_id: "task_id + {t}" }],
  ["pull_request_snapshots", { task_id: "task_id + {t}" }],
  ["task_activity", { id: null, task_id: "task_id + {t}" }],
  [
    "task_events",
    {
      id: null,
      task_id: "task_id + {t}",
      // What only the lead of the other server used.
      for_lead: "0",
      taken_at: "NULL",
      request_id: "NULL",
      report_id: "NULL",
    },
  ],
  ["task_notes", { id: null, task_id: "task_id + {t}" }],
  ["task_relations", { task_id: "task_id + {t}", related_id: "related_id + {t}" }],
  ["task_criteria", { id: null, task_id: "task_id + {t}" }],
  ["task_labels", { task_id: "task_id + {t}" }],
];

/**
 * Tables that are deliberately left out, see the module comment. `task_search` is filled
 * by the triggers on the imported tables.
 */
export const SKIPPED_TABLES: readonly string[] = [
  "devices",
  "push_subscriptions",
  "oauth_clients",
  "oauth_grants",
  "oauth_tokens",
  "chat_messages",
  "chat_channels",
  "chat_threads",
  "chat_actions",
  "chat_choices",
  "chat_attachments",
  "chat_search",
  "task_results",
  "task_search",
  "settings",
  "review_snapshots",
  // Adoptions only drive the ready announcements of the server that recorded them.
  "task_adoptions",
];

/** Adds the workspaces and tasks of `staged` to `db` in one transaction. */
export function importBackup(db: Database, staged: StagedBackup): ImportSummary {
  return staged.attachTo(db, SOURCE, () => db.transaction(() => merge(db))());
}

function merge(db: Database): ImportSummary {
  // Imported rows may refer to rows imported after them, e.g. a task merged with a later
  // one; the references are checked once everything is in.
  db.run("PRAGMA defer_foreign_keys = ON");
  const w = offset(db, "workspaces");
  const t = offset(db, "tasks");
  const count = (table: string) =>
    db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${SOURCE}.${table}`).get()?.n ?? 0;
  const summary = { workspaces: count("workspaces"), tasks: count("tasks"), taskIdOffset: t };
  for (const [table, columns] of IMPORTED_TABLES) {
    const all = db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((row) => row.name);
    // Rows without an ID of their own get new ones in their original order.
    const order = all.includes("id") ? " ORDER BY id" : "";
    const names: string[] = [];
    const values: string[] = [];
    for (const name of all) {
      const value = name in columns ? columns[name] : name;
      if (value === null || value === undefined) {
        continue;
      }
      names.push(name);
      values.push(value.replaceAll("{w}", String(w)).replaceAll("{t}", String(t)));
    }
    db.run(
      `INSERT INTO main.${table} (${names.join(", ")}) SELECT ${values.join(", ")} FROM ${SOURCE}.${table}${order}`,
    );
  }
  moveTaskRefs(db, t);
  return summary;
}

/**
 * References of the form `task:<id>`, such as the one a shipped-with conclusion writes,
 * name tasks of the imported database, so they move along with the task IDs. One whose
 * task is not in that database is dropped: its number would name an unrelated task here.
 * Every other reference is kept as it is.
 */
function moveTaskRefs(db: Database, t: number): void {
  const imported = new Set(
    db.query<{ id: number }, []>(`SELECT id FROM ${SOURCE}.tasks`).all().map((row) => row.id),
  );
  const rows = db
    .query<{ id: number; refs: string }, []>(
      `SELECT id, refs FROM ${SOURCE}.tasks WHERE refs LIKE '%"task:%'`,
    )
    .all();
  for (const { id, refs: json } of rows) {
    const refs = parseRefs(json);
    if (refs === null) {
      throw new StorageError({
        kind: "invalid_data",
        reason: `imported task ${id} has refs that are not a JSON array of strings: ${json}`,
      });
    }
    const moved = refs.flatMap((reference) => {
      const task = taskRef(reference);
      if (task === null) {
        return [reference];
      }
      return imported.has(task) ? [`task:${task + t}`] : [];
    });
    if (moved.length !== refs.length || moved.some((reference, index) => reference !== refs[index])) {
      db.run("UPDATE main.tasks SET refs = ?2 WHERE id = ?1", [id + t, JSON.stringify(moved)]);
    }
  }
}

function parseRefs(json: string): string[] | null {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
  } catch {
    return null;
  }
}

/** The task ID of a `task:<id>` reference. */
function taskRef(reference: string): number | null {
  const match = /^task:(\d+)$/.exec(reference);
  const id = Number(match?.[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The offset that puts imported IDs of `table` after every ID it ever used, including
 * those of deleted rows, which AUTOINCREMENT never hands out again.
 */
function offset(db: Database, table: string): number {
  return (
    db
      .query<{ offset: number }, []>(
        `SELECT max(
           coalesce((SELECT seq FROM main.sqlite_sequence WHERE name = '${table}'), 0),
           coalesce((SELECT max(id) FROM main.${table}), 0)) AS offset`,
      )
      .get()?.offset ?? 0
  );
}
