// Task resources and subscriptions to task record changes (`src-tauri/src/mcp/resources.rs`).

import type { TaskId } from "../domain/model.ts";
import { taskId } from "../domain/model.ts";
import type { Storage } from "../storage/storage.ts";
import { sortedPrettyJson } from "./json.ts";
import { taskDetails } from "./tools/queries.ts";

/** How often a listen stream reads its resources again without an announced change, in
 * milliseconds. */
export const POLL_MS = 5_000;

const TASKS = "toodo://tasks/";
const JSON_TYPE = "application/json";

/** The task a resource URI names, or `null` when it names no resource of this server. */
export function parseUri(uri: string): TaskId | null {
  if (!uri.startsWith(TASKS)) return null;
  const id = uri.slice(TASKS.length);
  if (!/^[0-9]+$/.test(id)) return null;
  const parsed = BigInt(id);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? taskId(Number(parsed)) : null;
}

/** The URI templates of the resources. */
export function templates(): object[] {
  return [
    {
      uriTemplate: `${TASKS}{task_id}`,
      name: "task",
      title: "Toodo task",
      description:
        "A task as get_task returns it: status timeline, notes, pull request, commits, and the tasks it depends on (ready and blockedBy), that depend on it, and that are related to it. Subscribe to it to learn when it changes, e.g. when a task it depends on is done.",
      mimeType: JSON_TYPE,
    },
  ];
}

/** A resource as `resources/list` lists it. */
export type Resource = { uri: string; name: string; title: string; mimeType: string };

/** The tasks that are not done, as resources, by task ID. */
export function list(storage: Storage): Resource[] {
  return storage
    .listAllTasks()
    .filter((task) => task.status !== "done")
    .sort((a, b) => a.id - b.id)
    .map((task) => ({ uri: `${TASKS}${task.id}`, name: `task-${task.id}`, title: `#${task.id} ${task.title}`, mimeType: JSON_TYPE }));
}

/** The content of the resource of task `id` as JSON text, its keys sorted as a JSON value
 * of `serde_json` keeps them. */
export function read(storage: Storage, id: TaskId): string {
  return sortedPrettyJson(taskDetails(storage, id));
}

/** Why `uri` names no resource of this server, with the URIs it does serve. */
export function unknown(uri: string): string {
  return `${uri} is not a Toodo resource; read toodo://tasks/{task_id} with a task ID that search_tasks or list_tasks finds`;
}

/** The notifications a `subscriptions/listen` request asks for or a server accepts. */
export type SubscriptionFilter = {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
};

/** What one listen stream watches, and what it last saw of it. */
export class Watch {
  readonly #watched: string[];
  readonly #list: boolean;
  #seen: { contents: Map<string, string | null>; open: string | null };

  /** Starts watching the resources `filter` accepted, as they are now. */
  constructor(storage: Storage, filter: SubscriptionFilter) {
    this.#watched = (filter.resourceSubscriptions ?? []).filter((uri) => parseUri(uri) !== null);
    this.#list = filter.resourcesListChanged === true;
    this.#seen = this.#snapshot(storage);
  }

  /** Reads the watched resources again: the URIs whose content changed since the last read,
   * and whether the list of tasks that are not done changed. */
  next(storage: Storage): { updated: string[]; listChanged: boolean } {
    const next = this.#snapshot(storage);
    const updated = [...next.contents]
      .filter(([uri, content]) => this.#seen.contents.get(uri) !== content)
      .map(([uri]) => uri);
    const listChanged = this.#seen.open !== next.open;
    this.#seen = next;
    return { updated, listChanged };
  }

  #snapshot(storage: Storage): { contents: Map<string, string | null>; open: string | null } {
    const contents = new Map<string, string | null>();
    for (const uri of [...new Set(this.#watched)].sort()) {
      let content: string | null;
      try {
        content = read(storage, parseUri(uri) as TaskId);
      } catch {
        // A task that cannot be read, e.g. one deleted, has no content until it can be again.
        content = null;
      }
      contents.set(uri, content);
    }
    let open: string | null = null;
    if (this.#list) {
      try {
        open = JSON.stringify(list(storage));
      } catch {
        open = "[]";
      }
    }
    return { contents, open };
  }
}
