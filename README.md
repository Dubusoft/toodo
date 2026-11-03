# Toodo

Toodo is a self-hosted app for planning and shipping code changes: `toodo-server` runs on
a Linux machine and you use it from a browser as an installable web app (PWA). It connects a task plan to
isolated git worktrees, AI-agent implementation sessions in
[herdr](https://herdr.dev), commit tracking, and pull requests. It keeps a timeline of
when each task was planned, started, and completed, so the year's work can be compiled
into a performance report.

## Features

- **Workspaces**: use a local directory or a remote directory on a saved herdr SSH
  machine as a workspace.
- **Planning**: create tasks per workspace; express ordering as dependencies (a DAG).
- **Worktree preparation**: before a task is implemented, create a dedicated
  `git worktree` in a separate directory via the herdr API.
- **Implementation in herdr**: the work itself happens in herdr panes and agents
  attached to the task's worktree.
- **Commit tracking**: record the commits (SHA, message, author, time) made for a task.
- **Completion and PR**: a task's branch is pushed and a pull request opened for it;
  once that pull request is merged on GitHub, Toodo completes the task automatically.
- **Agent planning (MCP)**: coding agents can list tasks, create tasks, and connect
  dependencies through the server's MCP endpoint; copy the client config from Agent
  access in Settings (the gear at the bottom of the sidebar). Agents on SSH machines use
  the same config, through a reverse SSH tunnel the server keeps open to each machine with
  a workspace.
- **Timeline**: every status change is timestamped; the dependency graph is drawn on a
  time axis showing when each task was planned, started, reviewed, and completed.

## Documentation

- [AGENTS.md](AGENTS.md): contributor and AI-agent guidelines, including the language policy.
- [docs/architecture.md](docs/architecture.md): domain model and system components.
- [docs/workflow.md](docs/workflow.md): task lifecycle from planning to pull request.
- [docs/server.md](docs/server.md): installing and running `toodo-server`, the web app, and
  its API.
- [docs/migrate-desktop-data.md](docs/migrate-desktop-data.md): moving the data of the former
  Windows desktop app into a `toodo-server`.

## Requirements

- A Linux machine (x86_64 for release builds) for `toodo-server`
- [herdr](https://herdr.dev), installed and running there (Toodo controls it; it is not bundled)
- Git, OpenSSH, and the GitHub CLI (`gh`) on the server's `PATH`
- A current browser to use the web app

See [docs/server.md](docs/server.md) to install it. On Linux x64 or arm64 (glibc) with
Node.js, the quickest start is:

```sh
npx @dubusoft/toodo init
```

See [Install with npm](docs/server.md#install-with-npm).

## End-to-End Tests

`e2e/` holds Playwright tests that drive the web app against a
scratch `toodo-server`. Every test starts its own server on a free loopback port with a
temporary data directory, so a run never touches the data of a real server and never binds
the default server ports. A run fails when it leaves a new workspace open in the herdr of
the machine (`e2e/herdr-guard.ts`).
CI does not run it; run it locally before merging changes to the web app.

To run it locally (Node, Rust, and a Linux machine):

```sh
npm ci
npx playwright install chromium                       # once
(cd src-tauri && cargo build --bin toodo-server)
npx vite build
npm run test:e2e
```

Rebuild the server after Rust changes and the web app after frontend changes; the tests use
the last builds. Pass Playwright options after `--`, for example
`npm run test:e2e -- e2e/timeline.spec.ts --headed`. `TOODO_SERVER_BIN` points the tests at
another `toodo-server` binary and `TOODO_E2E_WEB_DIR` at another web build. After a failure,
`npx playwright show-report` opens the report.

## Tech Stack

Rust (tokio, axum) for `toodo-server`, React + TypeScript + React Flow for the web app,
SQLite. See [AGENTS.md](AGENTS.md#platform-and-stack) for details.

## Releases

A release ships `toodo-server` together with the web app; servers update with
`scripts/install-server.sh --release latest` (see [docs/server.md](docs/server.md)).

To publish a release:

1. On `dev`, run `npm run bump <major|minor|patch|X.Y.Z>`. It sets the same version in
   `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/Cargo.lock`. Commit it as `Release X.Y.Z`. `npm run check-version` checks
   that the four files agree; the workflow runs it first.
2. Open a pull request from `dev` to `main` and merge it.
3. On every push to `main`, the `Release` workflow (`.github/workflows/release.yml`)
   releases the version in `package.json` unless it is already published: on Ubuntu it
   builds the web app (`npm run build`) and the x86_64 Linux `toodo-server`, packages
   them with `scripts/package-server.sh`, uploads
   `toodo-server-vX.Y.Z-linux-x86_64.tar.gz` and then its `.sha256`, and creates the
   release "Toodo vX.Y.Z" if it is missing. A push to `main` without a version bump does
   nothing.

Releases run from `main` rather than from tags so the Rust build cache of one release is
reused by the next. If a release fails, run the `Release` workflow by hand on `main`; it
completes a release whose server assets were not uploaded yet.

The `Release` workflow also publishes the release to npm under the dist-tag `latest`, and
every push to `dev` publishes an `X.Y.Z-dev.N` prerelease under `dev`; see
[npm Packages](docs/server.md#npm-packages).

## Status

Early bootstrap. Setup instructions will be added with the project scaffold.

## Language Policy

All repository content (docs, code, comments, commits, PRs) is written in English.

## Contributing

Outside contributions are accepted under the [Contributor License Agreement](CLA.md).
See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to sign it in a pull request.

## License

Copyright (C) 2026 dev-bokdong

Toodo is licensed under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). If you run a modified Toodo for users over a network, the AGPL requires
you to offer those users the source of your modified version.

Versions released before this license change, up to and including v1.3.1, were released
under the MIT License and remain available under it. Releases after v1.3.1 are
`AGPL-3.0-only`.
