import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  Crosshair,
  Flag,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  Inbox,
  PanelRight,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SquareTerminal,
  StickyNote,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrerequisiteConfirmation } from "@/components/prerequisite-confirmation";
import {
  compactSelectClass,
  inputClass,
  describeLocation,
  MoveWorkspaceForm,
  PathProblemNote,
  escapeCloses,
  shortLocation,
} from "@/components/workspace-list";
import { PathLabel } from "@/components/path-label";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import { DetailsSheet } from "@/components/details-sheet";
import { AgentBadge } from "@/components/agent-badge";
import type { SheetNavigation } from "@/components/task-graph";
import { PullRequestBadges } from "@/components/pull-request-badge";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { CollapsibleForm } from "@/components/collapsible-form";
import { MarkdownEditor } from "@/components/markdown-editor";
import { MoreMenu, type Action } from "@/components/more-menu";
import type {
  AgentMerge,
  CheckKind,
  CheckedBy,
  Criterion,
  CriterionId,
  CriterionInput,
  CriterionState,
  Estimate,
  EstimateUnit,
  MergedWith,
  NoteKind,
  Task,
  TaskId,
  TaskResolution,
  TaskStatus,
  TaskType,
  Workspace,
  WorkspaceId,
} from "@/lib/bindings";
import {
  CommandFailure,
  IssueLinkFailure,
  machineOf,
  useAddDependency,
  useAddRelation,
  useAgentStatuses,
  useCloseTaskWorkspace,
  useBranchFreshness,
  useCheckCriterion,
  usePullRequestStatuses,
  useCommitRecords,
  useCompleteTask,
  useCompleteTaskMergedWith,
  useConcludeTask,
  useCreateBaseBranch,
  useCreateIssue,
  useCreateTask,
  useDeleteTask,
  useFocusAgentPane,
  useHerdrStatus,
  useLinkIssue,
  useMachineSettings,
  useOpenPullRequest,
  useOpenTaskInHerdr,
  usePauseTask,
  useRefreshCommitRecords,
  useRemoveDependency,
  useRemoveRelation,
  useReopenTask,
  useRestoreTaskWorktree,
  useSaveMachineSettings,
  useSetCompletionNote,
  useSetTaskOutcome,
  useStartTask,
  useTaskRelations,
  useTasks,
  useUpdateTask,
  useUpdateWorkspace,
  useWorkspaceBranches,
  useWorkspaces,
} from "@/lib/queries";
import { pullRequestStats } from "@/lib/review";
import {
  dependenciesDone,
  dependencyEditableStatuses,
  freshnessWarning,
  isNotAdopted,
  isPaused,
  waitingPrerequisites,
  type TimelineScale,
} from "@/lib/task-graph";
import {
  defaultTaskFilter,
  emptyTaskFilter,
  groupTasks,
  isFilterActive,
  matchesFilter,
  shownStatus,
  shownStatuses,
  taskGroupNames,
  taskNumber,
  toggleStatus,
  type ShownStatus,
  type TaskFilter,
} from "@/lib/task-filter";
import { needsAttention, openBlocker } from "@/lib/attention";
import { formatFull, formatWhen, reachedMilestones } from "@/lib/timeline";
import { When } from "@/components/when";
import { firstParagraph, markdownPreview } from "@/lib/markdown";
import { dueState, dueStateLabels, formatEstimate, parseEstimateAmount } from "@/lib/plan";
import { normalizePath, shortPath } from "@/lib/paths";
import {
  statusNames,
  toneChip,
  toneFill,
  toneOutline,
  tonePanel,
  toneText,
  type Tone,
} from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { reachability, subscribeReachability } from "@/web/connection";

const Markdown = lazy(() => import("@/components/markdown"));
// The timeline pulls in React Flow, so it loads only when it is first shown.
const TaskGraph = lazy(() => import("@/components/task-graph").then((module) => ({ default: module.TaskGraph })));

const taskTypes: TaskType[] = ["feat", "fix", "modify", "refactor", "docs", "test", "chore", "rnd"];

/**
 * The status of `task`, naming a planned task that can be started now "Ready", one still
 * waiting on a prerequisite "Blocked", one that was worked on before "Paused" and a task
 * concluded without merging "Not adopted".
 */
function statusLabel(task: Task, byId: ReadonlyMap<TaskId, Task>): string {
  if (task.status === "done" && task.resolution === "completed") return "Completed";
  return statusNames[shownStatus(task, byId)];
}

/** The tone of each shown status, shared by the status chips and the status filter. */
const statusTones: Record<ShownStatus, Tone> = {
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
function shownStatusStyle(status: ShownStatus): string {
  return status === "not_adopted" ? notAdoptedStyle : toneChip[statusTones[status]];
}

/** The Complete button, in the colour of the done status it leads to; still tinted while disabled. */
const completeStyle = cn(
  shownStatusStyle("done"),
  "border-transparent hover:bg-emerald-200 dark:hover:bg-emerald-900 disabled:bg-emerald-100 disabled:opacity-60 dark:disabled:bg-emerald-950",
);

function statusStyle(task: Task, byId: ReadonlyMap<TaskId, Task>): string {
  return shownStatusStyle(shownStatus(task, byId));
}

/** What the task list needs to name tasks of other workspaces. */
type TaskContext = {
  /** Tasks of every workspace, by ID. */
  byId: ReadonlyMap<TaskId, Task>;
  workspaceName: (id: WorkspaceId) => string;
};

/** `#id`, prefixed with the workspace name when the task belongs to another workspace than `of`. */
function taskRef(id: TaskId, of: WorkspaceId, { byId, workspaceName }: TaskContext): string {
  const other = byId.get(id);
  return other === undefined || other.workspaceId === of ? `#${id}` : `${workspaceName(other.workspaceId)} #${id}`;
}

/**
 * Tasks of `workspace`, or of every workspace when it is null. The dependency DAG spans
 * workspaces, so a task may wait on a task of another workspace. The timeline is only
 * offered for every workspace, where it is the default view.
 */
/** A request to select a task on the timeline; each request is a new object. */
export type ShownTask = { id: TaskId };

export function TaskList({
  workspace,
  timelineScale,
  onTimelineScaleChange,
  draft = emptyDraft,
  onDraftChange,
  shownTask = null,
  onTaskShown,
}: {
  workspace: Workspace | null;
  /** Timeline scale, owned by the caller so it survives switching workspaces and views. */
  timelineScale: TimelineScale;
  onTimelineScaleChange: (scale: TimelineScale) => void;
  /** The new task being written in this workspace, owned by the caller so it survives switching away. */
  draft?: TaskDraft;
  onDraftChange?: (draft: TaskDraft) => void;
  /** A task to select on the timeline, which switches to it and clears filters hiding the task. */
  shownTask?: ShownTask | null;
  /** Called once the timeline selected `shownTask`. */
  onTaskShown?: () => void;
}) {
  const allTasks = useTasks();
  const workspaces = useWorkspaces();
  const [view, setView] = useState<"list" | "timeline">("timeline");
  const [timelineWorkspace, setTimelineWorkspace] = useState<WorkspaceId | null>(null);
  // The filter the user set; until then the timeline leaves finished tasks out and the list shows every status.
  const [chosenFilter, setTaskFilter] = useState<TaskFilter | null>(null);
  const agentStatuses = useAgentStatuses();
  const pullRequestStatuses = usePullRequestStatuses();
  // Done tasks are folded away until asked for, or while a search or filter is narrowing the list.
  const [doneShown, setDoneShown] = useState<boolean | null>(null);
  const [detailId, setDetailId] = useState<TaskId | null>(null);
  const names = new Map(workspaces.data?.map((entry) => [entry.id, entry.name]));
  const context: TaskContext = {
    byId: new Map(allTasks.data?.map((task) => [task.id, task])),
    workspaceName: (id) => names.get(id) ?? `Workspace ${id}`,
  };
  const tasks =
    workspace === null ? allTasks.data : allTasks.data?.filter((task) => task.workspaceId === workspace.id);
  const showTimeline = workspace === null && view === "timeline";
  const taskFilter = chosenFilter ?? (showTimeline ? defaultTaskFilter : emptyTaskFilter);
  // Workspaces the timeline can be narrowed to; a filter whose workspace has no tasks left falls back to all.
  const filterOptions = [...new Set(allTasks.data?.map((task) => task.workspaceId))].sort((a, b) =>
    context.workspaceName(a).localeCompare(context.workspaceName(b)),
  );
  const filter = timelineWorkspace !== null && filterOptions.includes(timelineWorkspace) ? timelineWorkspace : null;
  // A search for a task number finds that task in any workspace, shown first, ahead of the text matches.
  const numberedId = taskNumber(taskFilter.query);
  const numberedCandidate = numberedId === null ? undefined : context.byId.get(numberedId);
  const numbered =
    numberedCandidate !== undefined && matchesFilter(numberedCandidate, { ...taskFilter, query: "" }, context.byId)
      ? numberedCandidate
      : undefined;
  const filtered = tasks?.filter(
    (task) =>
      task !== numbered &&
      (!showTimeline || filter === null || task.workspaceId === filter) &&
      matchesFilter(task, taskFilter, context.byId),
  );
  const timelineTasks = numbered === undefined ? (filtered ?? []) : [numbered, ...(filtered ?? [])];
  const shownTaskData = shownTask === null ? undefined : context.byId.get(shownTask.id);
  useEffect(() => {
    if (shownTaskData === undefined) {
      return;
    }
    setView("timeline");
    setTimelineWorkspace((current) => (current === shownTaskData.workspaceId ? current : null));
    setTaskFilter((chosen) => {
      const current = chosen ?? defaultTaskFilter;
      return matchesFilter(shownTaskData, current, context.byId) ? chosen : emptyTaskFilter;
    });
    // Only a new request moves the view; later changes to the task do not.
  }, [shownTask, shownTaskData === undefined]);
  // Prerequisites in other workspaces are drawn too, dimmed, so the wait is visible.
  const prerequisites =
    filter === null
      ? []
      : (tasks ?? []).filter(
          (task) =>
            task !== numbered &&
            task.workspaceId !== filter &&
            timelineTasks.some((own) => own.dependsOn.includes(task.id)),
        );

  return (
    <section aria-labelledby="tasks-heading" className="flex flex-1 flex-col gap-4 max-md:gap-3">
      <header className="flex flex-col max-md:gap-2">
        <h2 id="tasks-heading" className="text-xl font-semibold tracking-tight">
          {workspace?.name ?? "All workspaces"}
        </h2>
        {workspace ? (
          <>
            <BaseBranchForm workspace={workspace} />
            <AgentMergeSetting workspace={workspace} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground max-md:hidden">Tasks of every workspace and the dependencies between them.</p>
        )}
      </header>

      {workspace && <WorktreeRootForm workspace={workspace} />}

      {workspace && onDraftChange && <NewTaskForm workspace={workspace} draft={draft} onChange={onDraftChange} />}

      {allTasks.isPending && <p className="text-sm text-muted-foreground">Loading tasks...</p>}
      {allTasks.isError && (
        <p role="alert" className="text-sm text-destructive">
          Failed to load tasks: {allTasks.error.message}
        </p>
      )}
      {tasks?.length === 0 && (
        <EmptyState
          title={workspace ? "No tasks in this workspace yet." : "No tasks yet."}
          hint={
            workspace
              ? "Plan the first task above; tasks can depend on each other across workspaces."
              : "Pick a workspace in the sidebar to plan its tasks."
          }
        />
      )}
      {allTasks.data && tasks && filtered && tasks.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {workspace === null && (
              <div role="group" aria-label="Task view" className="flex gap-1 max-md:gap-2">
                {(["timeline", "list"] as const).map((option) => (
                  <Button
                    key={option}
                    size="xs"
                    variant={view === option ? "default" : "ghost"}
                    aria-pressed={view === option}
                    onClick={() => setView(option)}
                  >
                    {option === "list" ? "List" : "Timeline"}
                  </Button>
                ))}
              </div>
            )}
            {showTimeline && (
              <select
                aria-label="Timeline workspace"
                className={compactSelectClass}
                value={filter ?? "all"}
                onChange={(event) =>
                  setTimelineWorkspace(event.target.value === "all" ? null : Number(event.target.value))
                }
              >
                <option value="all">All workspaces</option>
                {filterOptions.map((id) => (
                  <option key={id} value={id}>
                    {context.workspaceName(id)}
                  </option>
                ))}
              </select>
            )}
            <TaskFilterBar filter={taskFilter} onChange={setTaskFilter} />
          </div>
          {filtered.length === 0 && numbered === undefined ? (
            <EmptyState
              icon={<Search />}
              title="No tasks match the search and filters."
              hint="Change the search text, status, or type, or clear the filters."
            />
          ) : !showTimeline ? (
            <>
            <div role="region" aria-label="Tasks" className="flex flex-col gap-4">
              {numbered && (
                <section aria-label="Task number match" className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    Task <span className="tabular-nums font-normal">#{numbered.id}</span>
                  </h3>
                  <ul aria-label="Task number match" className="flex flex-col divide-y rounded-xl border bg-card shadow-xs">
                    <TaskRow
                      task={numbered}
                      tasks={allTasks.data}
                      context={context}
                      showWorkspace={workspace === null || numbered.workspaceId !== workspace.id}
                      onShowDetails={() => setDetailId(numbered.id)}
                    />
                  </ul>
                </section>
              )}
              {groupTasks(
                filtered,
                context.byId,
                needsAttention(filtered, agentStatuses.data ?? [], pullRequestStatuses.data ?? [], context.byId).map(
                  (item) => item.task.id,
                ),
              ).map(({ group, tasks: grouped }) => {
                const collapsed = group === "done" && !(doneShown ?? isFilterActive(taskFilter));
                const name = taskGroupNames[group];
                const count = <span className="tabular-nums font-normal">{grouped.length}</span>;
                return (
                  <section key={group} aria-label={name} className="flex flex-col gap-2">
                    <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                      {group === "done" ? (
                        <button
                          type="button"
                          aria-expanded={!collapsed}
                          className="flex items-center gap-1.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11"
                          onClick={() => setDoneShown(collapsed)}
                        >
                          <ChevronDown aria-hidden className={cn("size-4 transition-transform", collapsed && "-rotate-90")} />
                          {name} {count}
                        </button>
                      ) : (
                        <>
                          {name} {count}
                        </>
                      )}
                    </h3>
                    {!collapsed && (
                      <ul aria-label={name} className="flex flex-col divide-y rounded-xl border bg-card shadow-xs">
                        {grouped.map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            tasks={allTasks.data}
                            context={context}
                            showWorkspace={workspace === null}
                            onShowDetails={() => setDetailId(task.id)}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
              {detailId !== null && context.byId.has(detailId) && (
                <TaskDetailsSheet onClose={() => setDetailId(null)}>
                  <TaskRow
                    key={detailId}
                    task={context.byId.get(detailId)!}
                    tasks={allTasks.data}
                    context={context}
                    showWorkspace
                    detailed
                    navigation={{ open: setDetailId, canOpen: (id) => context.byId.has(id) }}
                  />
                </TaskDetailsSheet>
              )}
            </>
          ) : (
            <Suspense fallback={<p className="text-sm text-muted-foreground">Loading timeline...</p>}>
              <TaskGraph
                tasks={[...timelineTasks, ...prerequisites]}
                allTasks={allTasks.data}
                dimmed={new Set(prerequisites.map((task) => task.id))}
                workspaceLabel={(task) =>
                  filter === null || task.workspaceId !== filter ? context.workspaceName(task.workspaceId) : null
                }
                statusLabel={(task) => statusLabel(task, context.byId)}
                statusStyle={(task) => statusStyle(task, context.byId)}
                ready={(task) => shownStatus(task, context.byId) === "ready"}
                scale={timelineScale}
                onScaleChange={onTimelineScaleChange}
                shownTaskId={shownTask?.id ?? null}
                onTaskShown={() => onTaskShown?.()}
                renderDetail={(selected, navigation) => (
                  <TaskRow
                    key={selected.id}
                    task={selected}
                    tasks={allTasks.data ?? []}
                    context={context}
                    showWorkspace
                    detailed
                    navigation={navigation}
                  />
                )}
              />
            </Suspense>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The details sheet of the task list, like the timeline's. Escape, the close button, or a swipe
 * down closes it, after asking when an edit form in it has unsaved changes.
 */
function TaskDetailsSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const sheet = useRef<HTMLElement>(null);
  const [discarding, setDiscarding] = useState(false);

  function close() {
    if (sheet.current?.querySelector("form[data-dirty]")) {
      setDiscarding(true);
    } else {
      onClose();
    }
  }

  useEffect(() => {
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("[role=menu]")) {
        return;
      }
      if (discarding) {
        setDiscarding(false);
      } else if (!(event.target instanceof HTMLElement && event.target.closest("input, textarea, select"))) {
        close();
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  });

  return (
    <DetailsSheet
      ref={sheet}
      width="min(480px, max(360px, 40vw), calc(100vw - 32px))"
      onClose={close}
      banner={
        discarding && (
          <div
            role="group"
            aria-label="Unsaved changes"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-xs"
          >
            <span className="min-w-0 flex-1">Discard your unsaved changes?</span>
            <Button size="xs" variant="outline" autoFocus onClick={() => setDiscarding(false)}>
              Keep editing
            </Button>
            <Button size="xs" variant="destructive" onClick={onClose}>
              Discard changes
            </Button>
          </div>
        )
      }
    >
      {children}
    </DetailsSheet>
  );
}

/** Search text and status and type filters narrowing the task list and the timeline. */
function TaskFilterBar({ filter, onChange }: { filter: TaskFilter; onChange: (filter: TaskFilter) => void }) {
  return (
    <div
      role="search"
      aria-label="Task filters"
      className="flex flex-1 flex-wrap items-center justify-end gap-2 max-md:grid max-md:basis-full max-md:grid-cols-2"
    >
      <input
        type="search"
        aria-label="Search tasks"
        placeholder="Search title, description, or #number"
        className={cn(compactSelectClass, "w-56 max-md:col-span-2 max-md:w-full")}
        value={filter.query}
        onChange={(event) => onChange({ ...filter, query: event.target.value })}
      />
      <div role="group" aria-label="Status filter" className="flex flex-wrap gap-1 max-md:col-span-2 max-md:gap-2">
        {shownStatuses.map((status) => {
          const selected = filter.statuses.includes(status);
          const tone = statusTones[status];
          // Selected: filled like the status chip, with a check. Not selected: outlined in the
          // same hue, with a dot.
          return (
            <button
              key={status}
              type="button"
              className={cn(
                "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11",
                selected
                  ? cn(shownStatusStyle(status), "border-transparent hover:brightness-95 dark:hover:brightness-125")
                  : cn(toneOutline[tone], "bg-transparent hover:bg-muted"),
              )}
              aria-pressed={selected}
              onClick={() => onChange({ ...filter, statuses: toggleStatus(filter.statuses, status) })}
            >
              {selected ? (
                <Check aria-hidden className="size-3" />
              ) : (
                <span aria-hidden className={cn("size-1.5 rounded-full", toneFill[tone])} />
              )}
              {statusNames[status]}
            </button>
          );
        })}
      </div>
      <select
        aria-label="Type filter"
        className={compactSelectClass}
        value={filter.type ?? "all"}
        onChange={(event) =>
          onChange({ ...filter, type: event.target.value === "all" ? null : (event.target.value as TaskType) })
        }
      >
        <option value="all">All types</option>
        {taskTypes.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      {isFilterActive(filter) && (
        <Button size="xs" variant="ghost" onClick={() => onChange(emptyTaskFilter)}>
          <X />
          Clear filters
        </Button>
      )}
    </div>
  );
}

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

function TaskTimeline({ task, detailed }: { task: Task; detailed: boolean }) {
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

function TaskRow({
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
  const inReview = task.status === "in_review";
  const active = task.status === "in_progress" || inReview;
  const hasWorktree = active && task.worktreePath !== null;
  const agentStatus = agentStatuses.data?.find((entry) => entry.taskId === task.id)?.status;
  const pullRequestStatus = inReview
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
            ? needsHerdr(undefined)
            : notAdopted.length > 0
              ? "A dependency was not adopted; remove it to start"
              : "Waits until all its dependencies are done",
          disabled: !startable || !herdrRunning || startTask.isPending,
          onSelect: () => startTask.mutate(task.id),
        }
      : null;
  const restore: Action | null =
    active && (task.worktreePath === null || task.worktreeMissing) && task.branch !== null
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
    hasWorktree && !inReview
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
              : "Complete the task; its herdr workspace is closed and the worktree kept",
          disabled: finishing || herdrBlocked || !criteriaMet,
          onSelect: () => completeTask.mutate(task.id),
        }
      : null;
  const push: Action | null =
    hasWorktree && inReview
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
    active && task.herdrWorkspaceId
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
    detailed && active && task.herdrWorkspaceId && agentStatus
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
          : "Finish without merging, e.g. research whose result is not adopted; an open pull request is closed",
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
    !final && task.issue === null && !linkingIssue
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
          title: "Pause: stop working on the task; it keeps its branch, worktree, and pull request and can be resumed",
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
          title: "The work did ship, through another task or a merged pull request: mark it done as that one ended",
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
          title: "Reopen a task completed or concluded by mistake; it is paused and resumes on its branch",
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
          <TaskEditForm task={task} onDone={() => setEditing(false)} />
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
      {detailed && !editing && <TaskCriteria task={task} detailed />}
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
                task.status === "in_progress"
                  ? "A prerequisite that is not done pauses this task and closes its herdr workspace; the worktree is kept"
                  : undefined
              }
              className={cn(compactSelectClass, "max-w-48")}
              value=""
              disabled={changingDependencies}
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
      {paused && waitingOn.length > 0 && task.herdrWorkspaceId !== null && (
        <OpenWorkspaceNote
          taskId={task.id}
          collapsed={keepingWorkspace}
          blockedReason={herdrReason}
          disabled={!herdrRunning || closeWorkspace.isPending}
          onClose={() => closeWorkspace.mutate(task.id)}
          onKeep={() => setKeepingWorkspace(true)}
        />
      )}
      {detailed && hasWorktree && <BranchFreshnessNote taskId={task.id} />}
      {detailed && <TaskPlan task={task} />}
      {detailed && <TaskTimeline task={task} detailed />}
      {detailed && task.branch && (
        <DetailField label="Branch">
          <span className="break-all font-mono select-all">{task.branch}</span>
        </DetailField>
      )}
      {detailed && task.worktreePath && (
        <DetailField label="Worktree">
          <PathLabel
            label={`worktree path of #${task.id}`}
            full={normalizePath(task.worktreePath)}
            short={shortPath(task.worktreePath)}
            className="font-mono"
          />
        </DetailField>
      )}
      {detailed && task.pullRequestUrl && (
        <DetailField label="Pull request">
          <span className="break-all font-mono select-all">{task.pullRequestUrl}</span>
          {task.pullRequest && (
            <span aria-label={`Pull request of #${task.id}`} className="text-muted-foreground">
              {pullRequestStats(task.pullRequest)}
            </span>
          )}
        </DetailField>
      )}
      {detailed && task.mergedWith && (
        <ShippedWith
          task={task}
          mergedWith={task.mergedWith}
          through={task.mergedWith.taskId === null ? null : taskRef(task.mergedWith.taskId, task.workspaceId, context)}
          detailed
        />
      )}
      {((detailed && task.issue !== null) || linkingIssue) && (
        <TaskIssue task={task} detailed={detailed} linking={linkingIssue} onDone={() => setLinkingIssue(false)} />
      )}
      {detailed && <RelatedTasks task={task} tasks={tasks} context={context} navigation={navigation} />}
      {detailed && <CommitList task={task} detailed />}
      {detailed && <TaskNotes task={task} detailed />}
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
      {correcting === "reopen" && !editing && <ReopenForm task={task} onDone={() => setCorrecting(null)} />}
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

/** The due date of a task, flagged when it is late or overdue. */
function DueDate({ task }: { task: Task }) {
  const state = dueState(task, Date.now() / 1000);
  const behind = state === "late" || state === "overdue";
  return (
    <span data-due-state={state ?? undefined} className={cn(behind && cn("font-medium", toneText.danger))}>
      {state === null || state === "upcoming" ? "Due" : dueStateLabels[state]} {task.dueDate}
    </span>
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

/** The status of `task` as a pill with a colored dot. */
/** Warns when a started task's branch is behind its base, e.g. after a prerequisite was merged. */
function BranchFreshnessNote({ taskId }: { taskId: TaskId }) {
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

function TaskEditForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const updateTask = useUpdateTask();
  const [taskType, setTaskType] = useState<TaskType>(task.taskType);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [initialPlan] = useState<PlanDraft>(() => ({
    estimate: task.estimate === null ? "" : String(task.estimate.amount),
    estimateUnit: task.estimate?.unit ?? "hours",
    dueDate: task.dueDate ?? "",
  }));
  const [plan, setPlan] = useState<PlanDraft>(initialPlan);
  const [initialCriteria] = useState(() => task.criteria.map((criterion) => criterionDraft(criterion)));
  const [criteria, setCriteria] = useState<CriterionDraft[]>(initialCriteria);
  // Checking "Done when merged" without a merge criterion asks the backend for the one of the repository.
  const [addMerge, setAddMerge] = useState(false);
  const hasMerge = criteria.some((draft) => isMergeKind(draft.kind));
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
    criteriaChanged ||
    addMerge;
  const guard = useDiscardGuard(dirty, onDone, updateTask.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (estimate === undefined || criteriaInvalid) return;
    updateTask.mutate(
      {
        id: task.id,
        taskType,
        title: title.trim(),
        description: description.trim(),
        estimate,
        dueDate: plan.dueDate || null,
        // The criteria of a done task cannot change.
        criteria: criteriaChanged && task.status !== "done" ? criterionInputs(criteria) : null,
        mergeCriterion: addMerge && !hasMerge && task.status !== "done",
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
          autoFocus
        />
      </div>
      <MarkdownEditor
        label={`Description of #${task.id}`}
        placeholder="Description (optional, Markdown)"
        value={description}
        onChange={setDescription}
      />
      <PlanFields suffix={` of #${task.id}`} plan={plan} onChange={setPlan} />
      {task.status !== "done" && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-muted-foreground">Completion criteria</span>
            <label
              className="flex items-center gap-1.5 max-md:min-h-11"
              title="Keep or add the criterion that its pull request is merged, or its branch merged locally in a repository without origin"
            >
              <input
                type="checkbox"
                aria-label={`Done when merged, #${task.id}`}
                checked={hasMerge || addMerge}
                onChange={(e) => {
                  setAddMerge(e.target.checked && !hasMerge);
                  if (!e.target.checked) setCriteria(criteria.filter((draft) => !isMergeKind(draft.kind)));
                }}
              />
              Done when merged
            </label>
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

/**
 * Concludes an active task without merging: the conclusion, why the work is not adopted, is
 * required and becomes its completion note.
 */
function ConcludeForm({ task, onDone, onShipped }: { task: Task; onDone: () => void; onShipped: () => void }) {
  const concludeTask = useConcludeTask();
  const [note, setNote] = useState("");
  const guard = useDiscardGuard(note.trim() !== "", onDone, concludeTask.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    concludeTask.mutate({ id: task.id, note: note.trim() }, { onSuccess: onDone });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Conclude #${task.id}`}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        Finish #{task.id} without merging. It is marked not adopted, its pull request is closed with the
        conclusion as a comment, and the branch is kept. Tasks that depend on it stay blocked.
      </p>
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Conclusion of #${task.id}`}
        placeholder="What was tried, what was found, and why it is not adopted."
        value={note}
        onChange={(e) => setNote(e.target.value)}
        required
        autoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard conclusion of #${task.id}`}
          question={`Discard your conclusion of #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button
            type="submit"
            size="xs"
            variant="destructive"
            disabled={concludeTask.isPending || note.trim() === ""}
          >
            <CircleSlash />
            {concludeTask.isPending ? "Concluding..." : "Conclude without merge"}
          </Button>
          {/* Work that shipped through another task's pull request is done, not concluded. */}
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-label={`Complete #${task.id} as shipped by another task or pull request`}
            title="The work shipped through another task or a merged pull request: complete the task instead"
            disabled={concludeTask.isPending}
            onClick={onShipped}
          >
            <GitMerge />
            Complete as shipped by...
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Back
          </Button>
        </div>
      )}
      {concludeTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {concludeTask.error.message}
        </p>
      )}
    </form>
  );
}

/** What a form says about the outcome of a task. */
const resolutionNames: Record<TaskResolution, string> = {
  merged: "Merged",
  completed: "Completed",
  not_adopted: statusNames.not_adopted,
};

/**
 * Reopens a done task completed or concluded by mistake. The reason is required and kept as
 * a progress note with the earlier outcome.
 */
function ReopenForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const reopenTask = useReopenTask();
  const [reason, setReason] = useState("");
  const guard = useDiscardGuard(reason.trim() !== "", onDone, reopenTask.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    reopenTask.mutate({ id: task.id, reason: reason.trim() }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} aria-label={`Reopen #${task.id}`} className="flex flex-col gap-1" onKeyDown={guard.onKeyDown}>
      <p className="text-xs text-muted-foreground">
        Reopen #{task.id}: it is paused with its branch and commits, and Resume continues the work. Its outcome and
        completion note are cleared and kept, with your reason, as a progress note.
      </p>
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Reason to reopen #${task.id}`}
        placeholder="Why is the task not finished after all?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        autoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard reason to reopen #${task.id}`}
          question={`Discard your reason to reopen #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button changesData type="submit" size="xs" disabled={reopenTask.isPending || reason.trim() === ""}>
            <RotateCcw />
            {reopenTask.isPending ? "Reopening..." : "Reopen"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Back
          </Button>
        </div>
      )}
      {reopenTask.isError && (
        <p role="alert" className="text-xs text-destructive">
          {reopenTask.error.message}
        </p>
      )}
    </form>
  );
}

/**
 * Corrects how a done task ended without reopening it. The note is required and becomes its
 * completion note; the earlier outcome is kept as a progress note.
 */
function OutcomeForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const setOutcome = useSetTaskOutcome();
  const choices = (Object.keys(resolutionNames) as TaskResolution[]).filter((resolution) => resolution !== task.resolution);
  const [resolution, setResolution] = useState<TaskResolution>(choices[0]);
  const [note, setNote] = useState("");
  const guard = useDiscardGuard(note.trim() !== "", onDone, setOutcome.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOutcome.mutate({ id: task.id, resolution, note: note.trim() }, { onSuccess: onDone });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Outcome of #${task.id}`}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        #{task.id} is done as {task.resolution === null ? "done" : resolutionNames[task.resolution].toLowerCase()}.
        Correct how it ended; the earlier outcome and note are kept as a progress note. Tasks that depend on it wait
        while it is not adopted.
      </p>
      <select
        aria-label={`New outcome of #${task.id}`}
        className={cn(inputClass, "w-40")}
        value={resolution}
        onChange={(e) => setResolution(e.target.value as TaskResolution)}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {resolutionNames[choice]}
          </option>
        ))}
      </select>
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Outcome note of #${task.id}`}
        placeholder="What happened, e.g. the change was reverted. This becomes the completion note."
        value={note}
        onChange={(e) => setNote(e.target.value)}
        required
        autoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard outcome of #${task.id}`}
          question={`Discard the new outcome of #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button changesData type="submit" size="xs" disabled={setOutcome.isPending || note.trim() === ""}>
            <Flag />
            {setOutcome.isPending ? "Saving..." : "Change outcome"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Back
          </Button>
        </div>
      )}
      {setOutcome.isError && (
        <p role="alert" className="text-xs text-destructive">
          {setOutcome.error.message}
        </p>
      )}
    </form>
  );
}

/**
 * Completes a task whose work shipped through another task, one done as merged or
 * completed, or through a merged pull request: an active task, or one concluded as not
 * adopted, becomes done and its dependents can start.
 */
function ShippedByForm({
  task,
  tasks,
  context,
  onDone,
}: {
  task: Task;
  tasks: Task[];
  context: TaskContext;
  onDone: () => void;
}) {
  const completeMergedWith = useCompleteTaskMergedWith();
  // Only work that shipped can carry this task's work with it.
  const shippers = tasks
    .filter(
      (other) =>
        other.id !== task.id &&
        other.status === "done" &&
        (other.resolution === "merged" || other.resolution === "completed"),
    )
    .sort((a, b) => b.id - a.id);
  const [shipper, setShipper] = useState("");
  const [url, setUrl] = useState("");
  const byTask = shipper !== "";
  const ready = byTask || url.trim() !== "";
  const guard = useDiscardGuard(ready, onDone, completeMergedWith.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    completeMergedWith.mutate(
      {
        id: task.id,
        mergedWithTask: byTask ? Number(shipper) : null,
        pullRequestUrl: byTask ? null : url.trim(),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Complete #${task.id} as shipped by`}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <p className="text-xs text-muted-foreground">
        Complete #{task.id} as shipped by another task or a merged pull request into its base branch. It becomes done as
        that one ended, and tasks that depend on it can start. An open pull request of its own must be closed first.
      </p>
      <select
        aria-label={`Task that shipped #${task.id}`}
        className={inputClass}
        value={shipper}
        onChange={(e) => setShipper(e.target.value)}
        autoFocus
      >
        <option value="">A pull request URL instead</option>
        {shippers.map((other) => (
          <option key={other.id} value={other.id}>
            {taskRef(other.id, task.workspaceId, context)} {other.title}
          </option>
        ))}
      </select>
      {!byTask && (
        <input
          className={inputClass}
          type="url"
          aria-label={`Pull request that shipped #${task.id}`}
          placeholder="https://github.com/owner/repo/pull/123"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      )}
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard completion of #${task.id}`}
          question={`Discard completing #${task.id} as shipped by another?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button changesData type="submit" size="xs" disabled={completeMergedWith.isPending || !ready}>
            <GitMerge />
            {completeMergedWith.isPending ? "Completing..." : "Complete as shipped"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Back
          </Button>
        </div>
      )}
      {completeMergedWith.isError && (
        <p role="alert" className="text-xs text-destructive">
          {completeMergedWith.error.message}
        </p>
      )}
    </form>
  );
}

/**
 * The completion note of a done task, with a pencil to edit it. Without a note it shows
 * nothing until `adding`, set from the task's "Add note" action.
 */
function CompletionNote({ task, adding, onAdded }: { task: Task; adding: boolean; onAdded: () => void }) {
  const setNote = useSetCompletionNote();
  const [editingNote, setEditing] = useState(false);
  const [note, setNoteText] = useState("");
  const saved = task.completionNote ?? "";
  const editing = editingNote || adding;

  function close() {
    setEditing(false);
    onAdded();
  }
  const guard = useDiscardGuard(
    note.trim() !== saved.trim(),
    () => {
      setNoteText(saved);
      close();
    },
    setNote.isPending,
  );

  function edit() {
    setNoteText(saved);
    setEditing(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNote.mutate({ id: task.id, note }, { onSuccess: close });
  }

  if (!editing) {
    return task.completionNote === null ? null : (
      <div className="flex items-start gap-1 rounded-md bg-muted/60 px-2 py-1">
        <StickyNote aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <p aria-label={`Completion note of #${task.id}`} className="min-w-0 flex-1 whitespace-pre-line break-words-keep text-xs">
          {task.completionNote}
        </p>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Edit completion note of #${task.id}`}
          title="Edit note"
          onClick={edit}
        >
          <Pencil />
        </Button>
      </div>
    );
  }
  return (
    <form
      onSubmit={submit}
      aria-label={`Completion note form of #${task.id}`}
      className="flex flex-col gap-1"
      onKeyDown={guard.onKeyDown}
    >
      <textarea
        className={cn(inputClass, "h-auto min-h-16 py-1.5")}
        aria-label={`Completion note for #${task.id}`}
        placeholder="What did this achieve? Impact, decisions, follow-ups. Reviews include this note."
        value={note}
        onChange={(e) => setNoteText(e.target.value)}
        autoFocus
      />
      {guard.asking ? (
        <DiscardConfirm
          label={`Discard note of #${task.id}`}
          question={`Discard your note for #${task.id}?`}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex gap-1">
          <Button
            type="submit"
            size="xs"
            // The conclusion of work that was not adopted cannot be cleared.
            disabled={setNote.isPending || note.trim() === saved || (isNotAdopted(task) && note.trim() === "")}
          >
            {setNote.isPending ? "Saving..." : "Save note"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
            Discard
          </Button>
        </div>
      )}
      {setNote.isError && (
        <p role="alert" className="text-xs text-destructive">
          {setNote.error.message}
        </p>
      )}
    </form>
  );
}

/** An issue number typed by the user, with or without `#`; `null` unless it is a positive integer. */
function parseIssueNumber(raw: string): number | null {
  const match = /^#?(\d{1,9})$/.exec(raw.trim());
  const number = match ? Number(match[1]) : 0;
  return number > 0 ? number : null;
}

/**
 * The GitHub issue of a task, which its pull request closes on merge, or the form that
 * links an existing issue or creates one from the task.
 */
function TaskIssue({
  task,
  detailed,
  linking,
  onDone,
}: {
  task: Task;
  detailed: boolean;
  linking: boolean;
  onDone: () => void;
}) {
  const linkIssue = useLinkIssue();
  const createIssue = useCreateIssue();
  const [number, setNumber] = useState("");
  const parsed = parseIssueNumber(number);
  const pending = linkIssue.isPending || createIssue.isPending;
  const error = linkIssue.error ?? createIssue.error;
  const editable = task.status !== "done";
  const guard = useDiscardGuard(
    number.trim() !== "",
    () => {
      setNumber("");
      onDone();
    },
    pending,
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parsed !== null) {
      linkIssue.mutate({ id: task.id, number: parsed }, { onSuccess: onDone });
    }
  }

  const issue = task.issue;
  const content = issue ? (
    <p className="flex min-w-0 items-center gap-1 text-xs">
      {!detailed && <CircleDot aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
      {!detailed && <span className="sr-only">Issue </span>}
      <span aria-label={`Issue of #${task.id}`} title={issue.url} className="shrink-0 font-medium tabular-nums">
        #{issue.number}
      </span>
      <span className={cn("min-w-0 font-mono text-muted-foreground select-all", detailed ? "break-all" : "truncate")}>
        {issue.url}
      </span>
      {editable && (
        <Button
          changesData
          size="icon-xs"
          variant="ghost"
          aria-label={`Unlink issue from #${task.id}`}
          title="Unlink the issue; a pull request keeps its closing reference"
          disabled={pending}
          onClick={() => linkIssue.mutate({ id: task.id, number: null })}
        >
          <X />
        </Button>
      )}
    </p>
  ) : (
    linking && (
      <form
        onSubmit={submit}
        aria-label={`Issue form of #${task.id}`}
        className="flex flex-wrap items-center gap-1"
        onKeyDown={guard.onKeyDown}
      >
        <input
          className={cn(inputClass, "h-7 w-28")}
          inputMode="numeric"
          placeholder="Issue #"
          aria-label={`Issue number of #${task.id}`}
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          autoFocus
        />
        {guard.asking ? (
          <DiscardConfirm
            label={`Discard issue number of #${task.id}`}
            question="Discard the issue number?"
            onKeep={guard.keep}
            onDiscard={guard.discard}
          />
        ) : (
          <>
            <Button type="submit" size="xs" disabled={parsed === null || pending}>
              {linkIssue.isPending ? "Linking..." : "Link"}
            </Button>
            <Button
              changesData
              type="button"
              size="xs"
              variant="outline"
              aria-label={`Create issue for #${task.id}`}
              title="Open a GitHub issue with the title and description of this task and link it"
              disabled={pending}
              onClick={() => createIssue.mutate(task.id, { onSuccess: onDone })}
            >
              <Plus />
              {createIssue.isPending ? "Creating..." : "Create issue"}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
              Discard
            </Button>
          </>
        )}
      </form>
    )
  );
  return (
    <>
      {detailed && issue ? <DetailField label="Issue">{content}</DetailField> : content}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </>
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

/** A labeled block of the task details sheet. */
/**
 * The pull request, or the other task without a recorded one, that shipped a task done
 * without a pull request of its own.
 */
function ShippedWith({
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

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-0.5 text-xs">
      <h4 className="font-medium text-muted-foreground">{label}</h4>
      {children}
    </section>
  );
}

/**
 * Related tasks of the details sheet: earlier work an agent or the owner linked, in any
 * workspace. Links neither block nor wait. Without links only the add control shows.
 */
function RelatedTasks({
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
  const busy = addRelation.isPending || removeRelation.isPending;
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

function CommitList({ task, detailed }: { task: Task; detailed: boolean }) {
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

const noteKindLabels: Record<NoteKind, string> = { progress: "Progress", blocker: "Blocker" };

function NoteKindBadge({ kind }: { kind: NoteKind }) {
  return (
    <span
      data-note-kind={kind}
      className={cn(
        "shrink-0 rounded-md px-1.5 font-medium",
        kind === "blocker" ? toneChip.attention : toneChip.neutral,
      )}
    >
      {noteKindLabels[kind]}
    </span>
  );
}

/**
 * Notes agents left on the task through the MCP server: all of them in the details sheet,
 * the latest one in a list row.
 */
function TaskNotes({ task, detailed }: { task: Task; detailed: boolean }) {
  const notes = task.notes;
  if (notes.length === 0) {
    return null;
  }
  if (!detailed) {
    const latest = notes[notes.length - 1];
    return (
      <p
        aria-label={`Latest note of #${task.id}`}
        className="flex min-w-0 items-center gap-1.5 text-xs"
        title={formatFull(latest.at)}
      >
        <NoteKindBadge kind={latest.kind} />
        <span className="min-w-0 truncate text-muted-foreground">{markdownPreview(latest.body)}</span>
        {notes.length > 1 && (
          <span className="shrink-0 text-muted-foreground">{`+${notes.length - 1} more`}</span>
        )}
      </p>
    );
  }
  return (
    <DetailField label={`Notes (${notes.length})`}>
      <ol aria-label={`Notes of #${task.id}`} className="flex flex-col gap-2">
        {notes.map((note, index) => (
          <li key={index} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <NoteKindBadge kind={note.kind} />
              <When className="text-muted-foreground" at={note.at} />
            </div>
            <Suspense fallback={<p className="whitespace-pre-line break-words-keep">{note.body}</p>}>
              <Markdown source={note.body} />
            </Suspense>
          </li>
        ))}
      </ol>
    </DetailField>
  );
}

/** A dashed placeholder for a list with nothing in it yet. */
export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed px-6 py-10 text-center">
      <span aria-hidden className="mb-1 text-muted-foreground [&_svg]:size-6">
        {icon ?? <Inbox />}
      </span>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Whether agents merge their own task pull request into the base branch once its checks
 * pass, which agents read through the MCP server; saved as soon as it changes.
 */
function AgentMergeSetting({ workspace }: { workspace: Workspace }) {
  const updateWorkspace = useUpdateWorkspace();
  const value = updateWorkspace.isPending ? updateWorkspace.variables.agentMerge : workspace.agentMerge;
  // Saved on change, so it waits, like the buttons that change data, while the server is away.
  const reach = useSyncExternalStore(subscribeReachability, reachability);
  const serverDown = reach === "unreachable" || reach === "retrying";

  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <label htmlFor="agent-merge" className="shrink-0">
        Agent merge
      </label>
      <select
        id="agent-merge"
        className={cn(compactSelectClass, "max-w-72")}
        value={value}
        disabled={updateWorkspace.isPending || serverDown}
        onChange={(e) => updateWorkspace.mutate({ ...workspace, agentMerge: e.target.value as AgentMerge })}
      >
        <option value="never">Never, stop at the pull request</option>
        <option value="afterChecks">Into {workspace.defaultBaseBranch} after checks pass</option>
      </select>
      {updateWorkspace.isError && (
        <span role="alert" className="truncate text-xs text-destructive">
          {updateWorkspace.error.message}
        </span>
      )}
    </div>
  );
}

/** Picker value of the "New branch..." option; `:` cannot appear in a branch name. */
const NEW_BRANCH = ":new";

/**
 * The location and default base branch of the workspace; the branch that new task branches
 * start from and pull requests target can be changed in place, either to a branch of the
 * repository or to a new branch created from one.
 */
function BaseBranchForm({ workspace }: { workspace: Workspace }) {
  const updateWorkspace = useUpdateWorkspace();
  const createBaseBranch = useCreateBaseBranch();
  const tasks = useTasks();
  // An open pull request targets the current branch, so it stays while a task awaits completion.
  const inReview = tasks.data?.filter((task) => task.workspaceId === workspace.id && task.status === "in_review");
  const locked = inReview === undefined || inReview.length > 0;
  const [draft, setDraft] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [newName, setNewName] = useState("");
  const [newFrom, setNewFrom] = useState(workspace.defaultBaseBranch);
  const branches = useWorkspaceBranches(workspace.id, draft !== null);
  const location = describeLocation(workspace.location);
  const current = workspace.defaultBaseBranch;
  const names = [...new Set([...(branches.data?.names ?? []), current])].sort();
  const name = newName.trim();
  const pending = updateWorkspace.isPending || createBaseBranch.isPending;
  const canSave =
    !pending && (draft === NEW_BRANCH ? name !== "" && !names.includes(name) && newFrom !== "" : draft !== current);
  const error = updateWorkspace.error ?? createBaseBranch.error;
  const guard = useDiscardGuard(draft === NEW_BRANCH && name !== "", () => setDraft(null), pending);

  function open() {
    updateWorkspace.reset();
    createBaseBranch.reset();
    setNewName("");
    setNewFrom(current);
    setDraft(current);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null || !canSave) return;
    const close = { onSuccess: () => setDraft(null) };
    if (draft === NEW_BRANCH) {
      createBaseBranch.mutate({ workspace: workspace.id, name, from: newFrom }, close);
    } else {
      updateWorkspace.mutate({ ...workspace, defaultBaseBranch: draft }, close);
    }
  }

  if (moving) {
    return <MoveWorkspaceForm workspace={workspace} onClose={() => setMoving(false)} />;
  }

  if (draft === null) {
    return (
      <p className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground max-md:flex-wrap">
        <PathLabel label="workspace path" full={location} short={shortLocation(workspace.location)} />
        <Button
          size="xs"
          variant="ghost"
          aria-label="Move workspace"
          title="Point the workspace at its repository on another machine or in another folder"
          onClick={() => setMoving(true)}
        >
          Move
        </Button>
        <span className="shrink-0">&middot; base</span>
        <code className="text-foreground">{workspace.defaultBaseBranch}</code>
        {workspace.pathProblem && <PathProblemNote problem={workspace.pathProblem} className="max-md:basis-full" />}
        <Button
          size="xs"
          variant="ghost"
          aria-label="Change base branch"
          disabled={locked}
          onClick={open}
        >
          Change
        </Button>
        {inReview && inReview.length > 0 && (
          <span className="text-xs max-md:basis-full md:truncate">
            Locked while {inReview.map((task) => `#${task.id}`).join(", ")} {inReview.length > 1 ? "are" : "is"}{" "}
            awaiting completion
          </span>
        )}
      </p>
    );
  }

  return (
    <form onSubmit={submit} aria-label="Base branch" className="flex flex-col gap-1.5" onKeyDown={guard.onKeyDown}>
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="truncate">{location} &middot;</span>
        <label htmlFor="base-branch" className="shrink-0">
          Base branch
        </label>
        <select
          id="base-branch"
          className={cn(compactSelectClass, "max-w-56 font-mono")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        >
          {names.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
          <option value={NEW_BRANCH}>New branch...</option>
        </select>
        {branches.isFetching && <span className="text-xs">Loading branches...</span>}
      </div>
      {draft === NEW_BRANCH && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <label htmlFor="new-base-branch" className="shrink-0">
            Name
          </label>
          <input
            id="new-base-branch"
            aria-label="New branch name"
            className={cn(inputClass, "max-w-56 font-mono")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="release/2026"
            autoFocus
          />
          <label htmlFor="new-base-branch-from" className="shrink-0">
            from
          </label>
          <select
            id="new-base-branch-from"
            aria-label="Start new branch from"
            className={cn(compactSelectClass, "max-w-56 font-mono")}
            value={newFrom}
            onChange={(e) => setNewFrom(e.target.value)}
          >
            {names.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
          {names.includes(name) && <span className="text-xs">Branch {name} already exists; pick it above.</span>}
        </div>
      )}
      {guard.asking ? (
        <DiscardConfirm
          label="Discard new branch name"
          question="Discard the new branch name?"
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="outline" disabled={!canSave}>
            {draft === NEW_BRANCH ? "Create and save" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={guard.request}>
            Discard
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        New task branches start from this branch and pull requests target it.
        {draft === NEW_BRANCH && " The new branch is pushed to origin."}
      </p>
      {branches.error && (
        <p role="alert" className="text-xs text-destructive">
          Failed to load branches: {branches.error.message}
        </p>
      )}
      {branches.data?.fetchError && (
        <p className="text-xs text-muted-foreground" title={branches.data.fetchError}>
          Could not fetch origin; showing the branches known locally.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </form>
  );
}

/**
 * Where worktrees of the workspace's machine are created. Shown as a one-line summary once
 * set, and as an open form while unset or being changed.
 */
function WorktreeRootForm({ workspace }: { workspace: Workspace }) {
  const machine = machineOf(workspace.location);
  const settings = useMachineSettings(machine);
  const saveSettings = useSaveMachineSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const saved = settings.data?.worktreeRoot ?? "";
  const machineName = machine.kind === "local" ? "the server" : machine.label;
  const error = settings.error ?? saveSettings.error;
  const closeChange = () => {
    setDraft(null);
    setChanging(false);
  };
  const guard = useDiscardGuard(draft !== null && draft.trim() !== saved, closeChange, saveSettings.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveSettings.mutate(
      { machine, worktreeRoot: (draft ?? saved).trim() || null },
      {
        onSuccess: () => {
          setDraft(null);
          setChanging(false);
        },
      },
    );
  }

  if (settings.isSuccess && saved && !changing) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">Worktrees on {machineName} in</span>
        <code className="truncate text-foreground" title={saved}>
          {saved}
        </code>
        <Button size="xs" variant="ghost" aria-label="Change worktree root" onClick={() => setChanging(true)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Worktree root"
      onKeyDown={changing ? guard.onKeyDown : undefined}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border p-3",
        settings.isSuccess && !saved && "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30",
      )}
    >
      <div className="flex items-center gap-2 max-md:flex-wrap">
        <label htmlFor="worktree-root" className="shrink-0 text-xs text-muted-foreground max-md:basis-full">
          Worktree root on {machineName}
        </label>
        <input
          id="worktree-root"
          className={cn(inputClass, "font-mono max-md:min-w-0 max-md:flex-1")}
          placeholder={/^([a-zA-Z]:|\\\\)/.test(workspace.location.path) ? "D:\\worktrees" : "/srv/worktrees"}
          value={draft ?? saved}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!settings.isSuccess}
        />
        <Button type="submit" size="sm" variant="outline" disabled={draft === null || saveSettings.isPending}>
          Save
        </Button>
        {changing && !guard.asking && (
          <Button type="button" size="sm" variant="ghost" onClick={guard.request}>
            Discard
          </Button>
        )}
      </div>
      {guard.asking && (
        <DiscardConfirm
          label="Discard worktree root change"
          question="Discard the new worktree root?"
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      )}
      {settings.isSuccess && !saved && (
        <p className="text-xs text-muted-foreground">Set a worktree root to start tasks on this machine.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </form>
  );
}

/** What the user typed for a task's estimate and due date (`YYYY-MM-DD`, blank for none). */
type PlanDraft = { estimate: string; estimateUnit: EstimateUnit; dueDate: string };

/** The estimate typed in `plan`: null when blank, undefined when it is not a valid amount. */
function planEstimate(plan: PlanDraft): Estimate | null | undefined {
  const amount = parseEstimateAmount(plan.estimate);
  if (amount === null) return null;
  return Number.isNaN(amount) ? undefined : { unit: plan.estimateUnit, amount };
}

function PlanFields({
  suffix,
  plan,
  onChange,
}: {
  /** Appended to the field labels, e.g. ` of #3` in the edit form of task 3. */
  suffix: string;
  plan: PlanDraft;
  onChange: (plan: PlanDraft) => void;
}) {
  const invalid = planEstimate(plan) === undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <label className="flex items-center gap-1">
        Estimate
        <input
          className={cn(inputClass, "w-20")}
          inputMode="decimal"
          placeholder="Optional"
          aria-label={`Estimate${suffix}`}
          aria-invalid={invalid}
          title="Optional: expected size, a number greater than 0"
          value={plan.estimate}
          onChange={(e) => onChange({ ...plan, estimate: e.target.value })}
        />
      </label>
      <select
        aria-label={`Estimate unit${suffix}`}
        className={cn(compactSelectClass, "w-24")}
        value={plan.estimateUnit}
        onChange={(e) => onChange({ ...plan, estimateUnit: e.target.value as EstimateUnit })}
      >
        <option value="hours">hours</option>
        <option value="days">days</option>
        <option value="weeks">weeks</option>
        <option value="months">months</option>
      </select>
      <label className="flex items-center gap-1">
        Due
        <input
          type="date"
          className={cn(inputClass, "w-40")}
          aria-label={`Due date${suffix}`}
          value={plan.dueDate}
          onChange={(e) => onChange({ ...plan, dueDate: e.target.value })}
        />
      </label>
    </div>
  );
}

/** A task's estimate and due date, the due date in red once it is missed. */
function TaskPlan({ task }: { task: Task }) {
  if (task.estimate === null && task.dueDate === null) return null;
  return (
    <p aria-label={`Plan of #${task.id}`} className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
      {task.estimate !== null && <span>Estimate {formatEstimate(task.estimate)}</span>}
      {task.dueDate !== null && <DueDate task={task} />}
    </p>
  );
}

const criterionKindLabels: Record<CheckKind, string> = {
  manual: "Manual",
  url: "URL responds",
  command: "Command succeeds",
  pr_open_ci_green: "PR open with green CI",
  pr_merged: "PR merged",
  branch_merged_locally: "Merged locally",
};

/**
 * Kinds the criteria editor offers. The merge criterion (`pr_merged`, or
 * `branch_merged_locally` in a repository without `origin`) comes from "Done when merged"
 * in the new and edit forms and keeps its kind when the task is edited.
 */
const editableCriterionKinds: CheckKind[] = ["manual", "url", "command", "pr_open_ci_green"];

/** Kinds of the merge criterion, of which a task has at most one. */
function isMergeKind(kind: CheckKind): boolean {
  return kind === "pr_merged" || kind === "branch_merged_locally";
}

/** Kinds checked against a target their author gives: the URL to fetch or the command to run. */
function takesTarget(kind: CheckKind): boolean {
  return kind === "url" || kind === "command";
}

/** A row of the criteria editor; `id` is set for an existing criterion of the edited task. */
type CriterionDraft = { key: number; id: CriterionId | null; text: string; kind: CheckKind; target: string };

/** Tells editor rows apart, so removing one keeps the values and focus of the others. */
let lastCriterionKey = 0;

/** A new, empty row, or a row holding the existing `criterion`. */
function criterionDraft(criterion?: Criterion): CriterionDraft {
  lastCriterionKey += 1;
  if (criterion === undefined) {
    return { key: lastCriterionKey, id: null, text: "", kind: "manual", target: "" };
  }
  // The target of a merged-locally criterion is the commit Toodo found, not one to edit.
  const target = takesTarget(criterion.kind) ? (criterion.target ?? "") : "";
  return { key: lastCriterionKey, id: criterion.id, text: criterion.text, kind: criterion.kind, target };
}

/** The rows with a text, in order, as the backend takes them; blank rows are left out. */
function criterionInputs(drafts: CriterionDraft[]): CriterionInput[] {
  return drafts
    .filter((draft) => draft.text.trim() !== "")
    .map((draft) => ({
      ...(draft.id === null ? {} : { id: draft.id }),
      text: draft.text.trim(),
      kind: draft.kind,
      target: takesTarget(draft.kind) ? draft.target.trim() : null,
    }));
}

/** Why the backend would reject the target of a row, or null when it takes it. */
function targetProblem(draft: CriterionDraft): string | null {
  if (draft.text.trim() === "") return null;
  const target = draft.target.trim();
  if (draft.kind === "url" && !/^https?:\/\/\S*$/.test(target)) return "Enter an http:// or https:// URL";
  if (draft.kind === "command" && target === "") return "Enter the command to run";
  return null;
}

/**
 * The completion criteria of a new or an edited task: one row per criterion with what has
 * to hold, how it is checked, and the URL or command a check runs against. In the edit form
 * of a task, `taskId` ends the labels with ` of #id`.
 */
function CriteriaEditor({
  criteria,
  onChange,
  taskId,
}: {
  criteria: CriterionDraft[];
  onChange: (criteria: CriterionDraft[]) => void;
  taskId?: TaskId;
}) {
  // The row just added gets the focus.
  const [addedKey, setAddedKey] = useState<number | null>(null);
  const of = taskId === undefined ? "" : ` of #${taskId}`;
  const update = (key: number, change: Partial<CriterionDraft>) =>
    onChange(criteria.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));

  function add() {
    const draft = criterionDraft();
    setAddedKey(draft.key);
    onChange([...criteria, draft]);
  }

  return (
    <div className="flex flex-col gap-1 max-md:gap-2">
      {criteria.length > 0 && (
        <ol className="flex flex-col gap-1 max-md:gap-2">
          {criteria.map((draft, index) => {
            const n = index + 1;
            const problem = targetProblem(draft);
            const fixedKind = !editableCriterionKinds.includes(draft.kind);
            return (
              // Below md each criterion is a block: its text on the first line, kind and remove on the next.
              <li
                key={draft.key}
                className="flex flex-wrap items-center gap-1 max-md:grid max-md:grid-cols-[1rem_1fr_auto] max-md:gap-2 max-md:rounded-lg max-md:border max-md:p-2"
              >
                <span aria-hidden className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {n}
                </span>
                <input
                  className={cn(inputClass, "h-7 flex-1 basis-48 max-md:col-span-2")}
                  aria-label={`Criterion ${n} text${of}`}
                  placeholder="What has to hold, e.g. Docs updated"
                  value={draft.text}
                  onChange={(e) => update(draft.key, { text: e.target.value })}
                  autoFocus={draft.key === addedKey}
                />
                <select
                  aria-label={`Criterion ${n} kind${of}`}
                  className={cn(compactSelectClass, "h-7 max-md:col-start-2 max-md:row-start-2")}
                  value={draft.kind}
                  disabled={fixedKind}
                  title={fixedKind ? "The merge criterion keeps its kind" : "How the criterion is checked"}
                  onChange={(e) => update(draft.key, { kind: e.target.value as CheckKind })}
                >
                  {(fixedKind ? [draft.kind] : editableCriterionKinds).map((kind) => (
                    <option key={kind} value={kind}>
                      {criterionKindLabels[kind]}
                    </option>
                  ))}
                </select>
                {takesTarget(draft.kind) && (
                  <input
                    className={cn(
                      inputClass,
                      "h-7 flex-1 basis-40 font-mono max-md:col-span-2 max-md:col-start-2 max-md:row-start-3 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
                    )}
                    aria-label={`Criterion ${n} target${of}`}
                    aria-invalid={problem !== null}
                    title={
                      problem ??
                      (draft.kind === "url"
                        ? "Toodo checks that a GET of this URL succeeds"
                        : "Toodo checks that this command exits with 0 in the task worktree")
                    }
                    placeholder={draft.kind === "url" ? "https://example.com/health" : "npm test"}
                    value={draft.target}
                    onChange={(e) => update(draft.key, { target: e.target.value })}
                  />
                )}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove criterion ${n}${of}`}
                  title="Remove criterion"
                  className="max-md:col-start-3 max-md:row-start-2"
                  onClick={() => onChange(criteria.filter((other) => other.key !== draft.key))}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="self-start"
        aria-label={taskId === undefined ? undefined : `Add criterion to #${taskId}`}
        onClick={add}
      >
        <Plus />
        Add criterion
      </Button>
    </div>
  );
}

const criterionStateLabels: Record<CriterionState, string> = { pending: "Pending", met: "Met", failed: "Failed" };

/** Green once met, rose only when the last check failed. */
const criterionStateStyles: Record<CriterionState, string> = {
  pending: toneText.neutral,
  met: toneText.success,
  failed: toneText.danger,
};

const checkedByLabels: Record<CheckedBy, string> = { user: "you", agent: "an agent", toodo: "Toodo" };

function CriterionMarker({ state }: { state: CriterionState }) {
  const Icon = state === "met" ? CircleCheck : state === "failed" ? CircleX : Circle;
  return (
    <span
      role="img"
      aria-label={criterionStateLabels[state]}
      className={cn("flex size-4 shrink-0 items-center justify-center", criterionStateStyles[state])}
    >
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

/** Who checked a criterion last and when, or null when nobody has. */
function checkedByText(criterion: Criterion): string | null {
  if (criterion.checkedBy === null) return null;
  const at = criterion.checkedAt === null ? "" : ` ${formatWhen(criterion.checkedAt)}`;
  return `Checked by ${checkedByLabels[criterion.checkedBy]}${at}`;
}

/**
 * What has to hold for the task to be done, each criterion with its state. A list row keeps
 * every criterion to one line; the details sheet adds targets, evidence, and who checked.
 */
function TaskCriteria({ task, detailed }: { task: Task; detailed: boolean }) {
  const criteria = task.criteria;
  if (criteria.length === 0) {
    return null;
  }
  const list = (
    <ul aria-label={`Criteria of #${task.id}`} className="flex flex-col gap-0.5">
      {criteria.map((criterion) => (
        <CriterionItem key={criterion.id} task={task} criterion={criterion} detailed={detailed} />
      ))}
    </ul>
  );
  if (!detailed) {
    return list;
  }
  const met = criteria.filter((criterion) => criterion.state === "met").length;
  return <DetailField label={`Criteria (${met} of ${criteria.length} met)`}>{list}</DetailField>;
}

/**
 * One criterion of a task. A manual one of a task that is not done is a checkbox: checking
 * asks for optional evidence before it is saved, unchecking saves right away.
 */
function CriterionItem({ task, criterion, detailed }: { task: Task; criterion: Criterion; detailed: boolean }) {
  const checkCriterion = useCheckCriterion();
  // The evidence form of a check that is not saved yet.
  const [writing, setWriting] = useState(false);
  const [evidence, setEvidence] = useState("");
  const checkable = criterion.kind === "manual" && task.status !== "done";
  const checkedBy = checkedByText(criterion);
  const target = takesTarget(criterion.kind) ? criterion.target : null;

  function cancel() {
    setWriting(false);
    setEvidence("");
  }
  const guard = useDiscardGuard(evidence.trim() !== "", cancel, checkCriterion.isPending);

  function toggle(checked: boolean) {
    if (writing) {
      cancel();
    } else if (checked) {
      checkCriterion.reset();
      setWriting(true);
    } else {
      checkCriterion.mutate({ taskId: task.id, criterionId: criterion.id, met: false, evidence: null });
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    checkCriterion.mutate(
      { taskId: task.id, criterionId: criterion.id, met: true, evidence: evidence.trim() || null },
      { onSuccess: cancel },
    );
  }

  return (
    <li data-criterion-state={criterion.state} className="flex min-w-0 flex-col gap-0.5 text-xs">
      <div
        className="flex min-w-0 items-center gap-1.5"
        title={detailed ? undefined : [checkedBy, criterion.evidence, target].filter(Boolean).join("\n") || undefined}
      >
        {checkable ? (
          <>
            <label className="flex size-4 shrink-0 items-center justify-center max-md:-mx-3.5 max-md:size-11">
              <input
                type="checkbox"
                aria-label={`Check criterion ${criterion.id} of #${task.id}`}
                checked={criterion.state === "met" || writing}
                disabled={checkCriterion.isPending}
                onChange={(e) => toggle(e.target.checked)}
              />
            </label>
            {/* An unchecked box alone cannot tell a failed check from a pending one. */}
            {criterion.state === "failed" && <CriterionMarker state="failed" />}
          </>
        ) : (
          <CriterionMarker state={criterion.state} />
        )}
        <span
          className={cn(
            "min-w-0",
            detailed ? "break-words-keep" : "truncate",
            criterion.state === "failed" && toneText.danger,
          )}
        >{criterion.text}</span>
        {criterion.kind !== "manual" && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 text-muted-foreground">
            {criterionKindLabels[criterion.kind]}
          </span>
        )}
        {!detailed && criterion.evidence && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{criterion.evidence}</span>
        )}
      </div>
      {detailed && target && <code className="ml-5.5 break-all text-muted-foreground">{target}</code>}
      {detailed && (criterion.evidence || checkedBy) && (
        <p className="ml-5.5 whitespace-pre-line break-words-keep text-muted-foreground">
          {criterion.evidence}
          {criterion.evidence && checkedBy && " \u00b7 "}
          {criterion.checkedBy !== null && (
            <>
              Checked by {checkedByLabels[criterion.checkedBy]}
              {criterion.checkedAt !== null && (
                <>
                  {" "}
                  <When at={criterion.checkedAt} />
                </>
              )}
            </>
          )}
        </p>
      )}
      {writing && (
        <form
          onSubmit={save}
          className="ml-5.5 flex flex-wrap items-center gap-1"
          onKeyDown={guard.onKeyDown}
        >
          <input
            className={cn(inputClass, "h-7 flex-1 basis-48")}
            aria-label={`Evidence for criterion ${criterion.id}`}
            placeholder="Evidence (optional), e.g. a link or what you checked"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            autoFocus
          />
          {guard.asking ? (
            <DiscardConfirm
              label={`Discard evidence for criterion ${criterion.id}`}
              question="Discard the evidence?"
              onKeep={guard.keep}
              onDiscard={guard.discard}
            />
          ) : (
            <>
              <Button type="submit" size="xs" disabled={checkCriterion.isPending}>
                {checkCriterion.isPending ? "Saving..." : "Save"}
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={guard.request}>
                Cancel
              </Button>
            </>
          )}
        </form>
      )}
      {checkCriterion.isError && (
        <p role="alert" className="ml-5.5 text-destructive">
          {checkCriterion.error.message}
        </p>
      )}
    </li>
  );
}

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

const emptyDraft: TaskDraft = {
  taskType: "feat",
  title: "",
  description: "",
  issue: "",
  criteria: [],
  mergeCriterion: true,
  estimate: "",
  estimateUnit: "hours",
  dueDate: "",
};

function NewTaskForm({
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
      onChange({ ...draft, title: "", description: "", issue: "", estimate: "", dueDate: "", criteria: [] });
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
        criteria: criterionInputs(draft.criteria),
        mergeCriterion: draft.mergeCriterion,
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
          </div>
          <PlanFields
            suffix=""
            plan={draft}
            onChange={(plan) => onChange({ ...draft, ...plan })}
          />
          <div className="flex flex-col gap-1 border-t pt-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-medium text-muted-foreground">Completion criteria</span>
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
            </div>
            <CriteriaEditor criteria={draft.criteria} onChange={(criteria) => onChange({ ...draft, criteria })} />
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
