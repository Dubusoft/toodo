# Task Workflow

This document describes how a task moves from planning to a pull request.

## Task States

```
          Start / Resume        Open PR, or all          criteria met
                                criteria met with        (+ confirm when
                                a manual one             one is manual)
planned -----------------> in_progress ---------> in_review ---------> done (merged)
   ^                           |   |                  |
   |                           |   +-- all criteria met, all automatic --> done (merged)
   +------------ Pause --------+----------------------+
                               |                      |
                               +------ Conclude ------+---------------> done (not_adopted)
```

| State | Meaning |
| --- | --- |
| `planned` | Nobody works on the task: it was not started yet, or it was paused. |
| `in_progress` | A worktree exists and implementation is happening in herdr. |
| `in_review` | Awaiting completion, shown as "Awaiting completion": the task's pull request is open, waiting for its merge, or every completion criterion is met and one of them is manual, waiting for someone to confirm it. |
| `done` | Finished. Its `resolution` says how: `merged` (its completion criteria are met, e.g. its pull request is merged; dependents can start from the updated base branch) or `not_adopted` (concluded without merging, see step 7b; dependents stay blocked). |

Whether a `planned` task can be started is not a state: it can be started once every
task it depends on is `done` and merged, none of them `not_adopted` (it is **ready**). Its
dependencies can change while it is `planned` or `in_progress`, and through MCP also while
it is `in_review`; a `done` task cannot get new prerequisites (plan a follow-up task that
depends on them instead). Removing a dependency that does not exist, or a related link
that does not exist, is rejected. The UI names a `planned` task that was worked on before
"Paused" and offers "Resume" instead of "Start". MCP's `list_tasks` and `get_task` give
each task `ready` and `blockedBy`, the tasks it depends on that are not done yet or were
not adopted.

Work found while a task is in progress that the task needs before it can finish, such as
fixes found while verifying it, becomes a **prerequisite** of that task, never a
dependent: the task cannot finish before the fixes, so the fixes must not wait for it.
Adding a prerequisite that is not done to an `in_progress` task, in the app or by an agent
through MCP, pauses the task in the same step; the worktree and branch stay, and a
blocker note on the task names the prerequisites it waits on. In the app, Toodo asks for
confirmation first ("Pause and add"), whatever the state of the task's agent, and then
closes its herdr workspace, since that stops the agent. The server decides whether the
new prerequisite pauses the task: the app adds it without confirmation, and the server
adds nothing and asks for the confirmation when it would pause the task. An `in_review`
task is not paused; the agent's reply says so, and `pause_task` pauses it if it must wait.
An agent's `add_dependency` cannot wait for that answer, so it leaves the workspace open,
and its reply says whether the task was paused and what to do next: the paused
task then asks whether to close it ("Close workspace" or "Keep open", after which a small
"Close workspace" button stays), and a notification tells the user when the app
is in the background. The paused task shows "Waiting on #x, #y" and "Resume" stays disabled
until those prerequisites are done, or their dependencies are removed; it is then shown as
ready. Resuming opens the kept worktree in herdr again. If herdr fails to close the
workspace, the task stays paused and the error says so.

A blocker reported by an agent (`report_blocker`), or the one a pause by a new
prerequisite records, shows as a "Blocker" chip on the task and puts the task under
"Needs attention" until a later progress note, the task's completion, or resuming it; the
one a pause recorded also ends once its prerequisites no longer block the task.

Pausing ("Pause") an `in_progress` or `in_review` task moves it back to `planned`. It
keeps its branch, worktree, herdr workspace, commit records, and pull request, so
resuming it continues the same work (see step 3). Agents do the same through MCP:
`pause_task` pauses a task with a required reason, recorded as a progress note, and
`resume_task` resumes a paused task as "Resume" does, with an optional note. `done` is a
final state. A task that is abandoned is deleted (step 8); a paused one stays in the reports.

Agents can start, complete, and conclude tasks through Toodo's MCP server too
(`start_task`, `complete_task`, `conclude_task`), with the same steps and checks as the
app (steps 3, 7, and 7b) and the same status history, so a task can go from request to
merge without the user. Two differences: concluding through MCP rejects a task whose
branch has a pull request still open, recorded or not, instead of closing it, and agents are told never to start,
complete, or conclude their own task, whose pull request's merge completes it. Deleting
(step 8) stays in the app. `conclude_task` replies with the dependents the conclusion
leaves blocked and how to unblock each.

What the app and MCP can each do with a task:

| Action | App | MCP |
| --- | --- | --- |
| Create and edit tasks | Yes | Yes (`create_task`, `update_task`) |
| Add and remove dependencies and related links | Yes, while `planned` or `in_progress` | Yes, also while `in_review` |
| See whether a task is ready and what blocks it | Status chips and "Waiting on" | `ready` and `blockedBy` |
| Start, resume, and pause | Yes | Yes (`start_task`, `resume_task`, `pause_task`) |
| Check manual criteria | Yes | Yes (`check_criterion`) |
| Complete | Yes | Yes (`complete_task`) |
| Complete through another task's pull request | Yes | Yes (`complete_task` with `merged_with`) |
| Reopen a done task or change its outcome | Yes (step 7d) | No |
| Conclude without merging | Yes, closing an open pull request | Yes, rejected while a pull request is open |
| Record progress and blockers | Notes are shown | Yes (`add_progress_note`, `report_blocker`) |
| Close a paused task's herdr workspace | Yes | No |
| Open a pull request, link or create an issue | Yes | No (agents use `gh`) |
| Delete a task | Yes | No |

Every state change is recorded with its time in the task's status history, which feeds
the timeline view and year-end reports (see
[architecture.md](architecture.md#task-timeline)).

## Completion Criteria

A task is done when its completion criteria are met, not only when a pull request is
merged, so research and errands fit too. Criteria are structured data on the task (the
`task_criteria` table), never parsed from its description. Each has a text, a check kind,
a state (`pending`, `met`, or `failed`), the evidence of its last check, and who checked
it when (`user`, `agent`, or `toodo`):

| Kind | Checked by | Met when |
| --- | --- | --- |
| `manual` | the user in the app, or an agent through MCP (`check_criterion`, evidence required) | someone checks it |
| `pr_merged` | Toodo | the task's pull request is merged into the base branch |
| `pr_open_ci_green` | Toodo | the task's pull request is open and all its checks passed (or it is merged) |
| `branch_merged_locally` | Toodo | the task branch has commits since it started and the local base branch contains it |
| `url` | Toodo | a GET of its target, an http(s) URL, following redirects, answers 2xx or 3xx (evidence `GET <url> -> <status>`) |
| `command` | Toodo | its target, a shell command, exits with status 0 in the task worktree (`sh`, over `ssh` for SSH workspaces) |

Criteria are set when the task is created, in the app or through MCP (`create_task`), and
can be edited later (`update_task`, or one at a time through MCP with `add_criterion` and
`remove_criterion`) until the task is done: a kept criterion keeps its state unless its
kind or target changes. Unless its author opts out, a new task gets the merge criterion
first: `pr_merged` when the repository has an `origin` remote, `branch_merged_locally`
otherwise; "Done when merged" in the edit form puts it back on a task without one. A task
has at most one merge criterion, and criteria its repository could never meet are
rejected when they are added or their kind changes: `pr_merged` and `pr_open_ci_green`
without an `origin` remote, `branch_merged_locally` with one. `branch_merged_locally`
keeps the commit the branch started from (read when Toodo creates the branch, or the fork point once the branch is
ahead of its base), so a branch nobody committed to does not count as merged.

Toodo checks the automatic criteria of every `in_progress` and `in_review` task in the
background check (step 7), once a minute, and when a task is completed. A met automatic
criterion stays met, except that met `url` and `command` criteria run once more right
before the task is completed, and one that fails then keeps it open. A `command`
criterion runs only once every other criterion but the merge criterion is met, so it
checks the work before the merge without running every minute while the work goes on;
until then its evidence names the criteria it waits for. A failed check marks its
criterion `failed` with the reason as evidence and is retried, a failed command in the
background check only once the merge criterion is met too or when the task is completed;
a pull request that cannot be read changes nothing, as before.

The transition rule:

- Every criterion met and all of them automatic: the task is `done` right away (step 7).
- Every criterion met and one of them manual: an `in_progress` task moves to
  `in_review` and awaits completion until someone confirms it ("Confirm completion" in
  the app, or `complete_task`). Unchecking a criterion afterwards (`check_criterion`
  with `met: false`) makes it pending without evidence or checker and keeps the task
  there; confirming needs every criterion met.
- A task without criteria is completed only by confirming it.

Completing a task ("Complete"/"Confirm completion", `complete_task`) re-checks its
automatic criteria first and is rejected with the criteria that are not met. Done tasks
keep their criteria as a record; they cannot change. A done task completed by mistake is
reopened in the app (step 7d).

Work shipped without a pull request can be completed through MCP with
`complete_task {"id": 1, "without_pull_request": true, "note": "Deployed the configuration directly"}`.
The note must be non-empty. Toodo uses the shared branch PR lookup to require no pull
request at all, including closed or unrecorded ones. If one is merged, call
`complete_task` with only `id`; otherwise wait for merge, or conclude abandoned work
(an open PR is concluded by the user in the app).
Only `pr_merged` is satisfied by the note as evidence; every other criterion must
still hold. Rejections list unmet criteria and how to meet each. The branch commits
and completion note are recorded, the task ends as `done` with resolution `completed`,
and dependents become ready just as for `merged`. This cannot be combined with
`merged_with`. Concluding as `not_adopted` means the work was not shipped.

A task completed without criteria, a pull request, or `merged_with` also ends as
`completed`, not `merged`. A verified local branch merge still ends as `merged`.

When the database was migrated to criteria, every existing task got the `pr_merged`
criterion (met for tasks done as merged), followed by the `- [ ]` and `- [x]` items of the
`## Done when` section of its description as manual criteria, checked items met. The
description itself stays as it was. A task of a workspace without `origin` that was
created before can switch its merge criterion to `branch_merged_locally` by editing it.

## Workspaces Without a Remote

Every workspace is a git repository, but it does not need an `origin` remote. Without
one Toodo uses local git only: task branches start from the local base branch (step 3),
nothing is pushed, no pull request is opened, and `gh` never runs. The task's
`branch_merged_locally` criterion is met once the task branch is merged into the base
branch in the repository itself (`git merge` there, by the user or by an agent whose
workspace allows agents to merge), which completes the task. Concluding (step 7b) works
the same, without the pull request lookup. "Open PR" is rejected because there is no
GitHub repository to open it on.

## Lifecycle

### 1. Register a workspace

The user picks a directory on the server's machine ("Local"), or a remote directory on a saved herdr SSH
machine (its SSH target plus a POSIX path, or a Windows path on a Windows host), and one of
these sources:

- **Clone**: Toodo runs `git clone <url> <path>`. The path must not exist or must be an
  empty directory.
- **Open**: the path already holds a cloned repository. Toodo checks it with
  `git rev-parse --show-toplevel` and records the repository root.
- **Init**: the path is a plain folder, or does not exist yet. Toodo runs
  `git init --initial-branch=<base> <path>` (`main` unless the user entered a base branch)
  and records the repository root. The repository has no remote, so its tasks use local
  git only (see Workspaces Without a Remote); its first task start creates the
  `Initial commit` (step 3).

A remote machine is saved once in herdr: run `herdr machine add <host>` in a terminal on
the server and answer herdr's setup prompts. Toodo lists the saved machines in the sidebar.

Git runs locally as `git` and remotely as `ssh <machine> git ...` (on a Windows host through
an encoded PowerShell script; see "Windows Hosts" in [server.md](server.md)). The default
base branch is the one the user enters, or else the branch `origin/HEAD` points to, or
else the checked-out branch. It can be changed later by picking one of the repository's
branches (local and `origin` branches, listed after `git fetch --prune origin`) or by
creating a new branch from one of them (`git branch --no-track <name> <start>`, then
`git push --set-upstream origin <name>`); both are rejected while a task of the workspace
is `in_review`. Deleting a workspace never deletes its repository, and is
rejected while a not-yet-started task of another workspace depends on one of its tasks.

### 2. Plan tasks

The user creates tasks and declares dependencies between them, also on tasks of other
workspaces (a library task that an application task needs first). Toodo rejects any
dependency that would create a cycle and shows which tasks are ready. The creation
time is recorded as the task's `plannedAt`. The sidebar's "All workspaces" entry lists
the tasks of every workspace on one timeline (its default view, which can be narrowed to
one workspace) and in one list.

A task of any type that is not `done` can be linked to a GitHub issue of its workspace
repository (the repository of the `origin` remote): an existing one by number, checked
with `gh issue view <number> --repo <repo>`, entered when the task is created or later,
or a new one that Toodo opens from the task title and description
(`gh issue create --repo <repo>`). Toodo does not open issues on its own: a task is
already the record of its work, so an issue is only worth it when others track it on
GitHub. The pull request of a task with an issue closes the issue on merge, because
Toodo keeps a closing reference (`Closes #<number>`) in its body (steps 6 and 7).
Unlinking an issue leaves an existing pull request body as it is.

### 3. Prepare the worktree

When the user starts a `planned` task whose dependencies are all `done`, Toodo:

1. Resolves the worktree directory as
   `<worktreeRoot>/<workspace-name>/<task-type>-<task-name>-<task-id>`, where
   `worktreeRoot` is set per machine (see
   [architecture.md](architecture.md#worktree-layout-and-branch-naming)). If the machine
   has no `worktreeRoot` yet, the user is asked to set it first.
2. Derives the task branch as `<task-type>/<task-name>-<task-id>`.
3. If the repository has no commit yet (e.g. a freshly created, empty GitHub repository)
   and no local `<baseBranch>`, points `HEAD` at `<baseBranch>`, creates an empty
   `Initial commit` on it (staged files stay staged), and pushes it to `origin` when that
   remote exists, so the base branch exists for the worktree and the pull request. If
   any of this fails, the task stays `planned`.
4. Creates the task branch from the latest base on `origin`, so it contains pull
   requests merged since the user last updated the local base: runs
   `git fetch --quiet origin <baseBranch>` (on the SSH machine for SSH workspaces), then
   `git branch --no-track <branch> origin/<baseBranch>`. The branch gets no upstream, so
   pulling on it never pulls the base and a push cannot land on the base; the first
   `git push --set-upstream origin <branch>` sets its own remote branch. Only `origin/*`
   references change; the local base branch and its working copy are untouched. Without
   an `origin` remote, or when `origin` has no `<baseBranch>`, the branch starts from the
   local `<baseBranch>`. When the fetch fails (network, authentication), it also starts
   from the local base and the task gets a progress note "Started from local
   `<baseBranch>` (`<commit>`) because fetching origin failed: `<error>`", which the MCP
   `start_task` reply includes. An existing branch of that name is used as it is.
5. Calls `herdr worktree create --cwd <repository> --path <dir> --branch <branch>
   --base <start> --no-focus` (prefixed with `--machine <label>` for SSH
   workspaces) to check the branch out into a git worktree and open it as a herdr
   workspace. If herdr fails, the branch created in step 4 is deleted again, the task
   stays `planned`, and nothing is stored.
6. Stores `branch`, `worktreePath`, and `herdrWorkspaceId` on the task and moves it to
   `in_progress`, which records `startedAt`.

A paused task that already has a branch resumes on it instead ("Resume"): Toodo opens its
kept worktree with `herdr worktree open --cwd <repository> --path <worktreePath>
--no-focus`, which also finds the herdr workspace that still has it open. If the
checkout is gone, the branch is checked out into a new worktree like "Restore worktree"
(step 5) without fetching, or created from the local `<baseBranch>` when neither the repository nor `origin` has it.
`startedAt` stays the time of the first start.

### 4. Implement in herdr

Implementation happens directly in herdr: the user and/or AI agents work in panes bound
to the task's worktree. Toodo does not embed a terminal; it focuses the herdr workspace
(`herdr workspace focus`). Toodo may optionally send the task description as a prompt to
an agent (`herdr agent prompt`) and shows agent state (working, blocked, done) from
`pane.agent_status_changed` events. Tasks of local workspaces show the agent state of
their herdr workspace; if the user removes a task's worktree in herdr, Toodo forgets
the worktree, and if they open it again in herdr, Toodo follows the new workspace.

An `in_progress` or `in_review` task that lost its worktree this way can get it back
("Restore worktree"). Toodo checks out the task's branch, which herdr keeps when it
removes a worktree, with `herdr worktree create --cwd <repository> --path <dir>
--branch <branch> --base <branch> --no-focus`; herdr checks out an existing branch as
is and ignores `--base`. If the repository no longer has the branch, `--base
origin/<branch>` recreates it from `origin`; if neither exists, the restore is
rejected. The directory follows the current task title, and the status, commit
records, and pull request stay as they were.

While a task is `in_progress` or `in_review` and has a worktree, Toodo warns when its
branch has fallen behind the base branch, which the DAG makes common: a prerequisite
is merged into the base while its dependent still builds on the older base. In the
worktree it fetches `origin <baseBranch>` and counts `git rev-list --count
<taskBranch>..origin/<baseBranch>` (`<baseBranch>` without an `origin`); a failed fetch
counts against the last fetched base and says so. A task with a pull request also
shows whether GitHub can merge it without conflicts (`gh pr view <url> --json
mergeable`). The check reruns every five minutes and whenever tasks change in the
background, e.g. when a prerequisite's pull request is merged. Toodo only warns; it
never rebases or merges the branch.

### 5. Record commits

Toodo reads the commits on the task branch that are not on the base branch
(`git log --reverse <baseBranch>..<taskBranch>` in the worktree, over `ssh` for remote
workspaces) and stores a `CommitRecord` (SHA, message, author, timestamp) for each one,
oldest first, replacing the previous records. This runs automatically when the task is
completed; while the task is in progress, the user can trigger it manually ("Refresh
commits") to refresh the list.

### 6. Open a pull request

When the user opens the pull request of an `in_progress` task ("Open PR"), Toodo:

1. Reads the commits of the task branch. A branch without commits ahead of the base
   branch is rejected, because there is nothing to open a pull request for, unless its
   pull request is already merged (step 3).
2. Reads the `origin` remote URL and derives the GitHub repository (`host/owner/name`)
   from it. A remote that is not a hosted repository URL is rejected.
3. Looks up the most recent pull request of the task branch in any state
   (`gh pr list --repo <repo> --head <branch> --state all`), which may have been opened
   outside Toodo, e.g. by an agent in herdr. An open or merged one whose base is not the
   workspace base branch is rejected, because dependent tasks start from that branch. A
   merged one is recorded without pushing (if the branch log is empty after the merge,
   the commit records stored earlier are kept) and the next step is skipped.
4. Pushes the task branch to `origin` (`git push --set-upstream origin <branch>`, over
   `ssh` for remote workspaces), then reuses the open pull request, or, when there
   is none or the last one was closed, opens one with
   `gh pr create --repo <repo> --head <branch> --base <baseBranch>`, titled with the task
   title and described with the task description, followed by `Closes #<number>` when
   the task has an issue. A reused open pull request whose body has no closing reference
   to the issue (`close`, `fix`, or `resolve` in any form, then `#<number>`) gets one
   appended (`gh pr edit <url> --body`). `gh` always runs on this machine, so SSH
   machines do not need it.
5. In one transaction, stores the commit records and the pull request URL (and, for a
   merged one, its `mergedAt` as `pullRequestMergedAt`) and moves the task to
   `in_review`, which records `reviewAt`. Dependent tasks keep waiting: their worktrees start from the base
   branch, which does not contain this work until the pull request is merged.

If any step fails, the task keeps its status and previous commit records and the error is
shown; opening it again is safe, because pushing is repeatable and an open pull request
is reused instead of created twice. The same action on an `in_review` task ("Push to
PR") pushes commits added after review feedback and refreshes the commit records.

Review and merging happen on GitHub; Toodo never merges a pull request itself. Agents
stop at the open pull request too, unless the workspace's agent merge setting is "after
checks pass": then the agent merges its own pull request into the base branch once every
check on it passed.

### 7. Complete the task

A task completes when its completion criteria are met (see Completion Criteria). For the
default `pr_merged` criterion this is the pull request flow below; other criteria are
checked the same way, and a task without a pull request records the commits of its
branch since it started instead of a pull request snapshot.

When the user completes an `in_review` task with a pull request, Toodo reads the state, base branch, and
merge time of its pull request (`gh pr view <url> --json url,state,baseRefName,mergedAt`). A pull request into
another branch than the workspace base branch is rejected. Only a merged pull request
completes the task. Toodo first reads what reviews need about it (`gh pr view <url> --json
number,title,additions,deletions,changedFiles,mergeCommit,author,reviews,commits`); a
failure keeps the task `in_review`, so a completed task always has this snapshot. It then
closes its herdr workspace (`herdr workspace close
<herdrWorkspaceId>`), which keeps the worktree checkout on disk, then moves the task to
`done` (recording `completedAt`), stores `pullRequestMergedAt` and the pull request
snapshot, replaces the commit records with the commits of the pull request (so commits
pushed after it was opened are recorded too; a pull request without commits keeps the
records stored earlier), and clears `herdrWorkspaceId` in one transaction, which may make
dependent tasks ready to start. A workspace herdr no longer has is treated as already closed; any other herdr
failure keeps the task `in_review`, and completing it again is safe. An open pull request is rejected until it is
merged; a pull request closed without merging is rejected too, so the user reopens it or
pauses the task.

The user rarely needs to complete a task by hand: while the server runs, Toodo checks the
pull request of every `in_review` task once a minute and completes each task whose pull
request was merged, in the same way and with the same checks. Closed pull requests are
left alone; an open one only gets the closing reference to the task's issue if its body
lacks it, so a pull request an agent opened in herdr closes the issue too. Linking an
issue to a task whose pull request is open adds the reference right away. A failed check (e.g. `gh` is not signed in, or a herdr failure)
keeps the task `in_review` and is logged once until it changes; the next check tries
again. The task list refreshes when a task is completed this way. The next check starts a
minute after the previous one finished, so a task whose pull request was just merged can
still read `in_review` for up to about a minute; the MCP instructions and the toodo skill
tell agents to read the task again after a minute instead of completing it by hand.

In the same check, Toodo also looks up the pull request of the branch of every
`in_progress` task that has a branch and a worktree (steps 2 and 3 of opening a pull
request, `gh pr list --repo <repo> --head <branch> --state all`), so a pull request
opened outside Toodo, e.g. by an agent in herdr, is picked up within a minute. An open
or merged one into the workspace base branch is recorded as in step 5 without pushing,
which moves the task to `in_review`; a merged one then completes the task in the same
check. A branch without a pull request, or with a closed one only, leaves the task
`in_progress`; a pull request into another base branch or a failed lookup is logged once
until it changes.

Completion never waits for the user: dependents start as soon as the work is on the base
branch, and `completedAt` stays the time of the merge check. A completion note is
optional, since the task description already says what the work is: the user may add one
to a `done` task in the task list to record what the work achieved (the
`set_completion_note` command; only `done` tasks have one, and an empty note clears it),
and reports include it.

The worktree stays until the task is deleted (step 8).

### 7b. Conclude without merging

Some work ends without anything to merge, typically research and development (`rnd`
tasks, though any type can end this way): much was tried, and the conclusion is not to
adopt it. The plan still has to be finished, and the reason has to be kept. The user
concludes such an `in_progress` or `in_review` task ("Conclude") and must write the
conclusion: what was tried, what was found, and why it is not adopted. Toodo
(`conclude_task`):

1. Rejects an empty conclusion, and any task that is not `in_progress` or `in_review`.
2. Records the commits of the branch that are not on the base branch, as when
   refreshing commits; a task without a worktree, or a branch whose log is empty, keeps
   the commit records stored earlier.
3. If the task has a branch and the repository's `origin` is on GitHub, looks up the
   pull requests from the branch into the workspace base branch (`gh pr list --head
   <branch> --base <base> --state all`), whether or not Toodo recorded one: an agent may
   have opened one that the background check has not adopted yet. A merged one rejects
   the conclusion, since that task completes with its merge (step 7). An open one is
   closed without merging, with the conclusion as a comment (`gh pr close <url>
   --comment <conclusion>`), and its URL is recorded on the task; closed ones are left
   alone. If the lookup fails, nothing is concluded and the error is shown.
4. Closes the task's herdr workspace as in step 7, keeping the worktree on disk.
5. Moves the task to `done` with the resolution `not_adopted` (recording `completedAt`),
   stores the conclusion as its completion note, and clears `herdrWorkspaceId`, in one
   transaction. The branch, worktree, and pull request URL stay (the URL of a pull
   request closed in step 3 replaces the recorded one), so the work can be looked at
   later.

The tasks that depend on it are not released: they were planned to build on work that
is not there. The task list marks the dependency and says it was not adopted, and the
user removes the dependency or changes the plan before starting them. The conclusion can
be edited later but not cleared. Reviews count concluded tasks as completed and also
report how many were not adopted, with their conclusions.

### 7c. Complete through another task's pull request

One pull request sometimes ships the work of several tasks, e.g. an agent that fixed a
batch of small tasks on one branch. Only the task whose branch it is completes with its
merge (step 7); the others did ship, so concluding them as `not_adopted` would be wrong.
Agents complete each extra task through MCP with `complete_task` and `merged_with`; the
user does it in the app with "Complete as shipped by...", offered in the Conclude form
and on a task done as not adopted. The work is named by the ID of the task that shipped
it, which must be `done` as merged or completed, or by the URL of the pull request, which
must be merged into the workspace base branch (read with `gh pr view`). A task done that
way in turn passes on the pull request it shipped with; a task done without a recorded
pull request passes on itself. Toodo:

1. Accepts an `in_progress` or `in_review` task, or one already `done` as
   `not_adopted`, which is how such tasks were closed before; it rejects the task itself
   or its own pull request as `merged_with`.
2. For a task being worked on, records the commits of its branch and looks up the pull
   requests of its branch as in step 7b: a merged one rejects it (it completes with its
   own merge), and so does an open one, which the user closes first. It then closes the
   task's herdr workspace.
3. Moves the task to `done` with the resolution `merged` (or `completed` when the other
   task was completed without a pull request), records that pull request and its task
   (`mergedWith`, without a pull request URL for a task that has none) and the merge
   time, and clears `herdrWorkspaceId`. A `not_adopted` task keeps its status history
   and conclusion and only changes its resolution.

Dependents are released as after any merge, reviews count the task as merged, and the
task list shows which pull request or task shipped it ("Shipped with").

### 7d. Reopen a done task or correct its outcome

A task completed or concluded by mistake can be fixed in the app; MCP leaves done tasks
alone (`update_task` rejects them and points to `add_progress_note`).

- "Reopen" (`reopen_task`) takes a required reason. The task moves back to `planned`,
  paused if it was started, so Resume continues on its branch; its resolution,
  completion note, and `mergedWith` are cleared, and a progress note keeps the reason
  with the earlier outcome. The status history records the move, and the timeline shows
  it as Reopened; Completed shows again once the task is done again. Reopening is
  rejected while a task that depends on it has started, since that work built on the
  outcome.
- "Change outcome" (`set_task_outcome`) keeps the task done and replaces its resolution
  (merged, completed, or not adopted) and its completion note, which is required; a
  progress note keeps the earlier outcome and note. Merged needs a recorded merge, its
  own or the one it shipped with. Not adopted keeps dependents waiting again.

### 8. Delete the task and its worktree

When the user deletes a task that is not `in_progress` or `in_review` and still has a
worktree ("Delete"), Toodo first removes the worktree:

1. If the task still has a herdr workspace (a paused task), calls
   `herdr worktree remove --workspace <herdrWorkspaceId>` (prefixed with
   `--machine <profile-id>` for SSH workspaces), which deletes the checkout and closes
   its herdr workspace. The task branch is kept, locally and on `origin`.
2. If the task has no herdr workspace (a completed task, whose workspace was closed) or
   herdr no longer has it (the user closed it, which keeps the checkout, or herdr lost
   its session), opens the checkout again with
   `herdr worktree open --cwd <repository> --path <worktreePath> --no-focus` and removes
   it through the new workspace. If herdr cannot find the checkout either, it is already
   gone and nothing is removed.
3. Clears `worktreePath` and `herdrWorkspaceId` on the task, then deletes the task with
   its dependency edges, commit records, and status history.

A checkout with modified or untracked files is rejected and kept together with the task;
the user can then force the delete ("Force delete", `--force`), which discards those
files. Any other herdr failure keeps the task unchanged. A task without a worktree is
deleted without running herdr.
