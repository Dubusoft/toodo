import { lazy, Suspense, useState } from "react";
import {
  Check,
  CircleDot,
  CircleSlash,
  Crosshair,
  Flag,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  PanelRight,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  SquareTerminal,
  StickyNote,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrerequisiteConfirmation } from "@/components/prerequisite-confirmation";
import { compactSelectClass, escapeCloses } from "@/components/workspace-list";
import { PathLabel } from "@/components/path-label";
import { AgentBadge } from "@/components/agent-badge";
import type { SheetNavigation } from "@/components/task-graph";
import { PullRequestBadges } from "@/components/pull-request-badge";
import { RunsPanel } from "@/components/runs-panel";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { MoreMenu, type Action } from "@/components/more-menu";
import type { Task, TaskId, TaskStatus } from "@/lib/bindings";
import {
  CommandFailure,
  useAddDependency,
  useAgentStatuses,
  useCloseTaskWorkspace,
  useBranchFreshness,
  usePullRequestStatuses,
  useCompleteTask,
  useDeleteTask,
  useFocusAgentPane,
  useHerdrStatus,
  useOpenPullRequest,
  useOpenTaskInHerdr,
  usePauseTask,
  useRefreshCommitRecords,
  useRemoveDependency,
  useRestoreTaskWorktree,
  useStartTask,
} from "@/lib/queries";
import { pullRequestStats } from "@/lib/review";
import {
  dependenciesDone,
  dependencyEditableStatuses,
  freshnessWarning,
  isNotAdopted,
  isPaused,
  waitingPrerequisites,
} from "@/lib/task-graph";
import { openBlocker } from "@/lib/attention";
import { reachedMilestones } from "@/lib/timeline";
import { When } from "@/components/when";
import { firstParagraph } from "@/lib/markdown";
import { normalizePath, shortPath } from "@/lib/paths";
import { toneChip, toneOutline, tonePanel, toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import {
  statusLabel,
  completeStyle,
  statusStyle,
  type TaskContext,
  taskRef,
  DueDate,
  DetailField,
  useServerDown,
  Markdown,
} from "@/components/task-common";
import { TaskEditForm } from "@/components/task-edit-form";
import { ConcludeForm, ReopenForm, OutcomeForm, ShippedByForm, CompletionNote } from "@/components/task-outcome-forms";
import { TaskIssue } from "@/components/task-issue";

// Sections only the details view shows load with it, apart from the task list.
const taskDetails = () => import("@/components/task-details");
const TaskTimeline = lazy(() => taskDetails().then((module) => ({ default: module.TaskTimeline })));
const BranchFreshnessNote = lazy(() => taskDetails().then((module) => ({ default: module.BranchFreshnessNote })));
const ShippedWith = lazy(() => taskDetails().then((module) => ({ default: module.ShippedWith })));
const RelatedTasks = lazy(() => taskDetails().then((module) => ({ default: module.RelatedTasks })));
const CommitList = lazy(() => taskDetails().then((module) => ({ default: module.CommitList })));
const TaskActivity = lazy(() => taskDetails().then((module) => ({ default: module.TaskActivity })));
const AgentActivity = lazy(() => taskDetails().then((module) => ({ default: module.AgentActivity })));
const TaskNotes = lazy(() => taskDetails().then((module) => ({ default: module.TaskNotes })));
const TaskPlan = lazy(() => taskDetails().then((module) => ({ default: module.TaskPlan })));
const TaskCriteria = lazy(() => taskDetails().then((module) => ({ default: module.TaskCriteria })));

/** Statuses whose task is not being worked on, so it can be deleted with its worktree. */
const deletableStatuses: TaskStatus[] = ["planned", "done"];

type Confirmation = "delete" | "force-delete";

const confirmLabels: Record<Confirmation, string> = {
  delete: "Confirm delete",
  "force-delete": "Confirm force delete",
};

/** What a delete of task `id` removes, as asked before it runs. */
function deleteQuestion(action: Confirmation, id: TaskId, removableWorktree: boolean): string {
  if (action === "force-delete") {
    return `Force delete #${id}? Its worktree is removed with its modified and untracked files, and its herdr workspace is closed; the branch is kept.`;
  }
  return removableWorktree
    ? `Delete #${id}? Its worktree and herdr workspace are removed; the branch is kept.`
    : `Delete #${id} and its history from Toodo?`;
}

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
  const herdr = useHerdrStatus();
  const agentStatuses = useAgentStatuses();
  const pullRequestStatuses = usePullRequestStatuses();
  const startTask = useStartTask();
  const openTask = useOpenTaskInHerdr();
  const focusAgent = useFocusAgentPane();
  const refreshCommits = useRefreshCommitRecords();
  const openPullRequest = useOpenPullRequest();
  const completeTask = useCompleteTask();
  const pauseTask = usePauseTask();
  const deleteTask = useDeleteTask();
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const restoreWorktree = useRestoreTaskWorktree();
  const closeWorkspace = useCloseTaskWorkspace();
  const [editing, setEditing] = useState(false);
  // The user chose to keep the herdr workspace of this paused task open for now.
  const [keepingWorkspace, setKeepingWorkspace] = useState(false);
  const [concluding, setConcluding] = useState(false);
  // A form that changes how the task ends: reopening or correcting a done task, or completing it as shipped by another.
  const [correcting, setCorrecting] = useState<"reopen" | "outcome" | "shipped" | null>(null);
  const [linkingIssue, setLinkingIssue] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  // A prerequisite that would pause this started task, waiting for confirmation.
  const [confirmingPrerequisite, setConfirmingPrerequisite] = useState<TaskId | null>(null);
  const herdrRunning = herdr.data?.running === true;
  // Tasks of a plain directory have no branch, worktree, pull request, or herdr workspace.
  const capabilities = context.capabilities(task.workspaceId);
  const inReview = task.status === "in_review";
  const active = task.status === "in_progress" || inReview;
  const hasWorktree = capabilities.herdr && active && task.worktreePath !== null;
  const agentStatus = agentStatuses.data?.find((entry) => entry.taskId === task.id)?.status;
  const pullRequestStatus =
    capabilities.pullRequests && inReview
      ? pullRequestStatuses.data?.find((entry) => entry.taskId === task.id)
      : undefined;
  const finishing = refreshCommits.isPending || openPullRequest.isPending || completeTask.isPending;
  const final = task.status === "done";
  const criteriaMet = task.criteria.every((criterion) => criterion.state === "met");
  const unmetCriteria = task.criteria.filter((criterion) => criterion.state !== "met").length;
  // A started task completes once its criteria are met, or right away when it has none.
  const completable = inReview || (task.status === "in_progress" && criteriaMet);
  const paused = isPaused(task);
  const startable = task.status === "planned" && dependenciesDone(task, context.byId);
  // Prerequisites concluded without merging: this task cannot build on them.
  const notAdopted = task.status === "planned" ? task.dependsOn.filter((id) => isNotAdopted(context.byId.get(id))) : [];
  // A paused task may still have the worktree it had while it was worked on.
  const removableWorktree = !active && task.worktreePath !== null;
  // A rejected delete means the worktree has local changes; offer to discard them.
  const dirtyWorktree =
    removableWorktree && deleteTask.error instanceof CommandFailure && deleteTask.error.kind === "rejected";
  const dependenciesEditable = dependencyEditableStatuses.includes(task.status);
  // A planned task can start (or a paused one resume) once these prerequisites are done.
  const waitingOn = waitingPrerequisites(task, context.byId);
  // What an agent reported blocks the work, or the prerequisites a pause waits on.
  const blocker = openBlocker(task, context.byId);
  const changingDependencies = addDependency.isPending || removeDependency.isPending;
  const serverDown = useServerDown();
  const actionError =
    startTask.error ??
    openTask.error ??
    focusAgent.error ??
    refreshCommits.error ??
    openPullRequest.error ??
    completeTask.error ??
    pauseTask.error ??
    deleteTask.error ??
    restoreWorktree.error ??
    closeWorkspace.error ??
    addDependency.error ??
    removeDependency.error;
  const candidates = tasks.filter(
    (other) => other.id !== task.id && !task.dependsOn.includes(other.id),
  );
  // Candidates grouped by workspace, the task's own workspace first.
  const candidateGroups = [...new Set([task.workspaceId, ...candidates.map((other) => other.workspaceId)])]
    .map((workspaceId) => ({
      workspaceId,
      tasks: candidates.filter((other) => other.workspaceId === workspaceId),
    }))
    .filter((group) => group.tasks.length > 0);

  function confirm(action: Confirmation) {
    deleteTask.mutate({ id: task.id, force: action === "force-delete" }, { onSettled: () => setConfirming(null) });
  }

  // Actions in a fixed order; the first applicable of the main ones is the task's next action.
  const herdrBlocked = task.herdrWorkspaceId !== null && !herdrRunning;
  // Why actions that need herdr are disabled, as their tooltip and as a note below them.
  const herdrReason = herdrRunning
    ? null
    : herdr.isPending
      ? "Checking whether herdr is running..."
      : "herdr is not running on the server; start it there (`herdr status --json` shows whether it runs), then try again";
  const needsHerdr = (title: string | undefined) => herdrReason ?? title;
  const start: Action | null =
    task.status === "planned"
      ? {
          key: "start", changesData: true,
          label: startTask.isPending ? "Starting..." : paused ? "Resume" : "Start",
          ariaLabel: `${paused ? "Resume" : "Start"} #${task.id}`,
          icon: <Play />,
          title: startable
            ? capabilities.herdr
              ? needsHerdr(undefined)
              : undefined
            : notAdopted.length > 0
              ? "A dependency was not adopted; remove it to start"
              : "Waits until all its dependencies are done",
          // Without herdr, starting only marks the task in progress.
          disabled: !startable || (capabilities.herdr && !herdrRunning) || startTask.isPending,
          onSelect: () => startTask.mutate(task.id),
        }
      : null;
  const restore: Action | null =
    capabilities.herdr && active && (task.worktreePath === null || task.worktreeMissing) && task.branch !== null
      ? {
          key: "restore", changesData: true,
          label: restoreWorktree.isPending ? "Restoring..." : "Restore worktree",
          ariaLabel: `Restore worktree of #${task.id}`,
          icon: <FolderGit2 />,
          title: needsHerdr(`Check out ${task.branch} into a new worktree and open it in herdr`),
          disabled: !herdrRunning || restoreWorktree.isPending,
          onSelect: () => restoreWorktree.mutate(task.id),
        }
      : null;
  const openPr: Action | null =
    capabilities.pullRequests && hasWorktree && !inReview
      ? {
          key: "open-pr", changesData: true,
          label: openPullRequest.isPending ? "Pushing..." : "Open PR",
          ariaLabel: `Open pull request for #${task.id}`,
          icon: <GitPullRequest />,
          disabled: finishing,
          onSelect: () => openPullRequest.mutate(task.id),
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
            ? `${unmetCriteria} of ${task.criteria.length} criteria not met yet; check the manual ones under Criteria, Toodo checks the automatic ones every minute`
            : herdrBlocked
              ? needsHerdr(undefined)
              : capabilities.herdr
                ? "Complete the task; its herdr workspace is closed and the worktree kept"
                : undefined,
          disabled: finishing || herdrBlocked || !criteriaMet,
          onSelect: () => completeTask.mutate(task.id),
        }
      : null;
  const push: Action | null =
    capabilities.pullRequests && hasWorktree && inReview
      ? {
          key: "push", changesData: true,
          label: openPullRequest.isPending ? "Pushing..." : "Push to PR",
          ariaLabel: `Push #${task.id} to its pull request`,
          icon: <Upload />,
          disabled: finishing,
          onSelect: () => openPullRequest.mutate(task.id),
        }
      : null;
  const openInHerdr: Action | null =
    capabilities.herdr && active && task.herdrWorkspaceId
      ? {
          key: "open", changesData: true,
          label: "Open in herdr",
          ariaLabel: `Open #${task.id} in herdr`,
          icon: <SquareTerminal />,
          title: needsHerdr(undefined),
          disabled: !herdrRunning || openTask.isPending,
          onSelect: () => openTask.mutate(task.id),
        }
      : null;
  const focusPane: Action | null =
    detailed && capabilities.herdr && active && task.herdrWorkspaceId && agentStatus
      ? {
          key: "focus", changesData: true,
          label: "Focus agent pane",
          ariaLabel: `Focus agent pane of #${task.id}`,
          icon: <Crosshair />,
          title: needsHerdr("Focus the herdr pane of the agent working on this task"),
          disabled: !herdrRunning || focusAgent.isPending,
          onSelect: () => focusAgent.mutate(task.id),
        }
      : null;
  const refresh: Action | null = hasWorktree
    ? {
        key: "refresh", changesData: true,
        label: refreshCommits.isPending ? "Refreshing..." : "Refresh commits",
        ariaLabel: `Refresh commits of #${task.id}`,
        icon: <RefreshCw className={cn(refreshCommits.isPending && "animate-spin")} />,
        disabled: finishing,
        onSelect: () => refreshCommits.mutate(task.id),
      }
    : null;
  const conclude: Action | null = active
    ? {
        key: "conclude",
        label: "Conclude",
        ariaLabel: `Conclude #${task.id} without merging`,
        icon: <CircleSlash />,
        title: herdrBlocked
          ? needsHerdr(undefined)
          : capabilities.pullRequests
            ? "Finish without merging, e.g. research whose result is not adopted; an open pull request is closed"
            : "Finish without merging, e.g. research whose result is not adopted",
        disabled: finishing || herdrBlocked,
        onSelect: () => setConcluding(true),
      }
    : null;
  const primary = [start, restore, openPr, complete, openInHerdr].find((action) => action !== null) ?? null;
  const others = [start, restore, openPr, complete, push, openInHerdr, focusPane, refresh, conclude].filter(
    (action): action is Action => action !== null && action !== primary,
  );
  // Secondary actions always sit in the "More" menu, Delete last.
  const secondaryActions: (Action | null)[] = [
    capabilities.github && !final && task.issue === null && !linkingIssue
      ? {
          key: "link-issue",
          label: "Link issue",
          ariaLabel: `Link issue to #${task.id}`,
          icon: <CircleDot />,
          title: "Link a GitHub issue; the pull request closes it on merge",
          onSelect: () => setLinkingIssue(true),
        }
      : null,
    !final ? { key: "edit", label: "Edit", ariaLabel: `Edit #${task.id}`, icon: <Pencil />, onSelect: () => setEditing(true) } : null,
    active
      ? {
          key: "pause", changesData: true,
          label: "Pause",
          ariaLabel: `Pause #${task.id}`,
          icon: <Pause />,
          title: capabilities.herdr
            ? "Pause: stop working on the task; it keeps its branch, worktree, and pull request and can be resumed"
            : "Pause: stop working on the task; it can be resumed",
          disabled: pauseTask.isPending,
          onSelect: () => pauseTask.mutate(task.id),
        }
      : null,
    final && isNotAdopted(task)
      ? {
          key: "shipped",
          label: "Complete as shipped by...",
          ariaLabel: `Complete #${task.id} as shipped by another task or pull request`,
          icon: <GitMerge />,
          title: capabilities.github
            ? "The work did ship, through another task or a merged pull request: mark it done as that one ended"
            : "The work did ship, through another task: mark it done as that one ended",
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
          title: capabilities.herdr
            ? "Reopen a task completed or concluded by mistake; it is paused and resumes on its branch"
            : "Reopen a task completed or concluded by mistake; it is paused and can be resumed",
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
          title: removableWorktree
            ? needsHerdr("Delete the task and remove its worktree and herdr workspace; the branch is kept")
            : "Delete",
          disabled: removableWorktree && !herdrRunning,
          destructive: true,
          onSelect: () => setConfirming("delete"),
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
  // A shown action is disabled because herdr is not running: say so next to it, not only on hover.
  const shownActions = detailed ? [primary, ...others] : [primary];
  const herdrNote =
    herdrReason !== null &&
    shownActions.some((action) => action?.disabled === true && action.title === herdrReason);
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
          <TaskEditForm task={task} capabilities={capabilities} onDone={() => setEditing(false)} />
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
            {pullRequestStatus && <PullRequestBadges taskId={task.id} status={pullRequestStatus} />}
            {active && agentStatus && <AgentBadge taskId={task.id} status={agentStatus} />}
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
              {hasWorktree && <FreshnessWarning taskId={task.id} />}
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
              title={
                task.status !== "in_progress"
                  ? undefined
                  : capabilities.herdr
                    ? "A prerequisite that is not done pauses this task and closes its herdr workspace; the worktree is kept"
                    : "A prerequisite that is not done pauses this task"
              }
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
      {capabilities.herdr && paused && waitingOn.length > 0 && task.herdrWorkspaceId !== null && (
        <OpenWorkspaceNote
          taskId={task.id}
          collapsed={keepingWorkspace}
          blockedReason={herdrReason}
          disabled={!herdrRunning || closeWorkspace.isPending}
          onClose={() => closeWorkspace.mutate(task.id)}
          onKeep={() => setKeepingWorkspace(true)}
        />
      )}
      {detailed && hasWorktree && <Suspense fallback={null}><BranchFreshnessNote taskId={task.id} /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskPlan task={task} /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskTimeline task={task} detailed /></Suspense>}
      {detailed && capabilities.herdr && task.branch && (
        <DetailField label="Branch">
          <span className="break-all font-mono select-all">{task.branch}</span>
        </DetailField>
      )}
      {detailed && capabilities.herdr && task.worktreePath && (
        <DetailField label="Worktree">
          <PathLabel
            label={`worktree path of #${task.id}`}
            full={normalizePath(task.worktreePath)}
            short={shortPath(task.worktreePath)}
            className="font-mono"
          />
        </DetailField>
      )}
      {detailed && capabilities.pullRequests && task.pullRequestUrl && (
        <DetailField label="Pull request">
          <span className="break-all font-mono select-all">{task.pullRequestUrl}</span>
          {task.pullRequest && (
            <span aria-label={`Pull request of #${task.id}`} className="text-muted-foreground">
              {pullRequestStats(task.pullRequest)}
            </span>
          )}
        </DetailField>
      )}
      {/* A started task of a plain or tmux workspace has its runs here; one in progress starts them. */}
      {detailed && capabilities.plainRuns && (task.status !== "planned" || isPaused(task)) && (
        <RunsPanel task={task} remote={context.remote(task.workspaceId)} />
      )}
      {detailed && task.mergedWith && (
        <Suspense fallback={null}>
          <ShippedWith
            task={task}
            mergedWith={task.mergedWith}
            through={task.mergedWith.taskId === null ? null : taskRef(task.mergedWith.taskId, task.workspaceId, context)}
            detailed
          />
        </Suspense>
      )}
      {((detailed && task.issue !== null) || linkingIssue) && (
        <TaskIssue task={task} detailed={detailed} linking={linkingIssue} onDone={() => setLinkingIssue(false)} />
      )}
      {detailed && <Suspense fallback={null}><RelatedTasks task={task} tasks={tasks} context={context} navigation={navigation} /></Suspense>}
      {detailed && <Suspense fallback={null}><CommitList task={task} detailed /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskActivity task={task} capabilities={capabilities} /></Suspense>}
      {detailed && <Suspense fallback={null}><AgentActivity task={task} capabilities={capabilities} /></Suspense>}
      {detailed && <Suspense fallback={null}><TaskNotes task={task} detailed /></Suspense>}
      {final && !editing && (detailed || addingNote) && (
        <CompletionNote task={task} adding={addingNote} onAdded={() => setAddingNote(false)} />
      )}
      {actionError && (
        <p role="alert" className="text-xs text-destructive">
          {actionError.message}
        </p>
      )}
      {herdrNote && !editing && !concluding && correcting === null && (
        <p role="note" aria-label={`herdr unavailable for #${task.id}`} className="text-xs text-muted-foreground">
          {herdrReason}
        </p>
      )}
      {concluding && !editing && (
        <ConcludeForm
          task={task}
          capabilities={capabilities}
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
        <ReopenForm task={task} capabilities={capabilities} onDone={() => setCorrecting(null)} />
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
            onKeyDown={confirming ? escapeCloses(() => setConfirming(null), deleteTask.isPending) : undefined}
          >
            {confirming ? (
              <>
                <span className="min-w-0 flex-1 basis-48 text-xs">
                  {deleteQuestion(confirming, task.id, removableWorktree)}
                </span>
                <Button
                  size="xs"
                  variant="destructive"
                  aria-label={`${confirmLabels[confirming]} #${task.id}`}
                  disabled={deleteTask.isPending}
                  onClick={() => confirm(confirming)}
                >
                  <Trash2 />
                  {deleteTask.isPending ? "Deleting..." : confirmLabels[confirming]}
                </Button>
                {/* Focus lands on Back, under the pointer, so a double click cannot delete. */}
                <Button key="back" size="xs" variant="ghost" autoFocus onClick={() => setConfirming(null)}>
                  Back
                </Button>
              </>
            ) : (
              <>
                {dirtyWorktree && (
                  <Button
                    size="xs"
                    variant="destructive"
                    aria-label={`Force delete #${task.id}`}
                    title={needsHerdr("Delete the task and discard the modified and untracked files of its worktree")}
                    disabled={!herdrRunning}
                    onClick={() => setConfirming("force-delete")}
                  >
                    Force delete
                  </Button>
                )}
                {menu.length > 0 && <MoreMenu label={`More actions for #${task.id}`} actions={menu} />}
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** A row's short warning that its branch is behind its base or conflicts; nothing while it is fresh or unchecked. */
function FreshnessWarning({ taskId }: { taskId: TaskId }) {
  const freshness = useBranchFreshness(taskId, true);
  const warning = freshness.data ? freshnessWarning(freshness.data) : null;
  if (!freshness.data || warning === null) {
    return null;
  }
  const conflicting = freshness.data.mergeable === "conflicting";
  return (
    <span
      role="note"
      aria-label={`Base freshness of #${taskId}`}
      data-conflicting={conflicting || undefined}
      className={conflicting ? toneText.danger : toneText.attention}
    >
      {warning}
    </span>
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

/**
 * Asks whether to close the herdr workspace that a task paused on a new prerequisite still
 * has, e.g. because an agent added the prerequisite through MCP. Collapsed after "Keep
 * open", it still offers to close it.
 */
function OpenWorkspaceNote({
  taskId,
  collapsed,
  blockedReason,
  disabled,
  onClose,
  onKeep,
}: {
  taskId: TaskId;
  collapsed: boolean;
  /** Why closing needs herdr and cannot happen now; null while herdr runs. */
  blockedReason: string | null;
  disabled: boolean;
  onClose: () => void;
  onKeep: () => void;
}) {
  const close = (
    <Button
      size="xs"
      variant="destructive"
      aria-label={`Close herdr workspace of #${taskId}`}
      title={blockedReason ?? "Close the herdr workspace, which ends its agent session; the worktree is kept"}
      disabled={disabled}
      onClick={onClose}
    >
      <X />
      Close workspace
    </Button>
  );
  if (collapsed) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>herdr workspace still open</span>
        {close}
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label={`Herdr workspace of paused #${taskId}`}
      className={cn("flex flex-col gap-2 rounded-md p-2 text-xs", tonePanel.attention)}
    >
      <p>
        Paused for a new prerequisite, but its herdr workspace is still open. Close it? This ends its agent
        session; the worktree is kept for resuming.
      </p>
      <div className="flex gap-2">
        {close}
        <Button size="xs" variant="ghost" aria-label={`Keep herdr workspace of #${taskId} open`} onClick={onKeep}>
          Keep open
        </Button>
      </div>
    </div>
  );
}
