import { parseArgs } from "node:util";

import type { FlowDeps } from "./done-flow.ts";
import { isToodoRef, parseToodoRef, toodoChat, toodoRef } from "./messenger/toodo-chat.ts";

/**
 * Whether `dori <command> ...` addresses the Toodo chat: `dori send toodo` or `dori send --to <toodo ref>`, and for ack,
 * handled and typing a Toodo ref (or `toodo`) as the first argument.
 */
export const toodoChatCommand = (command: string, rest: readonly string[], key: string | undefined, to: string | undefined): boolean =>
  command === "send" ? key === "toodo" || (to !== undefined && isToodoRef(to))
    : ["ack", "handled", "typing"].includes(command) && rest[0] !== undefined && isToodoRef(rest[0]);

const ids = (values: readonly string[], die: (message: string) => never, usage: string): number[] =>
  values.map((v) => (/^[1-9]\d*$/.test(v) ? Number(v) : die(usage)));

/**
 * `dori send|ack|handled|typing` on the Toodo chat, through toodo-server's MCP chat tools with the `mcp-token`:
 *   send toodo --to REF --text TEXT [--handles ID,...]   Dori's message at REF; it marks the listed messages handled
 *   ack REF ID [REF ID ...]                              read receipts on the owner's messages, and the typing dots on
 *   handled REF ID (--reply ID | --task ID)              the owner's message handled by Dori's reply or a task
 *   typing toodo [--off]                                 the typing dots
 * REF is `toodo:channel/<id>`, `toodo:thread/<id>` or `toodo` (the default room), as INBOUND lines name it.
 */
export const toodoChatMain = async (
  [command = "", ...rest]: readonly string[],
  d: { readonly flow: FlowDeps; readonly die: (message: string, code?: number) => never; readonly opt: (name: string) => string | undefined; readonly need: (name: string) => string },
): Promise<number> => {
  const { flow, die } = d;
  if (!flow.config.platforms.includes("toodo")) die("TOODO_CHAT_OFF the Toodo chat is off: add \"toodo\" to platforms in the dori config");
  const chat = toodoChat(flow.tunables.toodoWriter);
  switch (command) {
    case "send": {
      if (d.opt("edit") !== undefined || d.opt("buttons") !== undefined || d.opt("thread") !== undefined) die("usage: dori send toodo --to REF --text TEXT [--handles ID,...] (no --edit, --buttons or --thread on Toodo)");
      const place = parseToodoRef(d.opt("to") ?? "toodo");
      const handles = d.opt("handles");
      const answered = handles === undefined ? [] : ids(handles.split(",").map((v) => v.trim()), die, "--handles takes Toodo message ids separated by commas");
      const sent = await chat.reply(place, d.need("text"), answered);
      console.log(`SENT toodo:${sent.id} ${toodoRef(sent.place)}`);
      return 0;
    }
    case "ack": {
      const usage = "usage: dori ack REF ID [REF ID ...] (REF a Toodo chat ref, ID its message id)";
      if (!rest.length || rest.length % 2) die(usage);
      const pairs: { ref: string; id: number }[] = [];
      for (let i = 0; i < rest.length; i += 2) {
        const ref = rest[i] ?? "";
        if (!isToodoRef(ref)) die(usage);
        pairs.push({ ref, id: ids([rest[i + 1] ?? ""], die, usage)[0] ?? die(usage) });
      }
      await chat.ack(pairs.map((p) => p.id));
      try { await chat.typing(true); } catch { console.error("ACK_TYPING_FAILED toodo: the typing dots could not be set; the messages are acked"); }
      for (const p of pairs) console.log(`ACKED ${p.ref} ${p.id}`);
      return 0;
    }
    case "handled": {
      const parsed = parseArgs({ args: [...rest], allowPositionals: true, options: { reply: { type: "string" }, task: { type: "string" } } });
      const usage = "usage: dori handled REF ID (--reply ID | --task ID) (REF a Toodo chat ref)";
      const [ref, message, ...extra] = parsed.positionals;
      if (!ref || !message || extra.length || (parsed.values.reply === undefined) === (parsed.values.task === undefined)) die(usage);
      const [id = 0, link = 0] = ids([message ?? "", parsed.values.reply ?? parsed.values.task ?? ""], die, usage);
      await chat.markHandled(id, parsed.values.reply !== undefined ? { replyId: link } : { taskId: link });
      console.log(`HANDLED ${ref} ${id} ${parsed.values.reply !== undefined ? `reply ${link}` : `task #${link}`}`);
      return 0;
    }
    case "typing": {
      const parsed = parseArgs({ args: [...rest], allowPositionals: true, options: { off: { type: "boolean" } } });
      if (parsed.positionals.length !== 1) die("usage: dori typing toodo [--off]");
      const on = parsed.values.off !== true;
      await chat.typing(on);
      console.log(`TYPING toodo ${on ? "on" : "off"}`);
      return 0;
    }
  }
  return die(`unknown Toodo chat command ${command}`);
};
