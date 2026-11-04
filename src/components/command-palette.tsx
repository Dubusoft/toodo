import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { keepFocusIn } from "@/lib/focus-trap";
import { shortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

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
 * A modal over the page: Escape and a click beside it close it, Tab stays inside, and closing
 * returns the focus to what had it before, unless something outside took the focus on purpose.
 */
function Overlay({ label, onClose, className, children }: { label: string; onClose: () => void; className?: string; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    return () => {
      const active = document.activeElement;
      if (active !== null && active !== document.body && !element?.contains(active)) return;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close.current();
      }
      if (event.key === "Tab") keepFocusIn(dialog.current, event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[min(15vh,8rem)] max-md:pt-[max(1rem,env(safe-area-inset-top))]">
      <div aria-hidden className="absolute inset-0 bg-black/40" onClick={() => onClose()} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal
        aria-label={label}
        className={cn(
          "relative flex max-h-[min(32rem,calc(100dvh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The command palette: a search field over a list of actions and tasks. Typing narrows the list,
 * the arrow keys move the highlight, and Enter or a click runs the highlighted entry and closes it.
 */
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const matched = matchCommands(commands, query);
  const index = Math.min(active, matched.length - 1);
  const optionId = (position: number) => `${listId}-${position}`;

  useEffect(() => {
    list.current?.querySelector(`[id="${optionId(index)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [index, query]);

  const run = (command: PaletteCommand | undefined) => {
    if (command === undefined) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const last = matched.length - 1;
    const next =
      event.key === "ArrowDown"
        ? Math.min(index + 1, last)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home" && event.ctrlKey
            ? 0
            : event.key === "End" && event.ctrlKey
              ? last
              : null;
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(matched[index]);
    }
  };

  const groups = (["Actions", "Tasks"] as const)
    .map((group) => ({ group, entries: matched.map((command, position) => ({ command, position })).filter(({ command }) => command.group === group) }))
    .filter(({ entries }) => entries.length > 0);

  return (
    <Overlay label="Command palette" onClose={onClose}>
      <div className="flex shrink-0 items-center gap-2 border-b px-3">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-label="Search actions and tasks"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={matched.length > 0 ? optionId(index) : undefined}
          placeholder="Jump to a task or run an action..."
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="rounded border px-1.5 text-[0.625rem] text-muted-foreground max-md:hidden">Esc</kbd>
      </div>
      <div ref={list} id={listId} role="listbox" aria-label="Actions and tasks" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {groups.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No actions or tasks match.</p>}
        {groups.map(({ group, entries }) => (
          <div key={group} role="group" aria-label={group} className="flex flex-col">
            <div aria-hidden className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
              {group}
            </div>
            {entries.map(({ command, position }) => (
              <div
                key={command.id}
                id={optionId(position)}
                role="option"
                aria-selected={position === index}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none max-md:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                  position === index && "bg-muted",
                )}
                onMouseMove={() => position !== index && setActive(position)}
                // Keeps the focus in the search field, so the keys keep working after a click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run(command)}
              >
                {command.icon}
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                {command.hint && <span className="shrink-0 text-xs text-muted-foreground">{command.hint}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Overlay>
  );
}

/** The list of keyboard shortcuts, opened with `?` or from the command palette. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => closeButton.current?.focus({ preventScroll: true }), []);
  return (
    <Overlay label="Keyboard shortcuts" onClose={onClose} className="max-w-md">
      <div className="flex shrink-0 items-center border-b px-4 py-2">
        <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
        <Button ref={closeButton} variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close shortcuts" title="Close (Esc)" onClick={onClose}>
          <X />
        </Button>
      </div>
      <dl className="flex min-h-0 flex-col gap-2 overflow-y-auto p-4 text-sm">
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
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">Letter shortcuts do nothing while you type in a field.</p>
    </Overlay>
  );
}
