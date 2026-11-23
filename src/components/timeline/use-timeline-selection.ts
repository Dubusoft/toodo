import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import type { Node as FlowNode, NodeChange } from "@xyflow/react";
import type { Task, TaskId } from "@/lib/bindings";
import type { TimelineBar } from "@/lib/task-graph";
import { singleKeyShortcut } from "@/lib/shortcuts";
import type { HoverCard } from "@/components/timeline/use-hover-card";

/** Keys that move the selection between timeline rows, and where each one goes. */
const rowKeys: Record<string, RowMove> = {
  ArrowUp: "previous",
  ArrowDown: "next",
  Home: "first",
  End: "last",
};

/** The letter shortcuts that move the selection, also when the focus is not on a bar. */
const letterKeys: Record<string, RowMove> = { j: "next", k: "previous" };

type RowMove = "previous" | "next" | "first" | "last";

/** Whether Escape pressed on `target` belongs to a form field rather than to the timeline. */
function isField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [role='combobox'], [contenteditable='true']") !== null
  );
}

function barOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest<HTMLElement>(".react-flow__node") : null;
}

/**
 * The task selected on the timeline, whose details sheet is open: changed by clicks, the row
 * keys, and Escape, and held back while the sheet has an edit form with unsaved changes.
 */
export function useTimelineSelection({
  selectedTask,
  onSelectedTaskChange,
  bars,
  panel,
  reveal,
  bar,
  hoverCard,
  clearSelectedEdges,
}: {
  /** The selected task, when it is on the timeline. */
  selectedTask: Task | undefined;
  onSelectedTaskChange: (id: TaskId | null) => void;
  bars: TimelineBar[];
  /** The timeline panel; row keys pressed outside it keep their usual meaning. */
  panel: { readonly current: HTMLElement | null };
  reveal: (id: TaskId, behindSheet: boolean) => void;
  /** The element of a task's bar, which the row keys move the focus to. */
  bar: (id: TaskId) => HTMLElement | null;
  hoverCard: HoverCard;
  clearSelectedEdges: () => void;
}) {
  const sheet = useRef<HTMLElement>(null);
  // False while the arrow keys move the selection, so the details sheet they open leaves the
  // focus on the bars for the next key.
  const focusSheet = useRef(true);
  // A selection change held back because the details sheet has unsaved edits: the task to
  // select next, or `null` to close the sheet.
  const [discarding, setDiscarding] = useState<{ next: TaskId | null } | null>(null);

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
      hoverCard.hide();
      return;
    }
    applySelection(next);
  }

  function applySelection(next: TaskId | null) {
    setDiscarding(null);
    if (next === null) {
      focusSheet.current = true;
      onSelectedTaskChange(null);
      return;
    }
    onSelectedTaskChange(next);
    clearSelectedEdges();
    hoverCard.hide();
    reveal(next, true);
  }

  /** Selects and focuses the bar `move` leads to from the bar of task `from`; false when there is none. */
  function moveRow(move: RowMove, from: string | undefined): boolean {
    const rows = [...bars].sort((a, b) => a.row - b.row);
    const current = rows.findIndex((candidate) => String(candidate.task.id) === from);
    const index = {
      previous: current <= 0 ? 0 : current - 1,
      next: current === -1 ? 0 : Math.min(current + 1, rows.length - 1),
      first: 0,
      last: rows.length - 1,
    }[move];
    const id = rows[index]?.task.id;
    if (id === undefined) {
      return false;
    }
    bar(id)?.focus({ preventScroll: true });
    focusSheet.current = false;
    changeSelection(id);
    return true;
  }

  // Escape closes the hover card, then the details sheet, wherever the focus is, except in a
  // form field or a form that handled it already, such as an edit form discarding its changes.
  const closeOnEscape = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    if (hoverCard.hovered !== null) {
      hoverCard.hide();
    } else if (discarding !== null) {
      setDiscarding(null);
    } else if (!isField(event.target)) {
      changeSelection(null);
    }
  });
  const escapable = hoverCard.hovered !== null || selectedTask !== undefined;
  useEffect(() => {
    if (!escapable) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => closeOnEscape(event);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [escapable]);

  // j and k move the selection from anywhere on the page, starting at the first row.
  const moveOnLetter = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const move = letterKeys[event.key];
    const from = barOf(event.target)?.dataset.id ?? (selectedTask && String(selectedTask.id));
    if (move !== undefined && singleKeyShortcut(event) && moveRow(move, from)) {
      event.preventDefault();
    }
  });
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => moveOnLetter(event);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return {
    sheet,
    /** Whether the details sheet takes the focus when it opens. */
    sheetTakesFocus: focusSheet.current,
    discarding,
    changeSelection,
    keepEditing: () => setDiscarding(null),
    /** Drops the unsaved changes and makes the selection change that waited for them. */
    discardChanges() {
      if (discarding !== null) {
        applySelection(discarding.next);
      }
    },
    /** Moves the selection, and the keyboard focus, to the row above or below, or to the first or last row. */
    moveSelection(event: KeyboardEvent) {
      const move = rowKeys[event.key];
      // Keys typed into the details sheet, or anywhere outside the bars, keep their usual meaning.
      const node = barOf(event.target);
      const inside = event.target instanceof Node && panel.current?.contains(event.target);
      if (move === undefined || !inside || (node === null && selectedTask === undefined)) {
        return;
      }
      if (moveRow(move, node?.dataset.id ?? String(selectedTask?.id))) {
        event.preventDefault();
      }
    },
    /** Follows a bar picked or let go in React Flow. */
    changeNodes(changes: NodeChange<FlowNode>[]) {
      const picked = changes.filter((change) => change.type === "select" && change.selected).pop();
      if (picked !== undefined && picked.type === "select") {
        changeSelection(Number(picked.id));
      } else if (
        changes.some((change) => change.type === "select" && !change.selected && Number(change.id) === selectedTask?.id)
      ) {
        changeSelection(null);
      }
    },
  };
}
