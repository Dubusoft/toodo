import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventPriority, Supervisor } from "../src/supervise.ts";
import { outcomeLane, pendingReported, recordReported, REPORTED_DIR, takeReminders } from "../src/lane-outcomes.ts";
import type { Lane } from "../src/registry.ts";
import { renderStatus, type Status } from "../src/status.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState, writeJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const MIN = 60_000;
const T0 = 1_800_000_000_000;

const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const world = newWorld();
  const deps = depsFor(world, clock, state.dir);
  const unreported = () => (readJournal(state.dir).events as { id: string; line: string }[]).filter((event) => event.line.startsWith("UNREPORTED "));
  return { state, clock, deps, world, unreported };
};

const lane = (key: string, extra: Partial<Lane> = {}): Lane => ({
  key, title: key, thread: "none", pane: undefined, brief: "/tmp/brief.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), ...extra,
} as Lane);

const deliveredOutcome = async () => {
  const f = fixture();
  const pane = { pane_id: "hc:t1", workspace_id: "test", agent: "omo", agent_status: "working" };
  f.world.panes.push(pane);
  // Keep the push step away from the input: only supervisor observations advance these tests.
  f.world.screen = "❯ owner draft";
  const session = join(f.state.dir, "lead.jsonl");
  writeFileSync(session, "{}\n");
  utimesSync(session, T0 / 1000, T0 / 1000);
  const supervisor = new Supervisor({ ...f.deps, tunables: { ...f.deps.tunables, cacheTtlMin: 60 }, run: async (argv, opts) => {
    if (argv[0] === "ps" && argv[1] === "-A") return { code: 0, out: `101 10 /usr/bin/omo --session-id ${session}`, err: "" };
    return f.deps.run(argv, opts);
  } });
  supervisor.enqueue("closed:alpha", "LANE_CLOSED alpha x");
  await supervisor.flush();
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ deliveredAt: T0 });
  expect(readJournal(f.state.dir).outcomes[0].deliveredWorking).toBeUndefined();
  return { ...f, pane, supervisor };
};

for (const ended of ["idle", "done"]) {
  test(`a delivered outcome gets its first UNREPORTED on working -> ${ended}, then keeps normal backoff`, async () => {
    const f = await deliveredOutcome();
    f.clock.at += 1_000;
    await f.supervisor.flush();
    expect(readJournal(f.state.dir).outcomes[0].deliveredWorking).toBe(true);
    expect(f.unreported()).toEqual([]);
    f.pane.agent_status = ended;
    f.clock.at += 1_000;
    const before = f.world.calls.filter((call) => call[0] === "hc" && call[2] === "ls").length;
    await f.supervisor.flush();
    expect(f.world.calls.filter((call) => call[0] === "hc" && call[2] === "ls").length - before).toBe(1);
    expect(f.unreported()).toHaveLength(1);
    expect(f.unreported()[0]).toMatchObject({ id: `unreported:alpha:${T0}:1`, at: T0 + 2_000 });
    expect(f.unreported()[0]?.line).toStartWith("UNREPORTED alpha ");
    f.clock.at += 5 * MIN - 1;
    await f.supervisor.reportTick();
    expect(f.unreported()).toHaveLength(1);
    f.clock.at += 1;
    await f.supervisor.reportTick();
    expect(f.unreported()[1]?.id).toBe(`unreported:alpha:${T0}:2`);
  });
}

test("delivery followed only by idle observations waits for reportTimeoutMin", async () => {
  const f = await deliveredOutcome();
  f.pane.agent_status = "idle";
  f.clock.at += 1_000;
  await f.supervisor.flush();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0].deliveredWorking).toBeUndefined();
  f.clock.at = T0 + 5 * MIN;
  await f.supervisor.flush();
  expect(f.unreported()[0]?.id).toBe(`unreported:alpha:${T0}:1`);
});

test("a report receipt on the turn-end tick wins over the idle observation", async () => {
  const f = await deliveredOutcome();
  f.clock.at += 1_000;
  await f.supervisor.flush();
  f.pane.agent_status = "idle";
  f.clock.at += 1_000;
  recordReported(f.state.dir, "alpha", f.clock.now());
  await f.supervisor.flush();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0].reportedAt).toBe(f.clock.now());
});

test("an unobserved lead still gets the timeout reminder", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("closed:alpha", "LANE_CLOSED alpha x");
  f.clock.at = T0 + 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()[0]?.id).toBe(`unreported:alpha:${T0}:1`);
  expect(readJournal(f.state.dir).outcomes[0].deliveredAt).toBeUndefined();
  expect(f.world.calls).toEqual([]);
});

test("a machine lane owes no report when its delivered turn ends early", async () => {
  const f = await deliveredOutcome();
  await f.deps.registry.write(lane("alpha", { autoClose: "machine" }));
  f.clock.at += 1_000;
  await f.supervisor.flush();
  f.pane.agent_status = "idle";
  f.clock.at += 1_000;
  await f.supervisor.flush();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ reportedAt: f.clock.now(), note: "autoClose: machine" });
});

test("outcome lines name their lane; other lines and malformed keys name none", () => {
  expect(outcomeLane("LANE_CLOSED alpha {\"checks\":[]}")).toBe("alpha");
  expect(outcomeLane("CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x")).toBe("alpha");
  expect(outcomeLane("CI_MERGED acme/app#7 into dev head=abc")).toBeUndefined();
  expect(outcomeLane("LANE_DONE_CLAIMED alpha w:p1 proof")).toBe("alpha");
  expect(outcomeLane("LANE_AUTO_CLAIMED alpha w:p1 proof")).toBeUndefined();
  expect(outcomeLane("LANE_AUTO_CLOSED alpha x")).toBeUndefined();
  expect(outcomeLane("LANE_CLOSED $(rm) x")).toBeUndefined();
});

test("CI_MERGED and LANE_CLOSED of one lane are one obligation: UNREPORTED after reportTimeoutMin, re-sent with backoff, stopped by dori reported", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("ci-merged:acme/app#7", "CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x");
  f.clock.at += MIN;
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha {\"checks\":[]}");
  expect(readJournal(f.state.dir).outcomes).toEqual([
    { lane: "alpha", since: T0, line: "CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x", events: ["ci-merged:acme/app#7", "lane-closed:alpha"], heads: ["abc"], woke: true },
  ]);
  f.clock.at = T0 + 5 * MIN - 1;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  f.clock.at = T0 + 5 * MIN;
  await supervisor.reportTick();
  const [first] = f.unreported();
  expect(first?.line).toStartWith("UNREPORTED alpha finished 5 min ago and the owner has not been told: run dori reported alpha --text TEXT to post the outcome to the owner in its thread. CI_MERGED acme/app#7");
  expect(eventPriority(first?.line ?? "")).toBe("urgent");
  // Re-sent one window later, then after twice the previous wait; a restarted supervisor keeps the count.
  f.clock.at += 5 * MIN;
  await new Supervisor(f.deps).reportTick();
  expect(f.unreported()).toHaveLength(2);
  const restarted = new Supervisor(f.deps);
  f.clock.at += 10 * MIN - 1;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(2);
  f.clock.at += 1;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(3);
  // The lead reports; nothing more is sent, and a later outcome event of the lane opens nothing.
  recordReported(f.state.dir, "alpha", f.clock.now(), "told in its thread");
  await restarted.reportTick();
  expect(readdirSync(join(f.state.dir, REPORTED_DIR))).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "alpha", reportedAt: f.clock.now(), note: "told in its thread" });
  restarted.enqueue("lane-closed:alpha:again", "LANE_CLOSED alpha again");
  f.clock.at += 120 * MIN;
  await restarted.reportTick();
  expect(f.unreported()).toHaveLength(3);
  expect(readJournal(f.state.dir).outcomes).toHaveLength(1);
});

test("a report recorded before the outcome event arrives settles it, and two lanes are two obligations", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  recordReported(f.state.dir, "beta", f.clock.now());
  await supervisor.reportTick();
  supervisor.enqueue("lane-closed:beta", "LANE_CLOSED beta x");
  supervisor.enqueue("lane-closed:gamma", "LANE_CLOSED gamma x");
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported().map((event) => event.line.split(" ")[1])).toEqual(["gamma"]);
});

test("outcomes in the history at startup open nothing, and an engine-only outcome is not owed", async () => {
  const f = fixture();
  writeJournal(f.state.dir, { events: [{ id: "lane-closed:old", line: "LANE_CLOSED old x", at: T0 - 60 * MIN }] });
  const supervisor = new Supervisor({ ...f.deps, tunables: { ...f.deps.tunables, eventPolicy: { default: "lead-digest", kinds: { ...f.deps.tunables.eventPolicy.kinds, LANE_CLOSED: "engine-only" } } } });
  supervisor.enqueue("lane-closed:quiet", "LANE_CLOSED quiet x");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes ?? []).toEqual([]);
  expect(f.unreported()).toEqual([]);
});

test("a lane with autoClose: machine owes no report", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("robot", { autoClose: "machine" }));
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane-closed:robot", "LANE_CLOSED robot x");
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "robot", reportedAt: f.clock.now(), note: "autoClose: machine" });
});

const CLAIM = "LANE_DONE_CLAIMED alpha w:p1 merged acme/app#1";
const AUTO = "LANE_DONE_AUTO_REPORTED alpha w:p1 merged acme/app#1 | verified: pr=#1 head=abc1234 checks=green conflict=no sig=ok report=m-1";

test("an auto-reported claim is owed nothing: its receipt closes the row whichever comes first, and the merge of its head is quiet", async () => {
  for (const receiptFirst of [true, false]) {
    const f = fixture();
    const supervisor = new Supervisor(f.deps);
    if (receiptFirst) recordReported(f.state.dir, "alpha", f.clock.now(), "auto-reported by the supervisor");
    supervisor.enqueue("done-claim:alpha:1", AUTO);
    if (!receiptFirst) recordReported(f.state.dir, "alpha", f.clock.now(), "auto-reported by the supervisor");
    f.clock.at += 10 * MIN;
    await supervisor.reportTick();
    expect(f.unreported()).toEqual([]);
    expect(readJournal(f.state.dir).outcomes).toMatchObject([{ lane: "alpha", reportedAt: T0, line: AUTO, claim: true, claimed: true }]);
    supervisor.enqueue("ci-merged:acme/app#1", "CI_MERGED acme/app#1 into dev lane=alpha head=abc1234 merge=def https://x");
    expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ reportedAt: T0, quiet: ["ci-merged:acme/app#1"] });
  }
});

test("a done claim opens the lane's obligation: listed for inbox take, UNREPORTED after reportTimeoutMin", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  expect(readJournal(f.state.dir).outcomes).toEqual([{ lane: "alpha", since: T0, line: CLAIM, events: ["done-claim:alpha:1"], claim: true, claimed: true, woke: true }]);
  await supervisor.reportTick();
  expect(takeReminders(f.state.dir)).toEqual([
    `unreported:alpha\tUNREPORTED alpha since ${new Date(T0).toISOString()}: run dori reported alpha --text TEXT to post the outcome to the owner in its thread`,
  ]);
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  const [first] = f.unreported();
  expect(first?.line).toBe(`UNREPORTED alpha claimed done 5 min ago and the owner has not been told: run dori reported alpha --text TEXT to post the outcome to the owner in its thread. ${CLAIM}`);
});

test("report checks tick one at a time: a receipt taken by a later tick survives an earlier tick still reading the registry", async () => {
  // Given a claim past reportTimeoutMin whose first tick hangs in its registry read (lead delivery and the report check
  // tick from separate supervisor tasks).
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  f.clock.at += 5 * MIN;
  const read = f.deps.registry.read.bind(f.deps.registry);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered = () => {};
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  f.deps.registry.read = async (key) => { if (reads++ === 0) { entered(); await held; } return read(key); };
  const first = supervisor.reportTick();
  await reading;
  // When the lead reports while it hangs and the next tick starts.
  recordReported(f.state.dir, "alpha", f.clock.now());
  const second = supervisor.reportTick();
  release();
  await Promise.all([first, second]);
  // Then the first tick's reminder stands, and the second tick's receipt is not overwritten by the first tick's stale list.
  expect(f.unreported()).toHaveLength(1);
  expect(readJournal(f.state.dir).outcomes[0]).toMatchObject({ lane: "alpha", reportedAt: f.clock.now(), reminders: 1 });
});

test("the seen-claim close joins the claim's obligation: a reported claim is not owed again", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  f.clock.at += 10 * MIN;
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha closed seen-claim {}");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes).toEqual([
    { lane: "alpha", since: T0, line: CLAIM, events: ["done-claim:alpha:1", "lane-closed:alpha"], reportedAt: T0, claimed: true, woke: true },
  ]);
  // Joined by a real outcome, the row is no longer the claim's: a later rejection leaves it.
  supervisor.enqueue("not-done:alpha", "LANE_NOT_DONE alpha dirty tree");
  expect(readJournal(f.state.dir).outcomes).toHaveLength(1);
});

test("a machine lane's LANE_AUTO_CLAIMED opens nothing", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("auto-claim:robot", "LANE_AUTO_CLAIMED robot w:p1 proof");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes ?? []).toEqual([]);
  expect(f.unreported()).toEqual([]);
});

test("LANE_NOT_DONE drops an unreported claim's obligation", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  await supervisor.reportTick();
  f.clock.at += MIN;
  supervisor.enqueue("not-done:alpha", "LANE_NOT_DONE alpha dirty tree");
  expect(readJournal(f.state.dir).outcomes).toEqual([]);
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  expect(takeReminders(f.state.dir)).toEqual([]);
});

test("LANE_NOT_DONE drops a reported claim's row, so the next claim is owed afresh", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  f.clock.at += MIN;
  supervisor.enqueue("not-done:alpha", "LANE_NOT_DONE alpha dirty tree");
  expect(readJournal(f.state.dir).outcomes).toEqual([]);
  f.clock.at += 30 * MIN;
  const again = f.clock.now();
  supervisor.enqueue("done-claim:alpha:2", `${CLAIM} fixed`);
  expect(readJournal(f.state.dir).outcomes).toEqual([{ lane: "alpha", since: again, line: `${CLAIM} fixed`, events: ["done-claim:alpha:2"], claim: true, claimed: true, woke: true }]);
  f.clock.at += 5 * MIN;
  await supervisor.reportTick();
  expect(f.unreported().map((event) => event.line.split(" ").slice(0, 3).join(" "))).toEqual(["UNREPORTED alpha claimed"]);
});

test("dori object-done (a registry objection, no event) drops the claim's obligation at the next tick; an older objection does not", async () => {
  const f = fixture();
  const objection = (at: number) => lane("alpha", { status: "not-done", objection: { at: new Date(at).toISOString(), reasons: ["dirty tree"] } });
  await f.deps.registry.write(objection(T0 - MIN));
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", CLAIM);
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes).toHaveLength(1);
  f.clock.at += MIN;
  await f.deps.registry.write(objection(f.clock.now()));
  await supervisor.reportTick();
  expect(readJournal(f.state.dir).outcomes).toEqual([]);
  expect(takeReminders(f.state.dir)).toEqual([]);
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
});

test("a claim joined by CI_MERGED or LANE_CLOSED is a real outcome: LANE_NOT_DONE and objections leave it", async () => {
  for (const [id, line] of [["ci-merged:acme/app#1", "CI_MERGED acme/app#1 into dev lane=alpha head=abc merge=def https://x"], ["lane-closed:alpha", "LANE_CLOSED alpha closed {}"]] as const) {
    const f = fixture();
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("done-claim:alpha:1", CLAIM);
    supervisor.enqueue(id, line);
    f.clock.at += MIN;
    await f.deps.registry.write(lane("alpha", { status: "not-done", objection: { at: new Date(f.clock.now()).toISOString(), reasons: ["x"] } }));
    supervisor.enqueue("not-done:alpha", "LANE_NOT_DONE alpha dirty tree");
    f.clock.at += 4 * MIN;
    await supervisor.reportTick();
    expect(readJournal(f.state.dir).outcomes).toEqual([expect.objectContaining({ lane: "alpha", events: ["done-claim:alpha:1", id] })]);
    expect(readJournal(f.state.dir).outcomes[0].claim).toBeUndefined();
    expect(f.unreported().map((event) => event.line.split(" ").slice(0, 3).join(" "))).toEqual(["UNREPORTED alpha finished"]);
  }
});

test("open obligations are listed for inbox take until reported", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  expect(takeReminders(f.state.dir)).toEqual([]);
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha done");
  await supervisor.reportTick();
  expect(takeReminders(f.state.dir)).toEqual([
    `unreported:alpha\tUNREPORTED alpha since ${new Date(T0).toISOString()}: run dori reported alpha --text TEXT to post the outcome to the owner in its thread`,
  ]);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  expect(takeReminders(f.state.dir)).toEqual([]);
});

test("dori status names unreported lanes as a problem", () => {
  const base = {
    at: new Date(T0).toISOString(), services: [], lanes: [], waits: [],
    lead: { pane: "hc:t1", state: "warm", cacheTtlMin: 60, capTokens: 100_000 },
    github: { repos: [], failures: [], issueAuthors: ["owner"], issueRepos: [] },
    gateway: { state: "live", text: "" },
    events: { hours: 24, wakes: 0, measured: 0, calls: 0, kinds: [] },
  } as unknown as Status;
  expect(renderStatus(base)).not.toContain("미보고");
  const text = renderStatus({ ...base, unreported: [{ lane: "alpha", since: new Date(T0 - 12 * MIN).toISOString() }] });
  expect(text.split("\n")[1]).toContain("미보고 레인 1");
  expect(text).toContain("- 끝났지만 오너에게 아직 보고 안 한 레인 (dori reported <key> --text TEXT): alpha 12분 전");
});

// A preload replacing fetch: each request is appended to $FAKE_LOG as JSON; $FAKE_STATUS (default 200) is the reply status.
// The fake Toodo server answers the task-thread chat tools: task thread 7, message 88.
const fakeFetch = (dir: string): string => {
  const preload = join(dir, "fake-fetch.js");
  writeFileSync(preload, [
    'const { appendFileSync } = require("node:fs");',
    'globalThis.fetch = async (url, init) => {',
    '  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined }) + "\\n");',
    '  const status = Number(process.env.FAKE_STATUS ?? 200);',
    '  if (!String(url).endsWith("/mcp") || status !== 200) return new Response(null, { status: status === 200 ? 404 : status });',
    '  const rpc = JSON.parse(init.body), name = rpc.params.name, a = rpc.params.arguments;',
    '  const value = name === "list_threads" ? [{ id: 7, taskId: a.task_id, status: "open" }] : name === "reply_in_chat" ? { id: 88, channelId: 1, threadId: a.thread_id, author: "agent", body: a.body, attachments: [] } : {};',
    '  return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });',
    '};',
  ].join("\n"));
  return preload;
};

const cli = async (dir: string, args: string[], env: Record<string, string> = {}) => {
  const data = join(dir, ".local", "share", "toodo-server");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "mcp-token"), "mcp-1\n");
  const log = join(dir, "fetch.log");
  rmSync(log, { force: true });
  const p = Bun.spawn([process.execPath, "--preload", fakeFetch(dir), join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: dir, FAKE_LOG: log, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { url: string; method: string; body?: { params?: { name: string; arguments: Record<string, unknown> } } }) : [];
  return { out, err, code, requests };
};

// Each case spawns `bun src/cli.ts`; a loaded full run on a small host needs more than bun's default 5 s per test.
const CLI_TIMEOUT = 30_000;

test("dori reported is lead-only, needs a registered lane, and needs --text", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200" }));
  const denied = await cli(f.state.dir, ["reported", "alpha", "--text", "merged"], { DORI_LANE_KEY: "alpha" });
  expect(denied.code).toBe(2);
  expect(denied.err).toStartWith("DORI_CLI_LANE_ONLY reported:");
  const unknown = await cli(f.state.dir, ["reported", "nope", "--text", "merged"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('no registered lane "nope"');
  const bare = await cli(f.state.dir, ["reported", "alpha", "--note", "told"]);
  expect(bare.code).toBe(1);
  expect(bare.err).toContain("usage: dori reported <key> --text TEXT [--note TEXT] | dori reported <key> --append TEXT [--note TEXT]");
  expect([...denied.requests, ...unknown.requests, ...bare.requests]).toEqual([]);
  expect(existsSync(join(f.state.dir, REPORTED_DIR))).toBe(false);
}, CLI_TIMEOUT);

test("dori reported posts to the lane's Toodo task thread despite a legacy Discord ref, then records the message and target", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", task: 951 }));
  const ok = await cli(f.state.dir, ["reported", "alpha", "--text", "alpha merged: acme/app#7", "--note", "told in its thread"]);
  expect(ok.err).toBe("");
  expect(ok.code).toBe(0);
  expect(ok.out.trim()).toBe("REPORTED_RECORDED alpha toodo:88");
  expect(ok.requests.map(({ method, url, body }) => [method, new URL(url).pathname, body?.params])).toEqual([
    ["POST", "/mcp", { name: "list_threads", arguments: { task_id: 951 } }],
    ["POST", "/mcp", { name: "reply_in_chat", arguments: { thread_id: 7, body: "[report]\nalpha merged: acme/app#7", handles: [] } }],
  ]);
  expect(pendingReported(f.state.dir).map(({ lane: key, note, message, target }) => ({ key, note, message, target })))
    .toEqual([{ key: "alpha", note: "told in its thread", message: "toodo:88", target: "toodo:thread/7" }]);
}, CLI_TIMEOUT);

test("a failed post records no receipt and exits non-zero", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { task: 951 }));
  const failed = await cli(f.state.dir, ["reported", "alpha", "--text", "alpha merged"], { FAKE_STATUS: "403" });
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("REPORT_NOT_POSTED alpha: the report did not reach the lane's Toodo task thread");
  expect(failed.out).not.toContain("REPORTED_RECORDED");
  expect(failed.requests).toHaveLength(1);
  expect(pendingReported(f.state.dir)).toEqual([]);
}, CLI_TIMEOUT);

test("a lane without a Toodo task dies without posting or recording", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha"));
  const none = await cli(f.state.dir, ["reported", "alpha", "--text", "alpha merged"]);
  expect(none.code).toBe(1);
  expect(none.err).toContain("REPORT_NOT_POSTED alpha: the report did not reach the lane's Toodo task thread (the lane has no task); nothing recorded");
  expect(none.requests).toEqual([]);
  expect(existsSync(join(f.state.dir, REPORTED_DIR))).toBe(false);
}, CLI_TIMEOUT);

test("pendingReported reads receipts written before reports carried a message id", () => {
  const f = fixture();
  mkdirSync(join(f.state.dir, REPORTED_DIR), { recursive: true });
  writeFileSync(join(f.state.dir, REPORTED_DIR, `${T0}-old.json`), JSON.stringify({ lane: "alpha", at: T0, note: "told" }));
  expect(pendingReported(f.state.dir).map(({ path: _path, ...rest }) => rest)).toEqual([{ lane: "alpha", at: T0, note: "told" }]);
});

test("a quiet lane's claim (reportQuietLanes) is owed nothing even after closing", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  await f.deps.registry.write(lane("blog-draft-1", { thread: "discord:100/200" }));
  // done-flow.ts writes the quiet receipt (no message) before announcing the claim.
  recordReported(f.state.dir, "blog-draft-1", f.clock.now(), "reportQuietLanes: the lane posts its own results");
  supervisor.enqueue("done-claim:blog-draft-1:1", "LANE_DONE_AUTO_REPORTED blog-draft-1 w:p1 merged acme/app#1 | verified: pr=none sig=ok report=quiet");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  await f.deps.registry.patch("blog-draft-1", { closedAt: new Date(f.clock.now()).toISOString() });
  supervisor.enqueue("closed:blog-draft-1", "LANE_CLOSED blog-draft-1 closed seen-claim toodo=no-task");
  f.clock.at += 10 * MIN;
  await supervisor.reportTick();
  expect(f.unreported()).toEqual([]);
  expect(readJournal(f.state.dir).outcomes).toMatchObject([{ lane: "blog-draft-1", reportedAt: T0, quiet: ["closed:blog-draft-1"] }]);
  supervisor.close();
});

test("dori reported --append posts a follow-up in the Toodo task thread despite a legacy Discord ref and report", async () => {
  const f = fixture();
  await f.deps.registry.write(lane("alpha", { thread: "discord:100/200", task: 951 }));
  writeFileSync(join(f.state.dir, "last-reports.json"), JSON.stringify({ alpha: { channel: "200", message: "m-1", at: T0 } }));
  const append = await cli(f.state.dir, ["reported", "alpha", "--append", "merged acme/app#1 (abc1234)"]);
  expect(append.err).toBe("");
  expect(append.code).toBe(0);
  expect(append.out.trim()).toBe("REPORT_APPENDED alpha toodo:88");
  expect(append.requests.map(({ method, url, body }) => [method, new URL(url).pathname, body?.params])).toEqual([
    ["POST", "/mcp", { name: "list_threads", arguments: { task_id: 951 } }],
    ["POST", "/mcp", { name: "reply_in_chat", arguments: { thread_id: 7, body: "[follow-up]\nmerged acme/app#1 (abc1234)", handles: [] } }],
  ]);
  expect(pendingReported(f.state.dir).map(({ message, target }) => [message, target])).toEqual([["toodo:88", "toodo:thread/7"]]);
}, CLI_TIMEOUT);
