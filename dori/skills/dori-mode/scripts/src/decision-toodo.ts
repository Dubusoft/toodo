import { type OwnerDecision, patchOne } from "./decision-store.ts";
import { scrubForThread } from "./freshness.ts";
import { errLine } from "./line-text.ts";
import { TOODO_DEFAULT_ROOM_REF } from "./config.ts";
import {
  parseToodoRef, TOODO_DEFAULT_ROOM, TOODO_THREAD_REF, type ToodoAction, type ToodoChat, type ToodoChatMessage, type ToodoPlace,
} from "./messenger/toodo-chat.ts";

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
  d.kind !== "request" && d.options.length > 0
    ? d.options.map((option, i) => ({ key: toodoChoiceKey(d.id, i + 1), label: buttonLabel(`${i + 1}. ${option}`), style: i + 1 === d.recommend ? "primary" : "default" }))
    : [];

const tag = (d: Pick<OwnerDecision, "kind">): string => (d.kind === "request" ? "요청" : "결정");

/**
 * The decision card's text. The
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
export const TOODO_DECISION_CHANNEL = TOODO_DEFAULT_ROOM_REF;

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


export type CloseOptions = {
  /** The close text: the reply to the owner, except for a decision that relays to its lane, where it goes to the lane (relaysToLane). */
  readonly text: string;
  /** The owner's line in the thread confirmation, in place of `text` (or of the automatic line when `text` goes to the lane). */
  readonly ownerText?: string;
  readonly choice?: number;
  /** `<channel>/<message>` of an answer the owner gave outside the decision thread. */
  readonly from?: string;
  readonly cancel?: boolean;
  /** The tasks each covered answer message holds; the close covers one of them (the rest go to `dori handled --lane`). */
  readonly tasks?: number;
};

/**
 * A lane's own question or request (asked with `dori report`), or a lead decision opened with `--relay-to`: its close
 * text is relayed to that lane (decision-relay.ts), not shown to the owner.
 */
export const relaysToLane = (d: Pick<OwnerDecision, "source" | "lane" | "relayTo">): boolean =>
  !!d.lane && (d.source === "lane" || d.relayTo === d.lane);

export const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);

export const decisionCloseText = (d: OwnerDecision, options: CloseOptions, home: string): string => {
  const from = options.from !== undefined && isAnswerRef(options.from);
  const picked = options.choice !== undefined ? ` ${options.choice}번(${cut(d.options[options.choice - 1] ?? "", 60)})` : "";
  // An owner message the close covered (`--from`, kept as coveredAnswers for the Toodo close line) is the owner's answer.
  const by = d.answeredAt === undefined && !d.revisions?.length && !from && !d.coveredAnswers?.length && !options.cancel ? " (리드가 정함)" : "";
  const note = (options.ownerText ?? (relaysToLane(d) ? `레인 ${d.lane}에 전달합니다` : options.text)).replace(/\s+/g, " ").trim();
  const outcome = options.cancel ? "취소" : d.kind === "request" ? "요청 처리" : `결정 반영:${picked}`;
  return scrubForThread(`[System] ${d.id} ${outcome}${d.kind === "request" ? "" : by}. ${note}${/[.!?。]$/.test(note) ? "" : "."}`, home);
};

/** The chat receipts recorded when the lead closes a decision. */
export type DecisionReceipts = {
  readonly ack: (channel: string, message: string) => Promise<void>;
  readonly handled: (channel: string, message: string, tasks: number) => Promise<void>;
};

export type AnswerRef = { readonly channel: string; readonly message: string };

export type AnswerOutcome = {
  /** The task count each covered message was recorded with (coverage 1/tasks). */
  readonly tasks: number;
  readonly acked: readonly AnswerRef[];
  readonly ackFailed: readonly (AnswerRef & { readonly error: string })[];
  readonly handled: readonly AnswerRef[];
  readonly handledFailed: readonly (AnswerRef & { readonly error: string })[];
  /** Answer messages acked but not covered (the shared chat place covers only the first answer). */
  readonly left: readonly AnswerRef[];
};

const refKey = (a: AnswerRef): string => `${a.channel}/${a.message}`;
/** Whether `from` identifies one Toodo owner message. */
export const isAnswerRef = (from: string): boolean => /^toodo:(channel|thread)\/\d+\/\d+$/.test(from);
/** The ref of a `<channel>/<message>` key; a Toodo channel ref (`toodo:thread/<id>`) holds a slash itself. */
export const refOf = (key: string): AnswerRef => {
  const cut = key.lastIndexOf("/");
  return cut < 0 ? { channel: key, message: "" } : { channel: key.slice(0, cut), message: key.slice(cut + 1) };
};

/**
 * A shared chat place's close covers the first recorded text answer and `--from`; later messages are only acked.
 */
export const answerTargets = (d: OwnerDecision, from: string | undefined): { readonly covered: string[]; readonly left: string[] } => {
  // A card choice gets its own status reply rather than close receipts.
  const recorded = (d.answers ?? []).filter((a) => a.choice === undefined).map(refKey).filter(isAnswerRef);
  const fromKey = from && isAnswerRef(from) ? [from] : [];
  const covered = [...new Set([...recorded.slice(0, 1), ...fromKey])];
  return { covered, left: [...new Set(recorded)].filter((key) => !covered.includes(key)) };
};

/** The close's lines about the answer messages, in the order they happened. */
export const answerOutcomeLines = (o: AnswerOutcome): string[] => {
  const tasks = o.tasks > 1 ? ` --tasks ${o.tasks}` : "";
  return [
    ...o.acked.map((a) => `DECISION_ACKED ${a.channel} ${a.message}`),
    ...o.ackFailed.map((a) => `DECISION_ACK_FAILED ${a.channel} ${a.message}: ${a.error}; the close went on`),
    ...o.handled.map((a) => `DECISION_HANDLED ${a.channel} ${a.message} coverage=1/${o.tasks}`),
    ...o.handledFailed.map((a) => `DECISION_HANDLED_FAILED ${a.channel} ${a.message}: ${a.error}; run the close again, or dori handled ${a.channel} ${a.message} --reply${tasks}`),
    ...o.left.map((a) => `DECISION_ANSWER_LEFT ${a.channel} ${a.message}: acked, not covered by the close; cover it with dori handled ${a.channel} ${a.message} --reply|--lane KEY`),
  ];
};

/** Records handled --reply for each covered answer not recorded yet, each success noted on the decision at once. */
export const recordAnswersHandled = async (
  stateDir: string, receipts: DecisionReceipts, d: OwnerDecision,
): Promise<{ readonly handled: AnswerRef[]; readonly handledFailed: (AnswerRef & { readonly error: string })[] }> => {
  const handled: AnswerRef[] = [];
  const handledFailed: (AnswerRef & { readonly error: string })[] = [];
  const done = new Set(d.handledAnswers ?? []);
  for (const key of d.coveredAnswers ?? []) {
    if (done.has(key) || !isAnswerRef(key)) continue;
    const ref = refOf(key);
    try {
      await receipts.handled(ref.channel, ref.message, d.closeTasks ?? 1);
      patchOne(stateDir, d.id, (x) => ({ ...x, handledAnswers: [...new Set([...(x.handledAnswers ?? []), key])] }));
      handled.push(ref);
    } catch (e) {
      handledFailed.push({ ...ref, error: errLine(e) });
    }
  }
  return { handled, handledFailed };
};
