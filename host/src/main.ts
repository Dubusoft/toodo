// The Toodo host: the core serves HTTP on the main thread and the Dori supervisor runs in a Worker, in one process.
// Code on this thread must not block it, so it makes no *Sync calls (host/src/sync-check.test.ts checks).
import { type SupervisorEvent, SupervisorHost, type SupervisorSnapshot, type SupervisorTunables, workerSpawner } from "./supervisor.ts";

export const DEFAULT_LISTEN = "127.0.0.1:47616";

export const SUPERVISOR_ENTRY = new URL("../../dori/skills/dori-mode/scripts/src/supervise-worker.ts", import.meta.url);

export type CoreFetch = (request: Request) => Response | Promise<Response>;

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
    fetch: (request) => new URL(request.url).pathname === "/api/host" ? Response.json(status()) : options.core(request),
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
      await server.stop(true);
    },
  };
};

/** `TOODO_LISTEN` as the Rust server reads it: `HOST:PORT`, an IPv6 host in brackets. */
export const parseListen = (value: string): { hostname: string; port: number } => {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  const port = Number(match?.[3]);
  if (!match || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`TOODO_LISTEN must be HOST:PORT, got ${JSON.stringify(value)}`);
  }
  return { hostname: match[1] ?? match[2] ?? "", port };
};

export const parseSupervisorSwitch = (value: string | undefined): "on" | "off" => {
  if (value === undefined || value === "" || value === "on") return "on";
  if (value === "off") return "off";
  throw new Error(`TOODO_SUPERVISOR must be on or off, got ${JSON.stringify(value)}`);
};

// The core's routes come with the HTTP surface; until then the host answers only `/api/host`.
const notFound: CoreFetch = () => new Response("Not Found", { status: 404 });

if (import.meta.main) {
  let listen: { hostname: string; port: number };
  let mode: "on" | "off";
  try {
    listen = parseListen(process.env.TOODO_LISTEN ?? DEFAULT_LISTEN);
    mode = parseSupervisorSwitch(process.env.TOODO_SUPERVISOR);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const host = startHost({ listen, core: notFound, supervisor: mode === "off" ? "off" : SUPERVISOR_ENTRY });
  process.on("SIGHUP", () => { void host.reloadSupervisor(); });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log("HOST_STOPPING");
    void host.stop().then(() => {
      console.log("HOST_STOPPED");
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
