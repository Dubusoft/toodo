import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Bot, ChevronLeft, ChevronsLeft, TriangleAlert } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Selector } from "@astryxdesign/core/Selector";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { EmptyState } from "@/components/task-list";
import {
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useStore,
  useViewport,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { DetailsSheet } from "@/components/details-sheet";
import { PrerequisiteConfirmation } from "@/components/prerequisite-confirmation";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { Button } from "@/components/button";
import {
  axisHeight,
  axisRowHeight,
  barHeight,
  rowHeight,
  rowsTop,
  sheetMargin,
  sheetMinWidth,
  sheetShare,
  sheetWidth,
} from "@/components/timeline/geometry";
import { useDependencyEditing } from "@/components/timeline/use-dependency-editing";
import { useHoverCard } from "@/components/timeline/use-hover-card";
import { useTimelineSelection } from "@/components/timeline/use-timeline-selection";
import { useTimelineViewport } from "@/components/timeline/use-timeline-viewport";
import type { Task, TaskId, Timestamp } from "@/lib/bindings";
import {
  axisLabelWidth,
  canAddDependency,
  dependencyEdges,
  isNotAdopted,
  isPaused,
  layoutTimeline,
  majorLabelOffset,
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
import { activeSeconds, reachedMilestones, waitingSeconds } from "@/lib/timeline";
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
    /** Prerequisites the task waits on, and those concluded without merging that block it. */
    waitingOn: TaskId[];
    notAdopted: TaskId[];
  },
  "bar"
>;

const nodeTypes = { bar: TimelineBarView };
const edgeTypes = { timeline: TimelineEdge };
const highlightedEdgeStyle = { stroke: "var(--foreground)", strokeWidth: 2 };

/** How often the current-time cursor, and the bars attached to it, move. */
const nowRefreshMs = 30_000;
/** Ticks this far outside the visible area are still drawn, so labels never pop in at the edge. */
const tickOverscan = 200;
/** Gap between a bar and a label drawn after it, because the label does not fit inside. */
const labelGap = 8;
/** Space kept between a label's end and the panel's right edge, and the least a label may shrink to. */
const labelEdgeGap = 8;
const labelMinRoom = 96;
/** Distance from the panel's left edge at which the label of a bar that starts off screen is pinned. */
const pinnedLabelInset = 2;

/** Width of the hover card of a bar. */
const tooltipWidth = 288;

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
  selectedTaskId,
  onSelectedTaskChange: setSelectedTaskId,
  shownTaskId = null,
  onTaskShown,
  onNearPast,
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
  /** The selected task, whose details sheet is open, owned by the caller. */
  selectedTaskId: TaskId | null;
  onSelectedTaskChange: (id: TaskId | null) => void;
  /** A task to select and pan to once it is on the timeline; `onTaskShown` is called when it is. */
  shownTaskId?: TaskId | null;
  onTaskShown?: () => void;
  /**
   * Called while the user pans or scrolls to within a screen of the earliest bar, to load older
   * tasks; left out when there are none to load.
   */
  onNearPast?: () => void;
  /** Details of the task selected on the timeline, with its actions. */
  renderDetail: (task: Task, navigation: SheetNavigation) => ReactNode;
}) {
  // The legend starts closed on a phone, where it would push the chart below the first screen.
  const [legendOpen, setLegendOpen] = useState(
    () => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 768px)").matches,
  );
  const [year, setYear] = useState<number | null>(null);
  const colorMode = useThemePreference();
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
  const chart = `${scale}-${year ?? "all"}`;
  const viewport = useTimelineViewport<BarNode>({ layout, chart, onNearPast });
  const hoverCard = useHoverCard();
  const edits = useDependencyEditing(tasks, dependencies);
  const selection = useTimelineSelection({
    selectedTask,
    onSelectedTaskChange: setSelectedTaskId,
    bars: layout.bars,
    panel: viewport.container,
    reveal: viewport.reveal,
    bar: viewport.bar,
    hoverCard,
    clearSelectedEdges: edits.clearSelectedEdges,
  });
  const { changeSelection } = selection;

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
      waitingOn: waitingPrerequisites(bar.task, byId),
      notAdopted:
        bar.task.status === "planned" ? bar.task.dependsOn.filter((id) => isNotAdopted(byId.get(id))) : [],
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
      selected: edits.selectedEdgeIds.has(edge.id),
      deletable: edits.editable(edge.target),
      markerEnd: highlighted
        ? { type: MarkerType.ArrowClosed, color: "var(--foreground)", width: 8, height: 8 }
        : { type: MarkerType.ArrowClosed },
      style: highlighted ? highlightedEdgeStyle : related ? undefined : { opacity: 0.2 },
    };
  });

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
    viewport.revealOnInit(shownTaskId);
    changeSelection(shownTaskId);
    onTaskShown?.();
    // Runs for a new request, or once the requested task reaches the timeline.
  }, [shownTaskId, shownPlaced]);

  function changeEdges(changes: EdgeChange[]) {
    if (changes.some((change) => change.type === "select" && change.selected)) {
      changeSelection(null);
    }
    edits.selectEdges(changes);
  }

  const { hovered } = hoverCard;
  const hoveredBar = layout.bars.find((bar) => bar.task.id === hovered?.id);
  const { removable, confirmingEdge } = edits;

  return (
    <section aria-label="Task timeline" className="flex flex-1 flex-col gap-2">
      {/* On a phone the controls stay on one line that scrolls sideways, until the legend opens below them. */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 text-xs",
          !legendOpen && "max-md:flex-nowrap max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:*:shrink-0",
        )}
      >
        <ToggleButtonGroup
          label="Timeline scale"
          size="sm"
          value={scale}
          onChange={(next) => typeof next === "string" && onScaleChange(next as TimelineScale)}
        >
          {timelineScales.map((option) => (
            <ToggleButton key={option} value={option} label={scaleLabels[option]} />
          ))}
        </ToggleButtonGroup>
        <Selector
          label="Timeline period"
          isLabelHidden
          size="sm"
          options={[
            { value: "all", label: "All time" },
            ...timelineYears(tasks, now).map((option) => ({ value: String(option), label: String(option) })),
          ]}
          value={year === null ? "all" : String(year)}
          onChange={(value) => setYear(value === "all" ? null : Number(value))}
        />
        {layout.bars.length > 0 && (
          <div role="group" aria-label="Timeline position" className="flex gap-1">
            <Button
              size="sm"
              variant="secondary"
              icon={<ChevronsLeft />}
              label="Earliest task"
              onClick={viewport.showEarliest}
            />
            <Button
              size="sm"
              variant="secondary"
              label="Today"
              isDisabled={layout.nowX === null}
              onClick={viewport.showToday}
            />
          </div>
        )}
        <Collapsible
          trigger="Legend"
          chevronPosition="start"
          isOpen={legendOpen}
          onOpenChange={setLegendOpen}
          className={cn("min-w-0 text-muted-foreground", legendOpen && "basis-full")}
        >
          <TimelineLegend />
        </Collapsible>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground empty:hidden">
        {removable.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            label={`Remove ${removable.map((edge) => `#${edge.source} \u2192 #${edge.target}`).join(", ")}`}
            isDisabled={edits.changing}
            onClick={() =>
              edits.removeEdges(removable.map((edge) => ({ source: String(edge.source), target: String(edge.target) })))
            }
          />
        )}
      </div>
      {confirmingEdge !== null && (
        <PrerequisiteConfirmation
          taskId={confirmingEdge.id}
          prerequisite={`#${confirmingEdge.dependsOn}`}
          pending={edits.confirmPending}
          onConfirm={() => edits.confirmEdge(confirmingEdge)}
          onCancel={() => edits.dropConfirmation(confirmingEdge)}
        />
      )}
      {edits.errors.length > 0 && (
        <div role="alert" className="text-xs text-destructive">
          {edits.errors.map((message, index) => (
            <p key={index}>{message}</p>
          ))}
        </div>
      )}
      <div
        className="flex min-h-40 flex-1 gap-2"
        onKeyDown={selection.moveSelection}
        onFocus={(event) => {
          // A bar reached with Tab comes into view; a selected one also clears the details sheet.
          const id = (event.target as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset.id;
          if (id !== undefined) {
            viewport.reveal(Number(id), Number(id) === selectedTask?.id);
          }
        }}
      >
        <div
          ref={viewport.container}
          className="min-w-0 flex-1 rounded-lg border"
          // Captured: React Flow stops the wheel events it pans with from bubbling.
          onWheelCapture={(event) => viewport.scrollUpAtTop(event.nativeEvent)}
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
                  <Button size="sm" variant="secondary" label="Show all years" onClick={() => setYear(null)} />
                )
              }
            />
          ) : (
            <ReactFlow
              key={chart}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              // Arrowheads take the line color (`--xy-edge-stroke`) instead of a fixed light gray.
              defaultMarkerColor={null}
              onInit={viewport.showLatest}
              minZoom={1}
              maxZoom={1}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              panOnScroll
              translateExtent={viewport.translateExtent}
              nodesDraggable={false}
              nodesConnectable={!edits.changing}
              isValidConnection={(c) => canAddDependency(allTasks, Number(c.source), Number(c.target))}
              onConnect={edits.connect}
              onNodesChange={selection.changeNodes}
              onPaneClick={() => changeSelection(null)}
              onNodeMouseEnter={(event, node) =>
                hoverCard.show(Number(node.id), event.currentTarget.getBoundingClientRect())
              }
              onNodeMouseLeave={hoverCard.hideSoon}
              onMoveStart={hoverCard.hide}
              onMove={(_, position) => viewport.nearPast(position)}
              autoPanOnNodeFocus={false}
              onEdgesChange={changeEdges}
              onEdgesDelete={edits.removeEdges}
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
            bounds={viewport.container.current?.getBoundingClientRect() ?? hovered.rect}
            workspace={workspaceLabel(hoveredBar.task)}
            statusLabel={statusLabel(hoveredBar.task)}
            statusStyle={statusStyle(hoveredBar.task)}
            now={now}
            onMouseEnter={hoverCard.keep}
            onMouseLeave={hoverCard.hide}
          />
        )}
        {selectedTask !== undefined && (
          // A floating sheet over the window's right side: the timeline keeps its full width and
          // the details get room to wrap instead of being cut off. On a phone, a bottom sheet.
          <DetailsSheet
            ref={selection.sheet}
            width={`min(${sheetWidth}px, max(${sheetMinWidth}px, ${sheetShare * 100}vw), calc(100vw - ${2 * sheetMargin}px))`}
            takeFocus={selection.sheetTakesFocus}
            returnFocus={() => viewport.bar(selectedTask.id)}
            onClose={() => changeSelection(null)}
            banner={
              selection.discarding !== null && (
                <DiscardBanner
                  id={selectedTask.id}
                  onKeep={selection.keepEditing}
                  onDiscard={selection.discardChanges}
                />
              )
            }
          >
            {renderDetail(selectedTask, { open: changeSelection, canOpen: (id) => placed.has(id) })}
          </DetailsSheet>
        )}
        {layout.unplaced.length > 0 && (
          <UnplacedTasks tasks={layout.unplaced} statusLabel={statusLabel} statusStyle={statusStyle} />
        )}
      </div>
    </section>
  );
}

/** What the marks on the timeline mean, and how to work it. */
function TimelineLegend() {
  return (
    <>
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
        Tasks not started yet wait at the current time, after their prerequisites, or at the end of their wait.
        A paused task that waits gets a box there too.
        <span className="[@media(pointer:coarse)]:hidden">
          {" "}Drag from a task's right handle to another task to make it a prerequisite. With a task selected, use the
          arrow keys to move between rows.
        </span>
      </p>
    </>
  );
}

/** Asks whether to drop the unsaved changes in the details sheet before the selection changes. */
function DiscardBanner({ id, onKeep, onDiscard }: { id: TaskId; onKeep: () => void; onDiscard: () => void }) {
  return (
    <div
      role="group"
      aria-label="Unsaved changes"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-xs"
    >
      <span className="min-w-0 flex-1">Discard your unsaved changes to #{id}?</span>
      <Button size="sm" variant="secondary" label="Keep editing" autoFocus onClick={onKeep} />
      <Button size="sm" variant="destructive" label="Discard changes" onClick={onDiscard} />
    </div>
  );
}

/** Tasks that started or closed without a known time, listed beside the timeline. */
function UnplacedTasks({
  tasks,
  statusLabel,
  statusStyle,
}: {
  tasks: Task[];
  statusLabel: (task: Task) => string;
  statusStyle: (task: Task) => string;
}) {
  return (
    <aside aria-label="Tasks without a planned date" className="flex w-56 shrink-0 flex-col gap-1 text-xs">
      <h3 className="font-medium text-muted-foreground">Not on the timeline</h3>
      <ul className="flex flex-col gap-1">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-1.5 rounded-md border px-2 py-1">
            <span className="tabular-nums text-muted-foreground">#{task.id}</span>
            <span className="truncate" title={task.title}>
              {task.title}
            </span>
            {task.autopilot && <AutopilotIcon id={task.id} />}
            <span className={cn("ml-auto shrink-0 rounded-full px-1.5", statusStyle(task))}>{statusLabel(task)}</span>
          </li>
        ))}
      </ul>
    </aside>
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
  now,
  onMouseEnter,
  onMouseLeave,
}: {
  task: Task;
  anchor: DOMRect;
  bounds: DOMRect;
  workspace: string | null;
  statusLabel: string;
  statusStyle: string;
  now: Timestamp;
  /** Mouse, not pointer, events: they come after the bar's `mouseleave`, which starts the hiding. */
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const milestones = reachedMilestones(task.milestones);
  const active = activeSeconds(task.timeline, now);
  const waiting = waitingSeconds(task.timeline, now);
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
        {workspace !== null && <Badge label={workspace} />}
        <TaskTypeBadge type={task.taskType} className="px-1 leading-4" />
        <span className="tabular-nums text-muted-foreground">#{task.id}</span>
        <span className={cn("ml-auto shrink-0 rounded-full px-1.5 font-medium", statusStyle)}>{statusLabel}</span>
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
          {waiting !== null && waiting > 0 && (
            <>
              <dt className="text-muted-foreground">Waiting</dt>
              <dd className="tabular-nums">{formatDuration(waiting)}</dd>
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
      <p className="text-muted-foreground">Click for details</p>
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
  data: { bar, statusLabel, statusStyle, ready, workspace, dimmed, waitingOn, notAdopted },
  selected,
  positionAbsoluteX,
}: NodeProps<BarNode>) {
  const { task, phases, blocks, pauses, resume, pending, lead, dueX, dueState } = bar;
  // How far the bar reaches left of the panel's edge; it changes, and re-renders the bar, only
  // while the bar starts off screen.
  const offScreen = useStore((state) => Math.max(0, pinnedLabelInset - positionAbsoluteX - state.transform[0]));
  const refs = (ids: TaskId[]) => ids.map((id) => `#${id}`).join(", ");
  const warnings = [
    notAdopted.length > 0 && `${refs(notAdopted)} not adopted`,
    waitingOn.length > 0 && `Waiting on ${refs(waitingOn)}`,
  ].filter((warning): warning is string => typeof warning === "string");
  const severe = notAdopted.length > 0;
  // Waiting alone is nothing to act on, so it stays neutral.
  const warningTone: Tone = severe ? "danger" : "neutral";
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
    // A label fits only on the work before a wait, so it does not run along the wait into the box after it.
    setLabelOutside(natural > (resume === null ? bar.width : (pauses.at(-1)?.x ?? resume.x)));
  }, [bar.width, resume, pauses, task.title, workspace, statusLabel]);
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
        {task.autopilot && <AutopilotIcon id={task.id} />}
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
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/**
 * Marks a task set for autopilot with the bot icon the timeline filter's Autopilot chip shows,
 * in that chip's `info` tone so it stands apart from the neutral and danger warning icons.
 */
function AutopilotIcon({ id }: { id: TaskId }) {
  return (
    <Bot
      role="img"
      aria-label={`#${id} is marked for autopilot`}
      className={cn("size-3.5 shrink-0", toneText.info)}
    >
      <title>Marked for autopilot</title>
    </Bot>
  );
}
