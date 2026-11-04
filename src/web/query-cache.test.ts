import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../../package.json";
import type { Snapshot, SnapshotStore } from "@/web/query-cache";

/** Fresh copies of the modules, since they remember the token and whether the server answers. */
async function fresh() {
  vi.resetModules();
  const [cache, session, connection] = await Promise.all([
    import("@/web/query-cache"),
    import("@/web/session"),
    import("@/web/connection"),
  ]);
  return { ...cache, ...session, ...connection };
}

function memoryStore(initial?: unknown) {
  let saved: unknown = initial;
  const store: SnapshotStore = {
    load: async () => saved,
    save: async (snapshot) => {
      saved = snapshot;
    },
    clear: async () => {
      saved = undefined;
    },
  };
  return { store, saved: () => saved as Snapshot | undefined };
}

describe("query cache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves the task list and details, and restores them in the next app", async () => {
    const { restoreQueries, saveQueries, setToken } = await fresh();
    setToken("device-token");
    const { store, saved } = memoryStore();
    const first = new QueryClient();
    const stop = saveQueries(first, store, 0);

    first.setQueryData(["task-list"], [{ id: 1, title: "Plan" }]);
    first.setQueryData(["tasks", 1, "commit-records"], [{ sha: "abc" }]);
    first.setQueryData(["run-log", 7], { lines: ["large"] });
    await vi.waitFor(() => expect(saved()).toBeDefined());
    stop();

    const next = new QueryClient();
    await restoreQueries(next, store);
    expect(next.getQueryData(["task-list"])).toEqual([{ id: 1, title: "Plan" }]);
    expect(next.getQueryData(["tasks", 1, "commit-records"])).toEqual([{ sha: "abc" }]);
    expect(next.getQueryData(["run-log", 7])).toBeUndefined();
  });

  it("ignores a snapshot of another build", async () => {
    const { restoreQueries, setToken } = await fresh();
    setToken("device-token");
    const old = new QueryClient();
    old.setQueryData(["task-list"], [{ id: 1 }]);
    const { dehydrate } = await import("@tanstack/react-query");
    const { store } = memoryStore({ version: `${version}-old`, savedAt: 0, state: dehydrate(old) });

    const next = new QueryClient();
    await restoreQueries(next, store);
    expect(next.getQueryData(["task-list"])).toBeUndefined();
  });

  it("forgets the saved tasks with the access token", async () => {
    const { forgetToken, saveQueries, setToken } = await fresh();
    setToken("device-token");
    const { store, saved } = memoryStore();
    const client = new QueryClient();
    const stop = saveQueries(client, store, 0);
    client.setQueryData(["task-list"], [{ id: 1 }]);
    await vi.waitFor(() => expect(saved()).toBeDefined());

    forgetToken();
    await vi.waitFor(() => expect(saved()).toBeUndefined());
    stop();
  });

  it("keeps loaded data while the server is unreachable and loads again once it answers", async () => {
    const { pauseQueriesWhileUnreachable, retryNow, serverFetch } = await fresh();
    let up = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!up) throw new TypeError("Failed to fetch");
        return new Response(null, { status: 401 });
      }),
    );
    pauseQueriesWhileUnreachable();
    const client = new QueryClient();
    client.mount();
    let answer = "fresh";
    const queryFn = vi.fn(async () => {
      await serverFetch("/api/rpc/list_tasks");
      return answer;
    });
    client.setQueryData(["task-list"], "cached");
    const observer = new QueryObserver(client, { queryKey: ["task-list"], queryFn, retry: 3, retryDelay: 0 });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe("paused"));
    expect(observer.getCurrentResult()).toMatchObject({ status: "success", data: "cached" });

    up = true;
    answer = "loaded again";
    retryNow();
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe("loaded again"));
    unsubscribe();
    client.unmount();
  });
});
