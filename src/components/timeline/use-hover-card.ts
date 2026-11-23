import { useEffect, useRef, useState } from "react";
import type { TaskId } from "@/lib/bindings";

/** How long the hover card stays after the pointer leaves its bar, so the pointer can reach the card. */
const graceMs = 200;

export type HoverCard = {
  /** The bar under the pointer, with its place on screen for the card. */
  hovered: { id: TaskId; rect: DOMRect } | null;
  show: (id: TaskId, rect: DOMRect) => void;
  /** Keeps the card while the pointer moves from the bar onto it. */
  keep: () => void;
  /** Hides the card once the grace period passes without `keep`. */
  hideSoon: () => void;
  hide: () => void;
};

/** The hover card of a timeline bar. */
export function useHoverCard(): HoverCard {
  const [hovered, setHovered] = useState<HoverCard["hovered"]>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function keep() {
    clearTimeout(timer.current);
  }
  return {
    hovered,
    show(id, rect) {
      keep();
      setHovered({ id, rect });
    },
    keep,
    hideSoon() {
      keep();
      timer.current = setTimeout(() => setHovered(null), graceMs);
    },
    hide: () => setHovered(null),
  };
}
