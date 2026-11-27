import { expect, test } from "bun:test";
import { csv } from "./csv.ts";
import { completed, entry, event, HOUR, local, render, snapshot, week } from "./report-fixtures.ts";

test("writes one CSV row per task with local times, quoted fields, and formulas kept as text", () => {
  const at = local(2026, 10, 13, 15);
  const done = completed(7, at);
  done.task.milestones.plannedAt = local(2026, 10, 1, 9);
  done.task.title = 'Fix "login", then\nlogout';
  done.task.refs.push("pr:https://github.com/acme/toodo/pull/3");
  done.task.issue = { number: 12, url: "https://github.com/acme/toodo/issues/12" };
  done.pullRequest = snapshot(3);
  done.task.completionNote = "Cut login time\n  in half, finally";
  done.task.resolution = "not_adopted";
  done.task.estimate = { unit: "hours", amount: 2 };
  done.task.dueDate = "2026-10-12";
  done.task.timeline = [
    event("planned", local(2026, 10, 1, 9)),
    event("in_progress", at - 3 * HOUR),
    event("in_review", at - 2 * HOUR),
    event("done", at),
  ];
  const working = entry(8, "planned");
  working.task.workspaceId = 9;
  working.task.title = "Plan café";
  working.task.timeline = [event("in_progress", at - 1800)];
  const link = entry(9, "planned");
  link.task.title = '=HYPERLINK("https://evil.example","Open")';
  link.task.completionNote = "@SUM(1+1)";
  link.task.estimate = { unit: "days", amount: -1.5 };

  // Two hours east of UTC: the times are local to the reader.
  const text = csv(render(week(), [done, working, link], "+02:00", at));

  expect(text).toBe(
    "\u{feff}" +
      [
        "Task,Workspace,Type,Title,Outcome,Outcome at,Resolution,Planned,Started,Awaiting completion,Completed,Merged,Pull request,Issue,Commits in period,Active hours,Waiting hours,Estimate,Estimate unit,Due date,Due status,Additions,Deletions,Changed files,Reviews,Completion note",
        '7,toodo,feat,"Fix ""login"", then\nlogout",Completed,2026-10-13 17:00,Not adopted,2026-10-01 11:00,,,2026-10-13 17:00,,https://github.com/acme/toodo/pull/3,https://github.com/acme/toodo/issues/12,0,3,0,2,hours,2026-10-12,Late,120,30,4,2,"Cut login time in half, finally"',
        "8,workspace 9,feat,Plan café,Planned,2026-10-13 17:00,,,,,,,,,0,0.5,0,,,,,,,,,",
        `9,toodo,feat,"'=HYPERLINK(""https://evil.example"",""Open"")",Planned,2026-10-13 17:00,,,,,,,,,0,,,-1.5,days,,,,,,,'@SUM(1+1)`,
      ].join("\r\n") +
      "\r\n",
  );
});
