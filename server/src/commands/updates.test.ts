import { describe, expect, test } from "bun:test";

import { channelOf, checkUpdate, compareVersions, fromDistTags } from "./updates.ts";

describe("update check", () => {
  test("prereleases follow dev and releases latest", () => {
    expect(channelOf("1.3.2-dev.9")).toBe("dev");
    expect(channelOf("1.3.1")).toBe("latest");
  });

  test("versions compare by semver precedence", () => {
    expect(compareVersions("1.3.2-dev.1", "1.3.2-dev.8")).toBe(-1);
    expect(compareVersions("1.3.2-dev.11", "1.3.2-dev.9")).toBe(1);
    expect(compareVersions("1.3.2", "1.3.2-dev.11")).toBe(1);
    expect(compareVersions("1.3.1", "1.3.2-dev.1")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.3.1+b", "1.3.1")).toBe(0);
    expect(compareVersions("next", "1.3.1")).toBeNull();
  });

  test("the channel of the running version decides what is newer", () => {
    const tags = { latest: "1.3.2", dev: "1.3.3-dev.70" };
    const dev = fromDistTags("1.3.3-dev.9", tags);
    expect(dev.channel).toBe("dev");
    expect(dev.latest).toBe("1.3.3-dev.70");
    expect(dev.newer).toBe(true);
    expect(dev.error).toBeNull();
    const release = fromDistTags("1.3.2", tags);
    expect(release.latest).toBe("1.3.2");
    expect(release.newer).toBe(false);
    expect(fromDistTags("1.4.0", tags).newer).toBe(false);
  });

  test("a missing channel is an error with a next step", () => {
    const check = fromDistTags("1.3.3-dev.9", { latest: "1.3.2" });
    expect(check.latest).toBeNull();
    expect(check.newer).toBe(false);
    expect(check.error).toContain("toodo update --check");
  });

  test("the registry's dist-tags of the package decide, and a closed registry is an error", async () => {
    const registry = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => new URL(request.url).pathname === "/-/package/@dubusoft/toodo/dist-tags"
        ? Response.json({ latest: "1.12.0", dev: "1.12.1-dev.3" })
        : new Response("missing", { status: 404 }),
    });
    const url = `http://127.0.0.1:${registry.port}`;
    try {
      expect(await checkUpdate("1.11.0", `${url}/`)).toEqual({
        current: "1.11.0", channel: "latest", latest: "1.12.0", newer: true, error: null,
      });
      expect((await checkUpdate("1.11.0", `${url}/nested`)).error).toBe(
        `cannot reach the npm registry ${url}/nested: GET ${url}/nested/-/package/@dubusoft/toodo/dist-tags answered 404 Not Found; check the server's network, or check for updates on the server with: toodo update --check`,
      );
    } finally {
      await registry.stop(true);
    }
    const closed = await checkUpdate("1.11.0", url);
    expect(closed.latest).toBeNull();
    expect(closed.error).toBe(
      `cannot reach the npm registry ${url}: error sending request for url (${url}/-/package/@dubusoft/toodo/dist-tags); check the server's network, or check for updates on the server with: toodo update --check`,
    );
  });
});
