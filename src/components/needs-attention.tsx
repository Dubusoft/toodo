import { BellRing } from "lucide-react";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { DecisionMark } from "@/components/chat-panel";
import { needsAttention, type AttentionReason } from "@/lib/attention";
import type { TaskId } from "@/lib/bindings";
import { useChatThreads, useTasks } from "@/lib/queries";
import { toneChip, toneText } from "@/lib/status-styles";
import { waitingThreads } from "@/lib/task-chats";
import { cn } from "@/lib/utils";
import type { ChatTarget } from "@/web/push";

const reasonLabels: Record<AttentionReason, string> = {
  blocker_note: "Blocker",
  stalled: "Stalled",
};

const reasonVariants: Record<AttentionReason, BadgeVariant> = {
  blocker_note: "warning",
  stalled: "neutral",
};

const itemButton =
  "flex min-w-0 flex-1 flex-col gap-1 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * What waits on the user, gathered at the top of the sidebar so an alert leads straight to it:
 * first the chat threads waiting on their decision, each opening its thread in the chat, then
 * the tasks needing attention, each shown on the timeline. Hidden while nothing does.
 */
export function NeedsAttention({
  onShow,
  onOpenChat,
}: {
  onShow: (id: TaskId) => void;
  onOpenChat: (target: ChatTarget) => void;
}) {
  const tasks = useTasks();
  const threads = useChatThreads({ archived: true });
  const decisions = waitingThreads(threads.data ?? []);
  const items = needsAttention(tasks.data ?? [], Date.now() / 1000);
  const taskOf = new Map((tasks.data ?? []).map((task) => [task.id, task]));
  const count = decisions.length + items.length;
  if (count === 0) {
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
        <span className={cn("ml-auto rounded-full px-1.5 tabular-nums", toneChip.attention)}>{count}</span>
      </h2>
      <div className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
        {decisions.length > 0 && (
          <ul aria-label="Waiting on your decision" className="flex flex-col gap-0.5">
            {decisions.map((thread) => {
              const task = thread.taskId === null ? undefined : taskOf.get(thread.taskId);
              return (
                <li key={thread.id} className="flex items-start gap-0.5 rounded-md hover:bg-sidebar-accent">
                  <button
                    type="button"
                    title="Open its chat"
                    className={itemButton}
                    onClick={() => onOpenChat({ channel: thread.channelId, thread: thread.id })}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-xs">
                      {task !== undefined && <span className="tabular-nums text-muted-foreground">#{task.id}</span>}
                      <span className="truncate font-medium">{task?.title ?? thread.title}</span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <DecisionMark />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {items.length > 0 && (
          <ul aria-label="Tasks needing attention" className="flex flex-col gap-0.5">
            {items.map(({ task, reasons }) => (
              <li key={task.id} className="flex items-start gap-0.5 rounded-md hover:bg-sidebar-accent">
                <button type="button" title="Show on the timeline" className={itemButton} onClick={() => onShow(task.id)}>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs">
                    <span className="tabular-nums text-muted-foreground">#{task.id}</span>
                    <span className="truncate font-medium">{task.title}</span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {reasons.map((reason) => (
                      <Badge key={reason} data-reason={reason} variant={reasonVariants[reason]} label={reasonLabels[reason]} />
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
