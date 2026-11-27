import { homedir } from "node:os";

import { configPath } from "../config.ts";
import type { FlowDeps } from "../done-flow.ts";
import { supervise, SUPERVISE_STOP_DEADLINE_MS, watchSecretStore } from "../supervise-loop.ts";
import { refreshLaneSandbox } from "../lane-sandbox-install.ts";
import { type CliCommand } from "./context.ts";

/** The supervisor until `signal` aborts, as `dori supervise` and the host's supervisor Worker both run it. */
export const runSupervisor = async (deps: FlowDeps, signal: AbortSignal): Promise<void> => {
  // dori update runs the code it started with, so the supervisor it restarts installs the new checkout's sandbox.
  try { const line = refreshLaneSandbox(homedir()); if (line) console.log(line); }
  catch (e) { console.error(`WARN lane sandbox: ${e instanceof Error ? e.message : String(e)}`); }
  const stopSecretWatch = await watchSecretStore();
  try { await supervise(deps, signal, { configFile: configPath() }); }
  finally { stopSecretWatch(); }
};

/** `dori supervise`: own inbound, sweeps and the lead lifecycle until stopped. */
export const superviseCommand: CliCommand = {
  options: {},
  run: async ({ deps }) => {
    const controller = new AbortController();
    // A stop exits within SUPERVISE_STOP_DEADLINE_MS even when a shutdown step hangs, so systemd never waits out its
    // stop timeout (90 s by default) while the owner's clicks and messages have no process to reach.
    const stop = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      setTimeout(() => {
        console.error(`SUPERVISOR_STOP_FORCED shutdown still running ${SUPERVISE_STOP_DEADLINE_MS} ms after the stop signal; exiting`);
        process.exit(0);
      }, SUPERVISE_STOP_DEADLINE_MS).unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try { await runSupervisor(deps, controller.signal); }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    // Shutdown is done: leftover timers, sockets or child pipes must not hold the process.
    console.log("SUPERVISOR_STOPPED");
    process.exit(0);
  },
};
