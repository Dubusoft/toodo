// The supervisor as the host's Worker (host/src/main.ts): the same run as `dori supervise`, stopped by the host's
// `stop` message instead of a signal, with a heartbeat the host's watchdog reads.
import { homedir } from "node:os";

import { HEARTBEAT_INTERVAL_MS, type HostToWorker, type WorkerToHost } from "../../../../../host/src/protocol.ts";
import { leadContext } from "./commands/context.ts";
import { envFilePath, loadEnvFile } from "./credentials.ts";
import { runSupervisor } from "./commands/supervise.ts";
import { loadConfig } from "./config.ts";
import { MachineAdmin } from "./machine-admin.ts";
import { Registry } from "./registry.ts";
import { handleScheduleRequest } from "./schedule-admin.ts";
import { realClock, run, setDefaultRunTimeout } from "./run.ts";
import { defaultRunnerDir } from "./runner/fs-safety.ts";
import { convertJsonState } from "./store-convert.ts";

declare const self: Worker;

const post = (message: WorkerToHost): void => { self.postMessage(message); };

const controller = new AbortController();
const configured = loadConfig();
// Settings > Machines & accounts, relayed by the host: every install, sign-in and ssh read runs here, never on the core's
// thread. Built once the supervisor's lane operations exist, which answer the workers' tool versions.
const machinesReady = Promise.withResolvers<MachineAdmin>();
self.addEventListener("message", (event: MessageEvent<HostToWorker>) => {
  const message = event.data;
  if (message.type === "stop") controller.abort();
  // The Toodo web app's scheduled-jobs panel, relayed by the host: applied to sources.json, which the next pass reads.
  else if (message.type === "schedules") void configured.then((config) => { post({ type: "schedules", id: message.id, reply: handleScheduleRequest(config.stateDir, config.displayTimeZone, message.request, Date.now()) }); });
  else void machinesReady.promise.then((admin) => admin.handle(message.request)).then((reply) => { post({ type: "machines", id: message.id, reply }); });
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
machinesReady.resolve(new MachineAdmin({
  stateDir: config.stateDir, guardMachines: config.guardMachines, runnerDir: defaultRunnerDir(), home: process.env.HOME || homedir(),
  env: process.env, run, now: realClock.now, agentCommand: config.agentCommand,
  observeTools: async (label) => (await deps.ops.observeMachine(label, { tools: true })).tools,
  publish: (job) => { post({ type: "machine-job", job }); },
}));
post({ type: "ready" });
await runSupervisor(deps, controller.signal);
clearInterval(heartbeat);
console.log("SUPERVISOR_STOPPED");
post({ type: "stopped" });
// Shutdown is done: leftover timers, sockets or child pipes must not keep the Worker alive.
process.exit(0);
