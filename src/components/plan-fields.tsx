import { useI18n, useMessages } from "@/lib/i18n";
import { useEffect, useRef } from "react";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DateInput, type DateInputProps } from "@astryxdesign/core/DateInput";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import koKR from "@astryxdesign/core/locales/ko-KR.generated.js";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { Estimate, EstimateUnit } from "@/lib/bindings";
import { type MissingPlanField, parseEstimateAmount } from "@/lib/plan";

const estimateUnits: EstimateUnit[] = ["hours", "days", "weeks", "months"];
const controlMessages = { "ko-KR": koKR };


/**
 * What the user typed for a task's estimate, due date (`YYYY-MM-DD`, blank for none), and
 * labels (comma-separated).
 */
export type PlanDraft = { estimate: string; estimateUnit: EstimateUnit; dueDate: string; labels: string };

/** The estimate typed in `plan`: null when blank, undefined when it is not a valid amount. */
export function planEstimate(plan: PlanDraft): Estimate | null | undefined {
  const amount = parseEstimateAmount(plan.estimate);
  if (amount === null) return null;
  return Number.isNaN(amount) ? undefined : { unit: plan.estimateUnit, amount };
}

/** Whether a task is marked for autopilot: an executor may take it up on its own once it is ready. */
export function AutopilotField({
  suffix,
  checked,
  onChange,
}: {
  /** Appended to the label, as for {@link PlanFields}. */
  suffix: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const m = useMessages();
  return (
    <span className="w-fit" title={m.tasks.autopilotFieldHint}>
      <CheckboxInput size="sm" label={m.tasks.autopilot} aria-label={m.tasks.autopilotField(suffix)} value={checked} onChange={onChange} />
    </span>
  );
}

export function PlanFields({
  suffix,
  plan,
  onChange,
  autoFocus,
}: {
  /** Appended to the field labels, e.g. ` of #3` in the edit form of task 3. */
  suffix: string;
  plan: PlanDraft;
  onChange: (plan: PlanDraft) => void;
  /** The field that takes the focus when the fields appear. */
  autoFocus?: MissingPlanField;
}) {
  const { m, locale } = useI18n();
  const invalid = planEstimate(plan) === undefined;
  // DateInput does not take autoFocus, so the due date is focused here, once, like the attribute.
  const dueDate = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus === "dueDate") dueDate.current?.focus();
  }, []);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <span title={m.tasks.estimateFieldHint}>
        <TextInput
          size="sm"
          width={80}
          inputMode="decimal"
          placeholder={m.tasks.optional}
          label={m.tasks.estimate}
          aria-label={m.tasks.estimateField(suffix)}
          status={invalid ? { type: "error" } : undefined}
          statusVariant="tooltip"
          hasAutoFocus={autoFocus === "estimate"}
          value={plan.estimate}
          onChange={(estimate) => onChange({ ...plan, estimate })}
        />
      </span>
      <Selector
        size="sm"
        width={96}
        label={m.tasks.estimateUnit(suffix)}
        isLabelHidden
        options={estimateUnits.map((value) => ({ value, label: m.tasks.estimateUnits[value] }))}
        value={plan.estimateUnit}
        onChange={(unit) => onChange({ ...plan, estimateUnit: unit as EstimateUnit })}
      />
      <InternationalizationProvider locale={locale === "ko" ? "ko-KR" : locale} messages={controlMessages}>
        <DateInput
          ref={dueDate}
          size="sm"
          // Astryx sets a 180px min-width on the control; a narrower field lets it spill over the next one.
          width={180}
          label={m.tasks.dueStates.upcoming}
          aria-label={m.tasks.dueDateField(suffix)}
          hasClear
          format="system_date"
          // A due date is blank or `YYYY-MM-DD`, from the server or from this field.
          value={(plan.dueDate || undefined) as DateInputProps["value"]}
          onChange={(date) => onChange({ ...plan, dueDate: date ?? "" })}
        />
      </InternationalizationProvider>
      <span className="min-w-48 flex-1" title={m.tasks.labelsFieldHint}>
        <TextInput
          size="sm"
          placeholder={m.tasks.labelsFieldPlaceholder}
          label={m.tasks.labels}
          aria-label={m.tasks.labelsField(suffix)}
          value={plan.labels}
          onChange={(labels) => onChange({ ...plan, labels })}
        />
      </span>
    </div>
  );
}
