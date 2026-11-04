import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, Inbox, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compactSelectClass } from "@/components/workspace-list";
import { ErrorBoundary } from "@/components/error-boundary";
import type { TaskId, TaskType, Workspace, WorkspaceId } from "@/lib/bindings";
import { useAgentStatuses, usePullRequestStatuses, useTasks, useWorkspaces } from "@/lib/queries";
import { type TimelineScale } from "@/lib/task-graph";
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
  type TaskFilter,
} from "@/lib/task-filter";
import { needsAttention } from "@/lib/attention";
import { statusNames, toneFill, toneOutline } from "@/lib/status-styles";
import { singleKeyShortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { workspaceCapabilities } from "@/lib/workspace-capabilities";
import {
  taskTypes,
  statusLabel,
  statusTones,
  shownStatusStyle,
  statusStyle,
  type TaskContext,
} from "@/components/task-common";
import { TaskRow } from "@/components/task-row";
import { AgentMergeSetting, BaseBranchForm, RunLimitForm, WorktreeRootForm } from "@/components/workspace-settings";
import { WorkspaceAgentOptions } from "@/components/agent-options";
import { WorkspacePullRequestOptions } from "@/components/pull-request-options";
import { type TaskDraft, emptyDraft, NewTaskForm } from "@/components/new-task-form";
import { PlanView } from "@/components/plan-view";
import type { AllView } from "@/lib/route";

// The timeline pulls in React Flow, so it loads only when it is first shown.
const TaskGraph = lazy(() => import("@/components/task-graph").then((module) => ({ default: module.TaskGraph })));
// The details sheet and the sections only it shows load when a task is first opened.
const TaskDetailsSheet = lazy(() =>
  import("@/components/task-details").then((module) => ({ default: module.TaskDetailsSheet })),
);

/** What the task list tells screen readers once tasks are loaded: how many it shows out of how many. */
function shownTasksMessage(shown: number, total: number): string {
  const count = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;
  return shown === total ? `Showing ${count(total)}.` : `Showing ${shown} of ${count(total)}.`;
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
  view = "list",
  onViewChange,
  selectedTask: detailId,
  onSelectTask: setDetailId,
}: {
  workspace: Workspace | null;
  /** The view of every workspace's tasks; a workspace only has the list. */
  view?: AllView;
  onViewChange?: (view: AllView) => void;
  /** The task whose details are open, owned by the caller so the address keeps it. */
  selectedTask: TaskId | null;
  onSelectTask: (id: TaskId | null) => void;
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
  const workspaces = useWorkspaces();
  const [timelineWorkspace, setTimelineWorkspace] = useState<WorkspaceId | null>(null);
  // The filter the user set; until then the timeline leaves finished tasks out and the list shows every status.
  const [chosenFilter, setTaskFilter] = useState<TaskFilter | null>(null);
  // A task a link shows or a number search names loads even when it is older than the loaded pages.
  const allTasks = useTasks([shownTask?.id, detailId, taskNumber(chosenFilter?.query ?? "")]);
  // On a phone the filters fold behind a button so the view gets most of the screen.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const agentStatuses = useAgentStatuses();
  const pullRequestStatuses = usePullRequestStatuses();
  // Done tasks are folded away until asked for, or while a search or filter is narrowing the list.
  const [doneShown, setDoneShown] = useState<boolean | null>(null);
  const byWorkspace = new Map(workspaces.data?.map((entry) => [entry.id, entry]));
  const context: TaskContext = {
    byId: new Map(allTasks.data?.map((task) => [task.id, task])),
    workspaceName: (id) => byWorkspace.get(id)?.name ?? `Workspace ${id}`,
    capabilities: (id) => workspaceCapabilities(byWorkspace.get(id)),
    remote: (id) => byWorkspace.get(id)?.location.kind === "ssh",
  };
  const tasks =
    workspace === null ? allTasks.data : allTasks.data?.filter((task) => task.workspaceId === workspace.id);
  const showTimeline = workspace === null && view === "timeline";
  const showPlan = workspace === null && view === "plan";
  // The timeline and the plan can be narrowed to one workspace.
  const narrowable = showTimeline || showPlan;
  const taskFilter = chosenFilter ?? (showTimeline ? defaultTaskFilter : emptyTaskFilter);
  // Workspaces the timeline can be narrowed to; a filter whose workspace has no tasks left falls back to all.
  const filterOptions = [...new Set(allTasks.data?.map((task) => task.workspaceId))].sort((a, b) =>
    context.workspaceName(a).localeCompare(context.workspaceName(b)),
  );
  const filter = timelineWorkspace !== null && filterOptions.includes(timelineWorkspace) ? timelineWorkspace : null;
  // Narrowings in effect, counted on the folded filters button: workspace, search, status, and type.
  const activeFilters = [
    narrowable && filter !== null,
    taskFilter.query.trim() !== "",
    taskFilter.statuses.length > 0,
    taskFilter.type !== null,
  ].filter(Boolean).length;
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
      (!narrowable || filter === null || task.workspaceId === filter) &&
      matchesFilter(task, taskFilter, context.byId),
  );
  const timelineTasks = numbered === undefined ? (filtered ?? []) : [numbered, ...(filtered ?? [])];
  // Older finished tasks load on request, offered wherever finished tasks are shown.
  const finishedShown = narrowable
    ? taskFilter.statuses.length === 0 || taskFilter.statuses.some((status) => status === "done" || status === "not_adopted")
    : (doneShown ?? isFilterActive(taskFilter));
  const shownTaskData = shownTask === null ? undefined : context.byId.get(shownTask.id);
  useEffect(() => {
    if (shownTaskData === undefined) {
      return;
    }
    setTimelineWorkspace((current) => (current === shownTaskData.workspaceId ? current : null));
    setTaskFilter((chosen) => {
      const current = chosen ?? defaultTaskFilter;
      return matchesFilter(shownTaskData, current, context.byId) ? chosen : emptyTaskFilter;
    });
    // Only a new request moves the view; later changes to the task do not.
  }, [shownTask, shownTaskData === undefined]);
  // In the list, j and k move the focus between task titles, where Enter opens the details;
  // with the details open they show the next task's. The timeline handles them itself.
  useEffect(() => {
    if (showTimeline) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const step = event.key === "j" ? 1 : event.key === "k" ? -1 : 0;
      if (step === 0 || !singleKeyShortcut(event) || document.querySelector("form[data-dirty]")) return;
      const titles = [...document.querySelectorAll<HTMLElement>("[data-task-row] [data-task-title]")];
      const rowOf = (title: HTMLElement) => title.closest<HTMLElement>("[data-task-row]")!;
      let current = titles.findIndex((title) => rowOf(title).contains(document.activeElement));
      if (current === -1) current = titles.findIndex((title) => rowOf(title).dataset.taskRow === String(detailId));
      const next = titles[current === -1 ? (step > 0 ? 0 : titles.length - 1) : current + step];
      if (next === undefined) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView?.({ block: "nearest" });
      if (detailId !== null) setDetailId(Number(rowOf(next).dataset.taskRow));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });
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
            {workspaceCapabilities(workspace).merge && <AgentMergeSetting workspace={workspace} />}
            {workspaceCapabilities(workspace).pullRequests && <WorkspacePullRequestOptions workspace={workspace} />}
            {(workspace.runner === "plain" || workspace.runner === "tmux") && <WorkspaceAgentOptions workspace={workspace} />}
          </>
        ) : (
          <p className="text-sm text-muted-foreground max-md:hidden">Tasks of every workspace and the dependencies between them.</p>
        )}
      </header>

      {/* Every runner but none starts tasks in worktrees under the worktree root of the machine. */}
      {workspace && workspace.runner !== "none" && <WorktreeRootForm workspace={workspace} />}
      {/* Only plain and tmux runs are started by Toodo, so only they count against a limit. */}
      {workspace && (workspace.runner === "plain" || workspace.runner === "tmux") && <RunLimitForm workspace={workspace} />}

      {workspace && onDraftChange && <NewTaskForm workspace={workspace} draft={draft} onChange={onDraftChange} />}

      {/* Stays mounted so screen readers hear loading start and finish, and how many tasks a search leaves. */}
      <p role="status" className={cn("text-sm text-muted-foreground", !allTasks.isPending && "sr-only")}>
        {allTasks.isPending
          ? "Loading tasks..."
          : tasks && filtered
            ? shownTasksMessage(filtered.length + (numbered ? 1 : 0), tasks.length)
            : ""}
      </p>
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
                {(["timeline", "list", "plan"] as const).map((option) => (
                  <Button
                    key={option}
                    size="xs"
                    variant={view === option ? "default" : "ghost"}
                    aria-pressed={view === option}
                    onClick={() => onViewChange?.(option)}
                  >
                    {option === "list" ? "List" : option === "plan" ? "Plan" : "Timeline"}
                  </Button>
                ))}
              </div>
            )}
            <Button
              size="xs"
              variant={filtersOpen ? "secondary" : "outline"}
              className="ml-auto md:hidden"
              aria-expanded={filtersOpen}
              aria-controls="task-filters"
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal />
              Filters
              {activeFilters > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-[0.625rem] leading-4 text-primary-foreground tabular-nums">
                  {activeFilters}
                  <span className="sr-only"> active</span>
                </span>
              )}
            </Button>
            <div id="task-filters" className={cn("contents", !filtersOpen && "max-md:hidden")}>
              {narrowable && (
                <select
                  aria-label={showPlan ? "Plan workspace" : "Timeline workspace"}
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
          </div>
          {filtered.length === 0 && numbered === undefined ? (
            <EmptyState
              icon={<Search />}
              title="No tasks match the search and filters."
              hint="Change the search text, status, or type, or clear the filters."
            />
          ) : !showTimeline ? (
            <>
            {showPlan ? (
              <PlanView tasks={timelineTasks} onShowTask={setDetailId} />
            ) : (
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
            )}
              {detailId !== null && context.byId.has(detailId) && (
                <Suspense fallback={<p className="text-sm text-muted-foreground">Loading details...</p>}>
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
                </Suspense>
              )}
            </>
          ) : (
            <ErrorBoundary label="the timeline">
              <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading timeline...</p>}>
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
                  selectedTaskId={detailId}
                  onSelectedTaskChange={setDetailId}
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
            </ErrorBoundary>
          )}
          {allTasks.hasNextPage && finishedShown && (
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              disabled={allTasks.isFetchingNextPage}
              onClick={() => void allTasks.fetchNextPage()}
            >
              {allTasks.isFetchingNextPage ? "Loading older finished tasks..." : "Load older finished tasks"}
            </Button>
          )}
        </>
      )}
    </section>
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

export type { TaskDraft } from "@/components/new-task-form";
