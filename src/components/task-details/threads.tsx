import { useState, type FormEvent } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { Conversation, ThreadActions, ThreadStatusBadge } from "@/components/chat-panel";
import { DetailField } from "@/components/task-common";
import type { ChatThreadId, Task } from "@/lib/bindings";
import { useChatChannels, useChatThreads, useCreateChatThread } from "@/lib/queries";
import { cn } from "@/lib/utils";

function NewThreadForm({ task, onCreated, onCancel }: { task: Task; onCreated: (id: ChatThreadId) => void; onCancel: () => void }) {
  const channels = useChatChannels();
  const create = useCreateChatThread();
  const [title, setTitle] = useState(`#${task.id} ${task.title}`);
  const [channel, setChannel] = useState("1");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { channelId: Number(channel), title: title.trim(), taskId: task.id },
      { onSuccess: (thread) => onCreated(thread.id) },
    );
  };
  return (
    <form aria-label={`New thread for #${task.id}`} className="flex flex-col gap-2 rounded-md border p-2" onSubmit={submit}>
      <TextInput label="Thread title" size="sm" value={title} onChange={setTitle} hasAutoFocus />
      <Selector
        label="Channel"
        size="sm"
        value={channel}
        onChange={setChannel}
        options={(channels.data ?? []).map((candidate) => ({ value: String(candidate.id), label: `#${candidate.name}` }))}
      />
      {create.isError && (
        <p role="alert" className="text-destructive">
          {create.error.message}
        </p>
      )}
      <div className="flex gap-1">
        <Button type="submit" size="sm" label="Start thread" changesData isDisabled={create.isPending || title.trim() === ""} />
        <Button variant="ghost" size="sm" label="Cancel" onClick={onCancel} />
      </div>
    </form>
  );
}

/**
 * The chat thread that follows the task, opening its conversation in place, or a form to
 * start it: a task has one thread.
 */
export function TaskThreads({ task }: { task: Task }) {
  const threads = useChatThreads({ taskId: task.id, archived: true });
  const channels = useChatChannels();
  const [shown, setShown] = useState<ChatThreadId | null>(null);
  const [adding, setAdding] = useState(false);
  const list = threads.data ?? [];
  const channelName = (id: number) => channels.data?.find((channel) => channel.id === id)?.name ?? String(id);

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
                  {thread.title}
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
                  <Conversation
                    key={thread.id}
                    place={{ thread: thread.id }}
                    label={thread.title}
                    open={thread.status === "open"}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {list.length > 0 ? null : adding ? (
        <NewThreadForm
          task={task}
          onCancel={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            setShown(id);
          }}
        />
      ) : (
        <div>
          <Button variant="ghost" size="sm" label="Start a thread" onClick={() => setAdding(true)} />
        </div>
      )}
    </DetailField>
  );
}
