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

/** Stands in for the page's reload, which jsdom does not do. */
function stubReload() {
  const reload = vi.fn();
  vi.stubGlobal("location", { ...location, reload });
  return reload;
}

// What `redirect: "manual"` gives for Cloudflare Access sending the browser to sign in.
const signIn = () => ({ type: "opaqueredirect", status: 0, headers: new Headers(), body: null }) as Response;

describe("reachability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the server unreachable until a later probe gets an answer", async () => {
    const connection = await freshConnection();
    const reload = stubReload();
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
    // An outage keeps what was loaded on screen; only a proxy's sign-in reloads.
    expect(reload).not.toHaveBeenCalled();
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
    let answer = () => json({ kind: "external", code: "external", message: "gh failed" }, 502);
    serve(() => answer(), () => html(530));

    await connection.serverFetch("/api/rpc/open_pull_request");
    expect(connection.reachability()).toBe("reachable");

    answer = () => html(502);
    await connection.serverFetch("/api/rpc/open_pull_request");
    await vi.waitFor(() => expect(connection.reachability()).toBe("unreachable"));
  });

  it("tells a proxy that wants a new sign-in from an outage", async () => {
    const connection = await freshConnection();
    stubReload();
    let answer: () => Response = signIn;
    serve(down, () => answer());

    await expect(connection.serverFetch("/api/rpc/list_tasks")).rejects.toThrow(TypeError);
    await vi.waitFor(() => expect(connection.reachability()).toBe("unreachable"));
    expect(connection.signInExpired()).toBe(true);

    answer = down;
    await vi.advanceTimersByTimeAsync(2000);
    expect(connection.signInExpired()).toBe(false);
  });

  it("reloads to the proxy's sign-in once, not again while a reload brought none", async () => {
    const connection = await freshConnection();
    const reload = stubReload();
    serve(down, signIn);

    await expect(connection.serverFetch("/api/rpc/list_tasks")).rejects.toThrow(TypeError);
    await vi.waitFor(() => expect(connection.reachability()).toBe("unreachable"));
    expect(reload).toHaveBeenCalledOnce();

    // The reload came back to the app without a sign-in: the same tab, a fresh module.
    const reloaded = await freshConnection();
    await expect(reloaded.serverFetch("/api/rpc/list_tasks")).rejects.toThrow(TypeError);
    await vi.waitFor(() => expect(reloaded.reachability()).toBe("unreachable"));
    await vi.advanceTimersByTimeAsync(2000 + 4000);
    expect(reloaded.signInExpired()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();

    // Long after, a sign-in that ran out again reloads again.
    // The probe repeats at most every 30 s.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(reload).toHaveBeenCalledTimes(2);
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
