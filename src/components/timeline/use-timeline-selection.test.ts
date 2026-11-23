import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskId } from "@/lib/bindings";
import type { TimelineBar } from "@/lib/task-graph";
import { useTimelineSelection } from "@/components/timeline/use-timeline-selection";

const task = (id: TaskId) => ({ id }) as Task;
const bars = [1, 2, 3].map((id, row) => ({ task: task(id), row }) as TimelineBar);

function setup(selected: TaskId | null, { dirty = false } = {}) {
  const onSelectedTaskChange = vi.fn();
  const reveal = vi.fn();
  const clearSelectedEdges = vi.fn();
  const hoverCard = { hovered: null, show: vi.fn(), keep: vi.fn(), hideSoon: vi.fn(), hide: vi.fn() };
  const props = {
    selectedTask: selected === null ? undefined : task(selected),
    onSelectedTaskChange,
    bars,
    panel: { current: document.createElement("div") },
    reveal,
    bar: () => null,
    hoverCard,
    clearSelectedEdges,
  };
  const hook = renderHook((current: typeof props) => useTimelineSelection(current), { initialProps: props });
  const sheet = document.createElement("aside");
  sheet.innerHTML = dirty ? "<form data-dirty></form>" : "";
  hook.result.current.sheet.current = sheet;
  return { ...hook, props, onSelectedTaskChange, reveal, clearSelectedEdges, hoverCard };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useTimelineSelection", () => {
  it("holds a selection change back while the sheet has unsaved edits, and makes it once they are discarded", () => {
    const { result, onSelectedTaskChange, reveal, clearSelectedEdges, hoverCard } = setup(1, { dirty: true });

    act(() => result.current.changeSelection(2));
    expect(onSelectedTaskChange).not.toHaveBeenCalled();
    expect(result.current.discarding).toEqual({ next: 2 });
    expect(hoverCard.hide).toHaveBeenCalled();

    act(() => result.current.discardChanges());
    expect(onSelectedTaskChange).toHaveBeenCalledWith(2);
    expect(clearSelectedEdges).toHaveBeenCalled();
    expect(reveal).toHaveBeenCalledWith(2, true);
    expect(result.current.discarding).toBeNull();
  });

  it("keeps the sheet open when the user keeps editing or presses Escape on the question", () => {
    const { result, onSelectedTaskChange } = setup(1, { dirty: true });

    act(() => result.current.changeSelection(null));
    expect(result.current.discarding).toEqual({ next: null });
    act(() => result.current.keepEditing());
    expect(result.current.discarding).toBeNull();

    act(() => result.current.changeSelection(3));
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(result.current.discarding).toBeNull();
    expect(onSelectedTaskChange).not.toHaveBeenCalled();
  });

  it("changes the selection at once without unsaved edits, and reveals the selected bar when it is picked again", () => {
    const { result, onSelectedTaskChange, reveal } = setup(1);

    act(() => result.current.changeSelection(1));
    expect(onSelectedTaskChange).not.toHaveBeenCalled();
    expect(reveal).toHaveBeenCalledWith(1, true);

    act(() => result.current.changeSelection(2));
    expect(onSelectedTaskChange).toHaveBeenCalledWith(2);

    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(onSelectedTaskChange).toHaveBeenLastCalledWith(null);
  });

  it("moves the selection one row down with j", () => {
    const { onSelectedTaskChange } = setup(1);

    act(() => {
      fireEvent.keyDown(document.body, { key: "j" });
    });
    expect(onSelectedTaskChange).toHaveBeenCalledWith(2);
  });

  it("listens to the document's keys once rather than again on every render", () => {
    const listen = vi.spyOn(document, "addEventListener");
    const { rerender, props } = setup(1);
    const attached = listen.mock.calls.filter(([type]) => type === "keydown").length;

    for (let render = 0; render < 3; render += 1) {
      rerender({ ...props });
    }
    expect(listen.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(attached);
  });
});
