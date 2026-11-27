import { useState, type FormEvent } from "react";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { When } from "@/components/when";
import {
  browserLanguage,
  describeRecurrence,
  describeSchedule,
  type Language,
  parseRecurrence,
  type Recurrence,
  recurrenceCron,
  WEEK_ORDER,
  weekdayName,
} from "@/lib/schedule-recurrence";
import type {
  NewScheduledJob,
  ScheduleCatchUp,
  ScheduledJob,
  ScheduleRequest,
  ScheduleTiming,
  ScheduleTimeZone,
} from "@/lib/supervisor-schedules";
import { formatFull } from "@/lib/timeline";
import { useChangeSchedule, useScheduledJobs } from "@/web/supervisor-schedules";

const seconds = (ms: number): number => Math.floor(ms / 1000);

const TEXT = {
  ko: {
    repeats: "반복",
    kinds: { daily: "매일", weekly: "매주", hourly: "매시간", monthly: "매월" },
    weekdays: "요일",
    day: "날짜",
    hour: "시",
    minute: "분",
    pickDay: "요일을 하나 이상 고르세요.",
    advanced: "고급: cron 식 직접 입력",
    raw: "cron 식(분 시 일 월 요일) 또는 실행 간격(초)",
    timeZone: "시간대",
    hourLabel: (hour: number) => `${hour < 12 ? "오전" : "오후"} ${hour % 12 || 12}시`,
    minuteLabel: (minute: number) => `${minute}분`,
    dayLabel: (day: number) => `${day}일`,
  },
  en: {
    repeats: "Repeats",
    kinds: { daily: "Every day", weekly: "Every week", hourly: "Every hour", monthly: "Every month" },
    weekdays: "Days",
    day: "Day of the month",
    hour: "Hour",
    minute: "Minute",
    pickDay: "Pick at least one day.",
    advanced: "Advanced: enter a cron expression",
    raw: "A cron expression (minute hour day month weekday) or seconds between runs",
    timeZone: "Time zone",
    hourLabel: (hour: number) => `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`,
    minuteLabel: (minute: number) => `:${String(minute).padStart(2, "0")}`,
    dayLabel: (day: number) => String(day),
  },
} as const;

type ScheduleDraft = { readonly advanced: boolean; readonly recurrence: Recurrence; readonly raw: string; readonly tz: string };

const DEFAULT_HOUR = 9;
const DEFAULT_RECURRENCE: Recurrence = { kind: "daily", hour: DEFAULT_HOUR, minute: 0 };

/** A job's schedule in the form: the pickers when they can show it, else Advanced, open. */
function draftOf(job: ScheduledJob | undefined, zone: ScheduleTimeZone): ScheduleDraft {
  if (job === undefined) return { advanced: false, recurrence: DEFAULT_RECURRENCE, raw: "", tz: zone.name };
  const recurrence = job.cron !== null && job.tz === zone.name ? parseRecurrence(job.cron) : null;
  return {
    advanced: recurrence === null,
    recurrence: recurrence ?? DEFAULT_RECURRENCE,
    raw: job.cron ?? String(job.everySec ?? ""),
    tz: job.tz,
  };
}

/** What the form saves: the pickers as cron in the display time zone, or Advanced as typed; `null` until it is complete. */
function draftTiming(draft: ScheduleDraft, zone: ScheduleTimeZone): { timing: ScheduleTiming; tz: string } | null {
  if (draft.advanced) {
    const raw = draft.raw.trim();
    if (!raw) return null;
    return { timing: /^\d+$/.test(raw) ? { everySec: Number(raw) } : { cron: raw }, tz: draft.tz.trim() || zone.name };
  }
  if (draft.recurrence.kind === "weekly" && draft.recurrence.days.length === 0) return null;
  return { timing: { cron: recurrenceCron(draft.recurrence) }, tz: zone.name };
}

/** Switches the repeat, keeping the time and the days or day already picked. */
function withKind(recurrence: Recurrence, kind: Recurrence["kind"]): Recurrence {
  const hour = recurrence.kind === "hourly" ? DEFAULT_HOUR : recurrence.hour;
  const { minute } = recurrence;
  switch (kind) {
    case "hourly":
      return { kind, minute };
    case "daily":
      return { kind, hour, minute };
    case "weekly":
      return { kind, days: recurrence.kind === "weekly" ? recurrence.days : [1], hour, minute };
    case "monthly":
      return { kind, day: recurrence.kind === "monthly" ? recurrence.day : 1, hour, minute };
  }
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
/** Every five minutes, plus a minute a job already runs at. */
function minutes(current: number): number[] {
  const steps = Array.from({ length: 12 }, (_, index) => index * 5);
  return steps.includes(current) ? steps : [...steps, current].sort((a, b) => a - b);
}

function ScheduleFields({
  draft,
  onChange,
  zone,
  language,
}: {
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
  zone: ScheduleTimeZone;
  language: Language;
}) {
  const text = TEXT[language];
  const recurrence = draft.recurrence;
  const set = (next: Recurrence) => onChange({ ...draft, recurrence: next });
  return (
    <div className="flex flex-col gap-2">
      {!draft.advanced && (
        <>
          <Selector
            size="sm"
            label={text.repeats}
            options={(["daily", "weekly", "hourly", "monthly"] as const).map((kind) => ({ value: kind, label: text.kinds[kind] }))}
            value={recurrence.kind}
            onChange={(value) => set(withKind(recurrence, value as Recurrence["kind"]))}
          />
          {recurrence.kind === "weekly" && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium">{text.weekdays}</legend>
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {WEEK_ORDER.map((day) => (
                  <CheckboxInput
                    key={day}
                    size="sm"
                    label={weekdayName(day, language)}
                    value={recurrence.days.includes(day)}
                    onChange={(checked) =>
                      set({ ...recurrence, days: checked ? [...recurrence.days, day].sort((a, b) => a - b) : recurrence.days.filter((d) => d !== day) })
                    }
                  />
                ))}
              </span>
              {recurrence.days.length === 0 && <span className="text-xs text-destructive">{text.pickDay}</span>}
            </fieldset>
          )}
          {recurrence.kind === "monthly" && (
            <Selector
              size="sm"
              label={text.day}
              options={DAYS.map((day) => ({ value: String(day), label: text.dayLabel(day) }))}
              value={String(recurrence.day)}
              onChange={(value) => set({ ...recurrence, day: Number(value) })}
            />
          )}
          <span className="flex flex-wrap gap-2">
            {recurrence.kind !== "hourly" && (
              <Selector
                size="sm"
                width={128}
                label={text.hour}
                options={HOURS.map((hour) => ({ value: String(hour), label: text.hourLabel(hour) }))}
                value={String(recurrence.hour)}
                onChange={(value) => set({ ...recurrence, hour: Number(value) })}
              />
            )}
            <Selector
              size="sm"
              width={112}
              label={text.minute}
              options={minutes(recurrence.minute).map((minute) => ({ value: String(minute), label: text.minuteLabel(minute) }))}
              value={String(recurrence.minute)}
              onChange={(value) => set({ ...recurrence, minute: Number(value) })}
            />
          </span>
          <p role="note" className="text-xs text-muted-foreground">
            {describeRecurrence(recurrence, zone, language)}
          </p>
        </>
      )}
      <details
        open={draft.advanced}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          if (open !== draft.advanced) onChange({ ...draft, advanced: open });
        }}
      >
        <summary className="cursor-pointer text-xs text-muted-foreground">{text.advanced}</summary>
        {draft.advanced && (
          <div className="mt-2 flex flex-col gap-2">
            <TextInput size="sm" label={text.raw} hasSpellCheck={false} value={draft.raw} onChange={(raw) => onChange({ ...draft, raw })} />
            <TextInput size="sm" label={text.timeZone} hasSpellCheck={false} value={draft.tz} onChange={(tz) => onChange({ ...draft, tz })} />
          </div>
        )}
      </details>
    </div>
  );
}

const DESCRIPTION_HINT = "What the job does and why, e.g. Gmail digest posted to #daily-reports (optional)";

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

function EditJob({
  job,
  zone,
  language,
  busy,
  onSave,
  onCancel,
}: {
  job: ScheduledJob;
  zone: ScheduleTimeZone;
  language: Language;
  busy: boolean;
  onSave: (request: ScheduleRequest) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(job, zone));
  const [description, setDescription] = useState(job.description ?? "");
  const saved = draftTiming(draft, zone);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (saved !== null) onSave({ op: "edit", name: job.name, timing: saved.timing, tz: saved.tz, description: description.trim() });
  }
  return (
    <form aria-label={`Edit ${job.name}`} className="flex flex-col gap-2 rounded-md border p-2" onSubmit={submit}>
      <TextInput size="sm" label="Description" description={DESCRIPTION_HINT} value={description} onChange={setDescription} />
      <ScheduleFields draft={draft} onChange={setDraft} zone={zone} language={language} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{job.command !== null ? "Command" : "Event"}</dt>
        <dd className="font-mono break-all">{actionLabel(job)}</dd>
        <dt className="text-muted-foreground">Event kind</dt>
        <dd className="font-mono break-all">{job.kind}</dd>
      </dl>
      <div className="flex gap-1">
        <Button changesData size="sm" variant="primary" type="submit" label={busy ? "Saving..." : "Save"} isDisabled={busy || saved === null} />
        <Button size="sm" variant="ghost" label="Cancel" onClick={onCancel} isDisabled={busy} />
      </div>
    </form>
  );
}

function Job({
  job,
  zone,
  language,
  busy,
  change,
}: {
  job: ScheduledJob;
  zone: ScheduleTimeZone;
  language: Language;
  busy: boolean;
  change: (request: ScheduleRequest, done?: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const when = describeSchedule(job, zone, language);
  return (
    <li aria-label={`Scheduled job ${job.name}`} className="flex flex-col gap-1.5 py-2 first:pt-0">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium break-all">{job.name}</span>
        <span className={when.raw ? "font-mono text-xs text-muted-foreground" : "text-muted-foreground"}>{when.text}</span>
        {job.paused && <span className="rounded bg-muted px-1.5 text-xs font-medium">Paused</span>}
      </span>
      {job.description !== null ? (
        <span className="break-words">{job.description}</span>
      ) : (
        <span className="font-mono text-xs break-all text-muted-foreground">{job.kind}</span>
      )}
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
        <EditJob
          job={job}
          zone={zone}
          language={language}
          busy={busy}
          onSave={(request) => change(request, () => setEditing(false))}
          onCancel={() => setEditing(false)}
        />
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
          <Button size="sm" variant="secondary" label={`Edit ${job.name}`} isDisabled={busy} onClick={() => setEditing(true)}>
            Edit
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

function AddJob({
  zone,
  language,
  busy,
  onAdd,
  onCancel,
}: {
  zone: ScheduleTimeZone;
  language: Language;
  busy: boolean;
  onAdd: (job: NewScheduledJob) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(() => draftOf(undefined, zone));
  const [action, setAction] = useState<Action>("command");
  const [body, setBody] = useState("");
  const [cwd, setCwd] = useState("");
  const [catchUp, setCatchUp] = useState<ScheduleCatchUp>("once");
  const saved = draftTiming(draft, zone);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (saved === null) return;
    onAdd({
      ...saved.timing,
      tz: saved.tz,
      name: name.trim(),
      kind: kind.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(action === "text" ? { text: body } : { command: body, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }),
      catchUp,
    });
  }
  return (
    <form aria-label="Add a scheduled job" className="flex flex-col gap-2 rounded-md border p-3" onSubmit={submit}>
      <TextInput size="sm" label="Name" description="Lowercase letters, digits, dots, underscores or hyphens" hasSpellCheck={false} value={name} onChange={setName} hasAutoFocus />
      <TextInput size="sm" label="Event kind" description="The event the job sends Dori, in capitals, e.g. GMAIL_DIGEST" hasSpellCheck={false} value={kind} onChange={setKind} />
      <TextInput size="sm" label="Description" description={DESCRIPTION_HINT} value={description} onChange={setDescription} />
      <ScheduleFields draft={draft} onChange={setDraft} zone={zone} language={language} />
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
          isDisabled={busy || !name.trim() || !kind.trim() || saved === null || !body.trim()}
        />
        <Button size="sm" variant="ghost" label="Cancel" onClick={onCancel} isDisabled={busy} />
      </div>
    </form>
  );
}

/**
 * The Dori supervisor's scheduled jobs (`dori schedule`): each with its schedule, next and
 * last run and result, and the changes the owner makes here instead of on the host. The
 * supervisor applies a change on its next pass, without a restart. Schedules read and are
 * picked in Dori's display time zone; a cron expression the pickers cannot show is edited
 * as it is, under Advanced.
 */
export function SchedulesPanel({ active }: { active: boolean }) {
  const jobs = useScheduledJobs(active);
  const mutation = useChangeSchedule();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const language = browserLanguage();

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
  const data = jobs.data;
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
      {data === undefined ? (
        !jobs.error && <p className="text-muted-foreground">Loading the scheduled jobs...</p>
      ) : data.jobs.length === 0 ? (
        <p className="text-muted-foreground">No scheduled job.</p>
      ) : (
        <ul aria-label="Scheduled jobs list" className="flex flex-col divide-y">
          {data.jobs.map((job) => (
            <Job key={job.name} job={job} zone={data.timeZone} language={language} busy={mutation.isPending} change={change} />
          ))}
        </ul>
      )}
      {data !== undefined &&
        (adding ? (
          <AddJob
            zone={data.timeZone}
            language={language}
            busy={mutation.isPending}
            onAdd={(job) => change({ op: "add", job }, () => setAdding(false))}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <div>
            <Button size="sm" variant="secondary" label="Add a job" onClick={() => setAdding(true)} />
          </div>
        ))}
    </section>
  );
}
