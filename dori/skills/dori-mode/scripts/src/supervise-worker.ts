// The supervisor as the host's Worker (host/src/main.ts): the same run as `dori supervise`, stopped by the host's
// `stop` message instead of a signal, with a heartbeat the host's watchdog reads.
import { homedir } from "node:os";

import { HEARTBEAT_INTERVAL_MS, type HostToWorker, type WorkerToHost } from "../../../../../host/src/protocol.ts";
import { leadContext } from "./commands/context.ts";
import { envFilePath, loadEnvFile } from "./credentials.ts";
import { runSupervisor } from "./commands/supervise.ts";
import { loadConfig } from "./config.ts";
import { Registry } from "./registry.ts";
import { handleScheduleRequest } from "./schedule-admin.ts";
import { setDefaultRunTimeout } from "./run.ts";
import { convertJsonState } from "./store-convert.ts";

declare const self: Worker;

const post = (message: WorkerToHost): void => { self.postMessage(message); };

const controller = new AbortController();
const configured = loadConfig();
self.addEventListener("message", (event: MessageEvent<HostToWorker>) => {
  const message = event.data;
  if (message.type === "stop") controller.abort();
  // The Toodo web app's scheduled-jobs panel, relayed by the host: applied to sources.json, which the next pass reads.
  else void configured.then((config) => { post({ type: "schedules", id: message.id, reply: handleScheduleRequest(config.stateDir, config.displayTimeZone, message.request, Date.now()) }); });
});

const heartbeat = setInterval(() => { post({ type: "heartbeat" }); }, HEARTBEAT_INTERVAL_MS);

// toodo.service puts no secret in its environment: the Worker reads ~/.dori/env (the Discord token, GH_TOKEN, ...) into
// its own process.env, which the main thread never sees. The commands it starts get them through `env: process.env`.
const envFile = envFilePath(process.env.HOME || homedir());
console.log(`SUPERVISOR_ENV ${loadEnvFile(process.env, envFile).length} entries from ${envFile}`);

const config = await configured;
await convertJsonState(config.stateDir);
setDefaultRunTimeout(config.runTimeoutMs);
const { deps } = leadContext(config, new Registry(config.stateDir), "supervise", [], { values: {}, positionals: [] });
post({ type: "ready" });
await runSupervisor(deps, controller.signal);
clearInterval(heartbeat);
console.log("SUPERVISOR_STOPPED");
post({ type: "stopped" });
// Shutdown is done: leftover timers, sockets or child pipes must not keep the Worker alive.
process.exit(0);
