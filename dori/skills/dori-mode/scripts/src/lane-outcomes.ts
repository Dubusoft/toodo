import { readFileSync, statSync } from "node:fs";
import { redactSecrets } from "./redact.ts";
import { join } from "node:path";

import { eventClass, forLead } from "./event-policy.ts";
import { replaceFileAtomic } from "./durable-write.ts";
import { dropFile, publishReceipt, receiptPaths } from "./receipts.ts";
import type { Registry } from "./registry.ts";
import type { Event, Journal, JournalCore, LaneOutcome } from "./supervise-journal.ts";

/**
 * Lane outcome reports: "a lane finished, so the owner is told", enforced the way owner messages are (ack, handled,
 * UNHANDLED). A lane claimed done (LANE_DONE_CLAIMED <key>) or finished (LANE_CLOSED <key>, or CI_MERGED ... lane=<key>)
 * opens one report obligation per lane key; a rejected claim (LANE_NOT_DONE, or the lead's `dori object-done`) drops the
 * obligation it opened while no real outcome has joined it. The lead tells the owner itself and then records
 * `dori reported <key>`, an immutable receipt the supervisor consumes.
 * An obligation still open after reportTimeoutMin comes back as urgent `UNREPORTED <key> ...`, re-sent with backoff; in
 * push mode it also keeps the lead pushed and counts toward the push escalation. The supervisor posts the report itself
 * only for a clean claim config autoReport covers (below).
 *
 * The obligation is also the lane's one finish record: a finish event that joins it with nothing new for the lead is
 * quiet and wakes no one (supervise-delivery.ts); it rides along with the next delivery. That is a claimed lane's first
 * CI_MERGED, or one at a PR head the row already saw merged: the claim already woke the lead, and the merge closes the
 * lane at once (done-flow.ts mergeConfirmed). Once an event of the row has woken the lead, a close whose Toodo task the
 * supervisor finished (`toodo=done`, or `toodo=not-adopted` for a lane closed not adopted; task-finish.ts) or that has none (`toodo=no-task`) and the lane's
 * AUTOPILOT_LANE_DONE are quiet too: one lane result wakes the lead once. A claim, a close the lead still has work on, and a merge at another PR head always wake; so do the
 * failure lines (LANE_NOT_DONE, TOODO_TASK_NOT_COMPLETED, AUTOPILOT_LANE_FAILED), which never join a row.
 *
 * A clean claim the supervisor reported to the owner itself (config autoReport, done-flow.ts) arrives as digest
 * `LANE_DONE_AUTO_REPORTED <key> ...`. Its post wrote the `dori reported` receipt first, so the row it opens or joins is
 * already reported and no UNREPORTED follows; it counts as the lane's claim, so a later merge of the claimed head is quiet
 * and LANE_NOT_DONE drops the row as for any claim.
 */

export const REPORTED_DIR = "reported";
/** The open obligations as the supervisor last saw them, for readers without its store (`dori inbox take`). */
export const UNREPORTED_FILE = "unreported.json";
/** Reminders after the first wait reportTimeoutMin, then twice as long each time, up to this. */
export const REPORT_REPEAT_MAX_MS = 60 * 60_000;
/** A reported outcome is kept this long, so a later outcome event of the same lane stays deduplicated. */
export const REPORTED_KEEP_MS = 7 * 24 * 60 * 60_000;
export const OUTCOME_LINE_MAX = 300;

const LANE_KEY = /^[\w.-]+$/;

export class ReportedError extends Error {}

const CLAIM = "LANE_DONE_CLAIMED ";
const AUTO_REPORTED = "LANE_DONE_AUTO_REPORTED ";
/** A done claim, whether the lead reports it or the supervisor already did. */
const isClaim = (line: string): boolean => line.startsWith(CLAIM) || line.startsWith(AUTO_REPORTED);
const REJECTED = "LANE_NOT_DONE ";
const MERGED = "CI_MERGED ";
const AUTOPILOT_DONE = "AUTOPILOT_LANE_DONE ";
/** A close after which nothing is left for the lead: the supervisor finished the lane's Toodo task, or it has none. */
const FINISHED_CLOSE = /^LANE_CLOSED \S+ closed\b.* toodo=(?:done|not-adopted|no-task)(?= |$)/;

/** The PR head a `CI_MERGED ... head=<sha> ...` line names. */
const mergedHead = (line: string): string | undefined => (line.startsWith(MERGED) ? / head=(\S+)/.exec(line)?.[1] : undefined);

const keyOf = (lane: string | undefined): string | undefined => (lane && LANE_KEY.test(lane) ? lane : undefined);

/**
 * The lane an obligation-opening event names: a done claim `LANE_DONE_CLAIMED <key> ...` (or `LANE_DONE_AUTO_REPORTED
 * <key> ...`), or a finished lane `LANE_CLOSED <key> ...` / `CI_MERGED ... lane=<key> ...`. A machine lane's
 * LANE_AUTO_CLAIMED names none.
 */
export const outcomeLane = (line: string): string | undefined =>
  keyOf(line.startsWith("LANE_CLOSED ") || isClaim(line) ? line.split(" ")[1] : line.startsWith("CI_MERGED ") ? / lane=(\S+)/.exec(line)?.[1] : undefined);

/** The lane an autopilot lane's done outcome names (`AUTOPILOT_LANE_DONE #<task> lane=<key> ...`): it joins a row, never opens one. */
const riderLane = (line: string): string | undefined => keyOf(line.startsWith(AUTOPILOT_DONE) ? / lane=(\S+)/.exec(line)?.[1] : undefined);

/** The lane whose done claim was rejected: `LANE_NOT_DONE <key> ...`. */
export const rejectedLane = (line: string): string | undefined => keyOf(line.startsWith(REJECTED) ? line.split(" ")[1] : undefined);

/** Where `dori reported` posted the report: the message id and its target (a Toodo chat ref). */
export type ReportedPost = { readonly message: string; readonly target: string };

/**
 * The lead's receipt that it told the owner about lane `lane`'s outcome: tmp, fsync, rename, then both directories.
 * `dori reported` writes it only after its post returned `posted.message`.
 */
export const recordReported = (stateDir: string, lane: string, at: number, note?: string, posted?: ReportedPost): string => {
  if (!LANE_KEY.test(lane)) throw new ReportedError("usage: dori reported <key> --text TEXT [--to TARGET] [--thread ID] [--note TEXT] (a lane key)");
  return publishReceipt(stateDir, REPORTED_DIR, at, { lane, at, ...(note ? { note: redactSecrets(note) } : {}), ...(posted ? { message: posted.message, target: posted.target } : {}) });
};

/** `message` and `target` are absent in receipts written before `dori reported` posted the report itself. */
export type ReportedReceipt = {
  readonly path: string; readonly lane: string; readonly at: number; readonly note?: string; readonly message?: string; readonly target?: string;
};

/** Receipts waiting for the supervisor; unreadable or malformed files are skipped (and never dropped). */
export const pendingReported = (stateDir: string): ReportedReceipt[] => {
  return receiptPaths(join(stateDir, REPORTED_DIR)).flatMap((path) => {
    try {
      const { lane, at, note, message, target } = JSON.parse(readFileSync(path, "utf8")) as {
        lane?: unknown; at?: unknown; note?: unknown; message?: unknown; target?: unknown;
      };
      if (typeof lane !== "string" || !LANE_KEY.test(lane)) return [];
      return [{
        path, lane, at: typeof at === "number" && Number.isFinite(at) ? at : statSync(path).mtimeMs,
        ...(typeof note === "string" && note ? { note } : {}),
        ...(typeof message === "string" && message ? { message } : {}),
        ...(typeof target === "string" && target ? { target } : {}),
      }];
    } catch { return []; }
  });
};

export const unreported = (journal: Journal): LaneOutcome[] => (journal.outcomes ?? []).filter((outcome) => outcome.reportedAt === undefined);

export const reportRule = (lane: string): string => `run dori reported ${lane} --text TEXT to post the outcome to the owner in its thread`;

type Published = { readonly lane: string; readonly since: number; readonly line?: string };

/** The published open report obligations (UNREPORTED_FILE); empty when unreadable. */
export const publishedUnreported = (stateDir: string): Published[] => {
  let list: unknown;
  try { list = JSON.parse(readFileSync(join(stateDir, UNREPORTED_FILE), "utf8")); } catch { return []; }
  return Array.isArray(list) ? list.filter((item: Partial<Published>) => typeof item?.lane === "string" && LANE_KEY.test(item.lane) && typeof item.since === "number") : [];
};

/** `dori inbox take`'s reminder lines (id<TAB>line, like the events) from the supervisor's published obligations. */
export const takeReminders = (stateDir: string): string[] =>
  publishedUnreported(stateDir).map((item) => `unreported:${item.lane}\tUNREPORTED ${item.lane} since ${new Date(item.since).toISOString()}: ${reportRule(item.lane)}`);

export class OutcomeTracking {
  private published?: string;
  /** The last tick pass, settled or not: the next one starts after it (tick). */
  private ticking: Promise<void> = Promise.resolve();

  constructor(private readonly core: JournalCore, private readonly enqueue: (id: string, line: string) => void) {}

  private get journal(): Journal { return this.core.journal; }
  private set journal(journal: Journal) { this.core.journal = journal; }
  private get windowMs(): number { return this.core.deps.tunables.reportTimeoutMin * 60_000; }

  /**
   * A live done claim or finished-lane event opens its lane's obligation; a later one of the same lane (the claim, then
   * its seen-claim close; CI_MERGED, then LANE_CLOSED) joins it, so one lane is one report. Only an event that reaches
   * the lead counts. A row opened by a claim stays marked `claim` until a real outcome joins it; LANE_NOT_DONE drops
   * such a row, reported or not, so the next claim is owed afresh. The caller persists.
   */
  track(event: Event): void {
    const rejected = rejectedLane(event.line);
    if (rejected) { this.dropClaim(rejected); return; }
    const rider = riderLane(event.line);
    const lane = outcomeLane(event.line) ?? rider;
    const cls = eventClass(event.line, this.core.deps.tunables.eventPolicy);
    if (!lane || !forLead(cls)) return;
    const outcomes = this.journal.outcomes ?? [];
    const at = outcomes.findIndex((outcome) => outcome.lane === lane);
    const line = event.line.slice(0, OUTCOME_LINE_MAX);
    const found = at < 0 ? undefined : outcomes[at];
    if (found?.events?.includes(event.id) || (rider && !found)) return;
    // Claim-only while every event in the row is a claim (a receipt-only row has none yet).
    const claim = isClaim(event.line) && (!found || found.claim === true || !found.events?.length);
    const head = mergedHead(event.line);
    const heads = found?.heads ?? [];
    // A merge after the claim (of the claimed head, or one already merged) adds nothing the lead must do now.
    const merge = event.line.startsWith(MERGED) && found?.claimed === true && (!heads.length || (head !== undefined && heads.includes(head)));
    // A row from before `woke` was kept counts its claim as the wake.
    const woke = found?.woke === true || found?.claimed === true;
    // The lead already woke for this lane's result: a finished close or the autopilot outcome adds nothing it must do now.
    const quiet = merge || (woke && (rider !== undefined || FINISHED_CLOSE.test(event.line)));
    const { claim: _was, ...kept } = found ?? { lane, since: event.at ?? this.core.deps.clock.now() };
    const next: LaneOutcome = {
      ...kept, line: kept.line ?? line, events: [...(kept.events ?? []), event.id], ...(claim ? { claim } : {}),
      ...(isClaim(event.line) ? { claimed: true as const } : {}),
      ...(head && !heads.includes(head) ? { heads: [...heads, head] } : {}),
      ...(quiet ? { quiet: [...(kept.quiet ?? []), event.id] } : {}),
      ...(woke || (cls === "lead-urgent" && !quiet) ? { woke: true as const } : {}),
    };
    this.journal = { ...this.journal, outcomes: at < 0 ? [...outcomes, next] : outcomes.map((outcome, i) => (i === at ? next : outcome)) };
  }

  /** Drops `lane`'s row if a claim opened it and no real outcome joined it. */
  private dropClaim(lane: string): void {
    const outcomes = this.journal.outcomes ?? [];
    if (!outcomes.some((outcome) => outcome.lane === lane && outcome.claim)) return;
    this.journal = { ...this.journal, outcomes: outcomes.filter((outcome) => !(outcome.lane === lane && outcome.claim)) };
    console.log(`LANE_OUTCOME_CLAIM_DROPPED ${lane}`);
  }

  /**
   * `dori reported` receipts close their lane's obligation; one for a lane with none yet (reported before its outcome
   * event arrived) is kept, so that event opens nothing. Persisted before the receipts are dropped: a replay only takes
   * the earliest report time again. Receipts are taken in time order.
   */
  consumeReceipts(): void {
    const receipts = pendingReported(this.core.deps.config.stateDir).sort((a, b) => a.at - b.at);
    if (!receipts.length) return;
    const outcomes = [...(this.journal.outcomes ?? [])];
    for (const receipt of receipts) {
      const at = outcomes.findIndex((outcome) => outcome.lane === receipt.lane);
      const found = at < 0 ? undefined : outcomes[at];
      const note = found?.note ?? receipt.note;
      const next: LaneOutcome = {
        ...(found ?? { lane: receipt.lane, since: receipt.at }),
        reportedAt: Math.min(found?.reportedAt ?? Infinity, receipt.at),
        ...(note ? { note } : {}),
      };
      if (at < 0) outcomes.push(next); else outcomes[at] = next;
      if (found?.reportedAt === undefined) console.log(`LANE_OUTCOME_REPORTED ${receipt.lane}`);
    }
    this.journal = { ...this.journal, outcomes };
    this.core.persist();
    for (const receipt of receipts) dropFile(receipt.path);
    this.publish();
  }

  /** Event `id` joined its lane's finish record with nothing new for the lead: it must not wake it (supervise-delivery.ts). */
  quiet(id: string): boolean {
    return (this.journal.outcomes ?? []).some((outcome) => outcome.quiet?.includes(id));
  }

  /** Reminded obligations, or those past their first window: they keep a pushed lead pushed (supervise-push.ts). */
  due(now: number): LaneOutcome[] {
    return unreported(this.journal).filter((outcome) => (outcome.reminders ?? 0) > 0 || now - outcome.since >= this.windowMs);
  }

  /** The delivery log is the handoff boundary. Do not use a pane sample taken before this write as working evidence. */
  markDelivered(): void {
    if (this.journal.restart) return;
    const ready = (outcome: LaneOutcome) => outcome.reportedAt === undefined && outcome.deliveredAt === undefined &&
      outcome.events?.some((id) => this.core.delivered.has(id));
    if (!this.journal.outcomes?.some(ready)) return;
    const now = this.core.deps.clock.now();
    this.journal = { ...this.journal, outcomes: this.journal.outcomes.map((outcome) => ready(outcome) ? { ...outcome, deliveredAt: now } : outcome) };
    this.core.persist("normal");
  }

  /** The first pointer that carried an obligation starts its escalation clock (no escalation before a pointer, N1). */
  markPushed(lanes: readonly string[], now: number): void {
    const want = new Set(lanes);
    if (!(this.journal.outcomes ?? []).some((outcome) => want.has(outcome.lane) && outcome.pushedAt === undefined)) return;
    this.journal = {
      ...this.journal,
      outcomes: this.journal.outcomes?.map((outcome) => (want.has(outcome.lane) && outcome.pushedAt === undefined ? { ...outcome, pushedAt: now } : outcome)),
    };
    this.core.persist();
  }

  /**
   * One pass: receipts first, then one urgent UNREPORTED when a delivered turn ends (working observed after delivery,
   * then idle/done), or reportTimeoutMin passes. Later reminders back off up to REPORT_REPEAT_MAX_MS. A lane whose brief declared
   * `autoClose: machine` closes with no lead wake and owes no report. Nothing is reminded while a lead restart runs: the
   * published list is kept current, and the new lead's `dori inbox take` prints every open obligation. Reported rows are
   * dropped after REPORTED_KEEP_MS. A claim-only row is dropped once the registry holds an objection made at or after it
   * opened: `dori object-done` writes only the registry and is never an event.
   *
   * Passes run one at a time, in call order: lead delivery and the report check tick from separate supervisor tasks,
   * and a pass writes back the outcome list it read before its awaits.
   */
  tick(registry: Pick<Registry, "read">, leadStatus?: () => Promise<string | undefined>): Promise<void> {
    const pass = this.ticking.then(() => this.tickOnce(registry, leadStatus));
    this.ticking = pass.catch(() => {});
    return pass;
  }

  private async tickOnce(registry: Pick<Registry, "read">, leadStatus?: () => Promise<string | undefined>): Promise<void> {
    this.consumeReceipts();
    if (this.journal.restart) { this.publish(); return; }
    const watching = (outcome: LaneOutcome) => outcome.reportedAt === undefined && outcome.deliveredAt !== undefined && !(outcome.reminders ?? 0);
    const status = leadStatus && this.journal.outcomes?.some(watching) ? await leadStatus() : undefined;
    // A receipt arriving during the pane lookup wins too.
    this.consumeReceipts();
    if (this.journal.restart) { this.publish(); return; }
    const now = this.core.deps.clock.now();
    const window = this.windowMs;
    let changed = false;
    const outcomes: LaneOutcome[] = [];
    for (let outcome of this.journal.outcomes ?? []) {
      const objection = outcome.claim ? (await registry.read(outcome.lane))?.objection : undefined;
      if (objection && Date.parse(objection.at) >= outcome.since) {
        console.log(`LANE_OUTCOME_CLAIM_DROPPED ${outcome.lane}`);
        changed = true;
        continue;
      }
      if (outcome.reportedAt !== undefined) {
        if (now - outcome.reportedAt >= REPORTED_KEEP_MS) changed = true;
        else outcomes.push(outcome);
        continue;
      }
      const reminders = outcome.reminders ?? 0;
      const turnEnded = watching(outcome) && outcome.deliveredWorking && (status === "idle" || status === "done");
      if (watching(outcome) && status === "working" && !outcome.deliveredWorking) {
        outcome = { ...outcome, deliveredWorking: true };
        changed = true;
      }
      const wait = reminders === 0 ? window : Math.min(window * 2 ** (reminders - 1), Math.max(REPORT_REPEAT_MAX_MS, window));
      if (!turnEnded && now - (outcome.remindedAt ?? outcome.since) < wait) { outcomes.push(outcome); continue; }
      if (reminders === 0 && (await registry.read(outcome.lane))?.autoClose === "machine") {
        outcomes.push({ ...outcome, reportedAt: now, note: "autoClose: machine" });
        changed = true;
        continue;
      }
      const minutes = Math.round((now - outcome.since) / 60_000);
      this.enqueue(`unreported:${outcome.lane}:${outcome.since}:${reminders + 1}`,
        `UNREPORTED ${outcome.lane} ${outcome.claim ? "claimed done" : "finished"} ${minutes} min ago and the owner has not been told: ${reportRule(outcome.lane)}. ${outcome.line ?? ""}`.trimEnd());
      outcomes.push({ ...outcome, reminders: reminders + 1, remindedAt: now });
      changed = true;
    }
    if (changed) {
      this.journal = { ...this.journal, outcomes };
      this.core.persist("normal");
    }
    this.publish();
  }

  /** Writes UNREPORTED_FILE when the open obligations changed (tmp + rename; it is derived, the store is the record). */
  publish(): void {
    const list: Published[] = unreported(this.journal).map(({ lane, since, line }) => ({ lane, since, ...(line ? { line } : {}) }));
    const text = JSON.stringify(list);
    if (text === this.published) return;
    const path = join(this.core.deps.config.stateDir, UNREPORTED_FILE);
    replaceFileAtomic(path, text, 0o600);
    this.published = text;
  }
}
