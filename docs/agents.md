# Agents

Coding agents use Toodo through its MCP server (`/mcp`, see
[Agents in docs/server.md](server.md#agents) for the client config). Toodo keeps the plan
and the record of the work; it doesn't run agents, create worktrees, or open pull
requests. The agent or person doing the work does that elsewhere and writes the results
back into Toodo.

Agents take one of two roles:

- A **worker** does one task and records it: the start, progress, decisions, blockers,
  review, and completion. It follows the `toodo` skill, which the `read_toodo_skill` tool
  returns.
- An **orchestrator** (a lead agent) plans tasks as a dependency DAG, picks ready tasks
  for workers, follows their records, and closes out tasks whose work shipped or was
  dropped.

The tool descriptions in `tools/list` give every argument; the examples below show the
arguments each step needs.

## Where the Instructions Come From

An agent gets two texts from Toodo:

- The MCP `initialize` reply carries the server instructions: how to use the tools, for
  any role.
- `read_toodo_skill` returns the skill (`src-tauri/src/mcp/toodo-skill.md`).

Both texts tell the agent to read the guidelines of a task's workspace before working on
it: rules the owner sets, which the agent follows, and memories, durable lessons recorded
for the workspace. `start_task` and `get_task` include them in `guidelines`, and
`get_guidelines` with `workspace_id` lists them. An agent records a new lesson with
`add_guideline` (kind `memory`, the default) and keeps memories current with
`update_guideline` and `remove_guideline`; it leaves rules to the user.

Rules both texts state, such as the task description format, how completion criteria are
checked, and how tasks are concluded, live once in `src-tauri/src/mcp/shared/`. A template
marks where one goes with `{{name}}`, and the server fills it in from `shared/<name>.md`
when it builds the texts. Change such a rule in its fragment file only; a test checks
that every fragment appears in both texts and that no placeholder is left.

## Planning a DAG

1. Find earlier work before you plan: `search_tasks` with two or three distinctive
   words, then `get_task` on the matches to read what was decided, including decision
   notes and `completionNote` for research that wasn't adopted.

   ```json
   { "query": "push notifications" }
   ```

2. Pick the workspace with `list_workspaces` and create the tasks. Wire prerequisites
   with `depends_on` in the same call, and context that doesn't block with `related`:

   ```json
   {
     "workspace_id": 1,
     "task_type": "feat",
     "title": "Send push notifications for blocked tasks",
     "description": "## Purpose\n\nTell the user when a task reports a blocker.\n\n## Background\n\nBlocker notes already exist.",
     "criteria": [{ "text": "A blocker note sends a push notification", "kind": "manual" }],
     "merge_criterion": false,
     "depends_on": [41],
     "related": [37],
     "labels": ["notifications"],
     "estimate": { "unit": "days", "amount": 2 }
   }
   ```

   A dependency points from the dependent task to its prerequisites; a call that would
   make a cycle is rejected. Create independent tasks when the work can run in parallel.
   `create_plan` creates several tasks and their dependencies in one call.

3. Write every description so that a worker can start from it alone: `## Purpose` and
   `## Background` in the description, what has to hold in `criteria` (`manual`, or
   `url` with a target Toodo fetches on completion).

## Recording the Work

1. List what can start now:

   ```json
   { "workspace_id": 1, "ready": true }
   ```

   `list_tasks` marks each task `ready` and lists `blockedBy`, the prerequisites that
   aren't done yet.

2. Record the start with `start_task`, a reason, and refs that tie the task to where the
   work happens. Toodo moves it to `in_progress` and creates nothing else:

   ```json
   { "id": 42, "reason": "Picked up by the search lane", "refs": ["lane:search", "branch:feat/push-blockers"] }
   ```

   The reply carries `guidelines`, the rules and memories of the task's workspace. Read
   them before the first edit and follow every rule.

3. A worker finds its task again with `current_task` and one of those refs, e.g.
   `{"ref": "lane:search"}`, or with `get_task` when it knows the id.

4. While working, record what later readers need: `add_progress_note` with kind
   `progress` for a milestone and kind `decision` for a choice and its reason,
   `report_blocker` when someone has to step in, and `pause_task` with a reason when the
   work stops. `resume_task` continues it. `wait_task` pauses it until a time, after
   which it returns on its own; `end_wait` returns it sooner.

5. When the work awaits review, move the task with `update_task`:

   ```json
   { "id": 42, "status": "in_review", "refs": ["pr:https://github.com/acme/app/pull/17"] }
   ```

## Following Progress

- `list_tasks` with `status` (e.g. `["in_progress", "in_review"]`) and `limit` keeps the
  overview short; page back with `before_id`.
- `get_task` shows a task's notes, refs, criteria, and status history. A blocker note
  means the worker needs someone; answer it or tell the user.
- `review_report` renders the review of a week, month, quarter, year, or custom period as
  Markdown or CSV, the same report the app's Review exports, e.g. `{"period": "week"}`
  for a weekly status update. Chat apps can call it with the `toodo.read` scope.
- A worker that finds a missing prerequisite creates the prerequisite tasks and adds
  them to its own task with `add_dependency`, which pauses it. Once they're done, the
  paused task is ready again and `resume_task` continues it.

## Closing Out

Toodo never completes a task by itself: it doesn't watch pull requests or CI. The
executor confirms the work shipped, then closes the task. The exact rules are in the
shared fragments the agents read:
[`completion.md`](../src-tauri/src/mcp/shared/completion.md),
[`review-timing.md`](../src-tauri/src/mcp/shared/review-timing.md),
[`other-tasks.md`](../src-tauri/src/mcp/shared/other-tasks.md), and
[`merge-policy.md`](../src-tauri/src/mcp/shared/merge-policy.md). In short:

- Shipped work: check each `manual` criterion with `check_criterion` and evidence, then
  call `complete_task` with a note and refs. Toodo fetches the `url` criteria and
  rejects the call with whatever isn't met.

  ```json
  { "id": 42, "note": "Push sent on every new blocker note.", "refs": ["pr:17"] }
  ```

- Work that didn't ship (research not adopted, a duplicate, work no longer needed):
  `conclude_task` with the reason. Its dependents stay blocked.

  ```json
  { "id": 44, "note": "Duplicate of #42." }
  ```

- Work another task shipped: `conclude_task` with outcome `shipped_with`.

  ```json
  { "id": 43, "note": "Shipped in #42.", "outcome": "shipped_with", "shipped_with": 42 }
  ```

## Rules for Orchestrators

- Add a prerequisite to an `in_progress` task last, with all prerequisites in one
  `add_dependency` call: it pauses the task.
- Delete a `planned` task created by mistake, or a `done` task whose record is no longer
  wanted, with `delete_task`; `delete_done_tasks` deletes every `done` task of a
  workspace at once. Reopen a task done by mistake with `reopen_task` and a reason. A
  deleted task is archived: it stays in reviews, and only the user restores or purges it in the app.
- Move a task filed in the wrong workspace with `move_task`, e.g.
  `{"id": 42, "workspace_id": 3}`. Only its workspace changes: its history, notes,
  criteria, refs, and links stay, and it follows the new workspace's guidelines. Refs
  such as `branch:` keep naming what they named; update them if the work moves too. An
  archived workspace is rejected.
- Archive a workspace that's no longer used with `archive_workspace`. Its tasks are
  archived with it and stay in reviews.
- When a call is rejected, read the error: it names the argument or step that succeeds.

## Example Session

1. `search_tasks {"query": "export csv"}` finds nothing open.
2. `create_task` for "Add CSV export API" (#50), then "Add CSV export button" (#51) with
   `depends_on: [50]`, and "Document CSV export" (#52) with `depends_on: [50]`.
3. `list_tasks {"workspace_id": 1, "ready": true}` returns #50 only.
4. A worker picks up #50 and calls `start_task {"id": 50, "reason": "First step of CSV export", "refs": ["lane:csv"]}`.
5. It records a decision note on the file format, opens a pull request outside Toodo,
   and calls `update_task {"id": 50, "status": "in_review", "refs": ["pr:61"]}`.
6. After the merge it calls `complete_task {"id": 50}`. `list_tasks` now returns #51 and
   #52 as ready, and both can start in parallel.
