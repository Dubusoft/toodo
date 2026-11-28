import { useEffect, useState } from "react";
import { ChoiceSetting, useDoriConfig } from "@/components/dori-config-panel";
import { SchedulesPanel } from "@/components/schedules-panel";
import { STALE_AFTER_MS, age, useNow } from "@/components/supervisor-status-panel";
import type { DoriConfigEntry } from "@/lib/dori-config";
import { useMessages } from "@/lib/i18n";
import type { SupervisorStatusSnapshot } from "@/lib/supervisor-status";
import { supervisorDown, useHostSupervisor } from "@/web/host-status";
import { useSupervisorStatus, workingLanes } from "@/web/supervisor-status";

/** How long the summary says it is checking before it says Dori has not reported. */
const FIRST_REPORT_WAIT_MS = 30_000;

/** The highest percentage the quota text names ("5h 12% · 7d 40%" is 40), or null when it names none. */
export function highestUsage(quota: SupervisorStatusSnapshot["quota"]): number | null {
  if (quota === null || "error" in quota) return null;
  const percents = [...quota.text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
  return percents.length === 0 ? null : Math.round(Math.max(...percents));
}

/**
 * Dori at a glance: whether it reports, its highest usage, and the working lanes. The full
 * status, quota, and lane screens are in Advanced. It follows the status only while `active`.
 */
function StatusSummary({ active }: { active: boolean }) {
  const m = useMessages();
  const t = m.settings.doriPanel;
  const units = m.settings.supervisorPanel;
  const { snapshot } = useSupervisorStatus(active);
  const supervisor = useHostSupervisor(active);
  const now = useNow();
  const [since, setSince] = useState(() => Date.now());
  useEffect(() => {
    if (active) setSince(Date.now());
  }, [active]);

  // The host says Dori is not running: say so plainly; Advanced has the state and what to do.
  if (supervisorDown(supervisor)) {
    return (
      <div className="flex flex-col gap-1.5">
        <p role="status" className="font-medium text-destructive">
          {supervisor.state === "absent" ? t.notRunning : supervisor.state === "off" ? t.off : t.unresponsive}
        </p>
        <p className="text-muted-foreground">{t.rawHint}</p>
      </div>
    );
  }
  if (snapshot === null) {
    const silent = now - since > FIRST_REPORT_WAIT_MS;
    return (
      <p role="status" className={silent ? "text-destructive" : "text-muted-foreground"}>
        {silent ? t.noReport : t.checking}
      </p>
    );
  }
  const stale = now - snapshot.at > STALE_AFTER_MS;
  const usage = highestUsage(snapshot.quota);
  const lanes = workingLanes(snapshot);
  return (
    <div className="flex flex-col gap-1.5">
      <p role="status" className="flex flex-wrap gap-x-2">
        <span className={stale ? "font-medium text-destructive" : "font-medium"}>{stale ? t.unresponsive : t.healthy}</span>
        <span className="text-muted-foreground">{t.lastReport(age(now - snapshot.at, units))}</span>
      </p>
      <p className="text-muted-foreground">
        {[usage === null ? null : t.usage(usage), lanes.length === 0 ? t.noLanes : t.lanes(lanes.length)].filter(Boolean).join(" · ")}
      </p>
      {lanes.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">{t.viewLanes}</summary>
          <ul className="flex flex-col gap-2 pt-2">
            {lanes.map((lane) => (
              <li key={lane.key} aria-label={units.lane(lane.key)} className="flex flex-col">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium break-all">{lane.key}</span>
                  {lane.task !== null && <span className="text-muted-foreground">#{lane.task}</span>}
                  <span className="text-muted-foreground">
                    {lane.machine} · {age(lane.ageMin * 60_000, units)}
                  </span>
                </span>
                {lane.progress !== null && <span className="break-words text-muted-foreground">{lane.progress}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-muted-foreground">{t.rawHint}</p>
    </div>
  );
}

/**
 * The value an option for a key's default saves: the value itself when the host wrote it out,
 * else unset, so picking the default leaves an unset key unset.
 */
const defaultValue = (entry: DoriConfigEntry, value: string) => (entry.value === value ? value : "");

/** The keys of how Dori works that an owner changes, in plain words and with choices. */
function BehaviorSettings() {
  const m = useMessages();
  const t = m.settings.doriPanel;
  const entries = useDoriConfig().data?.entries ?? [];
  const entry = (key: string) => entries.find((e) => e.key === key);
  const autoReport = entry("autoReport");
  if (!autoReport) return null;
  return (
    <div className="flex flex-col gap-3">
      <h4 className="font-medium">{t.behavior}</h4>
      <ChoiceSetting
        entry={autoReport}
        label={t.autoReport}
        description={t.autoReportDescription}
        options={[
          { value: "off", label: t.autoReportOptions.off },
          { value: "autopilot", label: t.autoReportOptions.autopilot },
          { value: defaultValue(autoReport, "all"), label: t.autoReportOptions.all },
        ]}
      />
    </div>
  );
}

/** Settings > Dori: its status at a glance, its scheduled jobs, and how it works. */
export function DoriPanel({ active }: { active: boolean }) {
  const m = useMessages();
  return (
    <section aria-label={m.settings.sections.dori} className="break-words-keep flex flex-col gap-6 text-sm">
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">{m.settings.doriPanel.status}</h4>
        <StatusSummary active={active} />
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">{m.settings.schedules.title}</h4>
        <SchedulesPanel active={active} />
      </div>
      <BehaviorSettings />
    </section>
  );
}
