# Owner Host: One Service

On the owner's host, Toodo and Dori run as one systemd user service, `toodo.service`, from
one checkout of this repository: `~/.dori/src` on the `dev` branch, the checkout `dori`
itself runs from. It replaces two services that ran from two places:

| Before | Now |
| --- | --- |
| `toodo-server.service`: the Rust server from `scripts/install-server.sh` (`~/.local/bin/toodo-server`, web app in `~/.local/share/toodo-server-web`) | the core on the main thread of `toodo.service` (`server/`) |
| `dori-supervisor.service`: `dori supervise` from `~/.dori/src`, with `~/.dori/env` as its `EnvironmentFile` | the supervisor in a Worker of `toodo.service` (`dori/`) |
| `host-healthcheck.timer`: a script that pinged healthchecks.io every minute | pings sent by `toodo.service` itself |
| the `toodo` CLI of the Rust release (npm or GitHub release) | `toodo` from the checkout (`host/src/cli.ts`) |

The core is the TypeScript server: the same `TOODO_*` environment, data directory, and
database file as `toodo-server` (see [server.md](server.md)). It opens only a database at
the schema version the Rust server last migrated it to, and neither creates nor migrates
one.

## What Runs

`toodo.service` runs `bun host/src/main.ts` in the checkout:

- The main thread serves the core on `TOODO_LISTEN` (default `127.0.0.1:47616`): the web
  app from the checkout's `dist-web`, `/api`, and events. `GET /api/host` answers with the
  supervisor's state.
- A Worker runs the Dori supervisor. The host restarts it when it fails or stops sending
  its heartbeat, with a backoff and a breaker; the core keeps serving meanwhile.
- `systemctl --user reload toodo.service` (`SIGHUP`) replaces only the Worker with the code
  on disk. `TOODO_SUPERVISOR=off` in the unit runs the core alone (safe mode).
- Every minute the host pings healthchecks.io (see [Health Checks](#health-checks)).

The journal (`journalctl --user -u toodo.service`) shows `HOST_LISTENING`, the core's
`toodo-server ... listening on` line, `SUPERVISOR_ENV <n> entries from ~/.dori/env`,
`HOST_SUPERVISOR_READY`, and `HOST_HEALTHCHECK` lines.

## Secrets

The unit has no `EnvironmentFile` and no secret in its environment. The supervisor Worker
reads `~/.dori/env` (the Discord token, `GH_TOKEN`, and the rest `dori setup` writes) into
its own `process.env` when it starts. That is a copy the main thread never sees, so the
thread that serves HTTP holds no Dori secret. Commands the supervisor starts get the values
because Dori spawns them with its environment.

Edit `~/.dori/env` as before, then `systemctl --user reload toodo.service` so a new Worker
reads it. `toodo doctor` fails when the unit's environment holds a name from
`~/.dori/env` or loads the file.

## Health Checks

The host reads two ping URLs from `~/.config/host-healthcheck.env` (mode 600;
`TOODO_HEALTHCHECK_FILE` moves it) and checks every minute:

| Variable | Healthy | Failing |
| --- | --- | --- |
| `HC_TOODO_URL` | the core answers on loopback with a status below 500 | no answer within 5 seconds, or a 5xx |
| `HC_DORI_URL` | `~/.dori/state/gateway-status.json` was written at most `DORI_MAX_AGE_MS` (default 120000) ago | the file is missing or older |

A healthy check pings its URL, a failing one pings `<URL>/fail` with the reason as the
body. Each ping is tried four times with a 10 second timeout. The URLs never appear in the
log: a check logs `HOST_HEALTHCHECK <name> ok` or `HOST_HEALTHCHECK <name> failing:
<reason>` when its state changes, and `HOST_HEALTHCHECK_SEND_FAILED <name>: <status or
error>` when a ping cannot be sent. Without the file the host logs `HOST_HEALTHCHECK_OFF`.

When `toodo.service` stops, nothing pings, and healthchecks.io alerts the owner after the
checks' grace time, without Discord.

## The `toodo` Command

`bun link` in the checkout's root puts `toodo` on `PATH` (in `~/.bun/bin`), next to `dori`.
It works on the TypeScript storage and commands:

- `toodo review [--period ...] [--format markdown|csv]`: the review of a period, with the
  options of the Rust command, read from the database directly.
- `toodo doctor`: `toodo.service` is active and runs this checkout with no secret in its
  environment, `toodo-server.service` and `dori-supervisor.service` no longer run beside
  it, the supervisor runs, the server's version matches the checkout, the database opens
  at the baseline schema and passes `quick_check`, the tokens exist, and both ping URLs are
  set. Exits 1 on a FAIL.
- `toodo service install`: writes `~/.config/systemd/user/toodo.service` for this checkout
  and runs `systemctl --user daemon-reload`. It carries the `TOODO_*` settings of
  `toodo-server.service` (listen address, data directory, public URL, Cloudflare Access,
  chat agent) and `DORI_CONFIG` and `PATH` of `dori-supervisor.service`, sets
  `TOODO_WEB_DIR` to the checkout's `dist-web`, and nothing else. It enables and starts
  nothing.

The data directory is `--data-dir`, else `TOODO_DATA_DIR`, else the one `toodo.service`
sets, else the one `toodo init` recorded in `~/.config/toodo/data-dir`.

`dori doctor` and `dori status` check `toodo.service` in place of `dori-supervisor.service`
while it is active, and `dori doctor` fails when `dori-supervisor.service` still runs or is
enabled beside it.

## Updates

`dori update --dev` (and the supervisor's automatic update after a merge, which runs it
outside the service) fast-forwards `~/.dori/src` and, while `toodo.service` is active:

1. runs `npm ci` when `package.json` or `package-lock.json` changed;
2. builds the web app (`npx vite build` into `dist-web`) when `src/`, `public/`,
   `index.html`, `vite.config.ts`, or the manifests changed;
3. restarts `toodo.service` when `server/`, `host/`, or the manifests changed, or with
   `--force`;
4. otherwise reloads it when `dori/` or pi-quota changed, which replaces only the
   supervisor Worker, and leaves it running after a web-only change.

A failed `npm ci` or web build stops the update before the restart, with the checkout
already moved; fix the cause and run `dori update --dev` again.

## Switching Over

Do this once, when the TypeScript server serves everything the Rust one does (MCP and
OAuth included) and the parity checks pass.

### Before Switching: the Baseline Schema

The core opens only a database at `BASELINE_SCHEMA_VERSION` (56, where the Rust schema is
frozen; see `AGENTS.md`). A host still on an older Rust release has an older schema, and
the core refuses to start on it. Check the live database:

```sh
sqlite3 ~/.local/share/toodo-server/toodo.sqlite3 'PRAGMA user_version'
```

Below 56, bring it there with a Rust server at the frozen schema before anything else.
Stable releases up to v1.11.0 predate the freeze; every dev pre-release built after it
(`vX.Y.Z-dev.N` on the releases page, such as the newest) carries schema 56 and a Linux
build, so no Rust toolchain is needed:

1. Take a backup (Settings, Backups in the web app). The migration is the first change
   the old server cannot undo.
2. Install that build in place of the old one; the service restarts on it and migrates
   the database when it opens it:
   ```sh
   cd ~/.dori/src && scripts/install-server.sh --release vX.Y.Z-dev.N
   ```
3. `PRAGMA user_version` prints `56`, and the web app works as before.

That build is the last Rust server: use `~/.local/bin/toodo-server` as the reference for
the shadow reads and the Rust binary of `rust-check` ([parity.md](parity.md)). Then run
the shadow reads against the live database for three days before switching, from
`~/.dori/src`:

```sh
node scripts/parity/parity.ts shadow --live ~/.local/share/toodo-server/toodo.sqlite3 \
  --reference ~/.local/bin/toodo-server --candidate "bun server/src/main.ts" \
  --rounds 72 --out ~/toodo-shadow
```

Switch only when every round in `shadow.jsonl` has no difference left unexplained.

### Steps

1. Pause autopilot and wait until no lane runs on this host (`dori status`).
2. Update the checkout and build the web app:
   ```sh
   dori update --dev
   cd ~/.dori/src && npm ci && npx vite build && bun link
   ```
3. Take a backup of the database right before the switch (Settings, Backups in the web
   app, or a copy of the data directory while the server is stopped), and note its path.
4. Write the unit and look at it: `toodo service install`, then
   `cat ~/.config/systemd/user/toodo.service`.
5. Replace the services, in one go:
   ```sh
   systemctl --user disable --now toodo-server.service dori-supervisor.service host-healthcheck.timer
   systemctl --user enable --now toodo.service
   ```
6. Check: `toodo doctor` and `dori doctor` have no FAIL, the journal shows
   `HOST_HEALTHCHECK toodo ok` and `HOST_HEALTHCHECK dori ok`, both checks are up on
   healthchecks.io, and the web app and a Discord message to Dori work.
7. Resume autopilot.

### Rolling Back

While the database is still at the Rust server's schema version, going back takes one
step; the data stays in the same file:

```sh
systemctl --user disable --now toodo.service
systemctl --user enable --now toodo-server.service dori-supervisor.service host-healthcheck.timer
```

## Retiring the Old Deployment

Once the checks of step 6 pass, remove what only the old services used; after this, the
backup from step 3 is the way back, not the old services. Keep the data directory
(`~/.local/share/toodo-server` unless `TOODO_DATA_DIR` moved it): it holds the database,
tokens, and backups that `toodo.service` serves.

1. Check that nothing depends on the old pieces: `toodo doctor` shows `unit checkout` as
   `~/.dori/src`, and `systemctl --user is-enabled toodo-server.service
   dori-supervisor.service host-healthcheck.timer` prints `disabled` for each.
2. The Rust server installed by `scripts/install-server.sh`:
   ```sh
   rm ~/.config/systemd/user/toodo-server.service
   rm ~/.local/bin/toodo-server
   rm -r ~/.local/share/toodo-server-web
   ```
3. The Rust `toodo` CLI: `npm rm -g @dubusoft/toodo` for an npm install, or
   `rm -r ~/.local/lib/toodo ~/.local/bin/toodo` for a GitHub release install. Then
   `command -v toodo` must print `~/.bun/bin/toodo`; run `bun link` in `~/.dori/src` again
   if it prints nothing.
4. A checkout `install-server.sh` built from (a deployment checkout other than
   `~/.dori/src`): make sure `git status` is clean and nothing is unpushed, then delete it.
5. The standalone supervisor unit: `rm ~/.config/systemd/user/dori-supervisor.service`.
   Do not run `dori setup --autostart` on this host afterwards: it installs that unit
   again.
6. The health check timer: `rm ~/.config/systemd/user/host-healthcheck.timer
   ~/.config/systemd/user/host-healthcheck.service ~/.local/bin/host-healthcheck.sh`.
   Keep `~/.config/host-healthcheck.env`; `toodo.service` reads it.
7. `systemctl --user daemon-reload`, then `toodo doctor` and `dori doctor` once more.

`scripts/install-server.sh` stays in the repository for installs of the released Rust
server elsewhere; this host no longer uses it.
