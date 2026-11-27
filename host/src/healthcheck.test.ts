import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doriMaxAge, gatewayProbe, httpProbe, parsePingFile, type Probe, sendPing, startHealthcheck } from "./healthcheck.ts";

type Ping = { readonly path: string; readonly body: string };

/** A stand-in for healthchecks.io: records every ping and answers with the next status of `statuses`, then 200. */
const pingServer = (statuses: number[] = []) => {
  const pings: Ping[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      pings.push({ path: new URL(request.url).pathname, body: await request.text() });
      return new Response("OK", { status: statuses.shift() ?? 200 });
    },
  });
  return { pings, url: (path: string) => `http://127.0.0.1:${server.port}${path}`, stop: () => server.stop(true) };
};

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixed = (verdict: string | null): Probe => async () => verdict;

describe("ping file", () => {
  test("reads both URLs, with export and quotes, and leaves blank or missing ones unset", () => {
    expect(parsePingFile("HC_TOODO_URL=https://hc-ping.com/a\nexport HC_DORI_URL=\"https://hc-ping.com/b\"\n"))
      .toEqual({ toodo: "https://hc-ping.com/a", dori: "https://hc-ping.com/b" });
    expect(parsePingFile("# HC_TOODO_URL=x\nHC_TOODO_URL=\nOTHER=1\n")).toEqual({ toodo: undefined, dori: undefined });
  });
});

describe("startHealthcheck", () => {
  test("a healthy check pings its URL, a failing one its /fail with the reason, and no log line names a URL", async () => {
    const server = pingServer();
    cleanups.push(server.stop);
    const lines: string[] = [];
    const urls = { toodo: server.url("/toodo-uuid"), dori: server.url("/dori-uuid/") };
    const health = startHealthcheck(urls, { probes: { toodo: fixed(null), dori: fixed("gateway heartbeat is 300 s old") }, log: (line) => { lines.push(line); } }, 3_600_000);
    await health.round();
    await health.stop();
    expect(server.pings).toEqual([
      { path: "/toodo-uuid", body: "" }, { path: "/dori-uuid/fail", body: "gateway heartbeat is 300 s old" },
      { path: "/toodo-uuid", body: "" }, { path: "/dori-uuid/fail", body: "gateway heartbeat is 300 s old" },
    ]);
    expect(lines.sort()).toEqual(["HOST_HEALTHCHECK dori failing: gateway heartbeat is 300 s old", "HOST_HEALTHCHECK toodo ok"]);
  });

  test("a check without a URL is not pinged", async () => {
    const server = pingServer();
    cleanups.push(server.stop);
    const health = startHealthcheck({ toodo: server.url("/t"), dori: undefined }, { probes: { toodo: fixed(null), dori: fixed(null) }, log: () => {} }, 3_600_000);
    await health.stop();
    expect(server.pings.map((ping) => ping.path)).toEqual(["/t"]);
  });

  test("a ping the service keeps refusing is logged without its URL", async () => {
    const server = pingServer([500, 500, 500, 500]);
    cleanups.push(server.stop);
    const lines: string[] = [];
    const health = startHealthcheck({ toodo: server.url("/secret-uuid"), dori: undefined }, { probes: { toodo: fixed(null), dori: fixed(null) }, log: (line) => { lines.push(line); } }, 3_600_000);
    await health.stop();
    expect(server.pings).toHaveLength(4);
    expect(lines).toContain("HOST_HEALTHCHECK_SEND_FAILED toodo: HTTP 500");
    expect(lines.join("\n")).not.toContain("secret-uuid");
  });
});

describe("sendPing", () => {
  test("retries a refused ping and stops at the first success", async () => {
    const server = pingServer([502, 503]);
    cleanups.push(server.stop);
    await sendPing(server.url("/p"), "");
    expect(server.pings).toHaveLength(3);
  });

  test("names the error, not the URL, when nothing answers", async () => {
    const closed = pingServer();
    const url = closed.url("/secret-uuid");
    await closed.stop();
    const error = await sendPing(url, "").then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain("secret-uuid");
  });
});

describe("probes", () => {
  test("the core is healthy below 500 and failing on a 5xx or no answer", async () => {
    let status = 404;
    const core = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status }) });
    cleanups.push(() => core.stop(true));
    const probe = httpProbe(`http://127.0.0.1:${core.port}/`);
    expect(await probe()).toBeNull();
    status = 503;
    expect(await probe()).toBe("HTTP 503");
    await core.stop(true);
    expect(await probe()).toStartWith("no answer: ");
  });

  test("the gateway heartbeat is healthy up to the maximum age", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toodo-health-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "gateway-status.json");
    const now = () => 1_000_000;
    expect(await gatewayProbe(path, 120_000, now)()).toBe(`no gateway heartbeat in ${path}`);
    await writeFile(path, JSON.stringify({ at: 1_000_000 - 120_000, state: "ready" }));
    expect(await gatewayProbe(path, 120_000, now)()).toBeNull();
    await writeFile(path, JSON.stringify({ at: 1_000_000 - 300_000 }));
    expect(await gatewayProbe(path, 120_000, now)()).toBe("gateway heartbeat is 300 s old");
    expect(doriMaxAge(undefined)).toBe(120_000);
    expect(doriMaxAge("60000")).toBe(60_000);
    expect(doriMaxAge("x")).toBe(120_000);
  });
});
