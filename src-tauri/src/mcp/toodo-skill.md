---
name: toodo
description: Work on a Toodo task from its description to a pull request into the workspace base branch, splitting off prerequisite tasks when needed, and write task descriptions Toodo can track. Use when working in a Toodo task worktree or creating Toodo tasks.
---

# Working on a Toodo task

Toodo tracks your task by its completion criteria, the `criteria` of the task: it is
done once every criterion is met. Toodo checks every kind but `manual` itself about once
a minute (`pr_merged`, `pr_open_ci_green`, `branch_merged_locally`, `url`, and `command`,
which runs once every other criterion but the merge criterion is met); you check `manual` ones with
`check_criterion` and evidence. A pull request from the task branch into the base branch
moves the task to `in_review`. Once every criterion is met, a task whose criteria are all
automatic is `done` at once; one with a manual criterion awaits completion (`in_review`)
until the user confirms it.

Never start, complete, or conclude your own task (the one `current_task` finds) with
`start_task`, `complete_task`, or `conclude_task`: it was started for you, and meeting its
criteria completes it. Those tools are for other tasks, e.g. starting a ready
task for another agent session or concluding a duplicate. `conclude_task` never closes a
pull request; a task with an open one is concluded by the user in the Toodo app.
When your pull request also fixed other tasks, never conclude them: once it is merged and
your task is done, complete each of them with `complete_task` and `merged_with` set to
your task ID (or the pull request URL). A task already concluded as `not_adopted` that way
can be completed with `merged_with` too.
For work that shipped without any pull request, call `complete_task` with
`without_pull_request: true` and a non-empty `note` explaining what shipped, not
`conclude_task`: concluding means the work was not shipped. This requires no branch
pull request at all, even closed or unrecorded. A merged PR needs `complete_task`
without optional arguments; an open or closed one needs a merge, or conclusion if
the work is abandoned (the user concludes an open PR in the app).
The no-PR path marks `pr_merged` met with the note as evidence; every other criterion
must still hold. It records branch commits and the completion note, ends as
`completed` rather than `merged`, and unblocks dependents. Do not combine
`without_pull_request` with `merged_with`.
Deleting tasks happens in the Toodo app only.

## 1. Start

1. Call `current_task` with your absolute working directory. Note the task's `id`,
   `workspaceId`, `branch`, `baseBranch`, and `agentMerge` (whether you merge your pull
   request, see step 4 of "Otherwise: finish with a pull request").
2. If no task matches and you were asked to work on a Toodo task, you are not in its
   worktree: tell the user and ask for its id instead of guessing, then read it with
   `get_task`. To plan new work outside a task, pick the workspace with
   `list_workspaces`. If the same path may exist on several machines, call
   `current_task` with `machine` (`local` or your SSH host). If the task's
   `worktreeMissing` is true, call `restore_worktree` with its id and work in the new
   `worktreePath`.
3. Read the description and the task's `criteria`: the criteria are your finish line;
   `## Purpose` decides questions they leave open. Tasks created before criteria
   existed keep their old `## Done when` list as manual criteria. If the description is unclear or contradicts the
   code, call `report_blocker` with what you need and ask the user.
4. Before you plan, look up the history of the subject (see "Finding earlier work"
   below): earlier tasks may already have decided an approach, rejected one, or left
   work you build on.

If a Toodo tool call fails with HTTP `401`, read the reply body: it says why (no
`Authorization` header, not `Bearer <token>`, a token this server does not accept, or
the web sign-in token instead of the MCP token) and names the Toodo server instance.
Retrying with the same config fails again. In a pane Toodo started for you,
`TOODO_MCP_URL` and `TOODO_MCP_TOKEN` hold the current URL and token. Otherwise tell the
user that the Toodo MCP token in your config is stale or wrong and that they can copy the
config again from Settings > Agent access (checking that it shows the same instance), and
continue the work that needs no Toodo tool.

## Finding earlier work

- `search_tasks` finds tasks of every workspace by words in their title, description,
  notes, completion note, branch, and pull request, best match first. Every word must
  appear (as a substring, in any language, short Korean words included); words are
  literal, never operators. Use two or three distinctive words, e.g. a component name
  and a verb, and search again with other words or synonyms before concluding there is
  nothing. Narrow with `workspace_id` or `status` when there are too many results. A
  task number alone, e.g. `431` or `#431`, returns that task first, in any workspace.
- `get_task` returns one task with its whole history: description, status timeline,
  progress and blocker notes, completion note (for a task done as `not_adopted`, the
  conclusion of why it was not adopted), pull request, and commits, plus the tasks it
  `depends_on`, its `dependents`, and its `related` tasks. Read what was decided there
  before deciding again, and follow the links with more `get_task` calls when the
  history matters.
- Link tasks only by what they mean:
  - `add_dependency` only for a real prerequisite: work that has to be done before the
    other task can be finished (see step 3). It blocks the dependent task.
  - `add_related` for everything else worth reading together: an earlier task whose
    decisions this one builds on, a follow-up of a not adopted experiment, the same area
    in another workspace. Related links go both ways, cross workspaces, and never block
    starting a task. `remove_related` drops a wrong link.

## 2. Work

- Change only this worktree, on the task's branch.
- Call `add_progress_note` when you take a decision worth remembering (the choice and why)
  or finish a meaningful step.
- When the work has to stop for a reason other than a prerequisite task (the user asks
  you to hold, or you wait on something outside Toodo), call `pause_task` with the
  reason and end your turn. It pauses the task as the app's Pause does and records the
  reason as a progress note. `resume_task`, with an optional note, continues a paused
  task once the reason is gone; for a prerequisite task use section 3 instead.

## 3. A prerequisite is needed: plan it and stop

When you find work that has to land before this task can be finished and that is outside
its scope (a bug in the base branch, a missing API, a refactor the change depends on):

1. Call `search_tasks` for the work and reuse a matching open task instead of creating
   a duplicate; read relevant done tasks with `get_task` before planning the new ones.
2. Create each missing task with `create_task`, with a description in the format below.
   Do not make it depend on your task: your task could then never finish. Link it with
   `add_related` to earlier tasks it builds on that it does not have to wait for.
3. Tell the user which tasks you created and why this task needs them.
4. Call `add_dependency` once, with `task_id` = your task and `depends_on` = every
   prerequisite. This pauses your task; the reply's `paused` and `message` confirm it.
   `get_task` and `list_tasks` show `ready` and `blockedBy` for any task.
5. End your turn. Do not continue the implementation and do not open a pull request; the
   user resumes the task in the Toodo app once its prerequisites are done.

## 4. Otherwise: finish with a pull request

1. Verify every criterion and run the checks the repository uses (tests, type checks,
   linters). Check each `manual` criterion with `check_criterion` and the evidence that
   shows it holds; leave the automatic ones to Toodo.
   - If `criteria` has `branch_merged_locally` instead of `pr_merged`, the repository has
     no `origin` remote: there is nothing to push and no pull request. Commit on the task
     branch and stop; the branch merged into `baseBranch` locally completes the task.
     Merge it yourself (`git merge` into `baseBranch` in the workspace repository) only
     with `agentMerge` `afterChecks` and once the repository's checks pass.
2. Commit on the task branch and push it: `git push -u origin <branch>`.
3. Open the pull request into the workspace base branch:
   `gh pr create --base <baseBranch> --head <branch>`, titled with the task title, with
   a body that summarizes the change and lists the criteria. If a pull request
   for the branch already exists, push to it instead of opening another. A pull request
   into any other base is ignored by Toodo.
4. Merge it only if the workspace allows it. `current_task` returns `agentMerge`:
   - `never` (the default): stop there. Do not merge the pull request; the user merges
     it, and the merge completes the task.
   - `afterChecks`: wait until every check on the pull request has finished and passed
     (`gh pr checks <number> --watch`). When one fails, fix it, push, and wait again.
     Then merge the pull request into `baseBranch` (`gh pr merge <number> --merge`, or
     the merge method the repository allows); the merge completes the task.

   Toodo checks pull requests every minute, so it moves the task to `in_review` and,
   after the merge, to `done` within about a minute. Right after you merge, the task can
   still read `in_review`; that is expected. Do not call `complete_task` on it; read it
   again with `get_task` after a minute, and only if it is still `in_review` then, call
   `report_blocker` with what you see.

   Even with `afterChecks`, never merge while a check is failing or pending or when the
   pull request has no checks, never bypass branch protection (no `--admin`), never
   merge a pull request into any branch other than `baseBranch`, and never release, tag,
   or merge `baseBranch` onward (e.g. into `main`).

# Writing task descriptions

Every task you create gets a description in GitHub-flavored Markdown with these two
sections, Toodo renders it and uses it as the GitHub issue body, and completion criteria
in `criteria`.

```markdown
## Purpose

The outcome the task delivers and why it matters, in one to three sentences.

## Background

What exists today, what prompted the task (e.g. found while working on #12), related
tasks and what they decided, links, and constraints the implementer has to respect.
```

```json
"criteria": [
  { "text": "`cargo test` covers the new rule", "kind": "command", "target": "cargo test" },
  { "text": "The user approved the wording", "kind": "manual" },
  { "text": "Docs site shows the page", "kind": "url", "target": "https://example.com/docs/x" }
]
```

- Write it for an agent that starts from this description alone, without your session.
- Make every criterion verifiable, one item each. Use an automatic kind when Toodo can
  check it (`command` with a short command that exits 0, `url`, `pr_open_ci_green`) and
  `manual` otherwise. The merge criterion (`pr_merged`, or `branch_merged_locally`
  without `origin`) is added first unless you pass `merge_criterion: false`, e.g. for
  research or an errand that ships no code.
- Use `-` lists, backticks for code, paths, and commands, fenced code blocks, and links;
  no raw HTML.
- Pick `task_type` by the kind of change (feat, fix, modify, refactor, docs, test, chore,
  rnd) and write a short imperative title.

# Criteria

| Kind | Checked by | When | `target` | Needs |
| --- | --- | --- | --- | --- |
| `manual` | you (`check_criterion`) or the user | once it holds | none | evidence |
| `pr_merged` | Toodo | every minute | none | an `origin` remote; the branch pull request into `baseBranch` merged |
| `branch_merged_locally` | Toodo | every minute | the start commit Toodo finds | no `origin` remote; the task branch merged into `baseBranch` locally |
| `pr_open_ci_green` | Toodo | every minute | none | an `origin` remote; the branch pull request open with passing checks |
| `url` | Toodo | every minute | http(s) URL | a GET answering 2xx or 3xx (`GET <url> -> <status>`) |
| `command` | Toodo | once every criterion but the merge criterion is met | shell command | the task worktree; exit status 0 there |

A task has one merge criterion (`pr_merged` or `branch_merged_locally`), the one its
repository uses; Toodo rejects the other, a second one, and `pr_open_ci_green` without
`origin`. A waiting `command` criterion says what it waits for in its evidence. A met
criterion stays met, but Toodo runs met `url` and `command` criteria again right before
it completes the task.

Add one criterion with `add_criterion` and delete one with `remove_criterion`; the
others keep their state and evidence:

```json
{ "task_id": 12, "text": "Tests pass", "kind": "command", "target": "npm test" }
{ "criterion_id": 33 }
```

Uncheck a manual criterion that no longer holds with
`check_criterion {"criterion_id": 32, "met": false}`; it is pending again without
evidence.

`update_task` with `criteria` replaces the whole list: a criterion whose `id` is left
out is deleted with its evidence. Keep one by sending `{"id": N}` alone (add `text`,
`kind`, or `target` to change it) and add new ones with `text` and `kind`:

```json
{ "id": 12, "criteria": [
  { "id": 31 },
  { "id": 32 },
  { "text": "The changelog lists the fix", "kind": "manual" }
] }
```

Each `id` appears once. Leaving out the merge criterion is rejected unless you also pass
`remove_merge_criterion: true`. `check_criterion` needs only `criterion_id` and
`evidence`; `add_dependency` and `remove_dependency` take `depends_on` as one task id or
an array, e.g. `{"task_id": 12, "depends_on": [10]}`.

# Adding a workspace

Every task belongs to a workspace, one repository on a machine. To plan tasks for a
repository Toodo does not have yet:

1. Call `list_workspaces` and reuse the workspace whose `location` already is the
   repository; never add a second workspace for the same path.
2. Only when it is missing and the user asked for it, call `create_workspace` with a
   `name` and the absolute `path` on the machine Toodo runs on. Pass `clone_url` to clone
   the repository into a new or empty directory, or leave it out to open a repository
   already cloned there. Pass `init: true` instead to make a plain folder a new git
   repository without a remote, whose tasks merge into the base branch locally. Set `default_base_branch` when pull requests go into a branch
   other than the repository's default one, e.g. `dev`.
3. Use the `id` it returns as `workspace_id` for `create_task`.

# Setting a machine's worktree root

Toodo creates each started task's worktree under the worktree root of the machine its
workspace is on, as `<root>/<workspace>/<type>-<title>-<id>`. `start_task` is rejected
for a task on a machine without one, e.g. on a freshly installed toodo-server.

1. Call `list_machine_settings`. It returns the machine Toodo runs on (`kind` `local`)
   and every known SSH machine (`kind` `ssh`, `label` = SSH host), each with its
   `worktreeRoot` (null when not set).
2. Set a missing root with `set_worktree_root`: `worktree_root` = an absolute directory
   on that machine, and `ssh_host` = the machine's label for an SSH machine (omit it for
   the local one). Use the directory the user named; when they named none, ask them
   instead of picking one.
3. Never change or clear a root that is already set unless the user asks; tasks started
   earlier keep their worktrees where they are.
