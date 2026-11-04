import { useState, type FormEvent } from "react";
import { CircleDot, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import type { Task } from "@/lib/bindings";
import { useCreateIssue, useLinkIssue } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { DetailField } from "@/components/task-common";


/** An issue number typed by the user, with or without `#`; `null` unless it is a positive integer. */
export function parseIssueNumber(raw: string): number | null {
  const match = /^#?(\d{1,9})$/.exec(raw.trim());
  const number = match ? Number(match[1]) : 0;
  return number > 0 ? number : null;
}

/**
 * The GitHub issue of a task, which its pull request closes on merge, or the form that
 * links an existing issue or creates one from the task.
 */
export function TaskIssue({
  task,
  detailed,
  linking,
  onDone,
}: {
  task: Task;
  detailed: boolean;
  linking: boolean;
  onDone: () => void;
}) {
  const linkIssue = useLinkIssue();
  const createIssue = useCreateIssue();
  const [number, setNumber] = useState("");
  const parsed = parseIssueNumber(number);
  const pending = linkIssue.isPending || createIssue.isPending;
  const error = linkIssue.error ?? createIssue.error;
  const editable = task.status !== "done";
  const guard = useDiscardGuard(
    number.trim() !== "",
    () => {
      setNumber("");
      onDone();
    },
    pending,
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parsed !== null) {
      linkIssue.mutate({ id: task.id, number: parsed }, { onSuccess: onDone });
    }
  }

  const issue = task.issue;
  const content = issue ? (
    <p className="flex min-w-0 items-center gap-1 text-xs">
      {!detailed && <CircleDot aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
      {!detailed && <span className="sr-only">Issue </span>}
      <span aria-label={`Issue of #${task.id}`} title={issue.url} className="shrink-0 font-medium tabular-nums">
        #{issue.number}
      </span>
      <span className={cn("min-w-0 font-mono text-muted-foreground select-all", detailed ? "break-all" : "truncate")}>
        {issue.url}
      </span>
      {editable && (
        <Button
          changesData
          size="icon-xs"
          variant="ghost"
          aria-label={`Unlink issue from #${task.id}`}
          title="Unlink the issue; a pull request keeps its closing reference"
          disabled={pending}
          onClick={() => linkIssue.mutate({ id: task.id, number: null })}
        >
          <X />
        </Button>
      )}
    </p>
  ) : (
    linking && (
      <form
        onSubmit={submit}
        aria-label={`Issue form of #${task.id}`}
        className="flex flex-wrap items-center gap-1"
        onKeyDown={guard.onKeyDown}
      >
        <input
          className={cn(inputClass, "h-7 w-28")}
          inputMode="numeric"
          placeholder="Issue #"
          aria-label={`Issue number of #${task.id}`}
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          autoFocus
        />
        {guard.asking ? (
          <DiscardConfirm
            label={`Discard issue number of #${task.id}`}
            question="Discard the issue number?"
            onKeep={guard.keep}
            onDiscard={guard.discard}
          />
        ) : (
          <>
            <Button type="submit" size="xs" disabled={parsed === null || pending}>
              {linkIssue.isPending ? "Linking..." : "Link"}
            </Button>
            <Button
              changesData
              type="button"
              size="xs"
              variant="outline"
              aria-label={`Create issue for #${task.id}`}
              title="Open a GitHub issue with the title and description of this task and link it"
              disabled={pending}
              onClick={() => createIssue.mutate(task.id, { onSuccess: onDone })}
            >
              <Plus />
              {createIssue.isPending ? "Creating..." : "Create issue"}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
              Discard
            </Button>
          </>
        )}
      </form>
    )
  );
  return (
    <>
      {detailed && issue ? <DetailField label="Issue">{content}</DetailField> : content}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </>
  );
}
