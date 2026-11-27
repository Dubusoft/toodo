// The supervisor as the host's Worker (host/src/main.ts): the same run as `dori supervise`, stopped by the host's
// `stop` message instead of a signal, with a heartbeat the host's watchdog reads.
import { HEARTBEAT_INTERVAL_MS, type HostToWorker, type WorkerToHost } from "../../../../../host/src/protocol.ts";
import { leadContext } from "./commands/context.ts";
import { runSupervisor } from "./commands/supervise.ts";
import { loadConfig } from "./config.ts";
import { Registry } from "./registry.ts";
import { setDefaultRunTimeout } from "./run.ts";
import { convertJsonState } from "./store-convert.ts";

declare const self: Worker;

const post = (message: WorkerToHost): void => { self.postMessage(message); };

const controller = new AbortController();
self.addEventListener("message", (event: MessageEvent<HostToWorker>) => {
  if (event.data.type === "stop") controller.abort();
});

const heartbeat = setInterval(() => { post({ type: "heartbeat" }); }, HEARTBEAT_INTERVAL_MS);

const config = await loadConfig();
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
