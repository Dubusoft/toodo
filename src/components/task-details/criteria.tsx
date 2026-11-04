import { useState, type FormEvent } from "react";
import { Circle, CircleCheck, CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import type { CheckedBy, Criterion, CriterionState, Task } from "@/lib/bindings";
import { useCheckCriterion } from "@/lib/queries";
import { formatWhen } from "@/lib/timeline";
import { When } from "@/components/when";
import { toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { DetailField, useServerDown } from "@/components/task-common";
import { criterionKindLabels, takesTarget } from "@/components/criteria-editor";


const criterionStateLabels: Record<CriterionState, string> = { pending: "Pending", met: "Met", failed: "Failed" };

/** Green once met, rose only when the last check failed. */
const criterionStateStyles: Record<CriterionState, string> = {
  pending: toneText.neutral,
  met: toneText.success,
  failed: toneText.danger,
};

const checkedByLabels: Record<CheckedBy, string> = { user: "you", agent: "an agent", toodo: "Toodo" };

function CriterionMarker({ state }: { state: CriterionState }) {
  const Icon = state === "met" ? CircleCheck : state === "failed" ? CircleX : Circle;
  return (
    <span
      role="img"
      aria-label={criterionStateLabels[state]}
      className={cn("flex size-4 shrink-0 items-center justify-center", criterionStateStyles[state])}
    >
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

/** Who checked a criterion last and when, or null when nobody has. */
function checkedByText(criterion: Criterion): string | null {
  if (criterion.checkedBy === null) return null;
  const at = criterion.checkedAt === null ? "" : ` ${formatWhen(criterion.checkedAt)}`;
  return `Checked by ${checkedByLabels[criterion.checkedBy]}${at}`;
}

/**
 * What has to hold for the task to be done, each criterion with its state. A list row keeps
 * every criterion to one line; the details sheet adds targets, evidence, and who checked.
 */
export function TaskCriteria({ task, detailed }: { task: Task; detailed: boolean }) {
  const criteria = task.criteria;
  if (criteria.length === 0) {
    return null;
  }
  const list = (
    <ul aria-label={`Criteria of #${task.id}`} className="flex flex-col gap-0.5">
      {criteria.map((criterion) => (
        <CriterionItem key={criterion.id} task={task} criterion={criterion} detailed={detailed} />
      ))}
    </ul>
  );
  if (!detailed) {
    return list;
  }
  const met = criteria.filter((criterion) => criterion.state === "met").length;
  return <DetailField label={`Criteria (${met} of ${criteria.length} met)`}>{list}</DetailField>;
}

function CriterionItem({ task, criterion, detailed }: { task: Task; criterion: Criterion; detailed: boolean }) {
  const checkCriterion = useCheckCriterion();
  const serverDown = useServerDown();
  // The evidence form of a check that is not saved yet.
  const [writing, setWriting] = useState(false);
  const [evidence, setEvidence] = useState("");
  const checkable = criterion.kind === "manual" && task.status !== "done";
  const checkedBy = checkedByText(criterion);
  const target = takesTarget(criterion.kind) ? criterion.target : null;

  function cancel() {
    setWriting(false);
    setEvidence("");
  }
  const guard = useDiscardGuard(evidence.trim() !== "", cancel, checkCriterion.isPending);

  function toggle(checked: boolean) {
    if (writing) {
      cancel();
    } else if (checked) {
      checkCriterion.reset();
      setWriting(true);
    } else {
      checkCriterion.mutate({ taskId: task.id, criterionId: criterion.id, met: false, evidence: null });
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    checkCriterion.mutate(
      { taskId: task.id, criterionId: criterion.id, met: true, evidence: evidence.trim() || null },
      { onSuccess: cancel },
    );
  }

  return (
    <li data-criterion-state={criterion.state} className="flex min-w-0 flex-col gap-0.5 text-xs">
      <div
        className="flex min-w-0 items-center gap-1.5"
        title={detailed ? undefined : [checkedBy, criterion.evidence, target].filter(Boolean).join("\n") || undefined}
      >
        {checkable ? (
          <>
            <label className="flex size-4 shrink-0 items-center justify-center max-md:-mx-3.5 max-md:size-11">
              <input
                type="checkbox"
                aria-label={`Check criterion ${criterion.id} of #${task.id}`}
                checked={criterion.state === "met" || writing}
                disabled={checkCriterion.isPending || serverDown}
                onChange={(e) => toggle(e.target.checked)}
              />
            </label>
            {/* An unchecked box alone cannot tell a failed check from a pending one. */}
            {criterion.state === "failed" && <CriterionMarker state="failed" />}
          </>
        ) : (
          <CriterionMarker state={criterion.state} />
        )}
        <span
          className={cn(
            "min-w-0",
            detailed ? "break-words-keep" : "truncate",
            criterion.state === "failed" && toneText.danger,
          )}
        >{criterion.text}</span>
        {criterion.kind !== "manual" && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 text-muted-foreground">
            {criterionKindLabels[criterion.kind]}
          </span>
        )}
        {!detailed && criterion.evidence && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{criterion.evidence}</span>
        )}
      </div>
      {detailed && target && <code className="ml-5.5 break-all text-muted-foreground">{target}</code>}
      {detailed && (criterion.evidence || checkedBy) && (
        <p className="ml-5.5 whitespace-pre-line break-words-keep text-muted-foreground">
          {criterion.evidence}
          {criterion.evidence && checkedBy && " \u00b7 "}
          {criterion.checkedBy !== null && (
            <>
              Checked by {checkedByLabels[criterion.checkedBy]}
              {criterion.checkedAt !== null && (
                <>
                  {" "}
                  <When at={criterion.checkedAt} />
                </>
              )}
            </>
          )}
        </p>
      )}
      {writing && (
        <form
          onSubmit={save}
          className="ml-5.5 flex flex-wrap items-center gap-1"
          onKeyDown={guard.onKeyDown}
        >
          <input
            className={cn(inputClass, "h-7 flex-1 basis-48")}
            aria-label={`Evidence for criterion ${criterion.id}`}
            placeholder="Evidence (optional), e.g. a link or what you checked"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            autoFocus
          />
          {guard.asking ? (
            <DiscardConfirm
              label={`Discard evidence for criterion ${criterion.id}`}
              question="Discard the evidence?"
              onKeep={guard.keep}
              onDiscard={guard.discard}
            />
          ) : (
            <>
              <Button type="submit" size="xs" disabled={checkCriterion.isPending}>
                {checkCriterion.isPending ? "Saving..." : "Save"}
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
                Cancel
              </Button>
            </>
          )}
        </form>
      )}
      {checkCriterion.isError && (
        <p role="alert" className="ml-5.5 text-destructive">
          {checkCriterion.error.message}
        </p>
      )}
    </li>
  );
}
