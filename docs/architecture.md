# Architecture

This document describes the domain model and the main components of Toodo. It is a
starting point; refine it as implementation decisions are made.

## Purpose

Besides driving the work itself, Toodo is the record used to compile a year-end
performance report. For every task it must be able to answer when it was planned, when
work on it started, when its pull request was opened, when it was paused, and when it
was completed, and show how tasks depended on each other over time. Timeline data is
therefore part of the domain, not a UI detail: it is recorded at the moment each change
happens and never derived later from git or GitHub alone.

## Domain Model

### Workspace

A directory that tasks are planned against, usually the root of a git repository. A git
workspace is created by cloning a repository into a path, opening a repository already
cloned at a path, or initializing a new one; a workspace without git just records the
directory. See [workflow.md](workflow.md#1-register-a-workspace).

| Field | Description |
| --- | --- |
| `id` | Stable identifier. |
| `name` | Display name. |
| `kind` | `local` or `ssh`. |
| `path` | Absolute path to the repository root: a POSIX path on the server's machine for `local`, a POSIX path on the SSH machine for `ssh`, or a Windows drive or UNC path when that machine is a Windows host (see "Windows Hosts" in [server.md](server.md)). Local paths stored by older Toodo versions may be Windows paths (see [migrate-desktop-data.md](migrate-desktop-data.md)); such a workspace can be moved to the PC it lives on. |
| `herdrMachine` | For `ssh` workspaces: the SSH target of the saved herdr machine (usually a `~/.ssh/config` host alias); also used as the `ssh` host. |
| `defaultBaseBranch` | Branch that task branches start from and PRs target (e.g. `main`). Detected or entered at registration and editable afterwards from the workspace header, except while a task of the workspace is `in_review` (its open PR targets the current branch). |
| `agentMerge` | Whether agents merge their own task PR: `never` (default; they stop once the PR is open) or `afterChecks` (they merge it into `defaultBaseBranch` once every check on it passed, never into another branch). Editable from the workspace header; agents read it from the MCP `current_task` tool. Toodo itself never merges. |
| `source` | Where the work lives: `none` (a plain directory, no git), `local_git` (a git repository used locally only), or `github` (a git repository with an `origin` remote on GitHub). |
| `completion` | How a task is completed: `manual` (by its manual, `url`, or `command` criteria, with no merge criterion), `local_merge` (the task branch is merged into the base branch locally), or `pr_merge` (its pull request is merged). |
| `runner` | What runs the work: `herdr` (a task start creates a branch, a worktree, and a herdr workspace), `plain` (a task start creates a branch and a git worktree, and agent runs are child processes of the server, without herdr), `tmux` (like `plain`, but each agent run is a detached tmux session on the workspace's host), or `none` (a task start only changes its status). |

The three axes are chosen at creation and are read-only afterwards. One domain rule
(`check_axes`) checks every combination, from the app and from MCP alike:

- Source `none` needs completion `manual` and runner `none`.
- Source `local_git` allows completion `manual` or `local_merge`.
- Source `github` allows completion `manual` or `pr_merge`.
- Runner `none` allows only completion `manual`, since a merge needs the task branch that
  only a runner creates. Runners `herdr`, `plain`, and `tmux` need a git source and allow
  the same completions.
- Runner `plain` accepts local and SSH workspaces on POSIX or Windows hosts.
- Runner `tmux` accepts local and POSIX SSH workspaces. A Windows SSH path is rejected,
  with runner `plain` or `herdr` named as the choice that works there.

No default picks `plain`; a workspace uses it only when created with it explicitly.
Migration 33 widens the `runner` check of `workspaces` to allow it.

Migration 34 widens the `runner` checks of `workspaces` and `runtime_workspaces` to allow
`tmux`, and adds a check on `task_runs.runner_kind` (`herdr`, `plain`, `tmux`, `none`).
SSH workspaces with runner `herdr` and their saved herdr machines work as before.

An omitted axis gets its default from the source: `none` gives `manual` + `none`,
`local_git` gives `local_merge` + `herdr`, and `github` gives `pr_merge` + `herdr`. An
omitted source is `github` when the prepared repository has an `origin` remote,
`local_git` when it doesn't, and `none` when no repository is given.

Workspaces created before the axes existed were migrated from their tasks: one with a
`branch_merged_locally` criterion became `local_git` + `local_merge`, one with a
`pr_merged` or `pr_open_ci_green` criterion or a task pull request became `github` +
`pr_merge`, all with runner `herdr`. The rest keep `github` + `pr_merge` until a
background pass at server start checks their repository for an `origin` remote and
stores `github` + `pr_merge` or `local_git` + `local_merge`. A failed git call leaves the
workspace for the next start. Backups without the axes restore the same way.

### Machine Settings

Per-machine configuration. There is one entry for the local machine and one for each
saved herdr SSH machine that hosts a workspace.

| Field | Description |
| --- | --- |
| `machine` | `local` or the SSH target of the saved herdr machine. |
| `worktreeRoot` | Absolute directory under which task worktrees are created on that machine: a POSIX path, or a Windows path on a Windows host, of the same kind as the workspace paths there. Required before a task on that machine can be started. |

### Task Types

A fixed set; users cannot define their own types for now.

| Type | Use for |
| --- | --- |
| `feat` | A new feature. |
| `fix` | A bug fix. |
| `modify` | A change to existing behavior that is neither a new feature nor a bug fix. |
| `refactor` | Restructuring code without changing behavior. |
| `docs` | Documentation-only changes. |
| `test` | Adding or changing tests only. |
| `chore` | Build, tooling, dependency, or maintenance work. |
| `rnd` | Research and development: exploring an approach whose result may be not to adopt it (see [Conclude without merging](workflow.md#7b-conclude-without-merging)). |

### Worktree Layout and Branch Naming

Each task worktree is created at:

```
<worktreeRoot>/<workspace-name>/<task-type>-<task-name>-<task-id>
```

and checks out the task branch:

```
<task-type>/<task-name>-<task-id>
```

- `worktreeRoot` comes from the settings of the machine that hosts the workspace.
- `<workspace-name>` is the source workspace's name.
- `<task-type>` is the task's [type](#task-types).
- `<task-name>` is the task title; `<task-id>` keeps the path and branch unique even when
  titles repeat.
- Workspace and task names are converted to slugs that are safe both as directory names
  (no path separators, no characters invalid on Windows, no trailing dots or spaces) and
  as git ref components: lowercase ASCII letters and digits joined by single hyphens,
  at most 48 characters. Other characters, including non-ASCII letters, separate words.
  An empty result falls back to `workspace` or `task`, and Windows device names such as
  `con` get that word as a suffix (`con-workspace`).
- Path and branch are passed to herdr explicitly:
  `herdr worktree create --path <path> --branch <branch>`.

### Task

A unit of work inside a workspace.

| Field | Description |
| --- | --- |
| `id` | Stable identifier. |
| `workspaceId` | Owning workspace. |
| `type` | Kind of change, one of the [task types](#task-types). Used in the worktree path and branch name. |
| `title`, `description` | What should be implemented (English). |
| `estimate` | Optional expected size: an amount greater than 0 in `hours`, `days` (24 hours), `weeks` (7 days), or `months` (30 days) of active work. Reviews compare it with the task's active time. |
| `dueDate` | Optional calendar day (`YYYY-MM-DD`) the task should be done by. It is met when the task is completed before the end of that day in local time. |
| `status` | See [workflow.md](workflow.md#task-states). |
| `resolution` | How a `done` task ended: `merged` (completed once its completion criteria were met, e.g. by its merged pull request) or `not_adopted` (concluded without merging); `null` for every other status. Tasks done before Toodo recorded it are `merged`. |
| `dependsOn` | IDs of tasks that must be completed first. |
| `branch` | Branch created for the task's worktree. |
| `worktreePath` | Directory of the task's worktree. |
| `herdrWorkspaceId` | herdr workspace bound to the worktree, if any. |
| `pullRequestUrl` | Set when the PR is opened, as the task moves to `in_review`. |
| `issue` | GitHub issue of the workspace repository the task works on (number and URL), or `null`. Its pull request closes it on merge; see [workflow.md](workflow.md#2-plan-tasks). |
| `pullRequestMergedAt` | Merge time reported by GitHub (`mergedAt`), stored when a merged pull request is recorded. |
| `pullRequest` | Snapshot of the merged pull request taken when it completed the task: number, title, additions, deletions, changed files, merge commit SHA, submitted reviews and distinct reviewers other than its author, and the first review time. Stored in `pull_request_snapshots`; `null` for tasks completed before Toodo recorded it. |
| `mergedWith` | For a task `done` through the pull request of another task (see [workflow.md](workflow.md#7c-complete-through-another-tasks-pull-request)): that pull request's URL and the task that owns it (`null` once that task is deleted), or only the task when it shipped without a recorded pull request; `null` otherwise. |
| `completionNote` | What the user wrote about the outcome of a `done` task, for reviews; `null` until written. For a `not_adopted` task it is the required conclusion: why the work is not adopted. |
| `criteria` | Completion criteria in order: text, check kind (`manual`, `pr_merged`, `pr_open_ci_green`, `branch_merged_locally`, `url`, `command`), target (URL or command), state (`pending`, `met`, `failed`), evidence, and who checked it when. Stored in `task_criteria`; see [workflow.md](workflow.md#completion-criteria). |
| `timeline` | Status history of the task; see [Task Timeline](#task-timeline). |

### Task Timeline

Every task keeps an append-only status history. Each entry is a `TaskEvent`:

| Field | Description |
| --- | --- |
| `taskId` | Task the event belongs to. |
| `status` | Status the task moved to. |
| `at` | Time of the change, in seconds since the Unix epoch (UTC), from the clock of the machine running Toodo. Shown in the local time zone. |
| `reason` | Why the work stopped, on a move back to `planned`: the reason given to `pause_task`, the prerequisites a task paused by a new dependency waits on, or why it was reopened. `null` for other changes and for the app's Pause, which asks for no reason. |

- Creating a task records its initial status (`planned`). Every later status change
  records one event in the same transaction as the change itself. Dependency changes do
  not change a status, so they record nothing.
- Events are never edited or deleted on their own. Deleting a task or its workspace
  archives it (`archived_at` on `tasks` or `workspaces`): it leaves the task lists and the
  DAG, but its history, commits, and links stay, and reviews still report its work, marked
  archived. Settings > Archive restores it (`restore_task`, `restore_workspace`) or
  deletes it for good (`purge_task`, `purge_workspace`); only that purge removes its
  events, and it accepts archived items only.
- The milestones used by the timeline view and reports are derived from the history:

  | Milestone | Derived from |
  | --- | --- |
  | `plannedAt` | The first event (task creation). |
  | `startedAt` | The first move to `in_progress`; resuming a paused task keeps it. |
  | `reviewAt` | The first move to `in_review` (pull request opened, or every criterion met with a manual one awaiting confirmation). |
  | `completedAt` | The latest move to `done`, cleared when the task is reopened after it. |
  | `reopenedAt` | The latest move out of `done`, which only reopening makes (see [workflow.md](workflow.md#7d-reopen-a-done-task-or-correct-its-outcome)); each such event is marked `reopened`. |
  | `pausedAt` | The latest move back to `planned` after `startedAt`, cleared when the task is started again. |
  | `lastReviewAt` | The latest move to `in_review`; later than `reviewAt` when the task went back to review. |
  | `activeSeconds` | Seconds spent `in_progress` or `in_review` up to the latest status change, pauses left out. |
  | `pauseCount` | How often the task moved back to `planned` after `startedAt`. |

  When a task became ready to start is not recorded: it is the `completedAt` of its last
  dependency to be done.

- Tasks created before status history existed have no events; their milestones are
  unknown and are not guessed from git or GitHub.

### Task Dependencies (DAG)

- There is one DAG across all workspaces: a task may depend on a task of another
  workspace, for example an application change that needs a low-level library change
  first. Edges must never form a cycle, including cycles that pass through several
  workspaces.
- A task is **ready** when every task it depends on is `done`, in whichever workspace it
  lives; finishing a task can release dependents in other workspaces. Readiness is
  derived from the DAG whenever it is needed and is not a status.
- A workspace cannot be deleted while a `planned` task of another workspace depends on
  one of its tasks, since that task would silently become ready, or while a run of one of
  its tasks is queued or active. An archived task is left out of the DAG: its edges are
  kept but no longer hold back their dependents, and no new edge can reach it. Restoring
  it brings its edges back, and is rejected if they would close a cycle with edges added
  meanwhile.
- Dependents of a task can be planned at any time but only started (or resumed) once
  ready.
- Dependencies change while a task is `planned` or `in_progress`. A new prerequisite that
  is not done pauses an `in_progress` task in the same transaction (back to `planned`,
  with a status event). From the app its herdr workspace is closed afterwards, keeping the
  worktree; through MCP it stays open until the user closes it with
  `close_task_workspace` (see [workflow.md](workflow.md#task-states)).
- A topological order of the DAG is the suggested execution order.

### Related Tasks

- Tasks can also be **related**: context worth reading together, e.g. an earlier task
  whose decisions a new one builds on, or a follow-up of research that was not adopted.
- A related link is symmetric, may cross workspaces, and never affects readiness or
  starting a task; only dependencies do. Table `task_relations` stores each link once,
  from the lower task ID to the higher one, and purging a task drops its links.
- Related links are set through MCP only (`add_related` / `remove_related`); the app
  does not show them yet.

### CommitRecord

A commit produced while implementing a task.

| Field | Description |
| --- | --- |
| `taskId` | Task the commit belongs to. |
| `sha` | Full commit hash. |
| `message` | Commit subject (and body if available). |
| `author` | Commit author. |
| `committedAt` | Commit timestamp. |

Commits are discovered from the task branch, typically as
`git log <baseBranch>..<taskBranch>` run in the worktree.

### Git Activity

The git activity of a task is what happened in its git history, shown as "Git activity"
in the detailed task view. It is separate from the status history in Task Timeline.
Each event (`domain/activity.rs`, table `task_activity`) has:

| Field | Description |
| --- | --- |
| `kind` | `commit`, `pr_opened`, `checks_passed`, `checks_failed`, or `pr_merged`. |
| `source` | Where it was first learned from: `git_poll` or `github_poll`. |
| `externalRef` | Commit SHA of a commit; pull request URL when opened or merged; head commit SHA the checks ran on for a CI result. |
| `title` | Commit summary line, pull request title, or a short CI text (`CI passed on abc1234`). |
| `author` | Commit author, when known. |
| `occurredAt` | When it happened. |
| `receivedAt` | When Toodo first stored it. |
| `confirmedAt` | The latest time any source reported it again. |

Sources report the same event again on every check and in any order, so each event is
stored once per task under its dedup key `<kind>:<externalRef>`. The source is not part
of the key, so a GitHub webhook can later be added as another source without storing
events twice. A repeated report keeps the first `receivedAt`, `source`, `title`, and
`author`, takes the earlier `occurredAt` of both, and sets `confirmedAt` to its own time.
Events are listed by `occurredAt`, then by when they were first stored, so the arrival
order never changes the result.

The background check of pull requests records it for every `in_progress` or
`in_review` task with a branch, after looking up pull requests and before settling
tasks, so a merge is recorded before it completes the task: the commits of the branch
(`git_poll`) and, in a GitHub workspace for a task with a pull request, the pull
request opened, its CI result once final, and its merge (`github_poll`). When a task is
completed, its commit records (which include the merged pull request's commits) and the
merge of its pull request are recorded too.

Only a workspace whose source is a git repository (`local_git` or `github`) and whose
completion is not `manual` has git activity; for the others nothing is read with git
or `gh` and nothing is recorded.

## Timeline View

The dependency graph is drawn on a time axis instead of as a free-form layered DAG, so
the same picture shows both what depended on what and when it happened. The timeline
belongs to the "All workspaces" view, where it is the default (a workspace's own view is
a task list): it draws the tasks of every workspace together, each bar labeled with its
workspace, and can be narrowed to one workspace. Narrowed, prerequisites from other
workspaces are still drawn, dimmed and labeled with their workspace.

The app loads tasks in pages so its first screen stays quick however long the history
grows: every open task, the 100 newest done tasks, and the done tasks open ones depend
on. Where done tasks are shown (the timeline with a status filter that includes them, or
the task list's Done group), "Load older finished tasks" loads the next 100.

- It reads like a Gantt chart: a time axis header (coarse dates above fine dates or
  hours) stays at the top while the rows scroll, and a cursor marks the current time,
  refreshed every 30 seconds.
- Each task is a bar whose ends follow its status:
  - Never started (`planned` without a branch or `startedAt`): a fixed-width bar
    attached to the current-time cursor, moving with it.
  - Being worked on (`in_progress`, `in_review`): fixed at `startedAt`, its end attached
    to the current-time cursor.
  - Paused or done (`planned` after a start, `done`): fixed from `startedAt` to
    `pausedAt` (drawn faded) or `completedAt`.
  A started bar is split into phases from the status history: in progress, in review,
  and paused (back in `planned` until the task was resumed), so a paused and resumed
  task shows its pause as a gap. Without history the phases come from the milestones:
  in progress (`startedAt` to `reviewAt`) and in review (`reviewAt` to the end).
- The wait before a bar is drawn lighter than the bar, so bar length still reads as
  work: a marker at `plannedAt` and a dashed line from it to the bar, with a tick at
  the `completedAt` of its last prerequisite when the task became ready later than it
  was planned. The axis starts early enough to show the earliest `plannedAt`.
- Every task has its own row. Rows are in dependency order: a task comes after all the
  tasks it depends on, otherwise in order of start time. A task that has not started is
  also placed to the right of its prerequisites' bars, so a chain of waiting tasks reads
  left to right from the current time. Its bar is as long as its estimate at the current
  scale, or a small fixed box without one; its label sits past the bar's right end when
  it does not fit inside. The label of a bar that starts left of the visible range is
  pinned to the left edge behind a chevron, so rows stay readable while their bars are
  cut off.
- "Earliest task" pans to the bar that starts first, and "Today" back to where the
  timeline opens.
- Dependency edges run from the prerequisite's bar to the dependent's bar.
- The visible range can be zoomed (hour, day, week, month) and narrowed to a period such
  as a calendar year, the unit of a performance report.
- Started or closed tasks without the milestones to place them (tasks created before
  status history existed) are listed beside the timeline instead of on it.
- Dependencies can still be added and removed in this view, with the same rules as in
  the task list.
- A task with a due date gets a vertical marker at the end of its due day, inside its
  row and behind its label, and the axis reaches far enough to show it. A task done after that day, or still open past it, is
  outlined in red, and so is its marker.

## Plan View

"Plan" in the "All workspaces" view (`?view=plan`) shows whether a quarter or a year of
planned work fits, before it slips. Like the timeline it can be narrowed to one
workspace, and the search, status, and type filters apply.

- Each task counts in the calendar quarter or year of its due date, with its estimate
  converted to seconds as everywhere else (a day is 24 hours, a week 7 days, a month 30
  days). Done tasks count, since their work filled the period; tasks that were not
  adopted do not.
- Periods run without gaps from the earliest due date to the latest, and always include
  the current one. Each lists its tasks, the summed estimate, the part of it already done,
  and how many of its tasks have no estimate and so are left out of the sum.
- Tasks without a due date are listed apart under "No due date", with their summed
  estimate.
- The capacity is an amount of work per quarter in an estimate unit; a year holds four
  quarters. A period whose summed estimate is more than its capacity is highlighted as
  over capacity, with the excess. The capacity is saved in the browser (`localStorage`),
  like the theme; without one, no period is highlighted.

## Review

A report of the work recorded in a period, across all workspaces, for status updates and
for the year-end report. It is built only from recorded facts (status history, commit
records, pull request snapshots) and the completion notes the user wrote; nothing is
generated or guessed by an agent.

- The user picks a week (from any first day, by default the Monday of the current week),
  a calendar month, quarter, or year, or a custom range of days. The `review_period`
  command takes the first and last day, and the server turns them into the half-open
  period `[start, end)` from midnight of the first day to midnight after the last day in
  its review time zone, so the same days give the same numbers on every device.
- The review time zone is a server setting (`settings` table), changed from the Review
  page (Change time zone) or with `set_review_time_zone`; until one is set, it is the
  server's own time zone (UTC when that has no IANA name). The review's monthly counts are
  in it too.
- A review can be saved as a snapshot (Export > Save as snapshot, or
  `save_review_snapshot`): the server stores its reviewed tasks as JSON, the names of
  their workspaces, the time zone, and the Markdown and CSV reports in
  `review_snapshots`. Reopening it from Saved reviews shows and exports exactly what was
  saved, with durations and due dates judged at the time it was saved, however the tasks
  change later (for example when a task is reopened). Snapshots are kept until deleted and
  are not merged by `toodo-server import`.
- The review can be narrowed to one workspace and to one label. Labels (such as a
  project or goal) are free text set on a task in the app or through MCP
  (`create_task`, `update_task`); each is trimmed, at most 40 characters, without commas,
  and a task has at most 20. The summary, plan, and exports cover the narrowed tasks.
- A task is in the review when it reached a milestone or got a commit in the period.
  Its outcome is the most advanced milestone reached in the period, in this order:

  | Outcome | Reached in the period |
  | --- | --- |
  | Completed | `completedAt` |
  | Opened for review | `reviewAt` |
  | Started | `startedAt` |
  | Worked on | No milestone, but at least one commit (`committedAt`) |
  | Planned | `plannedAt` |

- Each task is listed once, under its outcome, with its workspace, the time of the
  outcome, its pull request (with its size and review count once merged), its completion
  note, and the commits it got in the period. A started task also shows its active time
  (`in_progress` or `in_review`) against its waiting time (back in `planned` after its
  first start: paused, blocked by a prerequisite, or reopened, until it was started
  again), and each wait in the period with the `reason` its event recorded; time still
  under way counts until now. The CSV export has both as `Active hours` and
  `Waiting hours`.
- Tasks without status history appear only through their commits.
- The commits of a task are its commit records (recorded when its branch is refreshed,
  its pull request opens, and it completes) and the commits its git activity recorded
  since, so a task in progress without a pull request shows its commits within a minute
  of the background check reading its branch.
- Work merged before Toodo tracked it can be imported from GitHub: "Import merged pull
  requests" on an empty review (`backfill_pull_requests`) records each pull request the
  signed-in `gh` user merged into the base branch of a GitHub workspace in the period as a
  task done as merged, planned, started, and in review when the pull request was opened
  and completed when it was merged. Its type comes from the branch prefix (`fix/...`) or a
  conventional title (`docs: ...`), else `modify`. A pull request a task already records,
  or whose branch a task of the workspace has, is skipped, so importing again adds nothing
  twice.
- A summary leads the review: the count of tasks per outcome, the commits made in the
  period, completed tasks by task type and by workspace, the summed size of their merged
  pull requests, and the median durations of the tasks completed in the period:

  | Duration | From | To |
  | --- | --- | --- |
  | Lead time | `plannedAt` | `completedAt` |
  | Cycle time | `startedAt` | `completedAt` |
  | Active time | `startedAt` | `completedAt`, counting only time `in_progress` or `in_review` |
  | Review time | `reviewAt` | `pullRequestMergedAt`, else `completedAt` |

  Cycle time includes pauses and active time leaves them out, so the two together show
  how long a task took and how long it was worked on. A task without one of the
  milestones (or without status history, for active time) is left out of that median. A period over several
  calendar months also counts the tasks completed in each month. The review screen also
  says how many completed tasks were concluded without merging (not adopted); the Markdown report marks those
  tasks "not adopted" and lists their conclusion.
- When reviewed tasks have estimates or due dates, a "Plan vs actual" section compares the
  plan with what happened: the summed estimates of the completed tasks against their
  summed active time, how many completed tasks met their due date,
  and the late tasks: those completed after their due date, and open tasks whose due date
  passed before the end of the period (or before now, while the period is under way).
  The Markdown report adds these lines to its summary and a "Late" section.
- A year review adds a "Year in review" section, also in its Markdown report, from the
  tasks completed in the year: their merged pull request snapshots summed (pull
  requests, lines added and deleted, changed files, and reviews with how many pull
  requests got one), the three largest pull requests by changed lines, every
  completed `rnd` task with whether it was adopted and its conclusion, and the three
  tasks whose active time overran their estimate the most.
- The review can be copied as Markdown, or saved as a Markdown or CSV file (one row per
  task with its milestones as local times, its resolution (`Merged` or `Not adopted`), its
  active hours so far, its estimate and unit, its due date and whether it was met (`On
  time`, `Late`, `Overdue`, or `Not due yet`), the size and review count of its pull request, and its completion
  note; UTF-8 with a byte
  order mark). The server renders both reports with the `review_report` command, in the
  review time zone unless the caller names another IANA time zone (the web app and
  `toodo review` name none unless asked), and the browser downloads the file.
  Agents get the same report from the MCP tool `review_report`, and the CLI prints it
  with `toodo review` (see [server.md](server.md)).
- Printing the review (Export > Print or save as PDF, or the browser's print command)
  leaves out the sidebar, the controls, and banners, and uses the light theme.

## Runtime Context

Toodo runs as `toodo-server` on a Linux machine next to an already installed and running
herdr. The server serves its commands over HTTP to the frontend, an installable web app
(PWA) used from a browser, and the server's machine is the "Local" machine; see
[server.md](server.md). herdr owns terminals, agents, worktree checkouts, and SSH machine
connections; Toodo owns planning, task state, commit records, and pull requests.

## Runtime Records

SQLite keeps a record of what runs where in seven tables (migrations 29 and 32):

- `runtime_workspaces`: one row per herdr workspace a task has had. Each row carries a
  `generation` that counts up per task, a `state` of `open` or `closed`, the
  `provider_workspace_ref` (the herdr workspace id), `checkout_path`, and `branch`. A task
  has at most one open row. `provider_instance` stays NULL until the herdr server behind
  the handle is verified.
- `agent_conversations`: an agent session a run can resume, with its `resume_kind`
  (`none`, `exact_id`, `exact_path`, `named_session`, `transcript`) and `resume_ref`.
- `task_runs`: one agent run of a task, with a `role` (`writer` or `observer`), a `state`
  (`reserved`, `running`, `settled`, `exited`, `failed`, `cancelled`, `unknown`), and an
  optional `runtime_workspace_id`. A run with no checkout has no runtime workspace.
  Starting a task of a workspace with runner none records a `writer` run with
  `runner_kind` `none`, no checkout, and no runtime workspace, and ends the task's earlier
  runs as `exited`. `last_activity_at` is when the agent last wrote output: a plain run
  stores it at most every 5 s while its stdout flows, a tmux run once its end is seen.
  `input_tokens` (cached ones included), `cached_input_tokens`, and `output_tokens` hold
  what the agent reported: Claude's `result.usage` (cache reads and writes count as
  input) or the sum of Codex's `turn.completed.usage`. The run view shows a running run
  as working while its last output is at most 2 minutes old, else as idle since then.
- `agent_status_transitions`: when the agent in a task's herdr workspace changed what it
  was doing (`idle`, `working`, `blocked`, `done`, or NULL once no agent was seen), with
  the time. A status is stored only when it differs from the last one stored for the
  task, so the first pane list after a restart adds nothing unless the agent changed
  while the server was down. Imports keep them with their tasks.
- `run_events`: the ordered history of a run, keyed by `run_id` and `sequence`.
- `run_operations`: the ledger of `launch`, `input`, and `stop` requests against a run,
  each `pending`, `applied`, or `failed`, with a `receipt`.
- `runtime_host_events`: an append-only journal of neutral workspace opened/closed
  observations, host state changes, and snapshot reconciles. Its `sequence` increases
  by one per owner and host; it is a local cursor, not a herdr subscription offset.
  Activity changes stay in memory and repeated host states do not consume a sequence.
- `runtime_hosts`: each host's `last_sequence`, `reconciled_sequence`, and state
  (`online`, `offline`, or `unknown`). Accepted subscriptions and successful Windows
  polls mark hosts online; unreachable servers are offline, and errors after an
  accepted event stream leave the host unknown.

Every table except `run_events` has `owner_key`, which defaults to `implicit`. It's a
placeholder for a later tenant context; nothing filters or authenticates by it yet. The
`host_ref` column names the host: `local` for a local workspace, `ssh:<target>` for an SSH
workspace, where the target is the workspace's `herdr_machine`.

The open runtime workspace is the source of truth for the herdr workspace of a task; the
task's `herdrWorkspaceId` is read from it. Storage writes it next to the task's checkout
path and branch, which stay on `tasks` since they outlive the herdr workspace: a cleared
or changed handle closes the open row, a new handle opens the next generation, and a moved
checkout updates the open row. Migration 29 backfilled one open row per task that had a
handle and created no runs; migration 31 brought the open rows in line with the handles
once more and dropped the old `tasks.herdr_workspace_id` column. Import skips all
runtime tables, including the host journal and cursors, since their handles and
observations belong to the other server's hosts.

A checkout has one active writer at a time. The partial unique index
`task_runs_one_active_writer` covers writer runs on the same owner, host, and checkout in
`reserved`, `running`, or `unknown`; `unknown` counts because a run whose end isn't
confirmed may still be writing. `reserve_run` reports a second writer as
`CheckoutHasActiveWriter`.

Launch is idempotent. Each run carries a `request_key`, unique per owner, and reserving
with a known key returns the existing run instead of a new one. Reservation also writes a
`pending` launch operation under the same key. Recording the launch marks it `applied` with
the herdr reference as receipt, a failed launch marks it `failed`, and a retried call
finds the operation already settled.

`RuntimeService` (`src-tauri/src/runtime/`) drives these records. Runners are handed to it
per call: a `TaskWorkspaceRuntime` for runtime workspaces and a `RunLauncher` for runs.

- Starting, resuming, and restoring a task open its runtime workspace through
  `open_workspace`. herdr creates or reopens the worktree, then the task records the handle
  and storage opens the record. The service returns the task together with that record.
  Starting a task ends the runs still active from before it was paused as `exited`.
- Opening a started task whose herdr workspace herdr no longer has (focus, panes) goes
  through `reopen_workspace`: herdr opens the kept checkout in a new herdr workspace, and
  the new handle opens the next generation of the record. The pane commands read the herdr
  workspace from the open record.
- Closing a paused task's herdr workspace, completing, concluding, and completing a task
  merged with another go through `close_workspace`. It closes the herdr workspace of the
  open record, then runs the storage change that forgets the handle under the same lock,
  and ends the active runs of the closed record as `exited`.
- Deleting a task that still has a worktree goes through `remove_workspace`. It removes the
  checkout through the herdr workspace of the open record, or reopens the checkout first
  when there is no open record or herdr no longer has it.
- Creating or moving a Toodo workspace opens its repository in herdr through
  `open_repository`. A move saves the workspace through `move_workspace`: moving to another
  host makes its tasks forget their herdr handles, which closes their records, and their
  active runs become `unknown`, since Toodo no longer sees the old host's herdr.
- The herdr `RunLauncher` runs a `RunCommand`. `NewTab` opens a new tab of the run's herdr
  workspace, labelled `toodo-run-<request key>`, and types the argument vector into the
  tab's pane; a retry finds the tab by its label and adopts it instead of opening another.
  `InPane` types a shell line as is into an existing pane, which nothing marks, so a launch
  whose response was lost cannot be adopted. The pane ID is the receipt.
- The MCP `start_task` tool runs `agent_command` through `start_run` as an `InPane` writer
  run in the first pane of the task's open runtime workspace, with request key
  `mcp-agent-<task>-<n>`.
- The plain `RunLauncher` (`PlainRunner`, `src-tauri/src/runtime/plain/`) runs a
  `RunCommand::Agent`; see Plain Runs below.

### Plain Runs

A task of a workspace with runner `plain` starts without herdr: Toodo creates the task
branch, runs `git worktree add` at the task's checkout path (reusing a worktree already
registered there), and records the task `in_progress` with no runtime workspace. Earlier
active runs of the task end as `exited`. Deleting such a task removes its worktree with
`git worktree remove` and keeps the branch. Starting a task launches no agent; runs are
started separately through `start_plain_run` (`src-tauri/src/commands/runs.rs`), only for
an `in_progress` task of a plain or tmux workspace that has a worktree, local or SSH.

`PlainRunner` lives in server state for the server's lifetime. Each run launches the
`claude` or `codex` CLI from the server's `PATH`:

- Claude: `claude -p --output-format stream-json --verbose --permission-mode <mode>`,
  plus `--model <model>` when one is set, plus
  `--mcp-config <run dir>/mcp.json --strict-mcp-config` with MCP.
- Codex: `codex exec --json <permission flags>`, plus `--model <model>` when one is set,
  plus
  `-c mcp_servers.toodo.url="<url>" -c mcp_servers.toodo.bearer_token_env_var="TOODO_MCP_TOKEN"`
  with MCP, then `-`.

The session id (Claude) or thread id (Codex) a run's agent reports is kept in an
`agent_conversations` row (`resume_kind` `exact_id`) that the run links to through
`conversation_id`; a follow-up run (`start_plain_run` with `follow_up_of`) joins the same
conversation and resumes its latest session with `--resume <id>` (Claude) or
`resume <id>` before `-` (Codex). A run's `followUpOf` is the latest earlier run of its
conversation.

A workspace's pull request options (`set_workspace_pull_request_options`, stored in the
`pull_request_draft`, `pull_request_reviewers`, and `pull_request_labels` columns of
`workspaces`, the lists as JSON arrays) set whether the pull requests Toodo opens for its
tasks are drafts and which reviewers and labels they get; see `docs/workflow.md`.

The model, permission mode, and time limit come from the task's agent options, and each
value the task leaves unset from its workspace's (`set_task_agent_options`,
`set_workspace_agent_options`, stored in the `agent_model`, `agent_permission_mode`, and
`run_time_limit_minutes` columns of `tasks` and `workspaces`). Without either, the agent
CLI's default model is used, Claude runs `bypassPermissions` and Codex `--full-auto`, and
the time limit is 4 hours. The permission modes map to the CLIs as follows; tmux runs use
the same flags but have no time limit.

| Mode | Claude `--permission-mode` | Codex |
| --- | --- | --- |
| `read_only` | `plan` | `--sandbox read-only` |
| `edit` | `acceptEdits` | `--full-auto` |
| `bypass` | `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

The child runs in its own process group with the task worktree as its working
directory, and its PID is the receipt (`pid:<pid>`). Every run gets a private directory
`<data dir>/runs/<run id>/` (mode 0700) holding `brief.md` (the prompt), `stdout.log`,
`stderr.log`, and for Claude with MCP `mcp.json`, all mode 0600. The prompt reaches the
child on stdin from `brief.md`, never in its arguments. Without a prompt, the brief is the
task title, description, and criteria, plus an instruction to call the MCP `current_task`
tool when MCP is on.

With MCP on, the child environment gets `TOODO_MCP_URL` and `TOODO_MCP_TOKEN` (the
server's MCP bearer). The token is only there: `mcp.json` refers to it as
`${TOODO_MCP_TOKEN}`, and every occurrence in both logs and in run event payloads is
replaced with `[redacted]`. With MCP off, both variables are removed from the child
environment and no MCP flags are passed.

Stdout is read as NDJSON lines, including a last line without a newline. Lines that
aren't JSON or aren't known events are logged and ignored, and a line over 1 MiB is
logged truncated and not parsed.

While the run is active, each change of the agent's todo list is appended as a `todo`
run event: a Claude `assistant` message with a `TodoWrite` tool use (`input.todos`), or a
Codex `item.started`, `item.updated`, or `item.completed` event of a `todo_list` item.
The payload is compact JSON `{"items":[{"text":"...","status":"pending"}]}` in the
agent's order, with status `pending`, `in_progress`, or `completed` (an unknown Claude
status becomes `pending`; a Codex item is `completed` or `pending`), at most 50 items of
at most 500 bytes of text each, and redacted like every payload. A list identical to the
last recorded one records nothing, and a failure to record it is logged without stopping
the run.

When the process ends, its outcome settles the run:

| Outcome | Run state | Events |
| --- | --- | --- |
| Success result, exit 0 | `settled` | `result` (summary, up to 4 KiB) |
| Error result (Claude `is_error`, Codex `turn.failed` or `error`) | `failed` | `result_error` |
| No result, exit 0 | `failed` | `no_result` |
| No result, non-zero exit or signal | `failed` | `stderr` (last 4 KiB, redacted), `exit` |
| Success result, then non-zero exit or signal | `exited` | `exit_after_result` |
| Time limit (4 hours unless set) | `failed` | `timed_out` |
| `stop_run` | `cancelled` | `stop_requested` |

A timeout or stop sends SIGTERM to the process group and SIGKILL 5 seconds later if it
is still alive. `stop_run` on a run with no live process marks it `cancelled` directly.
A missing CLI fails the launch with a message to install it on the server's `PATH` or use
the other adapter. Deleting a task through the app stops its live plain runs first;
completing or concluding it stops them once the completion succeeded.

A local agent runs under a small `sh` wrapper in its own process group that ignores
SIGHUP, records its PID and start time in `pid` and its exit code in `exit`, and writes the
agent's stdout and stderr to `stdout.raw` and `stderr.raw` in the run directory. The
server follows those files, so the agent neither needs nor notices the server process; the
redacted `stdout.log` and `stderr.log` replace the raw files once the run ended. `launch`
keeps the adapter and the timeout deadline.

When the server starts, it appends `server_restarted` to plain runs still `reserved` or
`running` from the previous process. A local run whose wrapper recorded its PID is
reattached (event `reattached`): while the agent with the recorded start time runs, the
server follows its output again (lines recorded before the restart are replayed without
new events) and its timeout keeps the original deadline; once it exits, the run settles
from its output and exit code with the outcome table above. An agent that is gone without
an exit code becomes `failed` with `interrupted`. Any other run becomes `unknown`. Since
`unknown` still counts as an active writer, `stop_run` on such a run (which cancels it)
frees the checkout for a new run.

The systemd unit from `toodo service install` sets `KillMode=process`, so stopping or
restarting the service ends only the server process, not the agents of its runs.

A machine's run limit is `machine_settings.max_concurrent_runs` (NULL for no limit). It
counts the plain and tmux runs on the host that are `reserved`, `running`, or `unknown`.
`start_plain_run` decides under a process-wide admission lock: when the host is at its
limit or already has queued runs, the run is recorded in state `queued` (event `queued`),
with its prompt and MCP choice in `queued_runs`, and nothing launches. The server's
`run-queue` thread starts queued runs oldest first per host while slots are free, after a
stop or a limit change and at least every 3 seconds: it checks the task again, moves the
run to `reserved` with a pending launch operation, and launches it through the same
request key, with the agent options current at that moment. A queued writer is in the
active writer index, so its task starts no second run; `stop_run` cancels it without
launching. Queued runs survive a restart and are picked up by the thread.

A second launch is guarded three ways: the request key (`plain-<task>-<n>`) makes
`start_run` idempotent, `PlainRunner` returns the receipt of a live launch with the same
key instead of spawning again, and the one-active-writer index rejects another writer on
the worktree. A process that ends before its launch is recorded still settles: the settle
path records the launch first.

### Remote Plain Runs

On an SSH workspace, `PlainRunner` runs the agent on the workspace's host over `ssh`.
`src-tauri/src/runtime/host.rs` builds every host command; the host's OS comes from the
workspace path style (`HostPath::is_windows`), and a Windows host is never treated as
POSIX. POSIX hosts get `sh` scripts. Windows hosts get PowerShell sent as
`powershell -EncodedCommand`, with native Windows quoting.

The server creates a persistent 12-character lowercase hex identity in
`<data dir>/instance-id` (mode 0600 on POSIX), independently of database backups.
Keep this file when restarting or restoring a database; do not share it between servers.
The first stage exclusively creates each run directory. If it already exists, remove the
leftover directory on the named host, then start a new run; no existing files are overwritten.

Each run stages a private run directory on the host, `~/.toodo/runs/<instance>/<run id>` (under
`%USERPROFILE%` on Windows; mode 0700 with 0600 files on POSIX). `brief.md`, the MCP
token file, and Claude's `mcp.json` reach it on the stdin of `ssh`, never in arguments.
A wrapper script in that directory starts the agent, records its PID and start time, and
writes its exit code to a file. On POSIX the wrapper runs under util-linux
`setsid --wait`, so it owns its own process group and its real exit code comes back; a
host without it fails the launch with a message to install util-linux `setsid` or use
runner `herdr`. The receipt is `ssh:<target>:<run id>`. Stdout and stderr stream back
through the same redaction, parsing, and outcome table as a local run.

`stop_run` first runs a stop script on the host. It checks that the recorded PID still
has the recorded start time, then sends SIGTERM and SIGKILL to the whole process group
(POSIX) or runs `taskkill /T /F` (Windows). If the host can't be reached, the run keeps
`stop_requested` and stays active, and the error says to restore the connection and
reconcile.

A lost connection is never taken as the agent exiting. When `ssh` fails without durable
exit evidence on the host, the run becomes `unknown` with `observation_lost` and keeps the
checkout; nothing is relaunched. After a server restart, remote plain runs become
`unknown` with `server_restarted` without contacting the host; once the server serves, a
background pass reconciles every remote plain and tmux run that is `unknown`, the way
`reconcile_run` does, and repeats for the runs it leaves `unknown` after 30 seconds,
doubling the wait up to 30 minutes, until none is left. A repeated finding adds no event.
`reconcile_run` settles such a run from the host's files: a recorded exit 0 becomes `exited`, another exit code
`failed`, a live agent stays `unknown` with `remote_still_running`, a vanished agent
becomes `failed` with `interrupted`, and a missing run directory stays `unknown` with
`remote_missing`. An unreachable host leaves the run as it was.

Once a remote run ends, its `token` and `mcp.json` are removed from the host; the brief,
logs, PID, and exit files stay. A failed cleanup appends `credential_cleanup_failed` and
doesn't change the outcome.

### MCP for Remote Runs

A remote agent reaches MCP through the reverse tunnel the server already keeps to every
machine with an SSH workspace (`src-tauri/src/mcp/tunnels.rs`), at
`http://127.0.0.1:<server port>/mcp` on that host. No new tunnel is opened per run. A run
with MCP on starts only while that machine's tunnel is open; otherwise the error says to
wait for the tunnel or start the run with MCP off. The bearer token is written to the run
directory's private `token` file and read by the wrapper into `TOODO_MCP_TOKEN`; it never
appears in argv (remote argv is visible in `ps`), logs, run events, or the database.

### tmux Runs

A workspace with runner `tmux` prepares tasks like runner `plain` (a git worktree, locally
or over `ssh`, without herdr), and `start_plain_run` starts its agent runs through
`TmuxRunner` (`src-tauri/src/runtime/tmux/`). It works on the server and on POSIX SSH
hosts, and tmux must be installed on the host that runs the agent; a missing tmux fails
the launch with a message to install it there.

Only a session whose request marker matches the launch request key and generation can be
adopted after a lost launch response. Each run is a detached session
`toodo-<instance>-run-<run id>` with the worktree as its working directory and receipt
`tmux:<local|ssh:host>:toodo-<instance>-run-<run id>`. Files are staged the same way as plain
runs, in `<data dir>/runs/<run id>` locally or `~/.toodo/runs/<instance>/<run id>` on the host,
and MCP uses the same token file and tunnel rules. The wrapper copies stdout and
stderr into `stdout.log` and `stderr.log`, kept apart from what the terminal shows, with
the token redacted. It writes the exit code, then signals `tmux wait-for`, which a monitor
in the server waits on to settle the run with the plain outcome table.

While a run is active, `get_run_log` returns an `attach` command (`tmux attach -t ...`,
or `ssh -t <host> ...` for a remote one) to watch the session in a terminal. It's a view
only; Toodo never drives the agent through it. `stop_run` kills the session and marks the
run `cancelled`.

Sessions outlive the server. On start, `TmuxRunner::recover_after_restart` checks local
runs: a live session is observed again (the run goes back to `running` with `recovered`),
an ended one settles from its exit file. Remote runs become `unknown` with
`observation_lost` without contacting the host, and the background pass described under
Remote Plain Runs settles them the same way, as `reconcile_run` does. A lost connection leaves the run `unknown` rather than ending it.

`commands/events.rs` translates herdr observations into neutral `RuntimeEvent` values
and applies them through `RuntimeService`. Events carry the existing `OwnerKey`
(`implicit` today); this introduces no tenant filtering. All matching uses the host:
identical provider references or pane IDs on two machines are unrelated. A close only
affects the task's open runtime workspace on that host. An open adopts a matching
checkout, except a reference used by a closed generation of that task on that host
cannot replace its current handle. Handle observations never rewrite earlier runs.

Immediately after a subscription is accepted, a read-only workspace snapshot reconciles
the host's tasks. An open reference still present stays unchanged; a matching checkout
under another reference is adopted with the same stale-reference guard. Missing
checkouts are left for lazy `reopen_workspace`, not cleared. Reconciliation journals a
`SnapshotReconciled` observation and saves its sequence as `reconciled_sequence`, so a
fresh subscription repairs missed open events after `events_lost`. Windows keeps its
pane polling path and does not reconcile workspace snapshots.

Migration 32 adds the host journal and cursor tables. Rollback means reverting this
event integration while leaving both tables and their journal rows in place; no runtime
path deletes journal history.

## Components

```
+-----------------+      +-------------------+      +------------------+
| Toodo UI (PWA)  | ---> | Toodo Core (Rust) | ---> | Storage (SQLite) |
| React + React   | HTTP | (tasks, DAG rules,|      | (workspaces,     |
| Flow, browser   | SSE  |  lifecycle)       |      |  tasks, commits) |
+-----------------+      +-------------------+      +------------------+
                                  |
          +-----------------------+------------------------+
          v                       v                        v
+-------------------+   +-------------------+   +----------------------+
| Workspace adapter |   | herdr adapter     |   | Git hosting adapter  |
| (git locally,     |   | (CLI commands +   |   | (gh CLI: push and    |
|  ssh + git        |   |  socket event     |   |  open pull requests) |
|  for remote)      |   |  subscription)    |   |                      |
+-------------------+   +-------------------+   +----------------------+
```

- **Toodo Core**: owns the domain rules: DAG validation, readiness, and the task state
  machine. It has no direct I/O; it calls adapters.
- **Workspace adapter**: runs `git` for local workspaces and `ssh <machine> git ...`
  for remote ones. Uses the server user's `~/.ssh/config` and ssh-agent, the same
  configuration herdr uses.
- **herdr adapter**: wraps herdr, an optional preinstalled dependency needed only for
  workspaces with runner `herdr` (runs of SSH workspaces with runner `plain` or `tmux` do not use it).
  - Runner health: the `runner_health` command reports whether `herdr` is on `PATH`, whether
    it is running, and its version, whether `tmux -V` runs and its version, and whether
    `claude` and `codex` are each on the server's `PATH`, together with the other tools the
    server runs: whether `git --version` and `ssh -V` run, and whether `gh --version` runs and
    `gh auth status` succeeds (each check stops after 10 seconds). Every tool that is not
    ready carries its next step. The web app shows it in a Runners section of Settings and
    in a banner that names each tool a workspace needs and that is not ready (git for local
    repositories, gh for GitHub workspaces, ssh for SSH workspaces, tmux and an agent CLI
    for local tmux or plain workspaces, herdr for herdr workspaces); `toodo init` prints the
    same checks as this shell sees them; the new-workspace runner step prefers `plain` when herdr is missing,
    and the runs panel disables an agent whose CLI is missing (for local workspaces only: an
    SSH workspace runs the agent CLIs of its host) and refreshes the open run while it is active. The server itself defaults
    an omitted runner of a local git workspace to `plain` when herdr is not running.
  - Startup health check: `herdr` on `PATH` and `herdr status --json` reports
    `server.running`. herdr 0.9.3 has no `ping` command.
  - Commands for SSH workspaces run against the remote herdr server with
    `herdr --machine <profile-id> ...`. `--machine` accepts only a saved profile ID or
    label, so the profile is looked up in `herdr machine list --json` by its SSH target
    on every call, preferring an enabled profile on the `default` session.
  - The sidebar lists Local and the machines of `herdr machine list --json`. Machines are
    added with `herdr machine add <host>` in a terminal on the server, since herdr asks
    questions there; the sidebar shows that command while it lists no remote machine.
    Toodo never installs herdr itself.
  - Failures exit non-zero and print `{"error": {"code", "message"}}` on stderr.
  - Commands use the herdr CLI.
  - Events use the socket API (`src-tauri/src/adapters/herdr_events.rs`,
    `src-tauri/src/commands/events.rs`): newline-delimited JSON over the server socket
    that `herdr status --json` reports as `server.socket`, a Unix domain socket.
    - The herdr server of an SSH machine is reached with `ssh -o BatchMode=yes -o
      ConnectTimeout=10 -W <socket path> -- <host>` (with the other options of
      `git::SSH_OPTIONS`), so an unreachable machine fails within seconds and is
      recorded offline. Short `ssh` commands to a machine (git, directory listings,
      remote herdr) share one connection through OpenSSH multiplexing
      (`git::SSH_SHARED_CONNECTION`). The command forwards ssh's standard input and output to the
      remote socket. The socket path comes from running the remote herdr over SSH
      (`herdr --session <saved session> status --json`, looked up on `PATH`, then in
      `~/.local/bin`, Homebrew, `/usr/local/bin`, and the Nix profile), because
      `herdr --machine <id> status server --json` reports a `machine:<id>/<session>`
      placeholder instead (verified on herdr 0.9.3).
    - One background thread keeps one `events.subscribe` connection to the local herdr
      server, and one more to the herdr server of each machine that hosts an SSH
      workspace (checked every 5 s; a machine's thread ends when its last workspace is
      deleted). Each subscribes to `worktree.created`, `worktree.opened`, `worktree.removed`,
      `workspace.closed`, `pane.created`, `pane.closed`, `pane.agent_detected`, and
      `pane.agent_status_changed` of every pane. Agent status subscriptions name one
      pane each and a connection takes one subscription, so a new pane means a new
      connection.
    - Lifecycle events arrive as `{"event": "worktree_removed", "data": {...}}`;
      pane-scoped ones keep the dotted name (`pane.agent_status_changed`). Neither
      `workspace.updated` nor `pane.updated` reports agent status changes (verified on
      herdr 0.9.3).
    - herdr IDs are scoped to one server, so a thread only touches the tasks of its own
      machine. `worktree.removed` forgets the worktree and herdr workspace of the task
      bound to that herdr workspace; `worktree.created`/`worktree.opened` stores the new
      herdr workspace of the task with that worktree path. The frontend gets a
      `TasksChanged` event and refetches the workspace's tasks.
    - Agent status is read again with `herdr [--machine <id>] pane list` on every pane
      or agent event
      instead of being patched from the event, as herdr recommends. The status of a task
      is the most urgent one among the panes of its herdr workspace (blocked, working,
      done, idle) and reaches the frontend through `list_agent_statuses` and the
      `AgentStatusesChanged` event. Each change is stored in `agent_status_transitions`
      before the event goes out; `list_agent_status_transitions` reads a task's history,
      which the task details show as its agent activity with the time worked.
    - When the subscription ends (herdr stopped, `events_lost`, `pane_not_found`), agent
      statuses are cleared and the thread subscribes again after 1 s, doubling up to
      30 s while the server stays unreachable.
  - Toodo does not embed a terminal; it focuses the herdr workspace instead.
  - Relevant commands:
  - `herdr worktree create|open|list|remove`: manage worktree-backed herdr workspaces.
  - `herdr workspace list|get|focus|close`: inspect and control herdr workspaces.
  - `herdr agent list|get|prompt|wait|read`: drive and observe agents in panes.
  - `herdr machine list|status|add`: saved SSH machines for remote workspaces.
  - `herdr api schema` / `herdr api snapshot`: API schema and live runtime state.
- **Git hosting adapter**: opens pull requests and reads or opens issues with the `gh` CLI, reusing its
  authentication (`src-tauri/src/adapters/github.rs`). `gh` runs on this machine and
  names the repository with `--repo <host>/<owner>/<name>`, derived from the `origin`
  remote URL, so it needs no local checkout. The task branch is pushed by the workspace
  adapter, on the machine that holds the worktree. Callers use the `GitHub` trait;
  `GhCli` is its `gh` backend, so another backend (such as the REST API) can be added
  without changing them.
- **MCP server** (`src-tauri/src/mcp/`): lets coding agents plan in Toodo while the server
  runs, so an agent can split its work into follow-up tasks and connect them, and start
  and finish other tasks without the user clicking through the app.
  - Served by `toodo-server` itself (rmcp, Streamable HTTP, stateless JSON responses) on
    `/mcp` of its port (`http://127.0.0.1:47616/mcp` by default), loopback only. Embedding
    it shares the database lock with the commands and emits `TasksChanged`, so the UI refreshes like after any
    command; a separate process would need its own SQLite locking and change
    notifications.
  - Every request needs `Authorization: Bearer <token>`. The token is 32 random bytes,
    hex encoded, created once in `mcp-token` in the server's data directory. rmcp also
    rejects non-loopback `Host` headers against DNS rebinding.
  - Resources (`mcp/resources.rs`): `toodo://tasks/{id}` and `toodo://tasks/{id}/runs`.
    A `subscriptions/listen` stream (protocol `2026-07-28`) keeps a snapshot of the
    resources it watches and reads them again whenever a `Notifier` event marks the
    server's change signal, and at least every 5 seconds, reporting each one whose
    content changed; see `docs/server.md` (Task and Run Resources).
  - Tools: `list_workspaces`, `list_tasks` (narrowed by `status`, `ready`, and `limit`,
    the newest matching tasks, paged back with `before_id`), `current_task` (the task whose worktree
    contains a given directory, after resolving `.` and `..`; an optional `machine`
    scopes it to one machine, and a path inside worktrees on several machines is
    rejected without it), `restore_worktree` (the app's Restore worktree for an active
    task whose worktree directory is gone), `create_task` (with optional `depends_on`; unknown
    prerequisites create nothing), `create_plan` (several tasks linked to each other by
    key and to existing tasks by ID, in one transaction; any failure creates nothing),
    `update_task`, `add_dependency` (several
    prerequisites in one call; it pauses an `in_progress` task they block but leaves its
    herdr workspace open, and the app asks the user whether to close it),
    `remove_dependency`, `pause_task` / `resume_task` (the app's Pause and Resume; the
    pause reason and an optional resume note become progress notes), the run tools for
    workspaces with runner plain or tmux (`start_run`, the app's Start run;
    `run_status`, one run or every run of a task with whether it may still be running and
    what to do next; `run_log`; `stop_run`; and `reconcile_run`, over the same commands
    as the app's runs panel), `pull_request_status` (the open pull request of an
    `in_review` task, or of all of them, as the background check last read it: state,
    combined and per-check CI state, review decision and latest reviews, read time, and
    what to do next; it never runs `gh`), and
    `add_progress_note` / `report_blocker`, which append a
    timestamped Markdown note (`progress`, `decision` with `kind: "decision"`, or
    `blocker`, table `task_notes`) to a task without changing its status. A task's `refs`
    (a JSON array of strings in `tasks.refs`, in the order they were added and searched
    with its branch) say where its work is tracked or discussed; `create_task`,
    `update_task`, `start_task`, and `complete_task` append to them and `update_task`
    `remove_refs` drops some. The `reason` of `start_task` and the `note` of
    `complete_task` are kept with the status change in `task_events.reason`, as pause
    reasons are, and the task details list them under Timeline. They reuse the storage rules, so cycles are rejected. The
    server instructions tell agents that work their task needs before it can finish is a
    prerequisite of their task, added last, and to note decisions and blockers as they
    work; Toodo never prompts agents itself. Notes show in the task list (latest) and the
    task details (all), and period reviews list the notes left during the period. Tool
    failures come back as tool errors whose text the agent sees, with the error's kind,
    code, and message (the codes of `POST /api/rpc`) as structured content
    `{ "error": { "kind", "code", "message" } }`; arguments a tool does not know are rejected, naming the ones it accepts.
  - `search_tasks` finds earlier tasks of all workspaces (or one, or one status) by words
    in their title, description, completion note and notes, branch, and pull request
    title and URL; every word must appear, and results come best match first with
    their `depends_on`, `dependents`, and `related` IDs; a task number alone (`431` or
    `#431`) puts that task first, in any workspace. `get_task` returns one task
    with its whole history (timeline, notes, completion note, pull request, commits)
    and its linked tasks (id, title, status). `add_related` / `remove_related` set
    [related links](#related-tasks). The instructions and the `toodo` skill tell agents
    to search before planning or creating tasks, to read what earlier tasks decided,
    and to use `add_dependency` only for real prerequisites and `add_related`
    otherwise.
  - Search runs on `task_search`, an FTS5 table with the trigram tokenizer (bundled
    SQLite), so any substring of three or more characters matches in any language,
    ranked by bm25 with the title weighted highest. Words shorter than three
    characters, such as two-character Korean words, are matched with `LIKE` instead.
    Every word is quoted (FTS5) or escaped (`LIKE`), so operators, `*`, quotes, and
    parentheses are plain text. Triggers on `tasks`, `task_notes`, and
    `pull_request_snapshots` keep the index in sync with every write.
  - `start_task`, `complete_task`, and `conclude_task` run the app's own commands
    (`commands::herdr::start`, `commands::completion::complete` and `conclude`) on a
    blocking thread, with the same adapters, checks, and status history, and emit
    `TasksChanged`. Starting creates or reopens the worktree like Start or Resume and is
    rejected for the same reasons (not ready, not `planned`, no worktree root);
    completing needs a merged pull request, as the background check does. Concluding
    differs in one rule: a task whose pull request is still open is rejected instead of
    closing it, because closing a pull request stays a decision for the user in the app.
  - An MCP request does not say which session sent it, so nothing in code stops an
    agent from finishing its own task; the server instructions, tool descriptions, and
    the `toodo` skill tell agents never to start, complete, or conclude the task
    `current_task` finds for them, since its pull request's merge completes it.
  - `delete_task` and `reopen_task` change nothing unless called with `confirm: true`;
    without it the reply says what the change would do. `delete_task` deletes only
    `planned` tasks, through the app's Delete; `reopen_task` runs the app's Reopen with
    the same checks. Both are local-only.
  - `archive_workspace` works the same way: without `confirm: true` it only describes
    the change, and with it archives the workspace through the app's Remove. It is
    rejected while a task of the workspace is `in_progress` or `in_review`, and it is
    local-only.
  - Agent access in Settings copies an MCP client config with the URL and token
    (`mcp_server_info`), tests that the server accepts that token, and shows the server
    instance and the last request `/mcp` turned away with its reason. `401` bodies at
    `/mcp` and `/api` say why a request was turned away and name the next step.
  - `start_task` exports `TOODO_MCP_URL` and `TOODO_MCP_TOKEN` (read from `mcp-token`
    when the line runs) before the `agent_command` it runs in the task's pane.
  - Agents on SSH machines reach the server through reverse tunnels
    (`src-tauri/src/mcp/tunnels.rs`): while the server runs, Toodo keeps one
    `ssh -v -N -R 127.0.0.1:<port>:127.0.0.1:<port> -- <host>` (the server's own port) per machine with an SSH
    workspace (`BatchMode`, `ExitOnForwardFailure`, `ServerAliveInterval=15`,
    `ControlPath=none` so the forward never outlives the process in a shared master
    connection). Agents there use the same URL and token as local ones.
  - A tunnel counts as open once ssh logs `remote forward success`. One that ends,
    e.g. because the remote port is taken by another Toodo, is opened again after
    1 s, doubling up to 30 s; the delay resets once a tunnel opens. Tunnels of
    machines without workspaces are stopped, and all of them when the server exits. The
    Agent access section of Settings lists each machine's tunnel state and last error
    (`list_mcp_tunnels`); its tab and the sidebar's Settings entry count retrying tunnels.
  - The forwarded port listens on the remote loopback only, so other users of that
    machine can reach it; the bearer token keeps them out.
- **OAuth server** (`src-tauri/src/oauth/`): the single-owner authorization server that lets
  chat apps reach `/mcp` when `TOODO_PUBLIC_URL` is set. It serves discovery metadata,
  dynamic client registration and client ID metadata documents, the consent page (the
  owner approves with `web-token`), and the token and revocation endpoints. Grants carry
  an owner key and the scopes `toodo.read` and `toodo.write`; tokens and secrets are
  stored as SHA-256 hashes in `storage/oauth.rs`, while codes and pending consents stay in
  memory. The MCP server checks OAuth access tokens after the static token and limits
  those sessions to the tools that run no git, herdr, gh, or ssh command. Off by default,
  when its routes are not mounted.
- **Storage**: SQLite database `toodo.sqlite3` in the server's data directory (`TOODO_DATA_DIR`)
  for workspaces, machine settings, tasks, dependencies, and commit records
  (`src-tauri/src/storage/`).
  - The schema is versioned with `PRAGMA user_version` and migrated forward on startup;
    a database from a newer Toodo version is refused rather than modified.
  - Workspace and task IDs are never reused after a delete, because task IDs are part of
    branch and worktree names.
  - Writes that touch the task DAG run in one transaction: new edges are validated
    against the DAG rules, and starting a task checks in the same transaction that all
    its dependencies are done.
  - Every task status change appends a row to the task's status history in the same
    transaction (see [Task Timeline](#task-timeline)).
  - Deleting a workspace or task archives it; only purging an archived one deletes its
    tasks, dependency edges, commit records, and status history.

## Decisions

- Target: `toodo-server` on Linux, used through the web app (PWA) in a browser.
- herdr is optional, needed only for runner `herdr`; Toodo checks that it is running and never
  installs it.
- Backend in Rust (tokio); frontend in React + TypeScript with React Flow for the DAG.
- External tools are invoked as processes (`herdr`, `git`, `ssh`, `gh`) rather than
  reimplemented through libraries.
- Worktree location is configured per machine (`worktreeRoot`); worktree paths and branch
  names are derived from task type, name, and ID; see
  [Worktree Layout and Branch Naming](#worktree-layout-and-branch-naming).
- herdr CLI output is parsed as JSON. herdr CLI commands print the same
  `{"id": ..., "result": ...}` envelope as the socket API (verified for `workspace list`,
  `worktree list`, and `agent list` on herdr 0.9.3). Any command found not to return JSON
  is sent over the socket instead.
- Commits are recorded automatically: when it opens or updates a task's pull request,
  Toodo runs `git log <baseBranch>..<taskBranch>` in the worktree and stores the result. While a task
  is in progress, the user can refresh commit records manually.
- Storage uses SQLite through `rusqlite` (single-user local app; no async pool needed).
- Pull requests target GitHub only, through the `gh` CLI.
- Task types are a fixed set (see [Task Types](#task-types)).
- Toodo is used for year-end performance reporting, so every task status change is
  timestamped and kept as history, and the dependency graph is drawn on a time axis
  (see [Timeline View](#timeline-view)).

## Deferred

Out of the first scope; revisit when needed.

- User-defined task types.
- Git hosting providers beyond GitHub (for example GitLab), added as another Git hosting
  adapter.
- A herdr plugin for in-herdr actions such as "complete task".
- Rotating the MCP access token from the UI.
- Correcting timeline timestamps by hand, for example to enter work done before the task
  was created in Toodo.
