import { en, type Messages } from "@/locales/en";
import { useMessages, type Locale } from "@/lib/i18n";
import { formatFull } from "@/lib/timeline";
import { useState, type FormEvent } from "react";
import { AlarmClock } from "lucide-react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { inputClass } from "@/components/workspace-list";
import type { Task, TaskWait, Timestamp } from "@/lib/bindings";
import { useWaitTask } from "@/lib/queries";
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

/**
 * The status a wait returns a task to, by name: "planned" rather than "blocked" for a planned
 * one, since whether it is blocked or ready then depends on its prerequisites.
 */
function returnName(status: TaskWait["status"], m: Messages): string {
  return (status === "planned" ? m.details.status.waiting : m.details.status[status]).toLowerCase();
}

/** What a waiting task shows: until when it waits and the status it returns to. */
export function waitLabel(task: Task, locale: Locale = "en", m: Messages = en): string | null {
  if (task.wait === null) return null;
  return m.details.wait.waitingUntil(formatFull(task.wait.until, locale), returnName(task.wait.status, m));
}

/**
 * Makes a planned, in-progress, or in-review task wait until a time, or moves the time of a
 * waiting task. The task is paused until then and returns to its status on its own.
 */
export function WaitForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const m = useMessages();
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
      aria-label={m.details.wait.form(task.id)}
      className="flex flex-col gap-1"
      onKeyDown={(event) => event.key === "Escape" && !waitTask.isPending && onDone()}
    >
      <p className="text-xs text-muted-foreground">
        {task.wait === null
          ? task.status === "planned"
            ? m.details.wait.planned(task.id)
            : m.details.wait.paused(task.id, m.details.status[task.status].toLowerCase())
          : m.details.wait.reschedule(task.id, returnName(task.wait.status, m))}
      </p>
      <div className="flex flex-wrap gap-1 max-md:gap-2">
        {/* Native: Astryx DateInput picks a date only, and this needs a date and a time. */}
        <input
          type="datetime-local"
          className={cn(inputClass, "w-auto")}
          aria-label={m.details.wait.until(task.id)}
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          required
          autoFocus
        />
        <TextInput
          containerClassName="min-w-0 flex-1 basis-48"
          label={m.details.wait.reason(task.id)}
          isLabelHidden
          placeholder={m.details.wait.reasonHint}
          value={reason}
          onChange={setReason}
        />
      </div>
      <div className="flex gap-1">
        <Button
          changesData
          type="submit"
          size="sm"
          variant="primary"
          icon={<AlarmClock />}
          label={waitTask.isPending ? m.details.actions.saving : task.wait === null ? m.details.wait.submit : m.details.wait.change}
          isDisabled={waitTask.isPending || !valid}
        />
        <Button type="button" size="sm" variant="ghost" label={m.details.actions.back} onClick={onDone} />
      </div>
      {waitTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {waitTask.error.message}
        </p>
      )}
    </form>
  );
}
