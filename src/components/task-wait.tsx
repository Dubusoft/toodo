import { useState, type FormEvent } from "react";
import { AlarmClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import type { Task, Timestamp } from "@/lib/bindings";
import { useWaitTask } from "@/lib/queries";
import { statusNames } from "@/lib/status-styles";
import { formatFull } from "@/lib/timeline";
import { cn } from "@/lib/utils";

/** `at` as the value of a `datetime-local` input, in local time. */
function localInput(at: Timestamp): string {
  const date = new Date(at * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The default end of a new wait: tomorrow at 09:00 local time. */
function tomorrowMorning(): Timestamp {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime() / 1000;
}

/** What a waiting task shows: until when it waits and the status it returns to. */
export function waitLabel(task: Task): string | null {
  if (task.wait === null) return null;
  return `Waiting until ${formatFull(task.wait.until)}, then ${statusNames[task.wait.status].toLowerCase()}`;
}

/**
 * Makes a planned, in-progress, or in-review task wait until a time, or moves the time of a
 * waiting task. The task is paused until then and returns to its status on its own.
 */
export function WaitForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const waitTask = useWaitTask();
  const [until, setUntil] = useState(localInput(task.wait?.until ?? tomorrowMorning()));
  const [reason, setReason] = useState("");
  const at = until === "" ? Number.NaN : new Date(until).getTime() / 1000;
  const valid = Number.isFinite(at);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    waitTask.mutate(
      { id: task.id, until: Math.floor(at), reason: reason.trim() === "" ? null : reason.trim() },
      { onSuccess: onDone },
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Wait #${task.id}`}
      className="flex flex-col gap-1"
      onKeyDown={(event) => event.key === "Escape" && !waitTask.isPending && onDone()}
    >
      <p className="text-xs text-muted-foreground">
        {task.wait === null
          ? task.status === "planned"
            ? `#${task.id} waits until then and stays planned.`
            : `#${task.id} is paused until then, then returns to ${statusNames[task.status].toLowerCase()} on its own.`
          : `Move the end of the wait; #${task.id} then returns to ${statusNames[task.wait.status].toLowerCase()}.`}
      </p>
      <div className="flex flex-wrap gap-1 max-md:gap-2">
        <input
          type="datetime-local"
          className={cn(inputClass, "w-auto")}
          aria-label={`Wait #${task.id} until`}
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          required
          autoFocus
        />
        <input
          className={cn(inputClass, "min-w-0 flex-1 basis-48")}
          aria-label={`Reason #${task.id} waits`}
          placeholder="Why it waits (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="flex gap-1">
        <Button changesData type="submit" size="xs" disabled={waitTask.isPending || !valid}>
          <AlarmClock />
          {waitTask.isPending ? "Saving..." : task.wait === null ? "Wait" : "Change wait"}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Back
        </Button>
      </div>
      {waitTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {waitTask.error.message}
        </p>
      )}
    </form>
  );
}
