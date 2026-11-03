import type { AgentStatus, TaskId } from "@/lib/bindings";
import { toneChip } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

const agentLabels: Record<AgentStatus, string> = {
  idle: "Agent idle",
  working: "Agent working",
  blocked: "Agent needs input",
  done: "Agent done",
};

const agentStyles: Record<AgentStatus, string> = {
  idle: toneChip.neutral,
  working: toneChip.info,
  blocked: toneChip.attention,
  done: toneChip.success,
};

/** The status herdr reports for the agent working on task `taskId`. */
export function AgentBadge({
  taskId,
  status,
  className,
}: {
  taskId: TaskId;
  status: AgentStatus;
  className?: string;
}) {
  return (
    <span
      aria-label={`Agent of #${taskId}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        agentStyles[status],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", status === "working" && "motion-safe:animate-pulse")} />
      {agentLabels[status]}
    </span>
  );
}
