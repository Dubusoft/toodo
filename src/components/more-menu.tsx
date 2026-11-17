import { useSyncExternalStore, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Ellipsis } from "lucide-react";
import { IconButton } from "@/components/button";
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
    <DropdownMenu
      alignment="end"
      renderTrigger={(trigger) => (
        <IconButton {...trigger} label={label} tooltip="More actions" size="sm" icon={<Ellipsis />} />
      )}
    >
      {actions.map((action) => (
        <DropdownMenuItem
          key={action.key}
          aria-label={action.ariaLabel}
          // Menu items take no title, so the explanation (such as why Start waits) is described instead.
          aria-description={action.title}
          icon={action.icon}
          label={action.label}
          isDisabled={action.disabled || (action.changesData && serverDown)}
          variant={action.destructive ? "destructive" : "default"}
          onClick={action.onSelect}
        />
      ))}
    </DropdownMenu>
  );
}
