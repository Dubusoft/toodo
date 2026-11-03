import { BellRing, Crosshair } from "lucide-react";
import { Button } from "@/components/ui/button";
import { needsAttention, type AttentionReason } from "@/lib/attention";
import type { TaskId } from "@/lib/bindings";
import {
  useAgentStatuses,
  useFocusAgentPane,
  useHerdrStatus,
  usePullRequestStatuses,
  useTasks,
} from "@/lib/queries";
import { toneChip, toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

const reasonLabels: Record<AttentionReason, string> = {
  agent_blocked: "Agent needs input",
  blocker_note: "Blocker",
  ci_failed: "CI failed",
  changes_requested: "Changes requested",
};

const reasonStyles: Record<AttentionReason, string> = {
  agent_blocked: toneChip.attention,
  blocker_note: toneChip.attention,
  ci_failed: toneChip.danger,
  changes_requested: toneChip.attention,
};

/**
 * Tasks waiting on the user, gathered at the top of the sidebar so an alert leads straight to
 * its task. Hidden while nothing needs attention.
 */
export function NeedsAttention({ onShow }: { onShow: (id: TaskId) => void }) {
  const tasks = useTasks();
  const agentStatuses = useAgentStatuses();
  const pullRequestStatuses = usePullRequestStatuses();
  const herdr = useHerdrStatus();
  const focusAgent = useFocusAgentPane();
  const items = needsAttention(tasks.data ?? [], agentStatuses.data ?? [], pullRequestStatuses.data ?? []);
  if (items.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="attention-heading" className="flex flex-col gap-1">
      <h2
        id="attention-heading"
        className={cn("flex items-center gap-1.5 px-1 text-xs font-medium uppercase", toneText.attention)}
      >
        <BellRing aria-hidden className="size-3.5" />
        Needs attention
        <span className={cn("ml-auto rounded-full px-1.5 tabular-nums", toneChip.attention)}>
          {items.length}
        </span>
      </h2>
      <ul aria-label="Tasks needing attention" className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
        {items.map(({ task, reasons, agentStatus }) => (
          <li key={task.id} className="flex items-start gap-0.5 rounded-md hover:bg-sidebar-accent">
            <button
              type="button"
              title="Show on the timeline"
              className="flex min-w-0 flex-1 flex-col gap-1 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => onShow(task.id)}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <span className="tabular-nums text-muted-foreground">#{task.id}</span>
                <span className="truncate font-medium">{task.title}</span>
              </span>
              <span className="flex flex-wrap gap-1">
                {reasons.map((reason) => (
                  <span
                    key={reason}
                    data-reason={reason}
                    className={cn("rounded-full px-1.5 text-[11px] font-medium leading-4", reasonStyles[reason])}
                  >
                    {reasonLabels[reason]}
                  </span>
                ))}
              </span>
            </button>
            {agentStatus !== null && task.herdrWorkspaceId !== null && (
              <Button
                size="icon-xs"
                variant="ghost"
                className="mt-0.5"
                aria-label={`Focus agent pane of #${task.id}`}
                title="Focus agent pane"
                disabled={herdr.data?.running !== true || focusAgent.isPending}
                onClick={() => focusAgent.mutate(task.id)}
              >
                <Crosshair />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {focusAgent.error && (
        <p role="alert" className="px-1 text-xs text-destructive">
          {focusAgent.error.message}
        </p>
      )}
    </section>
  );
}
