# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## Language Policy (mandatory)

| Artifact | Language |
| --- | --- |
| Documentation (`README.md`, `docs/`, `AGENTS.md`, ADRs) | English |
| Code, identifiers, code comments, docstrings | English |
| Commit messages, branch names, PR titles and descriptions | English |
| Log messages, error messages, CLI/UI strings in source | English |
| Test names and test fixtures | English |
| Replies to the user in chat/conversation | **Korean** |

Rules:

- Everything written into the repository is English. No Korean text in tracked files,
  except for user-facing localization resources if the product later adds a Korean locale.
- Only conversational responses to the user are written in Korean. When quoting code,
  paths, commands, or identifiers in a Korean reply, keep them verbatim in English.
- If the user writes a requirement in Korean, translate it into English before recording
  it in docs, comments, task descriptions, or commit messages.

## Project Summary

Toodo is a task-planning app that turns a plan into implemented, reviewed code:

1. Register a **workspace**: clone a repository into, or open a repository already
   cloned at, a local directory or a remote directory on a saved herdr SSH machine.
2. **Plan** tasks inside a workspace. Tasks may depend on each other and form a DAG.
3. **Prepare** a task for implementation: create a dedicated `git worktree` in a separate
   directory, through the herdr CLI (`herdr worktree create`) for runner `herdr` and
   with `git worktree add` for runners `plain` and `tmux` (runner `none` creates none).
4. **Implement** the task in that worktree: in herdr agent panes, as `claude` or `codex`
   child processes, or in a detached tmux session, depending on the runner.
5. **Record** the commits produced (SHA, message, author, timestamp) against the task.
6. **Review** the task: push the worktree branch and open a pull request; the task moves
   to `in_review`.
7. **Complete** the task once its pull request is merged; only then do dependent tasks
   become ready.

Toodo doubles as the record for a year-end performance report: every task status change
is timestamped and kept as history (planned, started, in review, completed), and the
task DAG is shown on a time axis rather than as a free-form graph.

See [`docs/architecture.md`](docs/architecture.md) for the domain model and
[`docs/workflow.md`](docs/workflow.md) for the task lifecycle.

## Platform and Stack

- **Target**: `toodo-server` on Linux, used through the web app (PWA) it serves to
  browsers on any device; see `docs/server.md`. There is no native app.
- **Prerequisite**: herdr is optional; workspaces with runner `herdr` need it installed
  and running on the server, while runner `plain` runs `claude` or `codex` from the
  `PATH` of the server or the workspace's SSH host, runner `tmux` also needs `tmux`
  there, and runner `none` needs neither. Toodo
  controls herdr; it never installs, updates, or bundles herdr. Git, OpenSSH
  (`ssh`), and `gh` are also expected on the server's `PATH`.
- **Backend**: Rust with tokio and axum: commands over HTTP, events over server-sent
  events, MCP, and Web Push. TypeScript bindings for the commands are generated with
  specta and specta-typescript.
- **Frontend**: React, Vite, TypeScript, TanStack Query, Tailwind CSS, shadcn/ui, built as
  an installable web app with a service worker.
- **DAG editor**: React Flow (`@xyflow/react`) laid out on a timeline (see
  `docs/architecture.md`, Timeline View).
- **Storage**: SQLite via `rusqlite` in the server's data directory.
- **Tests**: `cargo test` for Rust, Vitest for the frontend, Playwright for the web app end
  to end, fake adapters for herdr, git, ssh, and gh.

## Repository Status

The React frontend lives in `src/`, the Rust server in `src-tauri/` (the directory keeps
its old name). Keep the **Commands** section below in sync with `package.json` scripts.

Layout:

- `src/`: React frontend. `@/` is an alias for `src/`.
  - `src/lib/bindings.ts`: TypeScript bindings generated from
    `src-tauri/src/bindings.rs`. Do not edit by hand; `cargo test` rewrites it.
  - `src/components/ui/`: shadcn/ui components (add more with `npx shadcn@latest add <name>`).
  - `src/web/`: browser modules the bindings and the app use to talk to `toodo-server`:
    commands (`core.ts`), events over SSE (`event.ts`), server access and devices,
    connection state, Web Push, and install prompts. PWA artwork is in `src/web/pwa/`.
- `src-tauri/`: Rust crate `toodo` (library `toodo_lib`, binary `toodo-server`).
  - `src-tauri/src/lib.rs`: module tree.
  - `src-tauri/src/bindings.rs`: the command and event list that generates
    `src/lib/bindings.ts`.
  - `src-tauri/src/server/`: commands over HTTP (`rpc.rs`), events over SSE, MCP, Web Push
    notifications (`push/`), and the web build on one port; see `docs/server.md`.
  - `src-tauri/src/commands/`: commands the frontend calls over HTTP; they take
    `commands::State`. `types.rs` holds the serializable shapes sent to the frontend and
    validates inputs at this boundary; the domain model itself stays free of serde and
    specta.
  - `src-tauri/src/domain/`: core domain model and rules (task DAG, status transitions,
    slugs, worktree paths and branch names). Pure logic: no I/O or storage.
  - `src-tauri/src/adapters/`: thin wrappers around external tools (`git.rs` runs git
    locally or over `ssh`, `herdr.rs` drives the herdr CLI, `github.rs` opens pull
    requests with `gh`, `ssh.rs` lists remote directories), each behind a trait with a fake for tests.
  - `src-tauri/src/runtime/plain/`: the plain runner, which runs `claude` or `codex` as child processes in a task worktree, locally or on an SSH host.
  - `src-tauri/src/runtime/host.rs`: builds run commands for the local host or an SSH host
    (POSIX `sh` or Windows PowerShell): staging, wrapper, stop, probe, and tmux commands.
  - `src-tauri/src/runtime/tmux/`: the tmux runner, which runs each agent in a detached
    tmux session locally or on a POSIX SSH host, and recovers sessions after a restart.
  - `src-tauri/src/mcp/`: MCP server for coding agents (rmcp over loopback HTTP with a
    bearer token); `tools.rs` holds the tool logic over `Storage`. Rules the `initialize`
    instructions and the `toodo-skill.md` skill both state live once in `shared/` and are
    filled in where a template says `{{name}}`; see `docs/agents.md`.
  - `src-tauri/src/oauth/`: OAuth authorization server for chat apps on `/mcp`, mounted
    only when `TOODO_PUBLIC_URL` is set (`routes.rs` endpoints, `clients.rs` client
    metadata documents).
  - `src-tauri/src/storage/`: SQLite persistence (`rusqlite`, bundled SQLite). Schema
    changes go in a new entry appended to `migrations.rs`; never edit a released one.
    `import.rs` backs `toodo-server import`.
  - `src-tauri/src/cli/`: the `toodo` CLI (binary `toodo`, `src/bin/toodo.rs`): `init`,
    `start`, `stop`, `status`, `service install`, and MCP registration with Claude Code
    and Codex.
- `npm/toodo/`: the `@dubusoft/toodo` npm package (launcher `bin/toodo.js`, README).
- `scripts/package-npm.mjs`: stages the npm packages (main and per-platform) for
  publishing; `scripts/smoke-npm.mjs` installs the staged packages from a local registry
  and checks that `toodo init` brings up a working server.

## Commands

Run from the repository root unless noted. Package manager is npm.

- Install: `npm install`
- Dev (web app): `npm run dev` (Vite dev server; forwards `/api` and `/mcp` to a running
  server at `TOODO_SERVER`, default `http://127.0.0.1:47616`)
- Build (web app): `npm run build` (typecheck, then build into `dist-web/`)
- Test (frontend): `npm test`
- Typecheck (frontend): `npm run typecheck`
- Test (web app end to end): `npm run test:e2e`, after building the server and `dist-web/`;
  see the "End-to-End Tests" section of `README.md`
- Server: `cargo build --bin toodo-server` in `src-tauri/`
- Test (Rust, also regenerates `src/lib/bindings.ts`): `cargo test --lib` in `src-tauri/`
- Lint / format (Rust): `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check`
  in `src-tauri/`
- Release: `npm run bump <major|minor|patch|X.Y.Z>` on `dev`, commit `Release X.Y.Z`,
  merge `dev` into `main`; see the "Releases" section of `README.md`.
  `npm run check-version` checks that the version files agree. A release carries
  `toodo-server` and the web app (packaged by `scripts/package-server.sh`)
- Package (npm): `node scripts/package-npm.mjs --version X.Y.Z --web dist-web --out dist-npm
  --binaries linux-x64=<dir with toodo and toodo-server>`; never run `npm publish` by hand,
  the `npm` workflow publishes
- Smoke test (npm): `node scripts/smoke-npm.mjs dist-npm` on the staged packages, part of
  the release checklist in `README.md`

After changing a command signature, run `cargo test` in `src-tauri/` and commit the
updated `src/lib/bindings.ts` together with the Rust change. A test in `server/rpc.rs`
checks that the server serves every command in the bindings.

CI only typechecks (`cargo check --all-targets` for Rust, `npm run typecheck` for the
frontend); it runs no tests, lints, or format checks. Run the tests, clippy, and
`cargo fmt --check` locally before opening a pull request.

## Conventions

- Keep changes small and focused; one concern per commit.
- Commit messages: imperative mood, English, e.g. `Add worktree creation via herdr API`.
- Do not commit secrets, SSH keys, or host-specific paths. SSH targets and credentials
  come from user configuration, never from source.
- External integrations (herdr, git, SSH, Git hosting/PR API) go behind a thin adapter
  module so they can be faked in tests.
- Treat the task DAG as an invariant: reject edges that would create a cycle.

## Integrations

- **herdr** (optional, preinstalled; needed for runner `herdr`): terminal workspace manager for AI coding agents.
  - On startup, check that `herdr` is on `PATH` and `herdr status --json` reports the
    server as running.
  - Commands go through the herdr CLI (`herdr worktree create|open|list|remove`,
    `herdr workspace focus`, `herdr agent prompt|wait`). CLI output is the JSON
    `{"id", "result"}` envelope of the socket API; parse it as JSON, never scrape text.
  - Events come from the socket API (`events.subscribe`) over herdr's Unix socket, and
    from saved SSH machines over `ssh -W <remote socket path>` (a Windows host's herdr
    listens on a named pipe `ssh -W` cannot reach, so its pane list is polled instead):
    `worktree.created`, `worktree.removed`, `pane.agent_status_changed`.
  - Remote workspaces map to saved herdr SSH machines (`herdr machine ...`), found by
    their SSH target. The user adds one with `herdr machine add <host>` in a terminal on
    the server; Toodo never installs herdr on a remote host itself.
  - Implementation happens in herdr itself; Toodo does not embed a terminal.
- **git**: run the `git` CLI (not libgit2) for branches and commit history.
- **ssh**: run OpenSSH `ssh` for git commands on remote workspaces, sharing the server
  user's `~/.ssh/config` and ssh-agent with herdr.
- **Git hosting**: GitHub only for now; pull requests are opened with the `gh` CLI.
