import { X } from "lucide-react";
import { compactSelectClass } from "@/components/workspace-list";
import type { SheetNavigation } from "@/components/task-graph";
import type { Task, TaskEvent } from "@/lib/bindings";
import { useAddRelation, useRemoveRelation, useTaskRelations } from "@/lib/queries";
import { reachedMilestones } from "@/lib/timeline";
import { When } from "@/components/when";
import { formatEstimate } from "@/lib/plan";
import { cn } from "@/lib/utils";
import { type TaskContext, taskRef, DueDate, DetailField, TaskLabels, useServerDown } from "@/components/task-common";
import { openUrl } from "@/web/opener";

/** What a status change with a reason did, e.g. `Started` or `Paused`. */
function eventLabel(event: TaskEvent): string {
  switch (event.status) {
    case "in_progress":
      return "Started";
    case "in_review":
      return "In review";
    case "done":
      return "Completed";
    case "planned":
      return event.reopened ? "Reopened" : "Paused";
  }
}

/** The status changes of `task` that were recorded with a reason, oldest first. */
function TaskReasons({ task }: { task: Task }) {
  const reasons = task.timeline.filter((event) => event.reason !== null);
  if (reasons.length === 0) {
    return null;
  }
  return (
    <ol aria-label={`Reasons of #${task.id}`} className="mt-1 flex flex-col gap-0.5">
      {reasons.map((event, index) => (
        <li key={index} className="flex min-w-0 items-baseline gap-2 max-md:flex-wrap max-md:gap-y-0">
          <When className="shrink-0 text-muted-foreground" at={event.at} />
          <span className="shrink-0 font-medium">{eventLabel(event)}</span>
          <span className="min-w-0 whitespace-pre-line break-words-keep max-md:basis-full">{event.reason}</span>
        </li>
      ))}
    </ol>
  );
}

/** The prefixes of references Toodo names, e.g. `lane:search` as Lane `search`. */
const refKinds: Record<string, string> = { lane: "Lane", discord: "Discord", pr: "PR" };

/** One reference of a task: a URL as a link, a known `<kind>:<value>` with its kind as a label. */
function TaskRef({ value }: { value: string }) {
  if (/^https?:\/\//i.test(value)) {
    const open = (event: { preventDefault: () => void }) => {
      event.preventDefault();
      openUrl(value).catch((error: unknown) => console.error(`Failed to open ${value}`, error));
    };
    return (
      <a
        href={value}
        onClick={open}
        onAuxClick={open}
        className="min-w-0 break-all text-primary underline underline-offset-2 hover:no-underline"
      >
        {value}
      </a>
    );
  }
  const separator = value.indexOf(":");
  const kind = separator > 0 ? refKinds[value.slice(0, separator)] : undefined;
  if (kind === undefined) {
    return <code className="min-w-0 break-all">{value}</code>;
  }
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="shrink-0 text-muted-foreground">{kind}</span>
      <code className="min-w-0 break-all">{value.slice(separator + 1)}</code>
    </span>
  );
}

/** Where the work of a task is tracked or discussed, in the order the references were added. */
export function TaskRefs({ task }: { task: Task }) {
  if (task.refs.length === 0) {
    return null;
  }
  return (
    <DetailField label="Refs">
      <ul aria-label={`Refs of #${task.id}`} className="flex flex-col gap-0.5">
        {task.refs.map((value) => (
          <li key={value} className="flex min-w-0">
            <TaskRef value={value} />
          </li>
        ))}
      </ul>
    </DetailField>
  );
}


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
        <TaskReasons task={task} />
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

/** A task's estimate and due date, the due date in red once it is missed. */
export function TaskPlan({ task }: { task: Task }) {
  return (
    <>
      {(task.estimate !== null || task.dueDate !== null) && (
        <p aria-label={`Plan of #${task.id}`} className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {task.estimate !== null && <span>Estimate {formatEstimate(task.estimate)}</span>}
          {task.dueDate !== null && <DueDate task={task} />}
        </p>
      )}
      <TaskLabels task={task} />
      <TaskRefs task={task} />
    </>
  );
}
