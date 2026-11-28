import type { LaneMessageStore } from "./lane-messages.ts";
import { clickMessageId, queueDecisionAnswer, type QueueOutcome, recordAnswerRevision, viaButton } from "./decision-delivery.ts";
import { answersIn, type AnswerRevision, type DecisionsFile, decisionTargetOf, directAnswer, type OwnerDecision, readDecisions, sameTarget, type TargetLane, updateDecisions } from "./decision-store.ts";
import { answeredLine, choiceLabel } from "./owner-decisions.ts";

/*
 * Routing an owner message to exactly one side (references/messaging.md, "Decision answers straight to the lane"):
 * `direct` when it is a qualifying answer to an open question a lane asked, recorded as an answer revision and queued as
 * lane message decision-d<ID>-r<n>; `lead` for everything else, which then reaches the lead as INBOUND exactly as before.
 * A message keeps the side it got first: an edit or delete of a direct answer revises or withdraws it, an edit or delete
 * of any other message goes to the lead.
 */

export type InboundSide = "direct" | "lead";

/** The owner message fields routing reads. */
export type RoutedMessage = {
  readonly id: string;
  readonly content: string;
  readonly attachments: readonly unknown[];
};

export type DirectRouting = {
  readonly stateDir: string;
  readonly store: () => LaneMessageStore;
  /** The lanes not closed, as the registry has them now. */
  readonly lanes: () => Promise<readonly TargetLane[]>;
  readonly now: () => number;
  /** Journals one event for the lead under a stable id. */
  readonly emit: (id: string, line: string) => Promise<void>;
  readonly log: (line: string) => void;
};

/** The qualifying answer forms: the whole trimmed text is `N`, or `d<ID>=<N>` (`d` either case). Attachments disqualify. */
export type AnswerForm = { readonly choice: number; readonly id?: string };

export const parseAnswerForm = (m: Pick<RoutedMessage, "content" | "attachments">): AnswerForm | undefined => {
  if (m.attachments.length) return undefined;
  const text = m.content.trim();
  const bare = /^(\d{1,3})$/.exec(text);
  if (bare) return { choice: Number(bare[1]) };
  const named = /^d(\d{1,9})=(\d{1,3})$/i.exec(text);
  return named ? { id: `d${Number(named[1])}`, choice: Number(named[2]) } : undefined;
};

const waiting = (d: OwnerDecision): boolean => d.state === "open" || d.state === "answered";

/**
 * The one decision a form names: `d<ID>=<N>` names it outright; a bare `N` names the only waiting question in thread
 * `channel`, or among several the only one still waiting on the owner (open, no direct answer on its way to the lane: one already answered there is
 * corrected by its button or `d<ID>=<N>`). Never the newest question by guess.
 */
export const answeredDecision = (decisions: readonly OwnerDecision[], channel: string, form: AnswerForm): OwnerDecision | undefined => {
  if (form.id !== undefined) {
    const named = decisions.find((d) => d.id === form.id);
    return named && waiting(named) ? named : undefined;
  }
  const here = decisions.filter((d) => answersIn(d, channel) && waiting(d));
  if (here.length === 1) return here[0];
  const unanswered = here.filter((d) => d.state === "open" && directAnswer(d) === undefined);
  return unanswered.length === 1 ? unanswered[0] : undefined;
};

/**
 * Whether `d` may take a direct answer now: a lane's own question (not a request, not the lead's), with a recorded
 * target whose lane is still open on the same runner and session, and no answer the lead already holds.
 */
export const delegated = (d: OwnerDecision, lanes: readonly TargetLane[]): boolean => {
  if (d.source !== "lane" || d.kind === "request" || !d.target || d.answers?.length) return false;
  const target = d.target;
  const lane = lanes.find((l) => l.key === target.lane);
  return lane !== undefined && sameTarget(target, decisionTargetOf(lane));
};

/** The decision holding answer revisions from owner message `channel`/`message`, and its newest such revision. */
const directOf = (stateDir: string, channel: string, message: string): { readonly decision: OwnerDecision; readonly last: AnswerRevision } | undefined => {
  let found: { decision: OwnerDecision; last: AnswerRevision } | undefined;
  for (const d of readDecisions(stateDir).decisions) {
    const last = d.revisions?.filter((r) => r.channel === channel && r.message === message).at(-1);
    if (last && (!found || last.at >= found.last.at)) found = { decision: d, last };
  }
  return found;
};

const choiceText = (d: OwnerDecision, r: AnswerRevision): string => (r.choice === undefined ? "withdrawn" : choiceLabel(d, r.choice));

/** Queues the newest revision's lane message and tells the lead: digest, or urgent when the lane may have had an older one. */
const deliver = async (routing: DirectRouting, d: OwnerDecision, r: AnswerRevision): Promise<void> => {
  let outcome: QueueOutcome;
  try { outcome = queueDecisionAnswer(routing.stateDir, routing.store(), d.id, routing.now()); }
  catch (e) {
    // The intent is recorded: the next start's reconcile queues it under the same id.
    routing.log(`DECISION_ROUTE_ERROR ${d.id} r${r.rev} not queued (${e instanceof Error ? e.message : String(e)}); reconciled at the next start`);
    return;
  }
  const from = `from ${r.channel}/${r.message}${viaButton(r)}`;
  const head = `${r.target.lane} ${d.id} r${r.rev} ${choiceText(d, r)} ${r.delivery.id}`;
  const line = outcome.kind === "queued" && outcome.replaces !== undefined
    ? `DECISION_ANSWER_CORRECTED ${head} replaces r${outcome.replaces} ${from}: the lane may have acted on r${outcome.replaces}; it gets the ${r.choice === undefined ? "withdrawal" : "correction"} to ack`
    : outcome.kind === "queued" ? `DECISION_ANSWER_DIRECT ${head} ${from}: queued for the lane, nothing to do`
    : outcome.kind === "none" ? undefined
    : `DECISION_ANSWER_DIRECT ${head} ${from}: ${outcome.reason}, nothing sent`;
  if (!line) return;
  try { await routing.emit(`decision-direct:${d.id}:r${r.rev}`, line); }
  catch { routing.log(`DECISION_ROUTE_ERROR cannot queue the lead's line for ${d.id} r${r.rev}`); }
};

/** Records `choice` (or a withdrawal) from the message as a revision of `d`; "refused" leaves everything as it was. */
const revise = async (routing: DirectRouting, d: OwnerDecision, channel: string, m: RoutedMessage, choice: number): Promise<"recorded" | "duplicate" | "refused"> => {
  if (!d.target) return "refused";
  const result = recordAnswerRevision(routing.stateDir, d.id, {
    channel, message: m.id, edit: 0, content: m.content, target: d.target, choice,
  }, routing.now());
  if (result.kind === "recorded") await deliver(routing, result.decision, result.revision);
  return result.kind;
};

/** Answers `form` names, when it qualifies: "direct" once recorded (or seen before), else "lead". */
const answer = async (routing: DirectRouting, channel: string, m: RoutedMessage): Promise<InboundSide> => {
  const form = parseAnswerForm(m);
  if (!form) return "lead";
  const d = answeredDecision(readDecisions(routing.stateDir).decisions, channel, form);
  if (!d || !delegated(d, await routing.lanes())) return "lead";
  return (await revise(routing, d, channel, m, form.choice)) === "refused" ? "lead" : "direct";
};

/**
 * A new owner message. A message already recorded as a direct answer stays
 * direct with nothing new; a failure before anything is recorded leaves it to the lead.
 */
export const routeOwnerMessage = async (routing: DirectRouting, channel: string, m: RoutedMessage): Promise<InboundSide> => {
  try {
    if (directOf(routing.stateDir, channel, m.id)) return "direct";
    return await answer(routing, channel, m);
  } catch (e) {
    routing.log(`DECISION_ROUTE_ERROR ${channel}/${m.id} goes to the lead (${e instanceof Error ? e.message : String(e)})`);
    return "lead";
  }
};

type DecisionClick = { readonly decision: string; readonly choice: number; readonly channel: string; readonly interaction: string };

/** Routes a Toodo card choice to the lane or the lead and returns any immediate owner reply. */
export const routeDecisionClick = async (routing: DirectRouting, click: DecisionClick): Promise<string | undefined> => {
  const d = readDecisions(routing.stateDir).decisions.find((x) => x.id === click.decision);
  if (!d || !answersIn(d, click.channel)) return "이 스레드의 질문 버튼이 아닙니다.";
  if (!waiting(d)) return `${d.id}은 이미 닫힌 질문입니다.`;
  const newest = d.revisions?.at(-1);
  if (newest?.choice !== undefined && newest.delivery.state === "acked") return `레인이 이미 ${d.id}의 ${newest.choice}번을 받았습니다. 다른 답은 스레드에 적어 주세요.`;
  if (d.kind === "request" || click.choice < 1 || click.choice > d.options.length) return `${d.id}에 없는 선택지입니다.`;
  const lastPick = d.answers?.findLast((a) => a.choice !== undefined);
  const shown = lastPick && (!newest || lastPick.at >= newest.at) ? lastPick.choice : newest?.choice;
  const toLead = async (): Promise<string | undefined> => {
    const recorded = recordButtonAnswer(routing.stateDir, d.id, click.channel, clickMessageId(click.interaction), click.choice, routing.now());
    if (!recorded?.added) return recorded?.decision.state === "closed" ? `${d.id}은 이미 닫힌 질문입니다.` : `${d.id}에 이미 ${click.choice}번으로 답했습니다.`;
    const at = recorded.first ? answeredEventId(d.id) : `decision-button:${d.id}:${click.interaction}`;
    const line = recorded.first ? answeredLine(recorded.decision)
      : `DECISION_ANSWER_CORRECTED ${d.lane ?? "-"} ${d.id} ${choiceLabel(d, click.choice)}${shown !== undefined ? ` replaces choice=${shown}` : ""} via button: `
        + `the owner changed the answer the lead holds; settle it with dori decision close ${d.id} --choice ${click.choice} --text "..."`;
    await routing.emit(at, line);
    return recorded.first || shown === undefined
      ? `${d.id}에 ${click.choice}번으로 답했습니다. 레인에 바로 전달할 수 없어 리드에게 넘겼습니다.`
      : `${d.id}의 답을 ${click.choice}번으로 바꾸었습니다. 리드에게 정정을 넘겼습니다.`;
  };
  if (shown === click.choice) return `${d.id}에 이미 ${click.choice}번으로 답했습니다.`;
  if (!delegated(d, await routing.lanes())) return toLead();
  const m: RoutedMessage = { id: clickMessageId(click.interaction), content: `${d.id}=${click.choice}`, attachments: [] };
  if ((await revise(routing, d, click.channel, m, click.choice)) === "refused") return toLead();
  return newest?.choice !== undefined ? `${d.id}의 답을 ${click.choice}번으로 바꾸었습니다. 레인에 정정을 전달합니다.` : undefined;
};


/** What an owner message in a decision thread says about its target. */
export type AnswerHint = { readonly content?: string };

/**
 * The decision an owner message in thread `channel` answers. With one waiting decision there, that one; with several (a
 * shared thread), the only one its text names by id (`d136`); never
 * the newest by guess, so a message that names none answers none and the lead reads it and picks.
 */
const answerTarget = (decisions: readonly OwnerDecision[], channel: string, hint: AnswerHint): OwnerDecision | undefined => {
  const waiting = decisions.filter((d) => answersIn(d, channel) && (d.state === "open" || d.state === "answered"));
  if (waiting.length <= 1) return waiting[0];
  const ids = new Set(Array.from(hint.content?.matchAll(/(?<![A-Za-z0-9])d(\d{1,9})(?![0-9])/gi) ?? [], (m) => `d${Number(m[1])}`));
  const named = waiting.filter((d) => ids.has(d.id));
  return named.length === 1 ? named[0] : undefined;
};

export const answeredEventId = (id: string): string => `owner-decision-answered:${id}`;

/**
 * Records an owner message in decision thread `channel` on the decision it answers (answerTarget): each message id once,
 * on one decision only (a replay or a decision posted later must not take an answer
 * an earlier one already holds). The first answer moves the decision to `answered` and returns `first: true` with the
 * event id to raise. A closed decision records nothing. Undefined when `channel` is no decision's thread, or when a shared
 * thread's message names no one decision.
 */
export const recordOwnerAnswer = (stateDir: string, channel: string, message: string, at: number, hint: AnswerHint = {}): { readonly decision: OwnerDecision; readonly first: boolean } | undefined => {
  return recordAnswer(stateDir, (file) => answerTarget(file.decisions, channel, hint), channel, message, at);
};


/**
 * Records the owner's press of button `choice` on decision `id`, made in `channel` as interaction message `message`
 * (decision-inbound.ts routeDecisionClick, a click the lane cannot take directly), as an answer the lead holds, like
 * recordOwnerAnswer: each click once; the first answer moves the decision to `answered` and returns `first: true`.
 * `added` is false for a click already recorded or a closed decision. Undefined for an unknown decision.
 */
const recordButtonAnswer = (
  stateDir: string, id: string, channel: string, message: string, choice: number, at: number,
): { readonly decision: OwnerDecision; readonly first: boolean; readonly added: boolean } | undefined =>
  recordAnswer(stateDir, (file) => file.decisions.find((d) => d.id === id), channel, message, at, choice);

/** The decision already holding owner message `channel`/`message` as an answer, or covering it with its close. */
const heldBy = (decisions: readonly OwnerDecision[], channel: string, message: string): OwnerDecision | undefined =>
  decisions.find((d) => d.answers?.some((a) => a.channel === channel && a.message === message) || d.coveredAnswers?.includes(`${channel}/${message}`));

const recordAnswer = (
  stateDir: string, pick: (file: DecisionsFile) => OwnerDecision | undefined, channel: string, message: string, at: number, choice?: number,
): { readonly decision: OwnerDecision; readonly first: boolean; readonly added: boolean } | undefined =>
  updateDecisions(stateDir, (file): { file?: DecisionsFile; result: { decision: OwnerDecision; first: boolean; added: boolean } | undefined } => {
    const held = heldBy(file.decisions, channel, message);
    if (held) return { result: { decision: held, first: false, added: false } };
    const d = pick(file);
    if (!d) return { result: undefined };
    if (!waiting(d)) return { result: { decision: d, first: false, added: false } };
    const first = d.answeredAt === undefined;
    const next: OwnerDecision = {
      ...d, answers: [...(d.answers ?? []), { channel, message, at, ...(choice !== undefined ? { choice } : {}) }],
      ...(first ? { state: "answered" as const, answeredAt: at, answerEvent: answeredEventId(d.id) } : {}),
    };
    return { file: { ...file, decisions: file.decisions.map((x) => (x.id === d.id ? next : x)) }, result: { decision: next, first, added: true } };
  });
