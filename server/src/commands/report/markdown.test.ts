import { expect, test } from "bun:test";
import { completed, DAY, entry, event, HOUR, local, markdown, period, snapshot, week } from "./report-fixtures.ts";

test("leads with a summary then lists each outcome with its tasks and commits", () => {
  const done = entry(1, "completed");
  done.task.title = "Add login";
  done.task.refs.push("pr:https://github.com/acme/toodo/pull/3");
  done.task.milestones.plannedAt = done.at - 2 * DAY;
  done.task.milestones.completedAt = done.at;
  done.commits = [
    { taskId: 1, sha: "0123456789abcdef", message: "Add login form\n\nWith validation.", author: "Ada <ada@example.com>", committedAt: done.at },
  ];
  const worked = entry(2, "worked_on");
  worked.task.taskType = "fix";

  expect(markdown(week(), [worked, done])).toBe(
    [
      "# Week review: 2026-10-12 to 2026-10-18",
      "",
      "## Summary",
      "",
      "- Completed: 1, Worked on: 1",
      "- Commits: 1",
      "- Completed by type: feat 1",
      "- Completed by workspace: toodo 1",
      "- Median lead time (planned to completed): 2.0d (1 task)",
      "- Median cycle time (started to completed): no data",
      "- Median active time (started to completed, without pauses): no data",
      "- Median review time (awaiting completion to merged): no data",
      "",
      "## Completed (1)",
      "",
      "- [feat] Add login (toodo, 2026-10-13, https://github.com/acme/toodo/pull/3)",
      "  - `0123456` Add login form",
      "",
      "## Worked on (1)",
      "",
      "- [fix] Task 2 (toodo, 2026-10-13)",
      "",
    ].join("\n"),
  );
});

test("says so when the period has no recorded activity", () => {
  expect(markdown(period("year", "2026-01-01"), [])).toBe("# Year review: 2026\n\nNo recorded activity.\n");
});

test("adds a completed per month table for a period over several months", () => {
  const text = markdown(period("quarter", "2026-10-01"), [completed(1, local(2026, 11, 3, 0))]);
  expect(text.startsWith("# Quarter review: 2026 Q4\n")).toBe(true);
  expect(text).toContain("| Month | Completed |\n| --- | --- |\n| 2026-10 | 0 |\n| 2026-11 | 1 |\n| 2026-12 | 0 |\n");
});

test("adds pull request sizes completion notes and conclusions", () => {
  const at = local(2026, 10, 13, 15);
  const shipped = completed(1, at);
  shipped.pullRequest = snapshot(12);
  shipped.task.completionNote = "Sign-in is twice as fast\n  for everyone";
  const small = completed(2, at);
  small.pullRequest = { ...snapshot(13), changedFiles: 1, reviewCount: 1 };
  const research = completed(3, at);
  research.task.taskType = "rnd";
  research.task.resolution = "not_adopted";
  research.task.refs.push("pr:https://github.com/acme/toodo/pull/5");
  research.task.completionNote = "Twice as slow\nas the current cache";

  const text = markdown(week(), [shipped, small, research]);

  expect(text).toContain("- Concluded without merging (not adopted): 1\n");
  expect(text).toContain("- Completed by type: feat 2, rnd 1\n");
  expect(text).toContain("- Changes in completed pull requests: +240/-60 in 5 files (2 pull requests)\n");
  expect(text).toContain(
    "- [feat] Task 1 (toodo, 2026-10-13, #12, +120/-30 in 4 files, 2 reviews)\n  - Note: Sign-in is twice as fast for everyone\n",
  );
  expect(text).toContain("- [feat] Task 2 (toodo, 2026-10-13, #13, +120/-30 in 1 file, 1 review)\n");
  expect(text).toContain(
    "- [rnd] Task 3 (toodo, 2026-10-13, not adopted, https://github.com/acme/toodo/pull/5)\n  - Conclusion: Twice as slow as the current cache\n",
  );
});

test("shows active against waiting time and each wait in the period with its reason", () => {
  const waited = completed(1, local(2026, 10, 16, 12));
  waited.task.timeline = [
    event("planned", local(2026, 10, 1, 0)),
    event("in_progress", local(2026, 10, 2, 0)),
    event("planned", local(2026, 10, 2, 5), "Waiting on #2 API (planned)"),
    event("in_progress", local(2026, 10, 11, 0)),
    event("planned", local(2026, 10, 13, 3)),
    event("in_progress", local(2026, 10, 15, 3)),
    event("in_review", local(2026, 10, 16, 0)),
    event("done", local(2026, 10, 16, 12)),
  ];
  const pausedTimeline = () => [
    event("planned", local(2026, 10, 12, 0)),
    event("in_progress", local(2026, 10, 12, 1)),
    event("planned", local(2026, 12, 29, 0), "Waiting for the API design"),
  ];
  const paused = entry(3, "started");
  paused.task.status = "planned";
  paused.task.timeline = pausedTimeline();
  const neverStarted = entry(4, "planned");
  neverStarted.task.timeline = [event("planned", local(2026, 10, 12, 0))];

  const text = markdown(week(), [waited, paused, neverStarted]);

  // 5h + 51h + 21h + 12h active, 211h + 48h waiting; the first wait ended before the week,
  // so it is only summed.
  expect(text).toContain(
    "- [feat] Task 1 (toodo, 2026-10-16)\n  - Time: 3.7d active, 10.8d waiting\n  - Waiting 2.0d from 2026-10-13: no reason recorded\n",
  );
  expect(text).not.toContain("Waiting on #2");
  // A wait still under way counts until now and is in every period it overlaps.
  expect(text).toContain("- [feat] Task 3 (toodo, 2026-10-13)\n  - Time: 78.0d active, 2.0d waiting\n");
  expect(text.split("Task 4")[1]).not.toContain("Time:");

  const stillWaiting = entry(3, "started");
  stillWaiting.task.timeline = pausedTimeline();
  expect(markdown(period("month", "2026-12-01"), [stillWaiting])).toContain(
    "  - Waiting 2.0d from 2026-12-29, still waiting: Waiting for the API design\n",
  );
});

test("lists the notes left on a task during the period", () => {
  const working = entry(1, "started");
  working.task.notes = [
    { kind: "progress", body: "Planned last week", at: local(2026, 10, 11, 23) },
    { kind: "progress", body: "Chose PKCE\nover implicit flow", at: local(2026, 10, 13, 9) },
    { kind: "blocker", body: "No test account", at: local(2026, 10, 18, 23) },
    { kind: "progress", body: "Next week", at: local(2026, 10, 19, 0) },
  ];

  const text = markdown(week(), [working]);

  expect(text).toContain("- [feat] Task 1 (toodo, 2026-10-13)\n  - Progress: Chose PKCE over implicit flow\n  - Blocker: No test account\n");
  expect(text).not.toContain("Planned last week");
  expect(text).not.toContain("Next week");
});

test("adds the plan to the summary and a late section", () => {
  const ship = completed(1, local(2026, 10, 15, 10));
  ship.task.title = "Ship";
  ship.task.estimate = { unit: "hours", amount: 4 };
  ship.task.dueDate = "2026-10-14";
  ship.task.timeline = [event("in_progress", local(2026, 10, 15, 4)), event("done", local(2026, 10, 15, 10))];
  const open = entry(2, "started");
  open.task.dueDate = "2026-10-16";

  const text = markdown(week(), [ship, open]);

  expect(text).toContain("- Estimate vs active time: 4h estimated, 6h active (1 task, 1.50x)\n");
  expect(text).toContain("- Due dates met: 0 of 1 (0%)\n");
  expect(text).toContain(
    "## Late (2)\n\n- [feat] Task 2 (due 2026-10-16, still open, 2.0d overdue)\n- [feat] Ship (due 2026-10-14, done 2026-10-15, 10h late)\n",
  );
  expect(text).toContain("- [feat] Ship (toodo, 2026-10-15, estimate 4h, due 2026-10-14)");
});

test("adds a year in review section to a year only", () => {
  const at = local(2026, 5, 1, 12);
  const login = completed(1, at);
  login.task.title = "Add login";
  login.pullRequest = { ...snapshot(11), additions: 50, deletions: 10, changedFiles: 2 };
  const cache = completed(2, at);
  cache.task.taskType = "rnd";
  cache.task.resolution = "not_adopted";
  cache.task.title = "Try a cache";
  cache.task.completionNote = "Twice as slow\nas before";
  const overran = (id: number, estimate: number, activeHours: number) => {
    const overrun = completed(id, at);
    overrun.task.estimate = { unit: "hours", amount: estimate };
    overrun.task.timeline = [event("in_progress", at - activeHours * HOUR), event("done", at)];
    return overrun;
  };
  const entries = [login, cache, overran(3, 2, 3), overran(4, 1, 6), overran(5, 4, 2), overran(6, 1, 3), overran(7, 2, 4)];

  expect(markdown(period("year", "2026-06-01"), entries)).toContain(
    [
      "## Year in review",
      "",
      "- Merged pull requests: +50/-10 in 2 files (1 pull request)",
      "- Reviews: 2 reviews on 1 of 1 pull request",
      "- Largest pull requests:",
      "  - [feat] Add login (#11, +50/-10 in 2 files, 2 reviews)",
      "- Research conclusions:",
      "  - Try a cache (not adopted): Twice as slow as before",
      "- Largest estimate overruns:",
      "  - [feat] Task 4 (estimated 1h, 6h active)",
      "  - [feat] Task 6 (estimated 1h, 3h active)",
      "  - [feat] Task 7 (estimated 2h, 4h active)",
      "",
    ].join("\n"),
  );
  expect(markdown(period("quarter", "2026-06-01"), entries)).not.toContain("Year in review");
});
