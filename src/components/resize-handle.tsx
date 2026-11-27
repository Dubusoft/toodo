import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { savePanelSize, showPanelSize, type PanelSize } from "@/lib/panel-sizes";
import { cn } from "@/lib/utils";

const keyStep = 16;

type Axis = "width" | "height";

/**
 * A grip on a panel anchored at its right or bottom (its parent): along its left edge with `width`,
 * along its top edge with `height`, and at its top-left corner with both. From `lg` up dragging it,
 * or the arrow keys while it has the focus, resize the panel toward the window's left or top (the
 * corner both ways in one drag), and a double click brings back its default size. Each size is saved
 * under the name `width` or `height` gives, as the window clamps it (see `src/index.css`).
 */
export function ResizeHandle({
  width,
  height,
  label,
}: {
  width?: PanelSize;
  height?: PanelSize;
  label: string;
}) {
  const [shown, setShown] = useState<Partial<Record<Axis, number>>>({});
  const sizes = () => {
    const found: { axis: Axis; name: PanelSize }[] = [];
    if (width !== undefined) found.push({ axis: "width", name: width });
    if (height !== undefined) found.push({ axis: "height", name: height });
    return found;
  };
  const measure = (panel: Element, axis: Axis) => panel.getBoundingClientRect()[axis];
  const showMeasured = (panel: Element) =>
    setShown(Object.fromEntries(sizes().map(({ axis }) => [axis, Math.round(measure(panel, axis))])));
  // Shows `next` and keeps what the window's clamp leaves of it, so dragging back past a limit
  // starts moving the edge again at once.
  const resize = (panel: Element, axis: Axis, name: PanelSize, next: number) => {
    showPanelSize(name, next);
    const clamped = measure(panel, axis);
    if (clamped !== next) showPanelSize(name, clamped);
    setShown((before) => ({ ...before, [axis]: Math.round(clamped) }));
    return clamped;
  };
  const pointerAt = (axis: Axis, event: { clientX: number; clientY: number }) =>
    axis === "width" ? event.clientX : event.clientY;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = event.currentTarget.parentElement;
    if (panel === null) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const drags = sizes().map(({ axis, name }) => {
      const start = measure(panel, axis);
      return { axis, name, start, from: pointerAt(axis, event), current: start };
    });
    const onMove = (move: globalThis.PointerEvent) => {
      for (const drag of drags) {
        drag.current = resize(panel, drag.axis, drag.name, drag.start + drag.from - pointerAt(drag.axis, move));
      }
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      for (const drag of drags) if (drag.current !== drag.start) savePanelSize(drag.name, drag.current);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, [Axis, number]> = {
      ArrowLeft: ["width", keyStep],
      ArrowRight: ["width", -keyStep],
      ArrowUp: ["height", keyStep],
      ArrowDown: ["height", -keyStep],
    };
    const key = keys[event.key];
    const size = key === undefined ? undefined : sizes().find(({ axis }) => axis === key[0]);
    const panel = event.currentTarget.parentElement;
    if (key === undefined || size === undefined || panel === null) return;
    event.preventDefault();
    savePanelSize(size.name, resize(panel, size.axis, size.name, measure(panel, size.axis) + key[1]));
  };

  const edge = width === undefined ? "top" : height === undefined ? "left" : "top-left";
  return (
    <div
      role="separator"
      aria-orientation={edge === "left" ? "vertical" : edge === "top" ? "horizontal" : undefined}
      aria-label={label}
      aria-valuenow={edge === "top-left" ? undefined : shown[edge === "left" ? "width" : "height"]}
      aria-valuetext={
        edge === "top-left" && shown.width !== undefined && shown.height !== undefined
          ? `${shown.width} by ${shown.height} pixels`
          : undefined
      }
      tabIndex={0}
      data-resize-handle={edge}
      title={`${label} (double-click to reset)`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const panel = event.currentTarget.parentElement;
        if (panel !== null) showMeasured(panel);
      }}
      onDoubleClick={(event) => {
        for (const { name } of sizes()) savePanelSize(name, null);
        const panel = event.currentTarget.parentElement;
        if (panel !== null) showMeasured(panel);
      }}
      className={cn(
        "absolute hidden touch-none outline-none lg:block print:hidden",
        "after:absolute after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-100",
        edge === "left" && "inset-y-0 left-0 z-10 w-2 cursor-ew-resize after:inset-y-0 after:left-0 after:w-0.5 after:bg-primary",
        edge === "top" && "inset-x-0 top-0 z-10 h-2 cursor-ns-resize after:inset-x-0 after:top-0 after:h-0.5 after:bg-primary",
        // Above the two edges where they meet; it traces the panel's rounded corner.
        edge === "top-left" &&
          "top-0 left-0 z-20 size-4 cursor-nwse-resize after:top-0 after:left-0 after:size-4 after:rounded-tl-xl after:border-t-2 after:border-l-2 after:border-primary",
      )}
    />
  );
}
