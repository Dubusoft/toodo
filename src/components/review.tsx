import { useState } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import type { ISODateString } from "@astryxdesign/core/Calendar";
import { DateInput } from "@astryxdesign/core/DateInput";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { Selector } from "@astryxdesign/core/Selector";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import koKR from "@astryxdesign/core/locales/ko-KR.generated.js";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { Button, IconButton } from "@/components/button";
import { EmptyState } from "@/components/task-list";
import { MissingPlanMark, TaskLabels } from "@/components/task-common";
import { TaskEditForm } from "@/components/task-edit-form";
import { inputClass } from "@/components/workspace-list";
import { When } from "@/components/when";
import {
  commands,
  type ReportFormat,
  type ReviewEntry,
  type ReviewOutcome,
  type ReviewReport,
  type ReviewSnapshotId,
  type Task,
  type TaskId,
  type Timestamp,
  type Workspace,
} from "@/lib/bindings";
import {
  unwrap,
  useArchive,
  useDeleteReviewSnapshot,
  useReview,
  useReviewSnapshot,
  useReviewSnapshots,
  useReviewTimeZone,
  useSaveReviewSnapshot,
  useSetReviewTimeZone,
  useWorkspaces,
} from "@/lib/queries";
import {
  commitSubject,
  durationKeys,
  filterEntries,
  formatChanges,
  formatDuration,
  formatDueRate,
  formatEstimateAccuracy,
  formatReviewDay,
  formatReviewMonth,
  formatReviews,
  groupByOutcome,
  lateDetails,
  noReviewFilter,
  periodContaining,
  periodLabel,
  planVsActual,
  pullRequestNumber,
  pullRequestRef,
  pullRequestStats,
  reviewLabels,
  shiftPeriod,
  summarize,
  weekStarting,
  yearInReview,
  type PeriodKind,
  type ReviewFilter,
  type ReviewPeriod,
} from "@/lib/review";
import { type MissingPlanField, missingPlan } from "@/lib/plan";
import { toneFill, toneText } from "@/lib/status-styles";
import { useI18n, useMessages } from "@/lib/i18n";
import type { Messages } from "@/locales/en";
import { activeSeconds, formatDate, formatFull, waitingSeconds, workSegments } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { saveFile } from "@/web/files";
import { openUrl } from "@/web/opener";

const outcomeStyles: Record<ReviewOutcome, string> = {
  completed: toneText.success,
  opened_for_review: toneText.review,
  started: toneText.progress,
  worked_on: toneText.progress,
  planned: toneText.neutral,
};

/** Selector values for the choices the review state keeps as `null`. */
const liveReview = "live";
const allWorkspaces = "all";
const anyLabel = "any";

const periodKinds = ["week", "month", "quarter", "year", "custom"] as const satisfies readonly PeriodKind[];
const controlMessages = { "ko-KR": koKR };

/** Report actions in one menu, so the controls fit a phone in two rows. */
function ExportMenu({ disabled, items }: { disabled: boolean; items: DropdownMenuOption[] }) {
  const m = useMessages();
  return (
    <DropdownMenu
      items={items}
      alignment="end"
      menuWidth={192}
      renderTrigger={(trigger) => (
        <Button {...trigger} size="sm" variant="primary" icon={<Download />} label={m.review.export} isDisabled={disabled} />
      )}
    />
  );
}

/** The time zone reviewed periods are judged in, and a form to change it. */
function TimeZoneControl() {
  const m = useMessages();
  const timeZone = useReviewTimeZone();
  const setTimeZone = useSetReviewTimeZone();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  async function save(value: string | null) {
    setError(null);
    try {
      await setTimeZone.mutateAsync(value);
      setEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  if (!timeZone.data) return null;
  const { timeZone: current, configured } = timeZone.data;
  if (!editing) {
    return (
      <span>
        {configured === null ? m.review.serverDaysIn(current) : m.review.daysIn(current)}{" "}
        <Button
          size="sm"
          variant="ghost"
          label={m.review.changeTimeZone}
          className="print:hidden"
          onClick={() => {
            setDraft(configured ?? current);
            setEditing(true);
          }}
        />
      </span>
    );
  }
  return (
    <form
      aria-label={m.review.timeZone}
      className="flex flex-wrap items-center gap-2 print:hidden"
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft);
      }}
    >
      <label htmlFor="review-time-zone" className="text-xs">
        {m.review.timeZoneForEveryDevice}
      </label>
      <input
        id="review-time-zone"
        list="review-time-zones"
        required
        className={cn(inputClass, "w-56")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <datalist id="review-time-zones">
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <Button size="sm" variant="primary" type="submit" label={m.common.save} isDisabled={setTimeZone.isPending} />
      {configured !== null && (
        <Button size="sm" variant="secondary" label={m.review.useServerTimeZone} onClick={() => void save(null)} />
      )}
      <Button size="sm" variant="ghost" label={m.common.cancel} onClick={() => setEditing(false)} />
      {error && (
        <span role="alert" className="w-full text-xs text-destructive">
          {error}
        </span>
      )}
    </form>
  );
}

/** What the review shows: the live review of a period or a saved one. */
interface Shown {
  period: ReviewPeriod;
  entries: ReviewEntry[];
  /** The period as `[start, end)`, as the server judged it. */
  start: Timestamp;
  end: Timestamp;
  timeZone: string;
  /** The time durations and due dates are judged at: now, or when the review was saved. */
  now: Timestamp;
}

export function Review({ onShowTask }: { onShowTask?: (id: TaskId) => void }) {
  const { m, locale } = useI18n();
  const [period, setPeriod] = useState<ReviewPeriod>(() => periodContaining("week", formatDate(Date.now() / 1000)));
  const [notice, setNotice] = useState<((messages: Messages["review"]) => string) | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>(noReviewFilter);
  // The task whose edit form a missing-plan mark opened, and the field it focuses.
  const [editingPlan, setEditingPlan] = useState<{ id: TaskId; field: MissingPlanField } | null>(null);
  // The saved review on screen; null for the live review of `period`.
  const [snapshotId, setSnapshotId] = useState<ReviewSnapshotId | null>(null);
  const live = useReview(period.from, period.to);
  const snapshots = useReviewSnapshots();
  const snapshot = useReviewSnapshot(snapshotId);
  const saveSnapshot = useSaveReviewSnapshot();
  const deleteSnapshot = useDeleteReviewSnapshot();
  const viewing = snapshotId !== null;
  const review = viewing ? snapshot : live;
  const workspaces = useWorkspaces();
  const archive = useArchive();
  // Reviews keep the work of deleted workspaces, so they are named too; a saved review
  // names them as they were named when it was saved.
  const workspaceList: Pick<Workspace, "id" | "name">[] = viewing
    ? (snapshot.data?.workspaces ?? [])
    : [...(workspaces.data ?? []), ...(archive.data?.workspaces ?? [])];
  const names = new Map(workspaceList.map((workspace) => [workspace.id, workspace.name]));
  const shown: Shown | undefined = viewing
    ? snapshot.data && {
        period: { kind: snapshot.data.summary.period, from: snapshot.data.summary.from, to: snapshot.data.summary.to },
        entries: snapshot.data.entries,
        start: snapshot.data.summary.start,
        end: snapshot.data.summary.end,
        timeZone: snapshot.data.summary.timeZone,
        now: snapshot.data.summary.savedAt,
      }
    : live.data && {
        period,
        entries: live.data.entries,
        start: live.data.start,
        end: live.data.end,
        timeZone: live.data.timeZone,
        now: Date.now() / 1000,
      };
  const shownPeriod = shown?.period ?? period;
  const entries = shown && filterEntries(shown.entries, filter);
  // The chosen label stays listed when the period has no task with it.
  const labels = reviewLabels(shown?.entries ?? []);
  if (filter.label !== null && !labels.includes(filter.label)) labels.push(filter.label);
  const scope = [
    filter.workspaceId === null
      ? m.review.acrossWorkspaces
      : m.review.inWorkspace(names.get(filter.workspaceId) ?? m.review.unnamedWorkspace(filter.workspaceId)),
    filter.label !== null && m.review.labelled(filter.label),
  ]
    .filter(Boolean)
    .join(", ");
  const noun = m.review.periodNouns[shownPeriod.kind];

  function moveTo(next: ReviewPeriod) {
    setNotice(null);
    setPeriod(next);
  }

  function openSnapshot(id: ReviewSnapshotId | null) {
    setNotice(null);
    setEditingPlan(null);
    setSnapshotId(id);
  }

  async function saveAsSnapshot() {
    try {
      const saved = await saveSnapshot.mutateAsync({
        period: period.kind,
        from: period.from,
        to: period.kind === "custom" ? period.to : null,
        workspaceId: filter.workspaceId,
        label: filter.label,
        title: null,
      });
      setNotice(() => (messages: Messages["review"]) => messages.snapshotSaved(saved.title, saved.entryCount));
    } catch (error) {
      setNotice(() => (messages: Messages["review"]) => messages.snapshotSaveFailed(error instanceof Error ? error.message : String(error)));
    }
  }

  async function removeSnapshot(id: ReviewSnapshotId) {
    try {
      await deleteSnapshot.mutateAsync(id);
      openSnapshot(null);
      setNotice(() => (messages: Messages["review"]) => messages.snapshotDeleted);
    } catch (error) {
      setNotice(() => (messages: Messages["review"]) => messages.snapshotDeleteFailed(error instanceof Error ? error.message : String(error)));
    }
  }


  function switchKind(kind: PeriodKind) {
    if (kind === period.kind) return;
    moveTo(kind === "custom" ? { ...period, kind } : periodContaining(kind, period.from));
  }

  // The server renders the report, as for MCP and `toodo review`, in its review time zone;
  // a saved review keeps the report rendered when it was saved.
  function renderReport(format: ReportFormat): Promise<ReviewReport> {
    if (viewing) {
      if (!snapshot.data) return Promise.reject(new Error(m.review.snapshotLoading));
      return Promise.resolve(format === "csv" ? snapshot.data.csv : snapshot.data.markdown);
    }
    return unwrap(
      commands.reviewReport({
        period: period.kind,
        date: null,
        from: period.from,
        to: period.kind === "custom" ? period.to : null,
        format,
        timeZone: null,
        workspaceId: filter.workspaceId,
        label: filter.label,
      }),
    );
  }

  async function copyMarkdown() {
    try {
      const report = renderReport("markdown");
      if (typeof ClipboardItem === "undefined") {
        await navigator.clipboard.writeText((await report).contents);
      } else {
        // Handing the clipboard a pending item keeps Safari's user-gesture check satisfied.
        const text = report.then(({ contents }) => new Blob([contents], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
      }
      setNotice(() => (messages: Messages["review"]) => messages.markdownCopied);
    } catch (error) {
      setNotice(() => (messages: Messages["review"]) => messages.copyFailed(error instanceof Error ? error.message : String(error)));
    }
  }

  async function saveAs(format: ReportFormat) {
    try {
      const report = await renderReport(format);
      // The report is for the user, not the server: the browser downloads it.
      saveFile(report.fileName, new Blob([report.contents], { type: `${report.mediaType};charset=utf-8` }));
      setNotice(() => (messages: Messages["review"]) => messages.downloaded(report.fileName));
    } catch (error) {
      setNotice(() => (messages: Messages["review"]) => messages.exportFailed(error instanceof Error ? error.message : String(error)));
    }
  }

  return (
    // The bottom padding lets the last entry scroll clear of the floating chat button.
    <section aria-labelledby="review-heading" className="flex flex-col gap-4 pb-14 print:pb-0">
      <header className="flex flex-col gap-1">
        <h2 id="review-heading" className="text-xl font-semibold tracking-tight">
          {viewing && snapshot.data ? snapshot.data.summary.title : m.review.periodTitles[shownPeriod.kind]}
        </h2>
        <p className="text-sm text-muted-foreground">
          {m.review.workRecorded(formatReviewDay(shownPeriod.from, locale), formatReviewDay(shownPeriod.to, locale), scope)}{" "}
          {viewing ? (
            snapshot.data && (
              <span>
                {m.review.snapshotDetails(formatFull(snapshot.data.summary.savedAt, locale), snapshot.data.summary.timeZone)}
              </span>
            )
          ) : (
            <TimeZoneControl />
          )}
        </p>
      </header>

      {(viewing || (snapshots.data?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Selector
            label={m.review.savedReviews}
            isLabelHidden
            size="sm"
            options={[
              { value: liveReview, label: m.review.liveReview },
              ...(snapshots.data ?? []).map((saved) => ({
                value: String(saved.id),
                label: m.review.savedOption(saved.title, formatReviewDay(formatDate(saved.savedAt), locale)),
              })),
            ]}
            value={snapshotId === null ? liveReview : String(snapshotId)}
            onChange={(value) => openSnapshot(value === liveReview ? null : Number(value))}
          />
          {snapshotId !== null && (
            <>
              <Button size="sm" variant="secondary" label={m.review.backToLiveReview} onClick={() => openSnapshot(null)} />
              <Button
                size="sm"
                variant="ghost"
                label={m.review.deleteSavedReview}
                isDisabled={deleteSnapshot.isPending}
                onClick={() => void removeSnapshot(snapshotId)}
              />
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 print:hidden">
        {!viewing && (
          <InternationalizationProvider locale={locale === "ko" ? "ko-KR" : locale} messages={controlMessages}>
            <ToggleButtonGroup
              label={m.review.period}
              size="sm"
              value={period.kind}
              onChange={(next) => typeof next === "string" && switchKind(next as PeriodKind)}
            >
              {periodKinds.map((kind) => (
                <ToggleButton key={kind} value={kind} label={m.review.periodKinds[kind]} />
              ))}
            </ToggleButtonGroup>
            {period.kind === "week" && (
              <DateInput
                label={m.review.weekStarting}
                size="sm"
                format="system_date"
                value={period.from as ISODateString}
                onChange={(value) => value && moveTo(weekStarting(value))}
              />
            )}
            {period.kind === "custom" && (
              <>
                <DateInput
                  label={m.review.from}
                  size="sm"
                  format="system_date"
                  max={period.to as ISODateString}
                  value={period.from as ISODateString}
                  onChange={(value) => value && value <= period.to && moveTo({ ...period, from: value })}
                />
                <DateInput
                  label={m.review.to}
                  size="sm"
                  format="system_date"
                  min={period.from as ISODateString}
                  value={period.to as ISODateString}
                  onChange={(value) => value && value >= period.from && moveTo({ ...period, to: value })}
                />
              </>
            )}
            {period.kind !== "week" && period.kind !== "custom" && (
              <span className="px-1 text-sm font-medium">{periodLabel(period, { m, locale })}</span>
            )}
            <IconButton
              size="sm"
              variant="secondary"
              icon={<ChevronLeft />}
              label={m.review.previousPeriod(noun)}
              tooltip={m.review.previousPeriod(noun)}
              onClick={() => moveTo(shiftPeriod(period, -1))}
            />
            <IconButton
              size="sm"
              variant="secondary"
              icon={<ChevronRight />}
              label={m.review.nextPeriod(noun)}
              tooltip={m.review.nextPeriod(noun)}
              onClick={() => moveTo(shiftPeriod(period, 1))}
            />
            {period.kind !== "custom" && (
              <Button
                size="sm"
                variant="ghost"
                label={m.review.thisPeriod(noun)}
                onClick={() => moveTo(periodContaining(period.kind, formatDate(Date.now() / 1000)))}
              />
            )}
          </InternationalizationProvider>
        )}
        <div className="ml-auto">
          <ExportMenu
            disabled={!entries}
            items={[
              ...(viewing ? [] : [{ label: m.review.saveSnapshot, onClick: () => void saveAsSnapshot() }]),
              { label: m.review.copyMarkdown, onClick: () => void copyMarkdown() },
              { label: m.review.saveMarkdown, onClick: () => void saveAs("markdown") },
              { label: m.review.saveCsv, onClick: () => void saveAs("csv") },
              { label: m.review.printOrSavePdf, onClick: () => window.print() },
            ]}
          />
        </div>
      </div>

      <div role="group" aria-label={m.review.filters} className="flex flex-wrap items-center gap-2 print:hidden">
        <Selector
          label={m.review.workspace}
          isLabelHidden
          size="sm"
          options={[
            { value: allWorkspaces, label: m.review.allWorkspaces },
            ...workspaceList.map((workspace) => ({ value: String(workspace.id), label: workspace.name })),
          ]}
          value={filter.workspaceId === null ? allWorkspaces : String(filter.workspaceId)}
          onChange={(value) => setFilter({ ...filter, workspaceId: value === allWorkspaces ? null : Number(value) })}
        />
        <Selector
          label={m.review.label}
          isLabelHidden
          size="sm"
          options={[
            { value: anyLabel, label: labels.length === 0 ? m.review.noLabels : m.review.anyLabel },
            ...labels.map((label) => ({ value: `label:${label}`, label })),
          ]}
          value={filter.label === null ? anyLabel : `label:${filter.label}`}
          onChange={(value) =>
            setFilter({ ...filter, label: value === anyLabel ? null : value.slice("label:".length) })
          }
        />
        {(filter.workspaceId !== null || filter.label !== null) && (
          <Button size="sm" variant="ghost" label={m.review.clearFilters} onClick={() => setFilter(noReviewFilter)} />
        )}
      </div>

      {notice && (
        <p role="status" className="text-xs text-muted-foreground print:hidden">
          {notice(m.review)}
        </p>
      )}

      {/* Stays mounted so screen readers hear loading start and finish for each period. */}
      <p role="status" className={cn("text-sm text-muted-foreground", !review.isPending && "sr-only")}>
        {review.isPending
          ? m.review.loading
          : entries
            ? m.review.showingActivity(entries.length, noun)
            : ""}
      </p>
      {review.isError && (
        <p role="alert" className="text-sm text-destructive">
          {m.review.loadFailed(review.error.message)}
        </p>
      )}
      {entries?.length === 0 && (
        <EmptyState
          title={
            shown?.entries.length === 0
              ? m.review.noActivity(noun)
              : m.review.noMatchingActivity(noun)
          }
          hint={
            viewing
              ? m.review.savedEmptyHint
              : shown?.entries.length === 0
              ? m.review.emptyHint
              : m.review.filteredEmptyHint
          }
          action={
            viewing ? undefined : (
            <div className="flex flex-wrap justify-center gap-2 print:hidden">
              <Button
                size="sm"
                variant="secondary"
                label={m.review.showPeriodBefore(noun)}
                onClick={() => moveTo(shiftPeriod(period, -1))}
              />
            </div>
            )
          }
        />
      )}
      {shown && entries && entries.length > 0 && (
        <ReviewSummaryPanel shown={shown} entries={entries} workspaces={workspaceList} />
      )}
      {shown && entries && <PlanPanel shown={shown} entries={entries} editable={!viewing} />}
      {shownPeriod.kind === "year" && entries && <YearInReviewPanel entries={entries} />}
      {entries &&
        groupByOutcome(entries).map((group) => (
          <section key={group.outcome} aria-label={m.review.outcomes[group.outcome]} className="flex flex-col gap-2">
            <h3 className={cn("text-sm font-semibold", outcomeStyles[group.outcome])}>
              {m.review.outcomes[group.outcome]}{" "}
              <span className="font-normal text-muted-foreground">({group.entries.length})</span>
            </h3>
            <ul className="flex flex-col divide-y rounded-lg border">
              {group.entries.map(({ task, at, commits, archived, pullRequest }) => (
                <li key={task.id} className="flex flex-col gap-1 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <TaskTypeBadge type={task.taskType} />
                    <span className="shrink-0 text-xs text-muted-foreground">#{task.id}</span>
                    <button
                      type="button"
                      aria-label={m.review.openTask(task.id, task.title)}
                      title={task.title}
                      onClick={() => onShowTask?.(task.id)}
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline max-md:min-h-11"
                    >
                      {task.title}
                    </button>
                    {task.resolution === "not_adopted" && <Badge className="shrink-0" label={m.review.notAdopted} />}
                    {archived && <Badge className="shrink-0" label={m.review.archived} />}
                    {task.resolution === "completed" && <Badge className="shrink-0" variant="green" label={m.review.outcomes.completed} />}
                    {pullRequestRef(task) && <PullRequestLink url={pullRequestRef(task)!} stats={pullRequest} />}
                    <span className="shrink-0 text-xs text-muted-foreground max-md:hidden print:inline">
                      {names.get(task.workspaceId) ?? m.review.unnamedWorkspaceTitle(task.workspaceId)} &middot; <When at={at} />
                    </span>
                  </div>
                  <TaskLabels task={task} />
                  {archived || viewing ? null : editingPlan?.id === task.id ? (
                    <TaskEditForm
                      task={task}
                      focusPlan={editingPlan.field}
                      onDone={() => setEditingPlan(null)}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground empty:hidden print:hidden">
                      <MissingPlanMark task={task} onEdit={(field) => setEditingPlan({ id: task.id, field })} />
                    </p>
                  )}
                  {task.completionNote && (
                    <p aria-label={m.review.completionNote(task.id)} className="whitespace-pre-line break-words-keep text-xs">
                      {task.completionNote}
                    </p>
                  )}
                  {shown && <TaskTime task={task} shown={shown} />}
                  {commits.length > 0 && (
                    <ul aria-label={m.review.taskCommits(task.id, noun)} className="flex flex-col gap-0.5">
                      {commits.map((commit) => (
                        <li key={commit.sha} className="flex gap-2 text-xs" title={commit.author}>
                          <code className="shrink-0 text-muted-foreground">{commit.sha.slice(0, 7)}</code>
                          <span className="truncate">{commitSubject(commit.message)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </section>
  );
}

/** `formatDuration`, with no time at all as `0h` rather than `<1h`. */
function formatSpan(seconds: number, m: Messages): string {
  return seconds === 0 ? m.review.hours(0) : formatDuration(seconds, m);
}

/**
 * Active against waiting time of a started task, and its waits in the shown period with the
 * reason recorded when each began, as of the time the review is judged at; nothing for a task
 * never started.
 */
function TaskTime({ task, shown }: { task: Task; shown: Shown }) {
  const { m, locale } = useI18n();
  const { start, end, now } = shown;
  const active = activeSeconds(task.timeline, now);
  const waiting = waitingSeconds(task.timeline, now);
  if (active === null || waiting === null) return null;
  const waits = workSegments(task.timeline).filter(
    (segment) => segment.state === "paused" && segment.start < end && (segment.end ?? now) > start,
  );
  return (
    <div aria-label={m.review.taskTime(task.id)} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <p>
        {m.review.activeAndWaiting(formatSpan(active, m), formatSpan(waiting, m))}
      </p>
      {waits.length > 0 && (
        <ul aria-label={m.review.taskWaits(task.id)} className="flex flex-col gap-0.5">
          {waits.map((wait) => (
            <li key={wait.start} className="break-words-keep">
              {(wait.end === null ? m.review.ongoingWait : m.review.endedWait)(
                formatSpan(Math.max((wait.end ?? now) - wait.start, 0), m),
                formatReviewDay(formatDate(wait.start), locale),
                wait.reason ?? m.review.noWaitReason,
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PullRequestLink({ url, stats }: { url: string; stats: ReviewEntry["pullRequest"] }) {
  const m = useMessages();
  const number = pullRequestNumber(url);
  const open = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    openUrl(url).catch((error: unknown) => console.error(`Failed to open ${url}`, error));
  };
  return (
    <a
      href={url}
      title={stats ? `${url} \u00b7 ${pullRequestStats(stats, m)}` : url}
      aria-label={number ? m.review.numberedPullRequest(number) : m.review.pullRequest}
      onClick={open}
      onAuxClick={open}
      className="shrink-0 text-xs text-primary underline underline-offset-2 hover:no-underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
    >
      {number ? `#${number}` : m.review.pullRequestShort}
    </a>
  );
}

function YearInReviewPanel({ entries }: { entries: ReviewEntry[] }) {
  const m = useMessages();
  const year = yearInReview(entries);
  if (year === null) return null;
  return (
    <section aria-labelledby="year-in-review-heading" className="flex flex-col gap-3 rounded-lg border p-3">
      <h3 id="year-in-review-heading" className="text-sm font-semibold">
        {m.review.yearInReview}
      </h3>
      {year.pullRequests && (
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{m.review.mergedPullRequests}</dt>
            <dd className="text-lg font-semibold">{year.pullRequests.pullRequests}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{m.review.linesChanged}</dt>
            <dd className="text-lg font-semibold">
              <span>+{year.pullRequests.additions}</span>
              <span className="text-muted-foreground"> / </span>
              <span>-{year.pullRequests.deletions}</span>
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{m.review.filesChanged}</dt>
            <dd className="text-lg font-semibold">{year.pullRequests.changedFiles}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{m.review.reviews}</dt>
            <dd className="text-lg font-semibold" title={formatReviews(year.pullRequests, m)}>
              {year.pullRequests.reviews}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {m.review.reviewedPullRequests(year.pullRequests.reviewed, year.pullRequests.pullRequests)}
              </span>
            </dd>
          </div>
        </dl>
      )}
      {year.largest.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">{m.review.largestPullRequests}</h4>
          <ol aria-label={m.review.largestPullRequests} className="flex flex-col gap-1">
            {year.largest.map(({ task, pullRequest }) => (
              <li key={task.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <TaskTypeBadge type={task.taskType} />
                <span className="truncate font-medium">{task.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{pullRequestStats(pullRequest, m)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {year.research.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">{m.review.researchConclusions}</h4>
          <ul aria-label={m.review.researchConclusions} className="flex flex-col divide-y rounded-md border">
            {year.research.map(({ task, at, adopted }) => (
              <li key={task.id} className="flex flex-col gap-1 px-2 py-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <span className="truncate font-medium">{task.title}</span>
                  <Badge className="shrink-0" variant={adopted ? "green" : "neutral"} label={adopted ? m.review.adopted : m.review.notAdopted} />
                  <When className="ml-auto shrink-0 text-xs text-muted-foreground" at={at} />
                </div>
                <p aria-label={m.review.researchConclusion(task.id)} className="whitespace-pre-line break-words-keep text-xs">
                  {task.completionNote ?? <span className="text-muted-foreground">{m.review.noConclusion}</span>}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {year.overruns.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">{m.review.largestOverruns}</h4>
          <ol aria-label={m.review.largestOverruns} className="flex flex-col gap-1">
            {year.overruns.map(({ task, estimated, actual }) => (
              <li key={task.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <TaskTypeBadge type={task.taskType} />
                <span className="truncate font-medium">{task.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {m.review.overrun(formatDuration(estimated, m), formatDuration(actual, m))}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/** Estimates and due dates of the reviewed tasks against what happened. */
function PlanPanel({ shown, entries, editable }: { shown: Shown; entries: ReviewEntry[]; editable: boolean }) {
  const { m, locale } = useI18n();
  const plan = planVsActual(shown.end, entries, shown.now);
  // Archived tasks and saved reviews cannot be edited, so only live tasks count as missing a plan.
  const missing = editable ? entries.filter(({ archived }) => !archived).map(({ task }) => missingPlan(task)) : [];
  const withoutEstimate = missing.filter((fields) => fields.includes("estimate")).length;
  const withoutDueDate = missing.filter((fields) => fields.includes("dueDate")).length;
  if (plan === null && withoutEstimate + withoutDueDate === 0) return null;
  const missingSummary = (
    <div className="contents">
      <dt className="text-muted-foreground">{m.review.missingPlan}</dt>
      <dd>{m.review.missingPlanDetails(withoutEstimate, withoutDueDate)}</dd>
    </div>
  );
  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-3 rounded-lg border p-3">
      <h3 id="plan-heading" className="text-sm font-semibold">
        {m.review.planVsActual}
      </h3>
      {plan === null ? (
        <>
          <p className="text-sm">{m.review.noPlanToCompare}</p>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">{missingSummary}</dl>
        </>
      ) : (
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <div className="contents">
          <dt className="text-muted-foreground">{m.review.estimateVsActive}</dt>
          <dd>{plan.time ? formatEstimateAccuracy(plan.time, m) : m.review.noCompletedEstimate}</dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">{m.review.dueDatesMet}</dt>
          <dd>{plan.dueDates ? formatDueRate(plan.dueDates, m) : m.review.noCompletedDueDate}</dd>
        </div>
        {withoutEstimate + withoutDueDate > 0 && missingSummary}
      </dl>
      )}
      {plan !== null && plan.late.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">{m.review.lateTasks}</h4>
          <ul aria-label={m.review.lateTasks} className="flex flex-col gap-1">
            {plan.late.map((late) => (
              <li key={late.task.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <span className="flex min-w-0 max-w-full items-center gap-2">
                  <TaskTypeBadge type={late.task.taskType} />
                  <span className="truncate font-medium">{late.task.title}</span>
                </span>
                <span className={cn("ml-auto shrink-0 text-xs", toneText.danger)}>{lateDetails(late, m, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ReviewSummaryPanel({
  shown,
  entries,
  workspaces,
}: {
  shown: Shown;
  entries: ReviewEntry[];
  workspaces: Pick<Workspace, "id" | "name">[];
}) {
  const { m, locale } = useI18n();
  const summary = summarize(shown.period, entries, workspaces, shown.timeZone, m);
  const busiestMonth = Math.max(1, ...(summary.completedPerMonth ?? []).map(({ count }) => count));
  return (
    <section aria-label={m.review.summary} className="flex flex-col gap-3 rounded-lg border p-3">
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {summary.outcomes.map(({ outcome, count }) => (
          <div key={outcome} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{m.review.outcomes[outcome]}</dt>
            <dd className="text-lg font-semibold">{count}</dd>
          </div>
        ))}
        {summary.notAdopted > 0 && (
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{m.review.notAdopted}</dt>
            <dd className="text-lg font-semibold">{summary.notAdopted}</dd>
          </div>
        )}
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{m.review.commits}</dt>
          <dd className="text-lg font-semibold">{summary.commits}</dd>
        </div>
      </dl>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {durationKeys.map((key) => {
          const stat = summary[key];
          return (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{m.review.durationLabels[key]}</dt>
              <dd>
                {stat === null
                  ? m.review.noData
                  : m.review.medianDuration(formatDuration(stat.median, m), stat.tasks)}
              </dd>
            </div>
          );
        })}
        {summary.changes && (
          <div className="contents">
            <dt className="text-muted-foreground">{m.review.completedPullRequestChanges}</dt>
            <dd>{formatChanges(summary.changes, m)}</dd>
          </div>
        )}
        {summary.completedByType.length > 0 && (
          <div className="contents">
            <dt className="text-muted-foreground">{m.review.completedByType}</dt>
            <dd>{summary.completedByType.map(({ taskType, count }) => m.review.completedCount(m.tasks.types[taskType], count)).join(", ")}</dd>
          </div>
        )}
        {summary.completedByWorkspace.length > 0 && (
          <div className="contents">
            <dt className="text-muted-foreground">{m.review.completedByWorkspace}</dt>
            <dd>{summary.completedByWorkspace.map(({ workspace, count }) => m.review.completedCount(workspace, count)).join(", ")}</dd>
          </div>
        )}
      </dl>
      {summary.completedPerMonth && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">{m.review.completedPerMonth}</h3>
          <ul aria-label={m.review.completedPerMonth} className="flex flex-col gap-0.5">
            {summary.completedPerMonth.map(({ month, count }) => (
              <li key={month} className="flex items-center gap-2 text-xs">
                <span className="w-16 shrink-0 font-mono text-muted-foreground">{formatReviewMonth(month, locale)}</span>
                <span
                  aria-hidden
                  className={cn("h-2 rounded-sm", toneFill.success)}
                  style={{ width: `${(count / busiestMonth) * 60}%`, minWidth: count > 0 ? 4 : 0 }}
                />
                <span>{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
