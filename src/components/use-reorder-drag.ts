import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from "react";

/** How far a mouse moves with its button down before the press becomes a drag, in pixels. */
const MOUSE_SLOP = 4;
/** How long a finger or pen holds still on a row before it picks the row up, in milliseconds. */
const LONG_PRESS_MS = 450;
/** How far a finger may move during that hold and still pick the row up; further is a scroll. */
const TOUCH_SLOP = 8;
/** How close to the scrolling list's edge a dragged row scrolls it, and how fast per frame. */
const EDGE = 48;
const EDGE_STEP = 8;

/** The attribute that names a row of the list by its key. */
const ROW_KEY = "data-reorder-key";

type Press = {
  key: number;
  pointerId: number;
  touch: boolean;
  x: number;
  y: number;
  /** The scroll position when the drag started, and the row's height then. */
  scrollTop: number;
  height: number;
  /** Where in the row the pointer holds it, from the row's top. */
  grab: number;
  lastY: number;
  timer: number | undefined;
  /** Whether the press became a drag, and where the row would land then (as `target`). */
  active: boolean;
  to: number | null;
};

export type ReorderDrag = {
  /** The row being dragged, until it is dropped. */
  dragging: number | null;
  /** Where the dragged row would land, as its index after the move; `null` when that is its own place. */
  target: number | null;
  /** How far the dragged row is moved from its place, in pixels, so it follows the pointer. */
  offset: number;
  /** The props of a row's draggable part: pointer, keyboard, and click handling. */
  handleProps: (key: number) => HTMLAttributes<HTMLElement>;
  /** The props of a row's element, which the drop line and the row's motion use. */
  rowProps: (key: number) => Record<string, string>;
};

/** The element that scrolls `element`, or `null` when the page does. */
function scroller(element: HTMLElement | null): HTMLElement | null {
  for (let at = element?.parentElement ?? null; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === "auto" || overflowY === "scroll") && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

/**
 * Lets the rows of a list be put in another order. A mouse drags a row once it moves a few
 * pixels with its button down; a finger or pen holds still on a row for a moment, then drags it,
 * so a flick still scrolls and a tap still opens the row. The dragged row follows the pointer,
 * the rows it would land between show a line, and the list scrolls near its edges. Alt with the
 * up or down arrow moves a focused row a place. Each finished move calls `onMove` with the row's
 * key and its index after the move; a press that moves nothing calls nothing.
 */
export function useReorderDrag({
  keys,
  onMove,
}: {
  keys: readonly number[];
  onMove: (key: number, to: number) => void;
}): ReorderDrag & { listRef: (list: HTMLElement | null) => void } {
  const list = useRef<HTMLElement | null>(null);
  const press = useRef<Press | null>(null);
  // A drag ends in a click on the row it started on, which must not open it.
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const latest = useRef({ keys, onMove });
  latest.current = { keys, onMove };

  const rows = () =>
    Array.from(list.current?.querySelectorAll<HTMLElement>(`[${ROW_KEY}]`) ?? []).filter(
      (row) => row.parentElement === list.current,
    );

  /** Moves the dragged row under the pointer at `y` and finds where it would land. */
  const follow = (y: number) => {
    const current = press.current;
    if (current === null) return;
    current.lastY = y;
    const scrolled = (scroller(list.current)?.scrollTop ?? 0) - current.scrollTop;
    setOffset(y - current.y + scrolled);
    // The dragged row's middle, against the middles of the rows that stay.
    const middle = y - current.grab + current.height / 2;
    const others = rows().filter((row) => row.getAttribute(ROW_KEY) !== String(current.key));
    const to = others.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top + rect.height / 2 < middle;
    }).length;
    current.to = to === latest.current.keys.indexOf(current.key) ? null : to;
    setTarget(current.to);
  };

  const start = () => {
    const current = press.current;
    if (current === null) return;
    const row = rows().find((candidate) => candidate.getAttribute(ROW_KEY) === String(current.key));
    const rect = row?.getBoundingClientRect();
    current.scrollTop = scroller(list.current)?.scrollTop ?? 0;
    current.height = rect?.height ?? 0;
    current.grab = current.y - (rect?.top ?? current.y);
    current.active = true;
    swallowClick.current = true;
    if (current.touch) navigator.vibrate?.(10);
    setDragging(current.key);
    setTarget(null);
    setOffset(0);
  };

  const finish = (drop: boolean) => {
    const current = press.current;
    press.current = null;
    if (current === null) return;
    window.clearTimeout(current.timer);
    if (drop && current.active && current.to !== null) latest.current.onMove(current.key, current.to);
    setDragging(null);
    setTarget(null);
    setOffset(0);
  };

  // While a row is held or dragged: follow the pointer across the page, keep a finger's moves
  // from scrolling once it holds a row, and scroll the list near its edges.
  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const current = press.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      if (current.active) {
        follow(event.clientY);
        return;
      }
      const moved = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (current.touch && moved > TOUCH_SLOP) finish(false);
      else if (!current.touch && moved > MOUSE_SLOP) start();
    };
    const onPointerUp = (event: globalThis.PointerEvent) => {
      if (press.current?.pointerId === event.pointerId) finish(true);
    };
    const onPointerCancel = (event: globalThis.PointerEvent) => {
      if (press.current?.pointerId === event.pointerId) finish(false);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (press.current?.active === true && event.cancelable) event.preventDefault();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && press.current !== null) finish(false);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("keydown", onKey);
    let frame = 0;
    if (dragging !== null) {
      const scroll = () => {
        const area = scroller(list.current);
        const current = press.current;
        if (area !== null && current !== null) {
          const { top, bottom } = area.getBoundingClientRect();
          const step = current.lastY < top + EDGE ? -EDGE_STEP : current.lastY > bottom - EDGE ? EDGE_STEP : 0;
          if (step !== 0) {
            area.scrollTop += step;
            follow(current.lastY);
          }
        }
        frame = requestAnimationFrame(scroll);
      };
      frame = requestAnimationFrame(scroll);
    }
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
    };
  });

  useEffect(() => () => window.clearTimeout(press.current?.timer), []);

  const handleProps = (key: number): HTMLAttributes<HTMLElement> => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      swallowClick.current = false;
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      const touch = event.pointerType !== "mouse";
      press.current = {
        key,
        pointerId: event.pointerId,
        touch,
        x: event.clientX,
        y: event.clientY,
        scrollTop: 0,
        height: 0,
        grab: 0,
        lastY: event.clientY,
        timer: touch ? window.setTimeout(start, LONG_PRESS_MS) : undefined,
        active: false,
        to: null,
      };
    },
    // A held finger would otherwise open the browser's menu or select the row's text.
    onContextMenu: (event) => {
      if (press.current !== null) event.preventDefault();
    },
    onClickCapture: (event) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      const from = latest.current.keys.indexOf(key);
      const to = from + (event.key === "ArrowUp" ? -1 : 1);
      event.preventDefault();
      if (from < 0 || to < 0 || to >= latest.current.keys.length) return;
      latest.current.onMove(key, to);
    },
  });

  // The line goes above the row the dragged one would land before, or below the last row when
  // it would land at the end.
  const others = keys.filter((key) => key !== dragging);
  const rowProps = (key: number): Record<string, string> => {
    const props: Record<string, string> = { [ROW_KEY]: String(key) };
    if (key === dragging) props["data-dragging"] = "";
    if (target !== null) {
      if (others[target] === key) props["data-drop"] = "before";
      else if (target === others.length && others[others.length - 1] === key) props["data-drop"] = "after";
    }
    return props;
  };

  return {
    listRef: (element) => {
      list.current = element;
    },
    dragging,
    target,
    offset,
    handleProps,
    rowProps,
  };
}
