import { Fragment, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { STALE_AFTER_MS, useNow } from "@/components/supervisor-status-panel";
import { toneBadges } from "@/components/task-common";
import type { Task, TaskId, Workspace, WorkspaceId } from "@/lib/bindings";
import { useMessages } from "@/lib/i18n";
import { useTasks } from "@/lib/queries";
import { toneText, type Tone } from "@/lib/status-styles";
import type {
  SupervisorLane,
  SupervisorLaneStatus,
  SupervisorMachine,
  SupervisorStatusSnapshot,
} from "@/lib/supervisor-status";
import { cn } from "@/lib/utils";
import { useSupervisorStatus } from "@/web/supervisor-status";

/** Dori's name for the runner on the host it runs on, which is the Toodo server's host. */
const SERVER_RUNNER = "local";

/**
 * Whether a page at `hostname` was opened on the server's own host: only a loopback address
 * says so for sure, since a proxy or tunnel in front of the server makes every peer look local.
 */
export function onServerHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

const laneTones: Record<SupervisorLaneStatus, Tone> = {
  working: "info",
  paused: "attention",
  "done-claimed": "review",
  "verified-done": "success",
  "not-done": "danger",
  closed: "neutral",
};

const machineTones: Record<SupervisorMachine["state"], Tone> = {
  connected: "success",
  stale: "attention",
  offline: "danger",
  lost: "danger",
  revoked: "danger",
};

/** One machine with its lanes, grouped by the workspace of each lane's task. */
export type MachineNode = {
  readonly label: string;
  /** `null` for a machine only a lane names, which Dori has no runner for, and for the server before Dori reports. */
  readonly machine: SupervisorMachine | null;
  /** The server's node also holds every workspace no lane works in, with no lanes. */
  readonly workspaces: readonly { readonly workspace: Workspace; readonly lanes: readonly SupervisorLane[] }[];
  /** Lanes with no task, or whose task is in no workspace listed. */
  readonly loose: readonly SupervisorLane[];
};

/**
 * The snapshot's machines in Dori's order (the server first), then any other machine a lane runs
 * on; under each, its lanes by workspace in the workspace list's order, and the lanes of no
 * workspace. The server is always there, so a workspace no lane works in, or every workspace
 * when Dori never reported (`snapshot` `null`), sits under it.
 */
export function machineTree(
  snapshot: SupervisorStatusSnapshot | null,
  tasks: ReadonlyMap<TaskId, Task>,
  workspaces: readonly Workspace[],
): MachineNode[] {
  const machines = snapshot?.machines ?? [];
  const allLanes = snapshot?.lanes ?? [];
  const labels = machines.map((machine) => machine.label);
  for (const lane of allLanes) if (!labels.includes(lane.machine)) labels.push(lane.machine);
  if (!labels.includes(SERVER_RUNNER)) labels.unshift(SERVER_RUNNER);
  const workspaceOf = (lane: SupervisorLane): WorkspaceId | undefined => {
    const task = lane.task === null ? undefined : tasks.get(lane.task as TaskId);
    return workspaces.find((workspace) => workspace.id === task?.workspaceId)?.id;
  };
  const worked = new Set(allLanes.map(workspaceOf));
  return labels.map((label) => {
    const lanes = allLanes.filter((lane) => lane.machine === label);
    return {
      label,
      machine: machines.find((machine) => machine.label === label) ?? null,
      workspaces: workspaces
        .map((workspace) => ({ workspace, lanes: lanes.filter((lane) => workspaceOf(lane) === workspace.id) }))
        .filter((group) => group.lanes.length > 0 || (label === SERVER_RUNNER && !worked.has(group.workspace.id))),
      loose: lanes.filter((lane) => workspaceOf(lane) === undefined),
    };
  });
}

function MachineFacts({ machine }: { machine: SupervisorMachine | null }) {
  const t = useMessages().app.machines;
  const sample = machine?.sample;
  const facts = !sample
    ? [t.noSample]
    : [
        sample.os,
        sample.load1 === undefined ? undefined : t.load(sample.load1.toFixed(1)),
        sample.memFreePct === undefined ? undefined : t.memoryFree(sample.memFreePct),
        sample.diskFreeGb === undefined ? undefined : t.diskFree(sample.diskFreeGb.toFixed(0)),
      ].filter((fact) => fact !== undefined);
  return <p className="px-2.5 text-xs text-muted-foreground">{facts.join(" · ")}</p>;
}

function LaneItem({ lane, onShowTask }: { lane: SupervisorLane; onShowTask: (id: TaskId) => void }) {
  const t = useMessages().app.machines;
  const status = lane.status ?? "working";
  // A lane is named by its task; the lane key, also in the tooltip, names one without a task.
  const title = lane.progress === null ? lane.key : `${lane.key}: ${lane.progress}`;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{lane.task === null ? lane.key : `#${lane.task}`}</span>
      <Badge
        data-lane-status={status}
        variant={toneBadges[laneTones[status]]}
        label={t.laneStatus[status]}
        className="shrink-0"
      />
    </>
  );
  const row = "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs";
  return (
    <li data-lane={lane.key}>
      {lane.task === null ? (
        <div className={row} title={title}>
          {content}
        </div>
      ) : (
        <button
          type="button"
          aria-label={t.showTask(lane.key, lane.task)}
          title={title}
          className={cn(row, "hover:bg-sidebar-accent")}
          onClick={() => onShowTask(lane.task as TaskId)}
        >
          {content}
        </button>
      )}
    </li>
  );
}

function LaneList({ name, lanes, onShowTask }: { name: string; lanes: readonly SupervisorLane[]; onShowTask: (id: TaskId) => void }) {
  const t = useMessages().app.machines;
  return (
    <ul aria-label={t.lanesOf(name)} className="ml-3 flex flex-col gap-0.5 border-l pl-1">
      {lanes.map((lane) => (
        <LaneItem key={lane.key} lane={lane} onShowTask={onShowTask} />
      ))}
    </ul>
  );
}

/**
 * The navigation's workspaces by machine: the server and each runner Dori knows with its state
 * and last reading, and under each the workspaces its lanes work in, each lane with a chip of its
 * live status; lanes of no workspace come last. Workspaces no lane works in sit under the server,
 * which is named Local when this page was opened on its host and Server otherwise. It follows
 * the Dori status without counting as a status panel, so it makes Dori read no lane screens or
 * quota; on a server Dori never reported to, it is the server with every workspace.
 */
export function MachineTree({
  workspaces,
  renderWorkspace,
  onShowTask,
}: {
  workspaces: readonly Workspace[];
  /** A workspace's item, with the list of its lanes on that machine (`null` for none) inside it. */
  renderWorkspace: (workspace: Workspace, lanes: ReactNode) => ReactNode;
  onShowTask: (id: TaskId) => void;
}) {
  const t = useMessages().app.machines;
  const { snapshot } = useSupervisorStatus(true, { watch: false });
  const tasks = useTasks(snapshot?.lanes.map((lane) => lane.task as TaskId | null) ?? []);
  const now = useNow();
  if (snapshot === null && workspaces.length === 0) return null;
  const byId = new Map((tasks.data ?? []).map((task) => [task.id, task]));
  const tree = machineTree(snapshot, byId, workspaces);
  const serverName = onServerHost(location.hostname) ? t.local : t.server;

  return (
    <>
      {snapshot !== null && now - snapshot.at > STALE_AFTER_MS && (
        <p role="status" className="px-2.5 text-xs text-destructive">
          {t.stale}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {tree.map((node) => {
          const name = node.label === SERVER_RUNNER ? serverName : node.label;
          const tone = node.machine ? machineTones[node.machine.state] : "neutral";
          return (
            <li key={node.label} aria-label={t.machine(name)} data-machine={node.label} className="flex flex-col gap-1">
              <div className="flex min-w-0 items-center gap-1.5 px-2.5">
                <span className="min-w-0 truncate text-sm font-medium">{name}</span>
                {node.machine && (
                  <span className={cn("ml-auto shrink-0 text-xs", toneText[tone])}>{t.states[node.machine.state]}</span>
                )}
              </div>
              {snapshot !== null && <MachineFacts machine={node.machine} />}
              {node.workspaces.length === 0 && node.loose.length === 0 ? (
                <p className="px-2.5 text-xs text-muted-foreground">{t.noLanes}</p>
              ) : (
                <ul className="ml-2.5 flex flex-col gap-1 border-l pl-1">
                  {node.workspaces.map(({ workspace, lanes }) => (
                    <Fragment key={workspace.id}>
                      {renderWorkspace(
                        workspace,
                        lanes.length > 0 ? <LaneList name={workspace.name} lanes={lanes} onShowTask={onShowTask} /> : null,
                      )}
                    </Fragment>
                  ))}
                  {node.loose.length > 0 && (
                    <li className="flex flex-col">
                      <span className="block w-full truncate px-2 py-1 text-sm text-muted-foreground">{t.noWorkspace}</span>
                      <LaneList name={t.noWorkspace} lanes={node.loose} onShowTask={onShowTask} />
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
