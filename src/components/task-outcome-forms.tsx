import { useState, type FormEvent } from "react";
import { CircleSlash, Flag, GitMerge, Pencil, RotateCcw, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import type { Task, TaskResolution } from "@/lib/bindings";
import {
  useConcludeTask,
  useReopenTask,
  useSetCompletionNote,
  useSetTaskOutcome,
} from "@/lib/queries";
import { isNotAdopted } from "@/lib/task-graph";
import { statusNames } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { type TaskContext, taskRef } from "@/components/task-common";


/**
 * Concludes an active task without completing it: the conclusion, why the work is not adopted, is
 * required and becomes its completion note.
 */
export function ConcludeForm({
  task,
  onDone,
  onShipped,
}: {
  task: Task;
  onDone: () => void;
  onShipped: () => void;
}) {
  const concludeTask = useConcludeTask();
  const [note, setNote] = useState("");
  const guard = useDiscardGuard(note.trim() !== "", onDone, concludeTask.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    concludeTask.mutate({ id: task.id, note: note.trim() }, { onSuccess: onDone });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Conclude #${task.id}`}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        Finish #{task.id} without completing it. It is marked not adopted. Tasks that depend on it stay blocked.
      </p>
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Conclusion of #${task.id}`}
        placeholder="What was tried, what was found, and why it is not adopted."
        value={note}
        onChange={(e) => setNote(e.target.value)}
        required
        autoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard conclusion of #${task.id}`}
          question={`Discard your conclusion of #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button
            type="submit"
            size="xs"
            variant="destructive"
            disabled={concludeTask.isPending || note.trim() === ""}
          >
            <CircleSlash />
            {concludeTask.isPending ? "Concluding..." : "Conclude as not adopted"}
          </Button>
          {/* Work that shipped through another task is done, not concluded. */}
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-label={`Complete #${task.id} as shipped by another task`}
            title="The work shipped through another task: complete the task instead"
            disabled={concludeTask.isPending}
            onClick={onShipped}
          >
            <GitMerge />
            Complete as shipped by...
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Back
          </Button>
        </div>
      )}
      {concludeTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {concludeTask.error.message}
        </p>
      )}
    </form>
  );
}

/** What a form says about the outcome of a task. */
const resolutionNames: Record<TaskResolution, string> = {
  merged: "Merged",
  completed: "Completed",
  not_adopted: statusNames.not_adopted,
};

/**
 * Reopens a done task completed or concluded by mistake. The reason is required and kept as
 * a progress note with the earlier outcome.
 */
export function ReopenForm({
  task,
  onDone,
}: {
  task: Task;
  onDone: () => void;
}) {
  const reopenTask = useReopenTask();
  const [reason, setReason] = useState("");
  const guard = useDiscardGuard(reason.trim() !== "", onDone, reopenTask.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    reopenTask.mutate({ id: task.id, reason: reason.trim() }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} aria-label={`Reopen #${task.id}`} className="flex flex-col gap-1" onKeyDown={guard.onKeyDown}>
      <p className="text-xs text-muted-foreground">
        Reopen #{task.id}: it is paused, and Resume continues the
        work. Its outcome and completion note are cleared and kept, with your reason, as a progress note.
      </p>
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Reason to reopen #${task.id}`}
        placeholder="Why is the task not finished after all?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        autoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard reason to reopen #${task.id}`}
          question={`Discard your reason to reopen #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button changesData type="submit" size="xs" disabled={reopenTask.isPending || reason.trim() === ""}>
            <RotateCcw />
            {reopenTask.isPending ? "Reopening..." : "Reopen"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Back
          </Button>
        </div>
      )}
      {reopenTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {reopenTask.error.message}
        </p>
      )}
    </form>
  );
}

/**
 * Corrects how a done task ended without reopening it. The note is required and becomes its
 * completion note; the earlier outcome is kept as a progress note.
 */
export function OutcomeForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const setOutcome = useSetTaskOutcome();
  const choices = (Object.keys(resolutionNames) as TaskResolution[]).filter((resolution) => resolution !== task.resolution);
  const [resolution, setResolution] = useState<TaskResolution>(choices[0]);
  const [note, setNote] = useState("");
  const guard = useDiscardGuard(note.trim() !== "", onDone, setOutcome.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOutcome.mutate({ id: task.id, resolution, note: note.trim() }, { onSuccess: onDone });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Outcome of #${task.id}`}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        #{task.id} is done as {task.resolution === null ? "done" : resolutionNames[task.resolution].toLowerCase()}.
        Correct how it ended; the earlier outcome and note are kept as a progress note. Tasks that depend on it wait
        while it is not adopted.
      </p>
      <select
        aria-label={`New outcome of #${task.id}`}
        className={cn(inputClass, "w-40")}
        value={resolution}
        onChange={(e) => setResolution(e.target.value as TaskResolution)}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {resolutionNames[choice]}
          </option>
        ))}
      </select>
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Outcome note of #${task.id}`}
        placeholder="What happened, e.g. the change was reverted. This becomes the completion note."
        value={note}
        onChange={(e) => setNote(e.target.value)}
        required
        autoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard outcome of #${task.id}`}
          question={`Discard the new outcome of #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button changesData type="submit" size="xs" disabled={setOutcome.isPending || note.trim() === ""}>
            <Flag />
            {setOutcome.isPending ? "Saving..." : "Change outcome"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Back
          </Button>
        </div>
      )}
      {setOutcome.isError && (
        <p role="alert" className="text-xs text-destructive">
          {setOutcome.error.message}
        </p>
      )}
    </form>
  );
}

/**
 * Completes a task whose work shipped through another task, one done as merged or completed:
 * an active task, or one concluded as not adopted, becomes done and its dependents can start.
 * The note is required and becomes its completion note.
 */
export function ShippedByForm({
  task,
  tasks,
  context,
  onDone,
}: {
  task: Task;
  tasks: Task[];
  context: TaskContext;
  onDone: () => void;
}) {
  const concludeTask = useConcludeTask();
  // Only work that shipped can carry this task's work with it.
  const shippers = tasks
    .filter(
      (other) =>
        other.id !== task.id &&
        other.status === "done" &&
        (other.resolution === "merged" || other.resolution === "completed"),
    )
    .sort((a, b) => b.id - a.id);
  const [shipper, setShipper] = useState("");
  const [note, setNote] = useState("");
  const ready = shipper !== "" && note.trim() !== "";
  const guard = useDiscardGuard(shipper !== "" || note.trim() !== "", onDone, concludeTask.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    concludeTask.mutate({ id: task.id, note: note.trim(), shippedWith: Number(shipper) }, { onSuccess: onDone });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Complete #${task.id} as shipped by`}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        Complete #{task.id} as shipped by another done task. It becomes done, and tasks that depend on it can start.
      </p>
      <select
        aria-label={`Task that shipped #${task.id}`}
        className={inputClass}
        value={shipper}
        onChange={(e) => setShipper(e.target.value)}
        required
        autoFocus
      >
        <option value="">Choose a task...</option>
        {shippers.map((other) => (
          <option key={other.id} value={other.id}>
            {taskRef(other.id, task.workspaceId, context)} {other.title}
          </option>
        ))}
      </select>
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Shipped note of #${task.id}`}
        placeholder="How the other task shipped this work. This becomes the completion note."
        value={note}
        onChange={(e) => setNote(e.target.value)}
        required
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard completion of #${task.id}`}
          question={`Discard completing #${task.id} as shipped by another?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button changesData type="submit" size="xs" disabled={concludeTask.isPending || !ready}>
            <GitMerge />
            {concludeTask.isPending ? "Completing..." : "Complete as shipped"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Back
          </Button>
        </div>
      )}
      {concludeTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {concludeTask.error.message}
        </p>
      )}
    </form>
  );
}

/**
 * The completion note of a done task, with a pencil to edit it. Without a note it shows
 * nothing until `adding`, set from the task's "Add note" action.
 */
export function CompletionNote({ task, adding, onAdded }: { task: Task; adding: boolean; onAdded: () => void }) {
  const setNote = useSetCompletionNote();
  const [editingNote, setEditing] = useState(false);
  const [note, setNoteText] = useState("");
  const saved = task.completionNote ?? "";
  const editing = editingNote || adding;

  function close() {
    setEditing(false);
    onAdded();
  }
  const guard = useDiscardGuard(
    note.trim() !== saved.trim(),
    () => {
      setNoteText(saved);
      close();
    },
    setNote.isPending,
  );

  function edit() {
    setNoteText(saved);
    setEditing(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNote.mutate({ id: task.id, note }, { onSuccess: close });
  }

  if (!editing) {
    return task.completionNote === null ? null : (
      <div className="flex items-start gap-1 rounded-md bg-muted/60 px-2 py-1">
        <StickyNote aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <p aria-label={`Completion note of #${task.id}`} className="min-w-0 flex-1 whitespace-pre-line break-words-keep text-xs">
          {task.completionNote}
        </p>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Edit completion note of #${task.id}`}
          title="Edit note"
          onClick={edit}
        >
          <Pencil />
        </Button>
      </div>
    );
  }
  return (
    <form
      onSubmit={submit}
      aria-label={`Completion note form of #${task.id}`}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Completion note for #${task.id}`}
        placeholder="What did this achieve? Impact, decisions, follow-ups. Reviews include this note."
        value={note}
        onChange={(e) => setNoteText(e.target.value)}
        autoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard note of #${task.id}`}
          question={`Discard your note for #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button
            type="submit"
            size="xs"
            // The conclusion of work that was not adopted cannot be cleared.
            disabled={setNote.isPending || note.trim() === saved || (isNotAdopted(task) && note.trim() === "")}
          >
            {setNote.isPending ? "Saving..." : "Save note"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Discard
          </Button>
        </div>
      )}
      {setNote.isError && (
        <p role="alert" className="text-xs text-destructive">
          {setNote.error.message}
        </p>
      )}
    </form>
  );
}
