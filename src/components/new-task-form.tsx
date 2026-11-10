import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import { CollapsibleForm } from "@/components/collapsible-form";
import { MarkdownEditor } from "@/components/markdown-editor";
import type { TaskType, Workspace } from "@/lib/bindings";
import { useCreateTask } from "@/lib/queries";
import { parseLabels } from "@/lib/plan";
import { cn } from "@/lib/utils";
import { taskTypes } from "@/components/task-common";
import { AutopilotField, type PlanDraft, planEstimate, PlanFields } from "@/components/plan-fields";
import { type CriterionDraft, criterionInputs, targetProblem, CriteriaEditor } from "@/components/criteria-editor";


export type TaskDraft = {
  taskType: TaskType;
  title: string;
  description: string;
  /** Rows of the criteria editor; blank ones are left out when the task is added. */
  criteria: CriterionDraft[];
  /** Whether the task is marked for autopilot from its creation on. */
  autopilot: boolean;
} & PlanDraft;

export const emptyDraft: TaskDraft = {
  taskType: "feat",
  title: "",
  description: "",
  criteria: [],
  autopilot: false,
  estimate: "",
  estimateUnit: "hours",
  dueDate: "",
  labels: "",
};

export function NewTaskForm({
  workspace,
  draft,
  onChange,
}: {
  workspace: Workspace;
  draft: TaskDraft;
  onChange: (draft: TaskDraft) => void;
}) {
  const createTask = useCreateTask();
  const [expanded, setExpanded] = useState(false);
  const { taskType, title, description } = draft;
  const estimate = planEstimate(draft);
  const criteriaInvalid = draft.criteria.some((criterion) => targetProblem(criterion) !== null);
  const setTaskType = (value: TaskType) => onChange({ ...draft, taskType: value });
  const setTitle = (value: string) => onChange({ ...draft, title: value });
  const setDescription = (value: string) => onChange({ ...draft, description: value });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (estimate === undefined || criteriaInvalid) return;
    createTask.mutate(
      {
        workspaceId: workspace.id,
        taskType,
        title,
        description,
        estimate,
        dueDate: draft.dueDate || null,
        labels: parseLabels(draft.labels),
        autopilot: draft.autopilot,
        criteria: criterionInputs(draft.criteria),
      },
      {
        onSuccess: () => {
          onChange({
            ...draft,
            title: "",
            description: "",
            estimate: "",
            dueDate: "",
            labels: "",
            criteria: [],
            autopilot: false,
          });
          setExpanded(false);
        },
      },
    );
  }

  return (
    <CollapsibleForm label="New task" expanded={expanded} onExpandedChange={setExpanded} onSubmit={submit}>
      <div className="flex gap-2">
        {expanded && (
          <select
            aria-label="Task type"
            className={cn(inputClass, "w-28 shrink-0 font-mono")}
            value={taskType}
            onChange={(e) => setTaskType(e.target.value as TaskType)}
          >
            {taskTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        )}
        <input
          className={cn(inputClass, "min-w-0")}
          placeholder={expanded ? "Task title" : "New task"}
          aria-label="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <Button type="submit" disabled={createTask.isPending || estimate === undefined || criteriaInvalid}>
          <Plus />
          Add task
        </Button>
      </div>
      {expanded && (
        <>
          <MarkdownEditor
            label="Description"
            placeholder="Description (optional, Markdown)"
            value={description}
            onChange={setDescription}
            className="flex-1"
          />
          <PlanFields
            suffix=""
            plan={draft}
            onChange={(plan) => onChange({ ...draft, ...plan })}
          />
          <AutopilotField
            suffix=""
            checked={draft.autopilot}
            onChange={(autopilot) => onChange({ ...draft, autopilot })}
          />
          <div className="flex flex-col gap-1 border-t pt-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-medium text-muted-foreground">Completion criteria</span>
            </div>
            <CriteriaEditor
              criteria={draft.criteria}
              onChange={(criteria) => onChange({ ...draft, criteria })}
            />
          </div>
        </>
      )}
      {createTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {createTask.error.message}
        </p>
      )}
    </CollapsibleForm>
  );
}
