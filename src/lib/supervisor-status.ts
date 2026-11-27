// The Dori status panel's snapshot: what the supervisor Worker pushes to the core over
// loopback (`PUT /mcp/supervisor-status` with the MCP token), and what the core streams to
// the web app (`GET /api/supervisor/status`). The core keeps only the latest one, in memory.
// Types only: the server, the web app, and the supervisor in `dori/` all import this file.

/** One working lane as the panel shows it. */
export type SupervisorLane = {
  readonly key: string;
  /** The Toodo task the lane works on, when it named one. */
  readonly task: number | null;
  /** The runner the lane runs on (`local` for this host). */
  readonly machine: string;
  readonly model: string | null;
  /** Minutes since the lane opened. */
  readonly ageMin: number;
  /** The lane's last progress line. */
  readonly progress: string | null;
  /**
   * The last lines of the lane's terminal, read when the snapshot was taken; `null` when
   * nobody was watching the panel then, an error when the screen could not be read.
   */
  readonly screen: { readonly text: string } | { readonly error: string } | null;
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
};

/** The core's answer to a push, and to `GET /mcp/supervisor-status`: how many panels are open. */
export type SupervisorStatusWatchers = { readonly watchers: number };

/** The event a panel stream sends with each snapshot. A stream opened before the first push
 * starts with `ready` and gets its first `status` with that push. */
export const SUPERVISOR_STATUS_EVENT = "status";
