import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  CalendarRange,
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
import { BackupStatusLabel } from "@/components/backup-panel";
import { Chat } from "@/components/chat-panel";
import { CommandPalette, ShortcutsDialog, type PaletteCommand } from "@/components/command-palette";
import { ErrorBoundary } from "@/components/error-boundary";
import { InstallBanner } from "@/components/install-banner";
import { NeedsAttention } from "@/components/needs-attention";
import { EmptyState, TaskList, type TaskDraft, type ShownTask } from "@/components/task-list";
import { SettingsDialog } from "@/components/settings-dialog";
import { Button, IconButton } from "@/components/button";
import { NewWorkspaceDialog, WorkspaceList } from "@/components/workspace-list";
import type { Task, TaskId, WorkspaceId } from "@/lib/bindings";
import { keepFocusIn } from "@/lib/focus-trap";
import { useLocaleFromSettings, useMessages } from "@/lib/i18n";
import { useServerEvents, useTasks, useWorkspaces } from "@/lib/queries";
import { useNarrow } from "@/lib/narrow";
import { useRoute, type Route } from "@/lib/route";
import { isPaletteKey, singleKeyShortcut } from "@/lib/shortcuts";
import { setThemePreference } from "@/lib/theme";
import type { TimelineScale } from "@/lib/task-graph";
import { cn } from "@/lib/utils";
import { type ChatTarget, chatTargetAt, listenForOpenChat, listenForOpenTask } from "@/web/push";

// The review screen loads only when it is first shown.
const Review = lazy(() => import("@/components/review").then((module) => ({ default: module.Review })));

/** The search field of the shown task view, unless it is folded away on a phone. */
function searchField(): HTMLInputElement | null {
  const field = document.querySelector<HTMLInputElement>("[role='search'] input[type='search']");
  return field !== null && (typeof field.checkVisibility !== "function" || field.checkVisibility()) ? field : null;
}

export default function App() {
  const m = useMessages();
  const workspaces = useWorkspaces();
  useServerEvents();
  useLocaleFromSettings();
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
  const settingsButton = useRef<HTMLButtonElement>(null);
  // Opened from the drawer, which closes, they give the focus back to the menu button.
  const settingsFromDrawer = useRef(false);
  const showSettings = () => {
    if (!settingsOpen) settingsFromDrawer.current = menuOpen;
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
  // The chat opens from its button, from a clicked chat notification, from a decision under Needs
  // attention, or at an address with `?chat`; the place named is shown until the chat takes it.
  const [chatOpen, setChatOpen] = useState(() => new URLSearchParams(location.search).has("chat"));
  const narrow = useNarrow();
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(() => chatTargetAt(location.search));
  useEffect(
    () =>
      listenForOpenChat((target) => {
        if (target !== null) setChatTarget(target);
        setChatOpen(true);
      }),
    [],
  );
  // The first workspace can be added from the empty main view too, on the server itself.
  const [addingFirst, setAddingFirst] = useState(false);
  const addFirstButton = useRef<HTMLButtonElement>(null);
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
    const newTask = document.querySelector<HTMLInputElement>("form[data-collapsible-form] input");
    const actions: (PaletteCommand | false)[] = [
      !!workspaces.data?.length && {
        id: "timeline",
        label: m.app.palette.timeline,
        icon: <ChartGantt />,
        run: () => openPage({ page: "all", view: "timeline", task: null }),
      },
      !!workspaces.data?.length && {
        id: "list",
        label: m.app.palette.list,
        icon: <List />,
        run: () => openPage({ page: "all", view: "list", task: null }),
      },
      !!workspaces.data?.length && {
        id: "plan",
        label: m.app.palette.plan,
        icon: <CalendarRange />,
        run: () => openPage({ page: "all", view: "plan", task: null }),
      },
      { id: "review", label: m.app.palette.review, icon: <ChartColumn />, run: () => openPage({ page: "review" }) },
      newTask !== null && {
        id: "new-task",
        label: m.app.palette.newTask,
        icon: <Plus />,
        run: () => newTask.focus(),
      },
      search !== null && { id: "search", label: m.app.searchTasks, hint: "/", icon: <Search />, run: () => search.focus() },
      { id: "settings", label: m.app.palette.settings, icon: <Settings />, run: showSettings },
      {
        id: "shortcuts",
        label: m.app.palette.shortcuts,
        hint: "?",
        icon: <Keyboard />,
        run: () => setShortcutsOpen(true),
      },
      { id: "light", label: m.app.palette.light, icon: <Sun />, run: () => setThemePreference("light") },
      { id: "dark", label: m.app.palette.dark, icon: <Moon />, run: () => setThemePreference("dark") },
      { id: "system", label: m.app.palette.system, icon: <SunMoon />, run: () => setThemePreference("system") },
      ...(workspaces.data ?? []).map(
        (workspace): PaletteCommand => ({
          id: `workspace-${workspace.id}`,
          label: m.app.palette.openWorkspace(workspace.name),
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
        kind: "task",
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
    <div className="flex h-dvh bg-background text-foreground print:block print:h-auto">
      {menuOpen && (
        <div aria-hidden className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMenuOpen(false)} />
      )}
      <aside
        ref={drawer}
        inert={settingsOpen}
        role={menuOpen ? "dialog" : undefined}
        aria-modal={menuOpen || undefined}
        aria-label={menuOpen ? m.app.menu : undefined}
        className={cn(
          "flex min-h-0 w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-sidebar p-3 text-sidebar-foreground print:hidden",
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
          <IconButton
            variant="ghost"
            size="sm"
            className="ml-auto md:hidden"
            label={m.app.closeMenu}
            icon={<X />}
            ref={closeMenuButton}
            onClick={() => setMenuOpen(false)}
          />
        </div>
        <ErrorBoundary label="the tasks that need attention">
          <NeedsAttention
            onShow={showTask}
            onOpenChat={(target) => {
              setMenuOpen(false);
              setChatTarget(target);
              setChatOpen(true);
            }}
          />
        </ErrorBoundary>
        <nav className="flex flex-col gap-0.5">
          <Button
            variant={reviewing ? "secondary" : "ghost"}
            className="justify-start"
            label={m.app.review}
            icon={<ChartColumn />}
            aria-pressed={reviewing}
            onClick={() => openPage({ page: "review" })}
          />
          <Button
            variant={showingAll ? "secondary" : "ghost"}
            className="justify-start"
            label={m.app.allWorkspaces}
            icon={<Layers />}
            aria-pressed={showingAll}
            isDisabled={!workspaces.data?.length}
            onClick={() => openPage({ page: "all", view: "timeline", task: null })}
          />
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
          label={m.settings.title}
          icon={<Settings />}
          // The backup status is part of the button's name, so it is read with it.
          endContent={
            <span className="ml-auto flex flex-col items-end text-xs font-normal">
              <BackupStatusLabel />
            </span>
          }
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          ref={settingsButton}
          onClick={showSettings}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col" inert={menuOpen || settingsOpen}>
        <header className="flex items-center gap-2 border-b px-2 py-1.5 md:hidden print:hidden">
          <IconButton
            variant="ghost"
            size="sm"
            label={m.app.openMenu}
            icon={<Menu />}
            ref={openMenuButton}
            onClick={() => setMenuOpen(true)}
          />
          <span className="font-semibold tracking-tight">Toodo</span>
        </header>
        <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-8 md:py-6 print:block print:overflow-visible print:p-0">
          <div className="contents print:hidden">
            <InstallBanner />
          </div>
          <ErrorBoundary label="this view" resetKey={reviewing ? "review" : showingAll ? "all" : selected?.id}>
            {reviewing ? (
              <Suspense fallback={<p className="text-sm text-muted-foreground">{m.app.loadingReview}</p>}>
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
                  title={m.app.workspace.firstTitle}
                  hint={m.app.workspace.firstHint}
                  action={
                    <Button
                      ref={addFirstButton}
                      variant="primary"
                      label={m.app.workspace.add}
                      icon={<Plus />}
                      aria-haspopup="dialog"
                      onClick={() => setAddingFirst(true)}
                    />
                  }
                />
              )
            )}
          </ErrorBoundary>
        </main>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        returnFocus={() => (settingsFromDrawer.current ? openMenuButton.current : settingsButton.current)}
      />
      {addingFirst && (
        <NewWorkspaceDialog
          onCreated={(workspace) => {
            setAddingFirst(false);
            openPage({ page: "workspace", workspace: workspace.id, task: null });
          }}
          onClose={() => {
            setAddingFirst(false);
            addFirstButton.current?.focus();
          }}
        />
      )}
      {!settingsOpen && (
        <ErrorBoundary label="the chat">
          <Chat
            open={chatOpen}
            onOpenChange={setChatOpen}
            target={chatTarget}
            onTargetShown={() => setChatTarget(null)}
            onShowTask={(id) => {
              // A phone has no room for both, so the chat gives way to the task's details.
              if (narrow) setChatOpen(false);
              showTask(id);
            }}
          />
        </ErrorBoundary>
      )}
      {paletteOpen && <CommandPalette commands={paletteCommands()} onClose={() => setPaletteOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
