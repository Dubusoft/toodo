import { useState } from "react";
import { Conversation, ThreadActions, ThreadStatusBadge, taskName } from "@/components/chat-panel";
import { DetailField } from "@/components/task-common";
import type { ChatThreadId, Task } from "@/lib/bindings";
import { useChatChannels, useChatThreads } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * The chat thread that follows the task, opening its conversation in place. A task has one
 * thread, which the agent opens (or the chat, when the task is opened there); left out while
 * the task has none.
 */
export function TaskThreads({ task }: { task: Task }) {
  const threads = useChatThreads({ taskId: task.id, archived: true });
  const channels = useChatChannels();
  const [shown, setShown] = useState<ChatThreadId | null>(null);
  const list = threads.data ?? [];
  const channelName = (id: number) => channels.data?.find((channel) => channel.id === id)?.name ?? String(id);
  if (list.length === 0) return null;
  const name = taskName(task);

  return (
    <DetailField label={`Threads (${list.length})`}>
      <ul aria-label={`Threads of #${task.id}`} className="flex flex-col gap-1">
        {list.map((thread) => {
          const open = shown === thread.id;
          return (
            <li key={thread.id} className="flex flex-col gap-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-expanded={open}
                  className={cn("min-w-0 truncate text-left text-sm hover:underline", open && "font-semibold")}
                  onClick={() => setShown(open ? null : thread.id)}
                >
                  {name}
                </button>
                <span className="shrink-0 text-muted-foreground">{`#${channelName(thread.channelId)}`}</span>
                <ThreadStatusBadge status={thread.status} />
                {thread.unread > 0 && thread.status !== "archived" && (
                  <span className="shrink-0 font-medium text-destructive">{`${thread.unread} unread`}</span>
                )}
                {open && (
                  <span className="ml-auto flex shrink-0">
                    <ThreadActions thread={thread} />
                  </span>
                )}
              </div>
              {open && (
                <div className="flex h-80 flex-col overflow-hidden rounded-md border">
                  <Conversation key={thread.id} place={{ thread: thread.id }} label={name} open={thread.status === "open"} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </DetailField>
  );
}
