import { afterEach, describe, expect, it, vi } from "vitest";

/** A fresh copy of the module, since it keeps the build it found. */
async function freshBuild(running: string | null) {
  vi.resetModules();
  document.head.innerHTML = running === null ? "" : `<meta name="toodo-build" content="${running}">`;
  return import("@/web/build");
}

function serve(response: () => Response | Promise<Response>) {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("checkForNewBuild", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
  });

  it("offers the build the server serves when it differs from the running one", async () => {
    const fetch = serve(() => json({ build: "new" }));
    const build = await freshBuild("old");
    const listener = vi.fn();
    build.subscribeNewBuild(listener);

    await build.checkForNewBuild();

    expect(fetch).toHaveBeenCalledWith("/version.json", { cache: "no-store" });
    expect(build.newBuild()).toBe("new");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("offers nothing while the server serves the running build", async () => {
    serve(() => json({ build: "same" }));
    const build = await freshBuild("same");

    await build.checkForNewBuild();

    expect(build.newBuild()).toBeNull();
  });

  it("does not ask outside a built app", async () => {
    const fetch = serve(() => json({ build: "new" }));
    const build = await freshBuild(null);

    await build.checkForNewBuild();

    expect(fetch).not.toHaveBeenCalled();
    expect(build.newBuild()).toBeNull();
  });

  it("ignores a server that answers with the app instead of a build file", async () => {
    serve(() => new Response("<!doctype html><html></html>", { headers: { "Content-Type": "text/html" } }));
    const build = await freshBuild("old");

    await build.checkForNewBuild();

    expect(build.newBuild()).toBeNull();
  });

  it("keeps a dismissed build hidden until the server serves yet another one", async () => {
    let served = "second";
    serve(() => json({ build: served }));
    const build = await freshBuild("first");
    await build.checkForNewBuild();

    build.dismissNewBuild();
    await build.checkForNewBuild();
    expect(build.newBuild()).toBeNull();

    served = "third";
    await build.checkForNewBuild();
    expect(build.newBuild()).toBe("third");
  });
});
