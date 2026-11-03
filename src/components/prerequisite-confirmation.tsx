import { Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { escapeCloses } from "@/components/workspace-list";
import type { TaskId } from "@/lib/bindings";
import { tonePanel } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

/**
 * Asks before adding a prerequisite that pauses the started task `taskId`: pausing closes its
 * herdr workspace, which stops its agent whatever state it is in.
 */
export function PrerequisiteConfirmation({
  taskId,
  prerequisite,
  pending,
  onConfirm,
  onCancel,
}: {
  taskId: TaskId;
  /** How the prerequisite is shown, e.g. "#3" or "herdr #3". */
  prerequisite: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={`Confirm prerequisite of #${taskId}`}
      className={cn("flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-xs", tonePanel.attention)}
      onKeyDown={escapeCloses(onCancel, pending)}
    >
      <span className="min-w-0 flex-1">
        Adding {prerequisite} as a prerequisite pauses #{taskId} and closes its herdr workspace, which stops its
        agent; the worktree is kept.
      </span>
      <Button size="xs" variant="destructive" disabled={pending} onClick={onConfirm}>
        <Pause />
        {pending ? "Pausing..." : "Pause and add"}
      </Button>
      <Button size="xs" variant="ghost" autoFocus disabled={pending} onClick={onCancel}>
        Back
      </Button>
    </div>
  );
}
