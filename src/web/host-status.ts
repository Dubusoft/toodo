/**
 * The host's supervisor state (`GET /api/host`) for the Dori panels, so they say why Dori is
 * silent instead of waiting for it: a server without the host (`toodo-server`) has no such
 * path, the host in safe mode answers `off`, and a supervisor that failed or stopped answers
 * with that state while the host restarts it or gives up.
 */
import { useQuery } from "@tanstack/react-query";
import { useMessages } from "@/lib/i18n";
import type { Messages } from "@/locales/en";
import { serverFetch } from "@/web/connection";

/** The host's states (host/src/supervisor.ts), `off` for safe mode, and `absent` without a host. */
export type HostSupervisor =
  | { readonly state: "absent" }
  | { readonly state: string; readonly nextStartAt: number | null };

/** The states in which the supervisor runs or is about to: the panels wait for it. */
const COMING = new Set(["idle", "starting", "running"]);
/** A started supervisor answers within seconds, so the panels learn of a change soon. */
const REFRESH_MS = 5000;

async function hostSupervisor(): Promise<HostSupervisor> {
  const response = await serverFetch("/api/host", { cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  const supervisor: unknown = typeof body === "object" && body !== null && "supervisor" in body ? body.supervisor : null;
  if (!response.ok || typeof supervisor !== "object" || supervisor === null || !("state" in supervisor) || typeof supervisor.state !== "string") {
    return { state: "absent" };
  }
  const next = "nextStartAt" in supervisor && typeof supervisor.nextStartAt === "number" ? supervisor.nextStartAt : null;
  return { state: supervisor.state, nextStartAt: next };
}

/** Why Dori cannot answer and what to do about it, or `null` while it runs or starts. */
export function supervisorNotice(
  supervisor: HostSupervisor | undefined,
  now: number,
  t: Messages["settings"]["supervisorPanel"],
): string | null {
  if (supervisor === undefined || COMING.has(supervisor.state)) return null;
  if (supervisor.state === "absent") return t.notConnected;
  if (supervisor.state === "off") return t.off;
  const next = "nextStartAt" in supervisor ? supervisor.nextStartAt : null;
  return t.notResponding(supervisor.state, next === null ? null : Math.max(0, Math.ceil((next - now) / 60_000)));
}

/** Whether the supervisor is known not to run or start: the Dori panels stop waiting for it. */
export function supervisorDown(supervisor: HostSupervisor | undefined): supervisor is HostSupervisor {
  return supervisor !== undefined && !COMING.has(supervisor.state);
}

/** The host's supervisor state, followed while a Dori panel is `active`; undefined until known. */
export function useHostSupervisor(active: boolean): HostSupervisor | undefined {
  return useQuery({
    queryKey: ["host-supervisor"],
    queryFn: hostSupervisor,
    enabled: active,
    retry: false,
    refetchInterval: active ? REFRESH_MS : false,
  }).data;
}

/** The notice for the supervisor's state, followed while a Dori panel is `active`. */
export function useSupervisorNotice(active: boolean): string | null {
  const t = useMessages().settings.supervisorPanel;
  return supervisorNotice(useHostSupervisor(active), Date.now(), t);
}
