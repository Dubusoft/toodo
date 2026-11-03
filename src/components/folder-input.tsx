import { useEffect, useState, type KeyboardEvent } from "react";
import type { Machine } from "@/lib/bindings";
import { useDirectories } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Wait after the last keystroke before listing a folder, so typing does not send a request per key. */
const listDelayMs = 200;

/** Whether `path` is a Windows drive or UNC path, as listed on a Windows host. */
function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\");
}

/** `name` inside the folder `base`, with the separator of the path's kind. */
export function joinPath(base: string, name: string): string {
  const separator = isWindowsPath(base) ? "\\" : "/";
  return /[\\/]$/.test(base) ? `${base}${name}` : `${base}${separator}${name}`;
}

/** `path` without trailing separators, except for a root such as `/` or `C:\`. */
export function withoutTrailingSeparator(path: string): string {
  return path.replace(/(?<=[^\\/:])[\\/]+$/, "");
}

/** `value` after it has stopped changing for `delayMs`. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

type FolderInputProps = {
  id: string;
  /** An SSH machine, or `local` for the server. */
  machine: Machine;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
};

/**
 * A folder path input that suggests the subfolders of the folder typed so far on `machine`,
 * filtered by the name typed after the last separator. Arrow keys move through the
 * suggestions; Enter, Tab, or a click fills one in with a trailing separator, so its own
 * subfolders show next.
 */
export function FolderInput({ id, machine, value, onChange, describedBy, required, autoFocus, className }: FolderInputProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const separatorAt = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const parent = separatorAt < 0 ? null : value.slice(0, separatorAt + 1);
  const prefix = value.slice(separatorAt + 1).toLowerCase();
  const settledParent = useSettled(parent, listDelayMs);
  const listing = useDirectories(machine, open ? settledParent : null);
  const current = open && parent !== null && settledParent === parent;
  const suggestions =
    current && listing.data ? listing.data.directories.filter((name) => name.toLowerCase().startsWith(prefix)) : [];
  const shown = suggestions.length > 0;
  const listId = `${id}-folders`;
  const machineName = machine.kind === "local" ? "the server" : machine.label;

  function change(next: string) {
    onChange(next);
    setActive(-1);
    setOpen(true);
  }

  function pick(name: string) {
    if (parent === null) return;
    change(`${joinPath(parent, name)}${isWindowsPath(parent) ? "\\" : "/"}`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!shown) {
        setOpen(true);
        return;
      }
      const count = suggestions.length;
      const down = event.key === "ArrowDown";
      setActive((index) => (index < 0 ? (down ? 0 : count - 1) : (index + (down ? 1 : count - 1)) % count));
    } else if (event.key === "Enter") {
      // Enter submits the form unless a suggestion is highlighted.
      if (!shown || active < 0) return;
      event.preventDefault();
      pick(suggestions[active]);
    } else if (event.key === "Tab") {
      // Tab moves on to the next field unless a suggestion is highlighted or a name is being typed.
      if (!shown || event.shiftKey || (active < 0 && prefix === "")) return;
      event.preventDefault();
      event.stopPropagation();
      pick(suggestions[Math.max(active, 0)]);
    } else if (event.key === "Escape") {
      if (!shown) return;
      // Closes the suggestions, not the dialog around the input.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        id={id}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        className={className}
        value={value}
        onChange={(e) => change(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        required={required}
        autoFocus={autoFocus}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`Folders in ${parent}`}
          className="absolute top-full right-0 left-0 z-10 mt-1 flex max-h-56 flex-col overflow-y-auto rounded-lg border bg-popover p-1 font-mono text-xs text-popover-foreground shadow-md"
        >
          {suggestions.map((name, index) => (
            <li
              key={name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // Keeps focus in the input, so the next level of folders can be typed or picked.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(name)}
              className={cn(
                "cursor-pointer truncate rounded px-1.5 py-1 hover:bg-muted max-md:py-2",
                index === active && "bg-secondary hover:bg-secondary",
              )}
            >
              {name}
              {isWindowsPath(parent ?? "") ? "\\" : "/"}
            </li>
          ))}
        </ul>
      )}
      {current && listing.isError && (
        <p role="status" className="mt-1 text-xs break-words text-muted-foreground">
          No suggestions: {listing.error.message}. Type the path of a folder that exists on {machineName}, ending in a
          separator, to see its subfolders.
        </p>
      )}
    </div>
  );
}
