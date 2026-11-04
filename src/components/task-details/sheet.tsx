import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DetailsSheet } from "@/components/details-sheet";


/**
 * The details sheet of the task list, like the timeline's. Escape, the close button, or a swipe
 * down closes it, after asking when an edit form in it has unsaved changes.
 */
export function TaskDetailsSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
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
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("[role=menu]")) {
        return;
      }
      if (discarding) {
        setDiscarding(false);
      } else if (!(event.target instanceof HTMLElement && event.target.closest("input, textarea, select"))) {
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
            aria-label="Unsaved changes"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-xs"
          >
            <span className="min-w-0 flex-1">Discard your unsaved changes?</span>
            <Button size="xs" variant="outline" autoFocus onClick={() => setDiscarding(false)}>
              Keep editing
            </Button>
            <Button size="xs" variant="destructive" onClick={onClose}>
              Discard changes
            </Button>
          </div>
        )
      }
    >
      {children}
    </DetailsSheet>
  );
}
