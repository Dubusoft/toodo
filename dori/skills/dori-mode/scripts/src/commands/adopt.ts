import { adoptLane } from "../launch.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori adopt <key> --pane ID ...`: register an agent already running in a pane as a lane. */
export const adoptCommand: CliCommand = {
  options: {
    mode: { type: "string" },
    title: { type: "string" },
    brief: { type: "string" },
    done: { type: "string" },
    pane: { type: "string" },
    machine: { type: "string" },
    cwd: { type: "string" },
    thread: { type: "string" },
    "share-thread": { type: "boolean" },
    "allow-repo-mismatch": { type: "boolean" },
  },
  run: async ({ deps, flags, key, opt, need, needSupervisor }) => {
    if (opt("mode") !== undefined) die("--mode applies to launch only");
    const adoptInput = { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), pane: need("pane"), machine: opt("machine"), cwd: opt("cwd"), shareThread: Boolean(flags.values["share-thread"]), allowRepoMismatch: Boolean(flags.values["allow-repo-mismatch"]) };
    await needSupervisor();
    const l = await adoptLane(deps, { ...adoptInput, thread: opt("thread") });
    console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
  },
};
