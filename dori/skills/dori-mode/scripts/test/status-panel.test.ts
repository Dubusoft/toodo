import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SupervisorStatusSnapshot } from "../../../../../src/lib/supervisor-status.ts";
import { quotaReport, type UsageLookup } from "../src/claude-quota.ts";
import { collectPanel, STATUS_PANEL_IDLE_MS, STATUS_PANEL_WATCHED_MS, type StatusPanelDeps, statusPanelPass } from "../src/status-panel.ts";
import { type Status, statusPages } from "../src/status.ts";

const AT = Date.parse("2026-10-21T00:53:36.000Z");

const status: Status = {
  at: new Date(AT).toISOString(),
  timeZone: "Asia/Seoul",
  services: [{ name: "dori-supervisor.service", enabled: "enabled", active: "active" }],
  lead: { pane: "wL1:p4", state: "warm", idleMin: 0, tokens: 52_000, cacheTtlMin: 5, capTokens: 150_000 },
  lanes: [
    { key: "ap-1-1", model: "anthropic-subscription/claude-opus-5-5", ageMin: 27, task: 1, machine: "local", progress: "porting the panel" },
    { key: "ap-2-1", ageMin: 3, machine: "mac-mini" },
  ],
  waits: [],
  github: { repos: [], failures: [], issueAuthors: [], issueRepos: [] },
  gateway: { state: "live", text: "live" },
  unacked: 0,
  events: { hours: 24, wakes: 0, sources: { owner: 0, lane: 0, noise: 0 }, measured: 0, calls: 0, kinds: [] },
};

// A cached read 40 s old, so the /quota text carries the cache line too.
const quota: UsageLookup = async () => ({
  results: [],
  text: "Claude default: 5h 12% · 7d 40%",
  cache: { fetchedAt: AT - 40_000, refreshed: false, backoff: [], stale: [] },
});

const tokenFile = (): string => {
  const file = join(mkdtempSync(join(tmpdir(), "status-panel-")), "mcp-token");
  writeFileSync(file, "agent\n");
  return file;
};

const deps = (over: Partial<StatusPanelDeps> = {}): StatusPanelDeps => ({
  endpoint: { url: "http://127.0.0.1:47616", tokenFile: tokenFile() },
  now: () => AT,
  timeZone: "Asia/Seoul",
  status: async () => status,
  quota,
  screen: async (key) => `screen of ${key}`,
  log: () => {},
  ...over,
});

test("a watched snapshot holds the /status pages and the /quota text of the same read, and every lane's screen", async () => {
  const snapshot = await collectPanel(deps(), true);
  expect(snapshot.at).toBe(AT);
  expect(snapshot.status).toEqual(statusPages(status));
  expect(snapshot.quota).toEqual({ text: await quotaReport(quota, "Asia/Seoul", () => AT)(AbortSignal.timeout(1000)), fetchedAt: AT - 40_000 });
  expect(snapshot.quota).toMatchObject({ text: expect.stringContaining("QUOTA | cached read from 40s ago") });
  expect(snapshot.lanes).toEqual([
    { key: "ap-1-1", status: "working", task: 1, machine: "local", model: "anthropic-subscription/claude-opus-5-5", ageMin: 27, progress: "porting the panel", screen: { text: "screen of ap-1-1" } },
    { key: "ap-2-1", status: "working", task: null, machine: "mac-mini", model: null, ageMin: 3, progress: null, screen: { text: "screen of ap-2-1" } },
  ]);
  expect(snapshot.machines).toEqual([]);
});

test("every open lane comes with its status, only working lanes' screens are read, and each runner is a machine with its sample", async () => {
  const screens: string[] = [];
  const snapshot = await collectPanel(deps({
    status: async () => ({
      ...status,
      otherLanes: [{ key: "ap-3-1", ageMin: 50, task: 3, machine: "local", status: "done-claimed" }],
      runners: [
        { label: "local", state: "connected", version: "1.11.0", gen: 1, cmds: 0,
          machine: { level: "ok", os: "linux", load1: 0.42, memFreePct: 61, diskFreeGb: 120, swapFreeGb: -1, reasons: [], sampledAt: "2026-10-21T00:53:00.000Z", ageSec: 36 } },
        { label: "mac-mini", state: "offline", gen: 2, cmds: 0 },
      ],
    }),
    screen: async (key) => { screens.push(key); return ""; },
  }), true);
  expect(snapshot.lanes.map((lane) => [lane.key, lane.status, lane.screen])).toEqual([
    ["ap-1-1", "working", { text: "" }],
    ["ap-2-1", "working", { text: "" }],
    ["ap-3-1", "done-claimed", null],
  ]);
  expect(screens).toEqual(["ap-1-1", "ap-2-1"]);
  expect(snapshot.machines).toEqual([
    { label: "local", state: "connected", version: "1.11.0", sample: { level: "ok", os: "linux", load1: 0.42, memFreePct: 61, diskFreeGb: 120, ageSec: 36 } },
    { label: "mac-mini", state: "offline", version: null, sample: null },
  ]);
});

test("an unwatched snapshot reads neither the quota nor any screen", async () => {
  let reads = 0;
  const snapshot = await collectPanel(deps({
    quota: async (signal) => { reads += 1; return quota(signal); },
    screen: async () => { reads += 1; return ""; },
  }), false);
  expect(reads).toBe(0);
  expect(snapshot.quota).toBeNull();
  expect(snapshot.lanes.map((lane) => lane.screen)).toEqual([null, null]);
  expect(snapshot.status).toEqual(statusPages(status));
});

test("a failed quota read or screen is shown as its error, not dropped", async () => {
  const snapshot = await collectPanel(deps({
    quota: async () => { throw new Error("usage endpoint down"); },
    screen: async (key) => { if (key === "ap-2-1") throw new Error("RUNNER_UNAVAILABLE runner=mac-mini"); return "ok"; },
  }), true);
  expect(snapshot.quota).toEqual({ error: "usage endpoint down" });
  expect(snapshot.lanes.map((lane) => lane.screen)).toEqual([{ text: "ok" }, { error: "RUNNER_UNAVAILABLE runner=mac-mini" }]);
});

type Call = { readonly method: string; readonly url: string; readonly auth: string | null; readonly body?: SupervisorStatusSnapshot };

/** A core that answers every call with `watchers()` panels open. */
const core = (watchers: () => number) => {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({
      method: init.method ?? "GET", url, auth: headers.get("authorization"),
      ...(typeof init.body === "string" ? { body: JSON.parse(init.body) as SupervisorStatusSnapshot } : {}),
    });
    return Response.json({ watchers: watchers() });
  };
  return { calls, fetch };
};

test("the pass pushes every 30 s while no panel is open, asks between pushes, and pushes full snapshots every 10 s once one is", async () => {
  let now = AT;
  let watchers = 0;
  const server = core(() => watchers);
  const pass = statusPanelPass(deps({ now: () => now, fetch: server.fetch }));

  await pass();
  expect(server.calls).toEqual([expect.objectContaining({ method: "PUT", url: "http://127.0.0.1:47616/mcp/supervisor-status", auth: "Bearer agent" })]);
  expect(server.calls[0]?.body?.quota).toBeNull();

  now += 5_000;
  await pass();
  expect(server.calls.map((call) => call.method)).toEqual(["PUT", "GET"]);

  // A panel opens: the next pass hears of it and pushes a full snapshot, since the last push is over 10 s old.
  watchers = 1;
  now += 5_000;
  await pass();
  expect(server.calls.map((call) => call.method)).toEqual(["PUT", "GET", "GET", "PUT"]);
  expect(server.calls[3]?.body?.quota).not.toBeNull();
  expect(server.calls[3]?.body?.lanes[0]?.screen).toEqual({ text: "screen of ap-1-1" });

  now += STATUS_PANEL_WATCHED_MS - 1;
  await pass();
  expect(server.calls).toHaveLength(4);
  now += 1;
  await pass();
  expect(server.calls.map((call) => call.method)).toEqual(["PUT", "GET", "GET", "PUT", "PUT"]);

  // The panel closed: pushes fall back to every 30 s, with a question in between.
  watchers = 0;
  now += STATUS_PANEL_WATCHED_MS;
  await pass();
  now += STATUS_PANEL_IDLE_MS - 1;
  await pass();
  expect(server.calls.map((call) => call.method)).toEqual(["PUT", "GET", "GET", "PUT", "PUT", "PUT", "GET"]);
});

test("a core that refuses the push is logged once, retried on schedule, and its recovery logged", async () => {
  let now = AT;
  let answer = 404;
  const lines: string[] = [];
  let calls = 0;
  const pass = statusPanelPass(deps({
    now: () => now,
    log: (line) => { lines.push(line); },
    fetch: async () => { calls += 1; return answer === 200 ? Response.json({ watchers: 0 }) : new Response("not here", { status: answer }); },
  }));
  await pass();
  now += STATUS_PANEL_IDLE_MS;
  await pass();
  expect(lines).toEqual(["STATUS_PANEL_PUSH_FAILED http://127.0.0.1:47616/mcp/supervisor-status: HTTP 404: not here"]);
  answer = 200;
  now += STATUS_PANEL_IDLE_MS;
  await pass();
  expect(lines.at(-1)).toBe("STATUS_PANEL_RECOVERED http://127.0.0.1:47616/mcp/supervisor-status");
  expect(calls).toBe(3);
});

test("a missing token file is a logged failure, and nothing is sent", async () => {
  const lines: string[] = [];
  let calls = 0;
  const pass = statusPanelPass(deps({
    endpoint: { url: "http://127.0.0.1:47616", tokenFile: join(tmpdir(), "status-panel-no-such-dir", "mcp-token") },
    log: (line) => { lines.push(line); },
    fetch: async () => { calls += 1; return Response.json({ watchers: 0 }); },
  }));
  await pass();
  expect(calls).toBe(0);
  expect(lines).toEqual([expect.stringContaining("cannot read the token file")]);
});
