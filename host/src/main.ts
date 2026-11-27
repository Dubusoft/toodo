// The Toodo host: the core serves HTTP on the main thread and the Dori supervisor runs in a Worker, in one process.
// The host's own code on this thread must not block it, so it makes no *Sync calls (host/src/sync-check.test.ts checks).
import type { Server } from "bun";

import { type Config, configFromEnv } from "../../server/src/http/config.ts";
import { type Core, openCore, SERVE_OPTIONS, stopServing } from "../../server/src/main.ts";
import { type SupervisorEvent, SupervisorHost, type SupervisorSnapshot, type SupervisorTunables, workerSpawner } from "./supervisor.ts";

export const SUPERVISOR_ENTRY = new URL("../../dori/skills/dori-mode/scripts/src/supervise-worker.ts", import.meta.url);

export type CoreFetch = (request: Request, server: Server<undefined>) => Response | Promise<Response>;

export type HostOptions = {
  readonly listen: { readonly hostname: string; readonly port: number };
  /** The core's handler for every request but the host's own `/api/host`. */
  readonly core: CoreFetch;
  /** The supervisor Worker's entry, or `off` for safe mode: the core alone. */
  readonly supervisor: URL | string | "off";
  readonly tunables?: Partial<SupervisorTunables>;
  readonly log?: (line: string) => void;
};

export type HostStatus = {
  readonly supervisor: SupervisorSnapshot | { readonly state: "off" };
};

export type Host = {
  readonly url: URL;
  readonly status: () => HostStatus;
  readonly supervisor: SupervisorHost | undefined;
  readonly reloadSupervisor: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export const eventLine = (event: SupervisorEvent): string => {
  switch (event.kind) {
    case "started": return `HOST_SUPERVISOR_STARTED start=${event.start}`;
    case "ready": return `HOST_SUPERVISOR_READY start=${event.start}`;
    case "failed":
      return `HOST_SUPERVISOR_FAILED start=${event.start} ${event.retryInMs === null ? "no restart" : `restart in ${event.retryInMs} ms`}: ${event.reason}`;
    case "breaker-open": return `HOST_SUPERVISOR_BREAKER_OPEN ${event.failures} failures; next try in ${event.retryInMs} ms`;
    case "stopped": return `HOST_SUPERVISOR_STOPPED start=${event.start}${event.forced ? " (terminated at the stop deadline)" : ""}`;
  }
};

export const startHost = (options: HostOptions): Host => {
  const log = options.log ?? ((line: string) => { console.log(line); });
  const supervisor = options.supervisor === "off"
    ? undefined
    : new SupervisorHost(workerSpawner(options.supervisor), options.tunables ? { tunables: options.tunables } : {});
  supervisor?.on((event) => { log(eventLine(event)); });
  const status = (): HostStatus => ({ supervisor: supervisor?.snapshot() ?? { state: "off" } });
  const server = Bun.serve({
    hostname: options.listen.hostname,
    port: options.listen.port,
    ...SERVE_OPTIONS,
    fetch: (request, server) => new URL(request.url).pathname === "/api/host" ? Response.json(status()) : options.core(request, server),
  });
  if (supervisor) supervisor.start();
  else log("HOST_SAFE_MODE TOODO_SUPERVISOR=off: the supervisor Worker is not started");
  const url = new URL(`http://${server.hostname?.includes(":") ? `[${server.hostname}]` : server.hostname}:${server.port}`);
  log(`HOST_LISTENING ${url.href} pid=${process.pid}`);
  return {
    url,
    status,
    supervisor,
    reloadSupervisor: async () => {
      if (!supervisor) return;
      log("HOST_SUPERVISOR_RELOAD");
      await supervisor.reload();
    },
    stop: async () => {
      await supervisor?.stop();
      await stopServing(server, "toodo");
    },
  };
};

export const parseSupervisorSwitch = (value: string | undefined): "on" | "off" => {
  if (value === undefined || value === "" || value === "on") return "on";
  if (value === "off") return "off";
  throw new Error(`TOODO_SUPERVISOR must be on or off, got ${JSON.stringify(value)}`);
};

if (import.meta.main) {
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // The core reads the same TOODO_* environment as toodo-server (server/src/http/config.ts).
  let config: Config;
  let mode: "on" | "off";
  try {
    config = configFromEnv((name) => process.env[name]);
    mode = parseSupervisorSwitch(process.env.TOODO_SUPERVISOR);
  } catch (e) {
    console.error(`toodo: ${message(e)}`);
    process.exit(2);
  }
  let core: Core;
  try {
    core = await openCore(config);
  } catch (e) {
    console.error(`toodo: ${message(e)}`);
    process.exit(1);
  }
  const host = startHost({ listen: config.listen, core: core.fetch, supervisor: mode === "off" ? "off" : SUPERVISOR_ENTRY });
  core.listening(Number(host.url.port));
  process.on("SIGHUP", () => { void host.reloadSupervisor(); });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log("HOST_STOPPING");
    void host.stop().then(() => core.close()).then(() => {
      console.log("HOST_STOPPED");
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
