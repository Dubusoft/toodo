# Agents

Coding agents use Toodo through its MCP server (`/mcp`, see
[Agents in docs/server.md](server.md#agents) for the client config). They take one of
two roles:

- A **worker** works on one task in that task's worktree, from its description to a
  pull request. It follows the `toodo` skill, which the `read_toodo_skill` tool returns.
- An **orchestrator** (a lead agent) works outside any task worktree. It plans tasks as a
  dependency DAG, starts ready tasks for worker sessions, watches them, and closes out
  tasks whose work shipped or was dropped.

This guide is for the orchestrator. The tool descriptions in `tools/list` give every
argument; the examples below show the arguments each step needs.

## Where the Instructions Come From

An agent gets two texts from Toodo:

- The MCP `initialize` reply carries the server instructions: how to use the tools, for
  any role.
- `read_toodo_skill` returns the worker skill (`src-tauri/src/mcp/toodo-skill.md`).

Rules both texts state, such as the merge policy, how completion criteria are checked,
the task description format, and how other tasks are completed or concluded, live once
in `src-tauri/src/mcp/shared/`. A template marks where one goes with `{{name}}`, and the
server fills it in from `shared/<name>.md` when it builds the texts. Change such a rule
in its fragment file only; a test checks that every fragment appears in both texts and
that no placeholder is left.

## Planning a DAG

1. Find earlier work before you plan: `search_tasks` with two or three distinctive
   words, then `get_task` on the matches to read what was decided, including
   `completionNote` for research that was not adopted.

   ```json
   { "query": "push notifications" }
   ```

2. Pick the workspace with `list_workspaces` and create the tasks. Wire prerequisites
   with `depends_on` in the same call, and context that does not block with `related`:

   ```json
   {
     "workspace_id": 1,
     "task_type": "feat",
     "title": "Send push notifications for failed runs",
     "description": "## Purpose\n\nTell the user when a run fails.\n\n## Background\n\nRuns already record their exit status.",
     "criteria": [{ "text": "`cargo test --lib push` passes", "kind": "command", "target": "cd src-tauri && cargo test --lib push" }],
     "depends_on": [41],
     "related": [37],
     "estimate": { "unit": "days", "amount": 2 }
   }
   ```

   A dependency points from the dependent task to its prerequisites; a call that would
   make a cycle is rejected. Create independent tasks when the work can run in
   parallel, so several workers can start at once.

3. Write every description so that a worker can start from it alone: `## Purpose` and
   `## Background` in the description, what has to hold in `criteria`.

## Starting Workers

1. List what can start now:

   ```json
   { "workspace_id": 1, "ready": true }
   ```

   `list_tasks` marks each task `ready` and lists `blockedBy`, the prerequisites that
   are not done yet.

2. Start a ready task with `start_task`. Toodo creates its worktree and herdr workspace
   and moves it to `in_progress`. With `agent_command`, Toodo runs that command in the
   workspace's first pane, with `TOODO_MCP_URL` and `TOODO_MCP_TOKEN` exported, so the
   worker can reach Toodo without a token in the pane:

   ```json
   { "id": 42, "agent_command": "claude 'Work on the Toodo task of this worktree: call read_toodo_skill, then follow it.'" }
   ```

   The reply has the task, its `panes`, `ranIn` (the pane the command ran in), and
   `paneError` when the command did not run; the task is started either way.
   `agent_command` works for workspaces on the server's machine only.

3. A machine without a worktree root rejects `start_task`. `list_machine_settings`
   shows each root; set a missing one with `set_worktree_root` to the directory the
   user names, and never change one that is set unless the user asks.

## Watching Progress

- `list_tasks` with `status` (e.g. `["in_progress", "in_review"]`) and `limit` keeps
  the overview short; page back with `before_id`.
- `get_task` shows a task's progress and blocker notes, its pull request, its commits,
  and the agent status of each pane (`working`, `idle`, `blocked`, `done`). A blocker
  note means the worker needs someone; answer it or tell the user.
- `pull_request_status` (without `task_id`) lists the open pull requests of `in_review`
  tasks with their CI checks and reviews as Toodo last read them, without running `gh`.
- `review_report` renders the review of a week, month, quarter, year, or custom period as
  Markdown or CSV, the same report the app's Review exports, e.g. `{"period": "week"}`
  for a weekly status update or `{"period": "year", "format": "csv"}` for a year-end
  report. Chat apps can call it with the `toodo.read` scope.
- A worker that finds a missing prerequisite creates the prerequisite tasks and pauses
  its own task with `add_dependency`. Start those prerequisites; once they are done,
  `start_task` on the paused task resumes it.

## Closing Out

Toodo completes a task by itself once its criteria are met, checking the automatic
kinds about once a minute; the orchestrator steps in only for tasks that do not finish
that way. The exact rules are in the shared fragments the agents read:
[`completion.md`](../src-tauri/src/mcp/shared/completion.md),
[`review-timing.md`](../src-tauri/src/mcp/shared/review-timing.md),
[`other-tasks.md`](../src-tauri/src/mcp/shared/other-tasks.md), and
[`merge-policy.md`](../src-tauri/src/mcp/shared/merge-policy.md). In short:

- A task with a `manual` criterion waits in `in_review` until that criterion is checked
  and the user confirms it. Right after a merge, a task can read `in_review` for about a
  minute; read it again instead of calling `complete_task`.
- One pull request that shipped several tasks: once it is merged, complete each extra
  task with `merged_with` set to the task that owns the pull request.

  ```json
  { "id": 43, "merged_with": 42 }
  ```

- Work shipped without any pull request: `complete_task` with
  `without_pull_request: true` and a `note` saying what shipped.
- Work that did not ship (research not adopted, a duplicate, work no longer needed):
  `conclude_task` with the reason. A task with an open pull request is concluded by the
  user in the app.

  ```json
  { "id": 44, "note": "Duplicate of #42." }
  ```

- Whether a worker merges its own pull request is the workspace's `agentMerge`:
  `never` (the default) or `afterChecks`, which merges into `baseBranch` only once every
  check passed. Toodo has no merge tool.

## Rules for Orchestrators

- Never start, complete, or conclude the task `current_task` finds for your own working
  directory; orchestrators usually work outside task worktrees, where it finds none.
- Add a prerequisite to an `in_progress` task last, with all prerequisites in one
  `add_dependency` call: it pauses the task, and the user is asked whether to close its
  herdr workspace.
- Delete a `planned` task created by mistake with `delete_task` and reopen a done task
  with `reopen_task`: call once without `confirm`, read what the change would do, then
  call again with `"confirm": true`. Done tasks are deleted in the Toodo app only. A deleted
  task is archived: it stays in reviews, and only the user restores or purges it in the app.
- When a call is rejected, read the error: it names the argument or step that succeeds.

## Example Session

1. `search_tasks {"query": "export csv"}` finds nothing open.
2. `create_task` for "Add CSV export API" (#50), then "Add CSV export button" (#51) with
   `depends_on: [50]`, and "Document CSV export" (#52) with `depends_on: [50]`.
3. `list_tasks {"workspace_id": 1, "ready": true}` returns #50 only.
4. `start_task {"id": 50, "agent_command": "codex 'Work on the Toodo task of this worktree.'"}`.
5. `get_task {"id": 50}` a while later shows the worker's notes and, later, its pull
   request in `in_review`.
6. After the merge, #50 is done; `list_tasks` now returns #51 and #52 as ready, and both
   start in parallel.
