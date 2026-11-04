import { useEffect, useRef, useState } from "react";
import { CalendarCheck, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/task-list";
import { MissingPlanMark, TaskLabels } from "@/components/task-common";
import { TaskEditForm } from "@/components/task-edit-form";
import { inputClass } from "@/components/workspace-list";
import {
  commands,
  type BackfillSummary,
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
  useBackfillPullRequests,
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
  durationLabels,
  filterEntries,
  formatChanges,
  formatDuration,
  formatDueRate,
  formatEstimateAccuracy,
  formatReviews,
  groupByOutcome,
  lateDetails,
  noReviewFilter,
  outcomeLabels,
  periodContaining,
  periodLabel,
  periodNouns,
  periodTitles,
  planVsActual,
  pullRequestNumber,
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
import { toneChip, toneFill, toneText } from "@/lib/status-styles";
import { workspaceCapabilities } from "@/lib/workspace-capabilities";
import { When } from "@/components/when";
import { activeSeconds, formatDate, formatFull, waitingSeconds, workSegments } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { openUrl } from "@/web/opener";

const outcomeStyles: Record<ReviewOutcome, string> = {
  completed: toneText.success,
  opened_for_review: toneText.review,
  started: toneText.progress,
  worked_on: toneText.progress,
  planned: toneText.neutral,
};

const notAdoptedChip = cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", toneChip.neutral);

const periodKinds: { kind: PeriodKind; label: string }[] = [
  { kind: "week", label: "Week" },
  { kind: "month", label: "Month" },
  { kind: "quarter", label: "Quarter" },
  { kind: "year", label: "Year" },
  { kind: "custom", label: "Custom" },
];

function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Report actions in one menu, so the controls fit a phone in two rows. */
function ExportMenu({ disabled, children }: { disabled: boolean; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <Button size="sm" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
        <Download />
        <span className="max-md:sr-only">Export</span>
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Export review"
          className="absolute right-0 z-10 mt-1 flex w-48 flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What importing merged pull requests added, for the status line. */
export function backfillNotice(summary: BackfillSummary, noun: string): string {
  const skipped =
    summary.skipped > 0 ? ` Left out ${plural(summary.skipped, "pull request")} a task already records.` : "";
  if (summary.imported === 0) {
    return `Found no new pull requests you merged in this ${noun}.${skipped}`;
  }
  return `Imported ${plural(summary.imported, "merged pull request")} as done tasks.${skipped}`;
}

function MenuItem({ onSelect, children }: { onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted max-md:min-h-11"
    >
      {children}
    </button>
  );
}

/** The time zone reviewed periods are judged in, and a form to change it. */
function TimeZoneControl() {
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
        Days are in {current}
        {configured === null && " (the server's time zone)"}.{" "}
        <button
          type="button"
          className="text-primary underline underline-offset-2 hover:no-underline print:hidden"
          onClick={() => {
            setDraft(configured ?? current);
            setEditing(true);
          }}
        >
          Change time zone
        </button>
      </span>
    );
  }
  return (
    <form
      aria-label="Review time zone"
      className="flex flex-wrap items-center gap-2 print:hidden"
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft);
      }}
    >
      <label htmlFor="review-time-zone" className="text-xs">
        Time zone for every device
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
      <Button size="sm" type="submit" disabled={setTimeZone.isPending}>
        Save
      </Button>
      {configured !== null && (
        <Button size="sm" type="button" variant="outline" onClick={() => void save(null)}>
          Use the server's
        </Button>
      )}
      <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
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
  const [period, setPeriod] = useState<ReviewPeriod>(() => periodContaining("week", formatDate(Date.now() / 1000)));
  const [notice, setNotice] = useState<string | null>(null);
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
  const backfill = useBackfillPullRequests();
  const [backfillFailures, setBackfillFailures] = useState<string[]>([]);
  const onGitHub = workspaces.data?.some((workspace) => workspace.source === "github") ?? false;
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
      ? "across all workspaces"
      : `in ${names.get(filter.workspaceId) ?? `workspace ${filter.workspaceId}`}`,
    filter.label !== null && `labelled ${filter.label}`,
  ]
    .filter(Boolean)
    .join(", ");
  const noun = periodNouns[shownPeriod.kind];

  function moveTo(next: ReviewPeriod) {
    setNotice(null);
    setBackfillFailures([]);
    setPeriod(next);
  }

  function openSnapshot(id: ReviewSnapshotId | null) {
    setNotice(null);
    setBackfillFailures([]);
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
      setNotice(`Saved "${saved.title}" with ${plural(saved.entryCount, "task")}; reopen it from Saved reviews.`);
    } catch (error) {
      setNotice(`Could not save the review: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function removeSnapshot(id: ReviewSnapshotId) {
    try {
      await deleteSnapshot.mutateAsync(id);
      openSnapshot(null);
      setNotice("Deleted the saved review.");
    } catch (error) {
      setNotice(`Could not delete the saved review: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function importPullRequests() {
    setNotice(null);
    setBackfillFailures([]);
    try {
      const summary = await backfill.mutateAsync({ from: period.from, to: period.to });
      setNotice(backfillNotice(summary, noun));
      setBackfillFailures(summary.failures);
    } catch (error) {
      setNotice(`Could not import pull requests: ${error instanceof Error ? error.message : String(error)}`);
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
      if (!snapshot.data) return Promise.reject(new Error("the saved review is still loading"));
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
      setNotice("Copied as Markdown.");
    } catch (error) {
      setNotice(`Could not copy: ${String(error)}`);
    }
  }

  async function saveAs(format: ReportFormat) {
    try {
      const report = await renderReport(format);
      // The report is for the user, not the server: the browser downloads it.
      download(report.fileName, report.contents, report.mediaType);
      setNotice(`Downloaded ${report.fileName}`);
    } catch (error) {
      setNotice(`Could not export: ${String(error)}`);
    }
  }

  return (
    <section aria-labelledby="review-heading" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 id="review-heading" className="text-xl font-semibold tracking-tight">
          {viewing && snapshot.data ? snapshot.data.summary.title : periodTitles[shownPeriod.kind]}
        </h2>
        <p className="text-sm text-muted-foreground">
          Work recorded from {shownPeriod.from} to {shownPeriod.to} {scope}.{" "}
          {viewing ? (
            snapshot.data && (
              <span>
                Saved {formatFull(snapshot.data.summary.savedAt)}, with days in {snapshot.data.summary.timeZone}; it
                stays as it was when saved.
              </span>
            )
          ) : (
            <TimeZoneControl />
          )}
        </p>
      </header>

      {(viewing || (snapshots.data?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <select
            aria-label="Saved reviews"
            className={cn(inputClass, "w-auto max-md:min-w-0 max-md:flex-1")}
            value={snapshotId ?? ""}
            onChange={(e) => openSnapshot(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">Live review</option>
            {snapshots.data?.map((saved) => (
              <option key={saved.id} value={saved.id}>
                {saved.title} (saved {formatDate(saved.savedAt)})
              </option>
            ))}
          </select>
          {snapshotId !== null && (
            <>
              <Button size="sm" variant="outline" onClick={() => openSnapshot(null)}>
                Back to the live review
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={deleteSnapshot.isPending}
                onClick={() => void removeSnapshot(snapshotId)}
              >
                Delete saved review
              </Button>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {!viewing && (
          <>
            <div role="group" aria-label="Review period" className="flex rounded-md border p-0.5 max-md:w-full">
              {periodKinds.map(({ kind, label }) => (
                <Button
                  key={kind}
                  size="sm"
                  variant={period.kind === kind ? "default" : "ghost"}
                  aria-pressed={period.kind === kind}
                  onClick={() => switchKind(kind)}
                >
                  {label}
                </Button>
              ))}
            </div>
            {period.kind === "week" && (
              <>
                <label htmlFor="week-start" className="text-xs text-muted-foreground max-md:sr-only">
                  Week starting
                </label>
                <input
                  id="week-start"
                  type="date"
                  required
                  className={cn(inputClass, "w-40 max-md:w-0 max-md:min-w-0 max-md:flex-1")}
                  value={period.from}
                  onChange={(e) => e.target.value && moveTo(weekStarting(e.target.value))}
                />
              </>
            )}
            {period.kind === "custom" && (
              <>
                <label htmlFor="review-from" className="text-xs text-muted-foreground max-md:sr-only">
                  From
                </label>
                <input
                  id="review-from"
                  type="date"
                  required
                  max={period.to}
                  className={cn(inputClass, "w-40")}
                  value={period.from}
                  onChange={(e) => e.target.value && e.target.value <= period.to && moveTo({ ...period, from: e.target.value })}
                />
                <label htmlFor="review-to" className="text-xs text-muted-foreground max-md:sr-only">
                  To
                </label>
                <input
                  id="review-to"
                  type="date"
                  required
                  min={period.from}
                  className={cn(inputClass, "w-40")}
                  value={period.to}
                  onChange={(e) => e.target.value && e.target.value >= period.from && moveTo({ ...period, to: e.target.value })}
                />
              </>
            )}
            {period.kind !== "week" && period.kind !== "custom" && (
              <span className="px-1 text-sm font-medium">{periodLabel(period)}</span>
            )}
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={`Previous ${noun}`}
              title={`Previous ${noun}`}
              onClick={() => moveTo(shiftPeriod(period, -1))}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={`Next ${noun}`}
              title={`Next ${noun}`}
              onClick={() => moveTo(shiftPeriod(period, 1))}
            >
              <ChevronRight />
            </Button>
            {period.kind !== "custom" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => moveTo(periodContaining(period.kind, formatDate(Date.now() / 1000)))}
              >
                <CalendarCheck className="md:hidden" aria-hidden />
                <span className="max-md:sr-only">This {noun}</span>
              </Button>
            )}
          </>
        )}
        <div className="ml-auto">
          <ExportMenu disabled={!entries}>
            {(close) => (
              <>
                {!viewing && (
                  <MenuItem
                    onSelect={() => {
                      close();
                      void saveAsSnapshot();
                    }}
                  >
                    Save as snapshot
                  </MenuItem>
                )}
                <MenuItem
                  onSelect={() => {
                    close();
                    void copyMarkdown();
                  }}
                >
                  Copy as Markdown
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    void saveAs("markdown");
                  }}
                >
                  Save as Markdown
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    void saveAs("csv");
                  }}
                >
                  Save as CSV
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    window.print();
                  }}
                >
                  Print or save as PDF
                </MenuItem>
              </>
            )}
          </ExportMenu>
        </div>
      </div>

      <div role="group" aria-label="Review filters" className="flex flex-wrap items-center gap-2 print:hidden">
        <select
          aria-label="Workspace"
          className={cn(inputClass, "w-auto max-md:min-w-0 max-md:flex-1")}
          value={filter.workspaceId ?? ""}
          onChange={(e) => setFilter({ ...filter, workspaceId: e.target.value === "" ? null : Number(e.target.value) })}
        >
          <option value="">All workspaces</option>
          {workspaceList.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Label"
          className={cn(inputClass, "w-auto max-md:min-w-0 max-md:flex-1")}
          value={filter.label ?? ""}
          onChange={(e) => setFilter({ ...filter, label: e.target.value === "" ? null : e.target.value })}
        >
          <option value="">{labels.length === 0 ? "No labels in this period" : "Any label"}</option>
          {labels.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
        {(filter.workspaceId !== null || filter.label !== null) && (
          <Button size="sm" variant="ghost" onClick={() => setFilter(noReviewFilter)}>
            Clear filters
          </Button>
        )}
      </div>

      {notice && (
        <p role="status" className="text-xs text-muted-foreground print:hidden">
          {notice}
        </p>
      )}
      {backfillFailures.length > 0 && (
        <ul role="alert" aria-label="Pull requests not imported" className="text-xs text-destructive print:hidden">
          {backfillFailures.map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      )}

      {/* Stays mounted so screen readers hear loading start and finish for each period. */}
      <p role="status" className={cn("text-sm text-muted-foreground", !review.isPending && "sr-only")}>
        {review.isPending
          ? "Loading the review..."
          : entries
            ? `Showing ${entries.length} ${entries.length === 1 ? "task" : "tasks"} with activity in this ${noun}.`
            : ""}
      </p>
      {review.isError && (
        <p role="alert" className="text-sm text-destructive">
          Failed to load the review: {review.error.message}
        </p>
      )}
      {entries?.length === 0 && (
        <EmptyState
          title={
            shown?.entries.length === 0
              ? `No recorded activity in this ${noun}.`
              : `No recorded activity in this ${noun} matches the filters.`
          }
          hint={
            viewing
              ? "This saved review keeps the tasks it had when it was saved."
              : shown?.entries.length === 0
              ? `Toodo records each task as it is planned, started, opened for review, and completed, with the commits of its branch, so reviews fill up as you work. Work merged before Toodo tracked it is not here: ${
                  onGitHub
                    ? `import the pull requests you merged in this ${noun} to add it.`
                    : "add a workspace with a GitHub repository to import the pull requests you merged."
                }`
              : "Pick another period or change the filters to look at other work."
          }
          action={
            viewing ? undefined : (
            <div className="flex flex-wrap justify-center gap-2 print:hidden">
              {shown?.entries.length === 0 && onGitHub && (
                <Button size="sm" disabled={backfill.isPending} onClick={() => void importPullRequests()}>
                  {backfill.isPending ? "Importing..." : "Import merged pull requests"}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => moveTo(shiftPeriod(period, -1))}>
                Show the {noun} before
              </Button>
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
          <section key={group.outcome} aria-label={outcomeLabels[group.outcome]} className="flex flex-col gap-2">
            <h3 className={cn("text-sm font-semibold", outcomeStyles[group.outcome])}>
              {outcomeLabels[group.outcome]}{" "}
              <span className="font-normal text-muted-foreground">({group.entries.length})</span>
            </h3>
            <ul className="flex flex-col divide-y rounded-lg border">
              {group.entries.map(({ task, at, commits, archived }) => (
                <li key={task.id} className="flex flex-col gap-1 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <TaskTypeBadge type={task.taskType} />
                    <span className="shrink-0 text-xs text-muted-foreground">#{task.id}</span>
                    <button
                      type="button"
                      aria-label={`Open #${task.id} ${task.title}`}
                      title={task.title}
                      onClick={() => onShowTask?.(task.id)}
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline max-md:min-h-11"
                    >
                      {task.title}
                    </button>
                    {task.resolution === "not_adopted" && (
                      <span className={notAdoptedChip}>Not adopted</span>
                    )}
                    {archived && <span className={notAdoptedChip}>Archived</span>}
                    {task.resolution === "completed" && (
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", toneChip.success)}>Completed</span>
                    )}
                    {task.pullRequestUrl && (
                      <PullRequestLink url={task.pullRequestUrl} stats={task.pullRequest} />
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground max-md:hidden print:inline">
                      {names.get(task.workspaceId) ?? `Workspace ${task.workspaceId}`} &middot; <When at={at} />
                    </span>
                  </div>
                  <TaskLabels task={task} />
                  {archived || viewing ? null : editingPlan?.id === task.id ? (
                    <TaskEditForm
                      task={task}
                      capabilities={workspaceCapabilities(workspaces.data?.find(({ id }) => id === task.workspaceId))}
                      focusPlan={editingPlan.field}
                      onDone={() => setEditingPlan(null)}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground empty:hidden print:hidden">
                      <MissingPlanMark task={task} onEdit={(field) => setEditingPlan({ id: task.id, field })} />
                    </p>
                  )}
                  {task.completionNote && (
                    <p aria-label={`Completion note of #${task.id}`} className="whitespace-pre-line break-words-keep text-xs">
                      {task.completionNote}
                    </p>
                  )}
                  {shown && <TaskTime task={task} shown={shown} />}
                  {commits.length > 0 && (
                    <ul aria-label={`Commits of #${task.id} this ${noun}`} className="flex flex-col gap-0.5">
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
function formatSpan(seconds: number): string {
  return seconds === 0 ? "0h" : formatDuration(seconds);
}

/**
 * Active against waiting time of a started task, and its waits in the shown period with the
 * reason recorded when each began, as of the time the review is judged at; nothing for a task
 * never started.
 */
function TaskTime({ task, shown }: { task: Task; shown: Shown }) {
  const { start, end, now } = shown;
  const active = activeSeconds(task.timeline, now);
  const waiting = waitingSeconds(task.timeline, now);
  if (active === null || waiting === null) return null;
  const waits = workSegments(task.timeline).filter(
    (segment) => segment.state === "paused" && segment.start < end && (segment.end ?? now) > start,
  );
  return (
    <div aria-label={`Time of #${task.id}`} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <p>
        {formatSpan(active)} active, {formatSpan(waiting)} waiting
      </p>
      {waits.length > 0 && (
        <ul aria-label={`Waits of #${task.id}`} className="flex flex-col gap-0.5">
          {waits.map((wait) => (
            <li key={wait.start} className="break-words-keep">
              Waiting {formatSpan(Math.max((wait.end ?? now) - wait.start, 0))} from {formatDate(wait.start)}
              {wait.end === null && ", still waiting"}: {wait.reason ?? "no reason recorded"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PullRequestLink({ url, stats }: { url: string; stats: ReviewEntry["task"]["pullRequest"] }) {
  const number = pullRequestNumber(url);
  const open = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    openUrl(url).catch((error: unknown) => console.error(`Failed to open ${url}`, error));
  };
  return (
    <a
      href={url}
      title={stats ? `${url} \u00b7 ${pullRequestStats(stats)}` : url}
      aria-label={number ? `Pull request #${number}` : "Pull request"}
      onClick={open}
      onAuxClick={open}
      className="shrink-0 text-xs text-primary underline underline-offset-2 hover:no-underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
    >
      {number ? `#${number}` : "PR"}
    </a>
  );
}

function YearInReviewPanel({ entries }: { entries: ReviewEntry[] }) {
  const year = yearInReview(entries);
  if (year === null) return null;
  return (
    <section aria-labelledby="year-in-review-heading" className="flex flex-col gap-3 rounded-lg border p-3">
      <h3 id="year-in-review-heading" className="text-sm font-semibold">
        Year in review
      </h3>
      {year.pullRequests && (
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Merged pull requests</dt>
            <dd className="text-lg font-semibold">{year.pullRequests.pullRequests}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Lines changed</dt>
            <dd className="text-lg font-semibold">
              <span>+{year.pullRequests.additions}</span>
              <span className="text-muted-foreground"> / </span>
              <span>-{year.pullRequests.deletions}</span>
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Files changed</dt>
            <dd className="text-lg font-semibold">{year.pullRequests.changedFiles}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Reviews</dt>
            <dd className="text-lg font-semibold" title={formatReviews(year.pullRequests)}>
              {year.pullRequests.reviews}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                on {year.pullRequests.reviewed} of {year.pullRequests.pullRequests}
              </span>
            </dd>
          </div>
        </dl>
      )}
      {year.largest.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">Largest pull requests</h4>
          <ol aria-label="Largest pull requests" className="flex flex-col gap-1">
            {year.largest.map(({ task, pullRequest }) => (
              <li key={task.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <TaskTypeBadge type={task.taskType} />
                <span className="truncate font-medium">{task.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{pullRequestStats(pullRequest)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {year.research.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">Research conclusions</h4>
          <ul aria-label="Research conclusions" className="flex flex-col divide-y rounded-md border">
            {year.research.map(({ task, at, adopted }) => (
              <li key={task.id} className="flex flex-col gap-1 px-2 py-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <span className="truncate font-medium">{task.title}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                      adopted ? toneChip.success : toneChip.neutral,
                    )}
                  >
                    {adopted ? "Adopted" : "Not adopted"}
                  </span>
                  <When className="ml-auto shrink-0 text-xs text-muted-foreground" at={at} />
                </div>
                <p aria-label={`Research conclusion of #${task.id}`} className="whitespace-pre-line break-words-keep text-xs">
                  {task.completionNote ?? <span className="text-muted-foreground">No conclusion written.</span>}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {year.overruns.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">Largest estimate overruns</h4>
          <ol aria-label="Largest estimate overruns" className="flex flex-col gap-1">
            {year.overruns.map(({ task, estimated, actual }) => (
              <li key={task.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <TaskTypeBadge type={task.taskType} />
                <span className="truncate font-medium">{task.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  estimated {formatDuration(estimated)}, {formatDuration(actual)} active
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
  const plan = planVsActual(shown.end, entries, shown.now);
  // Archived tasks and saved reviews cannot be edited, so only live tasks count as missing a plan.
  const missing = editable ? entries.filter(({ archived }) => !archived).map(({ task }) => missingPlan(task)) : [];
  const withoutEstimate = missing.filter((fields) => fields.includes("estimate")).length;
  const withoutDueDate = missing.filter((fields) => fields.includes("dueDate")).length;
  if (plan === null && withoutEstimate + withoutDueDate === 0) return null;
  const missingSummary = (
    <div className="contents">
      <dt className="text-muted-foreground">Missing plan</dt>
      <dd>
        {[
          withoutEstimate > 0 && `${plural(withoutEstimate, "task")} without an estimate`,
          withoutDueDate > 0 && `${plural(withoutDueDate, "task")} without a due date`,
        ]
          .filter(Boolean)
          .join(", ")}
        ; add them from the marks on the tasks below
      </dd>
    </div>
  );
  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-3 rounded-lg border p-3">
      <h3 id="plan-heading" className="text-sm font-semibold">
        Plan vs actual
      </h3>
      {plan === null ? (
        <>
          <p className="text-sm">No reviewed task has an estimate or a due date, so there is nothing to compare yet.</p>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">{missingSummary}</dl>
        </>
      ) : (
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <div className="contents">
          <dt className="text-muted-foreground">Estimate vs active time</dt>
          <dd>{plan.time ? formatEstimateAccuracy(plan.time) : "No completed task had an estimate"}</dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">Due dates met</dt>
          <dd>{plan.dueDates ? formatDueRate(plan.dueDates) : "No completed task had a due date"}</dd>
        </div>
        {withoutEstimate + withoutDueDate > 0 && missingSummary}
      </dl>
      )}
      {plan !== null && plan.late.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">Late tasks</h4>
          <ul aria-label="Late tasks" className="flex flex-col gap-1">
            {plan.late.map((late) => (
              <li key={late.task.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <span className="flex min-w-0 max-w-full items-center gap-2">
                  <TaskTypeBadge type={late.task.taskType} />
                  <span className="truncate font-medium">{late.task.title}</span>
                </span>
                <span className={cn("ml-auto shrink-0 text-xs", toneText.danger)}>{lateDetails(late)}</span>
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
  const summary = summarize(shown.period, entries, workspaces, shown.timeZone);
  const busiestMonth = Math.max(1, ...(summary.completedPerMonth ?? []).map(({ count }) => count));
  return (
    <section aria-label="Summary" className="flex flex-col gap-3 rounded-lg border p-3">
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {summary.outcomes.map(({ outcome, count }) => (
          <div key={outcome} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{outcomeLabels[outcome]}</dt>
            <dd className="text-lg font-semibold">{count}</dd>
          </div>
        ))}
        {summary.notAdopted > 0 && (
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Not adopted</dt>
            <dd className="text-lg font-semibold">{summary.notAdopted}</dd>
          </div>
        )}
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Commits</dt>
          <dd className="text-lg font-semibold">{summary.commits}</dd>
        </div>
      </dl>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {durationKeys.map((key) => {
          const stat = summary[key];
          return (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{durationLabels[key]}</dt>
              <dd>
                {stat === null
                  ? "No data"
                  : `${formatDuration(stat.median)} (${stat.tasks} ${stat.tasks === 1 ? "task" : "tasks"})`}
              </dd>
            </div>
          );
        })}
        {summary.changes && (
          <div className="contents">
            <dt className="text-muted-foreground">Changes in completed pull requests</dt>
            <dd>{formatChanges(summary.changes)}</dd>
          </div>
        )}
        {summary.completedByType.length > 0 && (
          <div className="contents">
            <dt className="text-muted-foreground">Completed by type</dt>
            <dd>{summary.completedByType.map(({ taskType, count }) => `${taskType} ${count}`).join(", ")}</dd>
          </div>
        )}
        {summary.completedByWorkspace.length > 0 && (
          <div className="contents">
            <dt className="text-muted-foreground">Completed by workspace</dt>
            <dd>{summary.completedByWorkspace.map(({ workspace, count }) => `${workspace} ${count}`).join(", ")}</dd>
          </div>
        )}
      </dl>
      {summary.completedPerMonth && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">Completed per month</h3>
          <ul aria-label="Completed per month" className="flex flex-col gap-0.5">
            {summary.completedPerMonth.map(({ month, count }) => (
              <li key={month} className="flex items-center gap-2 text-xs">
                <span className="w-16 shrink-0 font-mono text-muted-foreground">{month}</span>
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
