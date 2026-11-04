/**
 * Keeps what the app loaded readable while `toodo-server` does not answer: the task list and
 * what task details show are saved in IndexedDB as they load, and put back into the query
 * cache when the app starts, so an app started offline (see the service worker in
 * `vite-pwa.ts`) shows them too. Queries wait while the server is unreachable instead of
 * failing, so loaded data stays on screen; the offline banner tells it may be out of date
 * (see `src/components/offline-screen.tsx`).
 */
import { dehydrate, hydrate, onlineManager, type DehydratedState, type Query, type QueryClient } from "@tanstack/react-query";
import { version } from "../../package.json";
import { reachability, subscribeReachability } from "@/web/connection";
import { activeServer } from "@/web/server";
import { getToken, subscribeToken } from "@/web/session";

/** The first part of the keys of kept queries: workspaces, tasks, and task details (see `queryKeys`). */
const KEPT_QUERIES = ["workspaces", "task-list", "tasks", "agent-statuses", "pull-request-statuses"];

/** How long a kept query nobody shows stays in memory, so the next save still has it. */
const KEPT_GC_MS = 24 * 60 * 60 * 1000;

/** How long after a query loads the snapshot is saved, so a burst of loads saves once. */
const SAVE_DELAY_MS = 1000;

/** What is saved: the kept queries, from the build of `version`. */
export type Snapshot = { version: string; savedAt: number; state: DehydratedState };

/** Where the snapshot is saved; IndexedDB in the browser. */
export interface SnapshotStore {
  load(): Promise<unknown>;
  save(snapshot: Snapshot): Promise<void>;
  clear(): Promise<void>;
}

function isKept(query: Query): boolean {
  return query.state.status === "success" && KEPT_QUERIES.includes(String(query.queryKey[0]));
}

function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === "object" && value !== null && (value as Snapshot).version === version;
}

/**
 * Lets queries run only while the server answers. While it does not, they wait and keep
 * their data, and they run again once it answers. Mutations do not wait (`networkMode`
 * `always` in `main.tsx`): a change is never sent later on its own.
 */
export function pauseQueriesWhileUnreachable(): void {
  onlineManager.setEventListener((setOnline) => {
    const update = () => setOnline(reachability() === "reachable");
    update();
    const unsubscribe = subscribeReachability(update);
    return () => void unsubscribe();
  });
}

/**
 * Puts the saved queries back into `client`. A snapshot of another build is ignored, since
 * the shape of the data may have changed; without an access token there is nothing to show.
 */
export async function restoreQueries(client: QueryClient, store: SnapshotStore): Promise<void> {
  for (const key of KEPT_QUERIES) {
    client.setQueryDefaults([key], { gcTime: KEPT_GC_MS });
  }
  if (getToken() === null) return;
  try {
    const snapshot = await store.load();
    if (isSnapshot(snapshot)) {
      hydrate(client, snapshot.state);
    }
  } catch (error) {
    console.error("Toodo: could not restore the saved tasks", error);
  }
}

/**
 * Saves the kept queries of `client` whenever one loads, and forgets them when the access
 * token is forgotten, so a signed-out browser keeps no task data.
 */
export function saveQueries(client: QueryClient, store: SnapshotStore, delayMs = SAVE_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    if (getToken() === null) return;
    const state = dehydrate(client, { shouldDehydrateQuery: isKept, shouldDehydrateMutation: () => false });
    store.save({ version, savedAt: Date.now(), state }).catch((error: unknown) => {
      console.error("Toodo: could not save the tasks for offline reading", error);
    });
  };
  const unsubscribeCache = client.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "success" && isKept(event.query)) {
      timer ??= setTimeout(save, delayMs);
    }
  });
  const unsubscribeToken = subscribeToken(() => {
    if (getToken() !== null) return;
    clearTimeout(timer);
    timer = undefined;
    store.clear().catch((error: unknown) => console.error("Toodo: could not forget the saved tasks", error));
  });
  return () => {
    clearTimeout(timer);
    unsubscribeCache();
    unsubscribeToken();
  };
}

const DATABASE = "toodo";
const STORE = "query-cache";

function request<T>(open: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const pending = open(database.transaction(STORE, mode).objectStore(STORE));
      pending.onsuccess = () => {
        database.close();
        resolve(pending.result);
      };
      pending.onerror = () => {
        database.close();
        reject(pending.error);
      };
    };
  });
}

/** The snapshot of the active server in this browser's IndexedDB. */
export function indexedDbStore(): SnapshotStore {
  const key = activeServer.key("queries");
  return {
    load: () => request((store) => store.get(key), "readonly"),
    save: (snapshot) => request((store) => store.put(snapshot, key), "readwrite").then(() => undefined),
    clear: () => request((store) => store.delete(key), "readwrite"),
  };
}
