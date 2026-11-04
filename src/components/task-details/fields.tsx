import { GitMerge, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compactSelectClass } from "@/components/workspace-list";
import type { SheetNavigation } from "@/components/task-graph";
import type { MergedWith, Task, TaskId } from "@/lib/bindings";
import {
  useAddRelation,
  useBranchFreshness,
  useCommitRecords,
  useRemoveRelation,
  useTaskRelations,
} from "@/lib/queries";
import { freshnessWarning, isPaused } from "@/lib/task-graph";
import { reachedMilestones } from "@/lib/timeline";
import { When } from "@/components/when";
import { formatEstimate } from "@/lib/plan";
import { toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { type TaskContext, taskRef, DueDate, DetailField, useServerDown } from "@/components/task-common";


export function TaskTimeline({ task, detailed }: { task: Task; detailed: boolean }) {
  const milestones = reachedMilestones(task.milestones);
  if (milestones.length === 0) {
    return null;
  }
  if (detailed) {
    return (
      <DetailField label="Timeline">
        <dl aria-label={`Timeline of #${task.id}`} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {milestones.map(({ label, at }) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <When at={at} />
              </dd>
            </div>
          ))}
        </dl>
      </DetailField>
    );
  }
  return (
    <p aria-label={`Timeline of #${task.id}`} className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
      {milestones.map(({ label, at }) => (
        <When key={label} at={at} prefix={`${label} `} />
      ))}
    </p>
  );
}

/** The status of `task` as a pill with a colored dot. */
/** Warns when a started task's branch is behind its base, e.g. after a prerequisite was merged. */
export function BranchFreshnessNote({ taskId }: { taskId: TaskId }) {
  const freshness = useBranchFreshness(taskId, true);
  const label = `Base freshness of #${taskId}`;
  // After syncing the branch outside Toodo, the warning is checked again right away.
  const recheck = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="ml-1.5 h-5 px-1.5 align-middle"
      aria-label={`Recheck base freshness of #${taskId}`}
      title="Check again whether the branch is behind its base"
      disabled={freshness.isFetching}
      onClick={() => void freshness.refetch()}
    >
      <RefreshCw className={cn("size-3", freshness.isFetching && "animate-spin")} />
      Recheck
    </Button>
  );
  if (freshness.error) {
    return (
      <p role="note" aria-label={label} className="text-xs text-muted-foreground" title={freshness.error.message}>
        Could not check whether the branch is behind its base
        {recheck}
      </p>
    );
  }
  const data = freshness.data;
  const warning = data ? freshnessWarning(data) : null;
  if (!data || warning === null) {
    return null;
  }
  const conflicting = data.mergeable === "conflicting";
  return (
    <p
      role="note"
      aria-label={label}
      data-conflicting={conflicting || undefined}
      className={cn(
        "text-xs",
        conflicting ? toneText.danger : toneText.attention,
      )}
      title={
        [data.fetchError && `Fetching origin failed: ${data.fetchError}`, data.mergeableError]
          .filter(Boolean)
          .join("\n") || undefined
      }
    >
      {warning}
      {data.fetchError && " (not up to date: fetching origin failed)"}
      {recheck}
    </p>
  );
}

/** A labeled block of the task details sheet. */
/**
 * The pull request, or the other task without a recorded one, that shipped a task done
 * without a pull request of its own.
 */
export function ShippedWith({
  task,
  mergedWith,
  through,
  detailed,
}: {
  task: Task;
  mergedWith: MergedWith;
  through: string | null;
  detailed: boolean;
}) {
  const url = mergedWith.pullRequestUrl;
  if (url === null) {
    // The other task shipped the work without a pull request Toodo recorded.
    const label = `Shipped with task of #${task.id}`;
    return detailed ? (
      <DetailField label="Shipped with">
        <span aria-label={label}>{through ?? "A deleted task"}</span>
      </DetailField>
    ) : (
      <p className="flex min-w-0 items-center gap-1 text-xs">
        <GitMerge aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">Shipped with</span>
        <span aria-label={label}>{through ?? "a deleted task"}</span>
      </p>
    );
  }
  const label = `Shipped with pull request of #${task.id}`;
  if (detailed) {
    return (
      <DetailField label="Shipped with">
        <span aria-label={label} className="break-all font-mono select-all">
          {url}
        </span>
        {through && <span className="text-muted-foreground">Pull request of {through}</span>}
      </DetailField>
    );
  }
  return (
    <p className="flex min-w-0 items-center gap-1 text-xs">
      <GitMerge aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">Shipped with</span>
      <span aria-label={label} className="truncate select-all font-mono">
        {url}
      </span>
      {through && <span className="shrink-0 text-muted-foreground">of {through}</span>}
    </p>
  );
}

/**
 * Related tasks of the details sheet: earlier work an agent or the owner linked, in any
 * workspace. Links neither block nor wait. Without links only the add control shows.
 */
export function RelatedTasks({
  task,
  tasks,
  context,
  navigation,
}: {
  task: Task;
  tasks: Task[];
  context: TaskContext;
  navigation?: SheetNavigation;
}) {
  const relations = useTaskRelations();
  const addRelation = useAddRelation();
  const removeRelation = useRemoveRelation();
  const related = (relations.data ?? [])
    .flatMap(({ taskId, relatedId }) => (taskId === task.id ? [relatedId] : relatedId === task.id ? [taskId] : []))
    .filter((id) => context.byId.has(id));
  const candidates = tasks.filter((other) => other.id !== task.id && !related.includes(other.id));
  const groups = [...new Set([task.workspaceId, ...candidates.map((other) => other.workspaceId)])]
    .map((workspaceId) => ({ workspaceId, tasks: candidates.filter((other) => other.workspaceId === workspaceId) }))
    .filter((group) => group.tasks.length > 0);
  const serverDown = useServerDown();
  const busy = addRelation.isPending || removeRelation.isPending || serverDown;
  const failure = addRelation.error ?? removeRelation.error;
  if (related.length === 0 && groups.length === 0) {
    return null;
  }
  const picker = groups.length > 0 && (
    <select
      aria-label={`Add related task to #${task.id}`}
      className={cn(compactSelectClass, "max-w-48")}
      value=""
      disabled={busy}
      onChange={(event) => {
        if (event.target.value) {
          addRelation.mutate({ taskId: task.id, relatedId: Number(event.target.value) });
        }
      }}
    >
      <option value="">Add related task...</option>
      {groups.map((group) => (
        <optgroup key={group.workspaceId} label={context.workspaceName(group.workspaceId)}>
          {group.tasks.map((other) => (
            <option key={other.id} value={other.id}>
              #{other.id} {other.title}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
  const error = failure && (
    <p role="alert" className="text-destructive">
      {failure.message}
    </p>
  );
  if (related.length === 0) {
    return (
      <div className="flex flex-col gap-1 text-xs">
        {picker}
        {error}
      </div>
    );
  }
  return (
    <DetailField label="Related">
      <ul aria-label={`Related tasks of #${task.id}`} className="flex flex-wrap items-center gap-1 max-md:gap-2">
        {related.map((id) => {
          const other = context.byId.get(id);
          const label = taskRef(id, task.workspaceId, context);
          return (
            <li key={id} className="inline-flex h-6 min-w-0 items-center rounded-md border max-md:h-11 max-md:gap-2 max-md:border-0">
              <button
                type="button"
                aria-label={`Open related task ${label}`}
                title={other?.title}
                className="h-full min-w-0 max-w-56 truncate rounded-l-md px-1.5 tabular-nums hover:bg-muted max-md:rounded-md max-md:border max-md:px-3 disabled:cursor-default disabled:hover:bg-transparent"
                disabled={navigation === undefined || !navigation.canOpen(id)}
                onClick={() => navigation?.open(id)}
              >
                {label} {other?.title}
              </button>
              <button
                type="button"
                aria-label={`Remove related task #${id} from #${task.id}`}
                title="Remove related task"
                className="flex h-full items-center justify-center rounded-r-md p-1 text-muted-foreground hover:bg-muted max-md:w-11 max-md:rounded-md max-md:border hover:text-foreground disabled:opacity-50"
                disabled={busy}
                onClick={() => removeRelation.mutate({ taskId: task.id, relatedId: id })}
              >
                <X className="size-3" />
              </button>
            </li>
          );
        })}
        {picker}
      </ul>
      {error}
    </DetailField>
  );
}

export function CommitList({ task, detailed }: { task: Task; detailed: boolean }) {
  const recorded = task.status !== "planned" || isPaused(task);
  const commits = useCommitRecords(task.id, recorded);

  if (commits.isError) {
    return (
      <p role="alert" className="text-xs text-destructive">
        Failed to load commits: {commits.error.message}
      </p>
    );
  }
  if (!commits.data || commits.data.length === 0) {
    return null;
  }
  const list = (
    <ul aria-label={`Commits of #${task.id}`} className={cn("flex flex-col gap-0.5", !detailed && "mt-1")}>
      {commits.data.map((commit) => (
        <li key={commit.sha} className="flex gap-2 text-xs" title={commit.author}>
          <code className="shrink-0 text-muted-foreground">{commit.sha.slice(0, 7)}</code>
          <span className={detailed ? "min-w-0 break-words-keep" : "truncate"}>{commit.message.split("\n", 1)[0]}</span>
        </li>
      ))}
    </ul>
  );
  return detailed ? <DetailField label={`Commits (${commits.data.length})`}>{list}</DetailField> : list;
}

/** A task's estimate and due date, the due date in red once it is missed. */
export function TaskPlan({ task }: { task: Task }) {
  if (task.estimate === null && task.dueDate === null) return null;
  return (
    <p aria-label={`Plan of #${task.id}`} className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
      {task.estimate !== null && <span>Estimate {formatEstimate(task.estimate)}</span>}
      {task.dueDate !== null && <DueDate task={task} />}
    </p>
  );
}
