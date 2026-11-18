import { useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button, IconButton } from "@/components/button";
import type { NewWorkspace, Workspace, WorkspaceId } from "@/lib/bindings";
import { useNarrow } from "@/lib/narrow";
import { useCreateWorkspace, useDeleteWorkspace, useWorkspaces } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { reachability, subscribeReachability, unreachableCause } from "@/web/connection";

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none max-md:h-11 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

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
          size="sm"
          variant="secondary"
          label="Add"
          icon={<Plus />}
          aria-label="Add workspace"
          tooltip="Add a workspace"
          aria-haspopup="dialog"
          aria-expanded={adding}
          onClick={(event) => {
            opener.current = event.currentTarget;
            setAdding(true);
          }}
        />
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
          <Button size="sm" variant="secondary" label="Retry now" onClick={() => void workspaces.refetch()} />
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
          <IconButton
            size="sm"
            variant="ghost"
            label={`Remove ${workspace.name}`}
            tooltip="Move the workspace and its tasks to the archive"
            icon={<X />}
            className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            onClick={() => {
              deleteWorkspace.reset();
              setConfirming(true);
            }}
          />
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
              size="sm"
              variant="destructive"
              label={deleteWorkspace.isPending ? "Removing..." : "Remove"}
              aria-label={`Confirm remove ${workspace.name}`}
              isDisabled={deleteWorkspace.isPending}
              onClick={() => deleteWorkspace.mutate(workspace.id)}
            />
            <Button size="sm" variant="ghost" label="Back" autoFocus onClick={() => setConfirming(false)} />
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
  const narrow = useNarrow();
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
    <Dialog
      isOpen
      onOpenChange={(open) => !open && close()}
      purpose="form"
      variant={narrow ? "fullscreen" : "standard"}
      width={576}
      maxHeight="min(40rem, calc(100dvh - 4rem))"
    >
      <DialogHeader title="New workspace" onOpenChange={busy ? undefined : (open) => !open && close()} />
      {/* Escape is handled here too, so it closes the dialog (unless busy) wherever the focus is in it. */}
      <form onSubmit={submit} onKeyDown={escapeCloses(onClose, busy)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain py-4">
          <TextInput label="Name" value={name} onChange={setName} hasAutoFocus />
          <TextArea label="Description" description="Optional, Markdown." rows={4} value={description} onChange={setDescription} />
          <TextInput
            label="Repository"
            description="Optional, e.g. owner/repo or a URL. Toodo only shows it."
            value={repository}
            onChange={setRepository}
          />
          {createWorkspace.isError && (
            <p role="alert" className="text-xs break-words text-destructive">
              {createWorkspace.error.message}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t pt-3">
          <Button variant="ghost" label="Cancel" isDisabled={busy} onClick={close} />
          <Button
            type="submit"
            variant="primary"
            className="ml-auto"
            changesData
            label={busy ? "Adding..." : "Add workspace"}
            isDisabled={busy || name.trim() === ""}
          />
        </div>
      </form>
    </Dialog>
  );
}
