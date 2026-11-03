import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSwipeClose } from "@/lib/swipe-close";

/**
 * The frame of a task details sheet. From `md` up, a panel floating over the window's right side,
 * `width` wide. Below it, a bottom sheet sized to its content up to 90% of the screen, with a
 * grabber: dragging the grabber or the header down closes it.
 *
 * Opening it moves the focus to its heading, unless `takeFocus` is false; closing it returns
 * the focus to `returnFocus()`, or to what had it before, when the focus was in the sheet.
 * Escape is left to the caller, which knows what else Escape closes first.
 */
export function DetailsSheet({
  ref,
  width,
  takeFocus = true,
  returnFocus,
  onClose,
  banner,
  children,
}: {
  ref?: Ref<HTMLElement>;
  width: string;
  takeFocus?: boolean;
  returnFocus?: () => HTMLElement | null | undefined;
  onClose: () => void;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const sheet = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restore = useRef(returnFocus);
  restore.current = returnFocus;
  const drag = useSwipeClose(onClose);

  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = sheet.current;
    if (takeFocus) {
      heading.current?.focus({ preventScroll: true });
    }
    return () => {
      const active = document.activeElement;
      // Only take the focus back when closing the sheet lost it, not when it moved on elsewhere.
      if (active !== null && active !== document.body && !element?.contains(active)) {
        return;
      }
      const target = restore.current?.() ?? before;
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
      }
    };
  }, []);

  const dragHandlers = drag.handlers;

  return (
    <aside
      ref={(element) => {
        sheet.current = element;
        if (typeof ref === "function") {
          ref(element);
        } else if (ref) {
          ref.current = element;
        }
      }}
      aria-label="Task details"
      data-dragging={drag.dragging ? "" : undefined}
      className="fixed z-40 flex flex-col overflow-hidden border bg-card shadow-xl max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[90dvh] max-md:rounded-t-2xl max-md:border-b-0 max-md:pb-[env(safe-area-inset-bottom)] max-md:transition-transform max-md:data-dragging:transition-none motion-reduce:transition-none md:inset-y-4 md:right-4 md:w-(--sheet-width) md:rounded-xl"
      style={
        {
          "--sheet-width": width,
          transform: drag.offset === 0 ? undefined : `translateY(${drag.offset}px)`,
        } as CSSProperties
      }
    >
      <div className="flex shrink-0 justify-center pt-2 pb-1 md:hidden touch-none" {...dragHandlers}>
        <span data-grabber aria-hidden className="h-1 w-9 rounded-full bg-muted-foreground/40" />
      </div>
      <div
        className="flex shrink-0 items-center justify-between border-b px-4 py-2 max-md:touch-none max-md:pt-0"
        {...dragHandlers}
      >
        <h3 ref={heading} tabIndex={-1} className="text-xs font-medium text-muted-foreground outline-none">
          Task details
        </h3>
        <Button size="icon-xs" variant="ghost" aria-label="Close details" title="Close details (Esc)" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {banner}
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</ul>
    </aside>
  );
}
