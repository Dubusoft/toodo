// The scheduled jobs panel on the core: `GET /api/supervisor/schedules` lists the Dori
// supervisor's scheduled jobs and `POST` applies one change to them. The core keeps none of
// it: the host (host/src/main.ts) hands each request to the supervisor Worker, which owns the
// jobs. A server without the supervisor (`toodo-server`, or the host in safe mode) answers 503.

import {
  SCHEDULE_OPS,
  type NewScheduledJob,
  type ScheduleReply,
  type ScheduleRequest,
  type ScheduleTiming,
} from "../../../src/lib/supervisor-schedules.ts";
import { json } from "./auth.ts";

/** Hands a request to the supervisor and resolves with its answer; rejects when it cannot. */
export type ScheduleBridge = (request: ScheduleRequest) => Promise<ScheduleReply>;

/** The largest request body, in bytes: a job's fields are short. */
export const REQUEST_LIMIT = 16 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalText = (value: unknown): boolean => value === undefined || typeof value === "string";

function timing(value: Record<string, unknown>): ScheduleTiming | null {
  if (typeof value.cron === "string" && value.everySec === undefined) return { cron: value.cron };
  if (typeof value.everySec === "number" && value.cron === undefined) return { everySec: value.everySec };
  return null;
}

function newJob(value: unknown): NewScheduledJob | null {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.kind !== "string") return null;
  const when = timing(value);
  if (when === null) return null;
  const { description, tz, text, command, cwd, catchUp } = value;
  if (![description, tz, text, command, cwd].every(optionalText)) return null;
  if (catchUp !== undefined && catchUp !== "once" && catchUp !== "skip") return null;
  return {
    ...when,
    name: value.name,
    kind: value.kind,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof tz === "string" ? { tz } : {}),
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof command === "string" ? { command } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(catchUp !== undefined ? { catchUp } : {}),
  };
}

/** A request body in the shape the supervisor takes, or `null`. What the fields mean (a
 * valid cron, a known kind) is the supervisor's to check: it answers why it refused. */
export function parseScheduleRequest(value: unknown): ScheduleRequest | null {
  if (!isObject(value) || !(SCHEDULE_OPS as readonly unknown[]).includes(value.op)) return null;
  const op = value.op as ScheduleRequest["op"];
  if (op === "list") return { op };
  if (op === "add") {
    const job = newJob(value.job);
    return job === null ? null : { op, job };
  }
  if (typeof value.name !== "string") return null;
  if (op !== "edit") return { op, name: value.name };
  const { description, tz } = value;
  if (!optionalText(description) || !optionalText(tz)) return null;
  if (value.timing === undefined) {
    return typeof description === "string" && tz === undefined ? { op, name: value.name, description } : null;
  }
  const when = isObject(value.timing) ? timing(value.timing) : null;
  if (when === null) return null;
  return {
    op,
    name: value.name,
    timing: when,
    ...(typeof tz === "string" ? { tz } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}

async function relay(bridge: ScheduleBridge | null, request: ScheduleRequest): Promise<Response> {
  if (bridge === null) {
    return json(503, { ok: false, error: "the Dori supervisor does not run in this server" } satisfies ScheduleReply);
  }
  let reply: ScheduleReply;
  try {
    reply = await bridge(request);
  } catch (error) {
    return json(503, { ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ScheduleReply);
  }
  return json(reply.ok ? 200 : 400, reply);
}

/** `GET /api/supervisor/schedules`: every job with its next and last run. */
export function list(bridge: ScheduleBridge | null): Promise<Response> {
  return relay(bridge, { op: "list" });
}

/** `POST /api/supervisor/schedules`: one change, answered with every job after it. */
export async function change(bridge: ScheduleBridge | null, request: Request): Promise<Response> {
  const body = await request.text();
  if (new TextEncoder().encode(body).length > REQUEST_LIMIT) {
    return json(413, { ok: false, error: `the request is larger than ${REQUEST_LIMIT} bytes` } satisfies ScheduleReply);
  }
  let parsed: ScheduleRequest | null;
  try {
    parsed = parseScheduleRequest(JSON.parse(body));
  } catch {
    parsed = null;
  }
  if (parsed === null) return json(400, { ok: false, error: "the request is not a scheduled-jobs request" } satisfies ScheduleReply);
  return relay(bridge, parsed);
}
