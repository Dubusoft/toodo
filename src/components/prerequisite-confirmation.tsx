import { useMessages } from "@/lib/i18n";
import { Pause } from "lucide-react";
import { Button } from "@/components/button";
import { escapeCloses } from "@/components/workspace-list";
import type { TaskId } from "@/lib/bindings";
import { tonePanel } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

/** Asks before adding a prerequisite that pauses the started task `taskId`. */
export function PrerequisiteConfirmation({
  taskId,
  prerequisite,
  pending,
  onConfirm,
  onCancel,
}: {
  taskId: TaskId;
  /** How the prerequisite is shown, e.g. "#3". */
  prerequisite: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  return (
    <div
      role="group"
      aria-label={m.tasks.confirmPrerequisite(taskId)}
      className={cn("flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-xs", tonePanel.attention)}
      onKeyDown={escapeCloses(onCancel, pending)}
    >
      {/* The buttons move below the hint before it gets too narrow to read. */}
      <span className="min-w-0 flex-1 basis-56">
        {m.tasks.confirmPrerequisiteHint(taskId, prerequisite)}
      </span>
      <Button
        size="sm"
        variant="destructive"
        icon={<Pause />}
        label={pending ? m.tasks.pausing : m.tasks.pauseAndAdd}
        isDisabled={pending}
        onClick={onConfirm}
      />
      <Button size="sm" variant="ghost" label={m.tasks.back} autoFocus isDisabled={pending} onClick={onCancel} />
    </div>
  );
}
