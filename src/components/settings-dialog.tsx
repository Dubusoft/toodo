import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Bot, ChevronLeft, ChevronRight, DatabaseBackup, MonitorSmartphone, SlidersHorizontal, X } from "lucide-react";
import { AgentAccessPanel, AgentAccessStatus } from "@/components/agent-access-panel";
import { BackupPanel } from "@/components/backup-panel";
import { DevicesPanel, DevicesStatus } from "@/components/devices-panel";
import { NotificationsPanel, NotificationsStatus } from "@/components/notifications-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { commands } from "@/lib/bindings";
import { keepFocusIn } from "@/lib/focus-trap";
import { useNarrow } from "@/lib/narrow";
import { cn } from "@/lib/utils";

export type SettingsSection = "general" | "agents" | "devices" | "notifications" | "backups";

type Section = {
  id: SettingsSection;
  label: string;
  icon: ReactNode;
  status?: ReactNode;
};

const sections: Section[] = [
  { id: "general", label: "General", icon: <SlidersHorizontal /> },
  { id: "agents", label: "Agent access", icon: <Bot />, status: <AgentAccessStatus /> },
  { id: "devices", label: "Devices", icon: <MonitorSmartphone />, status: <DevicesStatus /> },
  { id: "notifications", label: "Notifications", icon: <Bell />, status: <NotificationsStatus /> },
  { id: "backups", label: "Backups", icon: <DatabaseBackup /> },
];

function GeneralSettings() {
  const appInfo = useQuery({ queryKey: ["app-info"], queryFn: () => commands.appInfo() });
  return (
    <section aria-label="General" className="flex flex-col gap-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Theme</span>
        <ThemeToggle />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">Version</span>
        <span className="ml-auto text-muted-foreground">
          {appInfo.data ? `v${appInfo.data.version}` : "Connecting to backend..."}
        </span>
      </div>
    </section>
  );
}

const tabId = (id: SettingsSection) => `settings-tab-${id}`;
const panelId = (id: SettingsSection) => `settings-panel-${id}`;

/**
 * The settings, as a modal dialog: a tab list at the left and the chosen section at the right
 * from `md` up; below it, the full screen with the list first and a section in its place once
 * chosen (`section` null shows the list there, and General from `md` up).
 *
 * It stays mounted while closed, so the sections keep their state and the tray's update check
 * still reaches it. Escape, a click beside it, and the close button close it; an inner form that
 * handles Escape itself goes first. Closing returns the focus to `returnFocus()`.
 */
export function SettingsDialog({
  open,
  section,
  onShow,
  onClose,
  returnFocus,
}: {
  open: boolean;
  section: SettingsSection | null;
  onShow: (section: SettingsSection | null) => void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null | undefined;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const contentHeading = useRef<HTMLHeadingElement>(null);
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
    onShow(id);
    if (narrow) requestAnimationFrame(() => contentHeading.current?.focus({ preventScroll: true }));
  };
  const back = () => {
    onShow(null);
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
    onShow(id);
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
              Settings
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto md:hidden"
              aria-label="Close settings"
              onClick={() => onClose()}
            >
              <X />
            </Button>
          </div>
          <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" className="flex flex-col gap-0.5" onKeyDown={onTabKeyDown}>
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
                  <span>{item.label}</span>
                  {item.status && <span className="ml-auto text-xs text-muted-foreground">{item.status}</span>}
                  <ChevronRight aria-hidden className={cn("md:hidden", !item.status && "ml-auto")} />
                </button>
              );
            })}
          </div>
        </div>
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", section === null && "max-md:hidden")}>
          <div className="flex shrink-0 items-center gap-1 border-b px-2 py-2 md:px-6 md:py-3">
            <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Back to settings" onClick={back}>
              <ChevronLeft />
            </Button>
            <h3 ref={contentHeading} tabIndex={-1} className="text-base font-semibold outline-none">
              {current.label}
            </h3>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Close settings"
              title="Close settings (Esc)"
              onClick={() => onClose()}
            >
              <X />
            </Button>
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
                {item.id === "general" ? (
                  <GeneralSettings />
                ) : item.id === "agents" ? (
                  <AgentAccessPanel />
                ) : item.id === "devices" ? (
                  <DevicesPanel />
                ) : item.id === "notifications" ? (
                  <NotificationsPanel />
                ) : (
                  <BackupPanel />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
