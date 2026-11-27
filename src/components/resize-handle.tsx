import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { savePanelSize, showPanelSize, type PanelSize } from "@/lib/panel-sizes";
import { cn } from "@/lib/utils";

const keyStep = 16;

/**
 * A grip along the left or top edge of a panel anchored at its right or bottom (its parent): from
 * `lg` up dragging it, or the arrow keys while it has the focus, resize the panel toward the window's
 * left or top, and a double click brings back its default size. The size is saved under `size()`,
 * read as the resizing starts, as the window clamps it (see `src/index.css`).
 */
export function ResizeHandle({
  edge,
  size,
  label,
}: {
  edge: "left" | "top";
  size: () => PanelSize;
  label: string;
}) {
  const [shown, setShown] = useState<number>();
  const measure = (panel: Element) => {
    const rect = panel.getBoundingClientRect();
    return edge === "left" ? rect.width : rect.height;
  };
  // Shows `next` and keeps what the window's clamp leaves of it, so dragging back past a limit
  // starts moving the edge again at once.
  const resize = (panel: Element, name: PanelSize, next: number) => {
    showPanelSize(name, next);
    const clamped = measure(panel);
    if (clamped !== next) showPanelSize(name, clamped);
    setShown(Math.round(clamped));
    return clamped;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = event.currentTarget.parentElement;
    if (panel === null) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const name = size();
    const start = measure(panel);
    const from = edge === "left" ? event.clientX : event.clientY;
    let current = start;
    const onMove = (move: globalThis.PointerEvent) => {
      current = resize(panel, name, start + from - (edge === "left" ? move.clientX : move.clientY));
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (current !== start) savePanelSize(name, current);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = edge === "left" ? "ArrowLeft" : "ArrowUp";
    const shrink = edge === "left" ? "ArrowRight" : "ArrowDown";
    if (event.key !== grow && event.key !== shrink) return;
    const panel = event.currentTarget.parentElement;
    if (panel === null) return;
    event.preventDefault();
    const name = size();
    savePanelSize(name, resize(panel, name, measure(panel) + (event.key === grow ? keyStep : -keyStep)));
  };

  return (
    <div
      role="separator"
      aria-orientation={edge === "left" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={shown}
      tabIndex={0}
      data-resize-handle={edge}
      title={`${label} (double-click to reset)`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const panel = event.currentTarget.parentElement;
        if (panel !== null) setShown(Math.round(measure(panel)));
      }}
      onDoubleClick={(event) => {
        savePanelSize(size(), null);
        const panel = event.currentTarget.parentElement;
        if (panel !== null) setShown(Math.round(measure(panel)));
      }}
      className={cn(
        "absolute z-10 hidden touch-none outline-none lg:block print:hidden",
        "after:absolute after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-100",
        edge === "left"
          ? "inset-y-0 left-0 w-2 cursor-ew-resize after:inset-y-0 after:left-0 after:w-0.5"
          : "inset-x-0 top-0 h-2 cursor-ns-resize after:inset-x-0 after:top-0 after:h-0.5",
      )}
    />
  );
}
