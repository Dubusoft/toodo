import { useId, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { age, STALE_AFTER_MS, useNow } from "@/components/supervisor-status-panel";
import { toneBadges } from "@/components/task-common";
import type { TaskId } from "@/lib/bindings";
import { useMessages } from "@/lib/i18n";
import { toneText, type Tone } from "@/lib/status-styles";
import type { SupervisorLane, SupervisorLaneStatus, SupervisorMachine, SupervisorStatusSnapshot } from "@/lib/supervisor-status";
import { cn } from "@/lib/utils";
import { openUrl } from "@/web/opener";
import { useSupervisorStatus } from "@/web/supervisor-status";

export const laneTones: Record<SupervisorLaneStatus, Tone> = {
  working: "info",
  paused: "attention",
  "done-claimed": "review",
  "verified-done": "success",
  "not-done": "danger",
  closed: "neutral",
};

export const machineTones: Record<SupervisorMachine["state"], Tone> = {
  connected: "success",
  stale: "attention",
  offline: "danger",
  lost: "danger",
  revoked: "danger",
};

/** The status a snapshot gives a lane; one from an older supervisor names working lanes only. */
export const laneStatus = (lane: SupervisorLane): SupervisorLaneStatus => lane.status ?? "working";

export function LaneStatusBadge({ lane, className }: { lane: SupervisorLane; className?: string }) {
  const t = useMessages().app.machines;
  const status = laneStatus(lane);
  return <Badge data-lane-status={status} variant={toneBadges[laneTones[status]]} label={t.laneStatus[status]} className={className} />;
}

/** A lane's task details open on its Lane tab: the task and the lane chosen there. */
export type DetailLane = { readonly task: TaskId; readonly lane: string };

function LaneLink({ label, url }: { label: string; url: string }) {
  const open = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    openUrl(url).catch((error: unknown) => console.error(`Failed to open ${url}`, error));
  };
  return (
    <a href={url} onClick={open} onAuxClick={open} className="text-primary underline underline-offset-2 hover:no-underline">
      {label}
    </a>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words-keep">{children}</dd>
    </div>
  );
}

const screenBox = "max-h-[60dvh] overflow-auto whitespace-pre rounded-md bg-muted px-2 py-1.5 font-mono text-xs leading-snug";

/**
 * One lane as the Dori status snapshot shows it: its live status, machine, model and age, its last
 * progress line, its thread and pull request, and the last lines of its terminal. The supervisor
 * reads screens only while a panel follows the status with `watch`, so whoever shows this view
 * follows it so (see `useSupervisorStatus`).
 */
export function LaneView({
  laneKey,
  snapshot,
  error,
}: {
  laneKey: string;
  snapshot: SupervisorStatusSnapshot | null;
  error: string | null;
}) {
  const m = useMessages();
  const t = m.details.lane;
  const now = useNow();
  if (snapshot === null) {
    return (
      <section role="region" aria-label={t.label(laneKey)} className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">{m.settings.supervisorPanel.waiting}</p>
        {error !== null && (
          <p role="alert" className="break-words-keep text-destructive">
            {error}
          </p>
        )}
      </section>
    );
  }
  const lane = snapshot.lanes.find((candidate) => candidate.key === laneKey);
  if (lane === undefined) {
    return (
      <section role="region" aria-label={t.label(laneKey)} className="flex flex-col gap-2 text-sm">
        <h4 className="font-medium break-all">{laneKey}</h4>
        <p className="text-muted-foreground">{t.gone}</p>
      </section>
    );
  }
  const machine = snapshot.machines?.find((candidate) => candidate.label === lane.machine);
  const stale = now - snapshot.at > STALE_AFTER_MS;
  const panel = m.settings.supervisorPanel;
  const working = laneStatus(lane) === "working";
  return (
    <section role="region" aria-label={t.label(lane.key)} className="flex flex-col gap-4 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="min-w-0 font-medium break-all">{lane.key}</h4>
        <LaneStatusBadge lane={lane} className="shrink-0" />
      </div>
      <dl className="flex flex-col gap-1 text-xs">
        <Fact label={t.machine}>
          {lane.machine}
          {machine && <span className={cn("ml-2", toneText[machineTones[machine.state]])}>{m.app.machines.states[machine.state]}</span>}
        </Fact>
        {lane.model !== null && <Fact label={t.model}>{lane.model}</Fact>}
        <Fact label={t.opened}>{t.ago(age(lane.ageMin * 60_000, panel))}</Fact>
        {lane.progress !== null && <Fact label={t.progress}>{lane.progress}</Fact>}
        {lane.prUrl !== undefined && (
          <Fact label={t.links}>
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <LaneLink label={t.pullRequest} url={lane.prUrl} />
            </span>
          </Fact>
        )}
      </dl>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <h5 className="text-xs font-medium text-muted-foreground">{t.screen}</h5>
          <p role="status" className={cn("text-xs", stale ? "text-destructive" : "text-muted-foreground")}>
            {(stale ? panel.stale : panel.updated)(age(now - snapshot.at, panel))}
            {error !== null && ` ${error}`}
          </p>
        </div>
        {!working ? (
          <p className="text-muted-foreground">{t.noScreen}</p>
        ) : lane.screen === null ? (
          <p className="text-muted-foreground">{panel.readingScreen}</p>
        ) : "error" in lane.screen ? (
          <p role="alert" className="break-words-keep text-destructive">
            {panel.screenFailure(lane.screen.error)}
          </p>
        ) : (
          <pre aria-label={panel.screenOf(lane.key)} className={screenBox}>
            {lane.screen.text}
          </pre>
        )}
      </div>
    </section>
  );
}

/** A lane with no task, shown alone: it follows the status with `watch` while it is open. */
export function LoneLane({ laneKey }: { laneKey: string }) {
  const { snapshot, error } = useSupervisorStatus(true);
  return (
    <li className="p-4">
      <LaneView laneKey={laneKey} snapshot={snapshot} error={error} />
    </li>
  );
}

/**
 * A task's details with a Lane tab for the lane that works on it, when one is open: `lane` is the
 * lane shown, `null` while the Task tab is. The status is followed with `watch` only while the
 * Lane tab is shown, so the supervisor reads the lane's screen just then; the task stays mounted
 * behind the Lane tab, so an edit in progress survives a look at the lane.
 */
export function TaskLaneTabs({
  task,
  lane,
  onLaneChange,
  children,
}: {
  task: TaskId;
  lane: string | null;
  onLaneChange: (lane: string | null) => void;
  children: ReactNode;
}) {
  const t = useMessages().details.lane;
  const id = useId();
  const showingLane = lane !== null;
  const { snapshot, error } = useSupervisorStatus(true, { watch: showingLane });
  const lanes = snapshot?.lanes.filter((candidate) => candidate.task === task) ?? [];
  const key = lane ?? (lanes.find((candidate) => laneStatus(candidate) === "working") ?? lanes[0])?.key;
  if (key === undefined) return children;
  const taskPanel = `${id}-task`;
  const lanePanel = `${id}-lane`;
  return (
    <li className="flex flex-col">
      <div className="px-4 pt-2">
        <TabList
          role="tablist"
          size="sm"
          hasDivider
          value={showingLane ? "lane" : "task"}
          onChange={(value) => onLaneChange(value === "lane" ? key : null)}
        >
          <Tab value="task" label={t.taskTab} panelId={taskPanel} />
          <Tab value="lane" label={t.laneTab} panelId={lanePanel} />
        </TabList>
      </div>
      <ul id={taskPanel} role="tabpanel" aria-label={t.taskTab} hidden={showingLane}>
        {children}
      </ul>
      <div id={lanePanel} role="tabpanel" aria-label={t.laneTab} hidden={!showingLane} className="p-4">
        {showingLane && <LaneView laneKey={key} snapshot={snapshot} error={error} />}
      </div>
    </li>
  );
}
