# Runners

The runner of a workspace decides what starting one of its tasks does: where the task's
worktree comes from and how agents work in it. You pick it in the third step of a new
workspace, after the source and the completion. This page compares the four runners and
helps you pick one; [workflow.md](workflow.md) has the details of each.

## At a Glance

| | herdr | Plain | tmux | No runner |
| --- | --- | --- | --- | --- |
| Starting a task | Creates the task branch and worktree and opens them as a herdr workspace | Creates the task branch and worktree (`git worktree add`) | Same as Plain | Only moves the task to `in_progress` |
| Where agents work | In herdr panes you open and steer yourself ("Open in herdr") | As a background agent CLI process (see [Agent Profiles](#agent-profiles)), started with "Start run" in the task's Runs | As an agent CLI in a detached tmux session, started with "Start run" | Wherever you work; Toodo starts nothing |
| Interactive | Yes, in a terminal | No: the prompt goes in on stdin, the app streams the logs | Attach to the session with the command the run shows | - |
| Needs on the host | herdr installed and running | An agent CLI on `PATH`; on a POSIX SSH host also util-linux `setsid --wait` | tmux and an agent CLI on `PATH` | Nothing |
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
  whether tmux and each agent CLI are on its `PATH`. A runner whose tool is missing
  can still be picked; install the tool before you start the first task.

Plain and tmux runs share the same controls: one run at a time can write to a worktree,
each run stops after its time limit (4 hours unless the workspace or task sets another),
and each machine can limit how many runs it runs at once, queueing the rest (Runs at
once, beside the worktree root). The workspace's agent options set the model and
permission mode of its runs. See steps 4b and 4c in [workflow.md](workflow.md).

## Agent Profiles

Plain and tmux runs start one of these agent CLIs, looked up by name on the host's
`PATH`. Claude and Codex are always offered in a task's Runs; the others show there once
the server finds them. Each profile after Claude and Codex was added once a contract
probe against the pinned release below confirmed its command line and JSON events.
What a probe did not confirm is off: the app disables it, and `start_plain_run` rejects
a run that needs it with the next step.

| Agent | Command | Pinned | Toodo MCP | Follow-ups | Todo list | Model | Permission modes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude | `claude -p --output-format stream-json` | - | Yes | Yes | Yes | Yes | all |
| Codex | `codex exec --json` | - | Yes | Yes | Yes | Yes | all |
| pi | `pi -p --mode json` | 0.73.1 | No | Yes | No | Yes | `read_only` (`--tools read,grep,find,ls`), `bypass` |
| omo | `omo -p --mode json` | 5.1.61 | No | Yes | Yes | No | `bypass` |
| OpenCode | `opencode run --format json` | 1.19.5 | Yes | Yes | Yes | Yes | `read_only` (`--agent plan`), `edit` (its own settings), `bypass` (`--auto`) |
| Gemini | `gemini -p "" --output-format stream-json --skip-trust` | 0.67.0 | No | Yes | Yes | Yes | `read_only` (`plan`), `edit` (`auto_edit`), `bypass` (`yolo`) |

Notes:

- The prompt always goes in on stdin, and a follow-up resumes the session id the agent
  reported (`--session` for pi, omo, and OpenCode, `--resume` for Gemini).
- OpenCode gets the Toodo MCP server from a file in the run directory named by
  `OPENCODE_CONFIG`, merged over the user's configuration; the bearer token stays in
  the environment, and the file only holds the placeholder `{env:TOODO_MCP_TOKEN}`. pi
  has no MCP client. omo takes no MCP server on its command line, and Gemini CLI reads
  MCP servers only from settings files (its system settings path is accepted only in a
  root-owned directory), which a run must not change.
- pi and omo never ask before running a tool, so they have no `edit` mode, and their
  default is `bypass`. Gemini also defaults to `bypass`: nobody can answer its approval
  prompts in headless mode. `--skip-trust` keeps Gemini CLI from dropping the approval
  mode in the new task worktree.
- omo takes no model on its command line; a task or workspace model makes its runs fail
  to start, so clear it or pick another agent.
- Gemini CLI writes its todo list only for Gemini 2 models.

The parsing is pinned by fixture tests (`src-tauri/src/runtime/plain/profile_fixtures.rs`,
fixtures in `fixtures/`), which run in `cargo test --lib`. Smoke tests in
`profile_smoke.rs` run the installed CLIs and are ignored by default. To run them,
install the pinned releases, start the fake model server, and name each CLI:

```sh
bun scripts/agent-smoke/fake-model.mjs 47901 /tmp/requests.jsonl probe-token &
cd src-tauri
TOODO_AGENT_SMOKE_URL=http://127.0.0.1:47901 \
  TOODO_AGENT_SMOKE_PI=/path/to/pi TOODO_AGENT_SMOKE_OPENCODE=/path/to/opencode \
  TOODO_AGENT_SMOKE_GEMINI=/path/to/gemini TOODO_AGENT_SMOKE_OMO=/path/to/omo \
  cargo test --lib profile_smoke -- --ignored
```

The fake server answers as an OpenAI-compatible API (pi, OpenCode), the Gemini API, and
an MCP server; each test gives its CLI an isolated `HOME`. omo has no provider setting
on its command line, so its test runs against the signed-in account. To add another
agent, confirm from its official documentation how it runs headless with JSON output,
run the same probe against a pinned release, and record the fixtures it wrote.

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
