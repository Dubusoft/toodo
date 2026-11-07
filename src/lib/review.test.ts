import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewEntry, Task, Workspace } from "@/lib/bindings";
import {
  addDays,
  dayIn,
  filterEntries,
  formatDuration,
  groupByOutcome,
  periodContaining,
  periodLabel,
  planVsActual,
  reviewLabels,
  shiftPeriod,
  startOfWeek,
  summarize,
  weekStarting,
  yearInReview,
} from "@/lib/review";

afterEach(() => {
  vi.unstubAllEnvs();
});

const hour = 3600;
const reviewNow = new Date(2026, 11, 31).getTime() / 1000;
const day = 24 * hour;
const local = (year: number, month: number, date: number, hours = 0) =>
  new Date(year, month - 1, date, hours).getTime() / 1000;
// The fixtures are built in this machine's time zone, so the summaries are judged in it too.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function entry(
  id: number,
  outcome: ReviewEntry["outcome"],
  overrides: Partial<Task> = {},
  pullRequest: ReviewEntry["pullRequest"] = null,
): ReviewEntry {
  return {
    pullRequest,
    task: {
      id,
      workspaceId: 1,
      taskType: "feat",
      title: `Task ${id}`,
      description: "",
      status: "in_progress",
      dependsOn: [],
      issue: null,
      estimate: null,
      dueDate: null,
      labels: [],
      refs: [],
      resolution: null,
      completionNote: null,
      notes: [],
      criteria: [],
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
      ...overrides,
    },
    outcome,
    at: local(2026, 10, 13, 15),
    commits: [],
    archived: false,
  };
}

function completed(
  id: number,
  at: number,
  milestones: Partial<Task["milestones"]>,
  overrides: Partial<Task> = {},
  pullRequest: ReviewEntry["pullRequest"] = null,
) {
  const base = entry(id, "completed", { status: "done", ...overrides }, pullRequest);
  base.task.milestones = { ...base.task.milestones, ...milestones, completedAt: at };
  base.at = at;
  return base;
}

function snapshot(number: number): NonNullable<ReviewEntry["pullRequest"]> {
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

const toodo: Workspace = {
  id: 1,
  name: "toodo",
  description: null,
  repository: null,
  archivedAt: null,
};
const herdr: Workspace = { ...toodo, id: 2, name: "herdr" };

describe("startOfWeek", () => {
  it("finds the Monday of the week, Sunday included", () => {
    expect(startOfWeek(new Date(2026, 9, 12, 0, 0))).toBe("2026-10-12");
    expect(startOfWeek(new Date(2026, 9, 14, 11, 30))).toBe("2026-10-12");
    expect(startOfWeek(new Date(2026, 9, 18, 23, 59))).toBe("2026-10-12");
    expect(startOfWeek(new Date(2026, 10, 1, 9))).toBe("2026-10-26");
  });
});

describe("addDays", () => {
  it("moves across month and year ends", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2026-03-02", -7)).toBe("2026-02-23");
  });
});

describe("periodContaining", () => {
  it("finds the week, month, quarter, and year of a day", () => {
    expect(periodContaining("week", "2026-10-14")).toEqual({ kind: "week", from: "2026-10-12", to: "2026-10-18" });
    expect(periodContaining("month", "2026-02-14")).toEqual({ kind: "month", from: "2026-02-01", to: "2026-02-28" });
    expect(periodContaining("quarter", "2026-12-31")).toEqual({
      kind: "quarter",
      from: "2026-10-01",
      to: "2026-12-31",
    });
    expect(periodContaining("quarter", "2026-01-01")).toEqual({
      kind: "quarter",
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(periodContaining("year", "2026-10-14")).toEqual({ kind: "year", from: "2026-01-01", to: "2026-12-31" });
  });
});

describe("shiftPeriod", () => {
  it("moves whole periods across year ends", () => {
    expect(shiftPeriod(weekStarting("2026-12-28"), 1)).toEqual(weekStarting("2027-01-04"));
    expect(shiftPeriod(periodContaining("month", "2026-01-10"), -1)).toEqual({
      kind: "month",
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(shiftPeriod(periodContaining("quarter", "2026-11-01"), 1)).toEqual({
      kind: "quarter",
      from: "2027-01-01",
      to: "2027-03-31",
    });
    expect(shiftPeriod(periodContaining("year", "2026-05-01"), -2)).toEqual({
      kind: "year",
      from: "2024-01-01",
      to: "2024-12-31",
    });
  });

  it("moves a custom period by its length in days", () => {
    expect(shiftPeriod({ kind: "custom", from: "2026-12-30", to: "2027-01-02" }, 1)).toEqual({
      kind: "custom",
      from: "2027-01-03",
      to: "2027-01-06",
    });
  });
});

describe("dayIn", () => {
  it("names the day of a time in the given time zone, whatever this machine's is", () => {
    const at = Date.UTC(2026, 2, 31, 20) / 1000;

    expect(dayIn(at, "Asia/Seoul")).toBe("2026-04-01");
    expect(dayIn(at, "UTC")).toBe("2026-03-31");
    expect(dayIn(at, "America/Los_Angeles")).toBe("2026-03-31");
  });
});

describe("periodLabel", () => {
  it("names each kind of period", () => {
    expect(periodLabel(weekStarting("2026-10-12"))).toBe("2026-10-12 to 2026-10-18");
    expect(periodLabel(periodContaining("month", "2026-10-12"))).toBe("2026-10");
    expect(periodLabel(periodContaining("quarter", "2026-10-12"))).toBe("2026 Q4");
    expect(periodLabel(periodContaining("year", "2026-10-12"))).toBe("2026");
  });
});

describe("groupByOutcome", () => {
  it("orders groups from most advanced and drops empty ones", () => {
    const groups = groupByOutcome([entry(1, "planned"), entry(2, "completed"), entry(3, "planned")]);

    expect(groups.map((group) => [group.outcome, group.entries.map((e) => e.task.id)])).toEqual([
      ["completed", [2]],
      ["planned", [1, 3]],
    ]);
  });
});

describe("summarize", () => {
  const year = periodContaining("year", "2026-06-01");

  it("counts outcomes, commits, and completed tasks by type and workspace", () => {
    const fix = completed(2, local(2026, 3, 5), {}, { taskType: "fix", workspaceId: 2 });
    const worked = entry(4, "worked_on");
    worked.commits = [
      { taskId: 4, sha: "a", message: "A", author: "Ada", committedAt: worked.at },
      { taskId: 4, sha: "b", message: "B", author: "Ada", committedAt: worked.at },
    ];
    const summary = summarize(
      year,
      [completed(1, local(2026, 3, 1), {}), fix, completed(3, local(2026, 10, 1), {}), worked, entry(5, "started")],
      [toodo, herdr],
      zone,
    );

    expect(summary.outcomes).toEqual([
      { outcome: "completed", count: 3 },
      { outcome: "started", count: 1 },
      { outcome: "worked_on", count: 1 },
    ]);
    expect(summary.commits).toBe(2);
    expect(summary.completedByType).toEqual([
      { taskType: "feat", count: 2 },
      { taskType: "fix", count: 1 },
    ]);
    expect(summary.completedByWorkspace).toEqual([
      { workspace: "toodo", count: 2 },
      { workspace: "herdr", count: 1 },
    ]);
    expect(summary.completedPerMonth).toHaveLength(12);
    expect(summary.completedPerMonth?.[2]).toEqual({ month: "2026-03", count: 2 });
    expect(summary.completedPerMonth?.[9]).toEqual({ month: "2026-10", count: 1 });
    expect(summary.completedPerMonth?.[11]).toEqual({ month: "2026-12", count: 0 });
  });

  it("takes medians over completed tasks that reached both milestones", () => {
    const end = local(2026, 5, 20);
    const summary = summarize(
      year,
      [
        completed(1, end, { plannedAt: end - 10 * day, startedAt: end - 4 * day, reviewAt: end - day }),
        completed(2, end, { plannedAt: end - 2 * day, startedAt: end - 2 * day, reviewAt: end - 3 * hour }),
        completed(3, end, { plannedAt: end - 6 * day }),
        entry(4, "started", {
          milestones: { ...entry(4, "started").task.milestones, plannedAt: end - 100 * day, startedAt: end },
        }),
      ],
      [toodo],
      zone,
    );

    expect(summary.leadTime).toEqual({ median: 6 * day, tasks: 3 });
    expect(summary.cycleTime).toEqual({ median: 3 * day, tasks: 2 });
    expect(summary.activeTime).toBeNull();
    expect(summary.reviewTime).toEqual({ median: (day + 3 * hour) / 2, tasks: 2 });
  });

  it("leaves out durations without data and months for a period inside one month", () => {
    const summary = summarize(periodContaining("month", "2026-10-01"), [entry(1, "started")], [toodo], zone);

    expect(summary.leadTime).toBeNull();
    expect(summary.completedByType).toEqual([]);
    expect(summary.completedPerMonth).toBeNull();
    expect(summarize({ kind: "custom", from: "2026-10-30", to: "2026-11-02" }, [], [], zone).completedPerMonth).toEqual([
      { month: "2026-10", count: 0 },
      { month: "2026-11", count: 0 },
    ]);
  });

  it("leaves pauses out of the active time of completed tasks", () => {
    const end = local(2026, 5, 20);
    const resumed = completed(1, end, { startedAt: end - 10 * day }, {
      timeline: [
        { status: "planned", at: end - 20 * day, reopened: false, reason: null },
        { status: "in_progress", at: end - 10 * day, reopened: false, reason: null },
        { status: "planned", at: end - 9 * day, reopened: false, reason: null },
        { status: "in_progress", at: end - 2 * day, reopened: false, reason: null },
        { status: "in_review", at: end - day, reopened: false, reason: null },
        { status: "done", at: end, reopened: false, reason: null },
      ],
    });

    const summary = summarize(year, [resumed], [toodo], zone);

    expect(summary.cycleTime).toEqual({ median: 10 * day, tasks: 1 });
    expect(summary.activeTime).toEqual({ median: 3 * day, tasks: 1 });
  });

  it("counts completions per month in the time zone the period was judged in", () => {
    const spring = { kind: "custom" as const, from: "2026-03-01", to: "2026-04-30" };
    const lateOnMarch31 = completed(1, Date.UTC(2026, 2, 31, 20) / 1000, {});

    const count = (timeZone: string) =>
      summarize(spring, [lateOnMarch31], [toodo], timeZone).completedPerMonth?.find(({ count }) => count > 0)?.month;

    expect(count("UTC")).toBe("2026-03");
    expect(count("Asia/Seoul")).toBe("2026-04");
  });
});

describe("formatDuration", () => {
  it("shows hours below a day and days above", () => {
    expect(formatDuration(20 * 60)).toBe("<1h");
    expect(formatDuration(5 * hour + 40 * 60)).toBe("6h");
    expect(formatDuration(23.5 * hour)).toBe("1.0d");
    expect(formatDuration(36 * hour)).toBe("1.5d");
  });
});

describe("planVsActual", () => {
  const weekEnd = local(2026, 10, 19);
  const worked = (start: number, end: number): Task["timeline"] => [
    { status: "in_progress", at: start, reopened: false, reason: null },
    { status: "done", at: end, reopened: false, reason: null },
  ];

  it("compares estimates in any unit with active time and rates due dates of completed tasks", () => {
    const entries = [
      completed(1, local(2026, 10, 13, 12), {}, {
        estimate: { unit: "hours", amount: 2 },
        dueDate: "2026-10-13",
        timeline: worked(local(2026, 10, 13, 9), local(2026, 10, 13, 12)),
      }),
      completed(2, local(2026, 10, 15, 10), {}, {
        estimate: { unit: "hours", amount: 4 },
        dueDate: "2026-10-14",
        timeline: worked(local(2026, 10, 15, 9), local(2026, 10, 15, 10)),
      }),
      completed(3, local(2026, 10, 16), {}, {
        estimate: { unit: "days", amount: 0.5 },
        timeline: worked(local(2026, 10, 14, 9), local(2026, 10, 14, 21)),
      }),
      completed(4, local(2026, 10, 16), {}, { estimate: { unit: "hours", amount: 1 } }),
    ];

    const plan = planVsActual(weekEnd, entries, reviewNow);

    expect(plan?.time).toEqual({ tasks: 3, estimated: 18 * hour, actual: 16 * hour });
    expect(plan?.dueDates).toEqual({ tasks: 2, onTime: 1 });
    expect(plan?.late.map(({ task, done, secondsLate }) => [task.id, done, secondsLate])).toEqual([
      [2, true, 10 * hour],
    ]);
  });

  it("counts open tasks late once their due date passed before the end of the period or now", () => {
    const entries = [
      entry(1, "started", { dueDate: "2026-10-14" }),
      entry(2, "started", { dueDate: "2026-10-20" }),
      entry(3, "planned", { dueDate: "2026-10-12", status: "planned" }),
      // Done late, but completed outside this period.
      entry(4, "worked_on", {
        status: "done",
        dueDate: "2026-10-12",
        milestones: { ...entry(4, "worked_on").task.milestones, completedAt: local(2026, 10, 25) },
      }),
    ];

    const late = planVsActual(weekEnd, entries, local(2026, 10, 16, 6))?.late;

    expect(late?.map(({ task, done, secondsLate }) => [task.id, done, secondsLate])).toEqual([
      [3, false, 3 * day + 6 * hour],
      [1, false, day + 6 * hour],
    ]);
    expect(planVsActual(weekEnd, entries, reviewNow)?.late.map(({ task }) => task.id)).toEqual([3, 1]);
    expect(planVsActual(weekEnd, [entry(5, "started")], reviewNow)).toBeNull();
  });

});

describe("yearInReview overruns", () => {
  it("ranks completed tasks by how far their active time overran an hour estimate", () => {
    const overran = (id: number, estimate: number, activeHours: number) =>
      completed(id, local(2026, 5, 1, 12), {}, {
        estimate: { unit: "hours", amount: estimate },
        timeline: [
          { status: "in_progress", at: local(2026, 5, 1, 12) - activeHours * hour, reopened: false, reason: null },
          { status: "done", at: local(2026, 5, 1, 12), reopened: false, reason: null },
        ],
      });
    const entries = [overran(1, 2, 3), overran(2, 1, 6), overran(3, 4, 2), overran(4, 1, 3), overran(5, 2, 4)];

    const year = yearInReview(entries);

    expect(year?.overruns.map(({ task, estimated, actual }) => [task.id, estimated, actual])).toEqual([
      [2, hour, 6 * hour],
      [4, hour, 3 * hour],
      [5, 2 * hour, 4 * hour],
    ]);
  });
});

describe("yearInReview", () => {
  const at = local(2026, 6, 1);
  const sized = (number: number, additions: number, reviewCount: number) => ({
    ...snapshot(number),
    additions,
    deletions: 10,
    changedFiles: 2,
    reviewCount,
  });

  it("sums pull request snapshots and ranks the largest of completed tasks only", () => {
    const entries = [
      completed(1, at, {}, {}, sized(11, 50, 2)),
      completed(2, at, {}, {}, sized(12, 500, 0)),
      completed(3, at, {}, {}, sized(13, 90, 1)),
      completed(4, at, {}, {}, sized(14, 5, 3)),
      entry(5, "opened_for_review", {}, sized(15, 9000, 9)),
    ];

    const year = yearInReview(entries);

    expect(year?.pullRequests).toEqual({
      pullRequests: 4,
      additions: 645,
      deletions: 40,
      changedFiles: 8,
      reviews: 6,
      reviewed: 3,
    });
    expect(year?.largest.map(({ pullRequest }) => pullRequest.number)).toEqual([12, 13, 11]);
    expect(year?.research).toEqual([]);
  });

  it("lists completed research tasks, oldest first, with whether they were adopted", () => {
    const entries = [
      completed(1, local(2026, 9, 1), {}, { taskType: "rnd", resolution: "not_adopted", completionNote: "Too slow" }),
      completed(2, local(2026, 3, 1), {}, { taskType: "rnd", resolution: "merged" }),
      completed(3, at, {}, { resolution: "not_adopted" }),
      entry(4, "started", { taskType: "rnd" }),
    ];

    const year = yearInReview(entries);

    expect(year?.pullRequests).toBeNull();
    expect(year?.research.map(({ task, adopted }) => [task.id, adopted])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(yearInReview([entry(1, "started"), completed(2, at, {})])).toBeNull();
  });

});

describe("filterEntries", () => {
  const entries = [
    entry(1, "completed", { workspaceId: 1, labels: ["search"] }),
    entry(2, "started", { workspaceId: 2, labels: ["q4-goal", "search"] }),
    entry(3, "planned", { workspaceId: 2 }),
  ];
  const ids = (filtered: ReviewEntry[]) => filtered.map(({ task }) => task.id);

  it("keeps the tasks of the chosen workspace and label, every task without a filter", () => {
    expect(ids(filterEntries(entries, { workspaceId: null, label: null }))).toEqual([1, 2, 3]);
    expect(ids(filterEntries(entries, { workspaceId: 2, label: null }))).toEqual([2, 3]);
    expect(ids(filterEntries(entries, { workspaceId: null, label: "search" }))).toEqual([1, 2]);
    expect(ids(filterEntries(entries, { workspaceId: 1, label: "q4-goal" }))).toEqual([]);
  });

  it("offers the labels of the reviewed tasks once each, sorted", () => {
    expect(reviewLabels(entries)).toEqual(["q4-goal", "search"]);
  });
});
