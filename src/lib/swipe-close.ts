import { useEffect, useState, type PointerEvent } from "react";

/** How far a sheet must be dragged down, in pixels, to close when let go. */
const swipeCloseDistance = 80;
/** Below Tailwind's `md` breakpoint, where sheets are phone sheets. */
export const phoneQuery = "(max-width: 47.99rem)";

/**
 * Dragging a phone sheet down by its grabber or header: `offset` is how far it is dragged,
 * for a `translateY`, and letting go far enough down calls `onClose`. Does nothing from `md` up.
 * Spread `handlers` on the elements that drag the sheet; a press on a button inside them is
 * left to the button.
 */
export function useSwipeClose(onClose: () => void) {
  const [drag, setDrag] = useState<{ pointer: number; startY: number; offset: number } | null>(null);

  useEffect(() => {
    if (drag === null) {
      return;
    }
    // A sheet dragged off the phone layout, say by rotating the device, snaps back.
    const media = window.matchMedia?.(phoneQuery);
    const cancel = () => setDrag(null);
    media?.addEventListener("change", cancel);
    return () => media?.removeEventListener("change", cancel);
  }, [drag !== null]);

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (!window.matchMedia?.(phoneQuery).matches || event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ pointer: event.pointerId, startY: event.clientY, offset: 0 });
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    if (drag?.pointer === event.pointerId) {
      setDrag({ ...drag, offset: Math.max(0, event.clientY - drag.startY) });
    }
  }

  function endDrag(event: PointerEvent<HTMLElement>) {
    if (drag?.pointer !== event.pointerId) {
      return;
    }
    setDrag(null);
    if (event.type === "pointerup" && event.clientY - drag.startY >= swipeCloseDistance) {
      onClose();
    }
  }

  return {
    dragging: drag !== null,
    offset: drag?.offset ?? 0,
    handlers: {
      onPointerDown: startDrag,
      onPointerMove: moveDrag,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
