import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, Crosshair, TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/task-list";
import { compactSelectClass } from "@/components/workspace-list";
import {
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useStore,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AgentBadge } from "@/components/agent-badge";
import { DetailsSheet } from "@/components/details-sheet";
import { PrerequisiteConfirmation } from "@/components/prerequisite-confirmation";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { Button } from "@/components/ui/button";
import type { AgentStatus, Task, TaskId, Timestamp } from "@/lib/bindings";
import {
  useAddDependency,
  useAgentStatuses,
  useBranchFreshness,
  useFocusAgentPane,
  useHerdrStatus,
  useRemoveDependency,
} from "@/lib/queries";
import {
  axisLabelWidth,
  canAddDependency,
  dependencyEdges,
  dependencyEditableStatuses,
  freshnessWarning,
  isNotAdopted,
  isPaused,
  layoutTimeline,
  majorLabelOffset,
  openingViewport,
  waitingPrerequisites,
  relatedTasks,
  timelineAxis,
  timelineEdgePath,
  timelineScales,
  timelineYears,
  yearPeriod,
  type TimelineBar,
  type TimelineLayout,
  type TimelinePhase,
  type TimelineScale,
} from "@/lib/task-graph";
import { useThemePreference } from "@/lib/theme";
import { formatDuration } from "@/lib/review";
import { When } from "@/components/when";
import { activeSeconds, reachedMilestones } from "@/lib/timeline";
import { dueState as dueStateOf, dueStateLabels, formatEstimate } from "@/lib/plan";
import {
  barStyles,
  nowLabel,
  nowLine,
  plannedOnName,
  statusNames,
  toneFill,
  toneMark,
  toneText,
  type Tone,
} from "@/lib/status-styles";
import { cn } from "@/lib/utils";

type BarNode = Node<
  {
    bar: TimelineBar;
    statusLabel: string;
    statusStyle: string;
    ready: boolean;
    workspace: string | null;
    dimmed: boolean;
    agentStatus: AgentStatus | null;
    /** Prerequisites the task waits on, and those concluded without merging that block it. */
    waitingOn: TaskId[];
    notAdopted: TaskId[];
    /** Whether the task has a worktree whose branch can fall behind its base. */
    checkFreshness: boolean;
  },
  "bar"
>;

const nodeTypes = { bar: TimelineBarView };
const edgeTypes = { timeline: TimelineEdge };
const highlightedEdgeStyle = { stroke: "var(--foreground)", strokeWidth: 2 };

/** Height of the axis header: a row of coarse ticks above a row of fine ticks. */
const axisRowHeight = 18;
const axisHeight = 2 * axisRowHeight;
const rowsTop = axisHeight + 8;
const rowHeight = 40;
const barHeight = 30;
/** How often the current-time cursor, and the bars attached to it, move. */
const nowRefreshMs = 30_000;
/** Ticks this far outside the visible area are still drawn, so labels never pop in at the edge. */
const tickOverscan = 200;
/**
 * Width of the floating task details sheet, and its distance from the window edges. In a narrow
 * window the sheet takes at most `sheetShare` of it, but never less than `sheetMinWidth`.
 */
const sheetWidth = 480;
const sheetMinWidth = 360;
const sheetShare = 0.4;
const sheetMargin = 16;
/** Gap between a bar and a label drawn after it, because the label does not fit inside. */
const labelGap = 8;
/** Space kept between a label's end and the panel's right edge, and the least a label may shrink to. */
const labelEdgeGap = 8;
const labelMinRoom = 96;
/** Distance from the panel's left edge at which the label of a bar that starts off screen is pinned. */
const pinnedLabelInset = 2;

function sheetWidthIn(windowWidth: number): number {
  return Math.min(sheetWidth, Math.max(sheetMinWidth, windowWidth * sheetShare), windowWidth - 2 * sheetMargin);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Whether Escape pressed on `target` belongs to a form field rather than to the timeline. */
function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}
/** Width of the hover card of a bar. */
const tooltipWidth = 288;
/** How long the hover card stays after the pointer leaves its bar, so the pointer can reach the card. */
const tooltipGraceMs = 200;
/** Keys that move the selection between timeline rows, and where each one goes. */
const rowKeys: Record<string, "previous" | "next" | "first" | "last"> = {
  ArrowUp: "previous",
  ArrowDown: "next",
  Home: "first",
  End: "last",
};

const scaleLabels: Record<TimelineScale, string> = { hour: "Hour", day: "Day", week: "Week", month: "Month" };

const phaseStyles: Record<TimelinePhase, string> = {
  in_progress: toneFill.progress,
  in_review: toneFill.review,
};

const phaseLabels: Record<TimelinePhase, string> = {
  in_progress: statusNames.in_progress,
  in_review: statusNames.in_review,
};


const pad = (value: number) => String(value).padStart(2, "0");

/** The current time in Unix seconds, refreshed every `nowRefreshMs`. */
function useNow(): Timestamp {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), nowRefreshMs);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Lets the details sheet select another task on the timeline; `canOpen` is false for tasks the filters hide. */
export type SheetNavigation = { open: (id: TaskId) => void; canOpen: (id: TaskId) => boolean };

export function TaskGraph({
  tasks,
  allTasks,
  dimmed,
  workspaceLabel,
  statusLabel,
  statusStyle,
  ready,
  scale,
  onScaleChange,
  shownTaskId = null,
  onTaskShown,
  renderDetail,
}: {
  /** Tasks drawn on the timeline. */
  tasks: Task[];
  /** Tasks of every workspace, which new dependencies are checked against. */
  allTasks: Task[];
  /** Tasks drawn only for context, such as prerequisites outside the shown workspace. */
  dimmed: ReadonlySet<TaskId>;
  /** Workspace name shown on a bar, or null to leave it out. */
  workspaceLabel: (task: Task) => string | null;
  statusLabel: (task: Task) => string;
  statusStyle: (task: Task) => string;
  /** Whether a planned task can be started now; its bar is drawn solid instead of dashed. */
  ready: (task: Task) => boolean;
  scale: TimelineScale;
  onScaleChange: (scale: TimelineScale) => void;
  /** A task to select and pan to once it is on the timeline; `onTaskShown` is called when it is. */
  shownTaskId?: TaskId | null;
  onTaskShown?: () => void;
  /** Details of the task selected on the timeline, with its actions. */
  renderDetail: (task: Task, navigation: SheetNavigation) => ReactNode;
}) {
  // The legend starts closed on a phone, where it would push the chart below the first screen.
  const [legendOpen, setLegendOpen] = useState(
    () => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 768px)").matches,
  );
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const focusAgent = useFocusAgentPane();
  const herdr = useHerdrStatus();
  const agentStatuses = useAgentStatuses();
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedTaskId, setSelectedTaskId] = useState<TaskId | null>(null);
  // A dependency drawn onto a started task that it would pause, waiting for confirmation.
  const [confirmingEdge, setConfirmingEdge] = useState<{ id: TaskId; dependsOn: TaskId } | null>(null);
  const [year, setYear] = useState<number | null>(null);
  // The bar under the pointer, with its place on screen for the hover card.
  const [hovered, setHovered] = useState<{ id: TaskId; rect: DOMRect } | null>(null);
  // A selection change held back because the details sheet has unsaved edits: the task to
  // select next, or `null` to close the sheet.
  const [discarding, setDiscarding] = useState<{ next: TaskId | null } | null>(null);
  const sheet = useRef<HTMLElement>(null);
  // False while the arrow keys move the selection, so the details sheet they open leaves the
  // focus on the bars for the next key.
  const focusSheet = useRef(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A shown task selected before the timeline was ready, revealed once it is.
  const pendingReveal = useRef<TaskId | null>(null);
  const colorMode = useThemePreference();
  const container = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<BarNode> | null>(null);
  const now = useNow();
  const layout = layoutTimeline(tasks, { now, scale, period: year === null ? null : yearPeriod(year) });
  const placed = new Set(layout.bars.map((bar) => bar.task.id));
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const dependencies = dependencyEdges(tasks).filter((edge) => placed.has(edge.source) && placed.has(edge.target));
  // A task that left the timeline, through a filter or a deletion, is no longer selected.
  const selectedTask = placed.has(selectedTaskId ?? -1) ? tasks.find((task) => task.id === selectedTaskId) : undefined;
  // While a task is selected, everything outside its dependency chain fades.
  const chain = selectedTask === undefined ? null : relatedTasks(tasks, selectedTask.id);
  const inChain = (id: TaskId) => chain === null || chain.has(id);
  const changing = addDependency.isPending || removeDependency.isPending;
  const editable = (target: number) =>
    dependencyEditableStatuses.includes(tasks.find((task) => task.id === target)?.status ?? "done");
  const height = rowsTop + layout.rows * rowHeight;
  // The panel fills the space the window leaves it, so its height is measured, not derived from the rows.
  const [panelHeight, setPanelHeight] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(() => setPanelHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Rows can be panned vertically only as far as they go; never into empty space.
  const translateExtent: [[number, number], [number, number]] = [
    [-Infinity, 0],
    [Infinity, Math.max(height + 8, panelHeight)],
  ];

  const nodes: BarNode[] = layout.bars.map((bar) => ({
    id: String(bar.task.id),
    type: "bar",
    position: { x: bar.x, y: rowsTop + bar.row * rowHeight + (rowHeight - barHeight) / 2 },
    data: {
      bar,
      statusLabel: statusLabel(bar.task),
      statusStyle: statusStyle(bar.task),
      ready: ready(bar.task),
      workspace: workspaceLabel(bar.task),
      dimmed: dimmed.has(bar.task.id) || !inChain(bar.task.id),
      agentStatus: agentStatusOf(bar.task),
      waitingOn: waitingPrerequisites(bar.task, byId),
      notAdopted:
        bar.task.status === "planned" ? bar.task.dependsOn.filter((id) => isNotAdopted(byId.get(id))) : [],
      checkFreshness:
        (bar.task.status === "in_progress" || bar.task.status === "in_review") && bar.task.worktreePath !== null,
    },
    selected: bar.task.id === selectedTask?.id,
    deletable: false,
    width: bar.width,
    height: barHeight,
  }));
  const edges: Edge[] = dependencies.map((edge) => {
    const related = inChain(edge.source) && inChain(edge.target);
    // The lines of the selected task's chain stand out along with its bars.
    const highlighted = chain !== null && related;
    return {
      id: edge.id,
      source: String(edge.source),
      target: String(edge.target),
      type: "timeline",
      selected: selectedEdgeIds.has(edge.id),
      deletable: editable(edge.target),
      markerEnd: highlighted
        ? { type: MarkerType.ArrowClosed, color: "var(--foreground)", width: 8, height: 8 }
        : { type: MarkerType.ArrowClosed },
      style: highlighted ? highlightedEdgeStyle : related ? undefined : { opacity: 0.2 },
    };
  });
  function agentStatusOf(task: Task): AgentStatus | null {
    if (task.status !== "in_progress" && task.status !== "in_review") {
      return null;
    }
    return agentStatuses.data?.find((entry) => entry.taskId === task.id)?.status ?? null;
  }

  // A shown task hidden by the selected year brings back the whole timeline.
  const shownPlaced = shownTaskId !== null && placed.has(shownTaskId);
  useEffect(() => {
    if (shownTaskId === null) {
      return;
    }
    if (!shownPlaced) {
      setYear(null);
      return;
    }
    if (flow.current === null) {
      pendingReveal.current = shownTaskId;
    }
    changeSelection(shownTaskId);
    onTaskShown?.();
    // Runs for a new request, or once the requested task reaches the timeline.
  }, [shownTaskId, shownPlaced]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // Escape closes the hover card, then the details sheet, wherever the focus is, except in a
  // form field or a form that handled it already, such as an edit form discarding its changes.
  useEffect(() => {
    if (hovered === null && selectedTask === undefined) {
      return;
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (hovered !== null) {
        setHovered(null);
      } else if (discarding !== null) {
        setDiscarding(null);
      } else if (!isField(event.target)) {
        changeSelection(null);
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  });

  /**
   * Selects task `next`, or closes the details sheet when it is `null`, after asking first when
   * the sheet has an edit form with unsaved changes.
   */
  function changeSelection(next: TaskId | null) {
    if (next === (selectedTask?.id ?? null)) {
      // Clicking the selected bar again still brings it out from under the sheet.
      if (next !== null) {
        reveal(next, true);
      }
      return;
    }
    if (sheet.current?.querySelector("form[data-dirty]")) {
      setDiscarding({ next });
      setHovered(null);
      return;
    }
    applySelection(next);
  }

  function applySelection(next: TaskId | null) {
    setDiscarding(null);
    if (next === null) {
      focusSheet.current = true;
      setSelectedTaskId(null);
    } else {
      select(next);
    }
  }

  function keepTooltip() {
    clearTimeout(hideTimer.current);
  }

  function hideTooltip() {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHovered(null), tooltipGraceMs);
  }

  const selected = dependencies.filter((edge) => selectedEdgeIds.has(edge.id) && editable(edge.target));
  const hoveredBar = layout.bars.find((bar) => bar.task.id === hovered?.id);

  function opening() {
    return openingViewport(layout, {
      visible: container.current?.clientWidth ?? 0,
      panel: container.current?.clientHeight ?? 0,
      height,
    });
  }

  function showLatest(instance: ReactFlowInstance<BarNode>) {
    flow.current = instance;
    void instance.setViewport(opening()).then(() => {
      if (pendingReveal.current !== null) {
        reveal(pendingReveal.current, true);
        pendingReveal.current = null;
      }
    });
  }

  /** Pans to the bar that starts first, with its row at the top, so the history can be reached without a wheel. */
  function showEarliest() {
    const earliest = layout.bars.reduce<TimelineBar | undefined>(
      (first, bar) => (first === undefined || bar.x < first.x ? bar : first),
      undefined,
    );
    if (flow.current === null || earliest === undefined) {
      return;
    }
    const lowest = Math.min(0, (container.current?.clientHeight ?? 0) - height - 8);
    void flow.current.setViewport(
      { x: 16 - earliest.x, y: Math.max(lowest, Math.min(0, -earliest.row * rowHeight)), zoom: 1 },
      { duration: prefersReducedMotion() ? 0 : 200 },
    );
  }

  /** Pans back to where the timeline opens: the Now line and the newest rows. */
  function showToday() {
    void flow.current?.setViewport(opening(), { duration: prefersReducedMotion() ? 0 : 200 });
  }

  function connect({ source, target }: Connection) {
    const edge = { id: Number(target), dependsOn: Number(source) };
    // The server tells whether the edge pauses a started task; then the user confirms it first.
    addDependency.mutate(
      { ...edge, confirmPause: false },
      { onSuccess: (outcome) => outcome === "confirm_pause" && setConfirmingEdge(edge) },
    );
  }

  function removeEdges(removed: { source: string; target: string }[]) {
    for (const edge of removed) {
      removeDependency.mutate({ id: Number(edge.target), dependsOn: Number(edge.source) });
    }
    setSelectedEdgeIds(new Set());
  }

  /**
   * Pans the timeline so the bar of a task is on screen: clear of the floating details sheet
   * when `behindSheet`, and of the axis header and the panel's bottom edge.
   */
  function reveal(id: TaskId, behindSheet: boolean) {
    const instance = flow.current;
    const box = container.current?.getBoundingClientRect();
    const bar = layout.bars.find((candidate) => candidate.task.id === id);
    if (instance === null || box === undefined || bar === undefined) {
      return;
    }
    const sheetLeft = window.innerWidth - sheetMargin - sheetWidthIn(window.innerWidth);
    const visibleRight = (behindSheet ? Math.min(box.right, sheetLeft) : box.right) - 16;
    const { x, y, zoom } = instance.getViewport();
    const left = box.left + x + bar.x;
    // Shifts that put the bar's left end at the panel's left edge, or its right end at the visible right.
    const toLeftEdge = left - box.left - 16;
    const toRightEnd = left + bar.width - visibleRight;
    let shift = 0;
    if (toRightEnd > 0) {
      // Move the bar left until its right end is clear, but never past the panel's left edge.
      shift = Math.max(Math.min(toRightEnd, toLeftEdge), 0);
    } else if (left + bar.width < box.left + 16) {
      // A bar entirely off the left edge comes back with its latest part showing.
      shift = Math.max(toLeftEdge, toRightEnd);
    }
    const top = rowsTop + bar.row * rowHeight;
    let nextY = y;
    if (top + y < rowsTop) {
      nextY = rowsTop - top;
    } else if (top + rowHeight + y > box.height) {
      nextY = box.height - top - rowHeight;
    }
    if (shift !== 0 || nextY !== y) {
      void instance.setViewport({ x: x - shift, y: nextY, zoom }, { duration: prefersReducedMotion() ? 0 : 200 });
    }
  }

  function select(id: TaskId) {
    setSelectedTaskId(id);
    setSelectedEdgeIds(new Set());
    setHovered(null);
    reveal(id, true);
  }

  /** Moves the selection, and the keyboard focus, to the row above or below, or to the first or last row. */
  function moveSelection(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    const move = rowKeys[event.key];
    // Keys typed into the details sheet, or anywhere outside the bars, keep their usual meaning.
    const node = target.closest<HTMLElement>(".react-flow__node");
    if (move === undefined || !container.current?.contains(target) || (node === null && selectedTask === undefined)) {
      return;
    }
    const rows = [...layout.bars].sort((a, b) => a.row - b.row);
    const current = rows.findIndex((bar) => String(bar.task.id) === (node?.dataset.id ?? String(selectedTask?.id)));
    const index = {
      previous: current <= 0 ? 0 : current - 1,
      next: current === -1 ? 0 : Math.min(current + 1, rows.length - 1),
      first: 0,
      last: rows.length - 1,
    }[move];
    const id = rows[index]?.task.id;
    if (id === undefined) {
      return;
    }
    event.preventDefault();
    container.current
      .querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
      ?.focus({ preventScroll: true });
    focusSheet.current = false;
    changeSelection(id);
  }

  function changeNodes(changes: NodeChange<BarNode>[]) {
    const picked = changes.filter((change) => change.type === "select" && change.selected).pop();
    if (picked !== undefined && picked.type === "select") {
      changeSelection(Number(picked.id));
    } else if (
      changes.some((change) => change.type === "select" && !change.selected && Number(change.id) === selectedTaskId)
    ) {
      changeSelection(null);
    }
  }

  function changeEdges(changes: EdgeChange[]) {
    if (changes.some((change) => change.type === "select" && change.selected)) {
      changeSelection(null);
    }
    setSelectedEdgeIds((current) => {
      const next = new Set(current);
      for (const change of changes) {
        if (change.type === "select") {
          if (change.selected) {
            next.add(change.id);
          } else {
            next.delete(change.id);
          }
        }
      }
      return next;
    });
  }

  return (
    <section aria-label="Task timeline" className="flex flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div role="group" aria-label="Timeline scale" className="flex gap-1">
          {timelineScales.map((option) => (
            <Button
              key={option}
              size="xs"
              variant={scale === option ? "default" : "ghost"}
              aria-pressed={scale === option}
              onClick={() => onScaleChange(option)}
            >
              {scaleLabels[option]}
            </Button>
          ))}
        </div>
        <select
          aria-label="Timeline period"
          className={compactSelectClass}
          value={year ?? "all"}
          onChange={(event) => setYear(event.target.value === "all" ? null : Number(event.target.value))}
        >
          <option value="all">All time</option>
          {timelineYears(tasks, now).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {layout.bars.length > 0 && (
          <div role="group" aria-label="Timeline position" className="flex gap-1">
            <Button size="xs" variant="outline" onClick={showEarliest}>
              <ChevronsLeft />
              Earliest task
            </Button>
            <Button size="xs" variant="outline" disabled={layout.nowX === null} onClick={showToday}>
              Today
            </Button>
          </div>
        )}
        <details
          open={legendOpen}
          onToggle={(event) => setLegendOpen(event.currentTarget.open)}
          className="group min-w-0 text-muted-foreground open:basis-full"
        >
        <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1 font-medium max-md:min-h-11 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          Legend
        </summary>
        <ul aria-label="Phases" className="flex flex-wrap gap-x-2 gap-y-1 pb-1 [&>li]:whitespace-nowrap">
          <li className="flex items-center gap-1">
            <span className="size-2 rotate-45 border border-muted-foreground" />
            {plannedOnName}
          </li>
          <li className="flex items-center gap-1">
            <span className={cn("h-2 border-l-2", toneMark.attention)} />
            Became ready
          </li>
          <li className="flex items-center gap-1">
            <span className="w-3 border-t border-dashed border-muted-foreground" />
            Waiting or paused
          </li>
          <li className="flex items-center gap-1">
            <span className={cn("h-2 w-3 rounded-sm border", barStyles.blocked)} />
            {statusNames.planned}
          </li>
          <li className="flex items-center gap-1">
            <span className={cn("h-2 w-3 rounded-sm border", barStyles.ready)} />
            {statusNames.ready}
          </li>
          {(Object.keys(phaseLabels) as TimelinePhase[]).map((phase) => (
            <li key={phase} className="flex items-center gap-1">
              <span className={cn("h-1.5 w-3 rounded-full", phaseStyles[phase])} />
              {phaseLabels[phase]}
            </li>
          ))}
          <li className="flex items-center gap-1">
            <span className={cn("h-2 w-3 rounded-sm border", barStyles.done)} />
            {statusNames.done}
          </li>
          <li className="flex items-center gap-1">
            <span className="h-3 border-l-2 border-muted-foreground" />
            Due date
          </li>
          <li className="flex items-center gap-1">
            <span className={cn("h-2 w-3 rounded-sm", barStyles.behindDue)} />
            Past due
          </li>
        </ul>
        <p className="pb-1">
          Tasks not started yet wait at the current time, after their prerequisites.
          <span className="[@media(pointer:coarse)]:hidden">
            {" "}Drag from a task's right handle to another task to make it a prerequisite. With a task selected, use the
            arrow keys to move between rows.
          </span>
        </p>
        </details>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground empty:hidden">
        {selected.length > 0 && (
          <Button
            size="xs"
            variant="outline"
            disabled={changing}
            onClick={() => removeEdges(selected.map((edge) => ({ source: String(edge.source), target: String(edge.target) })))}
          >
            Remove {selected.map((edge) => `#${edge.source} \u2192 #${edge.target}`).join(", ")}
          </Button>
        )}
      </div>
      {confirmingEdge !== null && (
        <PrerequisiteConfirmation
          taskId={confirmingEdge.id}
          prerequisite={`#${confirmingEdge.dependsOn}`}
          pending={addDependency.isPending}
          onConfirm={() =>
            addDependency.mutate({ ...confirmingEdge, confirmPause: true }, { onSettled: () => setConfirmingEdge(null) })
          }
          onCancel={() => setConfirmingEdge(null)}
        />
      )}
      {(addDependency.error ?? removeDependency.error ?? focusAgent.error) && (
        <p role="alert" className="text-xs text-destructive">
          {(addDependency.error ?? removeDependency.error ?? focusAgent.error)?.message}
        </p>
      )}
      <div
        className="flex min-h-40 flex-1 gap-2"
        onKeyDown={moveSelection}
        onFocus={(event) => {
          // A bar reached with Tab comes into view; a selected one also clears the details sheet.
          const id = (event.target as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset.id;
          if (id !== undefined) {
            reveal(Number(id), Number(id) === selectedTask?.id);
          }
        }}
      >
        <div
          ref={container}
          className="min-w-0 flex-1 rounded-lg border"
        >
          {layout.bars.length === 0 ? (
            <EmptyState
              title={year === null ? "No planned tasks yet." : `No tasks in ${year}.`}
              hint={
                year === null
                  ? "Add a task in a workspace and it appears here on the timeline."
                  : "Show every year to see the tasks planned or finished in other years."
              }
              action={
                year === null ? undefined : (
                  <Button size="sm" variant="outline" onClick={() => setYear(null)}>
                    Show all years
                  </Button>
                )
              }
            />
          ) : (
            <ReactFlow
              key={`${scale}-${year ?? "all"}`}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              // Arrowheads take the line color (`--xy-edge-stroke`) instead of a fixed light gray.
              defaultMarkerColor={null}
              onInit={showLatest}
              minZoom={1}
              maxZoom={1}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              panOnScroll
              translateExtent={translateExtent}
              nodesDraggable={false}
              nodesConnectable={!changing}
              isValidConnection={(c) => canAddDependency(allTasks, Number(c.source), Number(c.target))}
              onConnect={connect}
              onNodesChange={changeNodes}
              onPaneClick={() => changeSelection(null)}
              onNodeMouseEnter={(event, node) => {
                keepTooltip();
                setHovered({ id: Number(node.id), rect: event.currentTarget.getBoundingClientRect() });
              }}
              onNodeMouseLeave={hideTooltip}
              onMoveStart={() => setHovered(null)}
              autoPanOnNodeFocus={false}
              onEdgesChange={changeEdges}
              onEdgesDelete={removeEdges}
              deleteKeyCode={["Backspace", "Delete"]}
              colorMode={colorMode}
              proOptions={{ hideAttribution: true }}
            >
              <TimelineGrid layout={layout} />
              <TimelineHeader layout={layout} now={now} />
            </ReactFlow>
          )}
        </div>
        {hovered !== null && hoveredBar !== undefined && (
          <TimelineTooltip
            task={hoveredBar.task}
            anchor={hovered.rect}
            bounds={container.current?.getBoundingClientRect() ?? hovered.rect}
            workspace={workspaceLabel(hoveredBar.task)}
            statusLabel={statusLabel(hoveredBar.task)}
            statusStyle={statusStyle(hoveredBar.task)}
            agentStatus={agentStatusOf(hoveredBar.task)}
            now={now}
            focusAgent={
              agentStatusOf(hoveredBar.task) !== null && hoveredBar.task.herdrWorkspaceId !== null
                ? {
                    disabled: herdr.data?.running !== true || focusAgent.isPending,
                    run: () => focusAgent.mutate(hoveredBar.task.id),
                  }
                : null
            }
            onMouseEnter={keepTooltip}
            onMouseLeave={() => setHovered(null)}
          />
        )}
        {selectedTask !== undefined && (
          // A floating sheet over the window's right side: the timeline keeps its full width and
          // the details get room to wrap instead of being cut off. On a phone, a bottom sheet.
          <DetailsSheet
            ref={sheet}
            width={`min(${sheetWidth}px, max(${sheetMinWidth}px, ${sheetShare * 100}vw), calc(100vw - ${2 * sheetMargin}px))`}
            takeFocus={focusSheet.current}
            returnFocus={() =>
              container.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${selectedTask.id}"]`)
            }
            onClose={() => changeSelection(null)}
            banner={
              discarding !== null && (
                <div
                  role="group"
                  aria-label="Unsaved changes"
                  className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1">Discard your unsaved changes to #{selectedTask.id}?</span>
                  <Button size="xs" variant="outline" autoFocus onClick={() => setDiscarding(null)}>
                    Keep editing
                  </Button>
                  <Button size="xs" variant="destructive" onClick={() => applySelection(discarding.next)}>
                    Discard changes
                  </Button>
                </div>
              )
            }
          >
            {renderDetail(selectedTask, { open: changeSelection, canOpen: (id) => placed.has(id) })}
          </DetailsSheet>
        )}
        {layout.unplaced.length > 0 && (
              <aside aria-label="Tasks without a planned date" className="flex w-56 shrink-0 flex-col gap-1 text-xs">
                <h3 className="font-medium text-muted-foreground">Not on the timeline</h3>
                <ul className="flex flex-col gap-1">
                  {layout.unplaced.map((task) => (
                    <li key={task.id} className="flex items-center gap-1.5 rounded-md border px-2 py-1">
                      <span className="tabular-nums text-muted-foreground">#{task.id}</span>
                      <span className="truncate" title={task.title}>
                        {task.title}
                      </span>
                      <span className={cn("ml-auto shrink-0 rounded-full px-1.5", statusStyle(task))}>
                        {statusLabel(task)}
                      </span>
                    </li>
                  ))}
                </ul>
              </aside>
        )}
      </div>
    </section>
  );
}

/** Left and right ends, in flow coordinates, of the part of the timeline that is on screen. */
function useVisibleRange(): { from: number; to: number } {
  const { x } = useViewport();
  const width = useStore((state) => state.width);
  return { from: -x - tickOverscan, to: -x + width + tickOverscan };
}

/**
 * Vertical grid lines at each fine tick and the current-time cursor, behind the bars. Like
 * the header, they follow horizontal panning only, so they always run the panel's full height.
 */
function TimelineGrid({ layout }: { layout: TimelineLayout }) {
  const { x } = useViewport();
  const { from, to } = useVisibleRange();
  const { ticks } = timelineAxis(layout, from, to);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 0 }}>
      <div className="absolute inset-y-0 left-0" style={{ transform: `translateX(${x}px)` }}>
        {ticks.map((tick) => (
          <div key={tick.at} className="absolute inset-y-0 border-l border-border/60" style={{ left: tick.x }} />
        ))}
        {layout.nowX !== null && (
          <div className={cn("absolute inset-y-0 border-l-2", nowLine)} style={{ left: layout.nowX }} />
        )}
      </div>
    </div>
  );
}

/**
 * The time axis above the rows, like a Gantt chart header: it follows horizontal panning
 * but stays at the top when the rows scroll.
 */
function TimelineHeader({ layout, now }: { layout: TimelineLayout; now: Timestamp }) {
  const { x } = useViewport();
  const { from, to } = useVisibleRange();
  const { ticks, majorTicks } = timelineAxis(layout, from, to);
  const date = new Date(now * 1000);
  const nowText = `Now ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const nowLabelBox = layout.nowX === null ? null : { x: layout.nowX, width: axisLabelWidth(nowText) };
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden border-b bg-background text-[10px] text-muted-foreground"
      style={{ height: axisHeight, zIndex: 5 }}
    >
      <div className="absolute left-0 top-0 h-full" style={{ transform: `translateX(${x}px)` }}>
        {majorTicks.map((tick) => {
          const offset = majorLabelOffset(tick, axisLabelWidth(tick.label), -x, nowLabelBox);
          return (
            <div
              key={tick.at}
              className="absolute top-0 border-l border-border font-medium text-foreground"
              style={{ left: tick.x, width: tick.right - tick.x, height: axisRowHeight }}
            >
              {offset !== null && (
                <span className="block whitespace-nowrap pl-1" style={{ marginLeft: offset }}>
                  {tick.label}
                </span>
              )}
            </div>
          );
        })}
        {ticks.map((tick) => (
          <div
            key={tick.at}
            className="absolute whitespace-nowrap border-l border-border pl-1"
            style={{ left: tick.x, top: axisRowHeight, height: axisRowHeight }}
          >
            {tick.label}
          </div>
        ))}
        {layout.nowX !== null && (
          <div className={cn("absolute top-0 h-full border-l-2", nowLine)} style={{ left: layout.nowX }}>
            {/* Only the label row gets a background, so the fine ticks below stay visible. */}
            <span
              className={cn("block whitespace-nowrap bg-background pl-1 font-semibold", nowLabel)}
              style={{ height: axisRowHeight }}
            >
              {nowText}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The hover card of a bar: what the bar's label may cut off, and when the task reached each
 * milestone. It sits below the bar, or above it near the bottom of the window.
 */
function TimelineTooltip({
  task,
  anchor,
  bounds,
  workspace,
  statusLabel,
  statusStyle,
  agentStatus,
  now,
  focusAgent,
  onMouseEnter,
  onMouseLeave,
}: {
  task: Task;
  anchor: DOMRect;
  bounds: DOMRect;
  workspace: string | null;
  statusLabel: string;
  statusStyle: string;
  agentStatus: AgentStatus | null;
  now: Timestamp;
  /** Focuses the task's agent pane in herdr; `null` when the task has no agent. */
  focusAgent: { disabled: boolean; run: () => void } | null;
  /** Mouse, not pointer, events: they come after the bar's `mouseleave`, which starts the hiding. */
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const milestones = reachedMilestones(task.milestones);
  const active = activeSeconds(task.timeline, now);
  const dueState = dueStateOf(task, now);
  // A bar may start far off screen; the card starts where the visible part of the bar does.
  const left = Math.max(
    Math.min(Math.max(anchor.left, bounds.left), window.innerWidth - tooltipWidth - 8),
    8,
  );
  const below = anchor.bottom < window.innerHeight * 0.6;
  return (
    <div
      role="tooltip"
      aria-label={`Summary of #${task.id}`}
      className="fixed z-50 flex flex-col gap-1.5 rounded-lg border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        left,
        width: tooltipWidth,
        ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }),
      }}
    >
      <div className="flex items-center gap-1.5">
        {workspace !== null && <span className="rounded-sm bg-muted px-1 text-muted-foreground">{workspace}</span>}
        <TaskTypeBadge type={task.taskType} className="px-1 leading-4" />
        <span className="tabular-nums text-muted-foreground">#{task.id}</span>
        <span className={cn("ml-auto shrink-0 rounded-full px-1.5 font-medium", statusStyle)}>{statusLabel}</span>
        {agentStatus !== null && <AgentBadge taskId={task.id} status={agentStatus} className="px-1.5 py-0" />}
      </div>
      <p className="break-words-keep font-semibold">{task.title}</p>
      {milestones.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {milestones.map(({ label, at }) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums">
                <When at={at} />
              </dd>
            </div>
          ))}
          {active !== null && (
            <>
              <dt className="text-muted-foreground">Active</dt>
              <dd className="tabular-nums">{formatDuration(active)}</dd>
            </>
          )}
        </dl>
      )}
      {(task.estimate !== null || task.dueDate !== null) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {task.estimate !== null && (
            <>
              <dt className="text-muted-foreground">Estimate</dt>
              <dd className="tabular-nums">{formatEstimate(task.estimate)}</dd>
            </>
          )}
          {task.dueDate !== null && (
            <>
              <dt className="text-muted-foreground">{dueState === null ? "Due" : dueStateLabels[dueState]}</dt>
              <dd
                className={cn(
                  "tabular-nums",
                  (dueState === "late" || dueState === "overdue") && toneText.danger,
                )}
              >
                {task.dueDate}
              </dd>
            </>
          )}
        </dl>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground">Click for details</p>
        {focusAgent !== null && (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Focus agent pane of #${task.id}`}
            disabled={focusAgent.disabled}
            onClick={focusAgent.run}
          >
            <Crosshair />
            Focus agent pane
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * A dependency line routed between the rows, so it shows even when the bars meet in time.
 *
 * The line has no halo in the background color: a browser that darkens light pages itself
 * (Samsung Internet's dark mode) leaves SVG strokes as they are, so a halo stays light on the
 * darkened page, and the halos of the lines leaving one prerequisite merge into a thick band.
 */
function TimelineEdge({ sourceX, sourceY, targetX, targetY, markerEnd, style, interactionWidth }: EdgeProps) {
  const path = timelineEdgePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, rowHeight);
  return <BaseEdge path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />;
}

function TimelineBarView({
  data: { bar, statusLabel, statusStyle, ready, workspace, dimmed, agentStatus, waitingOn, notAdopted, checkFreshness },
  selected,
  positionAbsoluteX,
}: NodeProps<BarNode>) {
  const { task, phases, blocks, pauses, pending, lead, dueX, dueState } = bar;
  // How far the bar reaches left of the panel's edge; it changes, and re-renders the bar, only
  // while the bar starts off screen.
  const offScreen = useStore((state) => Math.max(0, pinnedLabelInset - positionAbsoluteX - state.transform[0]));
  // Shares the cached check of the task row, so the bar warns about the same base freshness.
  const freshness = useBranchFreshness(task.id, checkFreshness);
  const behindBase = checkFreshness && freshness.data ? freshnessWarning(freshness.data) : null;
  const conflicting = checkFreshness && freshness.data?.mergeable === "conflicting";
  const refs = (ids: TaskId[]) => ids.map((id) => `#${id}`).join(", ");
  const warnings = [
    notAdopted.length > 0 && `${refs(notAdopted)} not adopted`,
    waitingOn.length > 0 && `Waiting on ${refs(waitingOn)}`,
    behindBase,
  ].filter((warning): warning is string => typeof warning === "string");
  const severe = notAdopted.length > 0 || conflicting;
  // Waiting alone is nothing to act on, so only a branch behind its base warns in amber.
  const warningTone: Tone = severe ? "danger" : behindBase !== null ? "attention" : "neutral";
  // A paused task whose new prerequisite is done is ready again and drawn like a ready one.
  const faded = isPaused(task) && !ready;
  const behindDue = dueState === "late" || dueState === "overdue";
  // A paused task's dashed line runs on past the bar to now.
  const drawnWidth = Math.max(bar.width, ...pauses.map((pause) => pause.x + pause.width));
  // A label wider than its bar starts after the bar's right end, so no chip sits across the
  // bar's edge or under its handle.
  const label = useRef<HTMLDivElement>(null);
  const [labelOutside, setLabelOutside] = useState(false);
  useLayoutEffect(() => {
    const element = label.current;
    if (element === null) {
      return;
    }
    const { minWidth, maxWidth } = element.style;
    element.style.minWidth = "0";
    element.style.maxWidth = "none";
    const natural = element.offsetWidth;
    element.style.minWidth = minWidth;
    element.style.maxWidth = maxWidth;
    setLabelOutside(natural > bar.width);
  }, [bar.width, task.title, workspace, statusLabel, agentStatus]);
  const labelLeft = labelOutside ? drawnWidth + labelGap - 6 : 0;
  // A label that would start off screen is pinned to the panel's left edge, behind a chevron
  // saying that the bar goes on to the left.
  const pinned = labelLeft < offScreen;
  const labelMargin = pinned ? offScreen : labelOutside ? labelLeft : 0;
  // A label longer than the room left up to the panel's right edge ends with an ellipsis there
  // instead of being cut off.
  const room = useStore((state) =>
    Math.max(labelMinRoom, Math.floor(state.width - positionAbsoluteX - state.transform[0] - labelMargin - labelEdgeGap)),
  );
  return (
    <div
      data-dimmed={dimmed || undefined}
      data-due-state={dueState ?? undefined}
      className={cn("relative h-full w-full", dimmed && "opacity-40")}
    >
      <Handle type="target" position={Position.Left} />
      {lead !== null && (
        // The wait before the bar: from the planned time, through the time it became ready.
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2"
          style={{ left: lead.x, width: -lead.x }}
        >
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-muted-foreground/70" />
          {lead.planned && (
            <span className="absolute -left-1 -top-1 size-2 rotate-45 border border-muted-foreground bg-background" />
          )}
          {lead.readyX !== null && (
            <span
              className={cn("absolute -top-1 h-2 border-l-2", toneMark.attention)}
              style={{ left: lead.readyX - lead.x }}
            />
          )}
        </div>
      )}
      {pauses.map((pause) => (
        // A pause cuts the bar, like the wait before it: the blocks of work on either side are
        // joined by a dashed line.
        <div
          key={pause.x}
          aria-hidden
          data-pause
          className="pointer-events-none absolute top-1/2 border-t border-dashed border-muted-foreground/70"
          style={{ left: pause.x, width: pause.width }}
        />
      ))}
      {blocks.map((block) => (
        <div
          key={block.x}
          data-block
          className={cn(
            "absolute inset-y-0 overflow-hidden rounded-md border bg-card shadow-sm",
            selected && "ring-2 ring-primary",
            ready ? barStyles.ready : pending && barStyles.blocked,
            task.status === "done" && barStyles.done,
            faded && barStyles.paused,
            behindDue && barStyles.behindDue,
          )}
          style={{ left: block.x, width: block.width }}
        >
          <div className="absolute inset-x-0 bottom-0 h-1.5">
            {phases.map((phase) => (
              <span
                key={phase.x}
                className={cn("absolute inset-y-0", phaseStyles[phase.phase])}
                style={{ left: phase.x - block.x, width: phase.width }}
              />
            ))}
          </div>
        </div>
      ))}
      {dueX !== null && (
        // The end of the due day: a line as tall as the bar, so it stays inside the row, drawn
        // before the label so the label's chips cover it. Its hit area is wider than the line,
        // so its own tooltip can be reached.
        <span
          aria-label={`Due date of #${task.id}`}
          title={`Due ${task.dueDate}`}
          data-due-mark
          className="absolute inset-y-0 flex w-2 justify-center"
          style={{ left: dueX - 4 }}
        >
          <span className={cn("h-full border-l-2", behindDue ? toneMark.danger : toneMark.neutral)} />
        </span>
      )}
      {/* A halo in the background colour keeps grid lines and the Now line from crossing the letters. */}
      <div
        ref={label}
        className="relative flex items-center gap-1.5 whitespace-nowrap px-1.5 pt-1 text-xs text-card-foreground [text-shadow:0_0_3px_var(--background),0_0_3px_var(--background)]"
        data-pinned={pinned || undefined}
        style={{
          width: "max-content",
          maxWidth: room,
          ...(labelMargin > 0 ? { marginLeft: labelMargin } : { minWidth: "100%" }),
        }}
      >
        {pinned && (
          <ChevronLeft
            role="img"
            aria-label={`#${task.id} starts earlier`}
            className="-ml-1 size-3.5 shrink-0 text-muted-foreground"
          />
        )}
        {workspace !== null && <span className="rounded-sm bg-muted px-1 text-muted-foreground">{workspace}</span>}
        <TaskTypeBadge type={task.taskType} className="bg-card px-1 leading-4" />
        <span className="tabular-nums text-muted-foreground">#{task.id}</span>
        <span className="min-w-0 truncate font-semibold">{task.title}</span>
        {warnings.length > 0 && (
          <TriangleAlert
            role="img"
            aria-label={`Warnings of #${task.id}: ${warnings.join("; ")}`}
            data-severe={severe || undefined}
            data-tone={warningTone}
            className={cn("size-3.5 shrink-0", toneText[warningTone])}
          >
            <title>{warnings.join("\n")}</title>
          </TriangleAlert>
        )}
        <span className={cn("ml-auto shrink-0 rounded-full px-1.5 font-medium", statusStyle)}>{statusLabel}</span>
        {agentStatus !== null && <AgentBadge taskId={task.id} status={agentStatus} className="px-1.5 py-0" />}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
