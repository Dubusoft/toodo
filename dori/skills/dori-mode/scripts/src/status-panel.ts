// The Toodo app's status panel: the supervisor pushes a snapshot to
// the core over loopback (`PUT <url>/mcp/supervisor-status` with the server's mcp-token, the url and token file of
// tunables.toodoWriter). The core keeps the latest one and streams it to the open panels.
//
// The snapshot holds the status pages and the quota text made by the same functions as `dori status` and `dori quota`.
// Lane screens and the quota read (which may call the usage
// endpoints once the shared cache is older than quotaCacheSec) are taken only while a panel is open: the core answers
// every push with how many panels follow it, and between pushes the pass asks it (`GET`), so a panel that opens gets
// a full snapshot within one pass.
import type { SupervisorLane, SupervisorMachine, SupervisorStatusSnapshot, SupervisorStatusWatchers } from "../../../../../src/lib/supervisor-status.ts";
import { quotaReportText, type UsageLookup } from "./claude-quota.ts";
import type { RunnerView, Status } from "./status.ts";
import { statusPages } from "./status.ts";
import { readToken, TOODO_TIMEOUT_MS, type ToodoClientConfig, type ToodoFetch } from "./toodo-client.ts";

/** How often the status panel task runs; each pass decides whether a push is due. */
export const STATUS_PANEL_PASS_MS = 5_000;
/** A push this often while a panel is open. */
export const STATUS_PANEL_WATCHED_MS = 10_000;
/** A push this often while none is, so a panel that opens shows a recent status at once. */
export const STATUS_PANEL_IDLE_MS = 30_000;
/** The lines of a lane's terminal the panel shows. */
export const STATUS_PANEL_SCREEN_LINES = 40;
const QUOTA_TIMEOUT_MS = 30_000;

export type StatusPanelDeps = {
  readonly endpoint: ToodoClientConfig;
  readonly now: () => number;
  readonly timeZone?: string;
  /** What the status pages read (status.ts collectStatus, with the live lead pane). */
  readonly status: () => Promise<Status>;
  /** The shared quota read of `dori quota` (quota-cache.ts sharedQuotaLookup). */
  readonly quota: UsageLookup;
  /** The last STATUS_PANEL_SCREEN_LINES lines of a working lane's terminal. */
  readonly screen: (key: string) => Promise<string>;
  readonly fetch?: ToodoFetch;
  readonly log?: (line: string) => void;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A runner as the panel shows it: its state, version and last machine sample. */
const panelMachine = (runner: RunnerView): SupervisorMachine => {
  const m = runner.machine;
  const known = (n: number | undefined): n is number => n !== undefined && n >= 0;
  return {
    label: runner.label,
    state: runner.state,
    version: runner.version ?? null,
    sample: !m ? null : {
      level: m.level,
      ...(m.os ? { os: m.os } : {}),
      ...(known(m.load1) ? { load1: m.load1 } : {}),
      ...(known(m.memFreePct) ? { memFreePct: m.memFreePct } : {}),
      ...(known(m.diskFreeGb) ? { diskFreeGb: m.diskFreeGb } : {}),
      ageSec: m.ageSec,
    },
  };
};

/**
 * The snapshot of now: the status pages, every open lane with its status, and the runner machines always; the quota
 * and the working lanes' screens only when `watched`.
 */
export const collectPanel = async (deps: StatusPanelDeps, watched: boolean): Promise<SupervisorStatusSnapshot> => {
  const status = await deps.status();
  const at = Date.parse(status.at);
  const quota = !watched ? null : await deps.quota(AbortSignal.timeout(QUOTA_TIMEOUT_MS)).then(
    (read) => ({ text: quotaReportText(read, at, deps.timeZone), fetchedAt: read.cache?.fetchedAt ?? null }),
    (e: unknown) => ({ error: message(e) }),
  );
  const open = [...status.lanes.map((lane) => ({ ...lane, status: "working" as const })), ...(status.otherLanes ?? [])];
  const lanes = await Promise.all(open.map(async (lane): Promise<SupervisorLane> => ({
    key: lane.key,
    status: lane.status,
    task: lane.task ?? null,
    machine: lane.machine ?? "local",
    model: lane.model ?? null,
    ageMin: lane.ageMin,
    progress: lane.progress ?? null,
    // A repo guessed from a worktree directory is no owner/name, so it makes no link.
    ...(lane.repo?.includes("/") && lane.pr !== undefined ? { prUrl: `https://github.com/${lane.repo}/pull/${lane.pr}` } : {}),
    screen: !watched || lane.status !== "working" ? null : await deps.screen(lane.key).then((text) => ({ text }), (e: unknown) => ({ error: message(e) })),
  })));
  return { at, status: statusPages(status), quota, lanes, machines: (status.runners ?? []).map(panelMachine) };
};

/** One status panel pass for the supervisor's task loop (supervise-loop.ts). */
export const statusPanelPass = (deps: StatusPanelDeps): (() => Promise<void>) => {
  const fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const url = `${deps.endpoint.url.replace(/\/+$/, "")}/mcp/supervisor-status`;
  const log = deps.log ?? ((line: string) => { console.error(line); });
  let watchers = 0;
  let lastPush = Number.NEGATIVE_INFINITY;
  let failure: string | undefined;

  const call = async (token: string, method: "GET" | "PUT", body?: string): Promise<number> => {
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(TOODO_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${text.trim().slice(0, 200)}`);
    const reply = JSON.parse(text) as Partial<SupervisorStatusWatchers>;
    if (typeof reply.watchers !== "number") throw new Error("the answer names no watchers");
    return reply.watchers;
  };

  return async () => {
    const now = deps.now();
    try {
      const token = readToken(deps.endpoint.tokenFile, (text) => new Error(text));
      if (watchers === 0 && now - lastPush < STATUS_PANEL_IDLE_MS) watchers = await call(token, "GET");
      const every = watchers > 0 ? STATUS_PANEL_WATCHED_MS : STATUS_PANEL_IDLE_MS;
      if (now - lastPush < every) return;
      // Counted as pushed before it is sent: a core that is down is tried again on the same schedule, not every pass.
      lastPush = now;
      watchers = await call(token, "PUT", JSON.stringify(await collectPanel(deps, watchers > 0)));
      if (failure !== undefined) log(`STATUS_PANEL_RECOVERED ${url}`);
      failure = undefined;
    } catch (e) {
      // Logged once per kind of failure: a core without the panel or a missing token file would log every pass.
      const text = message(e);
      if (text !== failure) log(`STATUS_PANEL_PUSH_FAILED ${url}: ${text}`);
      failure = text;
      watchers = 0;
    }
  };
};
