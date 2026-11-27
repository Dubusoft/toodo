import type { Database } from "bun:sqlite";
import { taskId } from "../domain/model.ts";
import type { TaskId, WorkspaceId } from "../domain/model.ts";
import { charCount, isWhitespace } from "../domain/rust.ts";
import type { TaskStatus } from "../domain/status.ts";
import { StorageError } from "./errors.ts";
import type { Storage } from "./storage.ts";
import { LIVE_TASK } from "./task-sql.ts";

export type TaskSearch = {
  readonly query: string;
  readonly workspace: WorkspaceId | null;
  readonly status: TaskStatus | null;
  readonly limit: number;
};

const TRIGRAM = 3;
const BM25_WEIGHTS = "10.0, 2.0, 1.0, 5.0, 5.0";
const SEARCHED_TEXT = `(task_search.title || char(10) || task_search.description
  || char(10) || task_search.notes || char(10) || task_search.branch || char(10)
  || task_search.pull_request)`;

function splitWhitespace(text: string): string[] {
  const words: string[] = [];
  let word = "";
  for (const char of text) {
    if (isWhitespace(char)) {
      if (word !== "") words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (word !== "") words.push(word);
  return words;
}

export function ftsString(word: string): string {
  return `"${word.replaceAll('"', '""')}"`;
}

export function likePattern(word: string): string {
  return `%${word.replaceAll(/[%_\\]/gu, "\\$&")}%`;
}

export function searchTasks(storage: Storage, search: TaskSearch): TaskId[] {
  const indexed: string[] = [];
  const short: string[] = [];
  for (const word of splitWhitespace(search.query)) {
    (charCount(word) >= TRIGRAM ? indexed : short).push(word);
  }
  const [firstShort] = short;
  if (indexed.length === 0 && firstShort === undefined) return [];

  const conditions = [LIVE_TASK];
  const parameters: (number | string)[] = [];
  if (indexed.length > 0) {
    conditions.push("task_search MATCH ?");
    parameters.push(indexed.map(ftsString).join(" "));
  }
  for (const word of short) {
    conditions.push(`${SEARCHED_TEXT} LIKE ? ESCAPE '\\'`);
    parameters.push(likePattern(word));
  }
  if (search.workspace !== null) {
    conditions.push("t.workspace_id = ?");
    parameters.push(search.workspace);
  }
  if (search.status !== null) {
    conditions.push("t.status = ?");
    parameters.push(search.status);
  }
  let order: string;
  if (indexed.length === 0 && firstShort !== undefined) {
    parameters.push(likePattern(firstShort));
    order = "task_search.title LIKE ? ESCAPE '\\' DESC, t.id DESC";
  } else {
    order = `bm25(task_search, ${BM25_WEIGHTS}), t.id DESC`;
  }
  parameters.push(search.limit);
  return storage.db.query<{ readonly id: number }, (number | string)[]>(`
    SELECT t.id FROM task_search JOIN tasks t ON t.id = task_search.rowid
    WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ?
  `).all(...parameters).map(({ id }) => taskId(id));
}

function requireTask(db: Database, id: TaskId): void {
  if (db.query("SELECT 1 FROM tasks WHERE id = ?1").get(id) === null) {
    throw new StorageError({ kind: "task_not_found", task: id });
  }
}

export function linkRelated(db: Database, task: TaskId, related: TaskId): void {
  if (task === related) throw new StorageError({ kind: "self_relation", task });
  requireTask(db, task);
  requireTask(db, related);
  db.run("INSERT OR IGNORE INTO task_relations (task_id, related_id) VALUES (?1, ?2)",
    [Math.min(task, related), Math.max(task, related)]);
}

export function addRelated(storage: Storage, task: TaskId, related: TaskId): void {
  storage.transaction(() => linkRelated(storage.db, task, related), "deferred");
}

export function removeRelated(storage: Storage, task: TaskId, related: TaskId): void {
  storage.transaction(() => {
    requireTask(storage.db, task);
    const { changes } = storage.db.run("DELETE FROM task_relations WHERE task_id = ?1 AND related_id = ?2",
      [Math.min(task, related), Math.max(task, related)]);
    if (changes === 0) throw new StorageError({ kind: "relation_not_found", task, related });
  }, "deferred");
}

export function listRelations(storage: Storage): [TaskId, TaskId][] {
  return storage.db.query<{ readonly task_id: number; readonly related_id: number }, []>(`
    SELECT r.task_id, r.related_id FROM task_relations r
    WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = r.task_id AND ${LIVE_TASK})
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = r.related_id AND ${LIVE_TASK})
    ORDER BY r.task_id, r.related_id
  `).all().map(({ task_id, related_id }) => [taskId(task_id), taskId(related_id)]);
}
