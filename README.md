# Toodo

Toodo is a self-hosted task tracker for planned work, used by people and coding agents:
`toodo-server` runs on a Linux machine and you use it from a browser as an installable web
app (PWA), and agents use it over MCP. It keeps the dependencies between tasks as a DAG and
keeps the memory of the work: notes, decisions, references, and a timeline of when and why
each task was planned, started, reviewed, and completed, so the year's work can be
compiled into a performance report.

Toodo's executor is Dori, which lives in this repository (`dori/`) and is the agent the
chat names by default: it creates worktrees, runs coding agents, opens pull requests, and
records the outcome in Toodo. The Toodo server itself runs none of that work, and a person
or another agent records their work over MCP the same way.

## Features

- **Workspaces**: group tasks by project; a workspace has a name, an optional description,
  and an optional repository reference such as `owner/repo`.
- **Planning**: create tasks per workspace; express ordering as dependencies (a DAG). A
  planned task is ready once every task it depends on is done; cycles are rejected.
- **Work memory**: progress, decision, and blocker notes on each task, a completion note,
  and references (`refs`) such as `lane:<key>`, `slack:<thread>`, `pr:<url>`, or a URL.
- **Reasons**: starting, pausing, and completing a task record why, next to the status
  change in its history.
- **Completion criteria**: `manual` items checked with evidence, and `url` items Toodo
  checks with an HTTP GET; completing a task releases the dependents waiting on it.
- **Agent access (MCP)**: coding agents read and plan tasks, record starts, notes, and
  decisions, and complete tasks through the server's MCP endpoint; copy the client config
  from AI app connections in Settings (the gear at the bottom of the sidebar). See
  [docs/agents.md](docs/agents.md).
- **Timeline**: every status change is timestamped; the dependency graph is drawn on a
  time axis showing when each task was planned, started, reviewed, and completed.
- **Review**: a report of what was planned, started, and completed in a period, built
  from that history; see [Review](#review).

![Tasks of two workspaces on the timeline, with their dependencies](docs/images/timeline.png)

## Getting Started

[docs/quickstart.md](docs/quickstart.md) goes from installing the server to a first
completed task, and [docs/troubleshooting.md](docs/troubleshooting.md) covers the errors
new setups run into most.

## Plan

**Plan** in the "All workspaces" view sums the estimates of tasks per quarter or year of
their due dates. Set a capacity per quarter and every period that holds more work than
it is highlighted as over capacity; tasks without an estimate or due date are listed so
you can fill them in. [docs/architecture.md](docs/architecture.md#plan-view) has the
rules.

## Review

**Review** in the sidebar reports the work recorded in a week, month, quarter, year, or a
custom range, across all workspaces or narrowed to one workspace or label. It is built only
from recorded facts: status changes and their reasons, decision notes, references, and the
completion notes you write. Commit and pull request figures recorded by earlier versions
still show in the periods they cover.

- A summary counts the tasks completed, awaiting completion, started, and planned; it
  gives the median lead, cycle, active, and review times and what was completed by type
  and by workspace.
- "Plan vs actual" compares estimates with active time and due dates with completion
  dates, when tasks have them; a year adds a "Year in review" section.
- Each task is listed once, under the most advanced milestone it reached in the period,
  with its references and completion note.
- Export copies the review as Markdown, saves it as Markdown or CSV, or prints it.

The review is the source for status updates and a year-end report.
[docs/architecture.md](docs/architecture.md#review) defines each number.

![The week review](docs/images/review.png)

## Keyboard Shortcuts

The web app lists these with `?`. Letter shortcuts do nothing while you type in a field.

| Keys | Action |
| --- | --- |
| `Ctrl+K` / `Cmd+K` | Open the command palette: jump to a task by title or `#number`, or run an action such as opening a workspace, the review, or settings |
| `j` / `k` | Select the next or previous task in the list or on the timeline |
| `Enter` | Open the details of the selected task |
| `Esc` | Close the details, the palette, or a dialog |
| `/` | Search tasks |
| `?` | Show the shortcuts |
| `Up` / `Down` / `Home` / `End` | On a timeline bar, move the selection between rows |

## Documentation

- [toodo.dev](https://toodo.dev): website landing page; see [site/README.md](site/README.md) for preview and deployment.
- [docs/quickstart.md](docs/quickstart.md): from install to a first completed task.
- [docs/troubleshooting.md](docs/troubleshooting.md): common errors and what to do.
- [AGENTS.md](AGENTS.md): contributor and AI-agent guidelines, including the language policy.
- [docs/architecture.md](docs/architecture.md): domain model and system components.
- [docs/workflow.md](docs/workflow.md): task lifecycle from planning to completion.
- [docs/agents.md](docs/agents.md): using Toodo from coding agents, as an orchestrator or a
  worker, and where their instructions come from.
- [docs/server.md](docs/server.md): installing and running `toodo-server`, the web app, and
  its API.
- [docs/migrate-desktop-data.md](docs/migrate-desktop-data.md): moving the data of the former
  Windows desktop app into a `toodo-server`.

## Requirements

- A machine for `toodo-server`: Linux x64 or arm64 (glibc or musl) or macOS x64 or arm64
  for the npm packages, with Node.js 18 or later; Linux x86_64 (glibc) for the release
  archive
- A current browser to use the web app
- Optional: Claude Code (`claude`) or Codex (`codex`) on `PATH` when `toodo init` runs, to
  register the MCP endpoint with them

The recommended install, on Linux x64 or arm64 (glibc or musl) or macOS with Node.js 18 or
later:

```sh
npm i -g @dubusoft/toodo
toodo init
toodo service install
```

`toodo update` installs the newest version later and restarts the server on it. See
[Install with npm](docs/server.md#install-with-npm), and [docs/server.md](docs/server.md)
for installing without Node.js or from a checkout. Continue with
[docs/quickstart.md](docs/quickstart.md) to sign in and plan a first task.

## End-to-End Tests

`e2e/` holds Playwright tests that drive the web app against a
scratch `toodo-server`. Every test starts its own server on a free loopback port with a
temporary data directory, so a run never touches the data of a real server and never binds
the default server ports.
CI does not run it; run it locally before merging changes to the web app.

To run it locally (Node and Bun):

```sh
npm ci
npx playwright install chromium                       # once
npx vite build
npm run test:e2e
```

The tests start the server from the checkout (`bun server/src/main.ts`); rebuild the web
app after frontend changes, since they serve the last build. Pass Playwright options after
`--`, for example `npm run test:e2e -- e2e/timeline.spec.ts --headed`. `TOODO_SERVER_BIN`
points the tests at a `toodo-server` binary instead and `TOODO_E2E_WEB_DIR` at another web
build. After a failure, `npx playwright show-report` opens the report.

## Tech Stack

TypeScript on Bun for `toodo-server`, React + TypeScript + React Flow for the web app,
SQLite. See [AGENTS.md](AGENTS.md#platform-and-stack) for details.

## Releases

Releases are paused. The versions published so far, on npm (`@dubusoft/toodo`) and as
GitHub release assets, carry the Rust `toodo-server` this repository no longer contains,
so the `npm` and `Release` workflows that built and published them are gone. When
distribution is prepared again, a Bun-compiled binary of `server/` replaces the Rust
binaries in both channels, and the workflows return around it. Until then:

- The published versions stay installable as described above and in
  [docs/server.md](docs/server.md) (`toodo update`, or `scripts/install-server.sh --release
  latest` without npm), and the packaging scripts they were built with
  (`scripts/package-npm.mjs`, `scripts/smoke-npm.mjs`, `scripts/package-server.sh`) stay
  for the Bun binary to reuse.
- The owner host runs the server from a checkout as `toodo.service` (see
  [docs/host.md](docs/host.md)). There `toodo` is the command for people (`toodo update`,
  `status`, `quota`, `doctor`, `logs`, `restart`, `review`), and `dori` is the internal
  command of the Dori lead, its lanes, and runners; `toodo` runs `dori`'s code for the
  commands both need.
- `npm run bump <major|minor|patch|X.Y.Z>` sets the same version in `package.json` and
  `package-lock.json`, and `npm run check-version` checks that they agree.

## Language Policy

All repository content (docs, code, comments, commits, PRs) is written in English.

## Contributing

Outside contributions are accepted under the [Contributor License Agreement](CLA.md).
See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to sign it in a pull request.

## Sponsoring

If Toodo is useful to you, you can support its development through
[GitHub Sponsors](https://github.com/sponsors/dev-bokdong).

## License

Copyright (C) 2026 dev-bokdong

Toodo is licensed under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). If you run a modified Toodo for users over a network, the AGPL requires
you to offer those users the source of your modified version.

Versions released before this license change, up to and including v1.3.1, were released
under the MIT License and remain available under it. Releases after v1.3.1 are
`AGPL-3.0-only`.

The license covers the whole repository, `dori/` included. Dori mode was developed in the
now archived [Dubusoft/dori-mode](https://github.com/Dubusoft/dori-mode) repository under
the MIT License, which still applies to the code published there; in this repository it is
`AGPL-3.0-only` like the rest of Toodo.
