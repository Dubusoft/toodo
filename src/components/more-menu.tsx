import { useSyncExternalStore, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Ellipsis } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { reachability, subscribeReachability } from "@/web/connection";

/** An action offered as a button, or as an item of a "More" menu. */
export type Action = {
  key: string;
  label: string;
  /** The accessible name, naming the task it acts on. */
  ariaLabel: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  /** Destroys data, such as deleting a task; drawn in the destructive style. */
  destructive?: boolean;
  /** Extra classes of the action drawn as a button, such as the colour of the status it leads to. */
  className?: string;
  /** Changes data, so it waits while the web app cannot reach the server (see `Button`). */
  changesData?: boolean;
};

/** A "More" (`...`) button opening a menu of secondary actions, in the order given. */
export function MoreMenu({ label, actions }: { label: string; actions: Action[] }) {
  const state = useSyncExternalStore(subscribeReachability, reachability);
  const serverDown = state === "unreachable" || state === "retrying";
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} title="More actions" className={buttonVariants({ variant: "outline", size: "icon-xs" })}>
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup
            aria-label={label}
            // An action that opens a form focuses its first field; closing the menu leaves the focus there.
            finalFocus={() => !(document.activeElement instanceof HTMLElement && document.activeElement.matches("input, textarea, select"))}
            className="flex min-w-44 flex-col rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none"
          >
            {actions.map((action) => (
              <Menu.Item
                key={action.key}
                aria-label={action.ariaLabel}
                title={action.title}
                disabled={action.disabled || (action.changesData && serverDown)}
                onClick={action.onSelect}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted max-md:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0",
                  action.destructive
                    ? "text-destructive data-[highlighted]:bg-destructive/10 dark:data-[highlighted]:bg-destructive/20"
                    : "[&_svg]:text-muted-foreground",
                )}
              >
                {action.icon}
                {action.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
