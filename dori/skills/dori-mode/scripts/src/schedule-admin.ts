// Changes to the scheduled jobs from outside the supervisor's own pass: `dori schedule` and the Toodo web app (through the
// host, supervise-worker.ts). Each one edits sources.json, which the supervisor reads on every pass, so it applies
// without a restart.
import type { ScheduledJob, ScheduleReply, ScheduleRequest, ScheduleTiming } from "../../../../../src/lib/supervisor-schedules.ts";
import { readSourceStatus, SourceSpecs } from "./event-sources.ts";
import { queueRunNow, scheduleRow, type ScheduleSpec } from "./schedule.ts";
import { SourceError } from "./source-types.ts";

export const findSchedule = (specs: SourceSpecs, name: string): ScheduleSpec => {
  const spec = specs.list().find((s) => s.name === name);
  if (spec?.type !== "schedule") throw new SourceError(`no schedule "${name}"`);
  return spec;
};

/** A `--command` / form value as an argv: a shell line runs with `sh -c`, `[...]` is a JSON argv array. */
export const commandArgvOf = (command: string): unknown => {
  if (!command.startsWith("[")) return ["sh", "-c", command];
  try { return JSON.parse(command) as unknown; } catch { throw new SourceError("a command starting with [ must be a JSON argv array"); }
};

/** Swaps a job's spec for `patch` applied to it, from `now` on: the slots it passed before never catch up. */
const update = (specs: SourceSpecs, name: string, now: number, patch: (spec: ScheduleSpec) => Record<string, unknown>): ScheduleSpec => {
  const spec = findSchedule(specs, name);
  return specs.replace(name, { ...patch(spec), since: now }) as ScheduleSpec;
};

/** Pauses (disables) or resumes a job; resuming counts its slots from `now`, so the ones it skipped stay skipped. */
export const setSchedulePaused = (specs: SourceSpecs, name: string, paused: boolean, now: number): ScheduleSpec => {
  const spec = findSchedule(specs, name);
  if (Boolean(spec.paused) === paused) return spec;
  if (paused) return specs.replace(name, { ...spec, paused: true }) as ScheduleSpec;
  return update(specs, name, now, ({ paused: _, ...rest }) => rest);
};

/** Gives a job a new cron expression or interval (and time zone), counted from `now`. */
export const editScheduleTiming = (specs: SourceSpecs, name: string, timing: ScheduleTiming, tz: string | undefined, now: number): ScheduleSpec =>
  update(specs, name, now, ({ cron: _cron, everySec: _every, ...rest }) => ({ ...rest, ...timing, ...(tz !== undefined ? { tz } : {}) }));

/** Every scheduled job with its next and last run, as the web app shows them. */
export const scheduledJobs = (stateDir: string, now: number): ScheduledJob[] => {
  const status = readSourceStatus(stateDir)?.sources ?? {};
  return new SourceSpecs(stateDir).list().filter((spec): spec is ScheduleSpec => spec.type === "schedule").map((spec) => {
    const entry = status[spec.name];
    const row = scheduleRow(spec, entry, now);
    return {
      name: spec.name, kind: spec.kind, cron: spec.cron ?? null, everySec: spec.everySec ?? null, tz: spec.tz,
      text: spec.text ?? null, command: spec.command ?? null, cwd: spec.cwd ?? null, machine: spec.machine ?? null,
      heavy: spec.heavy === true, catchUp: spec.catchUp, paused: spec.paused === true,
      nextRunAt: row.nextRunAt ?? null, lastRunAt: row.lastRunAt ?? null, lastResult: row.lastResult ?? null,
      waiting: row.waiting ?? null, error: entry?.failing ? (entry.lastError ?? "failing") : null,
    };
  });
};

const apply = (stateDir: string, request: ScheduleRequest, now: number): void => {
  const specs = new SourceSpecs(stateDir);
  switch (request.op) {
    case "list": return;
    case "add": {
      const { job } = request;
      specs.add({
        name: job.name, type: "schedule", kind: job.kind, since: now,
        ...("cron" in job ? { cron: job.cron } : { everySec: job.everySec }),
        ...(job.tz !== undefined ? { tz: job.tz } : {}),
        ...(job.text !== undefined ? { text: job.text } : {}),
        ...(job.command !== undefined ? { command: commandArgvOf(job.command) } : {}),
        ...(job.cwd !== undefined ? { cwd: job.cwd } : {}),
        ...(job.catchUp !== undefined ? { catchUp: job.catchUp } : {}),
      });
      return;
    }
    case "remove": findSchedule(specs, request.name); specs.remove(request.name); return;
    case "run-now": findSchedule(specs, request.name); queueRunNow(stateDir, request.name, now); return;
    case "pause": setSchedulePaused(specs, request.name, true, now); return;
    case "resume": setSchedulePaused(specs, request.name, false, now); return;
    case "edit": editScheduleTiming(specs, request.name, request.timing, request.tz, now); return;
  }
};

/** Applies one request from the web app and answers with every job; a refused one answers why and changes nothing. */
export const handleScheduleRequest = (stateDir: string, request: ScheduleRequest, now: number): ScheduleReply => {
  try {
    apply(stateDir, request, now);
    return { ok: true, jobs: scheduledJobs(stateDir, now) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};
