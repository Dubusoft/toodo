import { decisionNoticeText } from "./decision-delivery.ts";
import { answeredEventId, type DirectRouting, recordOwnerAnswer, routeDecisionClick, routeOwnerMessage } from "./decision-inbound.ts";
import { directAnswer, type OwnerDecision, patchOne, readDecisions } from "./decision-store.ts";
import { TOODO_CHOICE_KEY } from "./decision-toodo.ts";
import {
  parseToodoRef, type ToodoChat, type ToodoChatMessage, toodoErrorText, toodoRef,
} from "./messenger/toodo-chat.ts";
import { answeredLine } from "./owner-decisions.ts";

/** Whether `d` waits on the owner: open (the lead holds no answer) with no direct answer on its way to the lane. */
const waitsOnOwner = (d: OwnerDecision): boolean => d.state === "open" && directAnswer(d) === undefined;

export type ToodoDecisionDeps = {
  readonly stateDir: string;
  readonly chat: () => ToodoChat;
  readonly home: string;
  /** The title a task gets for its thread when it has none yet (its lane's title). */
  readonly threadTitle: (d: OwnerDecision) => Promise<string>;
  readonly log: (line: string) => void;
};

/** Keeps each card thread's waiting mark in sync with its decisions. */
export const toodoDecisionTick = async (deps: ToodoDecisionDeps): Promise<void> => {
  const chat = deps.chat();
  const threads = new Map<string, OwnerDecision[]>();
  for (const d of readDecisions(deps.stateDir).decisions) {
    if (d.toodo?.place.startsWith("toodo:thread/")) threads.set(d.toodo.place, [...(threads.get(d.toodo.place) ?? []), d]);
  }
  for (const [place, decisions] of threads) {
    const want = decisions.some(waitsOnOwner);
    if (want === decisions.some((d) => d.toodo?.awaiting === true)) continue;
    try {
      await chat.awaiting(parseToodoRef(place).id, want);
      for (const d of decisions) patchOne(deps.stateDir, d.id, (x) => (x.toodo ? { ...x, toodo: { ...x.toodo, awaiting: want } } : x));
      deps.log(`TOODO_DECISION_AWAITING ${place} ${want ? "on" : "off"}`);
    } catch (e) { deps.log(`TOODO_DECISION_AWAITING_FAILED ${place}: ${toodoErrorText(e)}; retried next round`); }
  }
};

/** The owner "message" a card button press is recorded under: one per choice message, using its chat message id. */
const clickOf = (m: Pick<ToodoChatMessage, "id">): string => `toodo-${m.id}`;

/** Whether the owner message `message` of `place` is already recorded on a decision (a revision or an answer). */
const recorded = (stateDir: string, place: string, message: string): boolean =>
  readDecisions(stateDir).decisions.some((d) => d.revisions?.some((r) => r.channel === place && r.message === message)
    || d.answers?.some((a) => a.channel === place && a.message === message));

/** The owner's status line for the direct answer message `message` gave in `place`, when there is one. */
const directNotice = (stateDir: string, place: string, message: string): string | undefined => {
  for (const d of readDecisions(stateDir).decisions) {
    const r = d.revisions?.findLast((x) => x.channel === place && x.message === message);
    if (r) return decisionNoticeText(d, r);
  }
  return undefined;
};

/** Routes Toodo card choices and replies before unmatched messages are journaled for the lead. */
export const routeToodoOwnerMessage = async (routing: DirectRouting, chat: () => ToodoChat, m: ToodoChatMessage): Promise<"direct" | "lead"> => {
  const place = toodoRef(m.place);
  if (m.choiceOf) {
    const pick = TOODO_CHOICE_KEY.exec(m.choiceOf.key);
    if (!pick) return "lead";
    const interaction = clickOf(m);
    if (recorded(routing.stateDir, place, `click:${interaction}`)) return "direct";
    const reply = await routeDecisionClick(routing, { decision: pick[1] ?? "", choice: Number(pick[2]), channel: place, interaction });
    const line = reply ?? directNotice(routing.stateDir, place, `click:${interaction}`);
    if (line) await chat().reply(m.place, line, [m.id]);
    return "direct";
  }
  const id = String(m.id);
  const seen = recorded(routing.stateDir, place, id);
  if (await routeOwnerMessage(routing, place, { id, content: m.body, attachments: m.attachments }) === "direct") {
    const line = seen ? undefined : directNotice(routing.stateDir, place, id);
    if (line) await chat().reply(m.place, line, [m.id]);
    return "direct";
  }
  if (!seen) {
    try {
      const answer = recordOwnerAnswer(routing.stateDir, place, id, routing.now(), { content: m.body });
      if (answer?.first) await routing.emit(answeredEventId(answer.decision.id), answeredLine(answer.decision));
    } catch (e) {
      routing.log(`DECISION_ERROR cannot record the owner's answer in ${place} (${toodoErrorText(e)})`);
    }
  }
  return "lead";
};

/** Toodo receipts for owner answers; the handled receipt links back to the decision card. */
export const toodoAnswerReceipts = (stateDir: string, chat: () => ToodoChat) => ({
  ack: async (message: string): Promise<void> => { await chat().ack([Number(message)]); },
  handled: async (channel: string, message: string): Promise<void> => {
    // The answer the decision recorded, or a reply its close covers with --from (which no decision recorded).
    const d = readDecisions(stateDir).decisions.find((x) => x.toodo !== undefined
      && (x.answers?.some((a) => a.channel === channel && a.message === message) || x.coveredAnswers?.includes(`${channel}/${message}`)));
    if (!d?.toodo) throw new Error(`no decision card in ${channel} holds answer ${message}`);
    await chat().markHandled(Number(message), { replyId: d.toodo.message });
  },
});
