import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  CommandPalette as AstryxCommandPalette,
  CommandPaletteInput,
  useCommandPaletteContext,
} from "@astryxdesign/core/CommandPalette";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead";
import { shortcuts } from "@/lib/shortcuts";

/** An entry of the command palette: an action, or a task to jump to. */
export type PaletteCommand = {
  id: string;
  group: "Actions" | "Tasks";
  label: string;
  /** Words matched besides the label, such as a task's workspace. */
  keywords?: string;
  /** Shown at the right, such as the shortcut of the action or the workspace of a task. */
  hint?: string;
  icon?: ReactNode;
  run: () => void;
};

/** Commands whose label and keywords hold every word of `query`, in any order. */
function matchCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  return commands.filter((command) => {
    const text = `${command.label} ${command.keywords ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * A modal over the page: Escape closes it, and closing returns the focus to what had it
 * before, unless something outside took the focus on purpose.
 */
function useModal(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const active = document.activeElement;
      if (active !== null && active !== document.body && !active.closest("dialog")) return;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** Astryx groups the results by `auxiliaryData.group`. */
type PaletteItem = SearchableItem<PaletteCommand> & { auxiliaryData: PaletteCommand };

/** Highlights the first match whenever the matches change, so Enter runs it right away. */
function HighlightFirstMatch() {
  const palette = useCommandPaletteContext();
  const first = palette?.selectableItems[0]?.value;
  useEffect(() => {
    if (palette !== null && first !== undefined && palette.highlightedIndex === -1) palette.setHighlightedIndex(0);
  }, [palette?.searchResults, first]);
  return null;
}

/**
 * The command palette: a search field over a list of actions and tasks. Typing narrows the list
 * and highlights the first match, the arrow keys move the highlight, and Enter or a click runs
 * the highlighted entry and closes it.
 */
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  useModal(onClose);
  const items = commands.map((command): PaletteItem => ({ id: command.id, label: command.label, auxiliaryData: command }));
  const byId = new Map(items.map((item) => [item.id, item.auxiliaryData]));
  const source: SearchSource<PaletteItem> = {
    search: (query) => {
      const matched = new Set(matchCommands(commands, query));
      return items.filter((item) => matched.has(item.auxiliaryData));
    },
    bootstrap: () => items,
  };

  const run = (id: string) => {
    const command = byId.get(id);
    if (command === undefined) return;
    onClose();
    command.run();
  };

  return (
    <AstryxCommandPalette<PaletteItem>
      isOpen
      onOpenChange={(open) => !open && onClose()}
      label="Command palette"
      searchSource={source}
      onValueChange={run}
      emptySearchText="No actions or tasks match."
      input={
        <>
          <CommandPaletteInput label="Search actions and tasks" placeholder="Jump to a task or run an action..." />
          <HighlightFirstMatch />
        </>
      }
      renderItem={({ auxiliaryData: command }) => (
        <span className="flex min-w-0 flex-1 items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
          {command.icon}
          <span className="min-w-0 flex-1 truncate">{command.label}</span>
          {command.hint && <span className="shrink-0 text-xs text-muted-foreground">{command.hint}</span>}
        </span>
      )}
    />
  );
}

/** The list of keyboard shortcuts, opened with `?` or from the command palette. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useModal(onClose);
  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} width={448}>
      <DialogHeader title="Keyboard shortcuts" onOpenChange={(open) => !open && onClose()} />
      <dl className="flex min-h-0 flex-col gap-2 overflow-y-auto py-4 text-sm">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.description} className="flex items-baseline gap-3">
            <dt className="flex w-32 shrink-0 flex-wrap gap-1">
              {shortcut.keys.map((key) => (
                <kbd key={key} className="rounded border bg-muted px-1.5 font-mono text-xs">
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="text-muted-foreground">{shortcut.description}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t pt-2 text-xs text-muted-foreground">Letter shortcuts do nothing while you type in a field.</p>
    </Dialog>
  );
}
