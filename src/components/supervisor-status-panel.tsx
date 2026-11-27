import { useEffect, useState } from "react";
import type { SupervisorLane, SupervisorStatusSnapshot } from "@/lib/supervisor-status";
import { useSupervisorStatus } from "@/web/supervisor-status";

/** A snapshot older than this means the supervisor stopped reporting: it pushes every 10 s while a panel is open. */
const STALE_AFTER_MS = 2 * 60_000;

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const preformatted = "overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs leading-snug whitespace-pre";

function Quota({ quota }: { quota: SupervisorStatusSnapshot["quota"] }) {
  if (quota === null) return <p className="text-muted-foreground">Reading the quota...</p>;
  if ("error" in quota) {
    return (
      <p role="alert" className="break-words text-destructive">
        Quota lookup failed: {quota.error}
      </p>
    );
  }
  return <pre className={preformatted}>{quota.text}</pre>;
}

function Lane({ lane }: { lane: SupervisorLane }) {
  return (
    <li aria-label={`Lane ${lane.key}`} className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium break-all">{lane.key}</span>
        {lane.task !== null && <span className="text-muted-foreground">#{lane.task}</span>}
        <span className="text-muted-foreground">
          {lane.machine}
          {lane.model !== null && ` · ${lane.model}`} · {age(lane.ageMin * 60_000)}
        </span>
      </span>
      {lane.progress !== null && <span className="break-words text-muted-foreground">{lane.progress}</span>}
      <details>
        <summary className="cursor-pointer text-muted-foreground">Recent screen</summary>
        {lane.screen === null ? (
          <p className="text-muted-foreground">Reading the screen...</p>
        ) : "error" in lane.screen ? (
          <p role="alert" className="break-words text-destructive">
            The screen could not be read: {lane.screen.error}
          </p>
        ) : (
          <pre aria-label={`Recent screen of ${lane.key}`} className={preformatted}>
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
  const { snapshot, error } = useSupervisorStatus(active);
  const now = useNow();
  if (snapshot === null) {
    return (
      <section aria-label="Dori status" className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">Waiting for the supervisor's first report...</p>
        {error !== null && (
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
        )}
      </section>
    );
  }
  const stale = now - snapshot.at > STALE_AFTER_MS;
  return (
    <section aria-label="Dori status" className="flex flex-col gap-5 text-sm">
      <p role="status" className={stale ? "text-destructive" : "text-muted-foreground"}>
        {stale ? "The supervisor has not reported for " : "Updated "}
        {age(now - snapshot.at)}
        {stale ? "." : " ago."}
        {error !== null && ` ${error}`}
      </p>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">Quota</h4>
        <Quota quota={snapshot.quota} />
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">Lanes ({snapshot.lanes.length})</h4>
        {snapshot.lanes.length === 0 ? (
          <p className="text-muted-foreground">No lane is working.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {snapshot.lanes.map((lane) => (
              <Lane key={lane.key} lane={lane} />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">Status</h4>
        {snapshot.status.map((page, index) => (
          <pre key={index} aria-label={`Status page ${index + 1}`} className={preformatted}>
            {page}
          </pre>
        ))}
      </div>
    </section>
  );
}
