import { lazy, useSyncExternalStore, type ReactNode } from "react";
import type { Task, TaskId, TaskType, WorkspaceId } from "@/lib/bindings";
import { shownStatus, type ShownStatus } from "@/lib/task-filter";
import { dueState, dueStateLabels, type MissingPlanField, missingPlan, missingPlanLabel } from "@/lib/plan";
import { statusNames, toneChip, toneText, type Tone } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { type WorkspaceCapabilities } from "@/lib/workspace-capabilities";
import { reachability, subscribeReachability } from "@/web/connection";

export const Markdown = lazy(() => import("@/components/markdown"));

export const taskTypes: TaskType[] = ["feat", "fix", "modify", "refactor", "docs", "test", "chore", "rnd"];

/**
 * The status of `task`, naming a planned task that can be started now "Ready", one still
 * waiting on a prerequisite "Blocked", one that was worked on before "Paused" and a task
 * concluded without merging "Not adopted".
 */
export function statusLabel(task: Task, byId: ReadonlyMap<TaskId, Task>): string {
  if (task.status === "done" && task.resolution === "completed") return "Completed";
  return statusNames[shownStatus(task, byId)];
}

/** The tone of each shown status, shared by the status chips and the status filter. */
export const statusTones: Record<ShownStatus, Tone> = {
  planned: "neutral",
  ready: "attention",
  paused: "neutral",
  in_progress: "progress",
  in_review: "review",
  done: "success",
  not_adopted: "neutral",
};

/** Not adopted is a valid end of research, not a failure: neutral, outlined to tell it from planned. */
const notAdoptedStyle = cn(toneChip.neutral, "ring-1 ring-inset ring-muted-foreground/40");

/** The filled chip of a shown status. */
export function shownStatusStyle(status: ShownStatus): string {
  return status === "not_adopted" ? notAdoptedStyle : toneChip[statusTones[status]];
}

/** The Complete button, in the colour of the done status it leads to; still tinted while disabled. */
export const completeStyle = cn(
  shownStatusStyle("done"),
  "border-transparent hover:bg-emerald-200 dark:hover:bg-emerald-900 disabled:bg-emerald-100 disabled:opacity-60 dark:disabled:bg-emerald-950",
);

export function statusStyle(task: Task, byId: ReadonlyMap<TaskId, Task>): string {
  return shownStatusStyle(shownStatus(task, byId));
}

/** What the task list needs to name tasks of other workspaces and to know what their workspaces have. */
export type TaskContext = {
  /** Tasks of every workspace, by ID. */
  byId: ReadonlyMap<TaskId, Task>;
  workspaceName: (id: WorkspaceId) => string;
  /** What the tasks of a workspace have, such as pull requests or herdr. */
  capabilities: (id: WorkspaceId) => WorkspaceCapabilities;
  /** Whether the workspace is on an SSH machine, whose agent CLIs the server does not check. */
  remote: (id: WorkspaceId) => boolean;
};

/** `#id`, prefixed with the workspace name when the task belongs to another workspace than `of`. */
export function taskRef(id: TaskId, of: WorkspaceId, { byId, workspaceName }: TaskContext): string {
  const other = byId.get(id);
  return other === undefined || other.workspaceId === of ? `#${id}` : `${workspaceName(other.workspaceId)} #${id}`;
}

export function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-0.5 text-xs">
      <h4 className="font-medium text-muted-foreground">{label}</h4>
      {children}
    </section>
  );
}

/** The due date of a task, flagged when it is late or overdue. */
export function DueDate({ task }: { task: Task }) {
  const state = dueState(task, Date.now() / 1000);
  const behind = state === "late" || state === "overdue";
  return (
    <span data-due-state={state ?? undefined} className={cn(behind && cn("font-medium", toneText.danger))}>
      {state === null || state === "upcoming" ? "Due" : dueStateLabels[state]} {task.dueDate}
    </span>
  );
}

/**
 * Names the estimate or due date a task lacks, which leaves it out of the review's plan
 * comparison; clicking it opens the edit form at the first missing field. Nothing when the
 * task has both.
 */
export function MissingPlanMark({ task, onEdit }: { task: Task; onEdit: (field: MissingPlanField) => void }) {
  const missing = missingPlan(task);
  const label = missingPlanLabel(missing);
  if (label === null) return null;
  return (
    <button
      type="button"
      aria-label={`Edit plan of #${task.id}: ${label.toLowerCase()}`}
      title="Reviews compare estimates and due dates with what happened; add them"
      data-missing-plan={missing.join(" ")}
      className="cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11"
      onClick={() => onEdit(missing[0])}
    >
      {label}
    </button>
  );
}

/**
 * One criterion of a task. A manual one of a task that is not done is a checkbox: checking
 * asks for optional evidence before it is saved, unchecking saves right away.
 */
/** Whether the server does not answer: controls that change data at once wait meanwhile, like buttons do. */
export function useServerDown(): boolean {
  const reach = useSyncExternalStore(subscribeReachability, reachability);
  return reach === "unreachable" || reach === "retrying";
}

/** The labels of a task as chips. */
export function TaskLabels({ task, className }: { task: Task; className?: string }) {
  if (task.labels.length === 0) return null;
  return (
    <ul aria-label={`Labels of #${task.id}`} className={cn("flex flex-wrap gap-1", className)}>
      {task.labels.map((label) => (
        <li key={label} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
          {label}
        </li>
      ))}
    </ul>
  );
}
