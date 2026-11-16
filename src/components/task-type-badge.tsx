import { Badge } from "@astryxdesign/core/Badge";
import type { TaskType } from "@/lib/bindings";
import { cn } from "@/lib/utils";

/** The type of a task: a neutral category tag, unlike the coloured status pills. */
export function TaskTypeBadge({ type, className }: { type: TaskType; className?: string }) {
  return <Badge data-task-type={type} label={type} className={cn("shrink-0 font-mono", className)} />;
}
