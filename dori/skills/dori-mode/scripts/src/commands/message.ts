import { type CliCommand, die } from "./context.ts";

/**
 * `dori reported|send|ack|handled|typing`: message-cli.ts checks these shared flags per command and parses the rest
 * itself; send, ack, handled and typing go to the Toodo chat (toodo-chat-cli.ts).
 */
export const messageCommand: CliCommand = {
  options: {
    text: { type: "string" },
    append: { type: "string" },
    to: { type: "string" },
    note: { type: "string" },
    handles: { type: "string" },
  },
  ownFlags: true,
  run: async ({ deps, flags, key, opt, need }) => {
    const { messageMain } = await import("../message-cli.ts");
    const code = await messageMain(process.argv.slice(2), { flow: deps, die, flags, opt, need, key });
    if (code !== 0) process.exit(code);
  },
};
