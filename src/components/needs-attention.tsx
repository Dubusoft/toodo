import { BellRing } from "lucide-react";
import { needsAttention, type AttentionReason } from "@/lib/attention";
import type { TaskId } from "@/lib/bindings";
import { useTasks } from "@/lib/queries";
import { toneChip, toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

const reasonLabels: Record<AttentionReason, string> = {
  blocker_note: "Blocker",
  stalled: "Stalled",
};

const reasonStyles: Record<AttentionReason, string> = {
  blocker_note: toneChip.attention,
  stalled: toneChip.neutral,
};

/**
 * Tasks waiting on the user, gathered at the top of the sidebar so an alert leads straight to
 * its task. Hidden while nothing needs attention.
 */
export function NeedsAttention({ onShow }: { onShow: (id: TaskId) => void }) {
  const tasks = useTasks();
  const items = needsAttention(tasks.data ?? [], Date.now() / 1000);
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
        {items.map(({ task, reasons }) => (
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
          </li>
        ))}
      </ul>
    </section>
  );
}
