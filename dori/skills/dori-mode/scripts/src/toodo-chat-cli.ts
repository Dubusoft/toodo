import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";

import type { FlowDeps } from "./done-flow.ts";
import { isToodoRef, parseToodoRef, TOODO_FILES_MAX, toodoChat, toodoRef } from "./messenger/toodo-chat.ts";

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
 *   send toodo --to REF --text TEXT [--handles ID,...] [--file PATH ...]
 *                                                        Dori's message at REF with the files attached (up to 10; then
 *                                                        --text may be left out); it marks the listed messages handled
 *   ack REF ID [REF ID ...]                              read receipts on the owner's messages, and the typing dots on
 *                                                        at each REF
 *   handled REF ID (--reply ID | --task ID)              the owner's message handled by Dori's reply or a task
 *   typing REF [--off]                                   the typing dots at REF, where the reply goes
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
      const usage = "usage: dori send toodo --to REF --text TEXT [--handles ID,...] [--file PATH ...] (no --edit, --buttons or --thread on Toodo)";
      if (d.opt("edit") !== undefined || d.opt("buttons") !== undefined || d.opt("thread") !== undefined) die(usage);
      const place = parseToodoRef(d.opt("to") ?? "toodo");
      const handles = d.opt("handles");
      const answered = handles === undefined ? [] : ids(handles.split(",").map((v) => v.trim()), die, "--handles takes Toodo message ids separated by commas");
      // --file repeats, which the shared flags (one --file for decision) do not read: take every one from the arguments.
      const paths = parseArgs({ args: [...rest], allowPositionals: true, strict: false, options: { file: { type: "string", multiple: true } } }).values.file;
      const files = (Array.isArray(paths) ? paths : []).map((p) => (typeof p === "string" ? p.trim() : ""));
      if (files.some((p) => !p)) die("--file takes a file path");
      if (files.length > TOODO_FILES_MAX) die(`a Toodo chat message takes at most ${TOODO_FILES_MAX} files`);
      for (const p of files) if (!existsSync(p) || !statSync(p).isFile()) die(`SEND_NOT_POSTED --file ${p}: not a readable file`);
      const text = d.opt("text") ?? "";
      if (!text && !files.length) die(usage);
      const attachments: number[] = [];
      for (const p of files) attachments.push((await chat.upload({ name: basename(p), data: new Uint8Array(readFileSync(p)), contentType: Bun.file(p).type })).id);
      const sent = await chat.reply(place, text, answered, attachments);
      console.log(`SENT toodo:${sent.id} ${toodoRef(sent.place)}${attachments.length ? ` files=${sent.attachments.map((a) => a.id).join(",")}` : ""}`);
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
      // The dots show where the acked messages are, once per place.
      const places = new Map(pairs.map((p) => {
        const place = parseToodoRef(p.ref);
        return [toodoRef(place), place] as const;
      }));
      await chat.ack(pairs.map((p) => p.id));
      try {
        for (const place of places.values()) await chat.typing(place, true);
      } catch { console.error("ACK_TYPING_FAILED toodo: the typing dots could not be set; the messages are acked"); }
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
      const [ref, ...extra] = parsed.positionals;
      if (ref === undefined || extra.length) return die("usage: dori typing REF [--off] (REF a Toodo chat ref)");
      const place = parseToodoRef(ref);
      const on = parsed.values.off !== true;
      await chat.typing(place, on);
      console.log(`TYPING ${toodoRef(place)} ${on ? "on" : "off"}`);
      return 0;
    }
  }
  return die(`unknown Toodo chat command ${command}`);
};
