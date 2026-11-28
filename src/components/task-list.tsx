import { fill, useMessages } from "@/lib/i18n";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Check, ChevronDown, Inbox, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { Button } from "@/components/button";
import { escapeCloses } from "@/components/workspace-list";
import { ErrorBoundary } from "@/components/error-boundary";
import type { Task, TaskId, TaskType, Workspace, WorkspaceId } from "@/lib/bindings";
import { useDeleteDoneTasks, useDoneTaskCount, useOlderTasksWhileShown, useTasks, useWorkspaces } from "@/lib/queries";
import { timelineOrder, type TimelineScale } from "@/lib/task-graph";
import {
  defaultTaskFilter,
  emptyTaskFilter,
  isFilterActive,
  matchesFilter,
  shownStatus,
  shownStatuses,
  taskNumber,
  toggleStatus,
  type TaskFilter,
} from "@/lib/task-filter";
import { toneChip, toneFill, toneOutline, type Tone } from "@/lib/status-styles";
import { singleKeyShortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import {
  taskTypeOptions,
  statusLabel,
  statusTones,
  shownStatusStyle,
  statusStyle,
  type TaskContext,
} from "@/components/task-common";
import { TaskRow } from "@/components/task-row";
import { WorkspaceDetails } from "@/components/workspace-settings";
import { WorkspaceGuidelines } from "@/components/workspace-guidelines";
import { type TaskDraft, emptyDraft, NewTaskForm } from "@/components/new-task-form";
import { PlanView } from "@/components/plan-view";
import type { AllView } from "@/lib/route";

// The timeline pulls in React Flow, so it loads only when it is first shown.
const TaskGraph = lazy(() => import("@/components/task-graph").then((module) => ({ default: module.TaskGraph })));
// The details sheet and the sections only it shows load when a task is first opened.
const TaskDetailsSheet = lazy(() =>
  import("@/components/task-details").then((module) => ({ default: module.TaskDetailsSheet })),
);

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
  const m = useMessages();
  const workspaces = useWorkspaces();
  const [timelineWorkspace, setTimelineWorkspace] = useState<WorkspaceId | null>(null);
  // The filter the user set; until then the timeline leaves finished tasks out and the list shows every status.
  const [chosenFilter, setTaskFilter] = useState<TaskFilter | null>(null);
  // A task a link shows or a number search names loads even when it is older than the loaded pages.
  const allTasks = useTasks([shownTask?.id, detailId, taskNumber(chosenFilter?.query ?? "")]);
  // On a phone the filters fold behind a button so the view gets most of the screen.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Done tasks are folded away until asked for, or while a search or filter is narrowing the list.
  const [doneShown, setDoneShown] = useState<boolean | null>(null);
  const byWorkspace = new Map(workspaces.data?.map((entry) => [entry.id, entry]));
  const context: TaskContext = {
    byId: new Map(allTasks.data?.map((task) => [task.id, task])),
    workspaceName: (id) => byWorkspace.get(id)?.name ?? m.tasks.workspaceFallback(id),
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
  // Older finished tasks load as the user scrolls toward them, wherever finished tasks are shown:
  // up to the top of the list, or into the past on the timeline. Hidden again, they are dropped,
  // so showing them later loads the newest page only.
  const finishedShown = narrowable
    ? taskFilter.statuses.length === 0 || taskFilter.statuses.some((status) => status === "done" || status === "not_adopted")
    : (doneShown ?? isFilterActive(taskFilter));
  useOlderTasksWhileShown(finishedShown);
  const loadOlder =
    finishedShown && allTasks.hasNextPage
      ? () => void allTasks.fetchNextPage({ cancelRefetch: false })
      : undefined;
  // The oldest work comes first, so older finished tasks go on top of the list.
  const olderLoader = loadOlder && (
    <OlderTasksLoader loading={allTasks.isFetchingNextPage} failed={allTasks.isFetchNextPageError} onLoad={loadOlder} />
  );
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
  // The list runs top to bottom like the timeline's rows, oldest work first. Done tasks are
  // folded away until asked for, or while a search or filter is narrowing the list.
  const doneListed = doneShown ?? isFilterActive(taskFilter);
  const finished = (task: Task) => ["done", "not_adopted"].includes(shownStatus(task, context.byId));
  const ordered = timelineOrder(filtered ?? [], Date.now() / 1000);
  const doneCount = ordered.filter(finished).length;
  const listed = doneListed ? ordered : ordered.filter((task) => !finished(task));
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
          {workspace?.name ?? m.tasks.allWorkspaces}
        </h2>
        {workspace ? (
          <WorkspaceDetails key={workspace.id} workspace={workspace} />
        ) : (
          <p className="text-sm text-muted-foreground max-md:hidden">{m.tasks.allWorkspacesHint}</p>
        )}
      </header>

      {workspace && <WorkspaceGuidelines key={workspace.id} workspace={workspace} />}

      {workspace && onDraftChange && <NewTaskForm workspace={workspace} draft={draft} onChange={onDraftChange} />}

      {/* Stays mounted so screen readers hear loading start and finish, and how many tasks a search leaves. */}
      <p role="status" className={cn("text-sm text-muted-foreground", !allTasks.isPending && "sr-only")}>
        {allTasks.isPending
          ? m.tasks.loadingTasks
          : tasks && filtered
            ? m.tasks.shownTasks(filtered.length + (numbered ? 1 : 0), tasks.length)
            : ""}
      </p>
      {allTasks.isError && (
        <p role="alert" className="text-sm text-destructive">
          {m.tasks.loadTasksError(allTasks.error.message)}
        </p>
      )}
      {tasks?.length === 0 && (
        <EmptyState
          title={workspace ? m.tasks.emptyWorkspace : m.tasks.emptyTasks}
          hint={
            workspace
              ? m.tasks.emptyWorkspaceHint
              : m.tasks.emptyTasksHint
          }
        />
      )}
      {allTasks.data && tasks && filtered && tasks.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {workspace === null && (
              <ToggleButtonGroup
                label={m.tasks.taskView}
                type="single"
                size="sm"
                value={view}
                // Pressing the shown view again keeps it: one view is always shown.
                onChange={(next) => typeof next === "string" && onViewChange?.(next as AllView)}
              >
                <ToggleButton value="timeline" label={m.tasks.timeline} />
                <ToggleButton value="list" label={m.tasks.list} />
                <ToggleButton value="plan" label={m.tasks.plan} />
              </ToggleButtonGroup>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto md:hidden"
              label={activeFilters > 0 ? m.tasks.activeFilters(activeFilters) : m.tasks.filters}
              icon={<SlidersHorizontal />}
              endContent={activeFilters > 0 ? <Badge variant="info" label={activeFilters} /> : undefined}
              aria-expanded={filtersOpen}
              aria-controls="task-filters"
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              {m.tasks.filters}
            </Button>
            <div id="task-filters" className={cn("contents", !filtersOpen && "max-md:hidden")}>
              {narrowable && (
                <Selector
                  label={showPlan ? m.tasks.planWorkspace : m.tasks.timelineWorkspace}
                  isLabelHidden
                  size="sm"
                  value={filter === null ? "all" : String(filter)}
                  options={[
                    { value: "all", label: m.tasks.allWorkspaces },
                    ...filterOptions.map((id) => ({ value: String(id), label: context.workspaceName(id) })),
                  ]}
                  onChange={(value) => setTimelineWorkspace(value === "all" ? null : Number(value))}
                />
              )}
              <TaskFilterBar filter={taskFilter} onChange={setTaskFilter} />
            </div>
          </div>
          {filtered.length === 0 && numbered === undefined ? (
            <EmptyState
              icon={<Search />}
              title={m.tasks.noMatches}
              hint={m.tasks.noMatchesHint}
            />
          ) : !showTimeline ? (
            <>
            {showPlan ? (
              <>
                {olderLoader}
                <PlanView tasks={timelineTasks} onShowTask={setDetailId} />
              </>
            ) : (
            <div role="region" aria-label={m.tasks.region} className="flex flex-col gap-4">
              {numbered && (
                <section aria-label={m.tasks.numberMatch} className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {fill(m.tasks.numberedTask, { number: <span className="tabular-nums font-normal">#{numbered.id}</span> })}
                  </h3>
                  <ul aria-label={m.tasks.numberMatch} className="flex flex-col divide-y rounded-xl border bg-card shadow-xs">
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
              {doneCount > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                    <Button
                      size="sm"
                      variant="ghost"
                      label={m.tasks.doneCount(doneCount)}
                      icon={<ChevronDown aria-hidden className={cn("transition-transform", !doneListed && "-rotate-90")} />}
                      aria-expanded={doneListed}
                      onClick={() => setDoneShown(!doneListed)}
                    >
                      {fill(m.tasks.doneCountStyled, { count: <span className="tabular-nums font-normal">{doneCount}</span> })}
                    </Button>
                  </h3>
                  {/* Deleting acts on every done task of a workspace, so only a workspace's own list offers it. */}
                  {workspace && <DeleteDoneTasks workspace={workspace} />}
                </div>
              )}
              {olderLoader}
              {listed.length > 0 && (
                <ul aria-label={m.tasks.taskList} className="flex flex-col divide-y rounded-xl border bg-card shadow-xs">
                  {listed.map((task) => (
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
            </div>
            )}
              {detailId !== null && context.byId.has(detailId) && (
                <Suspense fallback={<p className="text-sm text-muted-foreground">{m.tasks.loadingDetails}</p>}>
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
              <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{m.tasks.loadingTimeline}</p>}>
                <TaskGraph
                  tasks={[...timelineTasks, ...prerequisites]}
                  allTasks={allTasks.data}
                  dimmed={new Set(prerequisites.map((task) => task.id))}
                  workspaceLabel={(task) =>
                    filter === null || task.workspaceId !== filter ? context.workspaceName(task.workspaceId) : null
                  }
                  statusLabel={(task) => statusLabel(task, context.byId, m)}
                  statusStyle={(task) => statusStyle(task, context.byId)}
                  ready={(task) => shownStatus(task, context.byId) === "ready"}
                  scale={timelineScale}
                  onScaleChange={onTimelineScaleChange}
                  selectedTaskId={detailId}
                  onSelectedTaskChange={setDetailId}
                  shownTaskId={shownTask?.id ?? null}
                  searchMatchId={numbered?.id}
                  onTaskShown={() => onTaskShown?.()}
                  onNearPast={allTasks.isFetchingNextPage || allTasks.isFetchNextPageError ? undefined : loadOlder}
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
        </>
      )}
    </section>
  );
}

/** The element that scrolls `element` up and down: its nearest scrolling ancestor, else the page. */
function scrollerOf(element: Element): Element {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
      return parent;
    }
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * Sits on top of the list, where older finished tasks go, and loads the next page of them each
 * time the user scrolls up while it is on screen or close to it. Showing the finished tasks
 * alone loads none, and a page coming in above the rows on screen pushes it away until the user
 * scrolls up to it again, so one move loads one page. After a failed page it waits for the user
 * to try again, instead of asking the server over and over.
 */
function OlderTasksLoader({ loading, failed, onLoad }: { loading: boolean; failed: boolean; onLoad: () => void }) {
  const m = useMessages();
  const top = useRef<HTMLDivElement>(null);
  const latest = useRef({ loading, failed, onLoad });
  useEffect(() => {
    latest.current = { loading, failed, onLoad };
  });
  useEffect(() => {
    const element = top.current!;
    // Measured when the user moves rather than observed, since a jump to the top fires a single
    // scroll event, before an observer would report the change.
    const near = () => {
      const { top, bottom } = element.getBoundingClientRect();
      return bottom > -600 && top < window.innerHeight;
    };
    const scrolledUp = () => {
      const { loading, failed, onLoad } = latest.current;
      if (!loading && !failed && near()) onLoad();
    };
    // Scroll positions of the elements scrolling the list, to tell which way each one moved.
    const positions = new WeakMap<Element, number>();
    const scroller = scrollerOf(element);
    positions.set(scroller, scroller.scrollTop);
    const onScroll = (event: Event) => {
      const scroller = event.target === document ? document.scrollingElement : event.target;
      if (!(scroller instanceof Element) || !scroller.contains(element)) return;
      const previous = positions.get(scroller) ?? scroller.scrollTop;
      positions.set(scroller, scroller.scrollTop);
      if (scroller.scrollTop < previous) scrolledUp();
    };
    // At the top nothing scrolls any more, but the wheel still turns.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && scrollerOf(element).scrollTop <= 0) scrolledUp();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("wheel", onWheel);
    };
  }, []);
  return (
    <div ref={top} className="flex min-h-8 items-center gap-2 text-sm text-muted-foreground">
      <span role="status">{loading ? m.tasks.loadingOlder : ""}</span>
      {failed && !loading && (
        <>
          <span role="alert">{m.tasks.loadOlderError}</span>
          <Button size="sm" variant="secondary" label={m.tasks.tryAgain} onClick={onLoad} />
        </>
      )}
    </div>
  );
}

/**
 * A filter chip in the hue of its tone: outlined while off, filled like the status chip while on.
 * The Astryx toggle alone is neutral, which loses the status colours.
 */
function filterChipStyle(tone: Tone, pressed: boolean, filled: string = toneChip[tone]) {
  return cn(
    "gap-1 rounded-full border px-2",
    pressed
      ? cn(filled, "border-transparent hover:brightness-95 dark:hover:brightness-125")
      : cn(toneOutline[tone], "bg-transparent"),
  );
}

/** Search text and status and type filters narrowing the task list and the timeline. */
function TaskFilterBar({ filter, onChange }: { filter: TaskFilter; onChange: (filter: TaskFilter) => void }) {
  const m = useMessages();
  return (
    <div
      role="search"
      aria-label={m.tasks.taskFilters}
      className="flex flex-1 flex-wrap items-center justify-end gap-2 max-md:grid max-md:basis-full max-md:grid-cols-2"
    >
      <TextInput
        type="search"
        label={m.tasks.searchTasks}
        isLabelHidden
        size="sm"
        placeholder={m.tasks.searchHint}
        containerClassName="w-56 max-md:col-span-2 max-md:w-full"
        value={filter.query}
        onChange={(query) => onChange({ ...filter, query })}
      />
      <div role="group" aria-label={m.tasks.statusFilter} className="flex flex-wrap gap-1 max-md:col-span-2 max-md:gap-2">
        {shownStatuses.map((status) => (
          // Not selected: a dot in the hue of the status chip. Selected: a check.
          <ToggleButton
            key={status}
            size="sm"
            label={m.tasks.statuses[status]}
            icon={<span aria-hidden className={cn("size-1.5 rounded-full", toneFill[statusTones[status]])} />}
            pressedIcon={<Check aria-hidden />}
            className={filterChipStyle(
              statusTones[status],
              filter.statuses.includes(status),
              shownStatusStyle(status),
            )}
            isPressed={filter.statuses.includes(status)}
            onPressedChange={() => onChange({ ...filter, statuses: toggleStatus(filter.statuses, status) })}
          >
            {m.tasks.statuses[status]}
          </ToggleButton>
        ))}
      </div>
      <Selector
        label={m.tasks.typeFilter}
        isLabelHidden
        size="sm"
        value={filter.type ?? "all"}
        options={[{ value: "all", label: m.tasks.allTypes }, ...taskTypeOptions(m)]}
        onChange={(value) => onChange({ ...filter, type: value === "all" ? null : (value as TaskType) })}
      />
      <ToggleButton
        size="sm"
        label={m.tasks.autopilot}
        tooltip={m.tasks.autopilotFilter}
        icon={<Bot aria-hidden />}
        className={filterChipStyle("info", filter.autopilot)}
        isPressed={filter.autopilot}
        onPressedChange={(autopilot) => onChange({ ...filter, autopilot })}
      >
        {m.tasks.autopilot}
      </ToggleButton>
      {isFilterActive(filter) && (
        <Button size="sm" variant="ghost" label={m.tasks.clearFilters} icon={<X />} onClick={() => onChange(emptyTaskFilter)} />
      )}
    </div>
  );
}

/**
 * Deletes every done task of `workspace` once an inline confirmation naming how many is
 * accepted; they move to the archive with their history. The server counts them, since the
 * loaded pages may hold only the newest done tasks and a search may hide some.
 */
function DeleteDoneTasks({ workspace }: { workspace: Workspace }) {
  const m = useMessages();
  const deleteDone = useDeleteDoneTasks();
  // When the confirmation opened; null while it is closed.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const confirming = openedAt !== null;
  // Back, Escape, and deleting return the focus to "Delete done", which the confirmation replaces.
  const [refocus, setRefocus] = useState(false);
  const count = useDoneTaskCount(workspace.id, confirming);
  // Only a count made since the confirmation opened is named (a count kept from earlier may be
  // out of date), and deleting waits while the tasks are counted again, so the number named is
  // the number deleted.
  const counted =
    openedAt !== null && count.isSuccess && count.dataUpdatedAt >= openedAt ? count.data : undefined;

  function stopConfirming() {
    setOpenedAt(null);
    setRefocus(true);
  }

  return (
    <>
      <div
        role={confirming ? "group" : undefined}
        aria-label={confirming ? m.tasks.deleteDoneQuestion(counted) : undefined}
        className={cn("ml-auto flex items-center gap-1 max-md:gap-2", confirming && "basis-full flex-wrap justify-end")}
        onKeyDown={confirming ? escapeCloses(stopConfirming, deleteDone.isPending) : undefined}
      >
        {confirming ? (
          <>
            <span className="min-w-0 flex-1 basis-48 text-xs">
              {counted === undefined
                ? m.tasks.countingDone
                : m.tasks.deleteDoneDescription(counted)}
            </span>
            <Button
              changesData
              size="sm"
              variant="destructive"
              label={deleteDone.isPending ? m.tasks.deleting : m.tasks.confirmDelete}
              icon={<Trash2 />}
              isDisabled={deleteDone.isPending || counted === undefined || count.isFetching}
              onClick={() => deleteDone.mutate(workspace.id, { onSuccess: stopConfirming })}
            />
            {/* Focus lands on Back, so pressing Enter or Space again cannot delete. */}
            <Button size="sm" variant="ghost" label={m.tasks.back} autoFocus onClick={stopConfirming} />
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            label={m.tasks.deleteDone}
            icon={<Trash2 />}
            tooltip={m.tasks.deleteDoneHint}
            autoFocus={refocus}
            onClick={() => {
              deleteDone.reset();
              setOpenedAt(Date.now());
            }}
          />
        )}
      </div>
      {deleteDone.isError ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {deleteDone.error.message}
        </p>
      ) : (
        confirming &&
        count.isError && (
          <p role="alert" className="basis-full text-xs text-destructive">
            {m.tasks.countDoneError(count.error.message)}
          </p>
        )
      )}
    </>
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
