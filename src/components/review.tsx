import { useEffect, useRef, useState } from "react";
import { CalendarCheck, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { TaskTypeBadge } from "@/components/task-type-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/task-list";
import { inputClass } from "@/components/workspace-list";
import type { ReviewEntry, ReviewOutcome, TaskId, Workspace } from "@/lib/bindings";
import { useReview, useWorkspaces } from "@/lib/queries";
import {
  commitSubject,
  durationKeys,
  durationLabels,
  formatChanges,
  formatDuration,
  formatDueRate,
  formatEstimateAccuracy,
  formatReviews,
  groupByOutcome,
  lateDetails,
  outcomeLabels,
  periodBounds,
  periodContaining,
  periodLabel,
  periodNouns,
  periodTitles,
  planVsActual,
  pullRequestStats,
  reviewCsv,
  reviewFileName,
  reviewMarkdown,
  shiftPeriod,
  summarize,
  weekStarting,
  yearInReview,
  type PeriodKind,
  type ReviewPeriod,
} from "@/lib/review";
import { toneChip, toneFill, toneText } from "@/lib/status-styles";
import { When } from "@/components/when";
import { formatDate } from "@/lib/timeline";
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

/** The pull request number of a GitHub pull request URL. */
function pullRequestNumber(url: string): string | null {
  return /\/pull\/(\d+)/.exec(url)?.[1] ?? null;
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

export function Review({ onShowTask }: { onShowTask?: (id: TaskId) => void }) {
  const [period, setPeriod] = useState<ReviewPeriod>(() => periodContaining("week", formatDate(Date.now() / 1000)));
  const [notice, setNotice] = useState<string | null>(null);
  const { start, end } = periodBounds(period);
  const review = useReview(start, end);
  const workspaces = useWorkspaces();
  const names = new Map(workspaces.data?.map((workspace) => [workspace.id, workspace.name]));
  const noun = periodNouns[period.kind];

  function moveTo(next: ReviewPeriod) {
    setNotice(null);
    setPeriod(next);
  }

  function switchKind(kind: PeriodKind) {
    if (kind === period.kind) return;
    moveTo(kind === "custom" ? { ...period, kind } : periodContaining(kind, period.from));
  }

  async function copyMarkdown(entries: ReviewEntry[]) {
    try {
      await navigator.clipboard.writeText(reviewMarkdown(period, entries, workspaces.data ?? [], Date.now() / 1000));
      setNotice("Copied as Markdown.");
    } catch (error) {
      setNotice(`Could not copy: ${String(error)}`);
    }
  }

  function saveAs(extension: "md" | "csv", entries: ReviewEntry[]) {
    const workspaceList = workspaces.data ?? [];
    const contents =
      extension === "csv"
        ? reviewCsv(entries, workspaceList, Date.now() / 1000)
        : reviewMarkdown(period, entries, workspaceList, Date.now() / 1000);
    // The report is for the user, not the server: the browser downloads it.
    const name = reviewFileName(period, extension);
    download(name, contents, extension === "csv" ? "text/csv" : "text/markdown");
    setNotice(`Downloaded ${name}`);
  }

  return (
    <section aria-labelledby="review-heading" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 id="review-heading" className="text-xl font-semibold tracking-tight">
          {periodTitles[period.kind]}
        </h2>
        <p className="text-sm text-muted-foreground">
          Work recorded from {period.from} to {period.to} across all workspaces.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
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
        <div className="ml-auto">
          <ExportMenu disabled={!review.data}>
            {(close) => (
              <>
                <MenuItem
                  onSelect={() => {
                    close();
                    if (review.data) void copyMarkdown(review.data);
                  }}
                >
                  Copy as Markdown
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    if (review.data) void saveAs("md", review.data);
                  }}
                >
                  Save as Markdown
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    if (review.data) void saveAs("csv", review.data);
                  }}
                >
                  Save as CSV
                </MenuItem>
              </>
            )}
          </ExportMenu>
        </div>
      </div>

      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}

      {review.isPending && <p className="text-sm text-muted-foreground">Loading the review...</p>}
      {review.isError && (
        <p role="alert" className="text-sm text-destructive">
          Failed to load the review: {review.error.message}
        </p>
      )}
      {review.data?.length === 0 && (
        <EmptyState
          title={`No recorded activity in this ${noun}.`}
          hint="Pick another period to look at earlier work."
          action={
            <Button size="sm" variant="outline" onClick={() => moveTo(shiftPeriod(period, -1))}>
              Show the {noun} before
            </Button>
          }
        />
      )}
      {review.data && review.data.length > 0 && (
        <ReviewSummaryPanel period={period} entries={review.data} workspaces={workspaces.data ?? []} />
      )}
      {review.data && <PlanPanel period={period} entries={review.data} />}
      {period.kind === "year" && review.data && <YearInReviewPanel entries={review.data} />}
      {review.data &&
        groupByOutcome(review.data).map((group) => (
          <section key={group.outcome} aria-label={outcomeLabels[group.outcome]} className="flex flex-col gap-2">
            <h3 className={cn("text-sm font-semibold", outcomeStyles[group.outcome])}>
              {outcomeLabels[group.outcome]}{" "}
              <span className="font-normal text-muted-foreground">({group.entries.length})</span>
            </h3>
            <ul className="flex flex-col divide-y rounded-lg border">
              {group.entries.map(({ task, at, commits }) => (
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
                    {task.resolution === "completed" && (
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", toneChip.success)}>Completed</span>
                    )}
                    {task.pullRequestUrl && (
                      <PullRequestLink url={task.pullRequestUrl} stats={task.pullRequest} />
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground max-md:hidden">
                      {names.get(task.workspaceId) ?? `Workspace ${task.workspaceId}`} &middot; <When at={at} />
                    </span>
                  </div>
                  {task.completionNote && (
                    <p aria-label={`Completion note of #${task.id}`} className="whitespace-pre-line break-words-keep text-xs">
                      {task.completionNote}
                    </p>
                  )}
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
function PlanPanel({ period, entries }: { period: ReviewPeriod; entries: ReviewEntry[] }) {
  const plan = planVsActual(period, entries, Date.now() / 1000);
  if (plan === null) return null;
  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-3 rounded-lg border p-3">
      <h3 id="plan-heading" className="text-sm font-semibold">
        Plan vs actual
      </h3>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <div className="contents">
          <dt className="text-muted-foreground">Estimate vs active time</dt>
          <dd>{plan.time ? formatEstimateAccuracy(plan.time) : "No completed task had an estimate"}</dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">Due dates met</dt>
          <dd>{plan.dueDates ? formatDueRate(plan.dueDates) : "No completed task had a due date"}</dd>
        </div>
      </dl>
      {plan.late.length > 0 && (
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
  period,
  entries,
  workspaces,
}: {
  period: ReviewPeriod;
  entries: ReviewEntry[];
  workspaces: Workspace[];
}) {
  const summary = summarize(period, entries, workspaces);
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
