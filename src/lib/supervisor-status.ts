// The Dori status panel's snapshot: what the supervisor Worker pushes to the core over
// loopback (`PUT /mcp/supervisor-status` with the MCP token), and what the core streams to
// the web app (`GET /api/supervisor/status`). The core keeps only the latest one, in memory.
// Types only: the server, the web app, and the supervisor in `dori/` all import this file.

/** Where a lane is in its life, as Dori's lane registry names it. */
export type SupervisorLaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";

/** One open lane as the panel shows it. */
export type SupervisorLane = {
  readonly key: string;
  /** Absent from an older supervisor, which sends working lanes only. */
  readonly status?: SupervisorLaneStatus;
  /** The Toodo task the lane works on, when it named one. */
  readonly task: number | null;
  /** The runner the lane runs on (`local` for this host). */
  readonly machine: string;
  readonly model: string | null;
  /** Minutes since the lane opened. */
  readonly ageMin: number;
  /** The lane's last progress line. */
  readonly progress: string | null;
  /** The lane's chat thread and pull request as `https` links, when it has them; absent from an older supervisor. */
  readonly threadUrl?: string;
  readonly prUrl?: string;
  /**
   * The last lines of the lane's terminal, read when the snapshot was taken; `null` when
   * nobody was watching the panel then, an error when the screen could not be read.
   */
  readonly screen: { readonly text: string } | { readonly error: string } | null;
};

/** One runner machine Dori knows, connected or not, `local` (this host) first. */
export type SupervisorMachine = {
  readonly label: string;
  readonly state: "connected" | "stale" | "offline" | "lost" | "revoked";
  /** The runner's version, when it reported one. */
  readonly version: string | null;
  /** The machine's last guard sample, `null` before the first; a reading the runner could not take is absent. */
  readonly sample: {
    readonly level: "ok" | "alert" | "critical";
    readonly os?: string;
    readonly load1?: number;
    readonly memFreePct?: number;
    readonly diskFreeGb?: number;
    /** Seconds since the sample was taken. */
    readonly ageSec: number;
  } | null;
};

export type SupervisorStatusSnapshot = {
  /** Epoch milliseconds the supervisor collected the snapshot at. */
  readonly at: number;
  /** The pages of `/status`, exactly as the Discord slash command shows them. */
  readonly status: readonly string[];
  /**
   * The `/quota` text read through the shared quota cache, `fetchedAt` being when the usage
   * endpoints were last called; an error when the read failed; `null` when nobody was
   * watching the panel, so no read was made.
   */
  readonly quota: { readonly text: string; readonly fetchedAt: number | null } | { readonly error: string } | null;
  readonly lanes: readonly SupervisorLane[];
  /** Absent from an older supervisor. */
  readonly machines?: readonly SupervisorMachine[];
};

/** The core's answer to a push, and to `GET /mcp/supervisor-status`: how many panels are open. */
export type SupervisorStatusWatchers = { readonly watchers: number };

/** The event a panel stream sends with each snapshot. A stream opened before the first push
 * starts with `ready` and gets its first `status` with that push. */
export const SUPERVISOR_STATUS_EVENT = "status";
