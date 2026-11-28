import type { Messages } from "@/locales/en";
import { useMessages } from "@/lib/i18n";
import { Bot, X } from "lucide-react";
import { Selector } from "@astryxdesign/core/Selector";
import { Button, IconButton } from "@/components/button";
import type { SheetNavigation } from "@/components/task-graph";
import type { Task, TaskEvent } from "@/lib/bindings";
import {
  useAddRelation,
  useMoveTask,
  useRemoveRelation,
  useTaskRelations,
  useUpdateTask,
  useWorkspaces,
} from "@/lib/queries";
import { reachedMilestones } from "@/lib/timeline";
import { When } from "@/components/when";
import { formatEstimate } from "@/lib/plan";
import { type TaskContext, taskRef, DueDate, DetailField, TaskLabels, useServerDown } from "@/components/task-common";
import { openUrl } from "@/web/opener";

/** What a status change with a reason did, e.g. `Started` or `Paused`. */
function eventLabel(event: TaskEvent, m: Messages): string {
  switch (event.status) {
    case "in_progress":
      return m.details.milestones.startedAt;
    case "in_review":
      return m.details.fields.inReview;
    case "done":
      return m.details.milestones.completedAt;
    case "planned":
      return event.reopened ? m.details.milestones.reopenedAt : m.details.milestones.pausedAt;
  }
}

/** The status changes of `task` that were recorded with a reason, oldest first. */
function TaskReasons({ task }: { task: Task }) {
  const m = useMessages();
  const reasons = task.timeline.filter((event) => event.reason !== null);
  if (reasons.length === 0) {
    return null;
  }
  return (
    <ol aria-label={m.details.fields.reasons(task.id)} className="mt-1 flex flex-col gap-0.5">
      {reasons.map((event, index) => (
        <li key={index} className="flex min-w-0 items-baseline gap-2 max-md:flex-wrap max-md:gap-y-0">
          <When className="shrink-0 text-muted-foreground" at={event.at} />
          <span className="shrink-0 font-medium">{eventLabel(event, m)}</span>
          <span className="min-w-0 whitespace-pre-line break-words-keep max-md:basis-full">{event.reason}</span>
        </li>
      ))}
    </ol>
  );
}

/** The prefixes of references Toodo names, e.g. `lane:search` as Lane `search`. */

/** One reference of a task: a URL as a link, a known `<kind>:<value>` with its kind as a label. */
function TaskRef({ value }: { value: string }) {
  const m = useMessages();
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
  const prefix = value.slice(0, separator);
  const kind = separator > 0 && (prefix === "lane" || prefix === "discord" || prefix === "pr")
    ? m.details.refKinds[prefix]
    : undefined;
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
  const m = useMessages();
  if (task.refs.length === 0) {
    return null;
  }
  return (
    <DetailField label={m.details.fields.refs}>
      <ul aria-label={m.details.fields.refsOf(task.id)} className="flex flex-col gap-0.5">
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
  const m = useMessages();
  const milestones = reachedMilestones(task.milestones, m);
  if (milestones.length === 0) {
    return null;
  }
  if (detailed) {
    return (
      <DetailField label={m.details.fields.timeline}>
        <dl aria-label={m.details.fields.timelineOf(task.id)} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
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
    <p aria-label={m.details.fields.timelineOf(task.id)} className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
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
  const m = useMessages();
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
    <Selector
      label={m.details.fields.addRelated(task.id)}
      isLabelHidden
      size="sm"
      width={192}
      placeholder={m.details.fields.addRelatedHint}
      // Always shows the placeholder: picking a task adds it instead of keeping a value.
      value=""
      isDisabled={busy}
      options={groups.map((group) => ({
        type: "section" as const,
        title: context.workspaceName(group.workspaceId),
        options: group.tasks.map((other) => ({ value: String(other.id), label: `#${other.id} ${other.title}` })),
      }))}
      onChange={(value) => {
        if (value) {
          addRelation.mutate({ taskId: task.id, relatedId: Number(value) });
        }
      }}
    />
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
    <DetailField label={m.details.fields.related}>
      <ul aria-label={m.details.fields.relatedOf(task.id)} className="flex flex-wrap items-center gap-1 max-md:gap-2">
        {related.map((id) => {
          const other = context.byId.get(id);
          const label = taskRef(id, task.workspaceId, context);
          return (
            <li key={id} className="inline-flex min-w-0 items-center max-md:gap-2">
              <Button
                size="sm"
                variant="secondary"
                label={other === undefined ? label : `${label} ${other.title}`}
                aria-label={m.details.fields.openRelated(label)}
                tooltip={other?.title}
                className="min-w-0 max-w-56 tabular-nums"
                isDisabled={navigation === undefined || !navigation.canOpen(id)}
                onClick={() => navigation?.open(id)}
              />
              <IconButton
                size="sm"
                variant="ghost"
                label={m.details.fields.removeRelated(id, task.id)}
                tooltip={m.details.fields.removeRelatedHint}
                icon={<X />}
                isDisabled={busy}
                onClick={() => removeRelation.mutate({ taskId: task.id, relatedId: id })}
              />
            </li>
          );
        })}
        {picker}
      </ul>
      {error}
    </DetailField>
  );
}

/**
 * Turns the autopilot mark of a task on or off in one click, as `update_task` does: marking
 * records since when, clearing drops it. The other fields are sent unchanged.
 */
export function AutopilotToggle({ task }: { task: Task }) {
  const m = useMessages();
  const updateTask = useUpdateTask();
  const toggle = () =>
    updateTask.mutate({
      status: null,
      id: task.id,
      taskType: task.taskType,
      title: task.title,
      description: task.description,
      estimate: task.estimate,
      dueDate: task.dueDate,
      autopilot: !task.autopilot,
      criteria: null,
    });
  return (
    <>
      <Button
        size="sm"
        variant={task.autopilot ? "primary" : "secondary"}
        changesData
        aria-pressed={task.autopilot}
        aria-label={m.details.fields.autopilotOf(task.id)}
        label={task.autopilot ? m.details.fields.autopilotOn : m.details.fields.autopilotOff}
        icon={<Bot aria-hidden />}
        tooltip={
          task.autopilot
            ? m.details.fields.autopilotOnHint
            : m.details.fields.autopilotOffHint
        }
        isDisabled={updateTask.isPending}
        onClick={toggle}
        className="shrink-0"
      />
      {updateTask.error && (
        <span role="alert" className="text-xs text-destructive">
          {updateTask.error.message}
        </span>
      )}
    </>
  );
}

/**
 * The workspace of a task in the details sheet, as a picker that moves the task into another
 * live workspace. Only the workspace changes: history, notes, criteria, refs, and links stay.
 */
export function TaskWorkspace({ task }: { task: Task }) {
  const m = useMessages();
  const workspaces = useWorkspaces();
  const moveTask = useMoveTask();
  const serverDown = useServerDown();
  const live = workspaces.data ?? [];
  if (live.length < 2) {
    return null;
  }
  return (
    <>
      <span
        className="inline-flex"
        title={m.details.fields.workspaceHint}
      >
        <Selector
          label={m.details.fields.workspaceOf(task.id)}
          isLabelHidden
          size="sm"
          width={160}
          value={String(task.workspaceId)}
          isDisabled={moveTask.isPending || serverDown}
          options={live.map((workspace) => ({ value: String(workspace.id), label: workspace.name }))}
          onChange={(value) => moveTask.mutate({ id: task.id, workspaceId: Number(value) })}
        />
      </span>
      {moveTask.error && (
        <span role="alert" className="text-xs text-destructive">
          {moveTask.error.message}
        </span>
      )}
    </>
  );
}

/** A task's estimate and due date, the due date in red once it is missed. */
export function TaskPlan({ task }: { task: Task }) {
  const m = useMessages();
  return (
    <>
      {(task.estimate !== null || task.dueDate !== null) && (
        <p aria-label={m.details.fields.planOf(task.id)} className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {task.estimate !== null && <span>{m.details.fields.estimate(formatEstimate(task.estimate, m))}</span>}
          {task.dueDate !== null && <DueDate task={task} />}
        </p>
      )}
      <TaskLabels task={task} />
      <TaskRefs task={task} />
    </>
  );
}
