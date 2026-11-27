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
- Exception for `dori/`: text Dori writes for its owner stays in that owner's language and
  counts as a localization resource. This covers the Korean report and message templates
  and the strings Dori sends to the owner, plus the translated READMEs
  (`dori/README.ko.md`, `dori/README.ja.md`, `dori/README.zh-CN.md`). Everything else in
  `dori/` (comments, identifiers, test names, log and error messages) follows the rules
  above; Korean that predates the move into this repository is being translated.
- Only conversational responses to the user are written in Korean. When quoting code,
  paths, commands, or identifiers in a Korean reply, keep them verbatim in English.
- If the user writes a requirement in Korean, translate it into English before recording
  it in docs, comments, task descriptions, or commit messages.

## Project Summary

Toodo is a task tracker for planned work, used by people and coding agents. It keeps two
things:

1. **Task dependencies (DAG)**: tasks grouped in **workspaces**, `depends_on` edges,
   related links, and readiness: a planned task is ready once every task it depends on
   is done. The timeline and plan views show them.
2. **Work memory**: each task's description, progress, decision, and blocker notes, its
   completion note, its references (`refs` such as `lane:<key>` or `pr:<url>`), and its
   status history with the reason recorded for each start, pause, and completion.

Dori (`dori/`) is Toodo's executor and the agent the chat names by default: it creates
worktrees, runs coding agents, and opens pull requests, then records the result through
MCP: `start_task`, notes, `update_task` with status `in_review`, then `complete_task` or
`conclude_task`. A person or another agent records work the same way, through MCP or the
web app. The Toodo server itself runs no git, gh, ssh, herdr, tmux, or agent CLI.

Toodo doubles as the record for a year-end performance report: every task status change
is timestamped and kept as history (planned, started, in review, completed), and the
task DAG is shown on a time axis rather than as a free-form graph.

See [`docs/architecture.md`](docs/architecture.md) for the domain model and
[`docs/workflow.md`](docs/workflow.md) for the task lifecycle.

## Platform and Stack

- **Target**: `toodo-server` on Linux, used through the web app (PWA) it serves to
  browsers on any device; see `docs/server.md`. There is no native app.
- **Prerequisite**: none beyond the server itself; it calls no other program.
- **Backend**: Rust with tokio and axum: commands over HTTP, events over server-sent
  events, MCP, and Web Push. TypeScript bindings for the commands are generated with
  specta and specta-typescript.
- **Frontend**: React, Vite, TypeScript, TanStack Query, Tailwind CSS, Astryx
  (`@astryxdesign/core`), built as an installable web app with a service worker.
- **DAG editor**: React Flow (`@xyflow/react`) laid out on a timeline (see
  `docs/architecture.md`, Timeline View).
- **Storage**: SQLite via `rusqlite` in the server's data directory.
- **Tests**: `cargo test` for Rust, Vitest for the frontend, `bun test` for the TypeScript
  server, Playwright for the web app end to end.

## Repository Status

The React frontend lives in `src/`, the Rust server in `src-tauri/` (the directory keeps
its old name). Keep the **Commands** section below in sync with `package.json` scripts.

Layout:

- `src/`: React frontend. `@/` is an alias for `src/`.
  - `src/lib/bindings.ts`: TypeScript bindings generated from
    `src-tauri/src/bindings.rs`. Do not edit by hand; `cargo test` rewrites it.
  - `src/components/button.tsx`: the app's `Button` and `IconButton`, the Astryx ones plus
    `changesData` (disabled while the server is unreachable; on for submit buttons) and
    `autoFocus`. Use them instead of importing the Astryx buttons directly.
  - `src/lib/astryx-theme.ts`: the Astryx theme (defaults with the brand accent);
    `src/index.css` points the app's Tailwind color names at its tokens.
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
    completion criteria, plans, refs, timeline, review, slugs). Pure logic: no I/O or
    storage.
  - `src-tauri/src/mcp/`: MCP server for coding agents (rmcp over loopback HTTP with a
    bearer token); `tools/` holds the tool logic over `Storage`. Rules the `initialize`
    instructions and the `toodo-skill.md` skill both state live once in `shared/` and are
    filled in where a template says `{{name}}`; see `docs/agents.md`.
  - `src-tauri/src/oauth/`: OAuth authorization server for chat apps on `/mcp`, mounted
    only when `TOODO_PUBLIC_URL` is set (`routes.rs` endpoints, `clients.rs` client
    metadata documents).
  - `src-tauri/src/storage/`: SQLite persistence (`rusqlite`, bundled SQLite). The schema
    is frozen (see **Schema Freeze** below); never edit a released migration.
    `import.rs` backs `toodo-server import`.
  - `src-tauri/src/cli/`: the `toodo` CLI (binary `toodo`, `src/bin/toodo.rs`): `init`,
    `start`, `stop`, `restart`, `status`, `doctor`, `logs`, `service install`, `update`,
    `uninstall`, `review`, and MCP registration with Claude Code and Codex.
- `server/`: the TypeScript (Bun) server that is replacing the Rust one, on the same
  database file and schema.
  - `server/src/storage/database.ts`: `bun:sqlite` connections: one writer and a
    separate read-only reader, each with WAL, a 5 second busy timeout, and foreign keys
    on. Both open only a database at `BASELINE_SCHEMA_VERSION` and reject any other
    version; neither creates nor migrates a database.
  - `server/src/storage/storage.ts`: `Storage`, the storage operations of
    `src-tauri/src/storage/` on one connection (workspaces, guidelines, tasks and their
    dependencies, status history, waits, notes, criteria, search, related links, and commit
    records), each module beside its ported Rust tests. Failures are a `StorageError` whose
    message is the Rust one word for word (`errors.ts`).
  - `server/src/storage/` chat, device, push, OAuth, review, backup, and import modules:
    the rest of `src-tauri/src/storage/`, as functions over a connection that take the
    time they act at where Rust reads its clock. Staging a backup accepts only
    `BASELINE_SCHEMA_VERSION`, since nothing here migrates.
  - `server/src/storage/schema.sql`: the frozen schema the Rust migrations create, which
    `cargo test --lib` regenerates; `server/src/storage/testing.ts` creates the storage
    tests' databases with it.
  - `server/src/commands/`: the commands of `src-tauri/src/commands/` over `Storage`, so
    far workspaces, guidelines, tasks, issues, chat, backups, the update check, completion,
    and reviews (`review.ts`, saved reviews in `snapshots.ts`, and the Markdown and CSV
    reports in `report/`, which reads days and time zones through Temporal in
    `report/calendar.ts`). Each is typed `Command<"<name>">` from `src/lib/bindings.ts`
    (`AsyncCommand` when it waits on the network, or with `Args` and `Reply` when it
    takes more state than `Storage`), so it takes the arguments the web app sends and
    returns the shape it expects, and `npm run typecheck` fails when the two drift apart;
    `server/src/web-bindings.d.ts` stands in for the two web modules that file imports.
    Failures are a `CommandError` with the Rust code, kind, and message (`errors.ts`);
    `types.ts` converts between those shapes and the domain model and validates inputs,
    and `chat-types.ts` does so for the chat. `events.ts` names the events the server
    sends, with their payloads from the bindings.
  - `server/src/push/`: Web Push delivery of `src-tauri/src/server/push/`: `aes128gcm`
    encryption and the VAPID key (`crypto.ts`, reading the Rust server's `push-key` file
    as is), what deserves a notification (`alerts.ts`), and sending with retries, the
    per-device deadline, the change worker, and the test notification (`push.ts`). Its
    HTTP routes are in `server/src/http/push.ts`.
  - `server/src/http/`: the HTTP surface of `src-tauri/src/server/` on one `Bun.serve`
    port (`server.ts`): every command of the bindings over `/api/rpc` (`rpc.ts`, whose
    table is checked against `src/lib/bindings.ts` by `rpc.test.ts`), events over SSE with
    replay and resync (`event-log.ts`), the `/api` gate of the shared web token, device
    tokens, read-only devices, the lockout of wrong tokens, and Cloudflare Access JWTs
    (`auth.ts`, `devices.ts`, `access.ts`), backup export, download, and restore
    (`files.ts`), chat attachments (`attachments.ts`), Web Push routes (`push.ts`), and the
    web build. `services.ts` holds what the routes share and announces changes;
    `config.ts` reads the `TOODO_*` environment. MCP (`/mcp`) and OAuth are not here yet.
  - `server/src/main.ts`: the TypeScript `toodo-server` (`bun server/src/main.ts`, same
    environment and `import FILE` as the Rust one). It opens only a database the Rust
    server created, since it neither creates nor migrates one.
  - `server/src/net.ts`: the public-address checks of `src-tauri/src/net.rs` for outbound
    requests to URLs from outside the server, and the GET URL criteria are checked with.
  - `server/src/domain/`: the domain model and rules of `src-tauri/src/domain/`, module for
    module, with the Rust tests ported beside each one. `rust.ts` holds the Rust standard
    library behavior they depend on (whitespace, `{:?}` quoting, float printing, string
    order), so messages and results match the Rust server byte for byte.
- `host/`: the one-process host (Bun) that will replace the `toodo-server` and
  `dori-supervisor` services. `host/src/main.ts` serves the core's HTTP on the main thread at
  `TOODO_LISTEN` (default `127.0.0.1:47616`) and runs the supervisor in a Worker
  (`dori/skills/dori-mode/scripts/src/supervise-worker.ts`); `host/src/supervisor.ts` keeps
  that Worker alive with a 30 second heartbeat watchdog, a restart backoff, and a breaker
  that stops restarting a Worker that keeps failing. `TOODO_SUPERVISOR=off` is safe mode (the
  core alone); `SIGHUP` reloads only the Worker, with the code on disk. `GET /api/host`
  answers with the supervisor's state; the core's own routes come with the HTTP surface.
  The main thread makes no `*Sync` calls (`host/src/sync-check.test.ts` walks its imports).
  `host/src/protocol.ts` holds the messages both threads exchange.
- `dori/`: Dori, the executor that runs coding agents in lanes and reports to Toodo, moved
  here from `Dubusoft/dori-mode` with its history (`git subtree`). The skill is
  `dori/skills/dori-mode/` and the `dori` CLI (Bun) is `dori/skills/dori-mode/scripts/`;
  `dori/install.sh` installs both from a clone of this repository.
- `npm/toodo/`: the `@dubusoft/toodo` npm package (launcher `bin/toodo.js`, README).
- `scripts/parity/`: the parity harness, which compares two servers (the Rust server and
  its TypeScript port) by their replies, events, and databases; see `docs/parity.md`.
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
- Typecheck (frontend, `server/`, and `host/`): `npm run typecheck`
- Test (TypeScript server): `npm run test:server`
- Test (host): `npm run test:host`
- Host: `bun host/src/main.ts` (`TOODO_LISTEN`, `TOODO_SUPERVISOR=off` for safe mode)
- Typecheck and test (`dori`): `bun install`, then `bun run typecheck` and `bun test` in
  `dori/skills/dori-mode/scripts/`
- Astryx docs (the project's pinned version): `npm run astryx -- search '<what>'`,
  `npm run astryx -- component <Name>`, `npm run astryx -- docs <topic>`
- Test (web app end to end): `npm run test:e2e`, after building the server and `dist-web/`;
  see the "End-to-End Tests" section of `README.md`
- Server: `cargo build --bin toodo-server` in `src-tauri/`
- Server (TypeScript): `bun server/src/main.ts`, on a data directory whose database the
  Rust server created
- Test (Rust, also regenerates `src/lib/bindings.ts`): `cargo test --lib` in `src-tauri/`
- Lint / format (Rust): `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check`
  in `src-tauri/`
- Audit (dependencies): `cargo audit` in `src-tauri/` (install with
  `cargo install cargo-audit --locked`) and `npm audit`, part of the release checklist in
  `README.md`. The Rust version is pinned in `rust-toolchain.toml`.
- Release: `npm run bump <major|minor|patch|X.Y.Z>` on `dev`, commit `Release X.Y.Z`,
  merge `dev` into `main`; see the "Releases" section of `README.md`.
  `npm run check-version` checks that the version files agree. A release carries
  `toodo-server` and the web app (packaged by `scripts/package-server.sh`)
- Package (npm): `node scripts/package-npm.mjs --version X.Y.Z --web dist-web --out dist-npm
  --binaries linux-x64=<dir with toodo and toodo-server>`; never run `npm publish` by hand,
  the `npm` workflow publishes
- Smoke test (npm): `node scripts/smoke-npm.mjs dist-npm` on the staged packages, part of
  the release checklist in `README.md`
- Parity (two servers): `node scripts/parity/parity.ts replay --a <server> --b <server>`,
  after `cargo build --bin toodo-server`; also `shadow`, `rust-check`, and `inventory`, see
  `docs/parity.md`

After changing a command signature, run `cargo test` in `src-tauri/` and commit the
updated `src/lib/bindings.ts` together with the Rust change. A test in `server/rpc.rs`
checks that the server serves every command in the bindings, and
`server/src/http/rpc.test.ts` does the same for the TypeScript server.

CI only typechecks (`cargo check --all-targets` for Rust, `npm run typecheck` for the
frontend, `server/`, and `host/`, `bun run typecheck` for `dori/`); it runs no tests, lints, or
format checks. Run the tests,
clippy, and `cargo fmt --check` locally before opening a pull request.

## Schema Freeze

The Rust schema is frozen at version 56, its `LATEST_VERSION` when the TypeScript
storage work started; `BASELINE_SCHEMA_VERSION` in `server/src/storage/database.ts` is
the same number, and a test in `migrations/tests.rs` fails when the two differ. Until
the Rust server is removed:

- Add no migration to `src-tauri/src/storage/migrations/`.
- A bug fix that needs a schema change lands together with the matching change in
  `server/` and the parity scenarios that cover it, and moves both versions together.
- The first new migration after the freeze is version 57, written once the Rust server
  is gone.

## Conventions

- Keep changes small and focused; one concern per commit.
- Before UI work, read the Astryx docs through the project-pinned CLI
  (`npm run astryx -- search '<what>'`, `npm run astryx -- component <Name>`,
  `npm run astryx -- docs <topic>`) rather than the package files or a global install.
- Commit messages: imperative mood, English, e.g. `Add decision notes to the review report`.
- Do not commit secrets, SSH keys, or host-specific paths.
- Treat the task DAG as an invariant: reject edges that would create a cycle.
- Keep execution out of Toodo: the server stores what an executor reports (status,
  notes, refs) and does not call git, gh, ssh, herdr, tmux, or agent CLIs. The only
  outside call is the HTTP GET of a `url` completion criterion.
