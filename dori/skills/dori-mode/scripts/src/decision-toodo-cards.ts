import { decisionNoticeText } from "./decision-delivery.ts";
import { type DirectRouting, routeDecisionClick, routeOwnerMessage } from "./decision-inbound.ts";
import { directAnswer, type OwnerDecision, patchOne, readDecisions } from "./decision-store.ts";
import { postToodoCard, TOODO_CHOICE_KEY } from "./decision-toodo.ts";
import {
  isToodoRef, parseToodoRef, TOODO_DEFAULT_ROOM, type ToodoChat, type ToodoChatMessage, toodoErrorText, toodoRef,
} from "./messenger/toodo-chat.ts";
import { answeredEventId, answeredLine, decisionCloseText, recordOwnerAnswer } from "./owner-decisions.ts";

/*
 * Owner decisions on the Toodo chat (config platforms has toodo), beside their Discord threads. Every decision the lead
 * or a lane opens also gets a card (decision-toodo.ts): in its task's thread, else in the default room. A question's
 * card offers one numbered button per option (action key `d<ID>:<N>`); a request's card has none and is answered with a
 * reply. With Discord off the card is the decision itself, posted when it opens, and its close confirmation goes there.
 *
 * A button press comes back as the owner's choice message and is routed like a Discord answer button
 * (decision-inbound.ts routeDecisionClick); a reply in the card's place is routed like a message in the decision's
 * Discord thread: `N` or `d<ID>=<N>` goes straight to the asking lane, anything else is an answer the lead holds
 * (OWNER_DECISION_ANSWERED) and reaches the lead as INBOUND too. While a card waits on the owner its thread is marked as
 * waiting (the app lists its task under Needs answer); the mark comes off once the owner answered, and a closed decision gets one close
 * line under its card. The Discord thread keeps working as before: an answer given there settles the card the same way.
 */

/** The close line under a closed decision's card: the Discord confirmation, which never closes this place. */
export const toodoCloseText = (d: OwnerDecision, home: string): string => {
  const acked = d.revisions?.at(-1)?.delivery.state === "acked";
  return decisionCloseText(d, {
    text: d.closeText ?? "", ...(acked && d.closeText ? { ownerText: d.closeText } : {}),
    ...(d.choice !== undefined ? { choice: d.choice } : {}), ...(d.cancelled ? { cancel: true } : {}),
  }, home, true);
};

/** Whether `d` waits on the owner: open (the lead holds no answer) with no direct answer on its way to the lane. */
export const waitsOnOwner = (d: OwnerDecision): boolean => d.state === "open" && directAnswer(d) === undefined;

export type ToodoDecisionDeps = {
  readonly stateDir: string;
  readonly chat: () => ToodoChat;
  readonly home: string;
  /** The title a task gets for its thread when it has none yet (its lane's title). */
  readonly threadTitle: (d: OwnerDecision) => Promise<string>;
  readonly log: (line: string) => void;
};

/**
 * The supervisor's pass over decisions for the Toodo chat, each step on its own and retried next round when it fails:
 * a card for every decision waiting on an answer that has none (state recorded on the decision; a decision opened on the
 * Toodo chat by a dori from before cards has its starter message taken as its card); one close line under the card of a
 * closed decision that lives on Discord; then each card thread's waiting mark brought in line with its decisions (marked
 * while any of them waits on the owner), written only when it changes.
 */
export const toodoDecisionTick = async (deps: ToodoDecisionDeps): Promise<void> => {
  const chat = deps.chat();
  for (const d of readDecisions(deps.stateDir).decisions) {
    if (d.toodo || (d.state !== "open" && d.state !== "answered")) continue;
    if (d.thread !== undefined && isToodoRef(d.thread) && d.message !== undefined) {
      const place = d.thread;
      const message = Number(d.message);
      patchOne(deps.stateDir, d.id, (x) => ({ ...x, toodo: { place, message } }));
      continue;
    }
    try {
      const place = d.task !== undefined ? await chat.taskThread(d.task, await deps.threadTitle(d)) : TOODO_DEFAULT_ROOM;
      const card = await postToodoCard(chat, place, d, deps.home);
      patchOne(deps.stateDir, d.id, (x) => ({ ...x, toodo: { place: toodoRef(card.place), message: card.id } }));
      deps.log(`TOODO_DECISION_CARD ${d.id} ${toodoRef(card.place)} ${card.id}`);
    } catch (e) { deps.log(`TOODO_DECISION_CARD_FAILED ${d.id}: ${toodoErrorText(e)}; retried next round`); }
  }
  for (const d of readDecisions(deps.stateDir).decisions) {
    // A decision on the Toodo chat has its close confirmation posted in its own place by the close itself.
    if (d.state !== "closed" || !d.toodo || d.toodo.closed || d.thread === d.toodo.place) continue;
    try {
      await chat.reply(parseToodoRef(d.toodo.place), toodoCloseText(d, deps.home));
      patchOne(deps.stateDir, d.id, (x) => (x.toodo ? { ...x, toodo: { ...x.toodo, closed: true } } : x));
    } catch (e) { deps.log(`TOODO_DECISION_CLOSE_FAILED ${d.id}: ${toodoErrorText(e)}; retried next round`); }
  }
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

/** The owner "message" a card button press is recorded under: one per choice message, as for a Discord click. */
const clickOf = (m: Pick<ToodoChatMessage, "id">): string => `toodo-${m.id}`;

/** Whether the owner message `message` of `place` is already recorded on a decision (a revision or an answer). */
const recorded = (stateDir: string, place: string, message: string): boolean =>
  readDecisions(stateDir).decisions.some((d) => d.revisions?.some((r) => r.channel === place && r.message === message)
    || d.answers?.some((a) => a.channel === place && a.message === message));

/** The owner's status line for the direct answer message `message` gave in `place`, when there is one. */
const directNotice = (stateDir: string, place: string, message: string): string | undefined => {
  for (const d of readDecisions(stateDir).decisions) {
    const r = d.revisions?.findLast((x) => x.channel === place && x.message === message);
    if (r) return decisionNoticeText(d, r, undefined, false);
  }
  return undefined;
};

/**
 * Routes one owner message of the Toodo chat before it is journaled: `direct` when the decision path took it and the
 * lead hears of it only through that path's own lines, `lead` when it is journaled as INBOUND.
 *   - A press of a card button (`choiceOf` key `d<ID>:<N>`) is routed like a Discord answer button: a direct answer to
 *     the lane, else an answer the lead holds; the owner gets the status or refusal line under it. A choice on any other
 *     message is the lead's.
 *   - A text in the place of a card is routed like a message in a decision's Discord thread: `N` or `d<ID>=<N>` straight
 *     to the asking lane (with its status line), anything else is recorded as the lead's answer to the card's decision
 *     (OWNER_DECISION_ANSWERED on the first one) and journaled as INBOUND, which carries a request's value.
 * A message recorded before (routed, then the supervisor restarted before the take) is `direct` or `lead` again without
 * a second status line or event.
 */
export const routeToodoOwnerMessage = async (routing: DirectRouting, chat: () => ToodoChat, m: ToodoChatMessage): Promise<"direct" | "lead"> => {
  const place = toodoRef(m.place);
  if (m.choiceOf) {
    const pick = TOODO_CHOICE_KEY.exec(m.choiceOf.key);
    if (!pick) return "lead";
    const interaction = clickOf(m);
    if (recorded(routing.stateDir, place, `click:${interaction}`)) return "direct";
    const reply = await routeDecisionClick(routing, { decision: pick[1] ?? "", choice: Number(pick[2]), channel: place, interaction });
    const line = reply.content ?? directNotice(routing.stateDir, place, `click:${interaction}`);
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

/**
 * `dori decision close`'s receipts for an answer the owner gave in the Toodo chat (`owns`: its channel is a Toodo ref):
 * the read receipt is Toodo's ack, and the handled receipt links the answer to the decision's card. A Discord answer
 * keeps the Discord receipts.
 */
export const toodoAnswerReceipts = (stateDir: string, chat: () => ToodoChat) => ({
  owns: (channel: string): boolean => isToodoRef(channel),
  ack: async (message: string): Promise<void> => { await chat().ack([Number(message)]); },
  handled: async (channel: string, message: string): Promise<void> => {
    const d = readDecisions(stateDir).decisions.find((x) => x.toodo?.place === channel && x.answers?.some((a) => a.channel === channel && a.message === message));
    if (!d?.toodo) throw new Error(`no decision card in ${channel} holds answer ${message}`);
    await chat().markHandled(Number(message), { replyId: d.toodo.message });
  },
});
