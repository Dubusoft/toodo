import { homedir } from "node:os";
import { parseArgs } from "node:util";

import type { FlowDeps } from "./done-flow.ts";
import { TOODO_THREAD_REF, toodoChat } from "./messenger/toodo-chat.ts";
import { realClock } from "./run.ts";
import { oneLine } from "./line-text.ts";

export type DecisionCliDeps = {
  readonly flow: FlowDeps;
  readonly die: (message: string, code?: number) => never;
};

/** `dori decision open|close|list` for the lead; a refusal or failure ends the process through die. */
export const decisionMain = async (rest: string[], { flow: deps, die }: DecisionCliDeps): Promise<number> => {
  const { config } = deps;
  // `dori decision open|close|list`: owner decisions (owner-decisions.ts), lead-only.
  const { callerLane, laneDecisionRefusal } = await import("./lane-perms.ts");
  const refusal = laneDecisionRefusal(callerLane());
  if (refusal) die(refusal);
  const od = await import("./owner-decisions.ts");
  const ds = await import("./decision-store.ts");
  const { decisionChoicesProblem, inputRequestProblem } = await import("./runner/decision-text.ts");
  const { toodoAnswerReceipts } = await import("./decision-toodo-cards.ts");
  const [sub, ...subArgs] = rest;
  const chat = () => toodoChat(deps.tunables.toodoWriter);
  const context: import("./owner-decisions.ts").DecisionContext = { config, now: realClock.now, home: homedir(), toodo: chat };
  if (sub === "open") {
    const usage = "usage: dori decision open --question TEXT --option TEXT --option TEXT [...] --recommend N --reason TEXT --waiting TEXT [--task N] [--lane KEY | --relay-to KEY] [--thread REF | --no-origin] [--nonblocking] [--from-event EVENT_ID]\n       dori decision open --request --question \"<what is needed>\" --reason TEXT --waiting TEXT [--file PATH] [--task N] [--lane KEY | --relay-to KEY] [--thread REF | --no-origin] [--nonblocking] [--from-event EVENT_ID]";
    const refuse = (reason: string): never => {
      console.error(`DECISION_REFUSED ${reason}`);
      return die(usage, 2);
    };
    const parsed = (() => {
      try {
        return parseArgs({
          args: subArgs, allowPositionals: false, strict: true,
          options: {
            question: { type: "string" }, option: { type: "string", multiple: true }, recommend: { type: "string" }, reason: { type: "string" },
            waiting: { type: "string" }, task: { type: "string" }, lane: { type: "string" }, thread: { type: "string" },
            nonblocking: { type: "boolean" }, "from-event": { type: "string" }, request: { type: "boolean" }, file: { type: "string" },
            "no-origin": { type: "boolean" }, "relay-to": { type: "string" },
          },
        });
      } catch (e) { return refuse(e instanceof Error ? e.message : String(e)); }
    })();
    const v = parsed.values;
    const request = v.request === true;
    if (request && (v.option !== undefined || v.recommend !== undefined)) refuse("a --request takes no --option or --recommend");
    if (!request && v.file !== undefined) refuse("--file goes only with --request");
    const problem = request
      ? inputRequestProblem({ need: v.question, reason: v.reason, waiting: v.waiting, ...(v.file !== undefined ? { file: v.file } : {}) })
      : decisionChoicesProblem({ question: v.question, options: v.option, recommend: v.recommend, reason: v.reason, waiting: v.waiting });
    if (problem) refuse(problem);
    let task: number | undefined;
    if (v.task !== undefined) {
      if (!/^[1-9]\d*$/.test(v.task.trim())) refuse(`--task must be a positive integer, got "${v.task}"`);
      task = Number(v.task.trim());
    }
    // --relay-to names the lane as --lane does and also types the close text into it (decision-relay.ts).
    const relayTo = v["relay-to"]?.trim() || undefined;
    if (v["relay-to"] !== undefined && !relayTo) refuse("--relay-to needs a lane key");
    if (relayTo && v.lane?.trim() && v.lane.trim() !== relayTo) refuse(`--lane ${v.lane.trim()} and --relay-to ${relayTo} name different lanes`);
    const laneKey = relayTo ?? (v.lane?.trim() || undefined);
    const found = laneKey === undefined ? undefined : await deps.registry.read(laneKey);
    if (laneKey !== undefined && !found) refuse(`unknown ${relayTo ? "--relay-to" : "--lane"} ${laneKey}: no registered lane has this key`);
    task ??= found?.task ?? od.taskOfLane(laneKey);
    const thread = v.thread?.trim();
    // A Toodo thread origin puts the card in that thread when the decision has no task (decision-toodo.ts toodoDecisionPlace).
    if (thread !== undefined && !TOODO_THREAD_REF.test(thread)) refuse(`--thread ${thread} is not a thread ref such as toodo:thread/<id>`);
    const laneThread = found?.thread && TOODO_THREAD_REF.test(found.thread) ? found.thread : undefined;
    const noOrigin = v["no-origin"] === true;
    if (noOrigin && thread !== undefined) refuse("--no-origin cannot go with --thread");
    const origin = noOrigin ? undefined : thread ?? laneThread;
    const fromEvent = v["from-event"]?.trim();
    const { recordResolved, validEventId } = await import("./decision-obligations.ts");
    if (fromEvent !== undefined && !validEventId(fromEvent)) refuse(`--from-event ${fromEvent} is not an event id`);
    const asked = request
      ? od.requestSpec({ need: oneLine(v.question ?? ""), reason: oneLine(v.reason ?? ""), waiting: oneLine(v.waiting ?? ""), blocking: v.nonblocking !== true, ...(v.file !== undefined ? { file: oneLine(v.file) } : {}) })
      : { question: oneLine(v.question ?? ""), options: (v.option ?? []).map((text) => oneLine(text)), recommend: Number((v.recommend ?? "").trim()),
        reason: oneLine(v.reason ?? ""), waiting: oneLine(v.waiting ?? ""), blocking: v.nonblocking !== true };
    const opened = await od.openOwnerDecision(context, {
      ...asked, source: "lead",
      ...(task !== undefined ? { task } : {}), ...(laneKey ? { lane: laneKey } : {}), ...(relayTo ? { relayTo } : {}), ...(origin ? { origin } : {}),
    }).catch((e: unknown) => {
      if (e instanceof ds.OwnerDecisionError) die(e.message, 1);
      throw e;
    });
    const d = opened.decision;
    console.log(`DECISION_OPENED ${d.id} ${od.decisionRef(d)}${d.kind === "request" ? " request" : ""}`);
    if (fromEvent !== undefined) {
      recordResolved(config.stateDir, fromEvent, realClock.now(), `decision ${d.id}`);
      console.log(`DECISION_SOURCE_RESOLVED ${d.id} ${fromEvent}`);
    }
    return 0;
  }
  if (sub === "close") {
    const usage = "usage: dori decision close <id> --text TEXT [--owner-text TEXT] [--choice N] [--from CHANNEL/MESSAGE] [--cancel] [--tasks N]";
    const parsed = (() => {
      try {
        return parseArgs({
          args: subArgs, allowPositionals: true, strict: true,
          options: {
            text: { type: "string" }, "owner-text": { type: "string" }, choice: { type: "string" }, from: { type: "string" }, cancel: { type: "boolean" },
            tasks: { type: "string" },
          },
        });
      } catch (e) { return die(`${e instanceof Error ? e.message : String(e)}\n${usage}`, 2); }
    })();
    const [id, ...extra] = parsed.positionals;
    const { text, "owner-text": ownerText, choice, from, cancel, tasks } = parsed.values;
    if (!id || extra.length || !text?.trim() || (ownerText !== undefined && !ownerText.trim()) || (choice !== undefined && !/^\d+$/.test(choice.trim()))
      || (from !== undefined && !od.isAnswerRef(from.trim())) || (cancel && choice !== undefined)
      || (tasks !== undefined && !/^[1-9]\d*$/.test(tasks.trim()))) die(usage, 2);
    const receipts = toodoAnswerReceipts(config.stateDir, chat);
    const closed = await od.closeOwnerDecision({ ...context, receipts: {
      ack: (_channel, message) => receipts.ack(message),
      handled: receipts.handled,
    } }, id ?? "", {
      text: (text ?? "").trim(), ...(ownerText !== undefined ? { ownerText: ownerText.trim() } : {}), ...(choice !== undefined ? { choice: Number(choice.trim()) } : {}),
      ...(from !== undefined ? { from: from.trim() } : {}), ...(cancel ? { cancel: true } : {}),
      ...(tasks !== undefined ? { tasks: Number(tasks.trim()) } : {}),
    }).catch((e: unknown) => {
      if (!(e instanceof ds.OwnerDecisionError)) throw e;
      for (const line of e.lines) console.log(line);
      return die(e.message, e.code === "DECISION_NOT_CLOSED" ? 1 : 2);
    });
    const did = closed.decision.id;
    console.log(`DECISION_CLOSED ${did}`);
    if (closed.review) console.log(`DECISION_REVIEW_RECORDED ${did} job=${closed.review.jobId} outcome=${closed.review.outcome}`);
    const { relayDecisionClose, relayLine } = await import("./decision-relay.ts");
    const relayed = relayLine(await relayDecisionClose(deps, closed.decision));
    if (relayed) console.log(relayed);
    for (const line of closed.answers ? od.answerOutcomeLines(closed.answers) : []) console.log(line);
    if (closed.resolved) console.log(`DECISION_RESOLVED_EVENT ${did} ${closed.resolved}`);
    return 0;
  }
  if (sub === "list") {
    const usage = "usage: dori decision list [--all] [--json]";
    const parsed = (() => {
      try {
        return parseArgs({ args: subArgs, allowPositionals: false, strict: true, options: { all: { type: "boolean" }, json: { type: "boolean" } } });
      } catch (e) { return die(`${e instanceof Error ? e.message : String(e)}\n${usage}`, 2); }
    })();
    const now = realClock.now();
    const listed = ds.readDecisions(config.stateDir).decisions
      .filter((d) => d.state !== "closed" || (parsed.values.all === true && d.closedAt !== undefined && now - d.closedAt <= ds.DECISION_LIST_CLOSED_MS))
      .sort((a, b) => a.openedAt - b.openedAt);
    if (parsed.values.json) console.log(JSON.stringify(listed, null, 2));
    else if (!listed.length) console.log("DECISION_NONE");
    else for (const d of listed) console.log(od.decisionListLine(d, now));
    return 0;
  }
  die("usage: dori decision open|close|list (dori decision open --help)", 2);
  return 0;
};
