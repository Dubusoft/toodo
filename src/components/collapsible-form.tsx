import { useEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useNarrow } from "@/lib/narrow";
import { cn } from "@/lib/utils";

/**
 * A create form that rests as one line and opens to the full form when anything in it takes
 * focus or input; on a phone it opens as a sheet over the page. Escape, the close button, or a
 * click elsewhere closes it again. Closing only hides fields: what was typed is kept.
 */
export function CollapsibleForm({
  label,
  expanded,
  onExpandedChange,
  onSubmit,
  children,
}: {
  label: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  // Focus handed back to the one-line form on closing must not open it again.
  const refocusing = useRef(false);
  const narrow = useNarrow();
  const sheet = expanded && narrow;

  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !form.current?.contains(event.target)) onExpandedChange(false);
    };
    document.addEventListener("click", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("click", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [expanded]);

  const open = () => {
    if (refocusing.current) refocusing.current = false;
    else if (!expanded) onExpandedChange(true);
  };

  function close() {
    onExpandedChange(false);
    const field = form.current?.querySelector<HTMLElement>("input");
    if (field && field !== document.activeElement) {
      refocusing.current = true;
      field.focus();
    }
  }

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || !expanded || event.defaultPrevented) return;
    event.preventDefault();
    onExpandedChange(false);
  }

  return (
    <>
      {sheet && <div aria-hidden className="fixed inset-0 z-40 bg-black/40" />}
      <div
        role={sheet ? "dialog" : undefined}
        aria-modal={sheet || undefined}
        aria-label={sheet ? label : undefined}
        className={cn(
          sheet &&
            "fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto rounded-t-xl bg-card pb-[env(safe-area-inset-bottom)] shadow-xl",
        )}
      >
        <form
          ref={form}
          aria-label={label}
          data-expanded={expanded || undefined}
          onSubmit={onSubmit}
          onFocus={open}
          onInput={open}
          onKeyDown={closeOnEscape}
          className={cn("flex flex-col gap-2 rounded-xl border bg-card p-3 shadow-xs", sheet && "border-0 shadow-none")}
        >
          {expanded && (
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 flex-1 text-sm font-medium">{label}</h3>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Close ${label}`} title="Close (Esc)" onClick={close}>
                <X />
              </Button>
            </div>
          )}
          {children}
        </form>
      </div>
    </>
  );
}
