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

A root git repository that tasks are planned against. A workspace is created either by
cloning a repository into a path or by opening a repository already cloned at a path; see
[workflow.md](workflow.md#1-register-a-workspace).

| Field | Description |
| --- | --- |
| `id` | Stable identifier. |
| `name` | Display name. |
| `kind` | `local` or `ssh`. |
| `path` | Absolute path to the repository root: a POSIX path on the server's machine for `local`, a POSIX path on the SSH machine for `ssh`, or a Windows drive or UNC path when that machine is a Windows host (see "Windows Hosts" in [server.md](server.md)). Local paths stored by older Toodo versions may be Windows paths (see [migrate-desktop-data.md](migrate-desktop-data.md)); such a workspace can be moved to the PC it lives on. |
| `herdrMachine` | For `ssh` workspaces: the SSH target of the saved herdr machine (usually a `~/.ssh/config` host alias); also used as the `ssh` host. |
| `defaultBaseBranch` | Branch that task branches start from and PRs target (e.g. `main`). Detected or entered at registration and editable afterwards from the workspace header, except while a task of the workspace is `in_review` (its open PR targets the current branch). |
| `agentMerge` | Whether agents merge their own task PR: `never` (default; they stop once the PR is open) or `afterChecks` (they merge it into `defaultBaseBranch` once every check on it passed, never into another branch). Editable from the workspace header; agents read it from the MCP `current_task` tool. Toodo itself never merges. |

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

- Creating a task records its initial status (`planned`). Every later status change
  records one event in the same transaction as the change itself. Dependency changes do
  not change a status, so they record nothing.
- Events are never edited or deleted on their own; they go away only when their task is
  deleted. A deleted task no longer appears in reports, so pause rather than delete a
  task whose work should be reported.
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
  one of its tasks, since that task would silently become ready. Dependencies of tasks
  being worked on or done are dropped with the workspace.
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
  from the lower task ID to the higher one, and deleting a task drops its links.
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

## Timeline View

The dependency graph is drawn on a time axis instead of as a free-form layered DAG, so
the same picture shows both what depended on what and when it happened. The timeline
belongs to the "All workspaces" view, where it is the default (a workspace's own view is
a task list): it draws the tasks of every workspace together, each bar labeled with its
workspace, and can be narrowed to one workspace. Narrowed, prerequisites from other
workspaces are still drawn, dimmed and labeled with their workspace.

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

## Review

A report of the work recorded in a period, across all workspaces, for status updates and
for the year-end report. It is built only from recorded facts (status history, commit
records, pull request snapshots) and the completion notes the user wrote; nothing is
generated or guessed by an agent.

- The user picks a week (from any first day, by default the Monday of the current week),
  a calendar month, quarter, or year, or a custom range of days. The period runs from
  local midnight of its first day to local midnight after its last day, as the half-open
  period `[start, end)` passed to the `review_period` command.
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
  note, and the commits it got in the period.
- Tasks without status history appear only through their commits.
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
  order mark). The frontend
  builds the file, since it knows the local time zone, and the browser downloads it.

## Runtime Context

Toodo runs as `toodo-server` on a Linux machine next to an already installed and running
herdr. The server serves its commands over HTTP to the frontend, an installable web app
(PWA) used from a browser, and the server's machine is the "Local" machine; see
[server.md](server.md). herdr owns terminals, agents, worktree checkouts, and SSH machine
connections; Toodo owns planning, task state, commit records, and pull requests.

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
- **herdr adapter**: wraps herdr, which is a required, preinstalled dependency.
  - Startup health check: `herdr` on `PATH` and `herdr status --json` reports
    `server.running`. herdr 0.9.3 has no `ping` command.
  - Commands for SSH workspaces run against the remote herdr server with
    `herdr --machine <profile-id> ...`. `--machine` accepts only a saved profile ID or
    label, so the profile is looked up in `herdr machine list --json` by its SSH target
    on every call, preferring an enabled profile on the `default` session.
  - The sidebar lists Local and the machines of `herdr machine list --json`. Machines are
    added with `herdr machine add <host>` in a terminal on the server, since herdr asks
    questions there. Toodo never installs herdr itself.
  - Failures exit non-zero and print `{"error": {"code", "message"}}` on stderr.
  - Commands use the herdr CLI.
  - Events use the socket API (`src-tauri/src/adapters/herdr_events.rs`,
    `src-tauri/src/commands/events.rs`): newline-delimited JSON over the server socket
    that `herdr status --json` reports as `server.socket`, a Unix domain socket.
    - The herdr server of an SSH machine is reached with `ssh -o BatchMode=yes -W
      <socket path> -- <host>`, which forwards ssh's standard input and output to the
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
      `AgentStatusesChanged` event.
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
  adapter, on the machine that holds the worktree.
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
  - Tools: `list_workspaces`, `list_tasks`, `current_task` (the task whose worktree
    contains a given directory, after resolving `.` and `..`; an optional `machine`
    scopes it to one machine, and a path inside worktrees on several machines is
    rejected without it), `restore_worktree` (the app's Restore worktree for an active
    task whose worktree directory is gone), `create_task` (with optional `depends_on`; unknown
    prerequisites create nothing), `update_task`, `add_dependency` (several
    prerequisites in one call; it pauses an `in_progress` task they block but leaves its
    herdr workspace open, and the app asks the user whether to close it),
    `remove_dependency`, `pause_task` / `resume_task` (the app's Pause and Resume; the
    pause reason and an optional resume note become progress notes), and
    `add_progress_note` / `report_blocker`, which append a
    timestamped Markdown note (`progress` or `blocker`, table `task_notes`) to a task
    without changing its status. They reuse the storage rules, so cycles are rejected. The
    server instructions tell agents that work their task needs before it can finish is a
    prerequisite of their task, added last, and to note decisions and blockers as they
    work; Toodo never prompts agents itself. Notes show in the task list (latest) and the
    task details (all), and period reviews list the notes left during the period. Tool
    failures come back as tool errors whose text the agent sees; arguments a tool does
    not know are rejected, naming the ones it accepts.
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
  - Deleting tasks is not exposed: it cannot be undone and stays in the app.
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
  - Deleting a workspace or task also deletes its tasks, dependency edges, commit
    records, and status history.

## Decisions

- Target: `toodo-server` on Linux, used through the web app (PWA) in a browser.
- herdr is a prerequisite; Toodo only checks that it is running and never installs it.
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
