# Troubleshooting

The problems new setups run into most, by what you see. Every error Toodo shows names the
next step that works; this page adds the background. Paths assume the default data
directory, `~/.local/share/toodo-server`; `toodo status` prints the one in use.

## The Server

### The web app does not load

Check whether the server runs:

```sh
toodo status          # exits 0 when it runs, 3 when it is stopped
toodo start
```

For the systemd user service, read its log with `journalctl --user -u toodo-server -n 50`;
a server started by `toodo start` without the service logs to `server.log` in the data
directory. `toodo start` and `toodo init` stop with
`127.0.0.1:47616 is already in use by another program; pick another port with: toodo init --port <port>`
when another program has the port; run the command it prints.

The server listens on loopback only by default, so `http://127.0.0.1:47616` works on the
server itself. From another device, reach it through a tunnel; see
[Off the Machine](server.md#off-the-machine-cloudflare-tunnel-and-access).

### Sign-in says the token is wrong

The access token is the content of `web-token` in the data directory:

```sh
cat ~/.local/share/toodo-server/web-token
```

Do not paste the MCP token (`mcp-token`): it is for agents and is rejected at `/api`.
After 20 wrong tokens within a minute, the server answers `429` to that address for the
rest of the minute, even with the right token; wait for it. A device token that expired
asks you to sign in again with `web-token`.

### `toodo update` installs nothing

`toodo update` stays on the channel of the installed version: `dev` for a prerelease,
`latest` for a release. When the newest version of that channel is older than the
installed one, it prints the command that installs it anyway,
`toodo update --channel <channel> --allow-downgrade`. When the server does not answer
after an update, `toodo update` exits `1` with the commands to find out why and to go
back to the previous version.

## Workspaces and Runners

### herdr is not running

Workspaces with runner herdr need the herdr server on the machine: `herdr status --json`
shows whether it runs. Start herdr there, then try again. Settings > Runners shows what
the server found. A workspace on the server can use runner Plain instead; see
[runners.md](runners.md). SSH machines are saved in herdr, so without herdr on the
server there are no SSH machines to add workspaces on.

### "gh is not logged in" or gh is missing

Workspaces with source GitHub run `gh` on the server for pull requests and issues, as
the user that runs the server:

```sh
gh auth login                       # github.com
gh auth login --hostname <host>     # GitHub Enterprise
gh auth status
```

For the systemd service, log in as the same user; a token in `GH_TOKEN` or
`GH_ENTERPRISE_TOKEN` in the service's environment works too. A repository without
GitHub can be a workspace with source Local git, which never needs `gh`.

### "worktree root is not set for machine local"

Tasks of workspaces with a runner get their worktrees under the worktree root of the
machine. Open the workspace and set "Worktree root on Local" (or on the SSH machine)
above its tasks, then start the task again.

### The runner of a workspace cannot change

The app keeps the runner a workspace was added with. An agent can change it with the
MCP tool `update_workspace` while no task of the workspace is `in_progress` or
`in_review`; otherwise it is rejected with
`the runner of workspace <id> cannot change from <old> to <new> while task <id> is being worked on with it`.
Complete or conclude that task first, or add the repository again as a new workspace.
See [Changing the Runner Later](runners.md#changing-the-runner-later).

## Runs

### Start run is disabled

- The agent is not installed: `claude was not found on the server's PATH` (or `codex`).
  Install it for the user that runs the server, log it in, then press Refresh in the
  task's Runs.
- Another run holds the worktree: only one run at a time can write to it. Stop it, or
  wait until it ends.
- An earlier run is `unknown`: its end was not seen, e.g. after a lost SSH connection.
  Reconcile it to settle it from what is left on its host, or stop it.

### A run stays queued

The machine runs as many runs at once as its limit allows (Runs at once, beside the
worktree root); the rest wait in order and start on their own within a few seconds of a
run there ending. Stop a queued run to take it out of the queue.

### Plain runs fail on an SSH host

A POSIX SSH host needs util-linux `setsid --wait` for Plain runs:
`<host> has no util-linux setsid --wait, which plain runs over SSH need`. macOS lacks
it; use runner herdr or tmux there. The host also needs `claude` or `codex` on the `PATH`
of a non-interactive SSH session.

## Tasks and Pull Requests

### Open PR says the branch has no commits

`branch <branch> has no commits that are not on <base>; commit the work before opening a pull request`.
The agent changed files but did not commit them. Commit in the task worktree (the path
is in the task's details), then select Open PR again.

### The pull request is merged but the task is still awaiting completion

Toodo checks the pull requests of tasks in review once a minute, so a task can read
"Awaiting completion" for up to about a minute after the merge. If it stays there:

- `gh` must work for the server's user (see above); a failed check is logged once and
  retried every minute.
- A pull request into another branch than the workspace's base branch never completes
  the task. Retarget it, or change the base branch of the workspace.
- A pull request closed without merging does not complete it either; reopen it, or pause
  or conclude the task.

### The worktree of a task is gone

When a worktree is removed outside Toodo (in herdr, or by deleting the directory), the
task shows Restore worktree. It checks the task branch out again, from `origin` if the
local branch is gone too, and keeps the task's status, commits, and pull request.

### The task branch is behind its base

The task's details warn when the base branch got commits the task branch does not have,
e.g. after a prerequisite was merged. Toodo only warns; rebase or merge the base into
the branch in the worktree yourself, or ask the agent to.

## Agents and MCP

### The agent gets 401 from Toodo's MCP server

The token `toodo init` gave the agent was replaced, or the agent reaches another Toodo
server. The `401` body names the server's instance. Run `toodo stop` and `toodo start`:
they register the endpoint and the current token again with Claude Code and Codex where
`toodo init` registered them. For other clients, copy the configuration from Settings >
Agent access again.

### The agent cannot reach Toodo from an SSH machine

Agents on an SSH machine use the same MCP configuration through a reverse SSH tunnel the
server keeps open to each machine with a workspace. The tunnel needs a working
`ssh <host>` for the server's user, with the key in its ssh-agent or `~/.ssh/config`.
