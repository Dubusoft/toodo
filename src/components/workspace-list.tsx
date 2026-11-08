import { useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NewWorkspace, Workspace, WorkspaceId } from "@/lib/bindings";
import { keepFocusIn } from "@/lib/focus-trap";
import { useCreateWorkspace, useDeleteWorkspace, useWorkspaces } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { reachability, subscribeReachability, unreachableCause } from "@/web/connection";

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none max-md:h-11 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** A small select for toolbars and inline pickers. */
export const compactSelectClass =
  "h-6 rounded-md border border-input bg-background px-1.5 text-xs outline-none max-md:h-11 max-md:px-2.5 max-md:text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

/** A field with a visible label above it and optional help text below. */
function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children({ id, describedBy: help ? helpId : undefined })}
      {help && (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}

type WorkspaceListProps = {
  selectedId: WorkspaceId | null;
  onSelect: (id: WorkspaceId) => void;
};

export function WorkspaceList({ selectedId, onSelect }: WorkspaceListProps) {
  const workspaces = useWorkspaces();
  const reach = useSyncExternalStore(subscribeReachability, reachability);
  const serverDown = reach === "unreachable" || reach === "retrying";
  const [adding, setAdding] = useState(false);
  // The new workspace dialog gives the focus back to the button that opened it.
  const opener = useRef<HTMLElement | null>(null);
  const stopAdding = () => {
    setAdding(false);
    opener.current?.focus();
  };

  return (
    <section aria-labelledby="workspaces-heading" className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <h2 id="workspaces-heading" className="min-w-0 flex-1 text-xs font-medium uppercase text-muted-foreground">
          Workspaces
        </h2>
        <Button
          size="xs"
          variant="outline"
          aria-label="Add workspace"
          title="Add a workspace"
          aria-haspopup="dialog"
          aria-expanded={adding}
          onClick={(event) => {
            opener.current = event.currentTarget;
            setAdding(true);
          }}
        >
          <Plus />
          Add
        </Button>
      </div>
      {workspaces.isPending && !serverDown && (
        <p className="text-sm text-muted-foreground">Loading workspaces...</p>
      )}
      {(workspaces.isError || (workspaces.isPending && serverDown)) && (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
          <p>
            Failed to load workspaces:{" "}
            {workspaces.error?.message ?? (unreachableCause() || "The Toodo server does not answer.")}
          </p>
          <Button size="xs" variant="outline" onClick={() => void workspaces.refetch()}>
            Retry now
          </Button>
        </div>
      )}
      {workspaces.data?.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">No workspaces yet.</p>
      )}
      {workspaces.data && workspaces.data.length > 0 && (
        <ul className="flex flex-col gap-1">
          {workspaces.data.map((workspace) => (
            <WorkspaceItem
              key={workspace.id}
              workspace={workspace}
              selected={workspace.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {adding && (
        <NewWorkspaceDialog
          onCreated={(workspace) => {
            stopAdding();
            onSelect(workspace.id);
          }}
          onClose={stopAdding}
        />
      )}
    </section>
  );
}

type WorkspaceItemProps = {
  workspace: Workspace;
  selected: boolean;
  onSelect: (id: WorkspaceId) => void;
};

/** A workspace in the list; removing it asks for confirmation first. */
function WorkspaceItem({ workspace, selected, onSelect }: WorkspaceItemProps) {
  const deleteWorkspace = useDeleteWorkspace();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-col gap-1">
      <div
        className={cn(
          "group flex items-center rounded-lg hover:bg-sidebar-accent",
          selected && "bg-sidebar-accent",
        )}
      >
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelect(workspace.id)}
          className="flex min-w-0 flex-1 flex-col px-2.5 py-1.5 text-left"
        >
          <span className="truncate text-sm font-medium">{workspace.name}</span>
          {workspace.repository && (
            <span className="truncate text-xs text-muted-foreground" title={workspace.repository}>
              {workspace.repository}
            </span>
          )}
        </button>
        {!confirming && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${workspace.name}`}
            title="Move the workspace and its tasks to the archive"
            className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            onClick={() => {
              deleteWorkspace.reset();
              setConfirming(true);
            }}
          >
            <X />
          </Button>
        )}
      </div>
      {confirming && (
        <div
          role="group"
          aria-label={`Remove ${workspace.name}`}
          className="flex flex-col gap-1.5 rounded-lg border p-2"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !deleteWorkspace.isPending) {
              event.preventDefault();
              setConfirming(false);
            }
          }}
        >
          <p className="text-xs text-muted-foreground">
            Remove {workspace.name} and its tasks from Toodo? They move to Settings &gt; Archive, where they can be
            restored.
          </p>
          {deleteWorkspace.isError && (
            <p role="alert" className="text-xs text-destructive">
              {deleteWorkspace.error.message}
            </p>
          )}
          <div className="flex gap-1">
            <Button
              changesData
              size="xs"
              variant="destructive"
              aria-label={`Confirm remove ${workspace.name}`}
              disabled={deleteWorkspace.isPending}
              onClick={() => deleteWorkspace.mutate(workspace.id)}
            >
              {deleteWorkspace.isPending ? "Removing..." : "Remove"}
            </Button>
            <Button size="xs" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Calls `close` when Escape is pressed inside an inline form, unless it is busy. */
export function escapeCloses(close: () => void, busy = false) {
  return (event: KeyboardEvent) => {
    if (event.key === "Escape" && !busy && !event.defaultPrevented) {
      event.preventDefault();
      close();
    }
  };
}

type NewWorkspaceDialogProps = {
  onCreated: (workspace: Workspace) => void;
  onClose: () => void;
};

/** Adds a workspace: a name, an optional Markdown description, and an optional repository reference. */
export function NewWorkspaceDialog({ onCreated, onClose }: NewWorkspaceDialogProps) {
  const createWorkspace = useCreateWorkspace();
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repository, setRepository] = useState("");
  const busy = createWorkspace.isPending;

  function close() {
    if (!busy) onClose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const workspace: NewWorkspace = {
      name: name.trim(),
      description: description.trim() || null,
      repository: repository.trim() || null,
    };
    createWorkspace.mutate(workspace, { onSuccess: onCreated });
  }

  return (
    <div className="fixed inset-0 z-50">
      <div aria-hidden className="absolute inset-0 bg-black/40 max-md:hidden" onClick={close} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Tab") keepFocusIn(dialog.current, event.nativeEvent);
          else escapeCloses(onClose, busy)(event);
        }}
        className={cn(
          "relative flex flex-col overflow-hidden bg-background text-foreground",
          "max-md:h-full max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]",
          "md:absolute md:top-1/2 md:left-1/2 md:max-h-[min(40rem,calc(100dvh-4rem))] md:w-[min(36rem,calc(100vw-4rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:shadow-xl",
        )}
      >
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2 md:px-6 md:pt-4">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold">
              New workspace
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close new workspace"
              title="Close (Esc)"
              disabled={busy}
              onClick={close}
            >
              <X />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain border-t px-4 py-4 md:px-6">
            <Field label="Name">
              {({ id }) => (
                <input
                  id={id}
                  className={inputClass}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                />
              )}
            </Field>
            <Field label="Description" help="Optional, Markdown.">
              {({ id, describedBy }) => (
                <textarea
                  id={id}
                  className={cn(inputClass, "h-24 py-1.5 max-md:h-32")}
                  aria-describedby={describedBy}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </Field>
            <Field label="Repository" help="Optional, e.g. owner/repo or a URL. Toodo only shows it.">
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className={inputClass}
                  aria-describedby={describedBy}
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                />
              )}
            </Field>
            {createWorkspace.isError && (
              <p role="alert" className="text-xs break-words text-destructive">
                {createWorkspace.error.message}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t px-4 py-3 md:px-6">
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" className="ml-auto" changesData disabled={busy || name.trim() === ""}>
              {busy ? "Adding..." : "Add workspace"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
