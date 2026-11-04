import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import { CollapsibleForm } from "@/components/collapsible-form";
import { MarkdownEditor } from "@/components/markdown-editor";
import type { TaskType, Workspace } from "@/lib/bindings";
import { IssueLinkFailure, useCreateTask } from "@/lib/queries";
import { parseLabels } from "@/lib/plan";
import { cn } from "@/lib/utils";
import { workspaceCapabilities } from "@/lib/workspace-capabilities";
import { taskTypes } from "@/components/task-common";
import { parseIssueNumber } from "@/components/task-issue";
import { type PlanDraft, planEstimate, PlanFields } from "@/components/plan-fields";
import { type CriterionDraft, criterionInputs, targetProblem, CriteriaEditor } from "@/components/criteria-editor";


export type TaskDraft = {
  taskType: TaskType;
  title: string;
  description: string;
  issue: string;
  /** Rows of the criteria editor; blank ones are left out when the task is added. */
  criteria: CriterionDraft[];
  /** Whether the backend puts the merge criterion first. */
  mergeCriterion: boolean;
} & PlanDraft;

export const emptyDraft: TaskDraft = {
  taskType: "feat",
  title: "",
  description: "",
  issue: "",
  criteria: [],
  mergeCriterion: true,
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
  const capabilities = workspaceCapabilities(workspace);
  const [expanded, setExpanded] = useState(false);
  const { taskType, title, description, issue } = draft;
  const issueNumber = parseIssueNumber(issue);
  const invalidIssue = issue.trim() !== "" && issueNumber === null;
  const estimate = planEstimate(draft);
  const criteriaInvalid = draft.criteria.some((criterion) => targetProblem(criterion) !== null);
  const setTaskType = (value: TaskType) => onChange({ ...draft, taskType: value });
  const setTitle = (value: string) => onChange({ ...draft, title: value });
  const setDescription = (value: string) => onChange({ ...draft, description: value });
  const setIssue = (value: string) => onChange({ ...draft, issue: value });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (estimate === undefined || criteriaInvalid) return;
    const added = () => {
      onChange({ ...draft, title: "", description: "", issue: "", estimate: "", dueDate: "", labels: "", criteria: [] });
      setExpanded(false);
    };
    createTask.mutate(
      {
        workspaceId: workspace.id,
        taskType,
        title,
        description,
        estimate,
        dueDate: draft.dueDate || null,
        labels: parseLabels(draft.labels),
        criteria: criterionInputs(draft.criteria),
        // Tasks completed without a merge get no merge criterion.
        mergeCriterion: capabilities.merge && draft.mergeCriterion,
        issue: issueNumber,
      },
      {
        onSuccess: added,
        // The task exists even though its issue was not linked; adding it again would duplicate it.
        onError: (error) => error instanceof IssueLinkFailure && added(),
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
        <Button type="submit" disabled={createTask.isPending || invalidIssue || estimate === undefined || criteriaInvalid}>
          <Plus />
          Add task
        </Button>
      </div>
      {expanded && (
        <>
          <div className="flex items-start gap-2">
            <MarkdownEditor
              label="Description"
              placeholder="Description (optional, Markdown)"
              value={description}
              onChange={setDescription}
              className="flex-1"
            />
            {capabilities.github && (
              <input
                className={cn(inputClass, "mt-7 w-36 shrink-0 max-md:mt-13")}
                inputMode="numeric"
                placeholder="Issue # (optional)"
                aria-label="Issue number"
                aria-invalid={invalidIssue}
                title="An issue of the workspace repository; the pull request closes it on merge"
                value={issue}
                onChange={(e) => setIssue(e.target.value)}
              />
            )}
          </div>
          <PlanFields
            suffix=""
            plan={draft}
            onChange={(plan) => onChange({ ...draft, ...plan })}
          />
          <div className="flex flex-col gap-1 border-t pt-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-medium text-muted-foreground">Completion criteria</span>
              {capabilities.merge && (
                <label
                  className="flex items-center gap-1.5 max-md:min-h-11"
                  title="Add the criterion that its pull request is merged, or its branch merged locally in a repository without origin"
                >
                  <input
                    type="checkbox"
                    checked={draft.mergeCriterion}
                    onChange={(e) => onChange({ ...draft, mergeCriterion: e.target.checked })}
                  />
                  Done when merged
                </label>
              )}
            </div>
            <CriteriaEditor
              capabilities={capabilities}
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
