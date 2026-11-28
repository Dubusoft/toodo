import { useMessages } from "@/lib/i18n";
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
  const m = useMessages();
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
      aria-label={m.details.outcome.conclude(task.id)}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        {m.details.outcome.concludeDescription(task.id)}
      </p>
      <TextArea
        rows={2}
        label={m.details.outcome.conclusion(task.id)}
        isLabelHidden
        placeholder={m.details.outcome.conclusionHint}
        value={note}
        onChange={setNote}
        hasAutoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={m.details.outcome.discardConclusion(task.id)}
          question={m.details.outcome.discardConclusionQuestion(task.id)}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex flex-wrap gap-1 max-md:gap-2">
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            icon={<CircleSlash />}
            label={concludeTask.isPending ? m.details.outcome.concluding : m.details.outcome.concludeNotAdopted}
            isDisabled={concludeTask.isPending || note.trim() === ""}
          />
          {/* Work that shipped through another task is done, not concluded. */}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={<GitMerge />}
            label={m.details.outcome.pickShipped}
            aria-label={m.details.outcome.shippedByOther(task.id)}
            tooltip={m.details.outcome.pickShippedHint}
            isDisabled={concludeTask.isPending}
            onClick={onShipped}
          />
          <Button type="button" size="sm" variant="ghost" label={m.details.actions.back} onClick={guard.request} />
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
  const m = useMessages();
  const reopenTask = useReopenTask();
  const [reason, setReason] = useState("");
  const guard = useDiscardGuard(reason.trim() !== "", onDone, reopenTask.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    reopenTask.mutate({ id: task.id, reason: reason.trim() }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} aria-label={m.details.outcome.reopen(task.id)} className="flex flex-col gap-1" onKeyDown={guard.onKeyDown}>
      <p className="text-xs text-muted-foreground">
        {m.details.outcome.reopenDescription(task.id)}
      </p>
      <TextArea
        rows={2}
        label={m.details.outcome.reopenReason(task.id)}
        isLabelHidden
        placeholder={m.details.outcome.reopenHint}
        value={reason}
        onChange={setReason}
        hasAutoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={m.details.outcome.discardReopen(task.id)}
          question={m.details.outcome.discardReopenQuestion(task.id)}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex flex-wrap gap-1 max-md:gap-2">
          <Button
            changesData
            type="submit"
            size="sm"
            variant="primary"
            icon={<RotateCcw />}
            label={reopenTask.isPending ? m.details.outcome.reopening : m.details.outcome.reopenSubmit}
            isDisabled={reopenTask.isPending || reason.trim() === ""}
          />
          <Button type="button" size="sm" variant="ghost" label={m.details.actions.back} onClick={guard.request} />
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
  const m = useMessages();
  const setOutcome = useSetTaskOutcome();
  const choices = (Object.keys(m.details.resolution) as TaskResolution[]).filter((resolution) => resolution !== task.resolution);
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
      aria-label={m.details.outcome.outcome(task.id)}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        {m.details.outcome.outcomeDescription(task.id, (task.resolution === null ? m.details.status.done : m.details.resolution[task.resolution]).toLowerCase())}
      </p>
      <Selector
        label={m.details.outcome.newOutcome(task.id)}
        isLabelHidden
        width={160}
        value={resolution}
        options={choices.map((choice) => ({ value: choice, label: m.details.resolution[choice] }))}
        onChange={(choice) => setResolution(choice as TaskResolution)}
      />
      <TextArea
        rows={2}
        label={m.details.outcome.outcomeNote(task.id)}
        isLabelHidden
        placeholder={m.details.outcome.outcomeHint}
        value={note}
        onChange={setNote}
        hasAutoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={m.details.outcome.discardOutcome(task.id)}
          question={m.details.outcome.discardOutcomeQuestion(task.id)}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex flex-wrap gap-1 max-md:gap-2">
          <Button
            changesData
            type="submit"
            size="sm"
            variant="primary"
            icon={<Flag />}
            label={setOutcome.isPending ? m.details.actions.saving : m.details.outcome.changeOutcome}
            isDisabled={setOutcome.isPending || note.trim() === ""}
          />
          <Button type="button" size="sm" variant="ghost" label={m.details.actions.back} onClick={guard.request} />
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
  const m = useMessages();
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
      aria-label={m.details.outcome.shippedForm(task.id)}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        {m.details.outcome.shippedDescription(task.id)}
      </p>
      <Selector
        ref={picker}
        label={m.details.outcome.shippedTask(task.id)}
        isLabelHidden
        placeholder={m.details.outcome.chooseTask}
        value={shipper}
        options={shippers.map((other) => ({
          value: String(other.id),
          label: `${taskRef(other.id, task.workspaceId, context)} ${other.title}`,
        }))}
        onChange={setShipper}
      />
      <TextArea
        rows={2}
        label={m.details.outcome.shippedNote(task.id)}
        isLabelHidden
        placeholder={m.details.outcome.shippedHint}
        value={note}
        onChange={setNote}
      />
      {guard.asking ? (
        <DiscardConfirm
          label={m.details.outcome.discardShipped(task.id)}
          question={m.details.outcome.discardShippedQuestion(task.id)}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex flex-wrap gap-1 max-md:gap-2">
          <Button
            changesData
            type="submit"
            size="sm"
            variant="primary"
            icon={<GitMerge />}
            label={concludeTask.isPending ? m.details.outcome.completing : m.details.outcome.submitShipped}
            isDisabled={concludeTask.isPending || !ready}
          />
          <Button type="button" size="sm" variant="ghost" label={m.details.actions.back} onClick={guard.request} />
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
  const m = useMessages();
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
        <p aria-label={m.details.outcome.note(task.id)} className="min-w-0 flex-1 whitespace-pre-line break-words-keep text-xs">
          {task.completionNote}
        </p>
        <IconButton
          size="sm"
          variant="ghost"
          label={m.details.outcome.editNote(task.id)}
          tooltip={m.details.outcome.editNoteTooltip}
          icon={<Pencil />}
          onClick={edit}
        />
      </div>
    );
  }
  return (
    <form
      onSubmit={submit}
      aria-label={m.details.outcome.noteForm(task.id)}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <TextArea
        rows={2}
        label={m.details.outcome.noteField(task.id)}
        isLabelHidden
        placeholder={m.details.outcome.noteHint}
        value={note}
        onChange={setNoteText}
        hasAutoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={m.details.outcome.discardNote(task.id)}
          question={m.details.outcome.discardNoteQuestion(task.id)}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex flex-wrap gap-1 max-md:gap-2">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            label={setNote.isPending ? m.details.actions.saving : m.details.outcome.saveNote}
            // The conclusion of work that was not adopted cannot be cleared.
            isDisabled={setNote.isPending || note.trim() === saved || (isNotAdopted(task) && note.trim() === "")}
          />
          <Button type="button" size="sm" variant="ghost" label={m.details.actions.discard} onClick={guard.request} />
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
