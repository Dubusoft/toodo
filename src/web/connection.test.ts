import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fresh copy of the module, since it remembers whether the server answers. */
async function freshConnection() {
  vi.resetModules();
  return import("@/web/connection");
}

function html(status: number): Response {
  return new Response("<h1>Bad gateway</h1>", { status, headers: { "Content-Type": "text/html" } });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function serve(request: () => Response, probe: () => Response) {
  const fetch = vi.fn(async (path: string) => (path === "/api" ? probe() : request()));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const down = () => {
  throw new TypeError("Failed to fetch");
};

describe("reachability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the server unreachable until a later probe gets an answer", async () => {
    const connection = await freshConnection();
    let answer: () => Response = down;
    serve(down, () => answer());
    const reachable = vi.fn();
    connection.onReachable(reachable);

    await expect(connection.serverFetch("/api/rpc/list_tasks")).rejects.toThrow(TypeError);
    await vi.waitFor(() => expect(connection.reachability()).toBe("unreachable"));

    answer = () => new Response(null, { status: 401 });
    await vi.advanceTimersByTimeAsync(2000);

    expect(connection.reachability()).toBe("reachable");
    expect(reachable).toHaveBeenCalledOnce();
  });

  it("never shows a blip that the probe answers as an outage", async () => {
    const connection = await freshConnection();
    serve(down, () => new Response(null, { status: 401 }));
    const states: string[] = [];
    connection.subscribeReachability(() => states.push(connection.reachability()));

    await expect(connection.serverFetch("/api/rpc/list_tasks")).rejects.toThrow(TypeError);
    await vi.waitFor(() => expect(connection.reachability()).toBe("reachable"));

    expect(states).toEqual(["checking", "reachable"]);
  });

  it("tells a proxy's error page from the server's own command errors", async () => {
    const connection = await freshConnection();
    let answer = () => json({ kind: "external", message: "gh failed" }, 502);
    serve(() => answer(), () => html(530));

    await connection.serverFetch("/api/rpc/open_pull_request");
    expect(connection.reachability()).toBe("reachable");

    answer = () => html(502);
    await connection.serverFetch("/api/rpc/open_pull_request");
    await vi.waitFor(() => expect(connection.reachability()).toBe("unreachable"));
  });

  it("probes at once when asked to try again", async () => {
    const connection = await freshConnection();
    let answer: () => Response = down;
    const fetch = serve(down, () => answer());
    await expect(connection.serverFetch("/api/events")).rejects.toThrow(TypeError);
    await vi.waitFor(() => expect(connection.reachability()).toBe("unreachable"));
    const probes = () => fetch.mock.calls.filter(([path]) => path === "/api").length;
    expect(probes()).toBe(1);

    answer = () => new Response(null, { status: 404 });
    connection.retryNow();
    await vi.waitFor(() => expect(connection.reachability()).toBe("reachable"));

    expect(probes()).toBe(2);
  });

  it("leaves aborted requests out", async () => {
    const connection = await freshConnection();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );

    await expect(connection.serverFetch("/api/events")).rejects.toThrow("aborted");

    expect(connection.reachability()).toBe("reachable");
  });
});
