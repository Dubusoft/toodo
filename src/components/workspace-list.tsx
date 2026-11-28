import { useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button, IconButton } from "@/components/button";
import { MachineSelector, MachineTree } from "@/components/machine-tree";
import type { NewWorkspace, Workspace, WorkspaceId } from "@/lib/bindings";
import { errorMessage } from "@/lib/error-messages";
import { useMessages } from "@/lib/i18n";
import { useNarrow } from "@/lib/narrow";
import { useCreateWorkspace, useDeleteWorkspace, useWorkspaces } from "@/lib/queries";
import type { SupervisorLane } from "@/lib/supervisor-status";
import { cn } from "@/lib/utils";
import { reachability, subscribeReachability, unreachableCause } from "@/web/connection";

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none max-md:h-11 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type WorkspaceListProps = {
  selectedId: WorkspaceId | null;
  onSelect: (id: WorkspaceId) => void;
  /** Shows a lane, from the machine tree. */
  onShowLane: (lane: SupervisorLane) => void;
};

/** The workspaces, each under the machines whose lanes work in it (see `MachineTree`). */
export function WorkspaceList({ selectedId, onSelect, onShowLane }: WorkspaceListProps) {
  const m = useMessages();
  const copy = m.app.workspace;
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
          {copy.title}
        </h2>
        <Button
          size="sm"
          variant="secondary"
          label={m.app.add}
          icon={<Plus />}
          aria-label={copy.add}
          tooltip={copy.addTooltip}
          aria-haspopup="dialog"
          aria-expanded={adding}
          onClick={(event) => {
            opener.current = event.currentTarget;
            setAdding(true);
          }}
        />
      </div>
      {workspaces.isPending && !serverDown && (
        <p className="text-sm text-muted-foreground">{copy.loading}</p>
      )}
      {(workspaces.isError || (workspaces.isPending && serverDown)) && (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
          <p className="break-words-keep">
            {copy.loadFailed(workspaces.error ? errorMessage(workspaces.error, m) : unreachableCause(m) || copy.noReply)}
          </p>
          <Button size="sm" variant="secondary" label={m.app.retryNow} onClick={() => void workspaces.refetch()} />
        </div>
      )}
      {workspaces.data?.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">{copy.empty}</p>
      )}
      {workspaces.data && (
        <MachineTree
          workspaces={workspaces.data}
          onShowLane={onShowLane}
          renderWorkspace={(workspace, lanes) => (
            <WorkspaceItem workspace={workspace} selected={workspace.id === selectedId} onSelect={onSelect}>
              {lanes}
            </WorkspaceItem>
          )}
        />
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
  /** The workspace's lanes, shown under it. */
  children?: ReactNode;
};

/** A workspace in the list; removing it asks for confirmation first. */
function WorkspaceItem({ workspace, selected, onSelect, children }: WorkspaceItemProps) {
  const m = useMessages();
  const copy = m.app.workspace;
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
          <span className="truncate text-sm font-medium" title={workspace.name}>
            {workspace.name}
          </span>
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
            label={copy.removeName(workspace.name)}
            tooltip={copy.archiveTooltip}
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
          aria-label={copy.removeName(workspace.name)}
          className="flex flex-col gap-1.5 rounded-lg border p-2"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !deleteWorkspace.isPending) {
              event.preventDefault();
              setConfirming(false);
            }
          }}
        >
          <p className="break-words-keep text-xs text-muted-foreground">
            {copy.removeQuestion(workspace.name)}
          </p>
          {deleteWorkspace.isError && (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage(deleteWorkspace.error, m)}
            </p>
          )}
          <div className="flex gap-1">
            <Button
              changesData
              size="sm"
              variant="destructive"
              label={deleteWorkspace.isPending ? copy.removing : copy.remove}
              aria-label={copy.confirmRemove(workspace.name)}
              isDisabled={deleteWorkspace.isPending}
              onClick={() => deleteWorkspace.mutate(workspace.id)}
            />
            <Button size="sm" variant="ghost" label={m.app.back} autoFocus onClick={() => setConfirming(false)} />
          </div>
        </div>
      )}
      {children}
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

/**
 * Adds a workspace: a name, an optional Markdown description, an optional repository reference,
 * and the machine it lives on, if any.
 */
export function NewWorkspaceDialog({ onCreated, onClose }: NewWorkspaceDialogProps) {
  const m = useMessages();
  const copy = m.app.workspace;
  const createWorkspace = useCreateWorkspace();
  const narrow = useNarrow();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repository, setRepository] = useState("");
  const [machine, setMachine] = useState<string | null>(null);
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
      machine,
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
      <DialogHeader title={copy.newWorkspace} onOpenChange={busy ? undefined : (open) => !open && close()} />
      {/* Escape is handled here too, so it closes the dialog (unless busy) wherever the focus is in it. */}
      <form onSubmit={submit} onKeyDown={escapeCloses(onClose, busy)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain py-4">
          <TextInput label={copy.name} value={name} onChange={setName} hasAutoFocus />
          <TextArea label={copy.description} description={copy.descriptionHint} rows={4} value={description} onChange={setDescription} />
          <TextInput
            label={copy.repository}
            description={copy.repositoryHint}
            value={repository}
            onChange={setRepository}
          />
          <MachineSelector value={machine} onChange={setMachine} />
          {createWorkspace.isError && (
            <p role="alert" className="text-xs break-words text-destructive">
              {errorMessage(createWorkspace.error, m)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t pt-3">
          <Button variant="ghost" label={m.common.cancel} isDisabled={busy} onClick={close} />
          <Button
            type="submit"
            variant="primary"
            className="ml-auto"
            changesData
            label={busy ? copy.adding : copy.add}
            isDisabled={busy || name.trim() === ""}
          />
        </div>
      </form>
    </Dialog>
  );
}
