// The Dori status panel on the core: the supervisor Worker pushes its latest snapshot over
// loopback with the MCP token (`PUT /mcp/supervisor-status`), the core keeps that one
// snapshot in memory, and web app panels follow it over their own event stream
// (`GET /api/supervisor/status`). Nothing is stored in the database, and the snapshots stay
// out of `/api/events`, whose replay they would crowd out.

import {
  SUPERVISOR_STATUS_EVENT,
  type SupervisorStatusSnapshot,
  type SupervisorStatusWatchers,
} from "../../../src/lib/supervisor-status.ts";
import { json, text } from "./auth.ts";
import { EventLog } from "./event-log.ts";

/** The largest snapshot a push may carry, in bytes: lane screens are the bulk of it. */
export const SNAPSHOT_LIMIT = 2 * 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isNullableText = (value: unknown): boolean => value === null || isText(value);

const isQuota = (value: unknown): boolean =>
  value === null ||
  (isObject(value) &&
    (isText(value.error) ||
      (isText(value.text) && (value.fetchedAt === null || Number.isFinite(value.fetchedAt)))));

const isScreen = (value: unknown): boolean => value === null || (isObject(value) && (isText(value.text) || isText(value.error)));

const isLane = (value: unknown): boolean =>
  isObject(value) &&
  isText(value.key) &&
  (value.task === null || Number.isSafeInteger(value.task)) &&
  isText(value.machine) &&
  isNullableText(value.model) &&
  Number.isFinite(value.ageMin) &&
  isNullableText(value.progress) &&
  isScreen(value.screen);

/** Whether a pushed body is a snapshot the panel can show. */
export function isSnapshot(value: unknown): value is SupervisorStatusSnapshot {
  return (
    isObject(value) &&
    Number.isFinite(value.at) &&
    Array.isArray(value.status) &&
    value.status.every(isText) &&
    isQuota(value.quota) &&
    Array.isArray(value.lanes) &&
    value.lanes.every(isLane)
  );
}

/** The latest snapshot and the panels that follow it. */
export class SupervisorStatusFeed {
  // One kept event: a stream opens with the latest snapshot, then gets each new one.
  readonly #log = new EventLog(undefined, 1);

  /** How many panels are open now. */
  get watchers(): number {
    return this.#log.streams;
  }

  /** `PUT /mcp/supervisor-status`: keeps the snapshot and sends it to every open panel. */
  async push(request: Request): Promise<Response> {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > SNAPSHOT_LIMIT) {
      return text(413, `the snapshot is larger than ${SNAPSHOT_LIMIT} bytes`);
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(body);
    } catch {
      return text(400, "the snapshot is not JSON");
    }
    if (!isSnapshot(snapshot)) return text(400, "the snapshot is not a supervisor status snapshot");
    this.#log.send(SUPERVISOR_STATUS_EVENT, body);
    return this.count();
  }

  /** `GET /mcp/supervisor-status`: how many panels are open, so the supervisor reads screens
   * and quota only for someone. */
  count(): Response {
    return json(200, { watchers: this.watchers } satisfies SupervisorStatusWatchers);
  }

  /** `GET /api/supervisor/status`: the latest snapshot, then each new one; `ready` first when
   * none came yet. */
  stream(): Response {
    const last = this.#log.last;
    const stream = this.#log.stream(last === 0 ? null : this.#log.id(last - 1));
    return new Response(stream.body(), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
}
