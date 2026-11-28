/**
 * The scheduled jobs panel's calls: `GET /api/supervisor/schedules` lists the Dori supervisor's
 * jobs and `POST` changes one; both answer with every job and Dori's display time zone, which
 * replace the cached list.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMessages } from "@/lib/i18n";
import type { Messages } from "@/locales/en";
import type { ScheduledJob, ScheduleRequest, ScheduleTimeZone } from "@/lib/supervisor-schedules";
import { serverFetch } from "@/web/connection";
import { credentials, forgetToken, rejectedByServer } from "@/web/session";

const SCHEDULES_PATH = "/api/supervisor/schedules";
const queryKey = ["supervisor-schedules"] as const;
/** Next and last runs move on their own while the panel is open. */
const REFRESH_MS = 30_000;

export type ScheduledJobs = { readonly jobs: readonly ScheduledJob[]; readonly timeZone: ScheduleTimeZone };

async function call(t: Messages["settings"]["schedules"], request?: ScheduleRequest): Promise<ScheduledJobs> {
  const signedIn = credentials();
  if (signedIn === null) throw new Error(t.noToken);
  const response = await serverFetch(
    SCHEDULES_PATH,
    request === undefined
      ? { headers: signedIn }
      : { method: "POST", headers: { ...signedIn, "content-type": "application/json" }, body: JSON.stringify(request) },
  );
  if (await rejectedByServer(response)) forgetToken();
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null && "ok" in body) {
    if (body.ok === true && "jobs" in body && "timeZone" in body) {
      return { jobs: body.jobs as readonly ScheduledJob[], timeZone: body.timeZone as ScheduleTimeZone };
    }
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? `: ${body.message}` : "";
  throw new Error(t.requestFailed(response.status, message));
}

/** Every scheduled job, fetched while the panel is `active`. */
export function useScheduledJobs(active: boolean) {
  const t = useMessages().settings.schedules;
  return useQuery({ queryKey, queryFn: () => call(t), enabled: active, refetchInterval: active ? REFRESH_MS : false });
}

/** Applies one change; the answer is the new list. */
export function useChangeSchedule() {
  const t = useMessages().settings.schedules;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ScheduleRequest) => call(t, request),
    onSuccess: (reply) => queryClient.setQueryData(queryKey, reply),
  });
}
