// Messages between the host (main thread) and the supervisor Worker. Both sides import this file, so it holds types
// and constants only: the Worker entry lives in dori/ and must not pull host code onto its thread.
import type { MachineJob, MachineReply, MachineRequest } from "../../src/lib/machines.ts";
import type { ScheduleReply, ScheduleRequest } from "../../src/lib/supervisor-schedules.ts";

/** How often the Worker reports that its event loop still runs. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Host to Worker: shut down and post `stopped` once done; or apply a scheduled-jobs or machines request and answer with
 * its `id`.
 */
export type HostToWorker =
  | { readonly type: "stop" }
  | { readonly type: "schedules"; readonly id: number; readonly request: ScheduleRequest }
  | { readonly type: "machines"; readonly id: number; readonly request: MachineRequest };

/** Worker to host; `machine-job` is unasked: a machines job's latest state, sent while it runs and once it ends. */
export type WorkerToHost =
  | { readonly type: "ready" }
  | { readonly type: "heartbeat" }
  | { readonly type: "stopped" }
  | { readonly type: "schedules"; readonly id: number; readonly reply: ScheduleReply }
  | { readonly type: "machines"; readonly id: number; readonly reply: MachineReply }
  | { readonly type: "machine-job"; readonly job: MachineJob };
