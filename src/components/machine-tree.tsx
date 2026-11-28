import { Badge } from "@astryxdesign/core/Badge";
import { STALE_AFTER_MS, useNow } from "@/components/supervisor-status-panel";
import { toneBadges } from "@/components/task-common";
import type { Task, TaskId, Workspace, WorkspaceId } from "@/lib/bindings";
import { useMessages } from "@/lib/i18n";
import { useTasks, useWorkspaces } from "@/lib/queries";
import { toneText, type Tone } from "@/lib/status-styles";
import type {
  SupervisorLane,
  SupervisorLaneStatus,
  SupervisorMachine,
  SupervisorStatusSnapshot,
} from "@/lib/supervisor-status";
import { cn } from "@/lib/utils";
import { useSupervisorStatus } from "@/web/supervisor-status";

const LOCAL_RUNNER = "local";

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
  /** `null` for a machine only a lane names, which Dori has no runner for. */
  readonly machine: SupervisorMachine | null;
  readonly workspaces: readonly { readonly workspace: Workspace; readonly lanes: readonly SupervisorLane[] }[];
  /** Lanes with no task, or whose task is in no workspace listed. */
  readonly loose: readonly SupervisorLane[];
};

/**
 * The snapshot's machines in Dori's order (local first), then any other machine a lane runs on;
 * under each, its lanes by workspace in the workspace list's order, and the lanes of no workspace.
 */
export function machineTree(
  snapshot: SupervisorStatusSnapshot,
  tasks: ReadonlyMap<TaskId, Task>,
  workspaces: readonly Workspace[],
): MachineNode[] {
  const machines = snapshot.machines ?? [];
  const labels = machines.map((machine) => machine.label);
  for (const lane of snapshot.lanes) if (!labels.includes(lane.machine)) labels.push(lane.machine);
  const workspaceOf = (lane: SupervisorLane): WorkspaceId | undefined => {
    const task = lane.task === null ? undefined : tasks.get(lane.task as TaskId);
    return workspaces.find((workspace) => workspace.id === task?.workspaceId)?.id;
  };
  return labels.map((label) => {
    const lanes = snapshot.lanes.filter((lane) => lane.machine === label);
    return {
      label,
      machine: machines.find((machine) => machine.label === label) ?? null,
      workspaces: workspaces
        .map((workspace) => ({ workspace, lanes: lanes.filter((lane) => workspaceOf(lane) === workspace.id) }))
        .filter((group) => group.lanes.length > 0),
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
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{lane.key}</span>
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
        <div className={row} title={lane.progress ?? undefined}>
          {content}
        </div>
      ) : (
        <button
          type="button"
          aria-label={t.showTask(lane.key, lane.task)}
          title={lane.progress ?? undefined}
          className={cn(row, "hover:bg-sidebar-accent")}
          onClick={() => onShowTask(lane.task as TaskId)}
        >
          {content}
        </button>
      )}
    </li>
  );
}

function LaneGroup({
  name,
  lanes,
  onOpen,
  onShowTask,
}: {
  name: string;
  lanes: readonly SupervisorLane[];
  onOpen?: () => void;
  onShowTask: (id: TaskId) => void;
}) {
  const t = useMessages().app.machines;
  const heading = "block w-full truncate rounded-md px-2 py-1 text-left text-sm";
  return (
    <li className="flex flex-col">
      {onOpen ? (
        <button type="button" className={cn(heading, "font-medium hover:bg-sidebar-accent")} onClick={onOpen}>
          {name}
        </button>
      ) : (
        <span className={cn(heading, "text-muted-foreground")}>{name}</span>
      )}
      <ul aria-label={t.lanesOf(name)} className="ml-2 flex flex-col gap-0.5 border-l pl-1">
        {lanes.map((lane) => (
          <LaneItem key={lane.key} lane={lane} onShowTask={onShowTask} />
        ))}
      </ul>
    </li>
  );
}

/**
 * The navigation's machines: each runner Dori knows with its state and last reading, and under
 * it the workspaces its lanes work in, each lane with a chip of its live status; lanes of no
 * workspace come last. It follows the Dori status without counting as a status panel, so it
 * makes Dori read no lane screens or quota, and it shows nothing on a server Dori never reported to.
 */
export function MachineTree({
  onSelectWorkspace,
  onShowTask,
}: {
  onSelectWorkspace: (id: WorkspaceId) => void;
  onShowTask: (id: TaskId) => void;
}) {
  const m = useMessages();
  const t = m.app.machines;
  const { snapshot } = useSupervisorStatus(true, { watch: false });
  const workspaces = useWorkspaces();
  const tasks = useTasks(snapshot?.lanes.map((lane) => lane.task as TaskId | null) ?? []);
  const now = useNow();
  if (snapshot === null) return null;
  const byId = new Map((tasks.data ?? []).map((task) => [task.id, task]));
  const tree = machineTree(snapshot, byId, workspaces.data ?? []);

  return (
    <section aria-labelledby="machines-heading" className="flex shrink-0 flex-col gap-2">
      <h2 id="machines-heading" className="px-0 text-xs font-medium uppercase text-muted-foreground">
        {t.title}
      </h2>
      {now - snapshot.at > STALE_AFTER_MS && (
        <p role="status" className="px-2.5 text-xs text-destructive">
          {t.stale}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {tree.map((node) => {
          const tone = node.machine ? machineTones[node.machine.state] : "neutral";
          return (
            <li key={node.label} aria-label={t.machine(node.label)} className="flex flex-col gap-1">
              <div className="flex min-w-0 items-center gap-1.5 px-2.5">
                <span className="min-w-0 truncate text-sm font-medium">{node.label}</span>
                {node.label === LOCAL_RUNNER && <span className="shrink-0 text-xs text-muted-foreground">{t.local}</span>}
                {node.machine && (
                  <span className={cn("ml-auto shrink-0 text-xs", toneText[tone])}>{t.states[node.machine.state]}</span>
                )}
              </div>
              <MachineFacts machine={node.machine} />
              {node.workspaces.length === 0 && node.loose.length === 0 ? (
                <p className="px-2.5 text-xs text-muted-foreground">{t.noLanes}</p>
              ) : (
                <ul className="ml-2.5 flex flex-col gap-1 border-l pl-1">
                  {node.workspaces.map(({ workspace, lanes }) => (
                    <LaneGroup
                      key={workspace.id}
                      name={workspace.name}
                      lanes={lanes}
                      onOpen={() => onSelectWorkspace(workspace.id)}
                      onShowTask={onShowTask}
                    />
                  ))}
                  {node.loose.length > 0 && <LaneGroup name={t.noWorkspace} lanes={node.loose} onShowTask={onShowTask} />}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
