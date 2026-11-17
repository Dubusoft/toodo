import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleSlash, Flag, GitMerge, Pencil, RotateCcw, StickyNote } from "lucide-react";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Button, IconButton } from "@/components/button";
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
import { type TaskContext, taskRef } from "@/components/task-common";


/**
 * Concludes an active or planned task without completing it: the conclusion, why the work is not
 * adopted, is required and becomes its completion note.
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
      <TextArea
        rows={2}
        label={`Conclusion of #${task.id}`}
        isLabelHidden
        placeholder="What was tried, what was found, and why it is not adopted."
        value={note}
        onChange={setNote}
        hasAutoFocus
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
            size="sm"
            variant="destructive"
            icon={<CircleSlash />}
            label={concludeTask.isPending ? "Concluding..." : "Conclude as not adopted"}
            isDisabled={concludeTask.isPending || note.trim() === ""}
          />
          {/* Work that shipped through another task is done, not concluded. */}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={<GitMerge />}
            label="Complete as shipped by..."
            aria-label={`Complete #${task.id} as shipped by another task`}
            tooltip="The work shipped through another task: complete the task instead"
            isDisabled={concludeTask.isPending}
            onClick={onShipped}
          />
          <Button type="button" size="sm" variant="ghost" label="Back" onClick={guard.request} />
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
      <TextArea
        rows={2}
        label={`Reason to reopen #${task.id}`}
        isLabelHidden
        placeholder="Why is the task not finished after all?"
        value={reason}
        onChange={setReason}
        hasAutoFocus
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
          <Button
            changesData
            type="submit"
            size="sm"
            variant="primary"
            icon={<RotateCcw />}
            label={reopenTask.isPending ? "Reopening..." : "Reopen"}
            isDisabled={reopenTask.isPending || reason.trim() === ""}
          />
          <Button type="button" size="sm" variant="ghost" label="Back" onClick={guard.request} />
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
      <Selector
        label={`New outcome of #${task.id}`}
        isLabelHidden
        width={160}
        value={resolution}
        options={choices.map((choice) => ({ value: choice, label: resolutionNames[choice] }))}
        onChange={(choice) => setResolution(choice as TaskResolution)}
      />
      <TextArea
        rows={2}
        label={`Outcome note of #${task.id}`}
        isLabelHidden
        placeholder="What happened, e.g. the change was reverted. This becomes the completion note."
        value={note}
        onChange={setNote}
        hasAutoFocus
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
          <Button
            changesData
            type="submit"
            size="sm"
            variant="primary"
            icon={<Flag />}
            label={setOutcome.isPending ? "Saving..." : "Change outcome"}
            isDisabled={setOutcome.isPending || note.trim() === ""}
          />
          <Button type="button" size="sm" variant="ghost" label="Back" onClick={guard.request} />
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
  // Selector does not take autoFocus, so its trigger is focused here, once, like the attribute.
  const picker = useRef<HTMLButtonElement>(null);
  useEffect(() => picker.current?.focus(), []);

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
      <Selector
        ref={picker}
        label={`Task that shipped #${task.id}`}
        isLabelHidden
        placeholder="Choose a task..."
        value={shipper}
        options={shippers.map((other) => ({
          value: String(other.id),
          label: `${taskRef(other.id, task.workspaceId, context)} ${other.title}`,
        }))}
        onChange={setShipper}
      />
      <TextArea
        rows={2}
        label={`Shipped note of #${task.id}`}
        isLabelHidden
        placeholder="How the other task shipped this work. This becomes the completion note."
        value={note}
        onChange={setNote}
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
          <Button
            changesData
            type="submit"
            size="sm"
            variant="primary"
            icon={<GitMerge />}
            label={concludeTask.isPending ? "Completing..." : "Complete as shipped"}
            isDisabled={concludeTask.isPending || !ready}
          />
          <Button type="button" size="sm" variant="ghost" label="Back" onClick={guard.request} />
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
        <IconButton
          size="sm"
          variant="ghost"
          label={`Edit completion note of #${task.id}`}
          tooltip="Edit note"
          icon={<Pencil />}
          onClick={edit}
        />
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
      <TextArea
        rows={2}
        label={`Completion note for #${task.id}`}
        isLabelHidden
        placeholder="What did this achieve? Impact, decisions, follow-ups. Reviews include this note."
        value={note}
        onChange={setNoteText}
        hasAutoFocus
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
            size="sm"
            variant="primary"
            label={setNote.isPending ? "Saving..." : "Save note"}
            // The conclusion of work that was not adopted cannot be cleared.
            isDisabled={setNote.isPending || note.trim() === saved || (isNotAdopted(task) && note.trim() === "")}
          />
          <Button type="button" size="sm" variant="ghost" label="Discard" onClick={guard.request} />
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
