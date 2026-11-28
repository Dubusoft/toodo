import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { defaultConfig, LEAD_DIET_EXCLUDED_TOOLS } from "../src/config.ts";
import type { Runner } from "../src/run.ts";
import { eventPriority, LEAD_SKILL, RetryingDelivery, Supervisor } from "../src/supervise.ts";
import { leadPermissionArgs, plainShell, UNCONFIRMED_LIMIT } from "../src/lead-process.ts";
import { SOFT_RELEASE_GRACE_MS, SOFT_SESSION_SETTLE_MS } from "../src/lead-soft-restart.ts";
import { acquireSupervisor } from "../src/supervise-loop.ts";
import { childWork } from "../src/supervise-lead-lifecycle.ts";
import { BUILT_IN } from "../src/tunables.ts";
import { Waits } from "../src/waits.ts";
import { pendingLeadRestart, requestLeadRestart } from "../src/lead-restart.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { clearLaunchHold, dequeueLaunch, enqueueLaunch } from "../src/routing.ts";
import { depsFor, fakeClock, newWorld, withState, journalBytes, readJournal, writeJournal } from "./fakes.ts";
import { readWakes, SQLITE_FILE, SqliteStore } from "../src/store.ts";
import { eventClass, resolveEventPolicy } from "../src/event-policy.ts";
import { routeReports } from "../src/lane-reports.ts";
import { openLaneReports } from "../src/lane-report-store.ts";
import { take, takeCarriedReminders, takeOutput } from "../src/inbox.ts";
import { POINTER_PREFIX } from "../src/supervise-push.ts";
import { recordReported } from "../src/lane-outcomes.ts";
import { TransientSuperviseError } from "../src/supervise-journal.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const fixture = (extra: Record<string, unknown> = {}) => {
  const state = withState();
  cleanups.push(state.done);
  // The evidence deadline is measured on this clock, so a sleep must move it forward.
  // A /new session's model entry is written once this clock reaches its start time (Infinity: it never starts).
  let startDelay = 0;
  let startedAt: number | undefined;
  let pendingStart: { readonly at: number; readonly file: string } | undefined;
  const startPending = () => {
    if (!pendingStart || clock.at < pendingStart.at) return;
    appendFileSync(pendingStart.file, `${JSON.stringify({ type: "model_change", provider: "test", modelId: "soft" })}\n`);
    utimesSync(pendingStart.file, clock.at / 1000, clock.at / 1000);
    startedAt = clock.at;
    pendingStart = undefined;
  };
  // After /new omo's terminal integration can release the pane's agent for a moment while the old session shuts down;
  // `dead` instead ends the process for good.
  let release: { from: number; to: number; dead: boolean; pending?: { readonly delay: number; readonly gap: number; readonly dead: boolean } } | undefined;
  const syncRelease = () => {
    if (!release || clock.at < release.from) return;
    if (release.dead) { pid = 0; pane.agent = ""; pane.agent_status = "unknown"; return; }
    if (clock.at < release.to) { pane.agent = ""; pane.agent_status = "unknown"; return; }
    pane.agent = "omo";
    pane.agent_status = "idle";
    release = undefined;
  };
  const clock: ReturnType<typeof fakeClock> = { at: 1_800_000_000_000, now: () => clock.at, sleep: async (ms: number) => { clock.at += ms; startPending(); syncRelease(); } };
  const world = newWorld();
  const session = "11111111-1111-4111-8111-111111111111";
  const config = { sessionsDir: join(state.dir, "sessions"), leadCwd: "/repo", ...extra };
  const dir = sessionDirFor(config.sessionsDir, "/repo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2027-01-15T08-00-00-000Z_${session}.jsonl`);
  writeFileSync(file, "{}\n");
  utimesSync(file, clock.now() / 1000, clock.now() / 1000);
  const pane = { pane_id: "hc:t1", workspace_id: "", cwd: "/repo", agent: "omo", agent_status: "idle", revision: 0 };
  world.panes.push(pane);
  let active = session;
  let launchedId = session;
  let pid = 101;
  let confirm = true;
  let admitted: string | undefined;
  let prompt: string | undefined;
  let onWait: (() => Promise<void>) | undefined;
  let hangs = 0;
  let softEvidence = true;
  let typed = "";
  let waiting = false;
  let terminals = 1;
  const auth: Record<string, string> = {};
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const ok = (out = "") => ({ code: 0, out, err: "" });
    if (argv[0] === "omo" && argv[1] === "auth") return { code: 1, out: auth[argv[argv.indexOf("--provider") + 1] ?? ""] ?? "", err: "" };
    if (argv[0] === "ps" && argv[1] === "-A") return ok(pid ? `${pid} 10 /usr/bin/omo --session-id ${launchedId}\n102 ${pid} tail -F events\n103 1 tail -F orphan\n104 1 other-agent\n10 1 /bin/bash` : "");
    if (argv[0] === "ps" && argv[1] === "eww") return ok(argv.at(-1) === "103" ? `tail -F orphan PI_SESSION_ID=${session}` : "PI_SESSION_ID=other");
    if (argv[0] === "kill") {
      if (argv[2] === String(pid)) { pid = 0; pane.agent = ""; pane.agent_status = ""; }
      return ok();
    }
    if (argv[0] !== "hc") throw new Error(`unexpected ${argv.join(" ")}`);
    if (argv[1] === "--version") return ok("hc 0.1.22\n");
    const [verb, addr = ""] = argv.slice(2);
    const at = world.panes.find((p) => p.pane_id === `hc:${addr}`);
    // Terminal reads right after a launch stand where the lead's readiness is polled (onWait); any other call ends that window.
    if (verb === "ls") {
      if (waiting) await onWait?.();
      return ok(JSON.stringify({ terminals: world.panes.filter((p) => p.pane_id.startsWith("hc:")).map((p) => ({ address: p.pane_id.slice(3), state: "live" })) }));
    }
    if (verb === "get") {
      if (!at) return { code: 1, out: "", err: `no terminal ${addr}` };
      // Only the lead's terminal runs the fake omo; until confirmed (confirm false) its status never reads ready.
      const lead = at === pane;
      const state = lead && waiting && !confirm ? "unknown" : at.agent_status;
      return ok(JSON.stringify({
        address: addr, state: "live", cwd: at.cwd, created_ms: 1, pid: 10,
        status: at.agent ? { app: at.agent, state } : null,
        foreground: lead && pid ? { pid, argv: ["omo", "--session-id", launchedId] } : null,
      }));
    }
    waiting = false;
    if (verb === "run") {
      // A new terminal at the lead's cwd: the fixture's pane object (the one its fakes change) moves there; a terminal it
      // leaves behind stays a plain shell.
      const made = `t${++terminals}`;
      const old = world.panes.indexOf(pane);
      if (old >= 0) world.panes[old] = { pane_id: pane.pane_id, workspace_id: "", cwd: "/repo", agent: "", agent_status: "" };
      pane.pane_id = `hc:${made}`;
      world.panes.push(pane);
      return ok(JSON.stringify({ address: made }));
    }
    if (verb === "kill") {
      if (!at) return { code: 1, out: "", err: `no terminal ${addr}` };
      world.panes.splice(world.panes.indexOf(at), 1);
      return ok();
    }
    if (verb === "rm") return ok();
    // hc has no pane revision: each Enter shows on the screen (one more row past the prompt; a --lines read trims it).
    if (verb === "read") return ok(JSON.stringify({ text: `${world.screen}${"\n".repeat(pane.revision)}` }));
    const text = verb === "send" ? argv[5] ?? "" : undefined;
    if (text?.startsWith("cd ")) {
      admitted = text;
      const path = /@([^'\s]+)/.exec(admitted)?.[1];
      prompt = path ? readFileSync(path, "utf8") : undefined;
      active = /--session-id ([\w-]+)/.exec(admitted)?.[1] ?? "";
      launchedId = active;
      pid = 201;
      // A healthy omo writes its holder pid file at once; a hung cold start only creates the empty directory.
      mkdirSync(join(dir, "session-holders", active), { recursive: true });
      if (hangs > 0) hangs--;
      else writeFileSync(join(dir, "session-holders", active, `${pid}.json`), "{}");
      pane.agent = "omo";
      pane.agent_status = "idle";
      waiting = true;
      return ok();
    }
    if (text !== undefined) typed = text;
    if (verb === "send" || verb === "keys") {
      pane.revision++;
      if (typed === "/new") {
        active = randomUUID();
        startedAt = undefined;
        writeFileSync(join(dir, `${active}.jsonl`), `${JSON.stringify({ type: "session", id: active })}\n`);
        pendingStart = { at: clock.now() + startDelay, file: join(dir, `${active}.jsonl`) };
        startPending();
        if (release?.pending) {
          const { delay, gap, dead } = release.pending;
          release = { from: clock.now() + delay, to: clock.now() + delay + gap, dead };
          syncRelease();
        }
      }
      if (typed.startsWith("Dori mode. ")) {
        prompt = typed;
        if (softEvidence) {
          mkdirSync(join(dir, "session-holders", active), { recursive: true });
          writeFileSync(join(dir, "session-holders", active, `${pid}.json`), "{}");
          appendFileSync(join(dir, `${active}.jsonl`), `${JSON.stringify({ type: "message", message: { role: "user", content: typed } })}\n`);
          utimesSync(join(dir, `${active}.jsonl`), clock.now() / 1000, clock.now() / 1000);
        }
        await onWait?.();
      }
      return ok();
    }
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = { ...depsFor(world, clock, state.dir, config), run };
  const log = () => readFileSync(join(state.dir, "lead-events.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return {
    state, deps, pane, clock, calls, log, file, world, auth,
    cold: () => { clock.at += 300_000; },
    command: () => admitted,
    session: () => active,
    softEvidence: (value: boolean) => { softEvidence = value; },
    startDelay: (ms: number) => { startDelay = ms; },
    releaseAfterNew: (delay: number, gap: number, dead = false) => { release = { from: Infinity, to: Infinity, dead, pending: { delay, gap, dead } }; },
    startedAt: () => startedAt,
    prompt: () => prompt,
    setConfirm: (value: boolean) => { confirm = value; },
    hang: (launches: number) => { hangs = launches; },
    noAgent: () => { pid = 0; pane.agent = ""; pane.agent_status = ""; },
    onWait: (callback: () => Promise<void>) => { onWait = callback; },
  };
};

/** A launch line typed into an hc terminal (`hc send <addr> -- cd <dir> && omo ...`). */
const isLaunch = (call: readonly string[]): boolean => call[0] === "hc" && call[2] === "send" && (call[5] ?? "").startsWith("cd ");
/** Text typed into an hc terminal other than a launch line (`hc send <addr> -- <text>`, one paste and Enter). */
const isTyped = (call: readonly string[]): boolean => call[0] === "hc" && call[2] === "send" && !(call[5] ?? "").startsWith("cd ");

const restartStarts = (f: ReturnType<typeof fixture>): string[][] =>
  f.calls.filter((call) => isLaunch(call) || (isTyped(call) && call[5] === "/new"));

/** The startup prompt's first instruction: every event past the take cursor is read with `dori inbox take`. */
const TAKE_FIRST = "Run dori inbox take now";
/** What `dori inbox take` prints the lead now, as `id\tline`. */
const taken = (f: ReturnType<typeof fixture>): string[] => takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }));
/**
 * What a new lead is handed, as `dori inbox take` prints it: the events past the cursor, then the cold start's carried
 * reminders. The startup prompt itself carries no event line (asserted here too). Takes, so call it once per handoff.
 */
const handed = (f: ReturnType<typeof fixture>): string => {
  expect(f.prompt()?.split("\n").filter((line) => line.startsWith("{") || /^(UNRESOLVED|UNREPORTED|LAUNCH_QUEUE) /.test(line))).toEqual([]);
  return [...taken(f), ...takeCarriedReminders(f.state.dir)].join("\n");
};

test("warm idle delivery appends once without restarting the lead", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("toodo:chat:1", "INBOUND warm");
  await supervisor.flush();
  supervisor.enqueue("toodo:chat:1", "INBOUND warm");
  await supervisor.flush();
  expect(f.log()).toEqual([{ id: "toodo:chat:1", line: "INBOUND warm" }]);
  expect(f.calls.some((call) => call[0] === "kill" || isLaunch(call))).toBe(false);
});

test("a lane's dori report question reaches the lead as an urgent LANE_REPORT within 10 s, with only a [dori] pointer typed", async () => {
  const f = fixture();
  // The lead is reached when the supervisor types its pointer.
  let pointedAt: number | undefined;
  const base = f.deps.run;
  const run: Runner = async (argv, options) => {
    if (isTyped(argv)) pointedAt ??= f.clock.now();
    return base(argv, options);
  };
  f.deps = { ...f.deps, run };
  await f.deps.registry.write({ key: "local-lane", title: "t", thread: "none", pane: "w:p7", brief: "b", done: "d", openedAt: new Date(f.clock.now()).toISOString() });
  const supervisor = new Supervisor(f.deps);
  const reports = openLaneReports(f.deps.config);
  cleanups.push(() => { reports.close(); });
  // The lane writes its rows (what `dori report` does); nothing is typed into the lead's pane.
  const written = f.clock.now();
  reports.append({ lane: "local-lane", generation: 0, kind: "milestone", text: "tests green", at: written });
  reports.append({ lane: "local-lane", generation: 0, kind: "question", text: "which\nbase branch?", at: written });
  // One polling pass routes the rows, one delivery pass hands them over.
  f.clock.at += 5_000;
  expect(await routeReports(f.deps, reports, (id, line) => supervisor.enqueue(id, line))).toEqual([
    "LANE_REPORT_ROUTED local-lane:0:1 milestone journal", "LANE_REPORT_ROUTED local-lane:0:2 question journal",
  ]);
  f.clock.at += 5_000;
  await supervisor.flush();
  expect((pointedAt ?? Number.POSITIVE_INFINITY) - written).toBeLessThanOrEqual(10_000);
  // The question wakes the lead; the milestone is digest by the policy table and waits for the next urgent delivery.
  const delivered = f.log();
  expect(delivered.some((event: { line: string }) => event.line === "LANE_REPORT local-lane question which base branch?")).toBe(true);
  expect(eventClass("LANE_REPORT local-lane question which base branch?", f.deps.tunables.eventPolicy)).toBe("lead-urgent");
  expect(eventClass("LANE_REPORT local-lane milestone tests green", f.deps.tunables.eventPolicy)).toBe("lead-digest");
  // Only the pointer is typed, never the report's text: the lead reads it with dori inbox take.
  const typedTexts = f.calls.filter((call) => isTyped(call)).map((call) => call[5] ?? "");
  expect(typedTexts).toHaveLength(1);
  expect(typedTexts[0]).toStartWith(POINTER_PREFIX);
  expect(typedTexts[0]).not.toContain("base branch");
  expect(taken(f)).toContain("lane-report:local-lane:0:2\tLANE_REPORT local-lane question which base branch?");
  // Consumed: the next pass routes nothing.
  expect(reports.pending()).toEqual([]);
  expect(await routeReports(f.deps, reports, (id, line) => supervisor.enqueue(id, line))).toEqual([]);
});

test("a forced restart takes a warm idle lead without traffic and applies model and thinking", async () => {
  const f = fixture();
  requestLeadRestart(f.deps.config, f.clock.now(), "test/forced", "high");
  const supervisor = new Supervisor(f.deps);
  await supervisor.flush();
  expect(f.calls.filter((call) => isTyped(call)).map((call) => call[5])).toContain("/model test/forced");
  expect(f.calls.filter((call) => isTyped(call)).map((call) => call[5])).toContain("/thinking high");
  expect(restartStarts(f)).toHaveLength(1);
  expect(pendingLeadRestart(f.state.dir)).toBeUndefined();
  expect(readJournal(f.state.dir).models).toEqual([{ model: "test/forced", thinking: "high" }]);
  await supervisor.flush();
  expect(restartStarts(f)).toHaveLength(1);
});

test.each(["working", "blocked", "unknown"])("a forced restart waits for a %s lead while events still deliver warm", async (status) => {
  const f = fixture();
  f.pane.agent_status = status;
  const request = requestLeadRestart(f.deps.config, f.clock.now(), "test/forced");
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("queued", "INBOUND queued");
  await supervisor.flush();
  expect(f.log()).toEqual([{ id: "queued", line: "INBOUND queued" }]);
  expect(f.calls.some((call) => call[0] === "kill" || isLaunch(call))).toBe(false);
  expect(pendingLeadRestart(f.state.dir)?.id).toBe(request.id);
  f.pane.agent_status = "idle";
  await new Supervisor(f.deps).flush();
  expect(f.calls).toContainEqual(["hc", "--json", "send", "t1", "--", "/model test/forced"]);
  expect(pendingLeadRestart(f.state.dir)).toBeUndefined();
});

test("a forced restart captures edited config and preserves a newer request arriving at startup", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  requestLeadRestart({ ...f.deps.config, leadModel: "edited/model", leadThinking: "medium" }, f.clock.now());
  f.onWait(async () => {
    f.onWait(async () => {});
    requestLeadRestart(f.deps.config, f.clock.now(), "newer/model", "high");
    f.pane.agent_status = "working";
  });
  await supervisor.flush();
  expect(f.calls).toContainEqual(["hc", "--json", "send", "t1", "--", "/model edited/model"]);
  expect(f.calls).toContainEqual(["hc", "--json", "send", "t1", "--", "/thinking medium"]);
  expect(pendingLeadRestart(f.state.dir)?.models[0]?.model).toBe("newer/model");
});

test.each([false, true])("a durable wait wakes a cold=%s lead through normal delivery", async (cold) => {
  const f = fixture();
  if (cold) f.cold();
  const file = join(f.state.dir, "ready");
  writeFileSync(file, "");
  new Waits(f.state.dir).register({ key: "release", until: `file ${file}`, note: "tell owner", cwd: f.state.dir }, f.clock.now());
  const supervisor = new Supervisor(f.deps);
  await new Waits(f.state.dir).tick(f.clock.now, f.deps.run, (id, line) => supervisor.enqueue(id, line));
  await supervisor.flush();
  expect(f.log().map((event) => event.line)).toEqual(["WAIT_DONE release tell owner"]);
  expect(restartStarts(f)).toHaveLength(cold ? 1 : 0);
});

test.each([false, true])("a close after a taken and reported claim wakes the lead at once, restart=%s between them", async (restart) => {
  const f = fixture();
  const pointers = () => f.calls.filter((call) => isTyped(call) && (call[5] ?? "").startsWith(POINTER_PREFIX)).length;
  let supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:alpha:1", "LANE_DONE_CLAIMED alpha w:p1 proof");
  await supervisor.flush();
  expect(taken(f)).toEqual(["done-claim:alpha:1\tLANE_DONE_CLAIMED alpha w:p1 proof"]);
  recordReported(f.state.dir, "alpha", f.clock.now());
  const before = pointers();
  if (restart) supervisor = new Supervisor(f.deps);
  // No other traffic: only the close can wake the lead (the lead's Toodo cleanup waits on it).
  f.clock.at += 5 * 60_000;
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha closed seen-claim https://x");
  await supervisor.flush();
  expect(pointers()).toBe(before + 1);
  expect(taken(f)).toEqual(["lane-closed:alpha\tLANE_CLOSED alpha closed seen-claim https://x"]);
});

const MERGED_7 = "CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x/7";

/** Enqueues each step's events, flushes, and returns how many pointers that flush sent and what the lead then takes. */
const finishSteps = async (steps: readonly (readonly (readonly [string, string])[])[], restartAt = -1) => {
  const f = fixture();
  const pointers = () => f.calls.filter((call) => isTyped(call) && (call[5] ?? "").startsWith(POINTER_PREFIX)).length;
  let supervisor = new Supervisor(f.deps);
  const seen: { pointers: number; taken: string[] }[] = [];
  for (const [i, step] of steps.entries()) {
    if (i === restartAt) supervisor = new Supervisor(f.deps);
    f.clock.at += 60_000;
    const before = pointers();
    for (const [id, line] of step) supervisor.enqueue(id, line);
    await supervisor.flush();
    seen.push({ pointers: pointers() - before, taken: taken(f).map((row) => row.split("\t")[0] ?? "") });
  }
  return seen;
};

test.each([-1, 1, 2])("one lane's claim, merge and close: the claim and the close wake the lead, the merge rides with the close (restart before step %i)", async (restartAt) => {
  expect(await finishSteps([
    [["done-claim:alpha:1", "LANE_DONE_CLAIMED alpha w:p1 proof"]],
    [["ci-merged:acme/app#7", MERGED_7]],
    [["lane-closed:alpha", "LANE_CLOSED alpha closed seen-claim https://x/7"]],
  ], restartAt)).toEqual([
    { pointers: 1, taken: ["done-claim:alpha:1"] },
    { pointers: 0, taken: ["INBOX_EMPTY"] },
    { pointers: 1, taken: ["ci-merged:acme/app#7", "lane-closed:alpha"] },
  ]);
});

test("a merge that brings something new still wakes the lead: before the claim, after an objection, at another PR head", async () => {
  const claim = ["done-claim:alpha:1", "LANE_DONE_CLAIMED alpha w:p1 proof"] as const;
  // Merge first: the merge is the lane's first finish news, and the later claim is one the lead may object to.
  expect((await finishSteps([[["ci-merged:acme/app#7", MERGED_7]], [claim]])).map((step) => step.pointers)).toEqual([1, 1]);
  // An objection drops the claim's record: a merge after it is news again.
  expect((await finishSteps([[claim], [["not-done:alpha", "LANE_NOT_DONE alpha checks red"]], [["ci-merged:acme/app#7", MERGED_7]]])).map((step) => step.pointers)).toEqual([1, 1, 1]);
  // A second PR merged at a head the record has not seen.
  expect((await finishSteps([[claim], [["ci-merged:acme/app#7", MERGED_7]],
    [["ci-merged:acme/app#8", "CI_MERGED acme/app#8 into dev lane=alpha head=fed merge=cba https://x/8"]]])).map((step) => step.pointers)).toEqual([1, 0, 1]);
});

test("one lane result wakes the lead once: a finished close and the autopilot outcome ride with the wake the merge or claim made", async () => {
  const claim = ["done-claim:alpha:1", "LANE_DONE_CLAIMED alpha w:p1 proof"] as const;
  const autopilotDone = ["autopilot-outcome:alpha", "AUTOPILOT_LANE_DONE #12 lane=alpha attempt=1: complete toodo task #12"] as const;
  // An unclaimed lane: the merge wakes, the close whose task the supervisor finished does not.
  expect((await finishSteps([[["ci-merged:acme/app#7", MERGED_7]], [["lane-closed:alpha", "LANE_CLOSED alpha closed toodo=done https://x/7"]]], 1))
    .map((step) => step.pointers)).toEqual([1, 0]);
  // A claimed autopilot lane: the claim wakes; the merge, the finished close and the autopilot outcome do not.
  expect((await finishSteps([[claim], [["ci-merged:acme/app#7", MERGED_7]],
    [["lane-closed:alpha", "LANE_CLOSED alpha closed seen-claim toodo=done https://x/7"], autopilotDone]], 2)).map((step) => step.pointers)).toEqual([1, 0, 0]);
  // Claim and close pending together are one wake.
  expect((await finishSteps([[claim, ["lane-closed:alpha", "LANE_CLOSED alpha closed toodo=done https://x/7"], autopilotDone]])).map((step) => step.pointers)).toEqual([1]);
  // A lane with no Toodo task: after the claim's wake its close is news only; after a merge's wake too.
  expect((await finishSteps([[claim], [["lane-closed:alpha", "LANE_CLOSED alpha closed seen-claim toodo=no-task https://x/7"]]])).map((step) => step.pointers)).toEqual([1, 0]);
  expect((await finishSteps([[["ci-merged:acme/app#7", MERGED_7]], [["lane-closed:alpha", "LANE_CLOSED alpha closed toodo=no-task https://x/7"]]])).map((step) => step.pointers)).toEqual([1, 0]);
  // With no earlier wake, a no-task close is the lane's first result and wakes the lead.
  expect((await finishSteps([[["lane-closed:alpha", "LANE_CLOSED alpha closed toodo=no-task https://x/7"]]])).map((step) => step.pointers)).toEqual([1]);
});

test("a lane result the lead still has work on wakes it again: an unfinished task, a failed autopilot lane, an outcome with no earlier wake", async () => {
  const claim = ["done-claim:alpha:1", "LANE_DONE_CLAIMED alpha w:p1 proof"] as const;
  expect((await finishSteps([[claim], [["lane-closed:alpha", "LANE_CLOSED alpha closed seen-claim toodo=failed https://x/7"],
    ["task-finish:alpha", "TOODO_TASK_NOT_COMPLETED alpha #12 toodo: refused; finish it yourself"]]])).map((step) => step.pointers)).toEqual([1, 1]);
  expect((await finishSteps([[["ci-merged:acme/app#7", MERGED_7]], [["autopilot-outcome:alpha", "AUTOPILOT_LANE_FAILED #12 lane=alpha attempt=1 cancelled: gave up: tell the owner"]]]))
    .map((step) => step.pointers)).toEqual([1, 1]);
  expect((await finishSteps([[["autopilot-outcome:alpha", "AUTOPILOT_LANE_DONE #12 lane=alpha attempt=1: complete toodo task #12"]]])).map((step) => step.pointers)).toEqual([1]);
});

test("a cold lead's prompt names SKILL.md and human.md by absolute path, or says human.md could not be resolved", async () => {
  const home = withState();
  cleanups.push(home.done);
  const repo = join(home.dir, "memory");
  const before = process.env.HOME;
  // An empty home has no omo memory repo for the lead's cwd.
  process.env.HOME = home.dir;
  cleanups.push(() => { process.env.HOME = before; });
  for (const [memoryCheck, memory] of [
    [{ repo }, `then your memory file ${join(repo, "system", "human.md")} in full`],
    [{ repo: "" }, `its path could not be resolved (memoryCheck.repo is unset and no omo memory repo exists for /repo under ${join(home.dir, ".omo", "memory", "agents")})`],
  ] as const) {
    const f = fixture({ memoryCheck });
    f.cold();
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("cold", "INBOUND cold");
    await supervisor.flush();
    const first = (f.prompt() ?? "").split("\n")[0] ?? "";
    expect(first).toContain(`read ${LEAD_SKILL} in full`);
    expect(first).toContain(memory);
  }
});

test("an unseen newly idle agent reported as done is positive startup evidence", async () => {
  const f = fixture();
  f.cold();
  f.onWait(async () => { f.pane.agent_status = "done"; });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-state", "INBOUND done-state");
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).toEqual(["done-state"]);
  expect(readJournal(f.state.dir).restart).toBeUndefined();
});

test("at the TTL boundary cold delivery starts a fresh session in the same pane and stops only owned processes", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("cold", "INBOUND cold");
  await supervisor.flush();
  expect(f.log()).toEqual([{ id: "cold", line: "INBOUND cold" }]);
  expect(f.prompt()).toContain(TAKE_FIRST);
  const launched = restartStarts(f);
  expect(launched).toHaveLength(1);
  expect(launched[0]?.[3]).toBe("t1");
  expect(f.calls.filter((call) => isLaunch(call))).toEqual([]);
  expect(f.calls.filter((call) => call[0] === "kill").map((call) => call[2])).toEqual(["103"]);
  expect(f.prompt()).toContain(`tail -c +${Buffer.byteLength(`${JSON.stringify(f.log()[0])}\n`) + 1}`);
  expect(taken(f)).toEqual(["cold\tINBOUND cold"]);
});

test("a stale lead with a pending durable wait is cold-started and the wait survives for the fresh lead", async () => {
  const f = fixture();
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait-active", "INBOUND owner");
  await supervisor.flush();
  expect(restartStarts(f)).toHaveLength(1);
  expect(f.log().map((event) => event.id)).toEqual(["wait-active"]);
  expect(new Waits(f.state.dir).list()).toHaveLength(1);
});

test("a stale lead with a working registry lane is cold-started and the lane keeps working", async () => {
  const f = fixture();
  await f.deps.registry.write({
    key: "working", title: "Working lane", thread: "discord:1/2", brief: "/brief",
    done: 'command ["true"]', openedAt: "2026-10-19T00:00:00Z", status: "working",
  });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane-active", "INBOUND owner");
  await supervisor.flush();
  expect(restartStarts(f)).toHaveLength(1);
  expect(f.log().map((event) => event.id)).toEqual(["lane-active"]);
  expect((await f.deps.registry.read("working"))?.status).toBe("working");
});

test.each([
  [249_999, "stale"], [250_000, "context-cap"], [250_001, "context-cap"],
] as const)("stale usage %s restarts as %s despite waits and working lanes", async (tokens, kind) => {
  const f = fixture();
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  await f.deps.registry.write({
    key: "working", title: "Working lane", thread: "discord:1/2", brief: "/brief",
    done: 'command ["true"]', openedAt: "2026-10-19T00:00:00Z", status: "working",
  });
  writeFileSync(f.file, [
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 300_000 } } }),
    JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: tokens } } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }),
  ].join("\n") + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  f.cold();
  const lines = await quiet(async () => {
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("cap", "INBOUND owner");
    await supervisor.flush();
  });
  expect(restartStarts(f)).toHaveLength(1);
  expect(lines.some((line) => line.startsWith(`LEAD_RESTART_TRIGGER ${kind} `))).toBe(true);
  expect(f.log().map((event) => event.id)).toEqual(["cap"]);
  expect(new Waits(f.state.dir).list()).toHaveLength(1);
});

test("a custom context cap controls stale delivery rather than the default cap", async () => {
  const f = fixture({ leadContextCapTokens: 42_000 });
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  writeFileSync(f.file, JSON.stringify({ message: { usage: { totalTokens: 50_000 } } }) + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("custom-cap", "INBOUND owner");
  await supervisor.flush();
  expect(restartStarts(f)).toHaveLength(1);
});

test.each([
  [249_999, false], [250_000, true], [300_000, true],
] as const)("usage %s with a warm cache restarts=%s as context-cap", async (tokens, restart) => {
  const f = fixture();
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  writeFileSync(f.file, JSON.stringify({ message: { usage: { totalTokens: tokens } } }) + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  const lines = await quiet(async () => {
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("fresh-cap", "INBOUND owner");
    await supervisor.flush();
  });
  expect(restartStarts(f)).toHaveLength(restart ? 1 : 0);
  expect(lines.some((line) => line.startsWith(`LEAD_RESTART_TRIGGER context-cap context ${tokens} tokens at or above leadContextCapTokens 250000`) && line.includes("cache warm"))).toBe(restart);
  expect(f.log().map((event) => event.id)).toEqual(["fresh-cap"]);
});

test("a warm lead over the context cap waiting on its own child restarts only once the child is done", async () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ message: { usage: { totalTokens: 260_000 } } }) + "\n" + lifecycle(1, f.clock.now()));
  const supervisor = new Supervisor(f.deps);
  const lines = await quiet(async () => {
    supervisor.enqueue("over-cap", "INBOUND over-cap");
    await supervisor.flush();
  });
  expect(restarted(f)).toEqual([]);
  expect(lines.some((line) => line.startsWith("LEAD_RESTART_DEFERRED context-cap context 260000 tokens"))).toBe(true);
  appendFileSync(f.file, lifecycle(0, f.clock.now()));
  const after = await quiet(async () => {
    supervisor.enqueue("over-cap-2", "INBOUND over-cap-2");
    await supervisor.flush();
  });
  expect(restartStarts(f)).toHaveLength(1);
  expect(after.some((line) => line.startsWith("LEAD_RESTART_TRIGGER context-cap context 260000 tokens"))).toBe(true);
});

test("a warm lead under a raised context cap takes delivery in place at any usage below it", async () => {
  const f = fixture({ leadContextCapTokens: 1_000_000 });
  writeFileSync(f.file, JSON.stringify({ message: { usage: { totalTokens: 600_000 } } }) + "\n");
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  const lines = await quiet(async () => {
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("under-cap", "INBOUND owner");
    await supervisor.flush();
  });
  expect(restartStarts(f)).toHaveLength(0);
  expect(lines.some((line) => line.startsWith("LEAD_RESTART_TRIGGER"))).toBe(false);
  expect(f.log().map((event) => event.id)).toEqual(["under-cap"]);
});

/** An omo session-lifecycle entry: the lead waits on `children` child tasks and `background` sources since `since`. */
const lifecycle = (children: number, since: number, background: { source: string; activeCount: number }[] = []): string =>
  JSON.stringify({
    type: "custom", customType: "session-lifecycle", timestamp: new Date(since).toISOString(),
    data: { state: children ? "waiting_children" : "done", since: new Date(since).toISOString(), waitingOn: { children, background, human: [] } },
  }) + "\n";

const restarted = (f: ReturnType<typeof fixture>): string[][] => f.calls.filter((call) => isLaunch(call) || call[0] === "kill");

test("a lead's own child work is read from its newest session-lifecycle entry; monitors and deliveries are not its children", () => {
  const f = fixture();
  const at = f.clock.now();
  writeFileSync(f.file, lifecycle(0, at, [{ source: "terminal-monitors", activeCount: 1 }, { source: "delivery:senpi-task.send-outcome", activeCount: 2 }]));
  expect(childWork(f.file)).toBeUndefined();
  appendFileSync(f.file, lifecycle(2, at, [{ source: "senpi-codemode", activeCount: 1 }, { source: "terminal-monitors", activeCount: 1 }]));
  expect(childWork(f.file)).toEqual({ children: 2, background: 1, since: at });
  appendFileSync(f.file, JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }) + "\n");
  expect(childWork(f.file)?.children).toBe(2);
  appendFileSync(f.file, lifecycle(0, at + 1));
  expect(childWork(f.file)).toBeUndefined();
});

test("a lead-restart request waits while the idle lead waits on its own child, and applies once the child is done", async () => {
  const f = fixture();
  writeFileSync(f.file, lifecycle(1, f.clock.now()));
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  const request = requestLeadRestart(f.deps.config, f.clock.now(), "test/forced");
  const supervisor = new Supervisor(f.deps);
  const lines = await quiet(async () => {
    supervisor.enqueue("child-running", "INBOUND child-running");
    await supervisor.flush();
    await supervisor.flush();
  });
  expect(restarted(f)).toEqual([]);
  expect(f.log().map((event) => event.id)).toEqual(["child-running"]);
  expect(pendingLeadRestart(f.state.dir)?.id).toBe(request.id);
  expect(lines.filter((line) => line.startsWith(`LEAD_RESTART_DEFERRED request ${request.id}`))).toHaveLength(1);
  appendFileSync(f.file, lifecycle(0, f.clock.now()));
  const after = await quiet(() => supervisor.flush());
  expect(f.calls).toContainEqual(["hc", "--json", "send", "t1", "--", "/model test/forced"]);
  expect(pendingLeadRestart(f.state.dir)).toBeUndefined();
  expect(after.filter((line) => line.startsWith(`LEAD_RESTART_TRIGGER request dori lead-restart ${request.id}`))).toHaveLength(1);
});

test.each([[59, false], [60, true]] as const)("a child wait of %s min against leadChildWaitMaxMin 60 lets the request through=%s", async (minutes, restart) => {
  const f = fixture();
  writeFileSync(f.file, lifecycle(1, f.clock.now() - minutes * 60_000));
  requestLeadRestart(f.deps.config, f.clock.now(), "test/forced");
  const lines = await quiet(() => new Supervisor(f.deps).flush());
  expect(restartStarts(f)).toHaveLength(restart ? 1 : 0);
  expect(lines.some((line) => line.startsWith("LEAD_CHILD_WAIT_EXPIRED request"))).toBe(restart);
  expect(lines.some((line) => line.startsWith("LEAD_RESTART_DEFERRED request"))).toBe(!restart);
});

test.each([true, false])("a stale idle lead with a running child=%s takes the event in place instead of a cold start", async (child) => {
  const f = fixture();
  writeFileSync(f.file, child ? lifecycle(1, f.clock.now()) : lifecycle(0, f.clock.now()));
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  f.cold();
  const lines = await quiet(async () => {
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("stale", "INBOUND stale");
    await supervisor.flush();
  });
  expect(restartStarts(f)).toHaveLength(child ? 0 : 1);
  expect(f.log().map((event) => event.id)).toEqual(["stale"]);
  expect(lines.some((line) => line.startsWith("LEAD_RESTART_DEFERRED stale idle 5 min"))).toBe(child);
  expect(lines.some((line) => line.startsWith("LEAD_RESTART_TRIGGER stale idle 5 min (past cacheTtlMin 5)"))).toBe(!child);
});

test.each([
  "not json\n",
  '{"message":{"role":"toolResult"}}\n',
  '{"message":{"usage":{"totalTokens":"200000"}}}\n',
  '{"message":{"usage":null}}\n',
  '{"message":{"usage":{"totalTokens":-1}}}\n',
])("unreadable usage is under-cap for a stale lead with a wait: %s", async (text) => {
  // Under-cap: the stale restart is named stale, never context-cap.
  const f = fixture();
  new Waits(f.state.dir).register({ key: "release", until: "file absent", note: "tell owner", cwd: f.state.dir }, f.clock.now());
  writeFileSync(f.file, text);
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  f.cold();
  const lines = await quiet(async () => {
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("unreadable", "INBOUND owner");
    await supervisor.flush();
  });
  expect(restartStarts(f)).toHaveLength(1);
  expect(lines.some((line) => line.startsWith("LEAD_RESTART_TRIGGER stale "))).toBe(true);
  expect(lines.some((line) => line.startsWith("LEAD_RESTART_TRIGGER context-cap "))).toBe(false);
});

test.each(["paused", "done-claimed", "not-done", "closed"] as const)("a %s lane does not retain a stale lead", async (status) => {
  const f = fixture();
  await f.deps.registry.write({
    key: "inactive", title: "Inactive lane", thread: "discord:1/2", brief: "/brief",
    done: 'command ["true"]', openedAt: "2026-10-19T00:00:00Z", status,
  });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("inactive-lane", "INBOUND owner");
  await supervisor.flush();
  expect(restartStarts(f)).toHaveLength(1);
});

test("an expired but working lead receives an append and is never stopped", async () => {
  const f = fixture();
  f.cold();
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("working", "INBOUND working");
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).toEqual(["working"]);
  expect(f.calls.some((call) => call[0] === "kill" || isLaunch(call))).toBe(false);
});

test("events arriving during restart stay queued and follow the prompt handoff exactly once", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("first", "INBOUND first");
  f.onWait(async () => {
    supervisor.enqueue("second", "INBOUND second");
    f.pane.agent_status = "working";
  });
  await Promise.all([supervisor.flush(), supervisor.flush()]);
  expect(f.log().map((event) => event.id)).toEqual(["first", "second"]);
  // Neither is inline (not owner messages): the new lead's first take prints each exactly once.
  expect(f.prompt()).toContain(TAKE_FIRST);
  expect(f.prompt()).not.toContain('"id":"first"');
  expect(f.prompt()).not.toContain('"id":"second"');
  expect(restartStarts(f)).toHaveLength(1);
  expect(taken(f)).toEqual(["first\tINBOUND first", "second\tINBOUND second"]);
  expect(taken(f)).toEqual(["INBOX_EMPTY"]);
});

const restartSession = (f: ReturnType<typeof fixture>) => readJournal(f.state.dir).restart;
const launchedSessions = (f: ReturnType<typeof fixture>) => f.calls.filter((call) => isLaunch(call)).map((call) => /--session-id ([\w-]+)/.exec(call[5] ?? "")?.[1]);

test.each(["idle", "done"])("an %s cold lead switches session, model and thinking without relaunching omo", async (status) => {
  // Given a reusable process; even its own environment and its shell must survive cleanup.
  const f = fixture({ leadModel: { model: "test/other", thinking: "high" } });
  f.cold();
  f.pane.agent_status = status;
  const old = f.session();
  const base = f.deps.run;
  const run: Runner = async (argv, options) => {
    if (argv[0] === "ps" && argv[1] === "eww") return { code: 0, out: `PI_SESSION_ID=${["101", "10"].includes(argv.at(-1) ?? "") ? old : "other"}`, err: "" };
    return base(argv, options);
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("soft", "INBOUND soft");
  // When the cold delivery restarts it.
  const lines = await quiet(() => supervisor.flush());
  // Then the four submissions are ordered and all confirmation uses the actual new id.
  const texts = f.calls.filter((call) => isTyped(call) && !call[5]?.startsWith(POINTER_PREFIX)).map((call) => call[5]);
  expect(texts.slice(0, 3)).toEqual(["/new", "/model test/other", "/thinking high"]);
  expect(texts).toHaveLength(4);
  // The prompt itself is typed, on one line; no prompt file exists for the new lead to miss.
  expect(texts[3]).toStartWith("Dori mode. ");
  expect(texts[3]).toContain(TAKE_FIRST);
  expect(texts[3]).not.toContain("\n");
  expect(f.calls.some((call) => isTyped(call) && /lead-[0-9a-f-]{36}\.md/.test(call[5] ?? ""))).toBe(false);
  expect(readdirSync(f.state.dir).filter((name) => /^lead-.*\.md$/.test(name))).toEqual([]);
  expect(f.session()).not.toBe(old);
  expect(f.calls.filter((call) => isLaunch(call))).toEqual([]);
  expect(f.calls.filter((call) => call[0] === "kill")).toEqual([]);
  expect(lines).toContain(`LEAD_SOFT_RESTARTED hc:t1 ${f.session()}`);
  expect(lines).toContain(`LEAD_RESTARTED hc:t1 ${f.session()}`);
  expect(readWakes(f.state.dir, 0).at(-1)?.session).toBe(f.session());
  // argv still names the old session: a later event must nevertheless reach the new, warm session.
  supervisor.enqueue("after", "INBOUND after");
  await supervisor.flush();
  expect(restartStarts(f)).toHaveLength(1);
});

test("a soft restart without a new session file falls back to a process launch", async () => {
  // Given a live idle process that accepts commands but never persists the prompt.
  const f = fixture();
  f.cold();
  f.softEvidence(false);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("fallback", "INBOUND fallback");
  const before = f.clock.now();
  // When its evidence deadline expires.
  const lines = await quiet(() => supervisor.flush());
  // Then the same batch is launched once through the hard path.
  expect(f.clock.now() - before).toBeGreaterThanOrEqual(20_000);
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(1);
  expect(f.calls.filter((call) => call[0] === "kill").map((call) => call[2])).toContain("101");
  expect(lines.filter((line) => line.startsWith("LEAD_SOFT_RESTART_FAILED "))).toHaveLength(1);
  expect(lines.some((line) => line.endsWith("; falling back to a process restart"))).toBe(true);
  expect(f.log()).toEqual([{ id: "fallback", line: "INBOUND fallback" }]);
  expect(restartSession(f)).toBeUndefined();
});

test("a soft restart types nothing after /new until the new session has started", async () => {
  // Given omo back at its editor right after /new while the new session is still starting for three seconds.
  const f = fixture({ leadModel: { model: "test/other", thinking: "high" } });
  f.cold();
  f.startDelay(3_000);
  const base = f.deps.run;
  const sends: [string, number, number | undefined][] = [];
  const run: Runner = async (argv, options) => {
    if (argv[0] === "ps" && argv[1] === "eww") return { code: 0, out: "PI_SESSION_ID=other", err: "" };
    if (isTyped(argv) && argv[5] !== "/new" && !argv[5]?.startsWith(POINTER_PREFIX)) sends.push([argv[5] ?? "", f.clock.now(), f.startedAt()]);
    return base(argv, options);
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("soft-start", "INBOUND soft");
  // When the cold delivery restarts it in place.
  const lines = await quiet(() => supervisor.flush());
  // Then /model, /thinking and the prompt are typed only once the new session has started and settled.
  expect(sends.map(([text]) => text.split(" ")[0])).toEqual(["/model", "/thinking", "Dori"]);
  for (const [, at, started] of sends) expect(at - (started ?? Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(SOFT_SESSION_SETTLE_MS);
  expect(lines).toContain(`LEAD_SOFT_RESTARTED hc:t1 ${f.session()}`);
  expect(f.calls.filter((call) => isLaunch(call))).toEqual([]);
});

test("a /new session that never starts falls back to a process launch without typing more", async () => {
  // Given omo that accepts /new but never starts the new session.
  const f = fixture({ leadModel: { model: "test/soft", thinking: "high" } });
  f.cold();
  f.startDelay(Number.POSITIVE_INFINITY);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("soft-stall", "INBOUND stall");
  // When its start deadline expires.
  const lines = await quiet(() => supervisor.flush());
  // Then no further command is typed into it and the batch is launched once through the hard path.
  expect(f.calls.filter((call) => isTyped(call) && /^\/(model|thinking) |^Dori mode\. /.test(call[5] ?? ""))).toEqual([]);
  expect(lines.filter((line) => line.startsWith("LEAD_SOFT_RESTART_FAILED new session did not start after /new"))).toHaveLength(1);
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(1);
  expect(f.log()).toEqual([{ id: "soft-stall", line: "INBOUND stall" }]);
});

test.each([
  ["a bare model the session already runs", { model: "soft", thinking: "high" }, undefined, ["/thinking high"]],
  ["a bare model the session does not run", { model: "other", thinking: "high" }, "test/default", ["/model test/other", "/thinking high"]],
  ["the qualified model the session already runs", { model: "test/soft", thinking: "high" }, undefined, ["/thinking high"]],
] as const)("a soft restart compares and types %s as provider/model", async (_name, leadModel, defaultModel, commands) => {
  // Given a lead model from the config, journal or lead-restart, while the /new session runs test/soft.
  const f = fixture({ leadModel, ...(defaultModel ? { defaultModel } : {}) });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("soft-model", "INBOUND model");
  // When the cold delivery restarts it in place.
  const lines = await quiet(() => supervisor.flush());
  // Then only a differing value is typed, and a model always with its provider.
  const texts = f.calls.filter((call) => isTyped(call) && !call[5]?.startsWith(POINTER_PREFIX)).map((call) => call[5]);
  expect(texts.slice(1, -1)).toEqual([...commands]);
  expect(lines).toContain(`LEAD_SOFT_RESTARTED hc:t1 ${f.session()}`);
});

test("a bare lead-restart model is stored with the configured provider", () => {
  const state = withState();
  cleanups.push(state.done);
  const config = { ...defaultConfig(state.dir), leadModel: "anthropic-subscription/claude-opus-5-5" };
  expect(requestLeadRestart(config, 1, "claude-opus-5-6", "low").models).toEqual([{ model: "anthropic-subscription/claude-opus-5-6", thinking: "low" }]);
  expect(requestLeadRestart(config, 2, "openai/gpt-6").models).toEqual([{ model: "openai/gpt-6" }]);
});

test("a soft restart waits out the agent release gap while omo switches to the /new session", async () => {
  // Given omo whose pane shows no agent from one second after /new until three seconds after it.
  const f = fixture({ leadModel: { model: "test/other", thinking: "high" } });
  f.cold();
  f.releaseAfterNew(1_000, 2_000);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("soft-gap", "INBOUND gap");
  // When the cold delivery restarts it in place.
  const lines = await quiet(() => supervisor.flush());
  // Then the same process is reused: nothing is killed or launched.
  expect(lines).toContain(`LEAD_SOFT_RESTARTED hc:t1 ${f.session()}`);
  expect(lines.some((line) => line.startsWith("LEAD_SOFT_RESTART_FAILED "))).toBe(false);
  expect(f.calls.filter((call) => isLaunch(call))).toEqual([]);
  expect(f.calls.filter((call) => call[0] === "kill").map((call) => call[2])).not.toContain("101");
});

test.each([["dead", 1_000, Infinity, true], ["missing past the grace", 1_000, 60_000, false]] as const)("a lead %s after /new falls back to one process launch", async (_name, delay, gap, dead) => {
  // Given omo that exits after /new, or whose agent never comes back.
  const f = fixture({ leadModel: { model: "test/other", thinking: "high" } });
  f.cold();
  f.releaseAfterNew(delay, gap, dead);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("soft-dead", "INBOUND dead");
  const before = f.clock.now();
  // When the cold delivery restarts it.
  const lines = await quiet(() => supervisor.flush());
  // Then a dead process fails the soft path at once, a missing agent only after the grace, and one launch follows.
  const failed = lines.filter((line) => line.startsWith("LEAD_SOFT_RESTART_FAILED "));
  expect(failed).toHaveLength(1);
  expect(failed[0]).toContain("reused lead is not live");
  if (dead) expect(f.clock.now() - before).toBeLessThan(SOFT_RELEASE_GRACE_MS);
  else expect(f.clock.now() - before).toBeGreaterThanOrEqual(SOFT_RELEASE_GRACE_MS);
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(1);
  expect(f.log()).toEqual([{ id: "soft-dead", line: "INBOUND dead" }]);
  expect(restartSession(f)).toBeUndefined();
});

test("a soft fallback preserves the journaled offset and records each batch event once", async () => {
  // Given a soft entry whose log grows after its offset was journaled.
  const f = fixture();
  f.cold();
  const base = f.deps.run;
  let offset: number | undefined;
  const run: Runner = async (argv, options) => {
    if (isTyped(argv) && argv[5] === "/new") {
      offset = restartSession(f).offset;
      appendFileSync(join(f.state.dir, "lead-events.log"), `${JSON.stringify({ id: "later", line: "INBOUND later" })}\n`);
      return { code: 1, out: "", err: "send failed" };
    }
    return base(argv, options);
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("first", "INBOUND first");
  supervisor.enqueue("second", "INBOUND second");
  // When the first command fails and a hard launch takes over.
  await quiet(() => supervisor.flush());
  // Then neither batch recording nor the soft-entry tail offset is repeated.
  expect(f.log()).toEqual([
    { id: "first", line: "INBOUND first" }, { id: "second", line: "INBOUND second" }, { id: "later", line: "INBOUND later" },
  ]);
  expect(offset).toBeGreaterThan(0);
  expect(f.prompt()).toContain(`tail -c +${(offset ?? 0) + 1} -F`);
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(1);
});

test.each([false, true])("a live omo blocks hard launch after soft failure, recovery=%s", async (recovery) => {
  // Given a soft failure before /new, or its recovered intent, and kills that have not taken effect.
  const f = fixture();
  f.cold();
  const event = { id: "guarded", line: "INBOUND guarded" };
  if (recovery) {
    const log = `${JSON.stringify(event)}\n`;
    writeFileSync(join(f.state.dir, "lead-events.log"), log);
    writeJournal(f.state.dir, {
      events: [event], restart: { session: randomUUID(), events: [event], offset: Buffer.byteLength(log), phase: "soft-failed" },
    });
  }
  const old = f.session();
  const base = f.deps.run;
  const kills: string[][] = [];
  const run: Runner = async (argv, options) => {
    if (argv[0] === "kill") {
      kills.push([...argv]);
      return { code: 0, out: "", err: "" };
    }
    // hc types and submits in one call: a failed send of /new reaches nothing.
    return isTyped(argv) && argv[5] === "/new" ? { code: 1, out: "", err: "send failed before /new" } : base(argv, options);
  };
  const deps = { ...f.deps, run };
  const supervisor = new Supervisor(deps);
  if (!recovery) supervisor.enqueue(event.id, event.line);
  // When forced cleanup still reports omo in the foreground.
  await expect(quiet(() => supervisor.flush())).rejects.toBeInstanceOf(TransientSuperviseError);
  // Then launch was not typed, and the same transaction remains retryable with its events.
  expect(kills.some((call) => call[2] === "101")).toBe(true);
  expect(f.session()).toBe(old);
  expect(f.calls.filter((call) => isLaunch(call))).toEqual([]);
  expect(restartSession(f)).toMatchObject({ phase: "soft-failed", events: [event] });
  expect(f.log()).toEqual([event]);
  // Once the shell actually returns, recovery can admit exactly one launch.
  f.noAgent();
  await quiet(() => new Supervisor(deps).flush());
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(1);
  expect(restartSession(f)).toBeUndefined();
  expect(f.log()).toEqual([event]);
});

test("a soft restart ignores existing quota lines during commands and quota text after the prompt", async () => {
  // Given normal output mentioning quota before /new and after the startup prompt.
  const f = fixture({ leadModel: { model: "test/other", thinking: "high" } });
  f.cold();
  f.world.screen = "Discussion of quota and rate limit handling\n❯ ";
  f.onWait(async () => { f.world.screen = "Startup prompt read: quota and rate limit handling\n❯ "; });
  const base = f.deps.run;
  const run: Runner = async (argv, options) => argv[0] === "ps" && argv[1] === "eww"
    ? { code: 0, out: "PI_SESSION_ID=other", err: "" } : base(argv, options);
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("soft-quota-text", "INBOUND soft");
  // When the new session persists the prompt pointer.
  const lines = await quiet(() => supervisor.flush());
  // Then live session evidence succeeds without killing or relaunching omo.
  expect(lines).toContain(`LEAD_SOFT_RESTARTED hc:t1 ${f.session()}`);
  expect(lines.some((line) => line.startsWith("LEAD_SOFT_RESTART_FAILED "))).toBe(false);
  expect(f.calls.filter((call) => call[0] === "kill")).toEqual([]);
  expect(f.calls.filter((call) => isLaunch(call))).toEqual([]);
  expect(f.calls.filter((call) => isTyped(call)).map((call) => call[5]).slice(0, 3)).toEqual([
    "/new", "/model test/other", "/thinking high",
  ]);
});

test("a soft command whose first Enter only accepts the autocomplete is entered again before the next command", async () => {
  // Given omo's editor: typed text shows on the prompt line, and a command with an argument opens an autocomplete
  // whose first Enter accepts the selection without submitting.
  const f = fixture({ leadModel: { model: "test/other", thinking: "high" } });
  f.cold();
  f.world.screen = "❯ ";
  const base = f.deps.run;
  let editor = "";
  let popup = false;
  const submitted: string[] = [];
  const run: Runner = async (argv, options) => {
    if (argv[0] === "ps" && argv[1] === "eww") return { code: 0, out: "PI_SESSION_ID=other", err: "" };
    // hc pastes the text and presses Enter in one `send`; `keys` presses Enter again.
    if (isTyped(argv)) {
      editor += argv[5] ?? "";
      popup = editor.startsWith("/") && editor.includes(" ");
    }
    if (isTyped(argv) || (argv[0] === "hc" && argv[2] === "keys")) {
      if (popup) {
        popup = false;
        f.pane.revision++;
        f.world.screen = `❯ ${editor}`;
        f.calls.push([...argv]);
        return { code: 0, out: "", err: "" };
      }
      submitted.push(editor);
      editor = "";
    }
    const result = await base(argv, options);
    f.world.screen = `❯ ${editor}`;
    return result;
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("soft-popup", "INBOUND soft");
  // When the cold delivery restarts it in place.
  const lines = await quiet(() => supervisor.flush());
  // Then each command is submitted on its own line and the soft restart succeeds.
  expect(submitted.slice(0, 3)).toEqual(["/new", "/model test/other", "/thinking high"]);
  expect(submitted[3]).toStartWith("Dori mode. ");
  expect(lines).toContain(`LEAD_SOFT_RESTARTED hc:t1 ${f.session()}`);
  expect(f.calls.filter((call) => isLaunch(call))).toEqual([]);
});

test.each([false, true])("soft evidence only accepts prompt files modified at or after soft entry, stale=%s", async (stalePrompt) => {
  // Given a historical jsonl that cannot be read as a regular file.
  const f = fixture();
  f.cold();
  const stale = join(dirname(f.file), `${randomUUID()}.jsonl`);
  mkdirSync(stale);
  utimesSync(stale, (f.clock.now() - 1) / 1000, (f.clock.now() - 1) / 1000);
  const startedAt = f.clock.now();
  let promptWritten = false;
  if (stalePrompt) f.onWait(async () => {
    if (promptWritten) return;
    promptWritten = true;
    const file = join(dirname(f.file), `${f.session()}.jsonl`);
    utimesSync(file, (startedAt - 1) / 1000, (startedAt - 1) / 1000);
  });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("mtime", "INBOUND mtime");
  // When the prompt file's mtime is either just before or exactly at soft entry.
  const lines = await quiet(() => supervisor.flush());
  // Then only current evidence confirms; stale evidence exhausts the bounded deadline.
  expect(lines.some((line) => line.startsWith("LEAD_SOFT_RESTARTED "))).toBe(!stalePrompt);
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(stalePrompt ? 1 : 0);
  if (stalePrompt) expect(f.clock.now() - startedAt).toBeGreaterThanOrEqual(20_000);
  expect(f.clock.now() - startedAt).toBeLessThan(30_000);
});

test.each([false, true])("a missing held-session jsonl is skipped during restart, force=%s", async (force) => {
  // Given a scanned holder whose jsonl cannot be statted because its target disappeared.
  const f = fixture();
  f.cold();
  const missing = randomUUID();
  const dir = dirname(f.file);
  mkdirSync(join(dir, "session-holders", missing), { recursive: true });
  writeFileSync(join(dir, "session-holders", missing, "101.json"), "{}");
  symlinkSync(join(dir, "removed-session"), join(dir, `${missing}.jsonl`));
  writeJournal(f.state.dir, {
    events: [], restart: { session: randomUUID(), events: [], offset: 0, phase: "stopping", force },
  });
  // When sessionFile (soft) or stopLead (hard) resolves the current session.
  await quiet(() => new Supervisor(f.deps).flush());
  // Then the absent file does not abort either restart path.
  expect(restartSession(f)).toBeUndefined();
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(force ? 1 : 0);
  if (!force) expect(f.calls.some((call) => isTyped(call) && call[5] === "/new")).toBe(true);
});

// hc types and submits in one `send`, so a failed Enter is a failed send.
test.each(["send", "busy", "screen"])("a soft %s failure forces a single hard fallback", async (failure) => {
  const f = fixture();
  f.cold();
  f.onWait(async () => { f.world.screen = "❯ "; });
  const base = f.deps.run;
  let failed = false;
  const run: Runner = async (argv, options) => {
    if (!failed && isTyped(argv)) {
      failed = true;
      if (failure === "send") return { code: 1, out: "", err: "send failed" };
      const result = await base(argv, options);
      if (failure === "busy") f.pane.agent_status = "working";
      if (failure === "screen") f.world.screen = "Cannot find module";
      return result;
    }
    return base(argv, options);
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("toodo:chat:22", "INBOUND 11 22 owner retry");
  // When the step fails.
  const lines = await quiet(() => supervisor.flush());
  // Then a busy reused process is still stopped and the hard launch receives the batch exactly once.
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(1);
  expect(f.calls.some((call) => call[0] === "kill" && call[2] === "101")).toBe(true);
  expect(lines.filter((line) => line.startsWith("LEAD_SOFT_RESTART_FAILED "))).toHaveLength(1);
  expect(taken(f)).toEqual(["toodo:chat:22\tINBOUND 11 22 owner retry"]);
});

test("recovering soft intent without evidence falls back without another new command", async () => {
  // Given intent persisted before any soft submission completed.
  const f = fixture();
  writeJournal(f.state.dir, { events: [], restart: { session: randomUUID(), events: [], offset: 0, phase: `soft:${f.session()}` } });
  // When the supervisor recovers.
  await quiet(() => new Supervisor(f.deps).flush());
  // Then no interactive command is replayed.
  expect(f.calls.some((call) => call[5] === "/new")).toBe(false);
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(1);
  expect(f.calls.some((call) => call[0] === "kill" && call[2] === "101")).toBe(true);
});

test("a journaled forced restart bypasses the soft path even for an idle lead", async () => {
  // Given a forced lifecycle transaction, not an ordinary owner restart request.
  const f = fixture();
  writeJournal(f.state.dir, { events: [], restart: { session: randomUUID(), events: [], offset: 0, phase: "stopping", force: true } });
  // When it is recovered.
  await quiet(() => new Supervisor(f.deps).flush());
  // Then only the process path is used.
  expect(f.calls.some((call) => call[5] === "/new")).toBe(false);
  expect(f.calls.filter((call) => isLaunch(call))).toHaveLength(1);
  expect(f.calls.some((call) => call[0] === "kill" && call[2] === "101")).toBe(true);
});

test.each([false, true])("recovering a soft restart, ready=%s, never resends the prompt", async (ready) => {
  // Given durable intent and evidence written before the supervisor crashed.
  const f = fixture();
  const old = f.session();
  const planned = randomUUID();
  const actual = randomUUID();
  const path = join(f.state.dir, `lead-${planned}.md`);
  writeFileSync(path, "startup");
  writeFileSync(join(dirname(f.file), `${actual}.jsonl`), `${JSON.stringify({ type: "message", message: { role: "user", content: path } })}\n`);
  utimesSync(join(dirname(f.file), `${actual}.jsonl`), 0, 0);
  const initial = { events: [], restart: { session: ready ? actual : planned, events: [], offset: 0, phase: ready ? `soft-ready:${planned}` as const : `soft:${old}` as const } };
  const seeded = new SqliteStore(join(f.state.dir, SQLITE_FILE), { create: true });
  try { seeded.save(initial, "normal"); } finally { seeded.close(); }
  // When recovery runs, only confirmation and cleanup are allowed.
  const lines = await quiet(() => new Supervisor(f.deps).flush());
  // Then it confirms the existing session without typing anything again.
  expect(f.calls.some((call) => isTyped(call) || isLaunch(call))).toBe(false);
  expect(lines).toContain(`LEAD_RESTARTED hc:t1 ${actual}`);
  if (!ready) expect(lines).toContain(`LEAD_SOFT_RESTARTED hc:t1 ${actual}`);
  expect(readWakes(f.state.dir, 0).at(-1)?.session).toBe(actual);
  expect(existsSync(path)).toBe(false);
  const saved = new SqliteStore(join(f.state.dir, SQLITE_FILE));
  try { expect(saved.read(false).restart).toBeUndefined(); } finally { saved.close(); }
});

test("a healthy cold start with holder evidence launches once and never kills the new session", async () => {
  const f = fixture();
  f.noAgent();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("healthy", "INBOUND healthy");
  await supervisor.flush();
  expect(launchedSessions(f)).toHaveLength(1);
  expect(f.calls.filter((call) => call[0] === "kill" && call[2] === "201")).toHaveLength(0);
  expect(restartSession(f)).toBeUndefined();
});

test("a hung cold start is killed by exact session and relaunched once with the same events and offset", async () => {
  const f = fixture();
  f.cold();
  f.noAgent(); // Exercise process-launch confirmation rather than the reusable-process path.
  f.hang(1);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("hung", "INBOUND hung");
  const before = f.clock.now();
  await supervisor.flush();
  const [first, second] = launchedSessions(f);
  expect(launchedSessions(f)).toHaveLength(2);
  expect(second).not.toBe(first);
  // the hung process (pid 201) was killed after the evidence deadline, not the original lead twice
  expect(f.calls.filter((call) => call[0] === "kill" && call[2] === "201")).toHaveLength(1);
  expect(f.clock.now() - before).toBeGreaterThanOrEqual(20_000);
  expect(f.log()).toEqual([{ id: "hung", line: "INBOUND hung" }]);
  expect(f.prompt()).toContain(TAKE_FIRST);
  expect(f.prompt()).toContain(`tail -c +${statSync(join(f.state.dir, "lead-events.log")).size + 1} -F`);
  expect(restartSession(f)).toBeUndefined();
  expect(taken(f)).toEqual(["hung\tINBOUND hung"]);
});

test("two hung launches journal LEAD_STARTUP_HUNG, retain the events, and do not relaunch in a tight loop", async () => {
  const f = fixture();
  f.cold();
  f.noAgent(); // Exercise process-launch confirmation rather than the reusable-process path.
  f.hang(2);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("hung2", "INBOUND hung2");
    await expect(supervisor.flush()).rejects.toThrow("LEAD_STARTUP_HUNG");
  } finally { console.log = original; }
  const sessions = launchedSessions(f);
  expect(sessions).toHaveLength(2);
  expect(lines.some((line) => line === `LEAD_STARTUP_HUNG ${sessions[1]}`)).toBe(true);
  const pending = restartSession(f);
  expect(pending.phase).toBe("starting");
  expect(pending.events).toEqual([{ id: "hung2", line: "INBOUND hung2" }]);
  expect(pending.session).not.toBe(sessions[1]);
  // a later backoff retry relaunches and recovers with the retained events
  await new Supervisor(f.deps).flush();
  expect(launchedSessions(f)).toHaveLength(3);
  expect(restartSession(f)).toBeUndefined();
});

test("a supervisor restart preserves queued input and does not duplicate a prior append", async () => {
  const f = fixture();
  const before = new Supervisor(f.deps);
  before.enqueue("delivered", "INBOUND delivered");
  await before.flush();
  before.enqueue("pending", "INBOUND pending");
  const after = new Supervisor(f.deps);
  after.enqueue("delivered", "INBOUND delivered");
  await after.flush();
  expect(f.log().map((event) => event.id)).toEqual(["delivered", "pending"]);
});

test("unconfirmed startup retains the transaction and recovery confirms the same launch without resubmitting", async () => {
  const f = fixture();
  f.cold();
  f.noAgent(); // Exercise process-launch confirmation rather than the reusable-process path.
  f.setConfirm(false);
  const before = new Supervisor(f.deps);
  before.enqueue("pending", "INBOUND pending");
  await expect(before.flush()).rejects.toThrow("STARTUP_UNCONFIRMED");
  expect(readJournal(f.state.dir).restart.phase).toBe("submitted");
  f.setConfirm(true);
  const after = new Supervisor(f.deps);
  await after.flush();
  expect(f.log().map((event) => event.id)).toEqual(["pending"]);
  expect(restartStarts(f)).toHaveLength(1);
  expect(readJournal(f.state.dir).restart).toBeUndefined();
});

test("a partial final log record is recovered from the durable inbox", async () => {
  const f = fixture();
  const before = new Supervisor(f.deps);
  before.enqueue("recover", "INBOUND recover");
  writeFileSync(join(f.state.dir, "lead-events.log"), '{"id":"recover"');
  const after = new Supervisor(f.deps);
  await after.flush();
  expect(f.log()).toEqual([{ id: "recover", line: "INBOUND recover" }]);
});

test("only one supervisor may own a state directory and releasing it permits a restart", () => {
  const f = fixture();
  const release = acquireSupervisor(f.state.dir);
  try { expect(() => acquireSupervisor(f.state.dir)).toThrow("lock"); }
  finally { release(); }
  acquireSupervisor(f.state.dir)();
});

test("a shell with no live agent starts the lead instead of appending into an unmonitored log", async () => {
  const f = fixture();
  f.noAgent();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("missing", "INBOUND missing-agent");
  await supervisor.flush();
  expect(f.prompt()).toContain(TAKE_FIRST);
  expect(restartStarts(f)).toHaveLength(1);
  expect(taken(f)).toEqual(["missing\tINBOUND missing-agent"]);
});

test("stale ready state from the old occupant cannot confirm a new generation", async () => {
  const f = fixture();
  f.noAgent();
  f.cold();
  let stale = true;
  // The first read after the launch still shows the old occupant, ready, in the foreground.
  const run: Runner = async (argv, options) => {
    const result = await f.deps.run(argv, options);
    if (argv[0] === "hc" && argv[2] === "get" && f.command() && stale) {
      stale = false;
      return { ...result, out: JSON.stringify({ ...JSON.parse(result.out), status: { app: "omo", state: "idle" }, foreground: { pid: 99, argv: ["omo", "--session-id", "old-generation"] } }) };
    }
    return result;
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("fresh", "INBOUND fresh");
  await supervisor.flush();
  expect(stale).toBe(false);
  expect(restartStarts(f)).toHaveLength(1);
  expect(readJournal(f.state.dir).restart).toBeUndefined();
});

test("the shell interval before a new agent registers is not a startup failure", async () => {
  const f = fixture();
  f.noAgent();
  // The first read after the launch shows the terminal's shell with no agent registered yet.
  let registering = true;
  const run: Runner = async (argv, options) => {
    const result = await f.deps.run(argv, options);
    if (argv[0] === "hc" && argv[2] === "get" && f.command() && registering) {
      registering = false;
      return { ...result, out: JSON.stringify({ ...JSON.parse(result.out), status: null, foreground: null }) };
    }
    return result;
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("registering", "INBOUND registering");
  await supervisor.flush();
  expect(registering).toBe(false);
  expect(restartStarts(f)).toHaveLength(1);
  expect(readJournal(f.state.dir).restart).toBeUndefined();
});

test("a lead that wakes during cold process resolution receives a warm append without interruption", async () => {
  const f = fixture();
  f.cold();
  let lists = 0;
  const run: Runner = async (argv, options) => {
    if (argv[0] === "hc" && argv[2] === "ls" && ++lists === 3) f.pane.agent_status = "working";
    return f.deps.run(argv, options);
  };
  const supervisor = new Supervisor({ ...f.deps, run });
  supervisor.enqueue("race", "INBOUND race");
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).toEqual(["race"]);
  expect(f.calls.some((call) => call[0] === "kill" || isLaunch(call))).toBe(false);
});

test("a large multibyte event reaches the new lead through take without exceeding the pane command line", async () => {
  const f = fixture();
  f.cold();
  const text = "한".repeat(2000);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:123:1", `INBOUND 123 1 Owner ${text}`);
  await supervisor.flush();
  // The prompt carries no event, so a large body cannot reach the pane command line; take hands it over whole.
  expect(handed(f)).toContain(text);
  expect(Buffer.byteLength(f.command() ?? "")).toBeLessThan(4096);
});

test.each([
  ["INBOUND 123 1 Owner hello", "urgent"],
  // A claim wakes the lead, and so does every close, the one after the lead received the claim (seen-claim) included.
  ["LANE_DONE_CLAIMED lane proof", "urgent"],
  ["LANE_CLOSED lane closed seen-claim", "urgent"],
  ["LANE_NOT_DONE lane reason", "urgent"],
  ["LANE_CLOSED lane", "urgent"],
  ["LANE_AUTO_CLOSED lane {}", "urgent"],
  ["CI_MERGED acme/app#7 into dev lane=lane head=abc merge=def https://github.com/acme/app/pull/7", "urgent"],
  ["DEAD_PANE scratch:p1", "urgent"],
  ["HOST_GUARD ALERT low disk", "urgent"],
  ["WORKING-WHILE-PAUSED lane detail", "urgent"],
  ["WAIT_DONE release tell owner", "urgent"],
  ["WAIT_TIMEOUT release check manually", "urgent"],
  ["UNRECOGNISED_PANE scratch:p1 dead-panes: no alive status", "urgent"],
  ["NO-PROGRESS lane 16 min without a thread update while working", "urgent"],
  ["HOST_GUARD CLEAR load 40, memory free 50%", "urgent"],
  ["LAUNCH_READY the host has room again", "urgent"],
  ["LANE_REPORT remote-lane question which base branch?", "urgent"],
  // CI follow-up messages the lane about its failing checks first, so for the lead they are digest.
  ["GH_PR acme/app#7 checks_failing sha=abc https://github.com/acme/app/pull/7", "digest"],
  // A merged lane PR is read back by the supervisor (MERGE_VERIFIED); only a merge it cannot confirm wakes the lead.
  ["GH_PR acme/app#7 merged sha=abc https://github.com/acme/app/pull/7", "digest"],
  ["MERGE_VERIFIED acme/app#7 into dev lane=lane merge=abc https://github.com/acme/app/pull/7", "digest"],
  ["MERGE_UNVERIFIED acme/app#7 lane=lane GitHub reads it OPEN https://github.com/acme/app/pull/7", "urgent"],
  ["GH_PR acme/app#7 closed sha=abc https://github.com/acme/app/pull/7", "urgent"],
  ["GH_PR acme/app#7 comment by=human https://github.com/acme/app/pull/7", "urgent"],
  ["GH_PR acme/app#7 checks_green sha=abc https://github.com/acme/app/pull/7", "digest"],
  ["GH_PR acme/app#7 opened sha=abc https://github.com/acme/app/pull/7", "digest"],
  ["GH_PR acme/app#7 checks_failing_extra sha=abc url", "digest"],
  ["HOST_GITHUB acme/app poll_failed gh api HTTP 401 exit=1", "digest"],
  ["WAIT_DONE_EXTRA not a matching token", "digest"],
  ["NUDGED lane detail", "digest"],
  ["PENDING-REPORT lane detail", "digest"],
  ["STALE-REPORT lane detail", "digest"],
  ["PROGRESS-FAILED lane thread hook failed: 500", "digest"],
  ["LANE_WATCH_WARN lane hc ls failed", "digest"],
  ["SWEEP_WARN dead-panes hc ls failed", "digest"],
  ["WORKTREE_CLEANED lane /data/repos/worktrees/x", "digest"],
  ["HOST_GUARD COMPUTE_READY load 1", "digest"],
  ["HOST_GUARD COMPUTE_BUSY load 100", "digest"],
  ["POSTED lane freshness reply", "digest"],
  ["INBOUND_ERROR offline", "digest"],
  ["LANE_CLOSED_EXTRA not a matching token", "digest"],
] as const)("classifies %s as %s", (line, expected) => {
  expect(eventPriority(line)).toBe(expected);
});

test("digest-only events survive restart without appending or touching a cold lead", async () => {
  const f = fixture();
  f.cold();
  const before = new Supervisor(f.deps);
  before.enqueue("digest", "HOST_GUARD COMPUTE_READY load 1");
  await before.flush();
  const after = new Supervisor(f.deps);
  await after.flush();
  expect(f.log()).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(readJournal(f.state.dir).events).toHaveLength(1);
});

test("a kind's class comes from config: engine-only stays journaled and never reaches the lead, lead-digest rides the next urgent delivery, nothing is posted to the owner", async () => {
  const f = fixture({ eventPolicy: resolveEventPolicy({ kinds: { "GH_PR * opened": "lead-urgent", NUDGED: "engine-only", LANE_REPORT: "lead-digest" } }) });
  const posted: string[] = [];
  const supervisor = new Supervisor(f.deps, { announce: async (text) => { posted.push(text); } });
  supervisor.enqueue("nudged", "NUDGED lane silent");
  supervisor.enqueue("report", "LANE_REPORT lane question which base?");
  await supervisor.flush();
  expect(f.log()).toEqual([]);
  supervisor.enqueue("pr", "GH_PR acme/app#7 opened sha=1 https://github.com/acme/app/pull/7");
  await supervisor.flush();
  await supervisor.announcementsSettled();
  expect(f.log().map((event) => event.id)).toEqual(["report", "pr"]);
  expect(posted).toEqual([]);
  f.clock.at += 2 * 60 * 60_000;
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).toEqual(["report", "pr"]);
  expect(readJournal(f.state.dir).events.map((event: { id: string }) => event.id)).toEqual(["nudged", "report", "pr"]);
  supervisor.close();
});

test("a warm wake records its trigger kinds and is closed with the lead's model calls when the next wake starts", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("nudged", "OWNER_DECISION_OPENED d1 lane question");
  supervisor.enqueue("owner", "INBOUND 1 1 hello");
  const woke = f.clock.now();
  await supervisor.flush();
  // Typing the pointer moves the fake clock; the wake itself is stamped when the batch was handed over.
  const typed = f.clock.now();
  const record = (role: string, ms: number) => JSON.stringify({ type: "message", timestamp: new Date(ms).toISOString(), message: { role } });
  appendFileSync(f.file, `${[record("assistant", woke - 1_000), record("user", woke + 500), record("assistant", woke + 1_000), record("assistant", woke + 2_000)].join("\n")}\n`);
  f.clock.at += 3_000;
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  supervisor.enqueue("closed", "GH_PR acme/app#7 closed sha=1 https://github.com/acme/app/pull/7");
  await supervisor.flush();
  supervisor.close();
  expect(readWakes(f.state.dir, 0)).toEqual([
    { at: woke, session: f.file, trigger: ["INBOUND"], kinds: { OWNER_DECISION_OPENED: 1, INBOUND: 1 }, calls: 2, closed: true },
    { at: typed + 3_000, session: f.file, trigger: ["GH_PR * closed"], kinds: { "GH_PR * closed": 1 } },
  ]);
  expect(readWakes(f.state.dir, woke + 1)).toHaveLength(1);
});

test("a cold start is a wake on the new session; a digest-only batch past digestMaxDelayMin is triggered by its overdue kinds", async () => {
  const f = fixture({ digestMaxDelayMin: 60 });
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("nudged", "OWNER_DECISION_OPENED d1 lane question");
  f.clock.at += 61 * 60_000;
  const start = f.clock.now();
  await supervisor.flush();
  supervisor.close();
  const session = f.session();
  expect(session).not.toBe("");
  const wakes = readWakes(f.state.dir, 0);
  expect(wakes).toMatchObject([{ session, trigger: ["OWNER_DECISION_OPENED"], kinds: { OWNER_DECISION_OPENED: 1 } }]);
  // Stamped during the soft restart, which now waits for the new session to start.
  expect(wakes[0]?.at).toBeGreaterThanOrEqual(start);
  expect(wakes[0]?.at).toBeLessThanOrEqual(f.clock.now());
});

test("digest waits for an urgent event, but no longer than digestMaxDelayMin", async () => {
  const f = fixture({ digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("digest", "OWNER_DECISION_OPENED d1 lane question");
  f.clock.at += 59 * 60_000;
  await supervisor.flush();
  expect(f.log()).toEqual([]);
  f.clock.at += 60_000;
  await supervisor.flush();
  expect(f.log()).toEqual([{ id: "digest", line: "OWNER_DECISION_OPENED d1 lane question" }]);
});

test("a sweep warning alone never forces a delivery, however old it gets", async () => {
  const f = fixture({ digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("warn", "LANE_WATCH_WARN lane worktree /x not removed: locked");
  f.clock.at += 6 * 60 * 60_000;
  await supervisor.flush();
  expect(f.log()).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("the next warm urgent delivery includes held digest once", async () => {
  const f = fixture();
  const before = new Supervisor(f.deps);
  before.enqueue("digest", "OWNER_DECISION_OPENED d1 lane question");
  await before.flush();
  const after = new Supervisor(f.deps);
  after.enqueue("urgent", "INBOUND 123 1 Owner hello");
  await after.flush();
  await after.flush();
  expect(f.log().map((event) => event.id)).toEqual(["digest", "urgent"]);
  expect(f.calls.some((call) => call[0] === "kill" || isLaunch(call))).toBe(false);
});

test("GitHub digest survives restart then joins an actionable PR event exactly once", async () => {
  const f = fixture();
  const before = new Supervisor(f.deps);
  before.enqueue("github:failing", "GH_PR acme/app#7 checks_failing sha=abc url");
  await before.flush();
  expect(f.calls).toEqual([]);
  expect(f.log()).toEqual([]);
  const after = new Supervisor(f.deps);
  after.enqueue("github:closed", "GH_PR acme/app#7 closed sha=abc url");
  await after.flush();
  const restarted = new Supervisor(f.deps);
  restarted.enqueue("github:closed", "GH_PR acme/app#7 closed sha=abc url");
  await restarted.flush();
  expect(f.log().map((event) => event.id)).toEqual(["github:failing", "github:closed"]);
  expect(f.calls.some((call) => call[0] === "kill" || isLaunch(call))).toBe(false);
});

test("the next cold urgent delivery includes held digest in the new session prompt", async () => {
  const f = fixture();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("digest", "OWNER_DECISION_OPENED d1 lane question");
  await supervisor.flush();
  supervisor.enqueue("urgent", "LANE_NOT_DONE lane reason");
  await supervisor.flush();
  expect(f.prompt()).toContain(TAKE_FIRST);
  expect(f.log().map((event) => event.id)).toEqual(["digest", "urgent"]);
  expect(restartStarts(f)).toHaveLength(1);
  expect(taken(f)).toEqual(["digest\tOWNER_DECISION_OPENED d1 lane question", "urgent\tLANE_NOT_DONE lane reason"]);
});

test("a claim reads delivered to the lead only once a cold start carrying it confirmed", async () => {
  const f = fixture();
  f.cold();
  f.noAgent(); // Exercise process-launch confirmation rather than the reusable-process path.
  f.setConfirm(false);
  const before = new Supervisor(f.deps);
  before.enqueue("done-claim:lane:t", "LANE_DONE_CLAIMED lane - proof");
  expect(before.leadDelivered("done-claim:lane:t")).toBe(false);
  await expect(before.flush()).rejects.toThrow("STARTUP_UNCONFIRMED");
  // Logged into the cold batch, but the new lead has not confirmed: not received yet.
  expect(f.log().map((event) => event.id)).toEqual(["done-claim:lane:t"]);
  expect(before.leadDelivered("done-claim:lane:t")).toBe(false);
  f.setConfirm(true);
  const after = new Supervisor(f.deps);
  await after.flush();
  expect(after.leadDelivered("done-claim:lane:t")).toBe(true);
  expect(after.leadDelivered("done-claim:lane:other")).toBe(false);
});

test("a claim delivered warm reads delivered at once", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("done-claim:lane:t", "LANE_DONE_CLAIMED lane - proof");
  await supervisor.flush();
  expect(supervisor.leadDelivered("done-claim:lane:t")).toBe(true);
});

test("a machine-closed lane's claim is digest and wakes no lead; its close is urgent", async () => {
  const f = fixture();
  expect(eventPriority("LANE_AUTO_CLAIMED lane w:p1 merged acme/app#1")).toBe("digest");
  expect(eventPriority("LANE_AUTO_CLOSED lane {}")).toBe("urgent");
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("sweep:1", "LANE_AUTO_CLAIMED lane w:p1 merged acme/app#1");
  await supervisor.flush();
  expect(f.log()).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("a cold start points the lead at the full SKILL.md and puts leadArgs on the lead command only", async () => {
  const f = fixture({ leadArgs: ["--approve"], leadDiet: false, defaultModel: "test/lead-default" });
  f.noAgent();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("card", "INBOUND card");
  await supervisor.flush();
  expect(LEAD_SKILL.endsWith("/skills/dori-mode/SKILL.md")).toBe(true);
  expect(existsSync(LEAD_SKILL)).toBe(true);
  expect(f.prompt()).toContain(LEAD_SKILL);
  expect(f.prompt()).toContain("Supervised mode: do not start inbound pollers or sweeps.");
  const command = f.command() ?? "";
  expect(command).toMatch(/omo '?--permission-preset'? '?full-access'? '?--session-id'? \S+ '?--session-dir'? \S+ '?--approve'? '?--model'?/);
  expect(command).toContain("test/lead-default");
});

test.each([["Japanese", true], [undefined, false]] as const)("ownerLanguage=%s: the lead's startup prompt names the owner's language only when set", async (ownerLanguage, named) => {
  const f = fixture(ownerLanguage ? { ownerLanguage } : {});
  f.noAgent();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("card", "INBOUND card");
  await supervisor.flush();
  const prompt = f.prompt() ?? "";
  expect(prompt.includes("The owner's language is Japanese (config ownerLanguage): write every reply, report and question to the owner in Japanese")).toBe(named);
  expect(prompt.includes("The owner's language is")).toBe(named);
});

test("the lead runs under omo's full-access preset unless its own argv names a preset", () => {
  expect(leadPermissionArgs(["--approve", "--model", "m"])).toEqual(["--permission-preset", "full-access"]);
  expect(leadPermissionArgs(["--permission-preset", "ask"])).toEqual([]);
  expect(leadPermissionArgs(["--permission-preset=workspace"])).toEqual([]);
});

test.each([true, false])("leadDiet=%s: the lead launch carries the slim omo flags and env only when on, never the lane command", async (leadDiet) => {
  const f = fixture({ leadArgs: ["--approve"], leadDiet });
  f.noAgent();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("card", "INBOUND card");
  await supervisor.flush();
  const command = f.command() ?? "";
  const list = LEAD_DIET_EXCLUDED_TOOLS.join(",");
  expect(command.includes("SENPI_PROMPT_SURFACE=chat")).toBe(leadDiet);
  expect(command.includes("--no-skills")).toBe(leadDiet);
  expect(command.includes("--exclude-tools")).toBe(leadDiet);
  expect(command.includes(list)).toBe(leadDiet);
  if (leadDiet) expect(command).toMatch(/DORI_SUPERVISED=1 '?SENPI_PROMPT_SURFACE=chat'? .*'?--approve'? '?--no-skills'? '?--exclude-tools'? \S+ '?--model'?/);
  const lane = defaultConfig().agentCommand.join(" ");
  expect(lane).not.toContain("--no-skills");
  expect(lane).not.toContain("--exclude-tools");
  expect(lane).not.toContain("SENPI_PROMPT_SURFACE");
});

const WITH_THINKING = ["omo", "--model", "{model}", "--thinking", "medium", "{prompt}"];
/** The lead's agent argv after `--session-dir <dir>`, up to the `@prompt` file. */
const leadAgent = async (extra: Record<string, unknown>) => {
  const f = fixture({ defaultModel: "test/lane-default", leadDiet: false, ...extra });
  f.noAgent();
  f.cold();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("card", "INBOUND card");
  await supervisor.flush();
  return /--session-dir \S+ (.*) @\S+$/.exec(f.command() ?? "")?.[1];
};

test.each([
  ["no lead fields keep agentCommand with defaultModel", {}, "--model test/lane-default --thinking medium"],
  ["leadModel sets only the lead's model", { leadModel: "test/lead" }, "--model test/lead --thinking medium"],
  ["leadThinking replaces only the lead's --thinking value", { leadThinking: "high" }, "--model test/lane-default --thinking high"],
  ["both lead fields apply together", { leadModel: "test/lead", leadThinking: "high" }, "--model test/lead --thinking high"],
  ["blank lead fields count as unset", { leadModel: " ", leadThinking: "" }, "--model test/lane-default --thinking medium"],
])("lead command: %s", async (_, extra, expected) => {
  expect(await leadAgent({ agentCommand: WITH_THINKING, ...extra })).toBe(expected);
});

test("lead command: leadThinking goes right after the --model pair when agentCommand has no --thinking", async () => {
  expect(await leadAgent({ agentCommand: ["omo", "--model", "{model}", "--yolo", "{prompt}"], leadThinking: "high" }))
    .toBe("--model test/lane-default --thinking high --yolo");
  // Without leadThinking nothing is inserted.
  expect(await leadAgent({ agentCommand: ["omo", "--model", "{model}", "--yolo", "{prompt}"] })).toBe("--model test/lane-default --yolo");
});

/** Captures console.log lines and silences console.error while `body` runs. */
const quiet = async (body: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.error = () => {};
  try { await body(); } finally { [console.log, console.error] = [log, error]; }
  return lines;
};

test("a lead terminal closed by hand is recreated as a new dori-lead hc terminal and cold-started with the pending events", async () => {
  const f = fixture();
  f.cold();
  // The owner closes the lead's terminal: the process is gone with it.
  f.world.panes.splice(f.world.panes.indexOf(f.pane), 1);
  f.noAgent();
  const run = f.deps.run;
  const persisted: string[] = [];
  const supervisor = new Supervisor({ ...f.deps, run, config: { ...f.deps.config } }, { persistLeadPane: (pane) => { persisted.push(pane); } });
  supervisor.enqueue("inbound:1", "INBOUND hello");
  const retries: string[] = [];
  const delivery = new RetryingDelivery({
    now: f.clock.now, flush: () => supervisor.flush(), repair: () => supervisor.repairLeadPane(),
    enqueue: () => {}, notify: async () => {}, log: (line) => { retries.push(line); },
  }, "boot");
  const lines = await quiet(async () => {
    await delivery.tick();
    while (!delivery.due) f.clock.at += 1000;
    await delivery.tick();
  });
  expect(retries).toEqual([expect.stringMatching(/^SUPERVISOR_RETRY lead pane hc:t1 does not exist; attempt 1/)]);
  const made = f.calls.find((call) => call[0] === "hc" && call[2] === "run") ?? [];
  expect(made.slice(0, 8)).toEqual(["hc", "--json", "run", "--bg", "--no-parent", "--no-notify", "--cwd", "/repo"]);
  expect(made.slice(8)).toEqual(["--label", "dori.lead=1", "--name", "dori-lead", "--", expect.any(String)]);
  expect(persisted).toEqual(["hc:t2"]);
  expect(lines).toContain("LEAD_PANE_RECREATED hc:t1 -> hc:t2");
  const [launched] = launchedSessions(f);
  expect(launchedSessions(f)).toHaveLength(1);
  expect(f.calls.find((call) => isLaunch(call))?.[3]).toBe("t2");
  expect(f.prompt()).toContain(TAKE_FIRST);
  expect(lines).toContain(`LEAD_RESTARTED hc:t2 ${launched}`);
  expect(restartSession(f)).toBeUndefined();
  expect(delivery.due).toBe(true);
  expect(taken(f)).toEqual(["inbound:1\tINBOUND hello"]);
});

test("a starting restart is never typed into a pane whose foreground is an agent, and launches once a plain shell is back", async () => {
  const f = fixture();
  // The issue's case: the journal is past "stopping" (a recreated pane or a hung retry) and the owner started omo by hand.
  writeJournal(f.state.dir, ({ events: [{ id: "x", line: "INBOUND x" }], restart: { session: "22222222-2222-4222-8222-222222222222", events: [{ id: "x", line: "INBOUND x" }], offset: 0, phase: "starting" } }));
  // "stopping" already logged the cold batch before the launch.
  writeFileSync(join(f.state.dir, "lead-events.log"), `${JSON.stringify({ id: "x", line: "INBOUND x" })}\n`);
  await expect(new Supervisor(f.deps).flush()).rejects.toThrow("LEAD_PANE_BUSY hc:t1: foreground is not a plain shell (omo)");
  expect(restartStarts(f)).toHaveLength(0);
  expect(restartSession(f).phase).toBe("starting");
  f.noAgent();
  await quiet(() => new Supervisor(f.deps).flush());
  expect(launchedSessions(f)).toEqual(["22222222-2222-4222-8222-222222222222"]);
  expect(restartSession(f)).toBeUndefined();
});

test("a submitted launch that never confirms is abandoned after the limit: screen saved, pane replaced, fresh session", async () => {
  const f = fixture();
  f.cold();
  f.noAgent(); // Exercise process-launch confirmation rather than the reusable-process path.
  f.setConfirm(false);
  f.hang(1); // the launch never initialises: no holder file, no session jsonl
  const deps = { ...f.deps, run: f.deps.run, config: { ...f.deps.config } };
  // One supervisor process: the recreated pane id lives in its deps (and in config through persistLeadPane).
  const supervisor = new Supervisor(deps);
  supervisor.enqueue("stuck", "INBOUND stuck");
  const lines = await quiet(async () => {
    for (let i = 1; i < UNCONFIRMED_LIMIT; i++) {
      await expect(supervisor.flush()).rejects.toThrow("STARTUP_UNCONFIRMED");
      expect(restartSession(f)).toMatchObject({ phase: "submitted", unconfirmed: i });
    }
    await expect(supervisor.flush()).rejects.toThrow("lead pane recreated as hc:t2");
  });
  const [launched] = launchedSessions(f);
  const pending = restartSession(f);
  expect(launchedSessions(f)).toHaveLength(1);
  expect(pending).toMatchObject({ phase: "starting", unconfirmed: 0, events: [{ id: "stuck", line: "INBOUND stuck" }] });
  expect(pending.session).not.toBe(launched);
  // the never-confirmed process was stopped by its exact session, then the screen was read before the pane closed
  expect(f.calls.filter((call) => call[0] === "kill" && call[2] === "201")).toHaveLength(1);
  const read = f.calls.findIndex((call) => call.join(" ") === "hc --json read t1 --lines 80");
  const killed = f.calls.findIndex((call) => call[0] === "kill" && call[2] === "201");
  const closed = f.calls.findIndex((call) => call.join(" ") === "hc --json kill t1");
  expect(read).toBeGreaterThanOrEqual(0);
  expect(killed).toBeGreaterThan(read);
  expect(closed).toBeGreaterThan(killed);
  const saved = readdirSync(f.state.dir).filter((name) => name.startsWith("lead-pane-hc_t1-"));
  expect(saved).toHaveLength(1);
  expect(readFileSync(join(f.state.dir, saved[0] ?? ""), "utf8")).toBe("❯ ");
  expect(lines).toContain(`LEAD_PANE_SCREEN_SAVED hc:t1 ${join(f.state.dir, saved[0] ?? "")}`);
  expect(lines).toContain("LEAD_PANE_RECREATED hc:t1 -> hc:t2");
  expect(existsSync(join(f.state.dir, `lead-${launched}.md`))).toBe(false);
  // the next backoff retry launches the fresh session into the new pane
  f.setConfirm(true);
  await quiet(() => supervisor.flush());
  expect(launchedSessions(f)).toEqual([launched, pending.session]);
  expect(f.calls.filter((call) => isLaunch(call)).at(-1)?.[3]).toBe("t2");
  expect(restartSession(f)).toBeUndefined();
});

test("argv-less foreground entries never crash, and a pane held by a process the supervisor did not start is left open while the lead moves to a new pane", async () => {
  const f = fixture();
  f.cold();
  f.noAgent(); // Exercise process-launch confirmation rather than the reusable-process path.
  f.hang(1);
  let foreign = false;
  // After the launch the old terminal runs something else (the owner's own omo); hc shows its foreground without argv.
  const run: Runner = async (argv, options) => {
    if (argv[0] === "hc" && argv[2] === "get" && argv[3] === "t1" && foreign) {
      f.calls.push([...argv]);
      return { code: 0, err: "", out: JSON.stringify({ address: "t1", state: "live", cwd: "/repo", created_ms: 1, pid: 10, status: null, foreground: { pid: 300, name: "node" } }) };
    }
    const out = await f.deps.run(argv, options);
    if (isLaunch(argv)) foreign = true;
    return out;
  };
  const deps = { ...f.deps, run, config: { ...f.deps.config } };
  const supervisor = new Supervisor(deps);
  supervisor.enqueue("owner", "INBOUND owner");
  const lines = await quiet(async () => {
    for (let i = 1; i <= UNCONFIRMED_LIMIT; i++) {
      await expect(supervisor.flush()).rejects.toThrow(i < UNCONFIRMED_LIMIT ? "STARTUP_UNCONFIRMED" : "lead pane recreated as hc:t2");
    }
  });
  expect(lines).toContain("LEAD_PANE_LEFT hc:t1: its foreground is not the supervisor's; left open, nothing in it stopped");
  expect(lines).toContain("LEAD_PANE_RECREATED hc:t1 -> hc:t2");
  expect(f.calls.some((call) => call[0] === "hc" && call[2] === "kill")).toBe(false);
  expect(f.calls.some((call) => call[0] === "kill" && (call[2] === "300" || call[2] === "301"))).toBe(false);
  const pending = restartSession(f);
  expect(pending.phase).toBe("starting");
  expect(pending.session).not.toBe(launchedSessions(f)[0]);
  // the fresh session launches into the new pane's shell, never into the process left in the old one
  f.noAgent();
  await quiet(() => supervisor.flush());
  expect(launchedSessions(f)).toEqual([expect.any(String), pending.session]);
  expect(f.calls.filter((call) => isLaunch(call)).map((call) => call[3])).toEqual(["t1", "t2"]);
  expect(restartSession(f)).toBeUndefined();
});

test("an old lead that never leaves its pane is moved to a new pane after the limit: screen saved, only its own tree killed, owner told once", async () => {
  const f = fixture();
  // A stuck lead whose terminal broke mid-draw: SIGKILL is sent but the process stays in the pane's foreground.
  writeJournal(f.state.dir, { events: [{ id: "x", line: "INBOUND x" }], restart: { session: "22222222-2222-4222-8222-222222222222", events: [{ id: "x", line: "INBOUND x" }], offset: 0, phase: "stopping", force: true } });
  f.world.screen = "0;276;0c11;rgb:1e1e/1e1e/2e2e\\0;276;0c11;rgb:1e1e/1e1e/2e2e";
  let stuck = true;
  const run: Runner = async (argv, options) => {
    if (argv[0] === "kill" && argv[2] === "101" && stuck) { f.calls.push([...argv]); return { code: 0, out: "", err: "" }; }
    // killing the old terminal ends what the kill could not
    if (argv[0] === "hc" && argv[2] === "kill" && argv[3] === "t1") { stuck = false; f.noAgent(); }
    return f.deps.run(argv, options);
  };
  const posted: string[] = [];
  const supervisor = new Supervisor({ ...f.deps, run, config: { ...f.deps.config } }, { announce: async (text) => { posted.push(text); } });
  const lines = await quiet(async () => {
    for (let i = 1; i < UNCONFIRMED_LIMIT; i++) {
      await expect(supervisor.flush()).rejects.toThrow("old lead has not exited");
      expect(restartSession(f)).toMatchObject({ phase: "stopping", unconfirmed: i });
    }
    await expect(supervisor.flush()).rejects.toThrow("LEAD_PANE_REPLACED");
    expect(restartSession(f)).toMatchObject({ phase: "starting", unconfirmed: 0 });
    // the next retry starts a fresh lead in the new pane
    await supervisor.flush();
  });
  const saved = readdirSync(f.state.dir).filter((name) => name.startsWith("lead-pane-hc_t1-"));
  expect(saved).toHaveLength(1);
  expect(readFileSync(join(f.state.dir, saved[0] ?? ""), "utf8")).toBe(f.world.screen);
  const read = f.calls.findIndex((call) => call.join(" ") === "hc --json read t1 --lines 80");
  const created = f.calls.findIndex((call) => call[0] === "hc" && call[2] === "run");
  const closed = f.calls.findIndex((call) => call.join(" ") === "hc --json kill t1");
  expect(read).toBeGreaterThanOrEqual(0);
  expect(created).toBeGreaterThan(read);
  expect(closed).toBeGreaterThan(created);
  // only the lead's own tree (process, child, detached session-owned monitor): never the shell or another agent
  expect(new Set(f.calls.filter((call) => call[0] === "kill" && call[1] === "-KILL").map((call) => call[2]))).toEqual(new Set(["101", "102", "103"]));
  expect(f.calls.filter((call) => isLaunch(call)).map((call) => call[3])).toEqual(["t2"]);
  expect(lines).toContain(`LEAD_RESTARTED hc:t2 22222222-2222-4222-8222-222222222222`);
  expect(restartSession(f)).toBeUndefined();
  await supervisor.announcementsSettled();
  expect(posted.filter((text) => text.includes("hc:t2"))).toHaveLength(1);
  expect(posted.find((text) => text.includes("hc:t2"))).toContain(join(f.state.dir, saved[0] ?? ""));
});

test("what an old occupant left above the launch line (its own words, a broken terminal's escape replies) cannot block readiness; a startup error after it still does", async () => {
  for (const [after, ready] of [["❯ ", true], ["Error: No API key found for anthropic", false]] as const) {
    const f = fixture();
    f.cold();
    f.noAgent(); // Exercise process-launch confirmation rather than the reusable-process path.
    const run: Runner = async (argv, options) => {
      const out = await f.deps.run(argv, options);
      if (isLaunch(argv)) f.world.screen = `the previous lead: the quota cache hit its rate limit\n0;276;0c11;rgb:1e1e/1e1e/2e2e\n$ ${argv[5]}\n${after}`;
      return out;
    };
    const supervisor = new Supervisor({ ...f.deps, run });
    supervisor.enqueue("x", "INBOUND x");
    const flushed = quiet(() => supervisor.flush());
    if (ready) {
      const lines = await flushed;
      expect(lines).toContain(`LEAD_RESTARTED hc:t1 ${launchedSessions(f)[0]}`);
    } else await expect(flushed).rejects.toThrow("STARTUP_UNCONFIRMED");
  }
});

test("an unconfirmed session that did initialise is never killed or relaunched past the limit", async () => {
  const f = fixture();
  f.cold();
  f.noAgent(); // Exercise process-launch confirmation rather than the reusable-process path.
  f.setConfirm(false); // e.g. blocked on a dialog: hc never reports it ready, but omo wrote its holder file
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("blocked", "INBOUND blocked");
  await quiet(async () => {
    for (let i = 1; i <= UNCONFIRMED_LIMIT + 1; i++) await expect(supervisor.flush()).rejects.toThrow("STARTUP_UNCONFIRMED");
  });
  const [launched] = launchedSessions(f);
  expect(launchedSessions(f)).toHaveLength(1);
  expect(restartSession(f)).toMatchObject({ session: launched, phase: "submitted", unconfirmed: UNCONFIRMED_LIMIT + 1 });
  expect(f.calls.some((call) => (call[0] === "kill" && call[2] === "201") || (call[0] === "hc" && (call[2] === "kill" || call[2] === "run")))).toBe(false);
});

test("a foreground process group other than the shell is not a plain shell", () => {
  expect(plainShell({ shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, argv: ["/usr/bin/zsh"] }] })).toBe(true);
  expect(plainShell({ shell_pid: 10, foreground_process_group_id: 300, foreground_processes: [{ pid: 10, argv: ["/usr/bin/zsh"] }] })).toBe(false);
  expect(plainShell({ foreground_processes: [] })).toBe(false);
});

/** Model selections through either a process launch or the interactive model commands, in argv spelling. */
const launches = (f: ReturnType<typeof fixture>) => f.calls.flatMap((call, i) => {
  if (isLaunch(call)) return [call[5] ?? ""];
  if (!isTyped(call) || !call[5]?.startsWith("/model ")) return [];
  const next = f.calls.slice(i + 1).find((item) => isTyped(item))?.[5];
  return [`--model ${call[5].slice("/model ".length)}${next?.startsWith("/thinking ") ? ` --thinking ${next.slice("/thinking ".length)}` : ""}`];
});
const journal = (f: ReturnType<typeof fixture>) => readJournal(f.state.dir);
const muted = async (work: () => Promise<void>) => {
  const original = console.log;
  console.log = () => {};
  try { await work(); } finally { console.log = original; }
};

test("a cold start delivers only untaken events and carries held launches until they start", async () => {
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("toodo:chat:22", "INBOUND 11 22 owner project-alpha");
  await supervisor.flush();
  expect(taken(f)).toEqual(["toodo:chat:22\tINBOUND 11 22 owner project-alpha"]);
  supervisor.enqueue("toodo:chat:23", "INBOUND 11 23 owner project-beta");
  await supervisor.flush();
  enqueueLaunch(f.state.dir, { key: "held-lane", title: "held", done: "merged acme/app#1", brief: "/b.md", queuedAt: "2027-01-15T08:00:00.000Z", reasons: ["memory"] });
  // When an unrelated event causes a cold restart.
  f.cold();
  // The held queue is named after the restart's session, as journaled when the prompt is typed.
  let session: string | undefined;
  f.onWait(async () => { session ??= restartSession(f)?.phase.startsWith("soft:") ? restartSession(f)?.session : undefined; });
  supervisor.enqueue("restart-trigger", "WAIT_DONE release");
  await supervisor.flush();
  expect(launches(f)).toHaveLength(1);
  expect(session).toMatch(/^[0-9a-f-]{36}$/);
  // Then the prompt lists nothing, and take prints each id exactly once: the untaken events, then the reminders.
  const lines = handed(f).split("\n");
  expect(lines.map((line) => line.split("\t")[0])).toEqual(["toodo:chat:23", "restart-trigger", `launch-queue:${session}`]);
  expect(lines[2]).toContain("held-lane");
  expect(taken(f)).toEqual(["INBOX_EMPTY"]);
  expect(takeCarriedReminders(f.state.dir).map((line) => line.split("\t")[0])).toEqual([`launch-queue:${session}`]);
  dequeueLaunch(f.state.dir, "held-lane");
  await supervisor.reportTick();
  expect(takeCarriedReminders(f.state.dir)).toEqual([]);
});

test("owner message bodies and lane reports are redacted before durable journal and log writes", async () => {
  // Given secrets in inbound and lane-report event payloads.
  const f = fixture();
  const supervisor = new Supervisor(f.deps);
  const secret = "ghp_1234567890123456789012345";
  supervisor.enqueue("toodo:chat:22", `INBOUND 11 22 owner ${secret} ${"x".repeat(4_000)}`);
  supervisor.enqueue("report:alpha", `LANE_REPORT alpha password=hunter2\n${secret}`);
  await supervisor.flush();
  for (const text of [journalBytes(f.state.dir), readFileSync(join(f.state.dir, "lead-events.log"), "utf8")]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[REDACTED]");
  }
});

const typed = (f: ReturnType<typeof fixture>): string[] => f.calls.filter((call) => isTyped(call)).map((call) => call[5] ?? "");
// The footer omo showed on a lead the owner stopped with Esc during `gh pr checks --watch` (2026-10-23).
const PAUSED_SCREEN = "❯ \n(😺 OmO Native by Q Kim) ◉ watching lead events (5m) Paused · 4 updates held · type to continue, /resume to resume";

test("an idle lead paused by Esc gets /resume typed before its pointer; still untaken after push.escalateMin it is restarted in push-only mode", async () => {
  const f = fixture({ delivery: { ...BUILT_IN.delivery, tailMonitor: false } });
  f.world.screen = PAUSED_SCREEN;
  // hc reports an Esc-paused omo as done.
  f.pane.agent_status = "done";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("toodo:chat:1", "INBOUND 1 1 hi");
  await muted(() => supervisor.flush());
  expect(f.log().map((event) => event.id)).toEqual(["toodo:chat:1"]);
  const [resume, pointer, ...rest] = typed(f);
  expect(resume).toBe("/resume");
  expect(pointer).toStartWith(POINTER_PREFIX);
  expect(rest).toEqual([]);
  expect(launches(f)).toEqual([]);
  f.clock.at += 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toEqual([]);
  f.clock.at += (f.deps.tunables.delivery.push.escalateMin - 1) * 60_000;
  await muted(() => supervisor.flush());
  expect(launches(f)).toHaveLength(1);
  expect(f.prompt()).toContain("it did not take pushed events");
  expect(handed(f)).toContain("toodo:chat:1\t");
});

test("a paused lead with the owner's text in its input is not typed into, and a lead that is not paused is not resumed", async () => {
  for (const screen of [PAUSED_SCREEN.replace("❯ ", "❯ half a sentence"), "❯ \n(😺 OmO Native by Q Kim) ◉ watching lead events (5m)"]) {
    const f = fixture();
    f.world.screen = screen;
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("toodo:chat:1", "INBOUND 1 1 hi");
    await muted(() => supervisor.flush());
    f.clock.at += 2 * 60_000;
    await muted(() => supervisor.flush());
    // Never /resume; the owner's text gets nothing typed at all, an empty input only the [dori] pointer.
    const texts = typed(f);
    expect(texts).not.toContain("/resume");
    if (screen.includes("half a sentence")) expect(texts).toEqual([]);
    else expect(texts.length > 0 && texts.every((text) => text.startsWith(POINTER_PREFIX))).toBe(true);
    expect(launches(f)).toEqual([]);
  }
});

test("safety-work events reach an idle lead at once, without waiting for the digest delay", async () => {
  const f = fixture({ digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  const lines = [
    "WAIT_FAILED release ci green (30 checks in a row failed; no --timeout set)",
    "WAITS_CORRUPT waits.json did not parse and was moved to /x; every wait in it is dropped, register them again",
    "LANE_RECOVERY_EXHAUSTED k w:p1 dead after 3 recovery attempts",
  ];
  for (const [i, line] of lines.entries()) {
    supervisor.enqueue(`urgent:${i}`, line);
    await supervisor.flush();
    expect(f.log().map((event) => event.id)).toContain(`urgent:${i}`);
  }
  // Control: a digest line alone still waits.
  supervisor.enqueue("digest", "OWNER_DECISION_OPENED d1 lane question");
  await supervisor.flush();
  expect(f.log().map((event) => event.id)).not.toContain("digest");
});

test("a cold handoff always carries the held launch queue, even after LAUNCH_READY lowered the flag", async () => {
  const f = fixture();
  f.cold();
  enqueueLaunch(f.state.dir, { key: "held-lane", title: "held", done: "merged acme/app#1", brief: "/b.md", queuedAt: "2027-01-15T08:00:00.000Z", reasons: ["memory"] });
  clearLaunchHold(f.state.dir);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("toodo:chat:1", "INBOUND 1 1 owner hi");
  await supervisor.flush();
  const handoff = handed(f);
  expect(handoff).toContain("LAUNCH_QUEUE held launches are still waiting");
  expect(handoff).toContain("held-lane");
});

test("an owner announcement that fails to post is kept and posted by the next supervisor", async () => {
  const f = fixture();
  writeJournal(f.state.dir, { events: [], outbox: [{ id: "lead-stuck:1", text: "The lead is stuck." }] });
  const failing = new Supervisor(f.deps, { announce: async () => { throw new Error("chat unavailable"); } });
  const error = console.error;
  console.error = () => {};
  try {
    await muted(() => failing.flush());
    await failing.announcementsSettled();
  } finally { console.error = error; }
  expect(journal(f).outbox).toHaveLength(1);
  f.clock.at += 60_000;
  const posted: string[] = [];
  const next = new Supervisor(f.deps, { announce: async (text) => { posted.push(text); } });
  await next.announcementsSettled();
  expect(posted).toEqual(["The lead is stuck."]);
  expect(journal(f).outbox).toEqual([]);
});

test("an owner-only event is no longer posted: it is journaled for the lead, and a leftover owner-only outbox row is dropped with one log line", async () => {
  const f = fixture({ eventPolicy: resolveEventPolicy({ kinds: { CUSTOM: "lead-digest" } }) });
  writeJournal(f.state.dir, {
    events: [],
    outbox: [
      { id: "owner-only:x", text: "CUSTOM old owner notice", retryAt: f.clock.now() + 60_000 },
      { id: "lead-stuck:1", text: "The lead is stuck." },
    ],
  });
  const posted: { text: string; id: string }[] = [];
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const supervisor = new Supervisor(f.deps, { announce: async (text, id) => { posted.push({ text, id }); } });
    supervisor.enqueue("custom", "CUSTOM new notice");
    await supervisor.flush();
    await supervisor.announcementsSettled();
    supervisor.close();
  } finally { console.error = error; }
  expect(posted).toEqual([{ text: "The lead is stuck.", id: "lead-stuck:1" }]);
  expect(journal(f).outbox ?? []).toEqual([]);
  expect(logged.filter((line) => line.includes("owner-only:x"))).toEqual(["OWNER_ANNOUNCE_DROPPED owner-only:x: owner-only events are no longer posted"]);
  expect(journal(f).events.map((event: { id: string }) => event.id)).toEqual(["custom"]);
});
