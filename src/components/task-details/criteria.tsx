import { fill, useI18n, useMessages } from "@/lib/i18n";
import { useState, type FormEvent } from "react";
import { Circle, CircleCheck, CircleX } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import type { Criterion, CriterionState, Task } from "@/lib/bindings";
import { useCheckCriterion } from "@/lib/queries";
import { formatWhen } from "@/lib/timeline";
import { When } from "@/components/when";
import { toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { DetailField, useServerDown } from "@/components/task-common";
import { takesTarget } from "@/components/criteria-editor";



/** Green once met, rose only when the last check failed. */
const criterionStateStyles: Record<CriterionState, string> = {
  pending: toneText.neutral,
  met: toneText.success,
  failed: toneText.danger,
};


function CriterionMarker({ state }: { state: CriterionState }) {
  const m = useMessages();
  const Icon = state === "met" ? CircleCheck : state === "failed" ? CircleX : Circle;
  return (
    <span
      role="img"
      aria-label={m.details.criterionState[state]}
      className={cn("flex size-4 shrink-0 items-center justify-center", criterionStateStyles[state])}
    >
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

/**
 * What has to hold for the task to be done, each criterion with its state. A list row keeps
 * every criterion to one line; the details sheet adds targets, evidence, and who checked.
 */
export function TaskCriteria({ task, detailed }: { task: Task; detailed: boolean }) {
  const m = useMessages();
  const criteria = task.criteria;
  if (criteria.length === 0) {
    return null;
  }
  const list = (
    <ul aria-label={m.details.criteria.ofTask(task.id)} className="flex flex-col gap-0.5">
      {criteria.map((criterion) => (
        <CriterionItem key={criterion.id} task={task} criterion={criterion} detailed={detailed} />
      ))}
    </ul>
  );
  if (!detailed) {
    return list;
  }
  const met = criteria.filter((criterion) => criterion.state === "met").length;
  return <DetailField label={m.details.criteria.count(met, criteria.length)}>{list}</DetailField>;
}

function CriterionItem({ task, criterion, detailed }: { task: Task; criterion: Criterion; detailed: boolean }) {
  const { locale, m } = useI18n();
  const checkCriterion = useCheckCriterion();
  const serverDown = useServerDown();
  // The evidence form of a check that is not saved yet.
  const [writing, setWriting] = useState(false);
  const [evidence, setEvidence] = useState("");
  const checkable = criterion.kind === "manual" && task.status !== "done";
  const who = criterion.checkedBy === null ? null : m.details.checkedBy[criterion.checkedBy];
  const when = criterion.checkedAt === null ? "" : ` ${formatWhen(criterion.checkedAt, undefined, locale, m)}`;
  const checkedBy = who === null ? null : m.details.criteria.checkedBy.replace("{who}", who).replace("{when}", when);
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
            <CheckboxInput
              size="sm"
              className="shrink-0"
              label={m.details.criteria.check(criterion.id, task.id)}
              isLabelHidden
              value={criterion.state === "met" || writing}
              isDisabled={checkCriterion.isPending || serverDown}
              onChange={toggle}
            />
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
          <Badge className="shrink-0" label={m.details.criterionKind[criterion.kind]} />
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
          {who !== null && fill(m.details.criteria.checkedBy, {
            who,
            when: criterion.checkedAt === null ? null : <> <When at={criterion.checkedAt} /></>,
          })}
        </p>
      )}
      {writing && (
        <form
          onSubmit={save}
          className="ml-5.5 flex flex-wrap items-center gap-1"
          onKeyDown={guard.onKeyDown}
        >
          <TextInput
            size="sm"
            containerClassName="flex-1 basis-48"
            label={m.details.criteria.evidence(criterion.id)}
            isLabelHidden
            placeholder={m.details.criteria.evidenceHint}
            value={evidence}
            onChange={setEvidence}
            hasAutoFocus
          />
          {guard.asking ? (
            <DiscardConfirm
              label={m.details.criteria.discardEvidence(criterion.id)}
              question={m.details.criteria.discardEvidenceQuestion}
              onKeep={guard.keep}
              onDiscard={guard.discard}
            />
          ) : (
            <>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                label={checkCriterion.isPending ? m.details.actions.saving : m.common.save}
                isDisabled={checkCriterion.isPending}
              />
              <Button type="button" size="sm" variant="ghost" label={m.common.cancel} onClick={guard.request} />
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
