// Messages between the host (main thread) and the supervisor Worker. Both sides import this file, so it holds types
// and constants only: the Worker entry lives in dori/ and must not pull host code onto its thread.
import type { ScheduleReply, ScheduleRequest } from "../../src/lib/supervisor-schedules.ts";

/** How often the Worker reports that its event loop still runs. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Host to Worker: shut down and post `stopped` once done; or apply a scheduled-jobs request and answer with its `id`. */
export type HostToWorker =
  | { readonly type: "stop" }
  | { readonly type: "schedules"; readonly id: number; readonly request: ScheduleRequest };

export type WorkerToHost =
  | { readonly type: "ready" }
  | { readonly type: "heartbeat" }
  | { readonly type: "stopped" }
  | { readonly type: "schedules"; readonly id: number; readonly reply: ScheduleReply };
