// The summary and year-in-review sections of the Markdown report. Port of
// `src-tauri/src/commands/report/summary.rs`.

import { displayFloat } from "../../domain/rust.ts";
import type { PullRequestSnapshot, ReviewEntry, ReviewOutcome, Task } from "../../../../src/lib/bindings.ts";
import {
  activeSeconds,
  countBy,
  fixed,
  formatChanges,
  formatDuration,
  formatStat,
  median,
  nonEmpty,
  oneLine,
  outcomeLabel,
  plural,
  pullRequestStats,
  round,
  sumChanges,
  typeName,
} from "./format.ts";
import type { Report } from "./report.ts";

function present<T>(value: T | null): value is T {
  return value !== null;
}

function pullRequests(entries: readonly ReviewEntry[]): PullRequestSnapshot[] {
  return entries.map((entry) => entry.pullRequest).filter(present);
}

export function summaryLines(
  report: Report,
  lines: string[],
  groups: ReadonlyArray<readonly [ReviewOutcome, readonly ReviewEntry[]]>,
): void {
  const completed = report.completed();
  lines.push("## Summary", "");
  lines.push(`- ${groups.map(([outcome, entries]) => `${outcomeLabel(outcome)}: ${entries.length}`).join(", ")}`);
  lines.push(`- Commits: ${report.entries.reduce((total, entry) => total + entry.commits.length, 0)}`);
  const notAdopted = completed.filter((entry) => entry.task.resolution === "not_adopted").length;
  if (notAdopted > 0) lines.push(`- Concluded without merging (not adopted): ${notAdopted}`);
  if (completed.length > 0) {
    const join = (counts: Array<[string, number]>) => counts.map(([key, count]) => `${key} ${count}`).join(", ");
    lines.push(`- Completed by type: ${join(countBy(completed.map((entry) => typeName(entry.task.taskType))))}`);
    lines.push(`- Completed by workspace: ${join(countBy(completed.map((entry) => report.workspace(entry.task))))}`);
  }
  const changes = sumChanges(pullRequests(completed));
  if (changes !== null) lines.push(`- Changes in completed pull requests: ${formatChanges(changes)}`);
  const span = (from: (task: Task) => number | null) =>
    median(completed.flatMap((entry) => {
      const start = from(entry.task);
      return start === null ? [] : [entry.at - start];
    }));
  const durations: Array<[string, ReturnType<typeof median>]> = [
    ["Median lead time (planned to completed)", span((task) => task.milestones.plannedAt)],
    ["Median cycle time (started to completed)", span((task) => task.milestones.startedAt)],
    [
      "Median active time (started to completed, without pauses)",
      median(completed.map((entry) => activeSeconds(entry.task.timeline, entry.at)).filter(present)),
    ],
    ["Median review time (awaiting completion to merged)", span((task) => task.milestones.reviewAt)],
  ];
  for (const [label, stat] of durations) lines.push(`- ${label}: ${formatStat(stat)}`);
  const planned = report.entries.some((entry) => entry.task.estimate !== null || entry.task.dueDate !== null);
  if (planned) {
    const timed = completed.map((entry) => report.estimatedAndActive(entry)).filter(present);
    if (timed.length > 0) {
      const estimated = timed.reduce((total, [value]) => total + value, 0);
      const actual = timed.reduce((total, [, value]) => total + value, 0);
      lines.push(
        `- Estimate vs active time: ${formatDuration(estimated)} estimated, ${formatDuration(actual)} active (${plural(timed.length, "task")}, ${fixed(actual / estimated, 2)}x)`,
      );
    }
    const due = completed
      .map((entry) => report.dueState(entry.task))
      .filter((state) => state === "on_time" || state === "late");
    if (due.length > 0) {
      const onTime = due.filter((state) => state === "on_time").length;
      lines.push(`- Due dates met: ${onTime} of ${due.length} (${displayFloat(round((onTime / due.length) * 100))}%)`);
    }
  }
  lines.push("");
  if (!planned) return;
  const late = report.late();
  if (late.length === 0) return;
  lines.push(`## Late (${late.length})`, "");
  for (const task of late) {
    lines.push(`- [${typeName(task.task.taskType)}] ${task.task.title} (${report.lateDetails(task)})`);
  }
  lines.push("");
}

/** Merged pull requests, research conclusions, and estimate overruns of the tasks completed
 * in a year. */
export function yearInReviewLines(report: Report, lines: string[]): void {
  const completed = report.completed();
  const merged = completed.flatMap((entry) => (entry.pullRequest === null ? [] : [[entry.task, entry.pullRequest] as const]));
  const research = completed
    .filter((entry) => entry.task.taskType === "rnd")
    .sort((a, b) => a.at - b.at || a.task.id - b.task.id);
  const overruns = completed
    .flatMap((entry) => {
      const timed = report.estimatedAndActive(entry);
      return timed !== null && timed[1] > timed[0] ? [[entry.task, timed[0], timed[1]] as const] : [];
    })
    .sort(([a, aEstimated, aActual], [b, bEstimated, bActual]) => bActual - bEstimated - (aActual - aEstimated) || a.id - b.id)
    .slice(0, 3);
  if (merged.length === 0 && research.length === 0 && overruns.length === 0) return;
  lines.push("## Year in review", "");
  const totals = sumChanges(merged.map(([, pullRequest]) => pullRequest));
  if (totals !== null) {
    lines.push(`- Merged pull requests: ${formatChanges(totals)}`);
    lines.push(`- Reviews: ${plural(totals.reviews, "review")} on ${totals.reviewed} of ${plural(totals.pullRequests, "pull request")}`);
  }
  if (merged.length > 0) {
    const size = (pullRequest: PullRequestSnapshot) => pullRequest.additions + pullRequest.deletions;
    const largest = [...merged].sort(([a, aPr], [b, bPr]) => size(bPr) - size(aPr) || a.id - b.id);
    lines.push("- Largest pull requests:");
    for (const [task, pullRequest] of largest.slice(0, 3)) {
      lines.push(`  - [${typeName(task.taskType)}] ${task.title} (${pullRequestStats(pullRequest)})`);
    }
  }
  if (research.length > 0) {
    lines.push("- Research conclusions:");
    for (const { task } of research) {
      const note = nonEmpty(task.completionNote);
      const conclusion = note === null ? "" : `: ${oneLine(note)}`;
      lines.push(`  - ${task.title} (${task.resolution === "not_adopted" ? "not adopted" : "adopted"})${conclusion}`);
    }
  }
  if (overruns.length > 0) {
    lines.push("- Largest estimate overruns:");
    for (const [task, estimated, actual] of overruns) {
      lines.push(`  - [${typeName(task.taskType)}] ${task.title} (estimated ${formatDuration(estimated)}, ${formatDuration(actual)} active)`);
    }
  }
  lines.push("");
}
