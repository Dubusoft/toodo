// Review reports of a period as Markdown and CSV, rendered from the entries of
// `review_period` in the time zone of the reader (see `docs/architecture.md`, Review).

import type { ReviewEntry, Task } from "../../../../src/lib/api.ts";
import { addDays, midnight, readDay, yearMonth, zoned } from "./calendar.ts";
import type { TimeZone } from "./calendar.ts";
import {
  activeSeconds,
  estimatedSeconds,
  formatDuration,
  formatEstimate,
  formatSpan,
  nonEmpty,
  oneLine,
  OUTCOMES,
  outcomeLabel,
  pullRequestStats,
  segments,
  segmentSeconds,
  typeName,
  waitingSeconds,
} from "./format.ts";
import type { ReportPeriod } from "./period.ts";
import { summaryLines, yearInReviewLines } from "./summary.ts";

export type DueState = "on_time" | "late" | "overdue" | "upcoming";

export type LateTask = {
  readonly task: Task;
  readonly dueDate: string;
  readonly done: boolean;
  readonly secondsLate: number;
};

/** What a report is rendered from: the reviewed entries of the period, the names of the
 * workspaces, the time zone its days and times are in, and the time due dates and active
 * time are judged at. */
export class Report {
  constructor(
    readonly period: ReportPeriod,
    readonly entries: readonly ReviewEntry[],
    readonly workspaceNames: ReadonlyMap<number, string>,
    readonly timeZone: TimeZone,
    readonly now: number,
  ) {}

  date(at: number): string {
    return zoned(at, this.timeZone).toPlainDate().toString();
  }

  /** Local date and time as `YYYY-MM-DD HH:MM`, which spreadsheets read as a date. */
  dateTime(at: number): string {
    const time = zoned(at, this.timeZone);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${time.toPlainDate().toString()} ${pad(time.hour)}:${pad(time.minute)}`;
  }

  workspace(task: Task): string {
    return this.workspaceNames.get(task.workspaceId) ?? `workspace ${task.workspaceId}`;
  }

  completed(): ReviewEntry[] {
    return this.entries.filter((entry) => entry.outcome === "completed");
  }

  /** The end of the due day: a task completed before it is on time. */
  dueEnd(day: string): number | null {
    const due = readDay(day);
    const next = due === null ? null : addDays(due, 1);
    return next === null ? null : midnight(next, this.timeZone);
  }

  dueState(task: Task): DueState | null {
    const end = task.dueDate === null ? null : this.dueEnd(task.dueDate);
    if (end === null) return null;
    if (task.status === "done") {
      const completedAt = task.milestones.completedAt;
      if (completedAt === null) return null;
      return completedAt < end ? "on_time" : "late";
    }
    return this.now >= end ? "overdue" : "upcoming";
  }

  secondsPastDue(task: Task): number {
    const end = task.dueDate === null ? null : this.dueEnd(task.dueDate);
    if (end === null) return 0;
    const until = task.status === "done" ? (task.milestones.completedAt ?? this.now) : this.now;
    return Math.max(until - end, 0);
  }

  /** Completed tasks done late and open tasks past their due date, the latest first. An
   * open task is late once its due date passed before the end of the period, or before now
   * while the period is under way. */
  late(): LateTask[] {
    const cutoff = Math.min(this.now, this.period.end);
    const late: LateTask[] = [];
    for (const { task, outcome } of this.entries) {
      const dueDate = task.dueDate;
      if (dueDate === null) continue;
      if (task.status === "done") {
        if (outcome === "completed" && this.dueState(task) === "late") {
          late.push({ task, dueDate, done: true, secondsLate: this.secondsPastDue(task) });
        }
        continue;
      }
      const end = this.dueEnd(dueDate);
      if (end !== null && cutoff >= end) late.push({ task, dueDate, done: false, secondsLate: cutoff - end });
    }
    return late.sort((a, b) => b.secondsLate - a.secondsLate || a.task.id - b.task.id);
  }

  lateDetails(late: LateTask): string {
    const completedAt = late.task.milestones.completedAt;
    const finish = completedAt !== null && late.done ? `done ${this.date(completedAt)}` : "still open";
    return `due ${late.dueDate}, ${finish}, ${formatDuration(late.secondsLate)} ${late.done ? "late" : "overdue"}`;
  }

  /** `[estimated, active]` seconds of a completed task with an estimate and a recorded
   * active time. */
  estimatedAndActive(entry: ReviewEntry): [number, number] | null {
    const estimated = estimatedSeconds(entry.task.estimate);
    const actual = activeSeconds(entry.task.timeline, entry.at);
    return estimated === null || actual === null ? null : [estimated, actual];
  }

  /** The review as Markdown, for pasting into a report. */
  markdown(): string {
    const period = this.period;
    const lines = [`# ${period.title()}: ${period.label()}`, ""];
    const groups = OUTCOMES.map((outcome) => [outcome, this.entries.filter((entry) => entry.outcome === outcome)] as const)
      .filter(([, entries]) => entries.length > 0);
    if (groups.length === 0) {
      lines.push("No recorded activity.", "");
      return lines.join("\n");
    }
    summaryLines(this, lines, groups);
    if (period.kind === "year") yearInReviewLines(this, lines);
    const months = period.months();
    if (months.length >= 2) {
      lines.push("| Month | Completed |", "| --- | --- |");
      for (const month of months) {
        const count = this.completed().filter((entry) => yearMonth(zoned(entry.at, this.timeZone).toPlainDate()) === month).length;
        lines.push(`| ${month} | ${count} |`);
      }
      lines.push("");
    }
    for (const [outcome, entries] of groups) {
      lines.push(`## ${outcomeLabel(outcome)} (${entries.length})`, "");
      for (const entry of entries) this.entryLines(lines, entry);
      lines.push("");
    }
    return lines.join("\n");
  }

  private entryLines(lines: string[], entry: ReviewEntry): void {
    const task = entry.task;
    const notAdopted = task.resolution === "not_adopted";
    const details = [this.workspace(task), this.date(entry.at)];
    if (notAdopted) details.push("not adopted");
    if (task.resolution === "completed") details.push("Completed");
    if (task.estimate !== null) details.push(`estimate ${formatEstimate(task.estimate)}`);
    const due = nonEmpty(task.dueDate);
    if (due !== null) details.push(`due ${due}`);
    if (task.issue !== null) details.push(task.issue.url);
    details.push(...task.refs.filter((ref) => ref.startsWith("pr:")).map((ref) => ref.slice(3)));
    if (entry.pullRequest !== null) details.push(pullRequestStats(entry.pullRequest));
    lines.push(`- [${typeName(task.taskType)}] ${task.title} (${details.join(", ")})`);
    const note = nonEmpty(task.completionNote);
    if (note !== null) lines.push(`  - ${notAdopted ? "Conclusion" : "Note"}: ${oneLine(note)}`);
    const active = activeSeconds(task.timeline, this.now);
    const waiting = waitingSeconds(task.timeline, this.now);
    if (active !== null && waiting !== null) {
      lines.push(`  - Time: ${formatSpan(active)} active, ${formatSpan(waiting)} waiting`);
    }
    for (const wait of segments(task.timeline)) {
      const end = wait.end ?? this.now;
      if (wait.active || wait.start >= this.period.end || end <= this.period.start) continue;
      const still = wait.end === null ? ", still waiting" : "";
      const reason = wait.reason === null ? "no reason recorded" : oneLine(wait.reason);
      lines.push(`  - Waiting ${formatSpan(segmentSeconds(wait, this.now))} from ${this.date(wait.start)}${still}: ${reason}`);
    }
    for (const note of task.notes) {
      if (this.period.start <= note.at && note.at < this.period.end) {
        const label = { blocker: "Blocker", progress: "Progress", decision: "Decision" }[note.kind];
        lines.push(`  - ${label}: ${oneLine(note.body)}`);
      }
    }
    for (const commit of entry.commits) {
      const sha = Array.from(commit.sha).slice(0, 7).join("");
      lines.push(`  - \`${sha}\` ${commit.message.split("\n")[0] ?? ""}`);
    }
  }
}
