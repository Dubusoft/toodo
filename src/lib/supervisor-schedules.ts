// The scheduled jobs panel: the Dori supervisor's scheduled jobs (`dori schedule`) as the web
// app lists and changes them. The web app calls the core (`GET` and `POST
// /api/supervisor/schedules`), the core hands each request to the host, and the host to the
// supervisor Worker, which applies it to its own sources.json and answers with every job.
// The supervisor reads sources.json on each pass, so a change takes effect without a restart.
// Types only: the server, the host, the web app, and the supervisor in `dori/` all import this file.

export type ScheduleCatchUp = "once" | "skip";

/** When a job runs: a 5-field cron expression (or `@daily` and the like) in `tz`, or every N seconds. */
export type ScheduleTiming = { readonly cron: string } | { readonly everySec: number };

/** One scheduled job as the panel shows it. */
export type ScheduledJob = {
  readonly name: string;
  /** The event kind the job emits. */
  readonly kind: string;
  /** What the job does and why, in the owner's words; `null` when it has none. */
  readonly description: string | null;
  readonly cron: string | null;
  readonly everySec: number | null;
  /** The time zone the cron expression is read in. */
  readonly tz: string;
  /** The event text an emit job sends; `null` for a command job. */
  readonly text: string | null;
  /** The argv a command job runs; `null` for an emit job. */
  readonly command: readonly string[] | null;
  readonly cwd: string | null;
  /** The runner that runs the command; `null` for the supervisor host. */
  readonly machine: string | null;
  readonly heavy: boolean;
  readonly catchUp: ScheduleCatchUp;
  /** Disabled: no slot runs until it is resumed. */
  readonly paused: boolean;
  /** Epoch milliseconds of the next slot; `null` while paused or when none is coming. */
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  /** The last run's result (`ok`, `emitted`, `failed exit 2`, `skipped 1 missed`, ...). */
  readonly lastResult: string | null;
  /** What a due run waits for (a heavy slot, an offline runner). */
  readonly waiting: string | null;
  /** The job's last error while it is failing. */
  readonly error: string | null;
};

/** A job to add. `command` is a shell line (run with `sh -c`) or a JSON argv array starting with `[`. */
export type NewScheduledJob = ScheduleTiming & {
  readonly name: string;
  readonly kind: string;
  readonly description?: string;
  readonly tz?: string;
  readonly text?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly catchUp?: ScheduleCatchUp;
};

/**
 * A change to a job: a new timing (counted from the change, with `tz` for its cron expression), a new description (an
 * empty one removes it), or both. A description alone leaves the schedule as it was.
 */
export type ScheduleEdit =
  | { readonly timing: ScheduleTiming; readonly tz?: string; readonly description?: string }
  | { readonly timing?: undefined; readonly description: string };

export type ScheduleRequest =
  | { readonly op: "list" }
  | { readonly op: "add"; readonly job: NewScheduledJob }
  | { readonly op: "remove"; readonly name: string }
  | { readonly op: "run-now"; readonly name: string }
  | { readonly op: "pause"; readonly name: string }
  | { readonly op: "resume"; readonly name: string }
  | ({ readonly op: "edit"; readonly name: string } & ScheduleEdit);

/** Dori's `displayTimeZone`, in which the panel shows and picks times, with its label ("KST"). */
export type ScheduleTimeZone = { readonly name: string; readonly label: string };

/** Every job after the request, or why it was refused. */
export type ScheduleReply =
  | { readonly ok: true; readonly jobs: readonly ScheduledJob[]; readonly timeZone: ScheduleTimeZone }
  | { readonly ok: false; readonly error: string };

export const SCHEDULE_OPS = ["list", "add", "remove", "run-now", "pause", "resume", "edit"] as const satisfies readonly ScheduleRequest["op"][];
