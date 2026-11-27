import type { OwnerDecision } from "./decision-store.ts";
import { scrubForThread } from "./freshness.ts";
import { hasDecisionButtons } from "./messenger/decision-buttons.ts";
import {
  isToodoRef, parseToodoRef, TOODO_DEFAULT_ROOM, TOODO_THREAD_REF, type ToodoAction, type ToodoChat, type ToodoChatMessage, type ToodoPlace,
} from "./messenger/toodo-chat.ts";
import type { DecisionTransport } from "./owner-decisions.ts";

/*
 * Owner decisions on the Toodo chat. Every decision gets a card there (decision-toodo-cards.ts posts it beside a
 * Discord thread): its question with one numbered button per option, or a request with none. For a config whose
 * platforms have no discord the card is the decision itself: it is posted where toodoDecisionPlace says, and recorded with that place's chat ref as its thread. The Toodo chat has no edits or archive: the lead closes the
 * decision with `dori decision close`, and the close's confirmation is posted in the same place.
 */

/** A card button's action key: decision id and option number 1-9. */
export const TOODO_CHOICE_KEY = /^(d\d{1,9}):([1-9])$/;

export const toodoChoiceKey = (decision: string, choice: number): string => `${decision}:${choice}`;

const LABEL_MAX = 80;

const buttonLabel = (text: string): string => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= LABEL_MAX ? chars.join("") : `${chars.slice(0, LABEL_MAX - 1).join("").trimEnd()}…`;
};

/** The card's buttons: one per option labelled `N. <option>`, the recommended one primary; none for a request. */
export const toodoCardActions = (d: Pick<OwnerDecision, "id" | "kind" | "options" | "recommend">): ToodoAction[] =>
  hasDecisionButtons(d)
    ? d.options.map((option, i) => ({ key: toodoChoiceKey(d.id, i + 1), label: buttonLabel(`${i + 1}. ${option}`), style: i + 1 === d.recommend ? "primary" : "default" }))
    : [];

const tag = (d: Pick<OwnerDecision, "kind">): string => (d.kind === "request" ? "요청" : "결정");

/**
 * The card's text: what the Discord starter message says, without Discord's thread links, answered in this place. The
 * app renders it as Markdown, so its parts are paragraphs and the options one numbered list; the head stays plain, since
 * the chat list shows a thread's latest message as raw text.
 */
export const toodoCardText = (d: OwnerDecision, home: string): string => {
  const head = [`[${tag(d)} ${d.id}]`, d.task !== undefined ? `Toodo #${d.task}` : undefined, d.lane ? `레인 ${d.lane}` : undefined].filter(Boolean).join(" · ");
  if (d.kind === "request") return scrubForThread([
    head,
    `필요한 것: ${d.question}`,
    `이유: ${d.reason}`,
    d.file
      ? `보내는 곳: 파일 \`${d.file}\`에 넣고 권한을 600으로 맞춰 주세요(\`chmod 600 ${d.file}\`). 값은 여기에 붙여넣지 마시고, 넣은 뒤 이 대화에 "완료"라고만 답해 주세요.`
      : "보내는 곳: 이 대화에 답으로 보내 주세요(인증코드처럼 한 번 쓰고 끝나는 값만). 비밀번호나 API 키 같은 오래 쓰는 비밀은 여기에 올리지 마세요.",
    d.blocking ? `기다리는 쪽: ${d.lane ? `레인 ${d.lane}, ` : ""}${d.waiting}` : `먼저 진행 중: ${d.lane ? `레인 ${d.lane}, ` : ""}${d.waiting}`,
  ].join("\n\n"), home);
  return scrubForThread([
    head,
    `질문: ${d.question}`,
    d.options.map((option, i) => `${i + 1}. ${option}${i + 1 === d.recommend ? " ← 추천" : ""}`).join("\n"),
    `추천 이유: ${d.reason}`,
    d.blocking ? `기다리는 동안 멈춘 것: ${d.waiting}` : `먼저 진행 중: 추천안(${d.recommend}번)으로 진행하고 있습니다(${d.waiting}). 다르게 정하시면 되돌립니다.`,
    `버튼을 누르거나, 이 대화에 번호나 문장으로 답해 주세요. 열린 질문이 여러이면 \`${d.id}=번호\`로 답해 주세요.`,
  ].join("\n\n"), home);
};

/** Posts `d`'s card at `place`: its text and buttons. */
export const postToodoCard = (chat: Pick<ToodoChat, "reply">, place: ToodoPlace, d: OwnerDecision, home: string): Promise<ToodoChatMessage> =>
  chat.reply(place, toodoCardText(d, home), [], [], toodoCardActions(d));

/** The `channel` a decision on the Toodo chat is recorded with (its thread is the place's chat ref). */
export const TOODO_DECISION_CHANNEL = "toodo";

/**
 * Where a decision goes on the Toodo chat, so the owner meets it where the work is: its task's thread (opened with
 * `title` when it has none), else the Toodo thread it was asked from (its `origin`), else the default room.
 */
export const toodoDecisionPlace = async (
  chat: Pick<ToodoChat, "taskThread">, d: { readonly task?: number; readonly origin?: string }, title = "",
): Promise<ToodoPlace> => {
  if (d.task !== undefined) return chat.taskThread(d.task, title);
  return d.origin !== undefined && TOODO_THREAD_REF.test(d.origin) ? parseToodoRef(d.origin) : TOODO_DEFAULT_ROOM;
};

/**
 * The decision transport that sends a channel named by a Toodo chat ref to the Toodo chat and any other to `discord`
 * (reached only then, so a Toodo decision needs no Discord token). On the Toodo chat a post is a chat message whose id
 * is the message id, answer buttons are left out, and a place reads as an open thread with no parent; the calls only a
 * Discord thread needs are refused.
 */
export const routedDecisionTransport = (discord: () => DecisionTransport, toodo: () => Pick<ToodoChat, "reply">): DecisionTransport => {
  const refused = (what: string, channel: string): Promise<never> => Promise.reject(new Error(`${what} is not available on the Toodo chat (${channel})`));
  return {
    send: async (channel, content, stableId, components) =>
      isToodoRef(channel) ? String((await toodo().reply(parseToodoRef(channel), content)).id) : discord().send(channel, content, stableId, components),
    edit: (channel, messageId, content) => (isToodoRef(channel) ? refused("editing a message", channel) : discord().edit(channel, messageId, content)),
    editComponents: async (channel, messageId, components) => { if (!isToodoRef(channel)) await discord().editComponents(channel, messageId, components); },
    content: (channel, messageId) => (isToodoRef(channel) ? refused("reading a message", channel) : discord().content(channel, messageId)),
    deleteMessage: (channel, messageId) => (isToodoRef(channel) ? refused("deleting a message", channel) : discord().deleteMessage(channel, messageId)),
    messagesAfter: (channel, afterId) => (isToodoRef(channel) ? refused("listing messages", channel) : discord().messagesAfter(channel, afterId)),
    startThread: (channel, messageId, name, memberId, autoArchiveMin) =>
      isToodoRef(channel) ? refused("starting a thread", channel) : discord().startThread(channel, messageId, name, memberId, autoArchiveMin),
    setThread: (threadId, patch) => (isToodoRef(threadId) ? refused("changing a thread", threadId) : discord().setThread(threadId, patch)),
    threadState: async (threadId) => (isToodoRef(threadId) ? { archived: false, parent: undefined } : discord().threadState(threadId)),
    threadArchived: async (threadId) => (isToodoRef(threadId) ? false : discord().threadArchived(threadId)),
  };
};
