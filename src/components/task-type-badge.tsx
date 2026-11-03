import type { TaskType } from "@/lib/bindings";
import { typeChip } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

/** The type of a task: an outlined, neutral chip, unlike the coloured status pills. */
export function TaskTypeBadge({ type, className }: { type: TaskType; className?: string }) {
  return (
    <span
      data-task-type={type}
      className={cn("shrink-0 rounded-md border px-1.5 font-mono text-xs", typeChip, className)}
    >
      {type}
    </span>
  );
}
