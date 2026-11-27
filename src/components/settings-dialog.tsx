import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Archive, Bell, Bot, CalendarClock, ChevronLeft, ChevronRight, DatabaseBackup, FileCog, MonitorSmartphone, Plug, SlidersHorizontal, X } from "lucide-react";
import { AgentAccessPanel } from "@/components/agent-access-panel";
import { ArchivePanel } from "@/components/archive-panel";
import { BackupPanel, BackupStatusLabel } from "@/components/backup-panel";
import { ConnectedAppsPanel } from "@/components/connected-apps-panel";
import { DevicesPanel, DevicesStatus } from "@/components/devices-panel";
import { DoriConfigPanel, LanguageSettingField } from "@/components/dori-config-panel";
import { ErrorBoundary } from "@/components/error-boundary";
import { NotificationsPanel, NotificationsStatus } from "@/components/notifications-panel";
import { SchedulesPanel } from "@/components/schedules-panel";
import { SupervisorStatusPanel } from "@/components/supervisor-status-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { IconButton } from "@/components/button";
import { commands } from "@/lib/bindings";
import { fill, useMessages } from "@/lib/i18n";
import { en, type Messages } from "@/locales/en";
import { keepFocusIn } from "@/lib/focus-trap";
import { useNarrow } from "@/lib/narrow";
import { cn } from "@/lib/utils";

export type SettingsSection =
  | "general"
  | "agents"
  | "dori"
  | "schedules"
  | "dori-config"
  | "apps"
  | "devices"
  | "notifications"
  | "backups"
  | "archive";

type Section = {
  id: SettingsSection;
  icon: ReactNode;
  status?: ReactNode;
};

const sections: Section[] = [
  { id: "general", icon: <SlidersHorizontal /> },
  { id: "agents", icon: <Bot /> },
  { id: "dori", icon: <Activity /> },
  { id: "schedules", icon: <CalendarClock /> },
  { id: "dori-config", icon: <FileCog /> },
  { id: "apps", icon: <Plug /> },
  { id: "devices", icon: <MonitorSmartphone />, status: <DevicesStatus /> },
  { id: "notifications", icon: <Bell />, status: <NotificationsStatus /> },
  { id: "backups", icon: <DatabaseBackup />, status: <BackupStatusLabel /> },
  { id: "archive", icon: <Archive /> },
];

const sectionLabel = (id: SettingsSection, m: Messages) => m.settings.sections[id];

function GeneralSettings() {
  const m = useMessages();
  const appInfo = useQuery({ queryKey: ["app-info"], queryFn: () => commands.appInfo() });
  // The server asks the npm registry; once in a while is enough.
  const update = useQuery({
    queryKey: ["update-check"],
    queryFn: () => commands.checkUpdate(),
    staleTime: 6 * 60 * 60 * 1000,
  });
  return (
    <section aria-label={m.settings.sections.general} className="flex flex-col gap-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{m.settings.theme}</span>
        <ThemeToggle />
      </div>
      <LanguageSettingField />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{m.settings.version}</span>
        <span className="ml-auto text-muted-foreground">
          {appInfo.data ? `v${appInfo.data.version}` : m.settings.connecting}
        </span>
        {update.data?.newer && (
          <p role="status" className="w-full text-muted-foreground">
            {fill(m.settings.updateAvailable, {
              version: `v${update.data.latest}`,
              channel: update.data.channel,
              command: <code>toodo update</code>,
            })}
          </p>
        )}
        {update.data?.error && <p className="w-full text-muted-foreground">{m.settings.updateCheckFailed(update.data.error)}</p>}
      </div>
    </section>
  );
}

const tabId = (id: SettingsSection) => `settings-tab-${id}`;
const panelId = (id: SettingsSection) => `settings-panel-${id}`;

/**
 * The settings, as a modal dialog: a tab list at the left and the chosen section at the right
 * from `md` up; below it, the full screen with the list first and a section in its place once
 * chosen. Each opening starts at the list there, and at General from `md` up.
 *
 * It stays mounted while closed, so the sections keep their state and the tray's update check
 * still reaches it. The chosen section is its own state, so switching sections re-renders only
 * the dialog, not the app behind it with its timeline. Escape, a click beside it, and the close button close it; an inner form that
 * handles Escape itself goes first. Closing returns the focus to `returnFocus()`.
 */
export function SettingsDialog({
  open,
  onClose,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  returnFocus: () => HTMLElement | null | undefined;
}) {
  const m = useMessages();
  const dialog = useRef<HTMLDivElement>(null);
  const contentHeading = useRef<HTMLHeadingElement>(null);
  // Null shows the list below `md`.
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSection(null);
  }
  const shown = section ?? "general";
  const close = useRef(onClose);
  close.current = onClose;
  const restore = useRef(returnFocus);
  restore.current = returnFocus;
  // Below `md` either the list or one section fills the screen.
  const narrow = useNarrow();

  useLayoutEffect(() => {
    if (!open) return;
    if (narrow && section !== null) contentHeading.current?.focus({ preventScroll: true });
    else document.getElementById(tabId(shown))?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (active !== null && active !== document.body && !dialog.current?.contains(active)) return;
      const back = restore.current();
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // An inner form or confirmation handles its own Escape first.
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close.current();
      }
      if (event.key === "Tab") keepFocusIn(dialog.current, event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Choosing a section or going back swaps the whole screen there, so the focus moves along.
  const choose = (id: SettingsSection) => {
    setSection(id);
    if (narrow) requestAnimationFrame(() => contentHeading.current?.focus({ preventScroll: true }));
  };
  const back = () => {
    setSection(null);
    requestAnimationFrame(() => document.getElementById(tabId(shown))?.focus({ preventScroll: true }));
  };

  const onTabKeyDown = (event: ReactKeyboardEvent) => {
    const index = sections.findIndex((item) => item.id === shown);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % sections.length
        : event.key === "ArrowUp"
          ? (index - 1 + sections.length) % sections.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? sections.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const id = sections[next].id;
    setSection(id);
    document.getElementById(tabId(id))?.focus();
  };

  const current = sections.find((item) => item.id === shown) ?? sections[0];

  return (
    <div hidden={!open} className="fixed inset-0 z-50">
      <div aria-hidden className="absolute inset-0 bg-black/40 max-md:hidden" onClick={() => onClose()} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal
        aria-labelledby="settings-title"
        className={cn(
          "relative flex overflow-hidden bg-background text-foreground",
          "max-md:h-full max-md:flex-col max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]",
          "md:absolute md:top-1/2 md:left-1/2 md:h-[min(40rem,calc(100dvh-4rem))] md:w-[min(52rem,calc(100vw-4rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:shadow-xl",
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-col gap-2 overflow-y-auto bg-sidebar p-3 text-sidebar-foreground md:w-56 md:shrink-0 md:border-r",
            "max-md:flex-1",
            section !== null && "max-md:hidden",
          )}
        >
          <div className="flex items-center gap-2 px-1">
            <h2 id="settings-title" className="text-lg font-semibold tracking-tight md:text-base">
              {m.settings.title}
            </h2>
            <IconButton
              variant="ghost"
              size="sm"
              className="ml-auto md:hidden"
              label={m.settings.close}
              icon={<X />}
              onClick={() => onClose()}
            />
          </div>
          <div role="tablist" aria-orientation="vertical" aria-label={m.settings.sectionsLabel} className="flex flex-col gap-0.5" onKeyDown={onTabKeyDown}>
            {sections.map((item) => {
              const selected = item.id === shown;
              return (
                <button
                  key={item.id}
                  id={tabId(item.id)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId(item.id)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => choose(item.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                    selected && "md:bg-secondary md:font-medium",
                  )}
                >
                  {item.icon}
                  <span>{sectionLabel(item.id, m)}</span>
                  {item.status && <span className="ml-auto text-xs text-muted-foreground">{item.status}</span>}
                  <ChevronRight aria-hidden className={cn("md:hidden", !item.status && "ml-auto")} />
                </button>
              );
            })}
          </div>
        </div>
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", section === null && "max-md:hidden")}>
          <div className="flex shrink-0 items-center gap-1 border-b px-2 py-2 md:px-6 md:py-3">
            <IconButton
              variant="ghost"
              size="sm"
              className="md:hidden"
              label={m.settings.back}
              icon={<ChevronLeft />}
              onClick={back}
            />
            <h3 ref={contentHeading} tabIndex={-1} className="text-base font-semibold outline-none">
              {sectionLabel(current.id, m)}
            </h3>
            <IconButton
              variant="ghost"
              size="sm"
              className="ml-auto"
              label={m.settings.close}
              tooltip={m.settings.closeTooltip}
              icon={<X />}
              onClick={() => onClose()}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 md:px-6">
            {sections.map((item) => (
              <div
                key={item.id}
                id={panelId(item.id)}
                role="tabpanel"
                aria-labelledby={tabId(item.id)}
                hidden={item.id !== shown}
              >
                <ErrorBoundary label={`the ${en.settings.sections[item.id]} settings`}>
                  {item.id === "general" ? (
                    <GeneralSettings />
                  ) : item.id === "dori" ? (
                    <SupervisorStatusPanel active={open && shown === "dori"} />
                  ) : item.id === "schedules" ? (
                    <SchedulesPanel active={open && shown === "schedules"} />
                  ) : item.id === "dori-config" ? (
                    <DoriConfigPanel active={open && shown === "dori-config"} />
                  ) : item.id === "agents" ? (
                    <AgentAccessPanel />
                  ) : item.id === "apps" ? (
                    <ConnectedAppsPanel />
                  ) : item.id === "devices" ? (
                    <DevicesPanel />
                  ) : item.id === "notifications" ? (
                    <NotificationsPanel />
                  ) : item.id === "backups" ? (
                    <BackupPanel />
                  ) : (
                    <ArchivePanel />
                  )}
                </ErrorBoundary>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
