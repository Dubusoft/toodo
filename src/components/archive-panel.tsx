import { useState, type ReactNode } from "react";
import { fill, useMessages } from "@/lib/i18n";
import { Button } from "@/components/button";
import type { TaskId, WorkspaceId } from "@/lib/bindings";
import { useArchive, usePurgeTask, usePurgeWorkspace, useRestoreTask, useRestoreWorkspace } from "@/lib/queries";

type Purge = { kind: "workspace"; id: WorkspaceId; name: string } | { kind: "task"; id: TaskId; name: string };

export function ArchivePanel() {
  const m = useMessages();
  const t = m.settings.archivePanel;
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
    <section aria-label={m.settings.sections.trash} className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        {t.intro}
      </p>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={t.confirm}
          className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2"
        >
          <p className="break-words">
            {fill(confirming.kind === "workspace" ? t.confirmWorkspace : t.confirmTask, {
              name: <span className="font-medium">{confirming.name}</span>,
            })}
          </p>
          <div className="flex gap-1">
            <Button
              changesData
              size="sm"
              variant="destructive"
              label={purgeWorkspace.isPending || purgeTask.isPending ? t.deleting : t.deletePermanent}
              onClick={() => purge(confirming)}
              isDisabled={busy}
            />
            <Button size="sm" variant="ghost" label={m.common.cancel} autoFocus onClick={() => setConfirming(null)} isDisabled={busy} />
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error.message}
        </p>
      )}
      <ArchiveList label={t.workspaces} empty={t.emptyWorkspaces}>
        {workspaces.map((workspace) => (
          <ArchiveItem
            key={workspace.id}
            name={workspace.name}
            detail={workspace.repository ?? ""}
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
      <ArchiveList label={t.tasks} empty={t.emptyTasks}>
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
  const m = useMessages();
  const t = m.settings.archivePanel;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 first:pt-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-muted-foreground">{detail}</span>
      </span>
      <span className="flex gap-1">
        <Button changesData size="sm" variant="secondary" label={t.restoreItem(name)} isDisabled={busy} onClick={onRestore}>
          {t.restore}
        </Button>
        <Button size="sm" variant="ghost" label={t.deleteItem(name)} isDisabled={busy} onClick={onPurge}>
          {t.deletePermanent}
        </Button>
      </span>
    </li>
  );
}
