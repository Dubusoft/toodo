import { fill, useI18n } from "@/lib/i18n";
import { useState } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import type { EstimateUnit, Task, TaskId } from "@/lib/bindings";
import {
  formatWork,
  loadCapacity,
  planLoad,
  saveCapacity,
  type Capacity,
  type PeriodLoad,
  type PlanScale,
} from "@/lib/capacity";
import { formatDueDate, formatEstimate, parseEstimateAmount } from "@/lib/plan";
import { formatDate } from "@/lib/timeline";
import { cn } from "@/lib/utils";

/**
 * The estimates of `tasks` summed per quarter or year of their due dates, against a capacity
 * per quarter saved in this browser, so a plan that does not fit shows before it slips.
 */
export function PlanView({ tasks, onShowTask }: { tasks: Task[]; onShowTask: (id: TaskId) => void }) {
  const { m, locale } = useI18n();
  const [scale, setScale] = useState<PlanScale>("quarter");
  const [capacity, setCapacity] = useState<Capacity | null>(loadCapacity);
  const [amountText, setAmountText] = useState(capacity === null ? "" : String(capacity.amount));
  const [unit, setUnit] = useState<EstimateUnit>(capacity?.unit ?? "weeks");
  const amount = parseEstimateAmount(amountText);
  const changeCapacity = (text: string, nextUnit: EstimateUnit) => {
    setAmountText(text);
    setUnit(nextUnit);
    const parsed = parseEstimateAmount(text);
    if (Number.isNaN(parsed)) return;
    const next = parsed === null ? null : { unit: nextUnit, amount: parsed };
    saveCapacity(next);
    setCapacity(next);
  };
  const shownUnit = capacity?.unit ?? unit;
  const { periods, unscheduled, unscheduledEstimated } = planLoad(tasks, scale, capacity, formatDate(Date.now() / 1000), { m, locale });
  const overloaded = periods.filter((period) => period.overloaded).length;

  return (
    // The bottom padding lets the last row scroll clear of the floating chat button.
    <div role="region" aria-label={m.tasks.plan} className="flex flex-col gap-4 pb-14">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <ToggleButtonGroup
          label={m.tasks.planPeriod}
          size="sm"
          value={scale}
          onChange={(next) => typeof next === "string" && setScale(next as PlanScale)}
        >
          {(["quarter", "year"] as const).map((option) => (
            <ToggleButton key={option} value={option} label={m.tasks.planScales[option]} />
          ))}
        </ToggleButtonGroup>
        {/* The amount and its unit wrap together, and the label sizes the field rather than wrapping in it. */}
        <div className="flex items-end gap-2">
          <TextInput
            label={m.tasks.quarterCapacity}
            size="sm"
            controlStyle={{ width: 128 }}
            inputMode="decimal"
            status={Number.isNaN(amount) ? { type: "error" } : undefined}
            aria-describedby="capacity-hint"
            placeholder={m.tasks.noCapacity}
            value={amountText}
            onChange={(value) => changeCapacity(value, unit)}
          />
          <Selector
            label={m.tasks.capacityUnit}
            isLabelHidden
            size="sm"
            options={(Object.keys(m.tasks.estimateUnits) as EstimateUnit[]).map((option) => ({ value: option, label: m.tasks.estimateUnits[option] }))}
            value={unit}
            onChange={(value) => changeCapacity(amountText, value as EstimateUnit)}
          />
        </div>
      </div>
      <p id="capacity-hint" className={cn("text-xs", Number.isNaN(amount) ? "text-destructive" : "text-muted-foreground")}>
        {Number.isNaN(amount)
          ? m.tasks.invalidCapacity
          : capacity === null
            ? m.tasks.capacityHint
            : overloaded > 0
              ? m.tasks.overloadedPeriods(overloaded)
              : m.tasks.capacityFits}
      </p>
      <ol aria-label={m.tasks.periods} className="flex flex-col gap-3">
        {periods.map((load) => (
          <PeriodCard key={load.period.from} load={load} unit={shownUnit} onShowTask={onShowTask} />
        ))}
      </ol>
      {unscheduled.length > 0 && (
        <section aria-label={m.tasks.missingPlan.dueDate} className="flex flex-col gap-2 rounded-xl border border-dashed p-3">
          <h3 className="flex items-baseline gap-2 text-sm font-medium">
            {m.tasks.missingPlan.dueDate}
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {m.tasks.unscheduledEstimate(m.tasks.taskCount(unscheduled.length), formatWork(unscheduledEstimated, shownUnit, m))}
            </span>
          </h3>
          <p className="text-xs text-muted-foreground">{m.tasks.unscheduledHint}</p>
          <TaskLines tasks={unscheduled} onShowTask={onShowTask} />
        </section>
      )}
    </div>
  );
}

function PeriodCard({ load, unit, onShowTask }: { load: PeriodLoad; unit: EstimateUnit; onShowTask: (id: TaskId) => void }) {
  const { m } = useI18n();
  const { capacity, estimated, overloaded } = load;
  const share = capacity === null || capacity === 0 ? null : estimated / capacity;
  return (
    <li
      aria-label={load.label}
      data-overloaded={overloaded || undefined}
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-3 shadow-xs",
        overloaded && "border-destructive/60 bg-destructive/5",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">{load.label}</h3>
        <span className="text-sm tabular-nums">
          {fill(m.tasks.estimatedOfCapacity, {
            estimated: formatWork(estimated, unit, m),
            capacity: capacity !== null && <span className="text-muted-foreground">{m.tasks.capacityOf(formatWork(capacity, unit, m))}</span>,
            share: share !== null && <span className="text-muted-foreground">{m.tasks.capacityShare(Math.round(share * 100))}</span>,
          })}
        </span>
        {overloaded && capacity !== null && (
          <span className="text-xs font-medium text-destructive">{m.tasks.overCapacity(formatWork(estimated - capacity, unit, m))}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {m.tasks.periodTaskCount(m.tasks.taskCount(load.tasks.length), load.done > 0 ? formatWork(load.done, unit, m) : undefined)}
        </span>
      </div>
      {share !== null && (
        <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", overloaded ? "bg-destructive" : "bg-primary")}
            style={{ width: `${Math.min(share, 1) * 100}%` }}
          />
        </div>
      )}
      {load.unestimated > 0 && (
        <p className="text-xs text-muted-foreground">
          {m.tasks.unestimatedTasks(load.unestimated)}
        </p>
      )}
      {load.tasks.length > 0 && <TaskLines tasks={load.tasks} onShowTask={onShowTask} />}
    </li>
  );
}

function TaskLines({ tasks, onShowTask }: { tasks: Task[]; onShowTask: (id: TaskId) => void }) {
  const { m, locale } = useI18n();
  return (
    <ul className="flex flex-col text-sm">
      {tasks.map((task) => (
        // A title too long to share its line with the estimate keeps the line, and the estimate moves below it.
        <li key={task.id} className="flex flex-wrap items-baseline gap-x-2 py-0.5">
          <button
            type="button"
            className={cn(
              "min-w-0 truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11",
              task.status === "done" && "text-muted-foreground line-through",
            )}
            onClick={() => onShowTask(task.id)}
          >
            <span className="tabular-nums text-muted-foreground">#{task.id}</span> {task.title}
          </button>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {task.estimate === null ? m.tasks.missingPlan.estimate : formatEstimate(task.estimate, m)}
            {task.dueDate !== null && m.tasks.planDueDate(formatDueDate(task.dueDate, locale))}
          </span>
        </li>
      ))}
    </ul>
  );
}
