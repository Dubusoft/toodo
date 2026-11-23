import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import type { TaskId, Timestamp } from "@/lib/bindings";
import { openingViewport, pixelsPerDay, type TimelineBar, type TimelineLayout } from "@/lib/task-graph";
import { panDuration, rowHeight, rowsTop, sheetMargin, sheetWidthIn } from "@/components/timeline/geometry";

/**
 * The part of the timeline on screen: where it opens, where the buttons and a selection pan it
 * to, how far it may pan, and how it follows the rows when they change.
 */
export function useTimelineViewport<N extends Node>({
  layout,
  chart,
  onNearPast,
}: {
  layout: TimelineLayout;
  /** Identifies the chart drawn, its scale and period; a new chart opens on its own. */
  chart: string;
  onNearPast?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<N> | null>(null);
  // A task selected before the timeline was ready, revealed once it is.
  const pendingReveal = useRef<TaskId | null>(null);
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
  // The rows change when a filter changes, when older tasks asked for with `onNearPast` come in,
  // or when a task is added, finished, or removed. Older tasks move the start of the axis
  // earlier, every bar right with it, and take rows above the ones shown, being older work. The
  // view moves along at once, before the next paint: it keeps showing the same days, and the
  // task at its top, or the first one below it that is still shown, stays there. It never stays
  // below the last row, which React Flow would correct only on the next pan.
  const shownLayout = useRef<{ chart: string; start: Timestamp; rows: TaskId[] } | null>(null);
  const lastViewportY = useRef(0);
  useLayoutEffect(() => {
    const previous = shownLayout.current;
    const rows: TaskId[] = [];
    for (const bar of layout.bars) rows[bar.row] = bar.task.id;
    shownLayout.current = { chart, start: layout.start, rows };
    const instance = flow.current;
    const panel = container.current;
    // A new chart, or one that had no rows, opens on its own in `showLatest`.
    if (previous === null || previous.chart !== chart || previous.rows.length === 0) return;
    if (instance === null || panel === null) return;
    const unchanged =
      previous.start === layout.start &&
      previous.rows.length === rows.length &&
      previous.rows.every((id, row) => rows[row] === id);
    if (unchanged) return;
    const { x, y, zoom } = instance.getViewport();
    const shift = ((previous.start - layout.start) / (24 * 60 * 60)) * pixelsPerDay[layout.scale];
    const rowOf = new Map(rows.map((id, row) => [id, row]));
    const topRow = Math.min(Math.max(Math.floor(-y / rowHeight), 0), previous.rows.length - 1);
    let drop = 0;
    for (let row = topRow; row < previous.rows.length; row += 1) {
      const moved = rowOf.get(previous.rows[row]);
      if (moved !== undefined) {
        drop = (moved - row) * rowHeight;
        break;
      }
    }
    const lowest = Math.min(0, panel.clientHeight - height - 8);
    const nextY = Math.min(0, Math.max(lowest, y - drop));
    if (shift !== 0 || nextY !== y) {
      void instance.setViewport({ x: x - shift, y: nextY, zoom });
    }
  }, [chart, layout]);

  /**
   * Asks for older tasks once the view is within a screen of the earliest bar, or of the top row
   * while it moves up: older work runs left and on top.
   */
  function nearPast(viewport: { x: number; y: number }) {
    const movedUp = viewport.y > lastViewportY.current;
    lastViewportY.current = viewport.y;
    const panel = container.current;
    if (onNearPast === undefined || layout.bars.length === 0 || panel === null) return;
    const earliest = Math.min(...layout.bars.map((bar) => bar.x));
    if (-viewport.x < earliest + panel.clientWidth || (movedUp && -viewport.y < panel.clientHeight)) onNearPast();
  }

  // At the top row the view cannot move up any further, so scrolling up there asks by itself.
  function scrollUpAtTop(event: WheelEvent) {
    const panel = container.current;
    if (onNearPast === undefined || event.deltaY >= 0 || flow.current === null || panel === null) return;
    if (-flow.current.getViewport().y < panel.clientHeight) onNearPast();
  }

  function opening() {
    return openingViewport(layout, { visible: container.current?.clientWidth ?? 0 });
  }

  function showLatest(instance: ReactFlowInstance<N>) {
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
      { duration: panDuration() },
    );
  }

  /** Pans back to where the timeline opens: the Now line and the first rows. */
  function showToday() {
    void flow.current?.setViewport(opening(), { duration: panDuration() });
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
      void instance.setViewport({ x: x - shift, y: nextY, zoom }, { duration: panDuration() });
    }
  }

  return {
    container,
    /** Rows can be panned vertically only as far as they go; never into empty space. */
    translateExtent: [
      [-Infinity, 0],
      [Infinity, Math.max(height + 8, panelHeight)],
    ] as [[number, number], [number, number]],
    showLatest,
    nearPast,
    scrollUpAtTop,
    showEarliest,
    showToday,
    reveal,
    /** Reveals the bar of `id` once the timeline is ready, when it is not yet. */
    revealOnInit(id: TaskId) {
      if (flow.current === null) {
        pendingReveal.current = id;
      }
    },
    bar: (id: TaskId) => container.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`) ?? null,
  };
}

export type TimelineViewport = ReturnType<typeof useTimelineViewport>;
