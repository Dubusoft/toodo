import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ChartColumn,
  CircleDot,
  FolderGit2,
  FolderPlus,
  ChartGantt,
  Keyboard,
  Layers,
  List,
  ListTodo,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  SunMoon,
  X,
} from "lucide-react";
import { AgentAccessStatus } from "@/components/agent-access-panel";
import { CommandPalette, ShortcutsDialog, type PaletteCommand } from "@/components/command-palette";
import { ErrorBoundary } from "@/components/error-boundary";
import { HerdrBanner } from "@/components/herdr-banner";
import { InstallBanner } from "@/components/install-banner";
import { NeedsAttention } from "@/components/needs-attention";
import { EmptyState, TaskList, type TaskDraft, type ShownTask } from "@/components/task-list";
import { SettingsDialog, type SettingsSection } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { WorkspaceList } from "@/components/workspace-list";
import type { Task, TaskId, WorkspaceId } from "@/lib/bindings";
import { keepFocusIn } from "@/lib/focus-trap";
import { useHerdrEvents, useTasks, useWorkspaces } from "@/lib/queries";
import { useRoute, type Route } from "@/lib/route";
import { isPaletteKey, singleKeyShortcut } from "@/lib/shortcuts";
import { setThemePreference } from "@/lib/theme";
import type { TimelineScale } from "@/lib/task-graph";
import { cn } from "@/lib/utils";
import { listenForOpenTask } from "@/web/push";

// The review screen loads only when it is first shown.
const Review = lazy(() => import("@/components/review").then((module) => ({ default: module.Review })));

/** The search field of the shown task view, unless it is folded away on a phone. */
function searchField(): HTMLInputElement | null {
  const field = document.querySelector<HTMLInputElement>("input[aria-label='Search tasks']");
  return field !== null && (typeof field.checkVisibility !== "function" || field.checkVisibility()) ? field : null;
}

export default function App() {
  const workspaces = useWorkspaces();
  useHerdrEvents();
  // A task to select on the All workspaces timeline, until the timeline shows it.
  const [shownTask, setShownTask] = useState<ShownTask | null>(null);
  // An address opened or returned to brings its task out on the timeline, as a shown task does.
  const [route, navigate] = useRoute((entered) => {
    if (entered.page === "all" && entered.view === "timeline" && entered.task !== null) {
      setShownTask({ id: entered.task });
    }
  });
  const reviewing = route.page === "review";
  const selectedId: WorkspaceId | "all" = route.page === "workspace" ? route.workspace : "all";
  const openPage = (next: Route) => {
    navigate(next);
    setMenuOpen(false);
  };
  // On narrow screens the sidebar is a modal drawer over the content.
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenuButton = useRef<HTMLButtonElement>(null);
  const closeMenuButton = useRef<HTMLButtonElement>(null);
  const menuWasOpen = useRef(false);
  const drawer = useRef<HTMLElement>(null);
  // Settings take over the screen and the focus, also when opened from the drawer.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  // Opened from the drawer, which closes, they give the focus back to the menu button.
  const settingsFromDrawer = useRef(false);
  const showSettings = (section: SettingsSection | null) => {
    if (!settingsOpen) settingsFromDrawer.current = menuOpen;
    setSettingsSection(section);
    setSettingsOpen(true);
    setMenuOpen(false);
  };
  useEffect(() => {
    if (menuOpen) closeMenuButton.current?.focus();
    else if (menuWasOpen.current && !settingsOpen) openMenuButton.current?.focus();
    menuWasOpen.current = menuOpen;
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // An inline form in the drawer handles its own Escape first.
      if (event.key === "Escape" && !event.defaultPrevented) setMenuOpen(false);
      if (event.key === "Tab") keepFocusIn(drawer.current, event);
    };
    // Past the md breakpoint (48rem) the sidebar is no drawer, so nothing may stay inert.
    const onResize = () => {
      if (window.innerWidth >= 768) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen]);
  // Kept here so switching workspaces or views does not reset them.
  const [timelineScale, setTimelineScale] = useState<TimelineScale>("week");
  const [drafts, setDrafts] = useState<ReadonlyMap<WorkspaceId, TaskDraft>>(new Map());
  const setDraft = (id: WorkspaceId, draft: TaskDraft) => setDrafts((current) => new Map(current).set(id, draft));
  const showTask = (id: TaskId) => {
    openPage({ page: "all", view: "timeline", task: id });
    setShownTask({ id });
  };
  // A clicked notification opens its task.
  useEffect(() => listenForOpenTask(showTask), []);
  const showingAll = selectedId === "all" && !reviewing;
  const selected =
    workspaces.data?.find((workspace) => workspace.id === selectedId) ?? workspaces.data?.[0];

  const tasks = useTasks();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The palette opens from anywhere but the settings, which own the keyboard while open.
      if (isPaletteKey(event)) {
        if (settingsOpen) return;
        event.preventDefault();
        setMenuOpen(false);
        setShortcutsOpen(false);
        setPaletteOpen((open) => !open);
      } else if (event.key === "?" && singleKeyShortcut(event)) {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (event.key === "/" && singleKeyShortcut(event) && searchField() !== null) {
        event.preventDefault();
        searchField()?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);
  // A task opens where the user is: in the list or on the timeline of every workspace, else in its workspace.
  const openTask = (task: Task) => {
    if (route.page === "all" && route.view === "timeline") showTask(task.id);
    else if (route.page === "all") openPage({ ...route, task: task.id });
    else openPage({ page: "workspace", workspace: task.workspaceId, task: task.id });
  };
  const paletteCommands = (): PaletteCommand[] => {
    const workspaceName = new Map(workspaces.data?.map((workspace) => [workspace.id, workspace.name]));
    const search = searchField();
    const newTask = document.querySelector<HTMLInputElement>("input[aria-label='Task title']");
    const actions: (PaletteCommand | false)[] = [
      !!workspaces.data?.length && {
        id: "timeline",
        group: "Actions",
        label: "Show the timeline of all workspaces",
        icon: <ChartGantt />,
        run: () => openPage({ page: "all", view: "timeline", task: null }),
      },
      !!workspaces.data?.length && {
        id: "list",
        group: "Actions",
        label: "Show the task list of all workspaces",
        icon: <List />,
        run: () => openPage({ page: "all", view: "list", task: null }),
      },
      { id: "review", group: "Actions", label: "Show the review", icon: <ChartColumn />, run: () => openPage({ page: "review" }) },
      newTask !== null && {
        id: "new-task",
        group: "Actions",
        label: "New task in this workspace",
        icon: <Plus />,
        run: () => newTask.focus(),
      },
      search !== null && { id: "search", group: "Actions", label: "Search tasks", hint: "/", icon: <Search />, run: () => search.focus() },
      { id: "settings", group: "Actions", label: "Open settings", icon: <Settings />, run: () => showSettings(null) },
      {
        id: "shortcuts",
        group: "Actions",
        label: "Show keyboard shortcuts",
        hint: "?",
        icon: <Keyboard />,
        run: () => setShortcutsOpen(true),
      },
      { id: "light", group: "Actions", label: "Use the light theme", icon: <Sun />, run: () => setThemePreference("light") },
      { id: "dark", group: "Actions", label: "Use the dark theme", icon: <Moon />, run: () => setThemePreference("dark") },
      { id: "system", group: "Actions", label: "Use the system theme", icon: <SunMoon />, run: () => setThemePreference("system") },
      ...(workspaces.data ?? []).map(
        (workspace): PaletteCommand => ({
          id: `workspace-${workspace.id}`,
          group: "Actions",
          label: `Open workspace ${workspace.name}`,
          icon: <FolderGit2 />,
          run: () => openPage({ page: "workspace", workspace: workspace.id, task: null }),
        }),
      ),
    ];
    // Open tasks come first, newest first, then finished ones.
    const ordered = [...(tasks.data ?? [])].sort(
      (a, b) => Number(a.status === "done") - Number(b.status === "done") || b.id - a.id,
    );
    const taskCommands = ordered.map(
      (task): PaletteCommand => ({
        id: `task-${task.id}`,
        group: "Tasks",
        label: `#${task.id} ${task.title}`,
        keywords: workspaceName.get(task.workspaceId),
        hint: workspaceName.get(task.workspaceId),
        icon: <CircleDot />,
        run: () => openTask(task),
      }),
    );
    return [...actions.filter((action) => action !== false), ...taskCommands];
  };

  return (
    <div className="flex h-dvh bg-background text-foreground">
      {menuOpen && (
        <div aria-hidden className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMenuOpen(false)} />
      )}
      <aside
        ref={drawer}
        inert={settingsOpen}
        role={menuOpen ? "dialog" : undefined}
        aria-modal={menuOpen || undefined}
        aria-label={menuOpen ? "Menu" : undefined}
        className={cn(
          "flex min-h-0 w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-sidebar p-3 text-sidebar-foreground",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-lg",
          !menuOpen && "max-md:hidden",
        )}
      >
        <div className="flex items-center gap-2">
          <h1 className="flex items-center gap-2 px-1 text-lg font-semibold tracking-tight">
            <span
              aria-hidden
              className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground"
            >
              <ListTodo className="size-4" />
            </span>
            Toodo
          </h1>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto md:hidden"
            aria-label="Close menu"
            ref={closeMenuButton}
            onClick={() => setMenuOpen(false)}
          >
            <X />
          </Button>
        </div>
        <ErrorBoundary label="the tasks that need attention">
          <NeedsAttention onShow={showTask} />
        </ErrorBoundary>
        <nav className="flex flex-col gap-0.5">
          <Button
            variant={reviewing ? "secondary" : "ghost"}
            className="justify-start"
            aria-pressed={reviewing}
            onClick={() => openPage({ page: "review" })}
          >
            <ChartColumn />
            Review
          </Button>
          <Button
            variant={showingAll ? "secondary" : "ghost"}
            className="justify-start"
            aria-pressed={showingAll}
            disabled={!workspaces.data?.length}
            onClick={() => openPage({ page: "all", view: "timeline", task: null })}
          >
            <Layers />
            All workspaces
          </Button>
        </nav>
        <ErrorBoundary label="the workspace list">
          <WorkspaceList
            selectedId={reviewing || showingAll ? null : (selected?.id ?? null)}
            onSelect={(id) => openPage({ page: "workspace", workspace: id, task: null })}
          />
        </ErrorBoundary>
        <Button
          variant="ghost"
          className="mt-auto shrink-0 justify-start"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          ref={settingsButton}
          onClick={() => showSettings(null)}
        >
          <Settings />
          Settings
          <span className="ml-auto text-xs font-normal">
            <AgentAccessStatus />
          </span>
        </Button>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col" inert={menuOpen || settingsOpen}>
        <header className="flex items-center gap-2 border-b px-2 py-1.5 md:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open menu"
            ref={openMenuButton}
            onClick={() => setMenuOpen(true)}
          >
            <Menu />
          </Button>
          <span className="font-semibold tracking-tight">Toodo</span>
        </header>
        <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-8 md:py-6">
          <InstallBanner />
          <HerdrBanner />
          <ErrorBoundary label="this view" resetKey={reviewing ? "review" : showingAll ? "all" : selected?.id}>
            {reviewing ? (
              <Suspense fallback={<p className="text-sm text-muted-foreground">Loading review...</p>}>
                <Review onShowTask={showTask} />
              </Suspense>
            ) : route.page === "all" && workspaces.data?.length ? (
              <TaskList
                key="all"
                workspace={null}
                view={route.view}
                onViewChange={(view) => navigate({ page: "all", view, task: null })}
                selectedTask={route.task}
                onSelectTask={(task) => navigate({ ...route, task })}
                timelineScale={timelineScale}
                onTimelineScaleChange={setTimelineScale}
                shownTask={shownTask}
                onTaskShown={() => setShownTask(null)}
              />
            ) : selected ? (
              <TaskList
                key={selected.id}
                workspace={selected}
                selectedTask={route.page === "workspace" ? route.task : null}
                onSelectTask={(task) => navigate({ page: "workspace", workspace: selected.id, task })}
                timelineScale={timelineScale}
                onTimelineScaleChange={setTimelineScale}
                draft={drafts.get(selected.id)}
                onDraftChange={(draft) => setDraft(selected.id, draft)}
              />
            ) : (
              // A failed load is explained, with a retry, in the sidebar's workspace list.
              !workspaces.isPending && !workspaces.isError && (
                <EmptyState
                  icon={<FolderPlus />}
                  title="Create a workspace to start planning tasks."
                  hint={`Clone a repository, open one already cloned, or make a folder a new repository, on the server or a saved herdr machine.`}
                />
              )
            )}
          </ErrorBoundary>
        </main>
      </div>
      <SettingsDialog
        open={settingsOpen}
        section={settingsSection}
        onShow={showSettings}
        onClose={() => setSettingsOpen(false)}
        returnFocus={() => (settingsFromDrawer.current ? openMenuButton.current : settingsButton.current)}
      />
      {paletteOpen && <CommandPalette commands={paletteCommands()} onClose={() => setPaletteOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
