# Runners

The runner of a workspace decides what starting one of its tasks does: where the task's
worktree comes from and how agents work in it. You pick it in the third step of a new
workspace, after the source and the completion. This page compares the four runners and
helps you pick one; [workflow.md](workflow.md) has the details of each.

## At a Glance

| | herdr | Plain | tmux | No runner |
| --- | --- | --- | --- | --- |
| Starting a task | Creates the task branch and worktree and opens them as a herdr workspace | Creates the task branch and worktree (`git worktree add`) | Same as Plain | Only moves the task to `in_progress` |
| Where agents work | In herdr panes you open and steer yourself ("Open in herdr") | As a background `claude` or `codex` process, started with "Start run" in the task's Runs | As `claude` or `codex` in a detached tmux session, started with "Start run" | Wherever you work; Toodo starts nothing |
| Interactive | Yes, in a terminal | No: the prompt goes in on stdin, the app streams the logs | Attach to the session with the command the run shows | - |
| Needs on the host | herdr installed and running | `claude` or `codex` on `PATH`; on a POSIX SSH host also util-linux `setsid --wait` | tmux and `claude` or `codex` on `PATH` | Nothing |
| Hosts | Local; SSH (POSIX or Windows) | Local; SSH (POSIX or Windows) | Local; SSH on a POSIX host | Any |
| Server restart | The agents keep running in herdr | A local run is followed again; a remote run is reconciled in the background | The tmux session survives and the server picks it up again | - |
| Run queue and time limit | - | Yes | Yes | - |
| Sources | Local git, GitHub | Local git, GitHub | Local git, GitHub | Any |
| Completions | Any | Any | Any | Manual only |

The host is the server ("Local") or the SSH machine of the workspace. Every SSH machine is
a machine saved in herdr (`herdr machine add <host>` in a terminal on the server), so a
workspace on an SSH machine needs herdr on the server even when its runner is Plain or
tmux.

## Which One to Pick

- **herdr** when herdr runs on the server and you want to watch and steer agents in a
  terminal: you open the task in herdr, talk to the agent, and see its state (working,
  blocked, done) in Toodo. This is the default for a git source while herdr runs.
- **Plain** when there is no herdr, or when agents should work on their own: "Start run"
  (or the MCP tool `start_plain_run`, for an orchestrating agent) starts `claude` or
  `codex` in the task worktree with the task's title, description, and criteria as the
  prompt. The app shows the run's state, todo list, and logs. This is the default for a
  git workspace on the server while herdr does not run there.
- **tmux** for runs like Plain that you can also attach to in a terminal, e.g. to watch
  a long run live. It needs a POSIX host with tmux, so it is not offered for a Windows SSH
  machine.
- **No runner** for work that is not code, or that is tracked elsewhere: a plain folder,
  or a repository whose tasks you complete by hand. Starting a task creates no branch, so
  its completion must be Manual.

Host notes:

- A macOS SSH host has no util-linux `setsid --wait`, which Plain runs over SSH need; use
  herdr or tmux there.
- A Windows SSH host takes herdr or Plain.
- Settings > Runners shows whether herdr is installed and running on the server and
  whether tmux, `claude`, and `codex` are on its `PATH`. A runner whose tool is missing
  can still be picked; install the tool before you start the first task.

Plain and tmux runs share the same controls: one run at a time can write to a worktree,
each run stops after its time limit (4 hours unless the workspace or task sets another),
and each machine can limit how many runs it runs at once, queueing the rest (Runs at
once, beside the worktree root). The workspace's agent options set the model and
permission mode of its runs. See steps 4b and 4c in [workflow.md](workflow.md).

## Changing the Runner Later

The app shows the runner of a workspace beside its source and completion but has no
control to change it, so pick it with care. An agent can change it with the MCP tool
`update_workspace` and its `runner` argument, which runs the same checks as creating a
workspace:

- It is rejected while a task of the workspace is `in_progress` or `in_review`, or
  still has a workspace open in the current runner, because that task's worktree and
  agents belong to it. Complete or conclude those tasks first.
- The new runner must fit the source and completion: No runner only with completion
  Manual, every other runner only with a git source.
- Switching to herdr opens the repository in herdr.

To start over instead, add the repository again as a new workspace with the runner you
want; deleting the old workspace never deletes the repository.
