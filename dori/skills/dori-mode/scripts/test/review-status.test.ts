import { afterEach, describe, expect, test } from "bun:test";

import { closeOwnerDecision, type DecisionContext } from "../src/owner-decisions.ts";
import type { Lane } from "../src/registry.ts";
import { type ReviewExecution, type ReviewJobRecord, ReviewJobs } from "../src/review-jobs.ts";
import type { ReviewReceipt } from "../src/review-receipt.ts";
import { reviewStatusTick, ReviewStatusStore, type ReviewStores } from "../src/review-status.ts";
import { ReviewExemptions } from "../src/review-exempt.ts";
import { readDecisions } from "../src/decision-store.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-14T12:00:00Z");
const REPO = "acme/app";
const sha = (c: string): string => c.repeat(40);
const H = sha("a");

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

type RecordSpec = {
  readonly id: string; readonly execution: ReviewExecution; readonly pr?: number; readonly head?: string; readonly round?: number;
  readonly verdict?: "pass" | "findings"; readonly at?: number; readonly author?: string; readonly response?: string;
  readonly patch?: Partial<ReviewJobRecord>;
};

/** A stored job record shaped like the gate writes it (only the fields the status and the gate read are filled in). */
const record = (s: RecordSpec): ReviewJobRecord => {
  const head = s.head ?? H, n = s.pr ?? 7, at = s.at ?? T0;
  const snapshot = { repo: REPO, prNumber: n, headSha: head, baseRef: "dev", baseSha: sha("b"), mergeBaseSha: sha("c"), policyVersion: "t4-1", criteriaSha256: "x" };
  const receipt = s.verdict ? ({
    receiptId: `rr-${s.id}`, jobId: s.id, repo: REPO, prNumber: n, headSha: head, baseRef: "dev", baseSha: sha("b"), round: s.round ?? 1, source: "reviewer",
    reportArtifact: `/state/research/review-${s.id}/review-report.md`,
    result: s.verdict === "pass" ? { verdict: "pass", findings: [] } : {
      verdict: "findings",
      findings: [{ id: "F1", severity: "high", criterionId: "C1", path: "src/x.ts", lineStart: 3, lineEnd: 4, observation: "the edge case is unguarded", consequence: "c", evidence: ["e"], requestedChange: "r" }],
    },
  } as unknown as ReviewReceipt) : undefined;
  return {
    job: {
      jobId: s.id, snapshot, authorLaneKey: s.author ?? "author", reviewerLaneKey: `review-app-${n}-${head.slice(0, 7)}`, round: s.round ?? 1,
      diffSha256: "d", authorModel: { id: "m" }, tokenHash: "t", createdAt: at, ...(s.response ? { responseSha256: s.response } : {}),
    },
    key: `${REPO}#${n}@${head}`, execution: s.execution, attempts: 1, updatedAt: at, ...(receipt ? { receipt } : {}), ...s.patch,
  };
};

const lane = (patch: Partial<Lane> = {}): Lane => ({
  key: "author", title: "author", thread: "toodo:thread/222", brief: "/b.md", done: "x", openedAt: new Date(T0).toISOString(), status: "done-claimed",
  claim: { at: new Date(T0).toISOString(), evidence: "e", pulls: [{ repo: REPO, number: 7, sha: H }] }, ...patch,
});

/** Supervisor-side pieces over a real state dir: registry, job store and decisions, with a fake chat. */
const world = async () => {
  const state = withState();
  cleanups.push(state.done);
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, state.dir, { displayTimeZone: "UTC", review: { repos: ["acme/app", "Dubusoft/dori-mode"] } });
  await deps.registry.write(lane());
  const jobs = new ReviewJobs(state.dir);
  const fail = { decision: false };
  let message = 0;
  const decisions: DecisionContext = {
    config: { stateDir: state.dir, displayTimeZone: "UTC" },
    now: () => clock.now(), home: "/home/test",
    toodo: () => ({
      taskThread: async (id) => ({ kind: "thread", id }),
      reply: async (place, body) => {
        if (fail.decision) throw new Error("Toodo chat unavailable");
        return { id: ++message, place, body, author: "agent", attachments: [] };
      },
    }),
  };
  const stores: ReviewStores = { jobs, exemptions: new ReviewExemptions(state.dir), merges: new ReviewStatusStore(state.dir) };
  const events: [string, string][] = [];
  const tick = () => reviewStatusTick({
    flow: deps, stores, decisions, home: "/home/test", emit: (id, line) => { events.push([id, line]); },
  });
  const put = (...records: ReviewJobRecord[]): void => { jobs.transact((_r, putOne) => { for (const r of records) putOne(r); }); };
  return { dir: state.dir, deps, clock, jobs, stores, fail, decisions, events, tick, put };
};

const cappedPair = (): ReviewJobRecord[] => [
  record({ id: "j1", verdict: "findings", execution: { state: "stale", reason: "s" }, patch: { authorNotified: { at: T0, laneKey: "author" } } }),
  record({ id: "j2", round: 2, verdict: "findings", at: T0 + 1, execution: { state: "completed", receiptId: "rr-j2" }, patch: { capReached: { reason: "2 review rounds ended with findings (limit 2)", at: T0 + 2 } } }),
];

describe("review status tick", () => {
  test("a reached limit opens exactly one owner decision across passes, recorded on the job", async () => {
    const w = await world();
    w.put(...cappedPair());
    await w.tick();
    await w.tick();
    const all = readDecisions(w.dir).decisions;
    expect(all).toHaveLength(1);
    const d = all[0]!;
    expect(d).toMatchObject({ lane: "author", source: "lead", sourceRef: `review-cap:j2:${T0 + 2}`, reviewCap: { jobId: "j2", repo: REPO, prNumber: 7 }, origin: "toodo:thread/222", toodo: { place: "toodo:thread/222", message: 1 } });
    expect(d.options).toHaveLength(3);
    expect(w.jobs.get("j2")?.capReached?.decisionId).toBe(d.id);
    expect(w.events.filter(([id]) => id.startsWith("owner-decision-opened:"))).toEqual([[`owner-decision-opened:${d.id}`, expect.stringContaining("OWNER_DECISION_OPENED")]]);
  });

  test("a decision that cannot be opened is raised once and opened by a later pass", async () => {
    const w = await world();
    w.put(...cappedPair());
    w.fail.decision = true;
    await w.tick();
    await w.tick();
    expect(readDecisions(w.dir).decisions).toHaveLength(0);
    expect(w.jobs.get("j2")?.capReached?.decisionId).toBeUndefined();
    expect(new Set(w.events.filter(([id]) => id.startsWith("review-decision-failed:")).map(([id]) => id))).toEqual(new Set(["review-decision-failed:j2"]));
    w.fail.decision = false;
    await w.tick();
    const opened = readDecisions(w.dir).decisions;
    expect(opened).toHaveLength(1);
    expect(w.jobs.get("j2")?.capReached?.decisionId).toBe(opened[0]!.id);
  });

  test("closing the decision records each choice as its own outcome; a close without a choice is refused", async () => {
    const outcomes: string[] = [];
    for (const choice of [1, 2, 3]) {
      const w = await world();
      w.put(...cappedPair());
      await w.tick();
      const id = readDecisions(w.dir).decisions[0]!.id;
      await expect(closeOwnerDecision(w.decisions, id, { text: "ok" })).rejects.toMatchObject({ code: "DECISION_BAD_CHOICE" });
      expect(w.jobs.get("j2")?.capReached?.ownerDecision).toBeUndefined();
      const closed = await closeOwnerDecision(w.decisions, id, { text: "ok", choice });
      expect(closed.review).toEqual({ jobId: "j2", outcome: w.jobs.get("j2")!.capReached!.ownerDecision!.outcome });
      expect(w.jobs.get("j2")?.capReached?.ownerDecision?.decisionId).toBe(id);
      outcomes.push(w.jobs.get("j2")!.capReached!.ownerDecision!.outcome);
    }
    expect(outcomes).toEqual(["continue", "rereview", "hold"]);
  });
});
