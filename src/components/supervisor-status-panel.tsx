import { useEffect, useState } from "react";
import { useMessages } from "@/lib/i18n";
import type { Messages } from "@/locales/en";
import type { SupervisorLane, SupervisorStatusSnapshot } from "@/lib/supervisor-status";
import { useSupervisorNotice } from "@/web/host-status";
import { useSupervisorStatus, workingLanes } from "@/web/supervisor-status";

/** A snapshot older than this means the supervisor stopped reporting: it pushes every 10 s while a panel is open. */
export const STALE_AFTER_MS = 2 * 60_000;

export function age(ms: number, t: Messages["settings"]["supervisorPanel"]): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t.seconds(seconds);
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? t.minutes(minutes) : t.hours(Math.round(minutes / 60));
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const monospace = "rounded-md bg-muted px-2 py-1.5 font-mono text-xs leading-snug";
/** Quota and lane screens line up in columns, so they keep their lines and scroll sideways. */
const preformatted = `${monospace} overflow-x-auto whitespace-pre`;
/** `/status` is prose lines, which wrap to the width so a phone shows them whole. */
const wrapped = `${monospace} whitespace-pre-wrap wrap-anywhere`;

function Quota({ quota }: { quota: SupervisorStatusSnapshot["quota"] }) {
  const m = useMessages();
  const t = m.settings.supervisorPanel;
  if (quota === null) return <p className="text-muted-foreground">{t.readingQuota}</p>;
  if ("error" in quota) {
    return (
      <p role="alert" className="break-words text-destructive">
        {t.quotaFailure(quota.error)}
      </p>
    );
  }
  return <pre className={preformatted}>{quota.text}</pre>;
}

function Lane({ lane }: { lane: SupervisorLane }) {
  const m = useMessages();
  const t = m.settings.supervisorPanel;
  return (
    <li aria-label={t.lane(lane.key)} className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium break-all">{lane.key}</span>
        {lane.task !== null && <span className="text-muted-foreground">#{lane.task}</span>}
        <span className="text-muted-foreground">
          {lane.machine}
          {lane.model !== null && ` · ${lane.model}`} · {age(lane.ageMin * 60_000, t)}
        </span>
      </span>
      {lane.progress !== null && <span className="break-words text-muted-foreground">{lane.progress}</span>}
      <details>
        <summary className="cursor-pointer text-muted-foreground">{t.screen}</summary>
        {lane.screen === null ? (
          <p className="text-muted-foreground">{t.readingScreen}</p>
        ) : "error" in lane.screen ? (
          <p role="alert" className="break-words text-destructive">
            {t.screenFailure(lane.screen.error)}
          </p>
        ) : (
          <pre aria-label={t.screenOf(lane.key)} className={preformatted}>
            {lane.screen.text}
          </pre>
        )}
      </details>
    </li>
  );
}

/**
 * Dori's state, quota, and working lanes with their recent screens: what Discord's `/status`
 * and `/quota` show, from the supervisor's latest snapshot. It follows the snapshots only while
 * `active` (shown), since the supervisor reads screens and quota only for an open panel.
 */
export function SupervisorStatusPanel({ active }: { active: boolean }) {
  const m = useMessages();
  const t = m.settings.supervisorPanel;
  const { snapshot, error } = useSupervisorStatus(active);
  const notice = useSupervisorNotice(active);
  const now = useNow();
  const noticeLine = notice !== null && (
    <p role="alert" className="break-words text-destructive">
      {notice}
    </p>
  );
  if (snapshot === null) {
    return (
      <section aria-label={m.settings.advanced.supervisor} className="flex flex-col gap-2 text-sm">
        {noticeLine || <p className="text-muted-foreground">{t.waiting}</p>}
        {notice === null && error !== null && (
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
        )}
      </section>
    );
  }
  const stale = now - snapshot.at > STALE_AFTER_MS;
  const lanes = workingLanes(snapshot);
  return (
    <section aria-label={m.settings.advanced.supervisor} className="flex flex-col gap-5 text-sm">
      {noticeLine}
      <p role="status" className={stale ? "text-destructive" : "text-muted-foreground"}>
        {(stale ? t.stale : t.updated)(age(now - snapshot.at, t))}
        {error !== null && ` ${error}`}
      </p>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">{t.quota}</h4>
        <Quota quota={snapshot.quota} />
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">{t.lanes(lanes.length)}</h4>
        {lanes.length === 0 ? (
          <p className="text-muted-foreground">{t.empty}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {lanes.map((lane) => (
              <Lane key={lane.key} lane={lane} />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">{t.status}</h4>
        {snapshot.status.map((page, index) => (
          <pre key={index} aria-label={t.page(index + 1)} className={wrapped}>
            {page}
          </pre>
        ))}
      </div>
    </section>
  );
}
