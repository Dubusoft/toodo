# Task Workflow

This document describes how a task moves from planning to done, and what Toodo records
along the way.

Toodo is a tracker. It keeps the task DAG and the memory of the work: descriptions,
notes, decisions, refs, and a timestamped status history. It doesn't run the work.
Preparing a worktree, implementing, recording commits, opening a pull request, and
noticing a merge all happen outside Toodo, done by the agent or person doing the work (an
executor such as Dori, for example). That executor tells Toodo what happened by changing
the task status through MCP or the web app.

## Task States

```
            start_task           update_task           complete_task
                              status in_review
planned -----------------> in_progress ---------> in_review ---------> done (completed)
   ^                           |                      |
   |                           +---- complete_task ---+--------------> done (completed)
   +------- pause_task --------+----------------------+
                               |                      |
                               +---- conclude_task ---+--------------> done (not_adopted)

planned ------------------------- conclude_task ---------------------> done (not_adopted)
```

| State | Meaning |
| --- | --- |
| `planned` | Nobody works on the task: it wasn't started yet, or it was paused. |
| `in_progress` | Someone recorded the start of the work with `start_task` (or "Start" in the app). |
| `in_review` | The work awaits review. The executor sets this with `update_task` and `status: "in_review"`, usually with a `pr:` ref once it opened a pull request. |
| `done` | Finished. Its `resolution` says how: `completed`, or `not_adopted` (concluded without adopting the work; dependents stay blocked). Tasks finished before the tracker-only model may read `merged`. |

A `planned` task that was worked on before shows as **paused**. Pausing isn't a separate
state: `pause_task` moves an `in_progress` or `in_review` task back to `planned` and
records the required reason.

Whether a `planned` task can be started isn't a state either. It is **ready** once every
task it depends on is `done`, none of them `not_adopted`. MCP's `list_tasks` and
`get_task` give each task `ready` and `blockedBy`, the prerequisites that aren't done
yet or weren't adopted.

Every state change is recorded with its time in the task's status history, and a status
event can carry a note: the start reason, the pause reason, or the completion note. That
history feeds the timeline view and the review report (see
[architecture.md](architecture.md#task-timeline)).

## Completion Criteria

Criteria are structured data on the task, never parsed from its description. Each has a
text, a kind, a state (`pending`, `met`, or `failed`), the evidence of its last check, and
who checked it when. There are two kinds:

| Kind | Checked by | Met when |
| --- | --- | --- |
| `manual` | a person in the app, or the executor through MCP (`check_criterion`, evidence required) | someone checks it |
| `url` | Toodo, when the task is completed | a GET of its target, an http(s) URL, answers 2xx |

The `url` check is the only outside call the server makes. Toodo never checks whether a
pull request merged or CI passed; the executor checks that before it completes the task,
and records it as a `manual` criterion if the task needs it written down.

Criteria are set when the task is created (`create_task`) and can be edited until the
task is done (`update_task`, or one at a time with `add_criterion` and
`remove_criterion`). Pass `merge_criterion: false` to `create_task` so no merge criterion
is added. Criteria of older kinds were turned into `manual` criteria by a migration, met
when they had been met before.

`complete_task` is rejected while a `manual` criterion is unchecked or a `url` criterion
fails, and the error lists what isn't met. A task without criteria completes when someone
calls it. Done tasks keep their criteria as a record.

## Lifecycle

### 1. Register a workspace

A workspace is a group of tasks. It has a name, an optional Markdown description, and an
optional repository reference: a free string such as `dev-bokdong/toodo` or
`discord:<channel>`. Toodo doesn't interpret it. A GitHub `owner/repo` value is shown as a
link. There's no directory, machine, or branch, so work that has no repository fits too.

Create one in the app or with `create_workspace`, change it with `update_workspace`, and
archive it with `archive_workspace`. Archiving takes its tasks with it; they stay in the
review report.

### 2. Plan tasks

Create tasks in a workspace and declare which ones depend on which, also across
workspaces. Toodo rejects any dependency that would close a cycle, from either side.
Context that doesn't block goes in a **related** link (`add_related`,
`remove_related`). The creation time is recorded as the task's `plannedAt`.

Each task has a type (`feat`, `fix`, `modify`, `refactor`, `docs`, `test`, `chore`,
`rnd`), a title, and a description in GitHub-flavored Markdown with `## Purpose` and
`## Background`. Optional fields are labels, an estimate, a due date, criteria, an issue
reference (`link_issue` stores it; Toodo creates no issues), and refs.

Refs are an ordered list of strings without duplicates, by convention
`<kind>:<value>`: `lane:<key>`, `discord:<thread>`, `pr:<url or number>`,
`branch:<name>`, or a plain `http(s)://` URL, which is shown as a link. Toodo stores them
as given. `create_task`, `update_task`, `start_task`, and `complete_task` append refs,
`update_task` with `remove_refs` removes them, and `search_tasks` searches them.
`current_task` finds a task by one, e.g. `{"ref": "lane:search"}`.

`create_plan` creates several tasks with their dependencies in one call.

### 3. Start

`start_task` records that work on a ready `planned` task begins, with an optional reason
and refs. The task moves to `in_progress`, `startedAt` is recorded, and the reason goes
into the status history. Toodo creates nothing else. A task with a prerequisite that
isn't done is rejected, and the error names that prerequisite.

`resume_task` continues a paused task the same way, with an optional note. `startedAt`
stays the time of the first start.

### 4. Record progress

While work goes on, the executor writes down what matters for later:

- `add_progress_note` with kind `progress` for a milestone, or kind `decision` for a
  choice and its reason. The review report lists decisions on their own.
- `report_blocker` when the work needs someone. A blocker shows as a "Blocker" chip and
  puts the task under "Needs attention" until a later progress note, a resume, or the
  task's completion.
- `pause_task` with a required reason when the work stops for now, and `resume_task`
  when it can go on.

Work found during a task that the task needs before it can finish becomes a
**prerequisite** of that task, never a dependent. Adding a prerequisite that isn't done
to an `in_progress` task pauses it, and a blocker note names what it waits on. It shows
as ready again once those prerequisites are done.

### 5. Review

When the work awaits review, the executor moves the task to `in_review` with
`update_task`, passing `status: "in_review"` and a ref for what's under review, such as
`pr:<url>`. Toodo records `reviewAt`. Review itself happens wherever the executor put the
work.

### 6. Complete

Once the work shipped and its criteria hold, the executor checks the `manual` criteria
with `check_criterion` and calls `complete_task` with an optional note and refs. Toodo
runs the `url` checks, moves the task to `done` with resolution `completed`, records
`completedAt` and the note, and the dependents become ready. In the app, "Complete" does
the same.

Work that ends without being adopted, typically research, is concluded instead.
`conclude_task` takes a required note (what was tried, what was found, why it isn't
adopted) and ends the task as `not_adopted`. Its dependents stay blocked until someone
removes the dependency or changes the plan. A `planned` task can be concluded as well,
without starting it first, e.g. an idea that is dropped before anyone works on it; its
prerequisites don't have to be done. In the app, "Conclude" does the same.

When another task's work shipped this one, call `conclude_task` with outcome
`shipped_with` and `shipped_with` set to that task's id. The task counts as done and its
dependents become ready.

The completion note can be edited later in the app.

### 7. Reopen

A task completed or concluded by mistake is reopened with `reopen_task` (or "Reopen" in
the app) and a reason. It moves back to `planned`, paused if it was started; its
resolution and completion note are cleared, and a progress note keeps the reason with the
earlier outcome. Reopening is rejected while a task that depends on it has started.

### 8. Delete

`delete_task` (or "Delete" in the app) archives the task record. It touches nothing
outside Toodo. An archived task leaves the task lists and stops holding back its
dependents, but keeps its history and notes, and the review report still counts it.
Settings > Archive restores an archived workspace or task, or deletes it for good after a
confirmation.
