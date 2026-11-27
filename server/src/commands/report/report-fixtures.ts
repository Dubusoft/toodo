import type {
  PullRequestSnapshot,
  ReviewEntry,
  ReviewOutcome,
  ReviewPeriodKind,
  TaskEvent,
  TaskStatus,
} from "../../../../src/lib/api.ts";
import { ReportPeriod } from "./period.ts";
import { Report } from "./report.ts";

export const HOUR = 3600;
export const DAY = 24 * HOUR;

export function local(year: number, month: number, day: number, hour: number): number {
  return Date.UTC(year, month - 1, day, hour) / 1000;
}

export function now(): number {
  return local(2026, 12, 31, 0);
}

export function period(kind: ReviewPeriodKind, day: string): ReportPeriod {
  const parsed = Temporal.PlainDate.from(day);
  const today = Temporal.PlainDate.from("2026-12-31");
  return kind === "week"
    ? ReportPeriod.resolve({ kind, date: null, from: parsed, to: null }, today, "UTC")
    : ReportPeriod.resolve({ kind, date: parsed, from: null, to: null }, today, "UTC");
}

export function week(): ReportPeriod {
  return period("week", "2026-10-12");
}

export function entry(id: number, outcome: ReviewOutcome): ReviewEntry {
  return {
    pullRequest: null,
    task: {
      id,
      workspaceId: 1,
      taskType: "feat",
      title: `Task ${id}`,
      description: "",
      status: "in_progress",
      resolution: null,
      dependsOn: [],
      issue: null,
      estimate: null,
      dueDate: null,
      labels: [],
      refs: [],
      completionNote: null,
      timeline: [],
      milestones: {
        plannedAt: null,
        startedAt: null,
        reviewAt: null,
        completedAt: null,
        reopenedAt: null,
        pausedAt: null,
        lastReviewAt: null,
        activeSeconds: 0,
        pauseCount: 0,
      },
      notes: [],
      criteria: [],
      wait: null,
      autopilot: false,
      autopilotAt: null,
    },
    outcome,
    at: local(2026, 10, 13, 15),
    commits: [],
    archived: false,
  };
}

export function completed(id: number, at: number): ReviewEntry {
  const done = entry(id, "completed");
  done.task.status = "done";
  done.task.milestones.completedAt = at;
  done.at = at;
  return done;
}

export function snapshot(number: number): PullRequestSnapshot {
  return {
    number,
    title: `Pull request ${number}`,
    additions: 120,
    deletions: 30,
    changedFiles: 4,
    mergeCommitSha: "abc123",
    reviewCount: 2,
    reviewerCount: 1,
    firstReviewedAt: null,
  };
}

export function event(status: TaskStatus, at: number, reason: string | null = null): TaskEvent {
  return { status, at, reopened: false, reason };
}

export function render(reportPeriod: ReportPeriod, entries: readonly ReviewEntry[], timeZone = "UTC", at = now()): Report {
  return new Report(reportPeriod, entries, new Map([[1, "toodo"]]), timeZone, at);
}

export function markdown(reportPeriod: ReportPeriod, entries: readonly ReviewEntry[]): string {
  return render(reportPeriod, entries).markdown();
}
