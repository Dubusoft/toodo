// Messages between the host (main thread) and the supervisor Worker. Both sides import this file, so it holds types
// and constants only: the Worker entry lives in dori/ and must not pull host code onto its thread.

/** How often the Worker reports that its event loop still runs. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Host to Worker: shut down and post `stopped` once done. */
export type HostToWorker = { readonly type: "stop" };

export type WorkerToHost =
  | { readonly type: "ready" }
  | { readonly type: "heartbeat" }
  | { readonly type: "stopped" };
