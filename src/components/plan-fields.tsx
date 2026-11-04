import { compactSelectClass, inputClass } from "@/components/workspace-list";
import type { Estimate, EstimateUnit } from "@/lib/bindings";
import { parseEstimateAmount } from "@/lib/plan";
import { cn } from "@/lib/utils";


/** What the user typed for a task's estimate and due date (`YYYY-MM-DD`, blank for none). */
export type PlanDraft = { estimate: string; estimateUnit: EstimateUnit; dueDate: string };

/** The estimate typed in `plan`: null when blank, undefined when it is not a valid amount. */
export function planEstimate(plan: PlanDraft): Estimate | null | undefined {
  const amount = parseEstimateAmount(plan.estimate);
  if (amount === null) return null;
  return Number.isNaN(amount) ? undefined : { unit: plan.estimateUnit, amount };
}

export function PlanFields({
  suffix,
  plan,
  onChange,
}: {
  /** Appended to the field labels, e.g. ` of #3` in the edit form of task 3. */
  suffix: string;
  plan: PlanDraft;
  onChange: (plan: PlanDraft) => void;
}) {
  const invalid = planEstimate(plan) === undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <label className="flex items-center gap-1">
        Estimate
        <input
          className={cn(inputClass, "w-20")}
          inputMode="decimal"
          placeholder="Optional"
          aria-label={`Estimate${suffix}`}
          aria-invalid={invalid}
          title="Optional: expected size, a number greater than 0"
          value={plan.estimate}
          onChange={(e) => onChange({ ...plan, estimate: e.target.value })}
        />
      </label>
      <select
        aria-label={`Estimate unit${suffix}`}
        className={cn(compactSelectClass, "w-24")}
        value={plan.estimateUnit}
        onChange={(e) => onChange({ ...plan, estimateUnit: e.target.value as EstimateUnit })}
      >
        <option value="hours">hours</option>
        <option value="days">days</option>
        <option value="weeks">weeks</option>
        <option value="months">months</option>
      </select>
      <label className="flex items-center gap-1">
        Due
        <input
          type="date"
          className={cn(inputClass, "w-40")}
          aria-label={`Due date${suffix}`}
          value={plan.dueDate}
          onChange={(e) => onChange({ ...plan, dueDate: e.target.value })}
        />
      </label>
    </div>
  );
}
