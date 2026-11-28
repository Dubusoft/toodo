import { useI18n } from "@/lib/i18n";
import { lazy, Suspense, useState } from "react";
import { AlarmClock, AlarmClockOff, Check, CircleSlash, Flag, GitMerge, PanelRight, Pause, Pencil, Play, RotateCcw, StickyNote, Trash2, X } from "lucide-react";
import { Selector } from "@astryxdesign/core/Selector";
import { Button, IconButton } from "@/components/button";
import { PrerequisiteConfirmation } from "@/components/prerequisite-confirmation";
import { escapeCloses } from "@/components/workspace-list";
import type { SheetNavigation } from "@/components/task-graph";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { MoreMenu, type Action } from "@/components/more-menu";
import type { Task, TaskId, TaskStatus } from "@/lib/bindings";
import {
  useAddDependency,
  useCompleteTask,
  useDeleteTask,
  useEndWait,
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
import { When } from "@/components/when";
import type { MissingPlanField } from "@/lib/plan";
import { firstParagraph } from "@/lib/markdown";
import { toneChip, toneOutline, toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import {
  completeStyle,
  StatusBadge,
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
import { WaitForm, waitLabel } from "@/components/task-wait";

// Sections only the details view shows load with it, apart from the task list.
const taskDetails = () => import("@/components/task-details");
const TaskTimeline = lazy(() => taskDetails().then((module) => ({ default: module.TaskTimeline })));
const RelatedTasks = lazy(() => taskDetails().then((module) => ({ default: module.RelatedTasks })));
const TaskNotes = lazy(() => taskDetails().then((module) => ({ default: module.TaskNotes })));
const TaskPlan = lazy(() => taskDetails().then((module) => ({ default: module.TaskPlan })));
const TaskCriteria = lazy(() => taskDetails().then((module) => ({ default: module.TaskCriteria })));
const AutopilotToggle = lazy(() => taskDetails().then((module) => ({ default: module.AutopilotToggle })));
const TaskThreads = lazy(() => taskDetails().then((module) => ({ default: module.TaskThreads })));
const TaskWorkspace = lazy(() => taskDetails().then((module) => ({ default: module.TaskWorkspace })));

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
  const { m, locale } = useI18n();
  const startTask = useStartTask();
  const completeTask = useCompleteTask();
  const pauseTask = usePauseTask();
  const endWait = useEndWait();
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
  const [waiting, setWaiting] = useState(false);
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
    endWait.error ??
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
          label: startTask.isPending ? m.tasks.starting : paused ? m.tasks.resume : m.tasks.start,
          ariaLabel: paused ? m.tasks.resumeTask(task.id) : m.tasks.startTask(task.id),
          icon: <Play />,
          title: startable
            ? undefined
            : notAdopted.length > 0
              ? m.tasks.startNotAdopted
              : m.tasks.startBlocked,
          disabled: !startable || startTask.isPending,
          onSelect: () => startTask.mutate(task.id),
        }
      : null;
  const complete: Action | null =
    completable
      ? {
          key: "complete", changesData: true,
          label: completeTask.isPending ? m.tasks.completing : m.tasks.complete,
          ariaLabel: m.tasks.completeTask(task.id),
          icon: <Check />,
          className: completeStyle,
          title: !criteriaMet
            ? m.tasks.criteriaUnmet(unmetCriteria, task.criteria.length)
            : undefined,
          disabled: finishing || !criteriaMet,
          onSelect: () => completeTask.mutate(task.id),
        }
      : null;
  // A planned task can be concluded too, so an idea is dropped without starting it.
  const conclude: Action | null = active || task.status === "planned"
    ? {
        key: "conclude",
        label: m.tasks.conclude,
        ariaLabel: m.tasks.concludeTask(task.id),
        icon: <CircleSlash />,
        title: m.tasks.concludeHint,
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
          label: m.common.edit,
          ariaLabel: m.tasks.editTask(task.id),
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
          label: m.tasks.pause,
          ariaLabel: m.tasks.pauseTask(task.id),
          icon: <Pause />,
          title: m.tasks.pauseHint,
          disabled: pauseTask.isPending,
          onSelect: () => pauseTask.mutate(task.id),
        }
      : null,
    !final
      ? {
          key: "wait",
          label: task.wait === null ? m.tasks.waitUntil : m.tasks.changeWait,
          ariaLabel: task.wait === null ? m.tasks.waitTask(task.id) : m.tasks.changeTaskWait(task.id),
          icon: <AlarmClock />,
          title: m.tasks.waitHint,
          onSelect: () => setWaiting(true),
        }
      : null,
    task.wait !== null
      ? {
          key: "end-wait", changesData: true,
          label: m.tasks.endWait,
          ariaLabel: m.tasks.endTaskWait(task.id),
          icon: <AlarmClockOff />,
          title: m.tasks.endWaitHint,
          disabled: endWait.isPending,
          onSelect: () => endWait.mutate(task.id),
        }
      : null,
    final && isNotAdopted(task)
      ? {
          key: "shipped",
          label: m.tasks.completeAsShipped,
          ariaLabel: m.tasks.completeTaskAsShipped(task.id),
          icon: <GitMerge />,
          title: m.tasks.shippedHint,
          onSelect: () => setCorrecting("shipped"),
        }
      : null,
    final
      ? {
          key: "outcome",
          label: m.tasks.changeOutcome,
          ariaLabel: m.tasks.changeTaskOutcome(task.id),
          icon: <Flag />,
          title: m.tasks.changeOutcomeHint,
          onSelect: () => setCorrecting("outcome"),
        }
      : null,
    final
      ? {
          key: "reopen",
          label: m.tasks.reopen,
          ariaLabel: m.tasks.reopenTask(task.id),
          icon: <RotateCcw />,
          title: m.tasks.reopenHint,
          onSelect: () => setCorrecting("reopen"),
        }
      : null,
    final && task.completionNote === null && !addingNote
      ? {
          key: "add-note",
          label: m.tasks.addNote,
          ariaLabel: m.tasks.addCompletionNote(task.id),
          icon: <StickyNote />,
          onSelect: () => setAddingNote(true),
        }
      : null,
    deletableStatuses.includes(task.status)
      ? {
          key: "delete",
          label: m.common.delete,
          ariaLabel: m.tasks.deleteTask(task.id),
          icon: <Trash2 />,
          title: m.common.delete,
          destructive: true,
          onSelect: () => setConfirming(true),
        }
      : null,
  ];
  const secondary = secondaryActions.filter((action): action is Action => action !== null);
  const details: Action | null = onShowDetails
    ? {
        key: "details",
        label: m.tasks.details,
        ariaLabel: m.tasks.showDetails(task.id),
        icon: <PanelRight />,
        onSelect: onShowDetails,
      }
    : null;
  // In the details sheet the main actions are buttons; in a row only the next action is.
  const menu = detailed ? secondary : [...(details ? [details] : []), ...others, ...secondary];
  const waitText = waitLabel(task, locale, m);
  const latest = reachedMilestones(task.milestones, m).at(-1);
  const metCriteria = task.criteria.filter((criterion) => criterion.state === "met").length;
  const failedCriteria = task.criteria.filter((criterion) => criterion.state === "failed").length;
  const preview = detailed ? "" : firstParagraph(task.description);

  function actionButton(action: Action, variant: "primary" | "secondary") {
    return (
      <Button
        key={action.key}
        size="sm"
        variant={variant}
        changesData={action.changesData}
        label={action.label}
        icon={action.icon}
        aria-label={action.ariaLabel}
        tooltip={action.title}
        isDisabled={action.disabled}
        onClick={action.onSelect}
        className={action.className}
      />
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
            <span className="text-xs text-muted-foreground">{m.tasks.editing}</span>
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
            {showWorkspace && !detailed && (
              // A long workspace name is cut short, so it cannot push the row wider than the list.
              <span
                className="max-w-48 shrink-0 truncate rounded-md bg-muted px-1.5 text-xs text-muted-foreground"
                title={context.workspaceName(task.workspaceId)}
              >
                {context.workspaceName(task.workspaceId)}
              </span>
            )}
            {detailed && (
              <Suspense fallback={null}>
                <TaskWorkspace task={task} />
              </Suspense>
            )}
            <TaskTypeBadge type={task.taskType} />
            {detailed && (
              <Suspense fallback={null}>
                <AutopilotToggle task={task} />
              </Suspense>
            )}
            {!detailed && task.autopilot && (
              <span
                role="note"
                aria-label={m.tasks.autopilotMarked(task.id)}
                title={m.tasks.autopilotMarkedHint}
                className={cn("shrink-0 rounded-md px-1.5 text-xs font-medium", toneChip.info)}
              >
                {m.tasks.autopilot}
              </span>
            )}
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
                aria-label={m.tasks.blockerOnTask(task.id, blocker.body)}
                title={blocker.body}
                className={cn("shrink-0 rounded-md px-1.5 text-xs font-medium", toneChip.attention)}
              >
                {m.tasks.blocker}
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
                <span role="note" aria-label={m.tasks.blockedPrerequisites(task.id)} className={toneText.attention}>
                  {m.tasks.prerequisitesNotAdopted(notAdopted.map((id) => taskRef(id, task.workspaceId, context)).join(", "))}
                </span>
              )}
              {waitingOn.length > 0 && (
                <span role="note" aria-label={m.tasks.waitingPrerequisites(task.id)} className={toneText.neutral}>
                  {m.tasks.waitingOn(waitingOn.map((id) => taskRef(id, task.workspaceId, context)).join(", "))}
                </span>
              )}
              {task.wait !== null && (
                <span role="note" aria-label={m.tasks.taskWait(task.id)} className={toneText.neutral}>
                  {waitText}
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
                  {m.tasks.criteriaMet(metCriteria, task.criteria.length)}
                </span>
              )}
              {!final && failedCriteria > 0 && (
                <span className={cn("font-medium", toneText.danger)}>{m.tasks.criteriaFailed(failedCriteria)}</span>
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
          aria-label={m.tasks.dependencies(task.id)}
          className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground max-md:gap-2"
        >
          {task.dependsOn.length > 0 && <span>{m.tasks.dependsOn}</span>}
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
                  ? m.tasks.notAdoptedTitle(context.byId.get(id)?.title)
                  : context.byId.get(id)?.title
              }
            >
              <span>{taskRef(id, task.workspaceId, context)}</span>
              {dependenciesEditable && (
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={m.tasks.removeTaskDependency(id, task.id)}
                  tooltip={m.tasks.removeDependency}
                  icon={<X />}
                  isDisabled={changingDependencies}
                  onClick={() => removeDependency.mutate({ id: task.id, dependsOn: id })}
                />
              )}
            </span>
          ))}
          {dependenciesEditable && candidates.length > 0 && (
            // Selector takes no title, so the hint about pausing sits on a wrapper.
            <span title={task.status !== "in_progress" ? undefined : m.tasks.dependencyPauses}>
              <Selector
                label={m.tasks.addTaskDependency(task.id)}
                isLabelHidden
                size="sm"
                width={192}
                placeholder={m.tasks.addDependency}
                // Nothing stays chosen: picking a task adds it and the picker resets.
                value=""
                isDisabled={changingDependencies || serverDown}
                options={candidateGroups.map((group) => ({
                  type: "section" as const,
                  title: context.workspaceName(group.workspaceId),
                  options: group.tasks.map((other) => ({ value: String(other.id), label: `#${other.id} ${other.title}` })),
                }))}
                onChange={(value) => {
                  const prerequisite = Number(value);
                  // The server tells whether it pauses this started task; then the user confirms it first.
                  addDependency.mutate(
                    { id: task.id, dependsOn: prerequisite, confirmPause: false },
                    { onSuccess: (outcome) => outcome === "confirm_pause" && setConfirmingPrerequisite(prerequisite) },
                  );
                }}
              />
            </span>
          )}
        </div>
        )
      )}
      {detailed && notAdopted.length > 0 && (
        <p
          role="note"
          aria-label={m.tasks.blockedPrerequisites(task.id)}
          className={cn("text-xs", toneText.attention)}
        >
          {m.tasks.prerequisitesNotAdoptedHint(notAdopted.map((id) => taskRef(id, task.workspaceId, context)).join(", "), notAdopted.length)}
        </p>
      )}
      {detailed && waitingOn.length > 0 && (
        <p
          role="note"
          aria-label={m.tasks.waitingPrerequisites(task.id)}
          className={cn("text-xs", toneText.neutral)}
        >
          {m.tasks.waitingOn(waitingOn.map((id) => taskRef(id, task.workspaceId, context)).join(", "))}
        </p>
      )}
      {detailed && task.wait !== null && (
        <p role="note" aria-label={m.tasks.taskWait(task.id)} className={cn("text-xs", toneText.neutral)}>
          {waitText}
        </p>
      )}
      {detailed && <Suspense fallback={null}><TaskPlan task={task} /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskTimeline task={task} detailed /></Suspense>}
      {detailed && task.issue !== null && <TaskIssue task={task} />}
      {detailed && <Suspense fallback={null}><RelatedTasks task={task} tasks={tasks} context={context} navigation={navigation} /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskNotes task={task} detailed /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskThreads task={task} /></Suspense>}
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
      {waiting && !editing && <WaitForm task={task} onDone={() => setWaiting(false)} />}
      {!editing && !concluding && correcting === null && !waiting && (
        <div className="flex flex-wrap items-center gap-1 max-md:gap-2">
          {primary && actionButton(primary, detailed ? "primary" : "secondary")}
          {detailed && others.map((action) => actionButton(action, "secondary"))}
          <div
            role={confirming ? "group" : undefined}
            aria-label={confirming ? m.tasks.deleteTaskQuestion(task.id) : undefined}
            className={cn(
              "ml-auto flex items-center gap-1 max-md:gap-2",
              confirming && "basis-full flex-wrap justify-end",
            )}
            onKeyDown={confirming ? escapeCloses(() => setConfirming(false), deleteTask.isPending) : undefined}
          >
            {confirming ? (
              <>
                <span className="min-w-0 flex-1 basis-48 text-xs">
                  {m.tasks.deleteTaskDescription(task.id)}
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  label={deleteTask.isPending ? m.tasks.deleting : m.tasks.confirmDelete}
                  icon={<Trash2 />}
                  aria-label={m.tasks.confirmDeleteTask(task.id)}
                  isDisabled={deleteTask.isPending}
                  onClick={() => deleteTask.mutate(task.id, { onSettled: () => setConfirming(false) })}
                />
                {/* Focus lands on Back, under the pointer, so a double click cannot delete. */}
                <Button key="back" size="sm" variant="ghost" label={m.tasks.back} autoFocus onClick={() => setConfirming(false)} />
              </>
            ) : (
              menu.length > 0 && <MoreMenu label={m.tasks.moreTaskActions(task.id)} actions={menu} />
            )}
          </div>
        </div>
      )}
    </li>
  );
}
