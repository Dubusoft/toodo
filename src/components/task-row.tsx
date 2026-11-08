import { lazy, Suspense, useState } from "react";
import { Check, CircleSlash, Flag, GitMerge, PanelRight, Pause, Pencil, Play, RotateCcw, StickyNote, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrerequisiteConfirmation } from "@/components/prerequisite-confirmation";
import { compactSelectClass, escapeCloses } from "@/components/workspace-list";
import type { SheetNavigation } from "@/components/task-graph";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { MoreMenu, type Action } from "@/components/more-menu";
import type { Task, TaskId, TaskStatus } from "@/lib/bindings";
import {
  useAddDependency,
  useCompleteTask,
  useDeleteTask,
  usePauseTask,
  useRemoveDependency,
  useStartTask,
} from "@/lib/queries";
import {
  dependenciesDone,
  canAddDependency,
  dependencyEditableStatuses,
  isNotAdopted,
  isPaused,
  waitingPrerequisites,
} from "@/lib/task-graph";
import { openBlocker } from "@/lib/attention";
import { reachedMilestones } from "@/lib/timeline";
import type { MissingPlanField } from "@/lib/plan";
import { When } from "@/components/when";
import { firstParagraph } from "@/lib/markdown";
import { toneChip, toneOutline, toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import {
  statusLabel,
  completeStyle,
  statusStyle,
  type TaskContext,
  taskRef,
  DueDate,
  MissingPlanMark,
  useServerDown,
  Markdown,
} from "@/components/task-common";
import { TaskEditForm } from "@/components/task-edit-form";
import { ConcludeForm, ReopenForm, OutcomeForm, ShippedByForm, CompletionNote } from "@/components/task-outcome-forms";
import { TaskIssue } from "@/components/task-issue";

// Sections only the details view shows load with it, apart from the task list.
const taskDetails = () => import("@/components/task-details");
const TaskTimeline = lazy(() => taskDetails().then((module) => ({ default: module.TaskTimeline })));
const RelatedTasks = lazy(() => taskDetails().then((module) => ({ default: module.RelatedTasks })));
const TaskNotes = lazy(() => taskDetails().then((module) => ({ default: module.TaskNotes })));
const TaskPlan = lazy(() => taskDetails().then((module) => ({ default: module.TaskPlan })));
const TaskCriteria = lazy(() => taskDetails().then((module) => ({ default: module.TaskCriteria })));

/** Statuses whose task is not being worked on, so it can be deleted. */
const deletableStatuses: TaskStatus[] = ["planned", "done"];

export function TaskRow({
  task,
  tasks,
  context,
  showWorkspace,
  detailed = false,
  navigation,
  onShowDetails,
}: {
  task: Task;
  /** Tasks of every workspace; any of them can become a prerequisite. */
  tasks: Task[];
  context: TaskContext;
  showWorkspace: boolean;
  /** Shown on its own, as in the details sheet: nothing is cut off and fields are labeled. */
  detailed?: boolean;
  /** Opens another task in the sheet; lets related-task chips jump to their task. */
  navigation?: SheetNavigation;
  /** Opens the details sheet of the task; rows show only a summary. */
  onShowDetails?: () => void;
}) {
  const startTask = useStartTask();
  const completeTask = useCompleteTask();
  const pauseTask = usePauseTask();
  const deleteTask = useDeleteTask();
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const [editing, setEditing] = useState(false);
  // The plan field the edit form focuses when the user opened it to add that field.
  const [focusPlan, setFocusPlan] = useState<MissingPlanField | undefined>(undefined);
  const [concluding, setConcluding] = useState(false);
  // A form that changes how the task ends: reopening or correcting a done task, or completing it as shipped by another.
  const [correcting, setCorrecting] = useState<"reopen" | "outcome" | "shipped" | null>(null);
  const [addingNote, setAddingNote] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A prerequisite that would pause this started task, waiting for confirmation.
  const [confirmingPrerequisite, setConfirmingPrerequisite] = useState<TaskId | null>(null);
  const inReview = task.status === "in_review";
  const active = task.status === "in_progress" || inReview;
  const finishing = completeTask.isPending;
  const final = task.status === "done";
  const criteriaMet = task.criteria.every((criterion) => criterion.state === "met");
  const unmetCriteria = task.criteria.filter((criterion) => criterion.state !== "met").length;
  // A started task completes once its criteria are met, or right away when it has none.
  const completable = inReview || (task.status === "in_progress" && criteriaMet);
  const paused = isPaused(task);
  const startable = task.status === "planned" && dependenciesDone(task, context.byId);
  // Prerequisites concluded without merging: this task cannot build on them.
  const notAdopted = task.status === "planned" ? task.dependsOn.filter((id) => isNotAdopted(context.byId.get(id))) : [];
  const dependenciesEditable = dependencyEditableStatuses.includes(task.status);
  // A planned task can start (or a paused one resume) once these prerequisites are done.
  const waitingOn = waitingPrerequisites(task, context.byId);
  // What an agent reported blocks the work, or the prerequisites a pause waits on.
  const blocker = openBlocker(task, context.byId);
  const changingDependencies = addDependency.isPending || removeDependency.isPending;
  const serverDown = useServerDown();
  const actionError =
    startTask.error ??
    completeTask.error ??
    pauseTask.error ??
    deleteTask.error ??
    addDependency.error ??
    removeDependency.error;
  // Tasks that would close a cycle are not offered.
  const candidates = tasks.filter((other) => canAddDependency(tasks, other.id, task.id));
  // Candidates grouped by workspace, the task's own workspace first.
  const candidateGroups = [...new Set([task.workspaceId, ...candidates.map((other) => other.workspaceId)])]
    .map((workspaceId) => ({
      workspaceId,
      tasks: candidates.filter((other) => other.workspaceId === workspaceId),
    }))
    .filter((group) => group.tasks.length > 0);

  // Actions in a fixed order; the first applicable of the main ones is the task's next action.
  const start: Action | null =
    task.status === "planned"
      ? {
          key: "start", changesData: true,
          label: startTask.isPending ? "Starting..." : paused ? "Resume" : "Start",
          ariaLabel: `${paused ? "Resume" : "Start"} #${task.id}`,
          icon: <Play />,
          title: startable
            ? undefined
            : notAdopted.length > 0
              ? "A dependency was not adopted; remove it to start"
              : "Waits until all its dependencies are done",
          disabled: !startable || startTask.isPending,
          onSelect: () => startTask.mutate(task.id),
        }
      : null;
  const complete: Action | null =
    completable
      ? {
          key: "complete", changesData: true,
          label: completeTask.isPending ? "Completing..." : "Complete",
          ariaLabel: `Complete #${task.id}`,
          icon: <Check />,
          className: completeStyle,
          title: !criteriaMet
            ? `${unmetCriteria} of ${task.criteria.length} criteria not met yet; check the manual ones under Criteria`
            : undefined,
          disabled: finishing || !criteriaMet,
          onSelect: () => completeTask.mutate(task.id),
        }
      : null;
  // A planned task can be concluded too, so an idea is dropped without starting it.
  const conclude: Action | null = active || task.status === "planned"
    ? {
        key: "conclude",
        label: "Conclude",
        ariaLabel: `Conclude #${task.id} without completing`,
        icon: <CircleSlash />,
        title: "Finish without completing, e.g. research whose result is not adopted",
        disabled: finishing,
        onSelect: () => setConcluding(true),
      }
    : null;
  const primary = [start, complete].find((action) => action !== null) ?? null;
  const others = [start, complete, conclude].filter(
    (action): action is Action => action !== null && action !== primary,
  );
  // Secondary actions always sit in the "More" menu, Delete last.
  const secondaryActions: (Action | null)[] = [
    !final
      ? {
          key: "edit",
          label: "Edit",
          ariaLabel: `Edit #${task.id}`,
          icon: <Pencil />,
          onSelect: () => {
            setFocusPlan(undefined);
            setEditing(true);
          },
        }
      : null,
    active
      ? {
          key: "pause", changesData: true,
          label: "Pause",
          ariaLabel: `Pause #${task.id}`,
          icon: <Pause />,
          title: "Pause: stop working on the task; it can be resumed",
          disabled: pauseTask.isPending,
          onSelect: () => pauseTask.mutate(task.id),
        }
      : null,
    final && isNotAdopted(task)
      ? {
          key: "shipped",
          label: "Complete as shipped by...",
          ariaLabel: `Complete #${task.id} as shipped by another task`,
          icon: <GitMerge />,
          title: "The work did ship, through another task: mark it done as shipped with that one",
          onSelect: () => setCorrecting("shipped"),
        }
      : null,
    final
      ? {
          key: "outcome",
          label: "Change outcome",
          ariaLabel: `Change outcome of #${task.id}`,
          icon: <Flag />,
          title: "Correct how the task ended, e.g. merged work that was reverted; the change is kept as a note",
          onSelect: () => setCorrecting("outcome"),
        }
      : null,
    final
      ? {
          key: "reopen",
          label: "Reopen",
          ariaLabel: `Reopen #${task.id}`,
          icon: <RotateCcw />,
          title: "Reopen a task completed or concluded by mistake; it is paused and can be resumed",
          onSelect: () => setCorrecting("reopen"),
        }
      : null,
    final && task.completionNote === null && !addingNote
      ? {
          key: "add-note",
          label: "Add note",
          ariaLabel: `Add completion note to #${task.id}`,
          icon: <StickyNote />,
          onSelect: () => setAddingNote(true),
        }
      : null,
    deletableStatuses.includes(task.status)
      ? {
          key: "delete",
          label: "Delete",
          ariaLabel: `Delete #${task.id}`,
          icon: <Trash2 />,
          title: "Delete",
          destructive: true,
          onSelect: () => setConfirming(true),
        }
      : null,
  ];
  const secondary = secondaryActions.filter((action): action is Action => action !== null);
  const details: Action | null = onShowDetails
    ? {
        key: "details",
        label: "Details",
        ariaLabel: `Show details of #${task.id}`,
        icon: <PanelRight />,
        onSelect: onShowDetails,
      }
    : null;
  // In the details sheet the main actions are buttons; in a row only the next action is.
  const menu = detailed ? secondary : [...(details ? [details] : []), ...others, ...secondary];
  const latest = reachedMilestones(task.milestones).at(-1);
  const metCriteria = task.criteria.filter((criterion) => criterion.state === "met").length;
  const failedCriteria = task.criteria.filter((criterion) => criterion.state === "failed").length;
  const preview = detailed ? "" : firstParagraph(task.description);

  function actionButton(action: Action, variant: "default" | "outline") {
    return (
      <Button
        key={action.key}
        size="xs"
        variant={variant}
        changesData={action.changesData}
        aria-label={action.ariaLabel}
        title={action.title}
        disabled={action.disabled}
        onClick={action.onSelect}
        className={action.className}
      >
        {action.icon}
        {action.label}
      </Button>
    );
  }

  return (
    <li
      data-task-row={detailed ? undefined : task.id}
      className={cn("flex flex-col", detailed ? "gap-3 p-4" : "gap-1.5 px-4 py-3 max-md:gap-2")}
    >
      {editing ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge task={task} byId={context.byId} />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{task.id}</span>
            <span className="text-xs text-muted-foreground">Editing</span>
          </div>
          <TaskEditForm
            task={task}
            focusPlan={focusPlan}
            onDone={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className={cn("flex min-w-0 flex-col", detailed ? "gap-1.5" : "gap-0.5")}>
          <div className={cn("flex min-w-0 items-center gap-2", detailed ? "flex-wrap" : "max-md:flex-wrap max-md:gap-y-1")}>
            <StatusBadge task={task} byId={context.byId} />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{task.id}</span>
            {showWorkspace && (
              <span className="shrink-0 rounded-md bg-muted px-1.5 text-xs text-muted-foreground">
                {context.workspaceName(task.workspaceId)}
              </span>
            )}
            <TaskTypeBadge type={task.taskType} />
            {!detailed && (
              // The title opens the details sheet. Below md it gets a line of its own under the chips.
              <button
                type="button"
                className="break-words-keep line-clamp-2 min-w-0 cursor-pointer rounded-sm text-left text-base font-semibold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 max-md:order-last max-md:min-h-11 max-md:basis-full md:flex-1 md:text-sm"
                title={task.title}
                data-task-title
                onClick={onShowDetails}
              >
                {task.title}
              </button>
            )}
            {blocker && (
              <span
                role="note"
                aria-label={`Blocker on #${task.id}: ${blocker.body}`}
                title={blocker.body}
                className={cn("shrink-0 rounded-md px-1.5 text-xs font-medium", toneChip.attention)}
              >
                Blocker
              </span>
            )}
          </div>
          {detailed && <h3 className="break-words-keep text-base font-semibold leading-snug">{task.title}</h3>}
          {detailed && task.description.trim() && (
            <Suspense
              fallback={<p className="whitespace-pre-line break-words-keep text-sm text-muted-foreground">{task.description}</p>}
            >
              <Markdown source={task.description} />
            </Suspense>
          )}
          {preview && <p className="break-words-keep line-clamp-2 text-sm text-muted-foreground">{preview}</p>}
          {!detailed && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground empty:hidden">
              {notAdopted.length > 0 && (
                <span role="note" aria-label={`Blocked prerequisites of #${task.id}`} className={toneText.attention}>
                  {notAdopted.map((id) => taskRef(id, task.workspaceId, context)).join(", ")} not adopted
                </span>
              )}
              {waitingOn.length > 0 && (
                <span role="note" aria-label={`Waiting prerequisites of #${task.id}`} className={toneText.neutral}>
                  Waiting on {waitingOn.map((id) => taskRef(id, task.workspaceId, context)).join(", ")}
                </span>
              )}
              {task.dueDate !== null && <DueDate task={task} />}
              <MissingPlanMark
                task={task}
                onEdit={(field) => {
                  setFocusPlan(field);
                  setEditing(true);
                }}
              />
              {!final && task.criteria.length > 0 && (
                <span>
                  {metCriteria}/{task.criteria.length} criteria met
                </span>
              )}
              {!final && failedCriteria > 0 && (
                <span className={cn("font-medium", toneText.danger)}>{failedCriteria} failed</span>
              )}
              {latest && (
                <When at={latest.at} prefix={`${latest.label} `} />
              )}
            </p>
          )}
        </div>
      )}
      {detailed && !editing && <Suspense fallback={null}><TaskCriteria task={task} detailed /></Suspense>}
      {/* The question takes the place of the dependency row, so the lines below stay put. */}
      {confirmingPrerequisite !== null ? (
        <PrerequisiteConfirmation
          taskId={task.id}
          prerequisite={taskRef(confirmingPrerequisite, task.workspaceId, context)}
          pending={addDependency.isPending}
          onConfirm={() =>
            addDependency.mutate(
              { id: task.id, dependsOn: confirmingPrerequisite, confirmPause: true },
              { onSettled: () => setConfirmingPrerequisite(null) },
            )
          }
          onCancel={() => setConfirmingPrerequisite(null)}
        />
      ) : (
        detailed && (task.dependsOn.length > 0 || (dependenciesEditable && candidates.length > 0)) && (
        <div
          role="group"
          aria-label={`Dependencies of #${task.id}`}
          className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground max-md:gap-2"
        >
          {task.dependsOn.length > 0 && <span>Depends on</span>}
          {task.dependsOn.map((id) => (
            <span
              key={id}
              className={cn(
                "inline-flex h-6 items-center gap-0.5 rounded-md border px-1.5 tabular-nums max-md:h-auto max-md:pr-0",
                context.byId.get(id)?.status === "done" && "line-through decoration-muted-foreground/60",
                notAdopted.includes(id) && toneOutline.attention,
              )}
              title={
                notAdopted.includes(id)
                  ? `${context.byId.get(id)?.title} (not adopted)`
                  : context.byId.get(id)?.title
              }
            >
              <span>{taskRef(id, task.workspaceId, context)}</span>
              {dependenciesEditable && (
                <button
                  type="button"
                  aria-label={`Remove dependency #${id} from #${task.id}`}
                  title="Remove dependency"
                  className="flex items-center justify-center self-stretch rounded-sm p-0.5 hover:bg-muted hover:text-foreground disabled:opacity-50 max-md:size-11"
                  disabled={changingDependencies}
                  onClick={() => removeDependency.mutate({ id: task.id, dependsOn: id })}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
          {dependenciesEditable && candidates.length > 0 && (
            <select
              aria-label={`Add dependency to #${task.id}`}
              title={task.status !== "in_progress" ? undefined : "A prerequisite that is not done pauses this task"}
              className={cn(compactSelectClass, "max-w-48")}
              value=""
              disabled={changingDependencies || serverDown}
              onChange={(e) => {
                if (e.target.value) {
                  const prerequisite = Number(e.target.value);
                  // The server tells whether it pauses this started task; then the user confirms it first.
                  addDependency.mutate(
                    { id: task.id, dependsOn: prerequisite, confirmPause: false },
                    { onSuccess: (outcome) => outcome === "confirm_pause" && setConfirmingPrerequisite(prerequisite) },
                  );
                }
              }}
            >
              <option value="">Add dependency...</option>
              {candidateGroups.map((group) => (
                <optgroup key={group.workspaceId} label={context.workspaceName(group.workspaceId)}>
                  {group.tasks.map((other) => (
                    <option key={other.id} value={other.id}>
                      #{other.id} {other.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>
        )
      )}
      {detailed && notAdopted.length > 0 && (
        <p
          role="note"
          aria-label={`Blocked prerequisites of #${task.id}`}
          className={cn("text-xs", toneText.attention)}
        >
          {notAdopted.map((id) => taskRef(id, task.workspaceId, context)).join(", ")}{" "}
          {notAdopted.length === 1 ? "was" : "were"} not adopted. Remove the dependency or change the plan to
          start this task.
        </p>
      )}
      {detailed && waitingOn.length > 0 && (
        <p
          role="note"
          aria-label={`Waiting prerequisites of #${task.id}`}
          className={cn("text-xs", toneText.neutral)}
        >
          Waiting on {waitingOn.map((id) => taskRef(id, task.workspaceId, context)).join(", ")}
        </p>
      )}
      {detailed && <Suspense fallback={null}><TaskPlan task={task} /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskTimeline task={task} detailed /></Suspense>}
      {detailed && task.issue !== null && <TaskIssue task={task} />}
      {detailed && <Suspense fallback={null}><RelatedTasks task={task} tasks={tasks} context={context} navigation={navigation} /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskNotes task={task} detailed /></Suspense>}
      {final && !editing && (detailed || addingNote) && (
        <CompletionNote task={task} adding={addingNote} onAdded={() => setAddingNote(false)} />
      )}
      {actionError && (
        <p role="alert" className="text-xs text-destructive">
          {actionError.message}
        </p>
      )}
      {concluding && !editing && (
        <ConcludeForm
          task={task}
          onDone={() => setConcluding(false)}
          onShipped={() => {
            setConcluding(false);
            setCorrecting("shipped");
          }}
        />
      )}
      {correcting === "shipped" && !editing && (
        <ShippedByForm task={task} tasks={tasks} context={context} onDone={() => setCorrecting(null)} />
      )}
      {correcting === "outcome" && !editing && <OutcomeForm task={task} onDone={() => setCorrecting(null)} />}
      {correcting === "reopen" && !editing && (
        <ReopenForm task={task} onDone={() => setCorrecting(null)} />
      )}
      {!editing && !concluding && correcting === null && (
        <div className="flex flex-wrap items-center gap-1 max-md:gap-2">
          {primary && actionButton(primary, detailed ? "default" : "outline")}
          {detailed && others.map((action) => actionButton(action, "outline"))}
          <div
            role={confirming ? "group" : undefined}
            aria-label={confirming ? `Delete #${task.id}?` : undefined}
            className={cn(
              "ml-auto flex items-center gap-1 max-md:gap-2",
              confirming && "basis-full flex-wrap justify-end",
            )}
            onKeyDown={confirming ? escapeCloses(() => setConfirming(false), deleteTask.isPending) : undefined}
          >
            {confirming ? (
              <>
                <span className="min-w-0 flex-1 basis-48 text-xs">
                  Delete #{task.id}? It moves to Settings &gt; Archive with its history, where it can be restored.
                </span>
                <Button
                  size="xs"
                  variant="destructive"
                  aria-label={`Confirm delete #${task.id}`}
                  disabled={deleteTask.isPending}
                  onClick={() => deleteTask.mutate(task.id, { onSettled: () => setConfirming(false) })}
                >
                  <Trash2 />
                  {deleteTask.isPending ? "Deleting..." : "Confirm delete"}
                </Button>
                {/* Focus lands on Back, under the pointer, so a double click cannot delete. */}
                <Button key="back" size="xs" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
                  Back
                </Button>
              </>
            ) : (
              menu.length > 0 && <MoreMenu label={`More actions for #${task.id}`} actions={menu} />
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function StatusBadge({ task, byId }: { task: Task; byId: ReadonlyMap<TaskId, Task> }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        statusStyle(task, byId),
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" />
      {statusLabel(task, byId)}
    </span>
  );
}
