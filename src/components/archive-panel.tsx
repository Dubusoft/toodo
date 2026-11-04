import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { TaskId, WorkspaceId } from "@/lib/bindings";
import { useArchive, usePurgeTask, usePurgeWorkspace, useRestoreTask, useRestoreWorkspace } from "@/lib/queries";

type Purge = { kind: "workspace"; id: WorkspaceId; name: string } | { kind: "task"; id: TaskId; name: string };

export function ArchivePanel() {
  const archive = useArchive();
  const restoreWorkspace = useRestoreWorkspace();
  const restoreTask = useRestoreTask();
  const purgeWorkspace = usePurgeWorkspace();
  const purgeTask = usePurgeTask();
  const [confirming, setConfirming] = useState<Purge | null>(null);

  const busy = restoreWorkspace.isPending || restoreTask.isPending || purgeWorkspace.isPending || purgeTask.isPending;
  const error = restoreWorkspace.error ?? restoreTask.error ?? purgeWorkspace.error ?? purgeTask.error ?? archive.error;
  const reset = () => {
    for (const mutation of [restoreWorkspace, restoreTask, purgeWorkspace, purgeTask]) mutation.reset();
  };

  function purge(item: Purge) {
    const options = { onSuccess: () => setConfirming(null) };
    if (item.kind === "workspace") purgeWorkspace.mutate(item.id, options);
    else purgeTask.mutate(item.id, options);
  }

  const workspaces = archive.data?.workspaces ?? [];
  const tasks = archive.data?.tasks ?? [];

  return (
    <section aria-label="Archive" className="flex flex-col gap-3 text-xs">
      <p className="text-muted-foreground">
        Deleted workspaces and tasks are kept here with their history and still count in reviews. Restore one to
        bring it back, or delete it permanently.
      </p>
      {confirming && (
        <div
          role="alertdialog"
          aria-label="Confirm permanent delete"
          className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2"
        >
          <p className="break-words">
            Permanently delete <span className="font-medium">{confirming.name}</span>
            {confirming.kind === "workspace" ? " and its tasks" : ""}? Its history, commits, and links are removed
            and leave the reviews; this cannot be undone.
          </p>
          <div className="flex gap-1">
            <Button changesData size="xs" variant="destructive" onClick={() => purge(confirming)} disabled={busy}>
              {purgeWorkspace.isPending || purgeTask.isPending ? "Deleting..." : "Delete permanently"}
            </Button>
            <Button size="xs" variant="ghost" autoFocus onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error.message}
        </p>
      )}
      <ArchiveList label="Archived workspaces" empty="No archived workspaces.">
        {workspaces.map((workspace) => (
          <ArchiveItem
            key={workspace.id}
            name={workspace.name}
            detail={workspace.location.path}
            busy={busy}
            onRestore={() => {
              reset();
              restoreWorkspace.mutate(workspace.id);
            }}
            onPurge={() => {
              reset();
              setConfirming({ kind: "workspace", id: workspace.id, name: workspace.name });
            }}
          />
        ))}
      </ArchiveList>
      <ArchiveList label="Archived tasks" empty="No archived tasks.">
        {tasks.map((task) => (
          <ArchiveItem
            key={task.id}
            name={`#${task.id} ${task.title}`}
            detail={task.status.replace("_", " ")}
            busy={busy}
            onRestore={() => {
              reset();
              restoreTask.mutate(task.id);
            }}
            onPurge={() => {
              reset();
              setConfirming({ kind: "task", id: task.id, name: `#${task.id} ${task.title}` });
            }}
          />
        ))}
      </ArchiveList>
    </section>
  );
}

function ArchiveList({ label, empty, children }: { label: string; empty: string; children: ReactNode[] }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="font-medium">{label}</h4>
      <ul aria-label={label} className="flex flex-col divide-y">
        {children.length === 0 && <li className="text-muted-foreground">{empty}</li>}
        {children}
      </ul>
    </div>
  );
}

function ArchiveItem({
  name,
  detail,
  busy,
  onRestore,
  onPurge,
}: {
  name: string;
  detail: string;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 first:pt-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-muted-foreground">{detail}</span>
      </span>
      <span className="flex gap-1">
        <Button changesData size="xs" variant="outline" aria-label={`Restore ${name}`} disabled={busy} onClick={onRestore}>
          Restore
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="hover:text-destructive"
          aria-label={`Delete ${name} permanently`}
          disabled={busy}
          onClick={onPurge}
        >
          Delete permanently
        </Button>
      </span>
    </li>
  );
}
