import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import { MarkdownEditor } from "@/components/markdown-editor";
import type { Task, TaskType } from "@/lib/bindings";
import { useUpdateTask } from "@/lib/queries";
import { formatLabels, type MissingPlanField, parseLabels } from "@/lib/plan";
import { cn } from "@/lib/utils";
import { taskTypes } from "@/components/task-common";
import { type PlanDraft, planEstimate, PlanFields } from "@/components/plan-fields";
import {
  type CriterionDraft,
  criterionDraft,
  criterionInputs,
  targetProblem,
  CriteriaEditor,
} from "@/components/criteria-editor";


export function TaskEditForm({
  task,
  focusPlan,
  onDone,
}: {
  task: Task;
  /** The plan field that takes the focus instead of the title, e.g. when adding a missing estimate. */
  focusPlan?: MissingPlanField;
  onDone: () => void;
}) {
  const updateTask = useUpdateTask();
  const [taskType, setTaskType] = useState<TaskType>(task.taskType);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [initialPlan] = useState<PlanDraft>(() => ({
    estimate: task.estimate === null ? "" : String(task.estimate.amount),
    estimateUnit: task.estimate?.unit ?? "hours",
    dueDate: task.dueDate ?? "",
    labels: formatLabels(task.labels),
  }));
  const [plan, setPlan] = useState<PlanDraft>(initialPlan);
  const labelsChanged = formatLabels(parseLabels(plan.labels)) !== formatLabels(task.labels);
  const [initialCriteria] = useState(() => task.criteria.map((criterion) => criterionDraft(criterion)));
  const [criteria, setCriteria] = useState<CriterionDraft[]>(initialCriteria);
  const estimate = planEstimate(plan);
  // Unchanged criteria are not sent, so a save never touches the ones checked so far.
  const criteriaChanged =
    JSON.stringify(criterionInputs(criteria)) !== JSON.stringify(criterionInputs(initialCriteria));
  const criteriaInvalid = criteria.some((draft) => targetProblem(draft) !== null);
  // The timeline asks before closing a details sheet whose edit form is marked dirty.
  const dirty =
    taskType !== task.taskType ||
    title !== task.title ||
    description !== task.description ||
    plan.estimate !== initialPlan.estimate ||
    plan.estimateUnit !== initialPlan.estimateUnit ||
    plan.dueDate !== initialPlan.dueDate ||
    plan.labels !== initialPlan.labels ||
    criteriaChanged;
  const guard = useDiscardGuard(dirty, onDone, updateTask.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (estimate === undefined || criteriaInvalid) return;
    updateTask.mutate(
      {
        status: null,
        id: task.id,
        taskType,
        title: title.trim(),
        description: description.trim(),
        estimate,
        dueDate: plan.dueDate || null,
        labels: labelsChanged ? parseLabels(plan.labels) : null,
        // The criteria of a done task cannot change.
        criteria: criteriaChanged && task.status !== "done" ? criterionInputs(criteria) : null,
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Edit task #${task.id}`}
      data-dirty={dirty || undefined}
      className="flex flex-col gap-1 max-md:gap-2"
      onKeyDown={guard.onKeyDown}
    >
      <div className="flex gap-2">
        <select
          aria-label={`Type of #${task.id}`}
          className={cn(inputClass, "w-28")}
          value={taskType}
          onChange={(e) => setTaskType(e.target.value as TaskType)}
        >
          {taskTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          aria-label={`Title of #${task.id}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus={focusPlan === undefined}
        />
      </div>
      <MarkdownEditor
        label={`Description of #${task.id}`}
        placeholder="Description (optional, Markdown)"
        value={description}
        onChange={setDescription}
      />
      <PlanFields suffix={` of #${task.id}`} plan={plan} onChange={setPlan} autoFocus={focusPlan} />
      {task.status !== "done" && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-muted-foreground">Completion criteria</span>
          </div>
          <CriteriaEditor taskId={task.id} criteria={criteria} onChange={setCriteria} />
        </div>
      )}
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard changes to #${task.id}`}
          question={`Discard your changes to #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1 max-md:gap-2">
          <Button type="submit" size="xs" disabled={updateTask.isPending || estimate === undefined || criteriaInvalid}>
            {updateTask.isPending ? "Saving..." : "Save"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Discard
          </Button>
        </div>
      )}
      {updateTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {updateTask.error.message}
        </p>
      )}
    </form>
  );
}
