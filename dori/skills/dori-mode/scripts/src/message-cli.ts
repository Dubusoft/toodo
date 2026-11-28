import { TOODO_DEFAULT_ROOM_REF } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { oneLine } from "./line-text.ts";
import { isToodoRef, ToodoChatError } from "./messenger/toodo-chat.ts";
import type { ReportPosted } from "./report-post.ts";
import { realClock } from "./run.ts";

export type MessageCliDeps = {
  readonly flow: FlowDeps;
  readonly die: (message: string, code?: number) => never;
  /** The CLI's shared flags (parsed from the arguments after the command), with its opt/need readers and first positional. */
  readonly flags: { readonly values: { readonly [name: string]: unknown }; readonly positionals: readonly string[] };
  readonly opt: (name: string) => string | undefined;
  readonly need: (name: string) => string;
  readonly key: string | undefined;
};

/**
 * The owner message commands, `args` starting with the command: `dori reported` here, and `dori send|ack|handled|typing`
 * on the Toodo chat (toodo-chat-cli.ts). `--to alerts` is the Toodo chat's default room.
 */
export const messageMain = async (args: string[], { flow: deps, die, flags, opt, need, key }: MessageCliDeps): Promise<number> => {
  const [command = ""] = args;
  const { config } = deps;
  if (command !== "reported") {
    const { toodoChatMain } = await import("./toodo-chat-cli.ts");
    const to = opt("to") === "alerts" ? TOODO_DEFAULT_ROOM_REF : opt("to");
    if (command === "send" && key !== undefined && key !== "toodo") die(`unknown platform ${key}`);
    if (command === "send" && to !== undefined && !isToodoRef(to)) die(`SEND_NOT_POSTED --to ${to}: not a Toodo chat ref (alerts, toodo, toodo:channel/<id> or toodo:thread/<id>)`);
    try {
      return await toodoChatMain(args, { flow: deps, die, opt: (name) => (name === "to" ? to : opt(name)), need });
    } catch (e) {
      // A flag the command's own parser does not take, or a target that is no Toodo chat ref, is a usage error, not a crash.
      if (e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS_")) return die(e.message);
      if (e instanceof ToodoChatError) return die(e.message);
      throw e;
    }
  }
  // `dori reported <key> --text T`: post lane <key>'s outcome into its Toodo task thread, then record the receipt. A
  // failed post records nothing, so the obligation stays open. `--append T`: a follow-up to that report (a merge, a
  // finished task) posted into the same thread as its own message.
  const { recordReported } = await import("./lane-outcomes.ts");
  const options = ["text", "append", "note"];
  const append = opt("append");
  if (!key || flags.positionals.length > 1 || Object.keys(flags.values).some((name) => !options.includes(name)) || options.some((name) => name in flags.values && !opt(name))
    || !opt("text") === (append === undefined)) {
    die("usage: dori reported <key> --text TEXT [--note TEXT] | dori reported <key> --append TEXT [--note TEXT]");
  }
  const found = (await deps.registry.read(key ?? "")) ?? die(`no registered lane "${key}"`);
  const note = opt("note");
  if (append !== undefined) {
    // The lane's task thread gets the follow-up, whatever thread the lane was bound to at launch.
    const { appendLaneToodo } = await import("./lane-toodo.ts");
    const appended = await appendLaneToodo(deps, found, append).catch((e: unknown) => ({ appended: false as const, why: e instanceof Error ? e.message : String(e) }));
    if (!appended.appended) return die(`REPORT_NOT_APPENDED ${found.key}: ${appended.why}; nothing recorded`);
    recordReported(config.stateDir, found.key, realClock.now(), note ? oneLine(note) : undefined, { message: appended.message, target: appended.target ?? "toodo" });
    console.log(`REPORT_APPENDED ${found.key} ${appended.message}`);
    return 0;
  }
  const { postLaneReport, ReportPostError } = await import("./report-post.ts");
  const { postLaneReportToodo } = await import("./lane-toodo.ts");
  let posted: ReportPosted;
  try {
    posted = await postLaneReport({ config, now: realClock.now, toodo: (lane, text) => postLaneReportToodo(deps, lane, text) }, found, opt("text") ?? "", { note });
  } catch (e) { if (e instanceof ReportPostError) die(e.message); throw e; }
  console.log(`REPORTED_RECORDED ${found.key} ${posted.message}`);
  return 0;
};
