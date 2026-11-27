import { useState, type FormEvent } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { When } from "@/components/when";
import type { NewScheduledJob, ScheduleCatchUp, ScheduledJob, ScheduleRequest, ScheduleTiming } from "@/lib/supervisor-schedules";
import { formatFull } from "@/lib/timeline";
import { useChangeSchedule, useScheduledJobs } from "@/web/supervisor-schedules";

const DEFAULT_TZ = "Asia/Seoul";

const seconds = (ms: number): number => Math.floor(ms / 1000);

/** A schedule field: whole seconds run every N seconds, anything else is a cron expression. */
function timingOf(text: string): ScheduleTiming {
  const value = text.trim();
  return /^\d+$/.test(value) ? { everySec: Number(value) } : { cron: value };
}

function timingText(job: ScheduledJob): string {
  return job.cron ?? String(job.everySec ?? "");
}

function whenLabel(job: ScheduledJob): string {
  return job.cron !== null ? `${job.cron} (${job.tz})` : `every ${job.everySec} s`;
}

function actionLabel(job: ScheduledJob): string {
  if (job.command !== null) {
    const line = job.command[0] === "sh" && job.command[1] === "-c" && job.command.length === 3 ? job.command[2]! : JSON.stringify(job.command);
    return `${line}${job.machine !== null ? ` on ${job.machine}` : ""}`;
  }
  return `${job.kind} ${job.text ?? ""}`;
}

function Moment({ ms }: { ms: number }) {
  return (
    <span title={formatFull(seconds(ms))}>
      {formatFull(seconds(ms))} (<When at={seconds(ms)} />)
    </span>
  );
}

function EditTiming({ job, busy, onSave, onCancel }: { job: ScheduledJob; busy: boolean; onSave: (request: ScheduleRequest) => void; onCancel: () => void }) {
  const [timing, setTiming] = useState(timingText(job));
  const [tz, setTz] = useState(job.tz);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({ op: "edit", name: job.name, timing: timingOf(timing), ...(tz.trim() && tz.trim() !== job.tz ? { tz: tz.trim() } : {}) });
  }
  return (
    <form aria-label={`Edit the schedule of ${job.name}`} className="flex flex-col gap-2 rounded-md border p-2" onSubmit={submit}>
      <TextInput
        size="sm"
        label="Schedule"
        description="A cron expression (minute hour day month weekday, e.g. 0 6 * * *) or a number of seconds between runs"
        hasSpellCheck={false}
        value={timing}
        onChange={setTiming}
        hasAutoFocus
      />
      <TextInput size="sm" label="Time zone" hasSpellCheck={false} value={tz} onChange={setTz} />
      <div className="flex gap-1">
        <Button changesData size="sm" variant="primary" type="submit" label={busy ? "Saving..." : "Save schedule"} isDisabled={busy || !timing.trim()} />
        <Button size="sm" variant="ghost" label="Cancel" onClick={onCancel} isDisabled={busy} />
      </div>
    </form>
  );
}

function Job({ job, busy, change }: { job: ScheduledJob; busy: boolean; change: (request: ScheduleRequest, done?: () => void) => void }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <li aria-label={`Scheduled job ${job.name}`} className="flex flex-col gap-1.5 py-2 first:pt-0">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium break-all">{job.name}</span>
        <span className="text-muted-foreground">{whenLabel(job)}</span>
        {job.paused && <span className="rounded bg-muted px-1.5 text-xs font-medium">Paused</span>}
      </span>
      <span className="font-mono text-xs break-all text-muted-foreground">{actionLabel(job)}</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Next run</dt>
        <dd>
          {job.paused ? "Paused" : job.waiting !== null ? `Waiting for a ${job.waiting}` : job.nextRunAt !== null ? <Moment ms={job.nextRunAt} /> : "None"}
        </dd>
        <dt className="text-muted-foreground">Last run</dt>
        <dd>{job.lastRunAt !== null ? <Moment ms={job.lastRunAt} /> : "Never"}</dd>
        <dt className="text-muted-foreground">Result</dt>
        <dd className={job.lastResult?.startsWith("failed") ? "text-destructive" : undefined}>{job.lastResult ?? "-"}</dd>
      </dl>
      {job.error !== null && (
        <p role="alert" className="text-xs break-words text-destructive">
          {job.error}
        </p>
      )}
      {editing ? (
        <EditTiming job={job} busy={busy} onSave={(request) => change(request, () => setEditing(false))} onCancel={() => setEditing(false)} />
      ) : removing ? (
        <div role="alertdialog" aria-label={`Confirm removing ${job.name}`} className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2">
          <p className="text-xs">Remove {job.name}? It stops running; add it again to bring it back.</p>
          <div className="flex gap-1">
            <Button changesData size="sm" variant="destructive" label="Remove job" isDisabled={busy} onClick={() => change({ op: "remove", name: job.name })} />
            <Button size="sm" variant="ghost" label="Cancel" onClick={() => setRemoving(false)} isDisabled={busy} />
          </div>
        </div>
      ) : (
        <span className="flex flex-wrap gap-1">
          <Button changesData size="sm" variant="secondary" label={`Run ${job.name} now`} isDisabled={busy} onClick={() => change({ op: "run-now", name: job.name })}>
            Run now
          </Button>
          <Button
            changesData
            size="sm"
            variant="secondary"
            label={`${job.paused ? "Resume" : "Pause"} ${job.name}`}
            isDisabled={busy}
            onClick={() => change({ op: job.paused ? "resume" : "pause", name: job.name })}
          >
            {job.paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="secondary" label={`Edit the schedule of ${job.name}`} isDisabled={busy} onClick={() => setEditing(true)}>
            Edit schedule
          </Button>
          <Button size="sm" variant="ghost" label={`Remove ${job.name}`} isDisabled={busy} onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </span>
      )}
    </li>
  );
}

type Action = "text" | "command";

function AddJob({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (job: NewScheduledJob) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [timing, setTiming] = useState("");
  const [tz, setTz] = useState(DEFAULT_TZ);
  const [action, setAction] = useState<Action>("command");
  const [body, setBody] = useState("");
  const [cwd, setCwd] = useState("");
  const [catchUp, setCatchUp] = useState<ScheduleCatchUp>("once");
  function submit(event: FormEvent) {
    event.preventDefault();
    onAdd({
      ...timingOf(timing),
      name: name.trim(),
      kind: kind.trim(),
      ...(tz.trim() ? { tz: tz.trim() } : {}),
      ...(action === "text" ? { text: body } : { command: body, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }),
      catchUp,
    });
  }
  return (
    <form aria-label="Add a scheduled job" className="flex flex-col gap-2 rounded-md border p-3" onSubmit={submit}>
      <TextInput size="sm" label="Name" description="Lowercase letters, digits, dots, underscores or hyphens" hasSpellCheck={false} value={name} onChange={setName} hasAutoFocus />
      <TextInput size="sm" label="Event kind" description="The event the job sends Dori, in capitals, e.g. GMAIL_DIGEST" hasSpellCheck={false} value={kind} onChange={setKind} />
      <TextInput
        size="sm"
        label="Schedule"
        description="A cron expression (minute hour day month weekday, e.g. 0 6 * * *) or a number of seconds between runs"
        hasSpellCheck={false}
        value={timing}
        onChange={setTiming}
      />
      <TextInput size="sm" label="Time zone" hasSpellCheck={false} value={tz} onChange={setTz} />
      <Selector
        size="sm"
        label="What it does"
        options={[
          { value: "command", label: "Run a command" },
          { value: "text", label: "Send an event" },
        ]}
        value={action}
        onChange={(value) => setAction(value as Action)}
      />
      {action === "command" ? (
        <>
          <TextInput size="sm" label="Command" description="A shell line, or a JSON argv array starting with [" hasSpellCheck={false} value={body} onChange={setBody} />
          <TextInput size="sm" label="Directory" description="An absolute path to run it in (optional)" hasSpellCheck={false} value={cwd} onChange={setCwd} />
        </>
      ) : (
        <TextInput size="sm" label="Event text" value={body} onChange={setBody} />
      )}
      <Selector
        size="sm"
        label="Missed runs"
        description="What happens to runs missed while the supervisor was down"
        options={[
          { value: "once", label: "Run the latest one once" },
          { value: "skip", label: "Skip them" },
        ]}
        value={catchUp}
        onChange={(value) => setCatchUp(value as ScheduleCatchUp)}
      />
      <div className="flex gap-1">
        <Button
          changesData
          size="sm"
          variant="primary"
          type="submit"
          label={busy ? "Adding..." : "Add job"}
          isDisabled={busy || !name.trim() || !kind.trim() || !timing.trim() || !body.trim()}
        />
        <Button size="sm" variant="ghost" label="Cancel" onClick={onCancel} isDisabled={busy} />
      </div>
    </form>
  );
}

/**
 * The Dori supervisor's scheduled jobs (`dori schedule`): each with its schedule, next and
 * last run and result, and the changes the owner makes here instead of on the host. The
 * supervisor applies a change on its next pass, without a restart.
 */
export function SchedulesPanel({ active }: { active: boolean }) {
  const jobs = useScheduledJobs(active);
  const mutation = useChangeSchedule();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function change(request: ScheduleRequest, done?: () => void) {
    setNotice(null);
    mutation.mutate(request, {
      onSuccess: () => {
        done?.();
        if (request.op === "run-now") setNotice(`${request.name} runs on the supervisor's next pass.`);
      },
    });
  }

  const error = mutation.error ?? jobs.error;
  return (
    <section aria-label="Scheduled jobs" className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">Jobs the Dori supervisor runs on a schedule. Changes apply on its next pass, without a restart.</p>
      {notice !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs break-words text-destructive">
          {error.message}
        </p>
      )}
      {jobs.data === undefined ? (
        !jobs.error && <p className="text-muted-foreground">Loading the scheduled jobs...</p>
      ) : jobs.data.length === 0 ? (
        <p className="text-muted-foreground">No scheduled job.</p>
      ) : (
        <ul aria-label="Scheduled jobs list" className="flex flex-col divide-y">
          {jobs.data.map((job) => (
            <Job key={job.name} job={job} busy={mutation.isPending} change={change} />
          ))}
        </ul>
      )}
      {adding ? (
        <AddJob busy={mutation.isPending} onAdd={(job) => change({ op: "add", job }, () => setAdding(false))} onCancel={() => setAdding(false)} />
      ) : (
        <div>
          <Button size="sm" variant="secondary" label="Add a job" onClick={() => setAdding(true)} isDisabled={jobs.data === undefined} />
        </div>
      )}
    </section>
  );
}
