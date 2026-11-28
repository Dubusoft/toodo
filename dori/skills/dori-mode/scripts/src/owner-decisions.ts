import type { DoriConfig } from "./config.ts";
import {
  answerOutcomeLines, type AnswerOutcome, type AnswerRef, answerTargets, type CloseOptions, decisionCloseText, type DecisionReceipts,
  cut, postToodoCard, recordAnswersHandled, refOf, relaysToLane, TOODO_DECISION_CHANNEL, toodoDecisionPlace,
} from "./decision-toodo.ts";
import {
  DECISION_KEEP_CLOSED_MS, DECISION_RELAY_ATTEMPTS, type DecisionTarget, type OwnerDecision,
  OwnerDecisionError, patchOne, readDecisions, removeOne, type ReviewCapDecision, type TargetLane, decisionTargetOf, updateDecisions,
} from "./decision-store.ts";
import { recordResolved } from "./decision-obligations.ts";
import { errLine } from "./line-text.ts";
import { parseToodoRef, TOODO_THREAD_REF, type ToodoChat, toodoRef } from "./messenger/toodo-chat.ts";
import { type DecisionChoices, parseDecisionText, parseRequestText } from "./runner/decision-text.ts";
import { recordReviewDecision, REVIEW_DECISION_OUTCOMES, type ReviewDecisionOutcome, ReviewJobs } from "./review-jobs.ts";

export { answerOutcomeLines, type DecisionReceipts, isAnswerRef, relaysToLane } from "./decision-toodo.ts";

export type DecisionConfig = Pick<DoriConfig, "stateDir" | "displayTimeZone">;

export type DecisionContext = {
  readonly config: DecisionConfig;
  readonly now: () => number;
  readonly home: string;
  readonly receipts?: DecisionReceipts;
  readonly toodo: () => Pick<ToodoChat, "taskThread" | "reply">;
};

/** The Toodo task number in an autopilot lane key `ap-<task>-<attempt>`. */
export const taskOfLane = (lane: string | undefined): number | undefined => {
  const m = lane === undefined ? null : /^ap-(\d+)-\d+$/.exec(lane);
  return m ? Number(m[1]) : undefined;
};

/** The thread id of a Toodo chat thread ref. */
export const refIds = (ref: string | undefined): { readonly thread: string } | undefined =>
  ref !== undefined && TOODO_THREAD_REF.test(ref) ? { thread: String(parseToodoRef(ref).id) } : undefined;

export type OpenResult = {
  readonly decision: OwnerDecision;
  readonly duplicateOf?: string;
};

export type DecisionSpec = DecisionChoices & {
  readonly kind?: "request";
  readonly file?: string;
  readonly task?: number;
  readonly lane?: string;
  readonly origin?: string;
  readonly source: "lead" | "lane";
  readonly sourceRef?: string;
  readonly target?: DecisionTarget;
  /** A lead decision's `--relay-to`: the same key as `lane`. */
  readonly relayTo?: string;
  readonly reviewCap?: ReviewCapDecision;
};

/** Reserves a decision id, posts the card in its chat place, and records the post. */
export const openOwnerDecision = async (ctx: DecisionContext, spec: DecisionSpec): Promise<OpenResult> => {
  const { stateDir } = ctx.config;
  const reserved = updateDecisions<OpenResult>(stateDir, (file) => {
    const known = spec.sourceRef ? file.decisions.find((d) => d.source === spec.source && d.sourceRef === spec.sourceRef) : undefined;
    if (known) return { result: { decision: known } };
    if (spec.source === "lane" && spec.lane) {
      const same = file.decisions.find((d) => d.state !== "closed" && d.lane === spec.lane && d.question === spec.question);
      if (same) return { result: { decision: same, duplicateOf: same.id } };
    }
    const decision: OwnerDecision = {
      ...spec, id: `d${file.nextSeq}`, state: "posting", channel: TOODO_DECISION_CHANNEL, openedAt: ctx.now(),
    };
    return { file: { ...file, nextSeq: file.nextSeq + 1, decisions: [...file.decisions, decision] }, result: { decision } };
  });
  const d = reserved.decision;
  if (reserved.duplicateOf || d.state !== "posting" || d.channel !== TOODO_DECISION_CHANNEL) return reserved;
  try {
    const chat = ctx.toodo();
    const place = d.thread ? parseToodoRef(d.thread) : await toodoDecisionPlace(chat, d);
    const card = await postToodoCard(chat, place, d, ctx.home);
    const thread = toodoRef(place);
    const posted = { state: "open", thread, message: String(card.id), toodo: { place: thread, message: card.id } } as const;
    return { decision: patchOne(stateDir, d.id, (x) => ({ ...x, ...posted })) ?? { ...d, ...posted } };
  } catch (e) {
    removeOne(stateDir, d.id);
    throw new OwnerDecisionError("DECISION_NOT_POSTED", `DECISION_NOT_POSTED ${errLine(e)}`);
  }
};

export type CloseResult = {
  readonly decision: OwnerDecision;
  readonly resolved?: string;
  readonly answers?: AnswerOutcome;
  readonly review?: { readonly jobId: string; readonly outcome: ReviewDecisionOutcome };
};

/** Posts the close confirmation in the card's place, then settles the decision and its receipts. */
export const closeOwnerDecision = async (ctx: DecisionContext, id: string, options: CloseOptions): Promise<CloseResult> => {
  const { stateDir } = ctx.config;
  const { receipts } = ctx;
  const d = readDecisions(stateDir).decisions.find((x) => x.id === id);
  if (!d) throw new OwnerDecisionError("DECISION_UNKNOWN", `DECISION_UNKNOWN ${id}`);
  if (d.state === "closed") {
    const again = receipts ? await recordAnswersHandled(stateDir, receipts, d) : { handled: [], handledFailed: [] };
    const lines = answerOutcomeLines({ tasks: d.closeTasks ?? 1, acked: [], ackFailed: [], left: [], ...again });
    throw new OwnerDecisionError("DECISION_ALREADY_CLOSED", `DECISION_ALREADY_CLOSED ${id}`, lines);
  }
  if (options.choice !== undefined && d.kind === "request") throw new OwnerDecisionError("DECISION_BAD_CHOICE", `DECISION_BAD_CHOICE ${id}: a request takes no --choice`);
  if (options.choice !== undefined && (!Number.isInteger(options.choice) || options.choice < 1 || options.choice > d.options.length)) {
    throw new OwnerDecisionError("DECISION_BAD_CHOICE", `DECISION_BAD_CHOICE ${id}: --choice must be 1-${d.options.length}`);
  }
  if (d.reviewCap && options.choice === undefined && !options.cancel) {
    throw new OwnerDecisionError("DECISION_BAD_CHOICE", `DECISION_BAD_CHOICE ${id}: a review limit decision closes with --choice 1-${d.options.length} (or --cancel)`);
  }
  const place = decisionChatRef(d);
  const tasks = options.tasks ?? 1;
  const targets = answerTargets(d, options.from);
  const acked: AnswerRef[] = [];
  const ackFailed: (AnswerRef & { readonly error: string })[] = [];
  if (receipts) {
    for (const key of [...targets.covered, ...targets.left]) {
      const ref = refOf(key);
      try { await receipts.ack(ref.channel, ref.message); acked.push(ref); }
      catch (e) { ackFailed.push({ ...ref, error: errLine(e) }); }
    }
  }
  // A review limit decision's outcome is recorded on its job first too: the review gate reads it from there.
  let review: CloseResult["review"];
  const outcome = d.reviewCap && options.choice !== undefined ? REVIEW_DECISION_OUTCOMES[options.choice - 1] : undefined;
  if (d.reviewCap && outcome) {
    try {
      recordReviewDecision(new ReviewJobs(stateDir), ctx.now(), d.reviewCap.jobId, d.id, outcome);
      review = { jobId: d.reviewCap.jobId, outcome };
    } catch (e) { throw new OwnerDecisionError("DECISION_REVIEW_FAILED", `DECISION_REVIEW_FAILED ${id}: ${errLine(e)}; nothing closed`); }
  }
  if (place) {
    try { await ctx.toodo().reply(parseToodoRef(place), decisionCloseText(d, options, ctx.home)); }
    catch (e) { throw new OwnerDecisionError("DECISION_NOT_CLOSED", `DECISION_NOT_CLOSED ${id} ${errLine(e)}`); }
  }
  const at = ctx.now();
  const closed = patchOne(stateDir, id, (x) => x.state === "closed" ? undefined : ({
    ...x, state: "closed", closedAt: at, closeText: options.text,
    ...(options.choice !== undefined ? { choice: options.choice } : {}), ...(options.cancel ? { cancelled: true } : {}),
    ...(receipts && targets.covered.length ? { coveredAnswers: targets.covered, closeTasks: tasks } : {}),
  })) ?? d;
  let resolved: string | undefined;
  if (closed.answerEvent) {
    recordResolved(stateDir, closed.answerEvent, at, `decision ${id}`);
    resolved = closed.answerEvent;
  }
  const answers = receipts
    ? { tasks: closed.closeTasks ?? tasks, acked, ackFailed, left: targets.left.map(refOf), ...await recordAnswersHandled(stateDir, receipts, closed) }
    : undefined;
  return { decision: closed, ...(resolved ? { resolved } : {}), ...(answers ? { answers } : {}), ...(review ? { review } : {}) };
};

export const short = (text: string, max = 80): string => cut(text.replace(/\s+/g, " ").trim(), max);
/** How the lead's lines name a choice: its number and option text, `choice=2 "Replace"`. */
export const choiceLabel = (d: Pick<OwnerDecision, "options">, choice: number): string => `choice=${choice} "${short(d.options[choice - 1] ?? "", 80)}"`;
/** The question as the lead's lines show it: a request marked `[request]`. */
const subject = (d: OwnerDecision, max = 80): string => (d.kind === "request" ? `[request] ${short(d.question, max - 10)}` : short(d.question, max));
/** The card's place, or no chat place for a record predating Toodo. */
type DecisionPlaceRecord = Pick<OwnerDecision, "channel" | "thread" | "toodo">;
const decisionChatRef = (d: DecisionPlaceRecord): string | undefined =>
  d.toodo?.place ?? (d.channel === TOODO_DECISION_CHANNEL ? d.thread : undefined);

export const decisionRef = (d: DecisionPlaceRecord): string => decisionChatRef(d) ?? "-";

/** The event raised by the owner's first answer; its second word is the lane (`-` for none), as decision obligations read it. */
export const answeredLine = (d: OwnerDecision): string => {
  const answer = d.answers?.[0];
  // A button press the lane could not take directly supplies the choice to the lead.
  const button = answer?.choice;
  const value = d.kind === "request"
    ? `; ${d.file ? `the owner says the value is in ${d.file}` : `the owner's reply is message ${answer?.channel ?? "?"}/${answer?.message ?? "?"}`} (never into a report, the repo or another thread)`
    : "";
  const close = `dori decision close ${d.id}${button !== undefined ? ` --choice ${button}` : ""} --text "..."`;
  const head = `OWNER_DECISION_ANSWERED ${d.lane ?? "-"} ${d.id} ${d.blocking ? "blocking" : "nonblocking"} ${decisionRef(d)}: ${subject(d)}`
    + (button !== undefined ? ` ${choiceLabel(d, button)} via button` : "");
  // One wording for decisions and requests: the close is the first call, and for a decision that relays to its lane it
  // also types --text into that lane (decision-relay.ts), so --text is what the lane needs to go on.
  const relay = relaysToLane(d)
    ? ` and types --text into lane ${d.lane}, so write it for the lane; hand it over yourself only on DECISION_RELAY_FAILED`
    : d.lane ? `; it does not reach lane ${d.lane}, relay it yourself` : "";
  return `${head}${value}; run ${close} first (it acks the answer, posts the reply, records it handled${relay}; --tasks N when the answer asks for more work), then act on it`;
};

/** The lead's urgent line for a close whose text could not be typed into its lane after every attempt (decision-relay.ts). */
export const relayFailedLine = (d: Pick<OwnerDecision, "id" | "relay">): string =>
  `DECISION_RELAY_FAILED ${d.relay?.lane ?? "-"} ${d.id}: ${d.relay?.reason ?? "not delivered"}; the close text did not reach the lane after ${d.relay?.attempts ?? 1} attempts and is not retried again, hand it to the lane yourself with dori lane send naming ${d.id} (its parked goal resumes once the lane acks it)`;

/** The digest event of a decision the supervisor opened from a lane question. */
export const openedLine = (d: OwnerDecision, duplicateOf?: string): string =>
  `OWNER_DECISION_OPENED ${d.id} lane ${d.lane ?? "-"} ${d.blocking ? "blocking" : "nonblocking"} ${decisionRef(d)} ${subject(d)}${duplicateOf ? ` (duplicate of ${duplicateOf})` : ""}`;

const age = (ms: number): string => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min >= 2880 ? `${Math.floor(min / 1440)}d` : min >= 60 ? `${Math.floor(min / 60)}h` : `${min}m`;
};

/** `dori decision list`'s line for one decision. */
export const decisionListLine = (d: OwnerDecision, now: number): string => {
  const last = d.revisions?.at(-1);
  const answer = last ? ` answer=r${last.rev}:${last.choice ?? "withdrawn"} delivery=${last.delivery.state}` : "";
  return `${d.id} ${d.state} ${d.blocking ? "blocking" : "nonblocking"}${d.task !== undefined ? ` task=#${d.task}` : ""}${d.lane ? ` lane=${d.lane}` : ""}${answer} age=${age(now - d.openedAt)} thread=${decisionRef(d)} ${subject(d)}`;
};

/** Decisions not closed, oldest first. */
export const openOwnerDecisions = (stateDir: string): OwnerDecision[] =>
  readDecisions(stateDir).decisions.filter((d) => d.state !== "closed").sort((a, b) => a.openedAt - b.openedAt);

/**
 * `dori inbox take`'s informational lines (not checklist items: the owner has not answered yet, or the answer is already
 * an UNRESOLVED reminder): one per decision not closed.
 */
export const takeOwnerDecisionLines = (stateDir: string, now: number): string[] =>
  openOwnerDecisions(stateDir).map((d) =>
    `decision:${d.id}\tDECISION_${d.state === "answered" ? "ANSWERED" : "WAITING"} ${d.id} ${d.blocking ? "blocking" : "nonblocking"}${d.task !== undefined ? ` task=#${d.task}` : ""}${d.lane ? ` lane=${d.lane}` : ""} open ${age(now - d.openedAt)}: ${subject(d)}`);

export type TickDeps = DecisionContext & {
  /** Journals one event under a stable id (the supervisor dedupes ids). */
  readonly enqueue: (id: string, line: string) => unknown;
  readonly log?: (line: string) => void;
};

/** Reports exhausted lane relays and prunes expired closed decisions. */
export const ownerDecisionTick = async (deps: TickDeps): Promise<void> => {
  const { stateDir } = deps.config;
  const now = deps.now();
  for (const d of readDecisions(stateDir).decisions) {
    if (d.state === "closed" && d.relay?.state === "failed" && d.relay.reportedAt === undefined && (d.relay.attempts ?? 1) >= DECISION_RELAY_ATTEMPTS) {
      await deps.enqueue(`decision-relay-failed:${d.id}`, relayFailedLine(d));
      patchOne(stateDir, d.id, (x) => (x.relay ? { ...x, relay: { ...x.relay, reportedAt: now } } : x));
    }
  }
  if (readDecisions(stateDir).decisions.some((d) => d.state === "closed" && now - (d.closedAt ?? now) >= DECISION_KEEP_CLOSED_MS)) {
    updateDecisions(stateDir, (f) => ({ file: { ...f, decisions: f.decisions.filter((d) => !(d.state === "closed" && now - (d.closedAt ?? now) >= DECISION_KEEP_CLOSED_MS)) }, result: undefined }));
  }
};

/** A request as a decision spec: what is needed as its question, no options. */
export const requestSpec = (request: { readonly need: string; readonly reason: string; readonly file?: string; readonly waiting: string; readonly blocking: boolean }): DecisionChoices & Pick<DecisionSpec, "kind" | "file"> => ({
  kind: "request", question: request.need, options: [], recommend: 0, reason: request.reason, waiting: request.waiting, blocking: request.blocking,
  ...(request.file ? { file: request.file } : {}),
});

/**
 * Opens the decision or request a lane question carries (its text in a runner/decision-text.ts form: DECISION v1 or
 * REQUEST v1), once per report row; undefined when the text is a free-text question (routed as before). Throws like
 * openOwnerDecision.
 */
export const openLaneDecision = async (
  ctx: DecisionContext, lane: TargetLane & { readonly thread: string }, report: { readonly id: string; readonly text: string },
): Promise<OpenResult | undefined> => {
  const request = parseRequestText(report.text);
  const choices = request ? requestSpec(request) : parseDecisionText(report.text);
  if (!choices) return undefined;
  const task = lane.task ?? taskOfLane(lane.key);
  return openOwnerDecision(ctx, {
    ...choices, source: "lane", sourceRef: report.id, lane: lane.key, ...(request ? {} : { target: decisionTargetOf(lane) }),
    ...(task !== undefined ? { task } : {}), ...(refIds(lane.thread) ? { origin: lane.thread } : {}),
  });
};
