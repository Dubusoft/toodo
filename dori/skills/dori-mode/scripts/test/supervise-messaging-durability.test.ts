import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { Supervisor } from "../src/supervise.ts";
import { enqueueLaunch, launchQueue, launchQueueText, recordLaunchVerdict } from "../src/routing.ts";
import { supervisorSweeps } from "../src/supervise-loop.ts";
import { RunnerGuardBoard } from "../src/runner/guard.ts";
import type { AnyRunnerEvent } from "../src/runner/protocol.ts";
import { SqliteStore } from "../src/store.ts";
import { resolveEventPolicy } from "../src/event-policy.ts";
import { depsFor, fakeClock, newWorld, withState, readJournal } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const fixture = () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(1_800_000_000_000);
  const world = newWorld();
  const pane = { pane_id: "hc:t1", workspace_id: "test", agent: "omo", agent_status: "working" };
  world.panes.push(pane);
  const deps = depsFor(world, clock, state.dir);
  const journal = (): {
    events: { id: string; line: string }[];
  } => readJournal(state.dir);
  return { state, clock, pane, deps, journal };
};

test.each([
  ["toodo:chat:22", "INBOUND 11 22 owner retry"],
  ["closed:alpha", "LANE_CLOSED alpha"],
])("failed enqueue rolls back tracking for %s before a same-id retry", (id, line) => {
  const f = fixture();
  const posted: string[] = [];
  const supervisor = new Supervisor(f.deps, {
    announce: async (text) => { posted.push(text); },
  });
  cleanups.unshift(() => supervisor.close());
  const before = structuredClone(supervisor["core"].journal);
  const store = supervisor["core"].store;
  const tmp = join(f.state.dir, "supervisor.json.tmp");
  if (store instanceof SqliteStore) {
    // All statements succeed; the deferred foreign key rejects the actual COMMIT.
    store["db"].exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE commit_parent (id TEXT PRIMARY KEY);
      CREATE TABLE commit_child (id TEXT REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER INSERT ON events BEGIN INSERT INTO commit_child VALUES (NEW.id); END;`);
  } else mkdirSync(tmp);
  expect(() => supervisor.enqueue(id, line)).toThrow();
  if (store instanceof SqliteStore) store["db"].exec("DROP TRIGGER fail_commit");
  else rmSync(tmp, { recursive: true });
  expect(supervisor["core"].journal).toEqual(before);
  expect(supervisor.journaled(id)).toBe(false);
  expect(posted).toEqual([]);
  expect(supervisor.enqueue(id, line)).toBe(true);
  expect(supervisor.enqueue(id, line)).toBe(false);
  expect(f.journal().events.filter((event) => event.id === id)).toHaveLength(1);
  supervisor.close();
  const restarted = new Supervisor(f.deps);
  try {
    expect(restarted.journaled(id)).toBe(true);
    expect(f.journal().events.filter((event) => event.id === id)).toHaveLength(1);
  } finally { restarted.close(); }
});

test.each(["lead-digest", "engine-only"] as const)("enqueue commits a %s event in one save and stages nothing for the owner", async (cls) => {
  const f = fixture();
  const posted: string[] = [];
  const supervisor = new Supervisor({
    ...f.deps, tunables: { ...f.deps.tunables, eventPolicy: resolveEventPolicy({ kinds: { CUSTOM: cls } }) },
  }, { announce: async (text) => { posted.push(text); } });
  cleanups.unshift(() => supervisor.close());
  const save = spyOn(supervisor["core"].store, "save");
  expect(supervisor.enqueue("announce:retry", "CUSTOM retry")).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  save.mockRestore();
  expect(readJournal(f.state.dir).outbox ?? []).toEqual([]);
  expect(f.journal().events.filter((event) => event.id === "announce:retry")).toHaveLength(1);
  await supervisor.announcementsSettled();
  expect(posted).toEqual([]);
});

test("a failed delivery-log append is retried after restart", async () => {
  // Given a durable inbox with an unwritable delivery-log path.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("toodo:chat:22", "INBOUND 11 22 owner alpha");
  unlinkSync(supervisor.eventLog);
  mkdirSync(supervisor.eventLog);
  // When the append fails.
  await expect(supervisor.flush()).rejects.toThrow();
  // The next supervisor retries delivery from the durable journal.
  rmSync(supervisor.eventLog, { recursive: true });
  await new Supervisor(f.deps).flush();
  expect(readFileSync(supervisor.eventLog, "utf8")).toContain('"id":"toodo:chat:22"');
});

test("LAUNCH_READY snapshots the persisted launch queue before the hold clears", async () => {
  // Given two held launches that a restarted lead must recover.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  recordLaunchVerdict(f.state.dir, { ok: false, reasons: ["host full"] }, f.clock.now());
  for (const key of ["alpha", "beta"]) {
    enqueueLaunch(f.state.dir, {
      key, title: key, done: `merged owner/${key}#1`, brief: `/briefs/${key}.md`,
      cwd: `/repo/${key}`, repos: [`owner/${key}`], thread: `toodo:thread/${key}`,
      queuedAt: new Date(f.clock.now()).toISOString(), reasons: ["host full"],
    });
  }
  const expectedQueue = launchQueueText(launchQueue(f.state.dir));
  const deps = {
    ...f.deps,
    run: async (argv: readonly string[]) => argv[0] === "df"
      ? { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }
      : f.deps.run(argv),
  };
  // The host's numbers come from the local runner's guard sample.
  const board = new RunnerGuardBoard(() => 0);
  board.event("local", {
    v: 1, runner: "local", gen: 1, epoch: 1, seq: 1, type: "guard.sample",
    body: { level: "ok", reasons: [], sampledAt: 0, load1: 1, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 2, swapTotalGb: 4, os: "linux", panes: 1 },
  } as unknown as AnyRunnerEvent);
  const guard = supervisorSweeps(deps, f.state.dir, undefined, undefined, undefined, () => board).find(([name]) => name === "guard");
  if (!guard) throw new Error("guard sweep missing");
  // When the actual guard sweep journals readiness and clears the hold.
  let sequence = 0;
  await guard[1](async (line) => { supervisor.enqueue(`guard:${sequence++}`, line); });
  // Then the durable event retains the complete formatter output and the queue remains recoverable.
  const ready = f.journal().events.find((event) => event.line.startsWith("LAUNCH_READY "))?.line;
  expect(ready?.endsWith(expectedQueue)).toBe(true);
  expect(ready?.split(expectedQueue)).toHaveLength(2);
  expect(launchQueue(f.state.dir)).toHaveLength(2);
});
