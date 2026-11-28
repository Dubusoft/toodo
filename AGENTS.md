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
  except for user-facing localization resources: the web app's Korean catalog in
  `src/locales/ko/`.
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
- **Backend**: TypeScript on Bun (`server/`): commands over HTTP, events over server-sent
  events, MCP, and Web Push. The web app and the server share the API's types
  (`src/lib/api.ts`).
- **Frontend**: React, Vite, TypeScript, TanStack Query, Tailwind CSS, Astryx
  (`@astryxdesign/core`), built as an installable web app with a service worker.
- **DAG editor**: React Flow (`@xyflow/react`) laid out on a timeline (see
  `docs/architecture.md`, Timeline View).
- **Storage**: SQLite via `bun:sqlite` in the server's data directory.
- **Tests**: Vitest for the frontend, `bun test` for the server and the host, Playwright
  for the web app end to end.

## Repository Status

The React frontend lives in `src/`, the server in `server/`. Keep the **Commands** section
below in sync with `package.json` scripts.

Layout:

- `src/`: React frontend. `@/` is an alias for `src/`.
  - `src/lib/api.ts`: the API the web app and the server share, edited by hand: every
    type that crosses `/api/rpc` and the event stream, the commands (`makeCommands`,
    typed `Commands`) with the arguments they send, and the events (`makeEvents`, typed
    `Events`). It imports nothing, so the server imports it directly.
  - `src/lib/bindings.ts`: the web app's client of that API (`commands`, `events`, and
    every type), over `src/web/core.ts` and `src/web/event.ts`.
  - `src/components/button.tsx`: the app's `Button` and `IconButton`, the Astryx ones plus
    `changesData` (disabled while the server is unreachable; on for submit buttons) and
    `autoFocus`. Use them instead of importing the Astryx buttons directly.
  - `src/lib/i18n.tsx` and `src/locales/`: the web app's UI language and time zone. The
    Time zone setting in Settings > General (Dori's `displayTimeZone`) sets the zone the
    shared formatters of `src/lib/timeline.ts` show dates in. Settings > General has two
    language settings. App language (`get_app_language` / `set_app_language`, the server's
    `app_language` setting in `server/src/storage/app-language.ts`, shared by every device)
    picks the language of the screens: `ko` shows `src/locales/ko/`, `en` shows
    `src/locales/en/`. While it is unset the screens follow Dori's language, so a setup from
    before the split keeps its language. Dori's language (Dori's `ownerLanguage`,
    `src/lib/dori-config.ts`) is the language Dori and its lanes write to the owner in; its
    first change sets the unset App language to the language shown, so it never changes the
    screens. Followed, Korean shows Korean and any other language or none shows English. A
    key the Korean catalog lacks shows its English text. Each catalog has one module per area
    (`common`, `app`, `tasks`, `details`, `chat`, `settings`, `review`, `alerts`); `en` defines the
    keys and their types (a message with values is a function of them), `ko` is a
    `Partial` of each area. Components read them with `useMessages()` (or `useI18n()` for
    the locale of dates), and a sentence with elements in it is a catalog string with
    `{name}` placeholders rendered by `fill`; text built outside React, such as browser
    notifications, reads `currentMessages()`. Write UI strings there, never inline, and add
    the Korean text with each new key.
  - `src/lib/astryx-theme.ts`: the Astryx theme (defaults with the brand accent);
    `src/index.css` points the app's Tailwind color names at its tokens.
  - `src/web/`: browser modules the bindings and the app use to talk to `toodo-server`:
    commands (`core.ts`), events over SSE (`event.ts`), server access and devices,
    connection state, Web Push, and install prompts. PWA artwork is in `src/web/pwa/`.
- `server/`: the Toodo server on Bun (`toodo-server`). It was ported from a Rust server,
  now removed, and keeps its database, messages, and answers byte for byte.
  - `server/src/storage/database.ts`: `bun:sqlite` connections: one writer and a
    separate read-only reader, each with WAL, a 5 second busy timeout, and foreign keys
    on. A new database gets the baseline schema of `schema.sql`; the writer migrates a
    database from `BASELINE_SCHEMA_VERSION` up to `SCHEMA_VERSION` with `MIGRATIONS`, and
    the reader opens only `SCHEMA_VERSION` (see **Schema Changes** below).
  - `server/src/storage/storage.ts`: `Storage`, the storage operations on one connection
    (workspaces, guidelines, tasks and their dependencies, status history, waits, notes,
    criteria, search, related links, and commit records), each module beside its tests.
    Failures are a `StorageError` (`errors.ts`).
  - `server/src/storage/` chat, device, push, OAuth, review, backup, and import modules:
    functions over a connection that take the time they act at. Staging a backup migrates
    it to `SCHEMA_VERSION` first.
  - `server/src/storage/schema.sql`: the baseline schema (version 56), never edited;
    `server/src/storage/testing.ts` creates the storage tests' databases from it.
  - `server/src/commands/`: the commands over `Storage`: workspaces, guidelines, tasks,
    issues, chat, backups, the update check, completion, and reviews (`review.ts`, saved
    reviews in `snapshots.ts`, and the Markdown and CSV reports in `report/`, which reads
    days and time zones through Temporal in `report/calendar.ts`). Each is typed
    `Command<"<name>">` from `Commands` in `src/lib/api.ts` (`AsyncCommand` when it waits
    on the network, or with `Args` and `Reply` when it takes more state than `Storage`),
    so it takes the arguments the web app sends and returns the shape it expects, and
    `npm run typecheck` fails when the two drift apart.
    Failures are a `CommandError` with a code, kind, and message (`errors.ts`);
    `types.ts` converts between those shapes and the domain model and validates inputs,
    and `chat-types.ts` does so for the chat. `events.ts` names the events the server
    sends, with their payloads from `Events`.
  - `server/src/push/`: Web Push delivery: `aes128gcm` encryption and the VAPID key
    (`crypto.ts`, the data directory's `push-key` file), what deserves a notification
    (`alerts.ts`), and sending with retries, the per-device deadline, the change worker,
    and the test notification (`push.ts`). Its HTTP routes are in
    `server/src/http/push.ts`.
  - `server/src/http/`: the HTTP surface on one `Bun.serve` port (`server.ts`): every
    command of the API over `/api/rpc` (`rpc.ts`, whose table is checked against
    `src/lib/api.ts` by `rpc.test.ts`), events over SSE with
    replay and resync (`event-log.ts`), the `/api` gate of the shared web token, device
    tokens, read-only devices, the lockout of wrong tokens, and Cloudflare Access JWTs
    (`auth.ts`, `devices.ts`, `access.ts`), backup export, download, and restore
    (`files.ts`), chat attachments (`attachments.ts`), Web Push routes (`push.ts`), the
    Dori status panel's latest snapshot and its stream (`supervisor-status.ts`), the
    scheduled jobs panel's requests, which the host hands to the supervisor
    (`supervisor-schedules.ts`), Settings > Machines & accounts' requests and job stream, which
    the host hands to and relays from the supervisor (`machines.ts`), and the
    web build. `services.ts` holds what the routes share and announces changes;
    `config.ts` reads the `TOODO_*` environment. `/mcp` and `/mcp/attachments` are served
    from `server/src/mcp/`, and `/oauth` and `/.well-known` from `server/src/oauth/` in
    public mode.
  - `server/src/mcp/`: the MCP server on `/mcp` (`McpEndpoint` in
    `mcp.ts`): loopback peers that bear the MCP token reach it, with the `401` answers and the
    lockout of `server/src/http/auth.ts`, and the agent's chat attachments are served on
    `/mcp/attachments`. In public mode (`TOODO_PUBLIC_URL`) chat apps also reach it from
    anywhere with an OAuth access token; they get the chat instructions and only the tools
    their grant's scopes allow (`oauthRefusal` in `protocol.ts`), and no chat attachments.
    `protocol.ts` answers as the Rust server's `rmcp` stateless JSON transport does, for
    clients that `initialize` and for the 2026-07-28 protocol with per-request `_meta`,
    `server/discover`, and `subscriptions/listen`. `tools.json` is `tools/list`, the tools'
    descriptions and input schemas, served as is; `tools/` holds the tool logic, with the
    arguments read as the Rust server's `serde` derives read them (`args.ts`,
    `tools/requests.ts`), and `resources.ts` the task resources and their subscriptions.
    The instructions and the skill (`toodo-skill.md`) are rendered by `instructions.ts`;
    rules both state live once in `shared/` and are filled in where a template says
    `{{name}}`; see `docs/agents.md`.
  - `server/src/oauth/`: the OAuth authorization server for chat
    apps, mounted only in public mode: discovery metadata, dynamic registration, the
    consent page, and the token and revocation endpoints with PKCE and refresh rotation
    (`routes.ts`), client registration metadata and client ID metadata documents
    (`clients.ts`, fetched from public addresses only through `server/src/net.ts`), the
    OAuth error answers (`errors.ts`), and the owner and scopes of grants (`scopes.ts`).
    Grants and tokens are stored by `server/src/storage/oauth.ts`.
  - `server/src/main.ts`: `toodo-server` (`bun server/src/main.ts`, with `import FILE`),
    which creates the data directory's database when it is missing.
  - `server/src/net.ts`: the public-address checks for outbound requests to URLs from
    outside the server, and the GET URL criteria are checked with.
  - `server/src/domain/`: the domain model and rules (task DAG, status transitions,
    completion criteria, plans, refs, timeline, review, slugs), pure logic with its tests
    beside each module. `rust.ts` holds the Rust standard
    library behavior they depend on (whitespace, `{:?}` quoting, float printing, string
    order), so messages and results match the Rust server byte for byte.
- `host/`: the one-process host (Bun) that replaces the `toodo-server` and
  `dori-supervisor` services on the owner's host as `toodo.service` (`host/toodo.service`;
  see `docs/host.md`). `host/src/main.ts` serves the core of `server/src/main.ts`
  (`openCore`, on the same `TOODO_*` environment) on the main thread at `TOODO_LISTEN`
  (default `127.0.0.1:47616`) and runs the supervisor in a Worker
  (`dori/skills/dori-mode/scripts/src/supervise-worker.ts`), which reads `~/.dori/env`
  itself so the unit holds no secret; `host/src/supervisor.ts` keeps that Worker alive with
  a 30 second heartbeat watchdog, a restart backoff, and a breaker that stops restarting a
  Worker that keeps failing. `TOODO_SUPERVISOR=off` is safe mode (the core alone); `SIGHUP`
  reloads only the Worker, with the code on disk. `GET /api/host` answers with the
  supervisor's state. `host/src/healthcheck.ts` pings the healthchecks.io URLs of
  `~/.config/host-healthcheck.env` every minute. The host's own code on the main thread
  makes no `*Sync` calls (`host/src/sync-check.test.ts` walks its imports, stopping at the
  core). `host/src/protocol.ts` holds the messages both threads exchange. `host/src/cli.ts`
  is the `toodo` command, the owner's one command on the host (`update`, `status`, `quota`,
  `doctor`, `logs`, `restart`, `review`, `service install`), linked from `package.json`;
  `update`, `status`, `quota`, and `doctor` run dori's CLI in the same checkout rather than
  copying it. `dori` stays the internal CLI of the lead, lanes, and runners.
- `dori/`: Dori, the executor that runs coding agents in lanes and reports to Toodo, moved
  here from `Dubusoft/dori-mode` with its history (`git subtree`). The skill is
  `dori/skills/dori-mode/` and the `dori` CLI (Bun) is `dori/skills/dori-mode/scripts/`;
  `dori/install.sh` installs both from a clone of this repository.
- `npm/toodo/`: the `@dubusoft/toodo` npm package (launcher `bin/toodo.js`, README).
- `scripts/package-npm.mjs`: stages the npm packages (main and per-platform) for
  publishing; `scripts/smoke-npm.mjs` installs the staged packages from a local registry
  and checks that `toodo init` brings up a working server. Like
  `scripts/package-server.sh` and `scripts/install-server.sh`, they package and install
  the published releases, which carry the Rust server; releases are paused until a
  Bun-compiled binary replaces it (see the "Releases" section of `README.md`).

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
- Test (web app end to end): `npm run test:e2e`, after building `dist-web/`; see the
  "End-to-End Tests" section of `README.md`
- Server: `bun server/src/main.ts` (creates the database of `TOODO_DATA_DIR` when it is
  missing)
- Audit (dependencies): `npm audit`

After changing a command signature, change `src/lib/api.ts` with the server; `npm run
typecheck` fails while the two disagree, and `server/src/http/rpc.test.ts` checks that the
server serves every command of the API with the arguments it sends.

CI only typechecks (`npm run typecheck` for the frontend, `server/`, and `host/`,
`bun run typecheck` for `dori/`); it runs no tests, lints, or format checks. Run the tests
locally before opening a pull request.

## Schema Changes

The schema starts at version 56 (`BASELINE_SCHEMA_VERSION`), the last one the Rust server
migrated to, which `server/src/storage/schema.sql` creates. Change it with a migration:

- Append the SQL to `MIGRATIONS` in `server/src/storage/database.ts`; the first one is
  version 57. The writer applies each pending migration in its own transaction when it
  opens a database, and refuses to commit one that leaves a row referring to a missing one.
- Never edit `schema.sql` or a migration that has shipped: databases already carry it.
- A database below version 56 is refused; the last Rust release migrates it there
  (`docs/host.md`).

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
