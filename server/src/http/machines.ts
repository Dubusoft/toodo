// Settings > Machines & accounts on the core (src/lib/machines.ts): `GET /api/machines` lists
// the machines and the latest jobs, `GET /api/machines/<label>/config` reads a runner's
// runner-config.json, and `POST /api/machines` makes one change or starts a job. The core runs
// no command for any of them: the host hands each request to the supervisor Worker, which runs
// it and sends each job's state back while it runs; the core keeps the latest of those in memory
// and streams them (`GET /api/machines/jobs`). A server without the supervisor answers 503. A
// read-only device is refused the POST by the device gate (auth.ts `readOnlyAllows`).

import {
  MACHINE_JOB_EVENT,
  MACHINE_OPS,
  MACHINE_TOOLS,
  type MachineJob,
  type MachineReply,
  type MachineRequest,
  type MachineTool,
} from "../../../src/lib/machines.ts";
import { json } from "./auth.ts";
import { EventLog } from "./event-log.ts";

/** Hands a request to the supervisor and resolves with its answer; rejects when it cannot. */
export type MachineBridge = (request: MachineRequest) => Promise<MachineReply>;

/** The largest request body, in bytes: a runner-config value is short. */
export const REQUEST_LIMIT = 16 * 1024;

/** The job updates a new stream replays, so it catches up on the jobs that ran last. */
const KEPT_UPDATES = 64;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

/** A request body in the shape the supervisor takes, or `null`. Which keys may change and
 * which machines exist is the supervisor's to check: it answers why it refused. */
export function parseMachineRequest(value: unknown): MachineRequest | null {
  if (!isObject(value) || !(MACHINE_OPS as readonly unknown[]).includes(value.op)) return null;
  const op = value.op as MachineRequest["op"];
  switch (op) {
    case "list":
      return { op };
    case "config":
      return isName(value.machine) ? { op, machine: value.machine } : null;
    case "config-set":
      return isName(value.machine) && isName(value.key) && typeof value.value === "string"
        ? { op, machine: value.machine, key: value.key, value: value.value }
        : null;
    case "install":
      return (MACHINE_TOOLS as readonly unknown[]).includes(value.tool) ? { op, tool: value.tool as MachineTool } : null;
    case "login":
      return value.replace === undefined || typeof value.replace === "boolean" ? { op, replace: value.replace === true } : null;
    case "cancel":
      return isName(value.job) ? { op, job: value.job } : null;
  }
}

async function relay(bridge: MachineBridge | null, request: MachineRequest): Promise<Response> {
  if (bridge === null) {
    return json(503, { ok: false, error: "the Dori supervisor does not run in this server" } satisfies MachineReply);
  }
  let reply: MachineReply;
  try {
    reply = await bridge(request);
  } catch (error) {
    return json(503, { ok: false, error: error instanceof Error ? error.message : String(error) } satisfies MachineReply);
  }
  return json(reply.ok ? 200 : 400, reply);
}

/** `GET /api/machines`: every machine with its tools, and the latest jobs. */
export function list(bridge: MachineBridge | null): Promise<Response> {
  return relay(bridge, { op: "list" });
}

/** `GET /api/machines/<label>/config`: that runner's runner-config.json. */
export function config(bridge: MachineBridge | null, machine: string): Promise<Response> {
  return relay(bridge, { op: "config", machine });
}

/** `POST /api/machines`: one change or one job, answered with the config after it or the job. */
export async function change(bridge: MachineBridge | null, request: Request): Promise<Response> {
  const body = await request.text();
  if (new TextEncoder().encode(body).length > REQUEST_LIMIT) {
    return json(413, { ok: false, error: `the request is larger than ${REQUEST_LIMIT} bytes` } satisfies MachineReply);
  }
  let parsed: MachineRequest | null;
  try {
    parsed = parseMachineRequest(JSON.parse(body));
  } catch {
    parsed = null;
  }
  if (parsed === null) return json(400, { ok: false, error: "the request is not a machines request" } satisfies MachineReply);
  return relay(bridge, parsed);
}

/** The jobs' latest states as the supervisor sends them, and the streams that follow them. */
export class MachineJobFeed {
  readonly #log = new EventLog(undefined, KEPT_UPDATES);

  push(job: MachineJob): void {
    this.#log.send(MACHINE_JOB_EVENT, JSON.stringify(job));
  }

  /** `GET /api/machines/jobs`: the kept updates, then each new one. */
  stream(): Response {
    const last = this.#log.last;
    const oldest = Math.max(1, last - KEPT_UPDATES + 1);
    const stream = this.#log.stream(last === 0 ? null : this.#log.id(oldest - 1));
    return new Response(stream.body(), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
}
