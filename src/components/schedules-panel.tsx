import { useState, type FormEvent } from "react";
import { useI18n, useMessages, type Locale } from "@/lib/i18n";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import {
  describeRecurrence,
  describeSchedule,
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
import { formatFull, formatWhen } from "@/lib/timeline";
import type { Messages } from "@/locales/en";
import { useSupervisorNotice } from "@/web/host-status";
import { useChangeSchedule, useScheduledJobs } from "@/web/supervisor-schedules";

const seconds = (ms: number): number => Math.floor(ms / 1000);

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
  locale,
}: {
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
  zone: ScheduleTimeZone;
  locale: Locale;
}) {
  const m = useMessages();
  const t = m.settings.schedules;
  const recurrence = draft.recurrence;
  const set = (next: Recurrence) => onChange({ ...draft, recurrence: next });
  return (
    <div className="flex flex-col gap-2">
      {!draft.advanced && (
        <>
          <Selector
            size="sm"
            label={t.repeats}
            options={(["daily", "weekly", "hourly", "monthly"] as const).map((kind) => ({ value: kind, label: t.kinds[kind] }))}
            value={recurrence.kind}
            onChange={(value) => set(withKind(recurrence, value as Recurrence["kind"]))}
          />
          {recurrence.kind === "weekly" && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium">{t.weekdays}</legend>
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {WEEK_ORDER.map((day) => (
                  <CheckboxInput
                    key={day}
                    size="sm"
                    label={weekdayName(day, locale)}
                    value={recurrence.days.includes(day)}
                    onChange={(checked) =>
                      set({ ...recurrence, days: checked ? [...recurrence.days, day].sort((a, b) => a - b) : recurrence.days.filter((d) => d !== day) })
                    }
                  />
                ))}
              </span>
              {recurrence.days.length === 0 && <span className="text-xs text-destructive">{t.pickDay}</span>}
            </fieldset>
          )}
          {recurrence.kind === "monthly" && (
            <Selector
              size="sm"
              label={t.day}
              options={DAYS.map((day) => ({ value: String(day), label: t.dayLabel(day) }))}
              value={String(recurrence.day)}
              onChange={(value) => set({ ...recurrence, day: Number(value) })}
            />
          )}
          <span className="flex flex-wrap gap-2">
            {recurrence.kind !== "hourly" && (
              <Selector
                size="sm"
                width={128}
                label={t.hour}
                options={HOURS.map((hour) => ({ value: String(hour), label: t.hourLabel(hour % 12 || 12, hour < 12 ? t.am : t.pm) }))}
                value={String(recurrence.hour)}
                onChange={(value) => set({ ...recurrence, hour: Number(value) })}
              />
            )}
            <Selector
              size="sm"
              width={112}
              label={t.minute}
              options={minutes(recurrence.minute).map((minute) => ({ value: String(minute), label: t.minuteLabel(minute) }))}
              value={String(recurrence.minute)}
              onChange={(value) => set({ ...recurrence, minute: Number(value) })}
            />
          </span>
          <p role="note" className="text-xs text-muted-foreground">
            {describeRecurrence(recurrence, zone, locale)}
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
        <summary className="cursor-pointer text-xs text-muted-foreground">{t.advanced}</summary>
        {draft.advanced && (
          <div className="mt-2 flex flex-col gap-2">
            <TextInput size="sm" label={t.raw} hasSpellCheck={false} value={draft.raw} onChange={(raw) => onChange({ ...draft, raw })} />
            <TextInput size="sm" label={t.timeZone} hasSpellCheck={false} value={draft.tz} onChange={(tz) => onChange({ ...draft, tz })} />
          </div>
        )}
      </details>
    </div>
  );
}

function actionLabel(job: ScheduledJob, t: Messages["settings"]["schedules"]): string {
  if (job.command !== null) {
    const line = job.command[0] === "sh" && job.command[1] === "-c" && job.command.length === 3 ? job.command[2]! : JSON.stringify(job.command);
    return job.machine === null ? line : t.onMachine(line, job.machine);
  }
  return `${job.kind} ${job.text ?? ""}`;
}

function Moment({ ms }: { ms: number }) {
  const { locale, m } = useI18n();
  const at = seconds(ms);
  return (
    <span title={formatFull(at, locale)}>
      {formatFull(at, locale)} (<time dateTime={new Date(at * 1000).toISOString()} title={formatFull(at, locale)}>{formatWhen(at, undefined, locale, m)}</time>)
    </span>
  );
}

function EditJob({
  job,
  zone,
  locale,
  busy,
  onSave,
  onCancel,
}: {
  job: ScheduledJob;
  zone: ScheduleTimeZone;
  locale: Locale;
  busy: boolean;
  onSave: (request: ScheduleRequest) => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  const t = m.settings.schedules;
  const [draft, setDraft] = useState(() => draftOf(job, zone));
  const [description, setDescription] = useState(job.description ?? "");
  const saved = draftTiming(draft, zone);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (saved !== null) onSave({ op: "edit", name: job.name, timing: saved.timing, tz: saved.tz, description: description.trim() });
  }
  return (
    <form aria-label={t.editJob(job.name)} className="flex flex-col gap-2 rounded-md border p-2" onSubmit={submit}>
      <TextInput size="sm" label={t.description} description={t.descriptionHint} value={description} onChange={setDescription} />
      <ScheduleFields draft={draft} onChange={setDraft} zone={zone} locale={locale} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{job.command !== null ? t.command : t.event}</dt>
        <dd className="font-mono break-all">{actionLabel(job, t)}</dd>
        <dt className="text-muted-foreground">{t.eventKind}</dt>
        <dd className="font-mono break-all">{job.kind}</dd>
      </dl>
      <div className="flex gap-1">
        <Button changesData size="sm" variant="primary" type="submit" label={busy ? t.saving : m.common.save} isDisabled={busy || saved === null} />
        <Button size="sm" variant="ghost" label={m.common.cancel} onClick={onCancel} isDisabled={busy} />
      </div>
    </form>
  );
}

function Job({
  job,
  zone,
  locale,
  busy,
  change,
}: {
  job: ScheduledJob;
  zone: ScheduleTimeZone;
  locale: Locale;
  busy: boolean;
  change: (request: ScheduleRequest, done?: () => void) => void;
}) {
  const m = useMessages();
  const t = m.settings.schedules;
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const when = describeSchedule(job, zone, locale);
  return (
    <li aria-label={t.job(job.name)} className="flex flex-col gap-1.5 py-2 first:pt-0">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium break-all">{job.name}</span>
        <span className={when.raw ? "font-mono text-xs text-muted-foreground" : "text-muted-foreground"}>{when.text}</span>
        {job.paused && <span className="rounded bg-muted px-1.5 text-xs font-medium">{t.paused}</span>}
      </span>
      {job.description !== null ? (
        <span className="break-words">{job.description}</span>
      ) : (
        <span className="font-mono text-xs break-all text-muted-foreground">{job.kind}</span>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{t.nextRun}</dt>
        <dd>
          {job.paused ? t.paused : job.waiting !== null ? t.waiting(job.waiting) : job.nextRunAt !== null ? <Moment ms={job.nextRunAt} /> : t.none}
        </dd>
        <dt className="text-muted-foreground">{t.lastRun}</dt>
        <dd>{job.lastRunAt !== null ? <Moment ms={job.lastRunAt} /> : t.never}</dd>
        <dt className="text-muted-foreground">{t.result}</dt>
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
          locale={locale}
          busy={busy}
          onSave={(request) => change(request, () => setEditing(false))}
          onCancel={() => setEditing(false)}
        />
      ) : removing ? (
        <div role="alertdialog" aria-label={t.confirmRemove(job.name)} className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2">
          <p className="text-xs">{t.removePrompt(job.name)}</p>
          <div className="flex gap-1">
            <Button changesData size="sm" variant="destructive" label={t.removeJob} isDisabled={busy} onClick={() => change({ op: "remove", name: job.name })} />
            <Button size="sm" variant="ghost" label={m.common.cancel} onClick={() => setRemoving(false)} isDisabled={busy} />
          </div>
        </div>
      ) : (
        <span className="flex flex-wrap gap-1">
          <Button changesData size="sm" variant="secondary" label={t.runJob(job.name)} isDisabled={busy} onClick={() => change({ op: "run-now", name: job.name })}>
            {t.runNow}
          </Button>
          <Button
            changesData
            size="sm"
            variant="secondary"
            label={job.paused ? t.resumeJob(job.name) : t.pauseJob(job.name)}
            isDisabled={busy}
            onClick={() => change({ op: job.paused ? "resume" : "pause", name: job.name })}
          >
            {job.paused ? t.resume : t.pause}
          </Button>
          <Button size="sm" variant="secondary" label={t.editJob(job.name)} isDisabled={busy} onClick={() => setEditing(true)}>
            {m.common.edit}
          </Button>
          <Button size="sm" variant="ghost" label={t.removeNamed(job.name)} isDisabled={busy} onClick={() => setRemoving(true)}>
            {t.remove}
          </Button>
        </span>
      )}
    </li>
  );
}

type Action = "text" | "command";

/**
 * The event kind a job sends when none is typed, made from its name (`gmail-digest` sends
 * `GMAIL_DIGEST`) in the shape Dori accepts: a capital letter, then capitals, digits, or underscores.
 */
export function kindFromName(name: string): string {
  const kind = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (kind === "") return "";
  return (/^[A-Z]/.test(kind) ? kind : `JOB_${kind}`).slice(0, 41);
}

function AddJob({
  zone,
  locale,
  busy,
  onAdd,
  onCancel,
}: {
  zone: ScheduleTimeZone;
  locale: Locale;
  busy: boolean;
  onAdd: (job: NewScheduledJob) => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  const t = m.settings.schedules;
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(() => draftOf(undefined, zone));
  const [action, setAction] = useState<Action>("text");
  const [body, setBody] = useState("");
  const [cwd, setCwd] = useState("");
  const [catchUp, setCatchUp] = useState<ScheduleCatchUp>("once");
  const saved = draftTiming(draft, zone);
  const eventKind = kind.trim() || kindFromName(name);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (saved === null) return;
    onAdd({
      ...saved.timing,
      tz: saved.tz,
      name: name.trim(),
      kind: eventKind,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(action === "text" ? { text: body } : { command: body, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }),
      catchUp,
    });
  }
  return (
    <form aria-label={t.addForm} className="flex flex-col gap-2 rounded-md border p-3" onSubmit={submit}>
      <TextInput size="sm" label={t.name} description={t.nameHint} hasSpellCheck={false} value={name} onChange={setName} hasAutoFocus />
      <TextInput size="sm" label={t.description} description={t.descriptionHint} value={description} onChange={setDescription} />
      <ScheduleFields draft={draft} onChange={setDraft} zone={zone} locale={locale} />
      {action === "text" && <TextInput size="sm" label={t.eventText} description={t.eventTextHint} value={body} onChange={setBody} />}
      {/* The event's kind and running a command on the host are for whoever runs Dori. */}
      <details>
        <summary className="cursor-pointer text-muted-foreground">{t.moreOptions}</summary>
        <div className="flex flex-col gap-2 pt-2">
          <TextInput
            size="sm"
            label={t.eventKind}
            description={t.eventKindHint}
            placeholder={kindFromName(name)}
            hasSpellCheck={false}
            value={kind}
            onChange={setKind}
          />
          <Selector
            size="sm"
            label={t.action}
            options={[
              { value: "text", label: t.sendEvent },
              { value: "command", label: t.runCommand },
            ]}
            value={action}
            onChange={(value) => setAction(value as Action)}
          />
          {action === "command" && (
            <>
              <TextInput size="sm" label={t.command} description={t.commandHint} hasSpellCheck={false} value={body} onChange={setBody} />
              <TextInput size="sm" label={t.directory} description={t.directoryHint} hasSpellCheck={false} value={cwd} onChange={setCwd} />
            </>
          )}
        </div>
      </details>
      <Selector
        size="sm"
        label={t.missed}
        description={t.missedHint}
        options={[
          { value: "once", label: t.runLatest },
          { value: "skip", label: t.skip },
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
          label={busy ? t.adding : t.addJob}
          isDisabled={busy || !name.trim() || !eventKind || saved === null || !body.trim()}
        />
        <Button size="sm" variant="ghost" label={m.common.cancel} onClick={onCancel} isDisabled={busy} />
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
  const { locale, m } = useI18n();
  const t = m.settings.schedules;
  const jobs = useScheduledJobs(active);
  const mutation = useChangeSchedule();
  const down = useSupervisorNotice(active);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function change(request: ScheduleRequest, done?: () => void) {
    setNotice(null);
    mutation.mutate(request, {
      onSuccess: () => {
        done?.();
        if (request.op === "run-now") setNotice(t.queued(request.name));
      },
    });
  }

  // `down` says why the supervisor cannot list the jobs, so its refusal is not repeated.
  const error = mutation.error ?? (down === null ? jobs.error : null);
  const data = jobs.data;
  return (
    <section aria-label={t.title} className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">{t.intro}</p>
      {notice !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {down !== null && (
        <p role="alert" className="break-words text-destructive">
          {down}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs break-words text-destructive">
          {error.message}
        </p>
      )}
      {data === undefined ? (
        down === null && !jobs.error && <p className="text-muted-foreground">{t.loading}</p>
      ) : data.jobs.length === 0 ? (
        <p className="text-muted-foreground">{t.empty}</p>
      ) : (
        <ul aria-label={t.list} className="flex flex-col divide-y">
          {data.jobs.map((job) => (
            <Job key={job.name} job={job} zone={data.timeZone} locale={locale} busy={mutation.isPending} change={change} />
          ))}
        </ul>
      )}
      {data !== undefined &&
        (adding ? (
          <AddJob
            zone={data.timeZone}
            locale={locale}
            busy={mutation.isPending}
            onAdd={(job) => change({ op: "add", job }, () => setAdding(false))}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <div>
            <Button size="sm" variant="secondary" label={t.addButton} onClick={() => setAdding(true)} />
          </div>
        ))}
    </section>
  );
}
