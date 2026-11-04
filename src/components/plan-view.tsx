import { useState } from "react";
import { Button } from "@/components/ui/button";
import { compactSelectClass } from "@/components/workspace-list";
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
import { formatEstimate, parseEstimateAmount } from "@/lib/plan";
import { formatDate } from "@/lib/timeline";
import { cn } from "@/lib/utils";

const scaleNames: Record<PlanScale, string> = { quarter: "Quarter", year: "Year" };
const unitNames: Record<EstimateUnit, string> = { hours: "hours", days: "days", weeks: "weeks", months: "months" };

/**
 * The estimates of `tasks` summed per quarter or year of their due dates, against a capacity
 * per quarter saved in this browser, so a plan that does not fit shows before it slips.
 */
export function PlanView({ tasks, onShowTask }: { tasks: Task[]; onShowTask: (id: TaskId) => void }) {
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
  const { periods, unscheduled, unscheduledEstimated } = planLoad(tasks, scale, capacity, formatDate(Date.now() / 1000));
  const overloaded = periods.filter((period) => period.overloaded).length;

  return (
    <div role="region" aria-label="Plan" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Plan period" className="flex gap-1 max-md:gap-2">
          {(["quarter", "year"] as const).map((option) => (
            <Button
              key={option}
              size="xs"
              variant={scale === option ? "secondary" : "ghost"}
              aria-pressed={scale === option}
              onClick={() => setScale(option)}
            >
              {scaleNames[option]}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground max-md:text-sm">
          Capacity per quarter
          <input
            type="text"
            inputMode="decimal"
            aria-label="Capacity per quarter"
            aria-invalid={Number.isNaN(amount) || undefined}
            aria-describedby="capacity-hint"
            placeholder="None"
            className={cn(compactSelectClass, "w-16")}
            value={amountText}
            onChange={(event) => changeCapacity(event.target.value, unit)}
          />
        </label>
        <select
          aria-label="Capacity unit"
          className={compactSelectClass}
          value={unit}
          onChange={(event) => changeCapacity(amountText, event.target.value as EstimateUnit)}
        >
          {(Object.keys(unitNames) as EstimateUnit[]).map((option) => (
            <option key={option} value={option}>
              {unitNames[option]}
            </option>
          ))}
        </select>
      </div>
      <p id="capacity-hint" className={cn("text-xs", Number.isNaN(amount) ? "text-destructive" : "text-muted-foreground")}>
        {Number.isNaN(amount)
          ? "Enter a capacity greater than 0 and at most 10000, such as 12, or clear the field for no capacity."
          : capacity === null
            ? "Set a capacity per quarter to see which periods are overloaded. A year holds four quarters."
            : overloaded > 0
              ? `${overloaded} ${overloaded === 1 ? "period is" : "periods are"} over capacity: move due dates or cut estimates.`
              : "Every period fits its capacity."}
      </p>
      <ol aria-label="Periods" className="flex flex-col gap-3">
        {periods.map((load) => (
          <PeriodCard key={load.period.from} load={load} unit={shownUnit} onShowTask={onShowTask} />
        ))}
      </ol>
      {unscheduled.length > 0 && (
        <section aria-label="No due date" className="flex flex-col gap-2 rounded-xl border border-dashed p-3">
          <h3 className="flex items-baseline gap-2 text-sm font-medium">
            No due date
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {unscheduled.length} {unscheduled.length === 1 ? "task" : "tasks"}, {formatWork(unscheduledEstimated, shownUnit)}{" "}
              estimated
            </span>
          </h3>
          <p className="text-xs text-muted-foreground">Set a due date on these tasks to count them in a period.</p>
          <TaskLines tasks={unscheduled} onShowTask={onShowTask} />
        </section>
      )}
    </div>
  );
}

function PeriodCard({ load, unit, onShowTask }: { load: PeriodLoad; unit: EstimateUnit; onShowTask: (id: TaskId) => void }) {
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
          {formatWork(estimated, unit)}
          {capacity !== null && <span className="text-muted-foreground"> of {formatWork(capacity, unit)}</span>}
          {share !== null && <span className="text-muted-foreground"> ({Math.round(share * 100)}%)</span>}
        </span>
        {overloaded && capacity !== null && (
          <span className="text-xs font-medium text-destructive">Over capacity by {formatWork(estimated - capacity, unit)}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {load.tasks.length} {load.tasks.length === 1 ? "task" : "tasks"}
          {load.done > 0 && `, ${formatWork(load.done, unit)} done`}
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
          {load.unestimated} {load.unestimated === 1 ? "task has" : "tasks have"} no estimate and {load.unestimated === 1 ? "is" : "are"} not
          counted: estimate {load.unestimated === 1 ? "it" : "them"} to complete the sum.
        </p>
      )}
      {load.tasks.length > 0 && <TaskLines tasks={load.tasks} onShowTask={onShowTask} />}
    </li>
  );
}

function TaskLines({ tasks, onShowTask }: { tasks: Task[]; onShowTask: (id: TaskId) => void }) {
  return (
    <ul className="flex flex-col text-sm">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-baseline gap-2 py-0.5">
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
            {task.estimate === null ? "No estimate" : formatEstimate(task.estimate)}
            {task.dueDate !== null && ` · due ${task.dueDate}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
