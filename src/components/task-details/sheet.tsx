import { useMessages } from "@/lib/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/button";
import { DetailsSheet } from "@/components/details-sheet";
import { openMenuButton } from "@/lib/shortcuts";

/**
 * The details sheet of the task list, like the timeline's. Escape, the close button, or a swipe
 * down closes it, after asking when an edit form in it has unsaved changes.
 */
export function TaskDetailsSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const m = useMessages();
  const sheet = useRef<HTMLElement>(null);
  const [discarding, setDiscarding] = useState(false);

  function close() {
    if (sheet.current?.querySelector("form[data-dirty]")) {
      setDiscarding(true);
    } else {
      onClose();
    }
  }

  useEffect(() => {
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(openMenuButton)) {
        return;
      }
      if (discarding) {
        setDiscarding(false);
      } else if (!(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [role=combobox], [role=listbox]"))) {
        close();
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  });

  return (
    <DetailsSheet
      ref={sheet}
      width="min(480px, max(360px, 40vw), calc(100vw - 32px))"
      onClose={close}
      banner={
        discarding && (
          <div
            role="group"
            aria-label={m.details.actions.unsaved}
            className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-xs"
          >
            <span className="min-w-0 flex-1">{m.details.actions.discardQuestion}</span>
            <Button size="sm" variant="secondary" label={m.details.actions.keepEditing} autoFocus onClick={() => setDiscarding(false)} />
            <Button size="sm" variant="destructive" label={m.details.actions.discardChanges} onClick={onClose} />
          </div>
        )
      }
    >
      {children}
    </DetailsSheet>
  );
}
