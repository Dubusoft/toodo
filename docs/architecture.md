# Architecture

This document describes the domain model and the main components of Toodo.

## Purpose

Toodo does two things. It keeps tasks and the dependencies between them as a DAG, so
it's always clear what can start now and what waits on what. And it keeps the work
memory of every task: what it's for, what was decided, what blocked it, why it started,
paused, or ended, and when each of those happened.

Executing the work isn't Toodo's job. Worktrees, branches, coding agents, pull requests,
CI, and merges happen outside Toodo, run by the agent or person doing the work (an
executor such as Dori, or a developer at a terminal). That executor writes the results
into Toodo through MCP or the web app: it starts the task, adds notes, moves the task to
review, and completes or concludes it. The server runs no git, gh, ssh, or agent
commands.

The same records feed the year-end performance report. For every task Toodo can answer
when it was planned, started, sent to review, paused, and completed, and show how tasks
depended on each other over time. Timeline data is therefore part of the domain, not a
UI detail: it's recorded at the moment each change happens.

## Domain Model

### Workspace

A group of tasks, usually the work on one repository. A workspace doesn't need a
directory or a repository; a channel or a project fits too.

| Field | Description |
| --- | --- |
| `id` | Stable identifier. |
| `name` | Display name. |
| `description` | Optional Markdown about the workspace. |
| `repository` | Optional free text naming where the work lives, such as `dev-bokdong/toodo` or `discord:<channel>`. Toodo doesn't interpret it; a GitHub `owner/repo` form is shown as a link. |
| `archivedAt` | Set when the workspace is archived (removed from the app); `null` otherwise. |

MCP tools: `list_workspaces`, `create_workspace`, `update_workspace`,
`archive_workspace`.

A workspace also holds **guidelines**, which agents read before working on one of its
tasks. Each entry has an `id`, its `workspaceId`, a `kind`, a Markdown `body` (trimmed,
not empty, at most 4000 characters), `createdAt`, and `updatedAt`. The kinds:

- `rule`: set by the owner; agents must follow it and change it only when the user asks.
- `memory`: a durable lesson or fact about the workspace, often recorded by an agent.

They are listed rules first, then memories, each by ascending id. `get_task` and the
`start_task` reply include the guidelines of the task's workspace.

MCP tools: `get_guidelines`, `add_guideline`, `update_guideline`, `remove_guideline`.

### Task Types

A fixed set; users can't define their own types for now.

| Type | Use for |
| --- | --- |
| `feat` | A new feature. |
| `fix` | A bug fix. |
| `modify` | A change to existing behavior that is neither a new feature nor a bug fix. |
| `refactor` | Restructuring code without changing behavior. |
| `docs` | Documentation-only changes. |
| `test` | Adding or changing tests only. |
| `chore` | Build, tooling, dependency, or maintenance work. |
| `rnd` | Research and development: exploring an approach whose result may be not to adopt it. |

### Task

A unit of work inside a workspace.

| Field | Description |
| --- | --- |
| `id` | Stable identifier. |
| `workspaceId` | Owning workspace. |
| `type` | Kind of change, one of the [task types](#task-types). |
| `title`, `description` | What the task is for. The description is GitHub-flavored Markdown with `## Purpose` and `## Background` sections. |
| `estimate` | Optional expected size: an amount greater than 0 in `hours`, `days` (24 hours), `weeks` (7 days), or `months` (30 days) of active work. Reviews compare it with the task's active time. |
| `dueDate` | Optional calendar day (`YYYY-MM-DD`) the task should be done by. It's met when the task is completed before the end of that day in local time. |
| `labels` | Free text such as a project or goal; each trimmed, at most 40 characters, without commas, at most 20 per task. |
| `status` | `planned`, `in_progress`, `in_review`, or `done`; see [workflow.md](workflow.md#task-states). |
| `resolution` | How a `done` task ended: `completed`, `not_adopted` (concluded without adopting it), or `merged` (historic, for tasks completed before the tracker-only model); `null` for every other status. |
| `dependsOn` | IDs of tasks that must be done first; see [Task Dependencies](#task-dependencies-dag). |
| `related` | IDs of [related tasks](#related-tasks). |
| `issue` | A reference to a linked GitHub issue, stored with `link_issue`. Toodo doesn't create issues. |
| `refs` | Where the work is tracked or discussed; see [Refs](#refs). |
| `notes` | Progress, blocker, and decision notes; see [Notes](#notes). |
| `completionNote` | What was written about the outcome of a `done` task. For a `not_adopted` task it's the required conclusion: why the work isn't adopted. |
| `criteria` | Completion criteria; see [Completion Criteria](#completion-criteria). |
| `timeline` | Status history; see [Task Timeline](#task-timeline). |

Tasks completed before the tracker-only model may also carry a pull request snapshot and
commit records. Those are kept read-only for past reviews; nothing new is recorded in
them.

### Task Dependencies (DAG)

- There's one DAG across all workspaces: a task may depend on a task of another
  workspace, for example an application change that needs a library change first.
  Edges must never form a cycle, including cycles through several workspaces, and a task
  can't depend on itself.
- A task is **ready** when it's `planned` and every task it depends on is `done`, in
  whichever workspace it lives. Finishing a task can release dependents in other
  workspaces. Readiness is derived from the DAG whenever it's needed and is not a status.
- `start_task` is rejected while a prerequisite isn't done; the message names it.
  Dependents can be planned at any time.
- A task concluded as `not_adopted` doesn't release its dependents: they stay blocked
  until the dependency is removed or replaced.
- Dependencies change while a task is `planned` or `in_progress`. A new prerequisite that
  isn't done pauses an `in_progress` task in the same transaction (back to `planned`,
  with a status event naming the prerequisites it waits on).
- An archived task is left out of the DAG: its edges are kept but no longer hold back
  their dependents, and no new edge can reach it. Restoring it brings its edges back, and
  is rejected if they would close a cycle with edges added meanwhile. A workspace can't be
  archived while a `planned` task of another workspace depends on one of its tasks.
- A topological order of the DAG is the suggested execution order.

### Related Tasks

- Tasks can also be **related**: context worth reading together, such as an earlier task
  whose decisions a new one builds on, or a follow-up of research that wasn't adopted.
- A related link is symmetric, may cross workspaces, and never affects readiness or
  starting a task; only dependencies do. Table `task_relations` stores each link once,
  from the lower task ID to the higher one, and purging a task drops its links.
- Related links are set through MCP (`add_related`, `remove_related`).

### Refs

A task's `refs` say where its work is tracked or discussed. They're an ordered,
de-duplicated list of strings (`tasks.refs`, a JSON array, in the order they were
added). The convention is `<kind>:<value>`, for example `lane:<key>`,
`discord:<thread>`, `pr:<url or number>`, or `branch:<name>`; a plain `http(s)://` URL is
shown as a link. Toodo stores refs without interpreting them.

- `create_task`, `update_task`, `start_task`, and `complete_task` append refs;
  `update_task` with `remove_refs` drops some.
- `search_tasks` searches refs along with the rest of the task.
- `current_task` finds a task by a ref (for example `ref: "lane:search"`). Without a ref,
  the executor reads its task with `get_task` by ID.

### Notes

Notes are timestamped Markdown entries on a task (table `task_notes`) that don't change
its status. There are three kinds:

| Kind | Added with | Use for |
| --- | --- | --- |
| `progress` | `add_progress_note` | What was done or found along the way. |
| `decision` | `add_progress_note` with `kind: "decision"` | A choice made and why. |
| `blocker` | `report_blocker` | What stops the work. |

Decisions are the task's work memory. `get_task` returns them with the other notes and
the review report lists them, so a later task (found with
`search_tasks` and read with `get_task`) can see what was decided and why without going
back to chat logs or pull requests.

### Completion Criteria

Each task has an ordered list of criteria (table `task_criteria`): text, kind, target,
state (`pending`, `met`, `failed`), evidence, and who checked it when.

| Kind | Checked by |
| --- | --- |
| `manual` | A person or the executor, with `check_criterion` and evidence. |
| `url` | Toodo itself: an HTTP GET of the target passes on a 2xx response. This is the only outside call the server makes. |

`complete_task` succeeds once every `manual` criterion is checked and every `url`
criterion passes. Toodo doesn't check whether a pull request merged; the executor checks
that before it calls `complete_task`. Older criterion kinds (`pr_merged`,
`pr_open_ci_green`, `branch_merged_locally`, `command`) were turned into `manual`
criteria by a migration, checked when they had been met. `create_task` takes
`merge_criterion: false` to add no merge criterion. See
[workflow.md](workflow.md#completion-criteria).

### Task Timeline

Every task keeps an append-only status history. Each entry is a `TaskEvent`:

| Field | Description |
| --- | --- |
| `taskId` | Task the event belongs to. |
| `status` | Status the task moved to. |
| `at` | Time of the change, in seconds since the Unix epoch (UTC), from the server's clock. Shown in the local time zone. |
| `reason` | The note recorded with the change, or `null`. |

Status changes carry their reasons, so the history explains itself:

- `start_task` takes an optional `reason`: why the work starts now.
- `pause_task` requires a `reason`. A task paused by a new prerequisite records the
  prerequisites it waits on, and reopening records why.
- `complete_task` and `conclude_task` record their `note`, which is also the task's
  completion note.

The task details list these under Timeline.

- Creating a task records its initial status (`planned`). Every later status change
  records one event in the same transaction as the change itself. Dependency changes
  don't change a status, so they record nothing.
- Events are never edited or deleted on their own. Deleting a task or its workspace
  archives it (`archived_at` on `tasks` or `workspaces`): it leaves the task lists and the
  DAG, but its history and links stay, and reviews still report its work, marked
  archived. Settings > Archive restores it (`restore_task`, `restore_workspace`) or
  deletes it for good (`purge_task`, `purge_workspace`); only that purge removes its
  events, and it accepts archived items only.
- The milestones used by the timeline view and reports are derived from the history:

  | Milestone | Derived from |
  | --- | --- |
  | `plannedAt` | The first event (task creation). |
  | `startedAt` | The first move to `in_progress`; resuming a paused task keeps it. |
  | `reviewAt` | The first move to `in_review`. |
  | `completedAt` | The latest move to `done`, cleared when the task is reopened after it. |
  | `reopenedAt` | The latest move out of `done`, which only reopening makes; each such event is marked `reopened`. |
  | `pausedAt` | The latest move back to `planned` after `startedAt`, cleared when the task is started again. |
  | `lastReviewAt` | The latest move to `in_review`; later than `reviewAt` when the task went back to review. |
  | `activeSeconds` | Seconds spent `in_progress` or `in_review` up to the latest status change, pauses left out. |
  | `pauseCount` | How often the task moved back to `planned` after `startedAt`. |

  When a task became ready isn't recorded: it's the `completedAt` of its last
  dependency to be done.

- Tasks created before status history existed have no events; their milestones are
  unknown and aren't guessed.

### Historic Records

Before the tracker-only model, Toodo recorded the commits of each task branch and a
snapshot of each merged pull request (size, reviews, merge time). Those rows stay in
storage and still appear in reviews of past periods, read-only. New work records no
commits or pull request snapshots, so reviews of new periods have no commit counts or
changed lines.

## Timeline View

The dependency graph is drawn on a time axis instead of as a free-form layered DAG, so
the same picture shows both what depended on what and when it happened. The timeline
belongs to the "All workspaces" view, where it's the default (a workspace's own view is
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
  - Never started (`planned` without `startedAt`): a fixed-width bar attached to the
    current-time cursor, moving with it.
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
  tasks it depends on, otherwise in order of start time. A task that hasn't started is
  also placed to the right of its prerequisites' bars, so a chain of waiting tasks reads
  left to right from the current time. Its bar is as long as its estimate at the current
  scale, or a small fixed box without one; its label sits past the bar's right end when
  it doesn't fit inside. The label of a bar that starts left of the visible range is
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
  row and behind its label, and the axis reaches far enough to show it. A task done after
  that day, or still open past it, is outlined in red, and so is its marker.

## Plan View

"Plan" in the "All workspaces" view (`?view=plan`) shows whether a quarter or a year of
planned work fits, before it slips. Like the timeline it can be narrowed to one
workspace, and the search, status, and type filters apply.

- Each task counts in the calendar quarter or year of its due date, with its estimate
  converted to seconds as everywhere else (a day is 24 hours, a week 7 days, a month 30
  days). Done tasks count, since their work filled the period; tasks that weren't
  adopted don't.
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
for the year-end report. It's built only from recorded facts: the status history and its
reasons, task types, labels, refs, completion notes, and decision notes, plus the
read-only [historic records](#historic-records) of past periods. Nothing is generated
or guessed by an agent.

- The user picks a week (from any first day, by default the Monday of the current week),
  a calendar month, quarter, or year, or a custom range of days. The `review_period`
  command takes the first and last day, and the server turns them into the half-open
  period `[start, end)` from midnight of the first day to midnight after the last day in
  its review time zone, so the same days give the same numbers on every device.
- The review time zone is a server setting (`settings` table), changed from the Review
  page (Change time zone) or with `set_review_time_zone`; until one is set, it's the
  server's own time zone (UTC when that has no IANA name). The review's monthly counts are
  in it too.
- A review can be saved as a snapshot (Export > Save as snapshot, or
  `save_review_snapshot`): the server stores its reviewed tasks as JSON, the names of
  their workspaces, the time zone, and the Markdown and CSV reports in
  `review_snapshots`. Reopening it from Saved reviews shows and exports exactly what was
  saved, with durations and due dates judged at the time it was saved, however the tasks
  change later. Snapshots are kept until deleted and aren't merged by
  `toodo-server import`.
- The review can be narrowed to one workspace and to one label. The summary, plan, and
  exports cover the narrowed tasks.
- A task is in the review when it reached a milestone in the period (or, for past
  periods, got a historic commit record in it). Its outcome is the most advanced
  milestone reached in the period, in this order:

  | Outcome | Reached in the period |
  | --- | --- |
  | Completed | `completedAt` |
  | In review | `reviewAt` |
  | Started | `startedAt` |
  | Worked on | No milestone, but a historic commit record |
  | Planned | `plannedAt` |

- Each task is listed once, under its outcome, with its workspace, the time of the
  outcome, its completion note, its refs, and the decision notes left in the period. A
  started task also shows its active time (`in_progress` or `in_review`) against its
  waiting time (back in `planned` after its first start: paused, blocked by a
  prerequisite, or reopened, until it was started again), and each wait in the period
  with the reason its event recorded; time still under way counts until now. The CSV
  export has both as `Active hours` and `Waiting hours`.
- A summary leads the review: the count of tasks per outcome, completed tasks by task
  type and by workspace, and the median durations of the tasks completed in the period:

  | Duration | From | To |
  | --- | --- | --- |
  | Lead time | `plannedAt` | `completedAt` |
  | Cycle time | `startedAt` | `completedAt` |
  | Active time | `startedAt` | `completedAt`, counting only time `in_progress` or `in_review` |
  | Review time | `reviewAt` | `completedAt` |

  Cycle time includes pauses and active time leaves them out, so the two together show
  how long a task took and how long it was worked on. A task without one of the
  milestones (or without status history, for active time) is left out of that median. A
  period over several calendar months also counts the tasks completed in each month.
  The review also says how many completed tasks were concluded without adopting them;
  the Markdown report marks those tasks "not adopted" and lists their conclusion.
- When reviewed tasks have estimates or due dates, a "Plan vs actual" section compares the
  plan with what happened: the summed estimates of the completed tasks against their
  summed active time, how many completed tasks met their due date, and the late tasks:
  those completed after their due date, and open tasks whose due date passed before the
  end of the period (or before now, while the period is under way). The Markdown report
  adds these lines to its summary and a "Late" section.
- A year review adds a "Year in review" section, also in its Markdown report, from the
  tasks completed in the year: every completed `rnd` task with whether it was adopted and
  its conclusion, and the three tasks whose active time overran their estimate the most.
  For years with historic pull request snapshots it also sums them.
- The review can be copied as Markdown, or saved as a Markdown or CSV file (one row per
  task with its milestones as local times, its resolution, its active hours so far, its
  estimate and unit, its due date and whether it was met (`On time`, `Late`, `Overdue`,
  or `Not due yet`), and its completion note; UTF-8 with a byte order mark). The server
  renders both reports with the `review_report` command, in the review time zone unless
  the caller names another IANA time zone, and the browser downloads the file. Agents get
  the same report from the MCP tool `review_report`, and the CLI prints it with
  `toodo review` (see [server.md](server.md)).
- Printing the review (Export > Print or save as PDF, or the browser's print command)
  leaves out the sidebar, the controls, and banners, and uses the light theme.

## Components

```
+-----------------+      +-------------------+      +------------------+
| Toodo UI (PWA)  | ---> | Toodo Core (Rust) | ---> | Storage (SQLite) |
| React + React   | HTTP | (tasks, DAG rules,|      | (workspaces,     |
| Flow, browser   | SSE  |  lifecycle)       |      |  tasks, history) |
+-----------------+      +-------------------+      +------------------+
                                  ^
                                  | MCP (bearer token or OAuth)
                         +-------------------+
                         | Executor (agent   |
                         | or person)        |
                         +-------------------+
```

- **Server** (`toodo-server`): serves commands over HTTP (`/api/rpc/*`), events over
  server-sent events, MCP on `/mcp`, Web Push, and the web app, all on one port. It also
  handles backups, `toodo-server import`, and device access. It needs no other program
  on `PATH`. See [server.md](server.md).
- **Toodo Core**: the domain rules in `src-tauri/src/domain/`: DAG validation, readiness,
  and the task state machine. Pure logic with no I/O.
- **Web app**: React, TanStack Query, and React Flow, installable as a PWA. It shows the
  task lists, the timeline, the plan view, task details with notes and history, and the
  review.
- **MCP server** (`src-tauri/src/mcp/`): how coding agents and other executors read and
  record work while the server runs.
  - Served by `toodo-server` itself (rmcp, Streamable HTTP, stateless JSON responses) on
    `/mcp` of its port (`http://127.0.0.1:47616/mcp` by default), loopback only. It shares
    the database lock with the commands and emits `TasksChanged`, so the UI refreshes like
    after any command.
  - Every request needs `Authorization: Bearer <token>`. The token is 32 random bytes,
    hex encoded, created once in `mcp-token` in the server's data directory. rmcp also
    rejects non-loopback `Host` headers against DNS rebinding.
  - Tools: `read_toodo_skill`, `list_workspaces`, `create_workspace`, `update_workspace`,
    `archive_workspace`, `list_tasks`, `search_tasks`, `get_task`, `add_related`,
    `remove_related`, `current_task`, `create_task`, `create_plan`, `check_criterion`,
    `add_criterion`, `remove_criterion`, `update_task`, `add_dependency`,
    `remove_dependency`, `add_progress_note`, `report_blocker`, `pause_task`,
    `resume_task`, `delete_task`, `reopen_task`, `start_task`, `complete_task`,
    `conclude_task`, and `review_report`. They reuse the storage rules, so cycles are
    rejected.
  - The lifecycle tools only record: `start_task` moves a ready task to `in_progress` and
    creates nothing else; `update_task` with `status: "in_review"` marks work that awaits
    review; `complete_task` checks the criteria and moves the task to `done`;
    `conclude_task` ends it, started or still `planned`, as `not_adopted`, or as shipped
    with another task (`outcome: "shipped_with"`). See [workflow.md](workflow.md).
  - `create_plan` creates several tasks linked to each other by key and to existing tasks
    by ID in one transaction; any failure creates nothing. `add_dependency` takes several
    prerequisites in one call and pauses an `in_progress` task they block.
  - `delete_task`, `reopen_task`, and `archive_workspace` change nothing unless called
    with `confirm: true`; without it the reply says what the change would do.
  - `search_tasks` finds tasks of all workspaces (or one, or one status) by words in their
    title, description, completion note, notes, and refs; every word must appear, and
    results come best match first with their `depends_on`, `dependents`, and `related`
    IDs. A task number alone (`431` or `#431`) puts that task first. `get_task` returns
    one task with its whole history and its linked tasks. Search runs on `task_search`,
    an FTS5 table with the trigram tokenizer, ranked by bm25 with the title weighted
    highest; words shorter than three characters are matched with `LIKE`.
  - Tool failures come back as tool errors with the error's kind, code, and message as
    structured content `{ "error": { "kind", "code", "message" } }`; unknown arguments
    are rejected, naming the ones the tool accepts.
  - The `initialize` instructions and the `toodo` skill (`toodo-skill.md`) share rules
    kept once in `src-tauri/src/mcp/shared/` and filled in where a template says
    `{{name}}`; see [agents.md](agents.md). They tell agents to search before planning,
    record decisions and blockers as they work, and use `add_dependency` only for real
    prerequisites. Toodo never prompts agents itself.
  - Agent access in Settings copies an MCP client config with the URL and token
    (`mcp_server_info`), tests that the server accepts that token, and shows the last
    request `/mcp` turned away with its reason.
- **OAuth server** (`src-tauri/src/oauth/`): the single-owner authorization server that
  lets chat apps reach `/mcp` when `TOODO_PUBLIC_URL` is set. It serves discovery
  metadata, dynamic client registration and client ID metadata documents, the consent
  page (the owner approves with `web-token`), and the token and revocation endpoints.
  Grants carry an owner key and the scopes `toodo.read` and `toodo.write`; tokens and
  secrets are stored as SHA-256 hashes in `storage/oauth.rs`, while codes and pending
  consents stay in memory. Off by default, when its routes aren't mounted.
- **Web Push** (`src-tauri/src/server/push/`): notifications to subscribed browsers.
- **Storage**: SQLite database `toodo.sqlite3` in the server's data directory
  (`TOODO_DATA_DIR`) for workspaces, tasks, dependencies, related links, notes,
  criteria, status history, reviews, and the historic records (`src-tauri/src/storage/`).
  - The schema is versioned with `PRAGMA user_version` and migrated forward on startup;
    a database from a newer Toodo version is refused rather than modified. Migrations
    are only appended, never edited once released.
  - Workspace and task IDs are never reused after a delete.
  - Writes that touch the task DAG run in one transaction: new edges are validated
    against the DAG rules, and starting a task checks in the same transaction that all
    its dependencies are done.
  - Every task status change appends a row to the task's status history in the same
    transaction (see [Task Timeline](#task-timeline)).
  - Deleting a workspace or task archives it; only purging an archived one deletes its
    tasks, dependency edges, and status history.

## Decisions

- Toodo tracks; it doesn't execute. Worktrees, branches, agents, pull requests, CI, and
  merges stay with the executor, which records the outcome through MCP. This keeps the
  server free of external tools and lets any kind of executor use it.
- Target: `toodo-server` on Linux, used through the web app (PWA) in a browser.
- Backend in Rust (tokio); frontend in React + TypeScript with React Flow for the DAG.
- Storage uses SQLite through `rusqlite` (single-user server; no async pool needed).
- Task types are a fixed set (see [Task Types](#task-types)).
- Completion criteria are `manual` or `url` only; Toodo doesn't read pull request or CI
  state.
- Toodo is used for year-end performance reporting, so every task status change is
  timestamped and kept as history with its reason, and the dependency graph is drawn on a
  time axis (see [Timeline View](#timeline-view)).

## Deferred

Out of the current scope; revisit when needed.

- User-defined task types.
- Rotating the MCP access token from the UI.
- Correcting timeline timestamps by hand, for example to enter work done before the task
  was created in Toodo.
- Showing related links in the app.
