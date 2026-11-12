# Linux Server

`toodo-server` is Toodo: it runs headless on a Linux machine for one user, and is used from a browser. It serves:

- the commands of the app as an HTTP API with a server-sent event stream (see [API](#api)),
- the frontend, an installable web app (PWA) that uses them (see [Web App](#web-app)),
- the MCP server for coding agents on the machine (`http://127.0.0.1:47616/mcp`),
- the background work: automatic backups and Web Push notifications,

and keeps its data in SQLite in the server's data directory. Everything is served on one
port, `127.0.0.1:47616` by default.

Toodo tracks tasks and keeps their history; it runs no work itself. The server starts no
git, gh, herdr, ssh, tmux, `claude`, or `codex`, and needs no other program on `PATH`. The
agent or person doing a task creates branches and worktrees, runs agents, opens pull
requests, and writes the results into Toodo through MCP or the web app. The one outside
call the server makes is an HTTP `GET` for a task's `url` criteria.

Data of the Windows desktop app that earlier releases shipped can be moved into a server
with `toodo-server import`; see [migrate-desktop-data.md](migrate-desktop-data.md).

## Versions and Releases

Every GitHub release `vX.Y.Z` carries
`toodo-server-vX.Y.Z-linux-x86_64.tar.gz` (the `toodo-server` binary for x86_64 Linux and,
under `web/`, the web app) with its `.sha256`, built from the same commit. `toodo-server --version` prints the
version, so an installed server compares directly with a release, and the commit it was built from (`toodo-server 0.12.0 (commit
1c78b7a1a2b3)`), so a build of a later commit is told apart from the release it reports.
The server prints the same line when it starts. See "Releases and Updates" in the README for how a release is made.

### npm Packages

The same version is published to npm as `@dubusoft/toodo` (the `toodo` launcher) with
one platform package per target, each carrying `toodo`, `toodo-server`, and the web app:
`@dubusoft/toodo-linux-x64` and `@dubusoft/toodo-linux-arm64` (glibc),
`@dubusoft/toodo-linux-x64-musl` and `@dubusoft/toodo-linux-arm64-musl` (statically linked
against musl, for Alpine and other musl distributions), and `@dubusoft/toodo-darwin-x64`
and `@dubusoft/toodo-darwin-arm64` (macOS). npm installs the package whose `os`, `cpu`,
and `libc` match the machine, and the launcher runs it.
The `npm` workflow (`.github/workflows/npm.yml`) publishes them:

- On every push to `dev`, a prerelease `X.Y.Z-dev.N` (the next patch version of
  `package.json`, `N` the run number) under the dist-tag `dev`.
- In a run on `main` with dist-tag `latest`, the release version under the dist-tag
  `latest`, skipped when that version is on npm already. The `Release` workflow starts
  this run; a failed or skipped publish is retried by running the `npm` workflow by hand
  on `main` with dist-tag `latest`.

It publishes with the `NPM_TOKEN` secret when that is set, else through npm trusted
publishing (OIDC). With neither set up it skips publishing with a notice instead of
failing. Under trusted publishing the musl and macOS packages are published only once
trusted publishing is configured for them on npmjs.com, which npm allows only for a
package that exists: publish the first version of a new platform package by hand, then
configure it. Until then the workflow leaves that package out with a notice, and
`@dubusoft/toodo` does not list it. Packages are staged with `scripts/package-npm.mjs`.

## Install with npm

This is the recommended way to install and update Toodo. On Linux x64 or arm64 (glibc or
musl) or macOS x64 or arm64 (Node.js 18 or later):

```sh
npm i -g @dubusoft/toodo
toodo init
toodo service install
```

`toodo update` updates it later. `npx @dubusoft/toodo init` works too: run through `npx`,
`init` first installs the same version globally with
`npm i -g @dubusoft/toodo@<version> --include=optional` and goes on from that install, so the
server does not run from npm's npx cache (which npm may clean) and the `toodo` command stays
on `PATH`. When npm cannot install globally (`EACCES`), nothing is set up; give npm a prefix
you own (`npm config set prefix ~/.local`, with `~/.local/bin` on `PATH`) and rerun it. The
other ways, [from a release without npm](#install-and-update) and
[from a checkout](#from-a-checkout), are for machines without Node.js and for development.

`init` creates the data directory with its database and access tokens, saves the listen
address in `cli.json` there, and starts `toodo-server` in the background. It prints the web
app URL and the file that holds the web access token (`cat` it to sign in), and the MCP
URL with its token file. Where `claude` is on `PATH` it registers the MCP endpoint with
`claude mcp add-json` in the user scope, with a `headersHelper` that reads `mcp-token`
each time Claude Code connects; where `codex` is on `PATH` it writes the endpoint and the
token to `$CODEX_HOME/config.toml` (else `~/.codex/config.toml`), readable by the owner
only. The token never appears on a command line. `toodo start` and `toodo update`
register the endpoint again with the agents that have it registered already, so they
pick up a replaced token. Running `init` again keeps the database and tokens; a server
that `toodo start` left running from another install (such as the npx cache) is restarted
on this one. The next steps it prints name `toodo` when the `toodo` on `PATH` is this
install, else the full path of the CLI. `claude` and `codex` are looked for only to
register the MCP endpoint with them.

- `--port N`: port to listen on, keeping the saved host (default `47616`).
- `--listen HOST:PORT`: address to listen on (default `127.0.0.1:47616`). On an address
  other than loopback (such as `0.0.0.0`), other machines can reach the server over plain
  HTTP, and `init` and `service install` print a warning; keep it on loopback and reach it
  through a tunnel instead (see [Off the Machine](#off-the-machine-cloudflare-tunnel-and-access)).
- `--data-dir DIR`: data directory (default `$TOODO_DATA_DIR`, else the directory `init`
  recorded, else `$XDG_DATA_HOME/toodo-server` or `~/.local/share/toodo-server`). `init`
  records the absolute path in `$XDG_CONFIG_HOME/toodo/data-dir` (`~/.config/toodo/data-dir`),
  so the other commands find it without the option; they take `--data-dir` too, and the
  option beats `$TOODO_DATA_DIR`, which beats the record.
- `--no-mcp`: register the MCP endpoint with no agent.

The commands of a global install (`toodo COMMAND --help` shows the options of each):

- `toodo start`, `toodo stop`: start or stop the server, through systemd or launchd once
  the service is installed, else as a background process with `server.pid` and
  `server.log` in the data directory. On macOS `toodo stop` unloads the launchd job; it
  loads again at the next login or `toodo start`.
- `toodo restart`: stop the server and start it again the same way, then register its MCP
  endpoint again like `toodo start`.
- `toodo status`: whether the server runs and where its files are; exits `0` when it runs
  and `3` when it is stopped.
- `toodo doctor`: the versions of `toodo` and of the running server (asked with the web
  access token of the data directory), whether the server runs and answers, the database
  and tokens in the data directory. Each problem is printed with the command that fixes
  it; it exits `0` when it finds none and `1` when it does. It checks no other programs.
- `toodo logs [--lines N] [--follow]`: print the last 50 (or `N`) lines of the server log,
  and with `--follow` new lines until interrupted: through `journalctl --user -u
  toodo-server` for the systemd service, else with `tail` of
  `~/Library/Logs/toodo-server.log` for the launchd agent or of `server.log` in the data
  directory.
- `toodo uninstall [--delete-data]`: stop the server and remove what `toodo` set up for
  it: the systemd service (disabled, its unit removed) or the launchd agent, the copies
  of the server and web app they run, the MCP registrations of the server's URL with
  Claude Code and Codex (a registration of another server stays), and the record of the
  data directory in `~/.config/toodo/data-dir` when it names this one. The data directory
  stays unless `--delete-data`, which deletes it only when it holds a Toodo database. The
  `toodo` command itself stays; `npm rm -g @dubusoft/toodo` removes it.
- `toodo service install`: run the server as the systemd user service
  `toodo-server.service`, in the same layout as `scripts/install-server.sh`
  (`~/.local/bin/toodo-server`, the web app in `~/.local/share/toodo-server-web`, see
  [systemd](#systemd)). It enables and restarts the service and turns on lingering with
  `loginctl enable-linger`, noting the `sudo` command when that is not allowed. With
  `--port N` or `--listen HOST:PORT` it saves a new listen address first, like `init`.
  On macOS it installs the same files and writes the launchd agent
  `~/Library/LaunchAgents/toodo-server.plist` instead, which runs the server in the
  logged-in user's session (`gui/<uid>`), starts it at login, restarts it after a crash,
  and logs to `~/Library/Logs/toodo-server.log`; it loads the job with
  `launchctl bootstrap` and waits until the server accepts connections.
- `toodo update [--channel dev|latest] [--allow-downgrade | --check]`: update a global
  install and restart the server on it, see below. With `--check` it only prints whether
  the channel has a newer version than the installed one, and changes nothing.
- `toodo review [--period week|month|quarter|year|custom] [--date DAY] [--from DAY]
  [--to DAY] [--format markdown|csv] [--workspace ID] [--label LABEL] [--time-zone ZONE]`:
  print the review of a period as the web app's Review exports it, rendered by the
  running server with the web access token of the data directory; days and times are in
  the server's review time zone (see the Review section of
  [architecture.md](architecture.md)) unless `--time-zone` names another. For example
  `toodo review --period year --format csv > review.csv`.
- `toodo --version`, `toodo --help`. `--version` prints the version of the installed npm
  package (`toodo 1.3.2-dev.9 (commit 1c78b7a1a2b3)`). `toodo-server --version` and the
  server's start log line report the same version: the npm workflow builds both binaries
  with `TOODO_VERSION` set to the version it publishes (`src-tauri/build.rs`); other builds
  report the crate version.

`@dubusoft/toodo` follows releases; `@dubusoft/toodo@dev` follows the `dev` branch
(`X.Y.Z-dev.N` prereleases), for example `npx @dubusoft/toodo@dev init`.

To update a global install, run `toodo update`. It:

1. Picks the channel: `--channel dev` or `--channel latest`, else `dev` when the installed
   version is a prerelease and `latest` when it is a release.
2. Resolves the channel to a version with `npm view` and stops when that version is
   installed already. When it is older than the installed version by semver precedence
   (`1.3.2-dev.1` is older than `1.3.2-dev.8`, and `1.3.2-dev.11` older than `1.3.2`), it
   installs nothing and prints the command to install it anyway:
   `toodo update --channel <channel> --allow-downgrade`. It checks that npm's global root (`npm root -g`) holds this `toodo`,
   so it never updates another copy, and that the platform package of the version
   (`@dubusoft/toodo-linux-x64`, ...) is on npm, which is published shortly after
   `@dubusoft/toodo`. Then it runs `npm i -g @dubusoft/toodo@<version> --include=optional`.
3. Restarts the server of the data directory (`--data-dir` as for the other commands) on
   the new version, the way it runs: for the systemd user service `toodo-server.service`
   it copies the new `toodo-server` and web app over `~/.local/bin/toodo-server` and
   `~/.local/share/toodo-server-web` and runs `systemctl --user restart`; a server started
   by `toodo start` is stopped and started again; on macOS the launchd agent `toodo-server`
   (`~/Library/LaunchAgents/toodo-server.plist`) gets the same copies and is restarted with
   `launchctl kickstart -k`. A server that is not running is left stopped; for the systemd
   service and the launchd agent the new server and web app are still copied, so the next
   `toodo start` runs the new version.
4. Checks that the server answers (`POST /api/rpc/list_tasks` without a token is `401`).
5. Prints the old and new version and the result.

When npm fails, nothing is restarted and the running server keeps its version. When the
server does not answer after the restart, `toodo update` goes back by itself: it installs
the previous version with `npm i -g @dubusoft/toodo@<previous> --include=optional`,
restarts the server on it the same way, and checks that it answers. It then exits `1` with
the cause and `toodo logs` to find out why; when going back fails too, it prints the
commands to restart the server or go back by hand.

The web app shows a newer version too: Settings > General names it under the version of
the server. The server asks the npm registry for the dist-tags of `@dubusoft/toodo` (the
`check_update` command), from `https://registry.npmjs.org` unless `TOODO_NPM_REGISTRY`
names another registry, and compares the version on its own channel.

Without `toodo update`, run `npm i -g @dubusoft/toodo` again, then `toodo service install`
or `toodo stop` and `toodo start`.

## Install and Update

Without Node.js, install and update from releases instead of npm. The script needs gh logged in and curl to download the release;
no Rust toolchain is needed:

```sh
scripts/install-server.sh --release latest
```

The script needs no checkout in this mode; fetch it alone with
`gh api repos/Dubusoft/toodo/contents/scripts/install-server.sh --jq .content | base64 -d`
if there is none. It downloads the server asset of the release with `gh`, checks its
sha256 and that the binary reports the release's version, installs it to
`~/.local/bin/toodo-server` and the web app to `~/.local/share/toodo-server-web`, writes the
systemd user service `toodo-server.service` (see [systemd](#systemd)), restarts it, and
checks that it answers (`/api` without a token is `401`, `/` is the web app). It prints
where the tokens are, never the tokens.

- `--release latest|vX.Y.Z`: the release to install; `vX.Y.Z` pins a version.
- `--listen ADDR`: listen address of the service (default `127.0.0.1:47616`).
- `--no-service`: install only; leave the service alone.

To update, run it again with the same options; the database and tokens in the data
directory are kept.

Releases before the server was published (0.9.3 and older) have no server asset; build
those from a checkout. Releases before the web app was published carry the binary only;
the script then serves the API and MCP only.

### From a Checkout

For development, run the script without `--release` from a checkout of this repository
(Rust needed as well). It builds `toodo-server` from the checkout and installs it the same
way:

```sh
git pull
scripts/install-server.sh
```

- `--with-web`: also build the web app (needs Node.js and npm), install it to
  `~/.local/share/toodo-server-web`, and serve it (see [Web App](#web-app)). A release
  carries its web app already, so this option is for checkout builds only.

## Build

To build by hand instead, on the server (Rust installed):

```sh
cd src-tauri
cargo build --release --bin toodo-server
```

The binary is `src-tauri/target/release/toodo-server`. It needs no other program at
runtime.

## Run

```sh
toodo-server
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOODO_LISTEN` | `127.0.0.1:47616` | Address to listen on |
| `TOODO_DATA_DIR` | `$XDG_DATA_HOME/toodo-server` or `~/.local/share/toodo-server` | Database, backups, and access tokens |
| `TOODO_WEB_DIR` | none | Web build to serve; without it only the API and MCP are served |
| `TOODO_PUBLIC_URL` | none | Public HTTPS origin, e.g. `https://toodo.example.com`; turns on OAuth for chat apps (see [Chat Apps over OAuth](#chat-apps-over-oauth)) |
| `TOODO_PUSH_SUBJECT` | `https://github.com/Dubusoft/toodo` | Contact sent to push services with every notification, a `mailto:` or `https:` URL (see [Notifications](#notifications)) |

On first start the data directory gets two access tokens:

- `mcp-token`: agents send it to `/mcp` as `Authorization: Bearer <token>`.
- `web-token`: the shared web token. A browser signs in with it once and is registered
  as a device with a token of its own (see [Devices](#devices)); `/api` accepts the
  shared token too, so existing clients keep working.

The data directory is created readable by its owner only (`0700`) and the token files
`0600`; the server tightens an existing directory and token files on start. To replace a
token, delete its file and restart the server; for `mcp-token`, restart it with
`toodo stop` and `toodo start`, which give the new token to the agents `init`
registered. Replacing `web-token` does not sign out registered devices; revoke them one by one. The server logs every token file it creates,
and its start line names both token files and the server's instance id.

A request without a valid token gets `401` with `WWW-Authenticate: Bearer` and a
plain-text body that says why and what to do, never the token: no `Authorization`
header, a header that is not `Bearer <token>` (the scheme is case-insensitive), a token
the server does not accept, or the other surface's token (`web-token` at `/mcp`, the MCP
token at `/api`). At `/mcp` the body also names the server instance, which tells a reply
from another Toodo server, e.g. one an old config or a tunnel reached, apart from this one.
An expired device token gets `401` that says it expired.

Wrong tokens are rate limited per client address and per surface: after 20 wrong tokens
within a minute, every request from that address to that surface (`/api` or `/mcp`) gets
`429` with `Retry-After` until the minute since the first of them is over, even with the
right token. Missing headers and the other surface's token do not count. Behind a reverse
proxy every client shares the proxy's address, so one client that keeps sending an old
token locks out the others for that minute; stop it, or replace its token.

### Backups

The server writes backups of the database into its backup directory, `<data>/backups/`
unless *Settings > Backups* names another absolute path, such as a directory on another
disk (saved as `directory` in `<data>/backup-settings.json`). Backups already in the old
directory stay there and are no longer listed. There are three kinds:

- `toodo-auto-<time>.sqlite3`: on the automatic schedule (every 24 hours by default,
  the newest 7 kept).
- `toodo-pre-restore-<time>.sqlite3`: right before a restore or an import replaces or
  adds data.
- `toodo-pre-migration-<time>.sqlite3`: on start, right before a newer version migrates
  the database to its schema. If this backup cannot be written, the server does not start
  and leaves the database unchanged; its error names the directory to fix.

Each backup is a `VACUUM INTO` snapshot that must pass `PRAGMA integrity_check` before it
takes its name; a damaged one is deleted. Automatic backups and exports read the
database through a connection of their own, so requests keep being served while they
run. When an automatic backup fails, the Settings button and *Settings > Backups* say so,
with the reason, until one succeeds again.

### Import

```sh
toodo-server import FILE
```

adds the data of another Toodo database, such as a Windows desktop app's (see
[migrate-desktop-data.md](migrate-desktop-data.md)), to the data in `TOODO_DATA_DIR`, then
exits. It imports workspaces, tasks (with dependencies, status history, commit records,
notes, related links, criteria, and pull request snapshots) in one
transaction, after writing a pre-restore backup into `<data>/backups/`. Devices, push
subscriptions, connected OAuth apps, settings, saved reviews, and chat messages are not
imported. Records of the removed execution backend (herdr workspaces, runs, machine
settings) are not imported either. The file is checked and migrated to the latest
schema in memory first; a newer schema than the server's is refused, and the file itself
is never modified.

Imported IDs go after every ID the server has used: task #N becomes #(N + offset), and the
command prints the offset. Into an empty server, tasks keep their numbers. Stop the
service first (`systemctl --user stop toodo-server`) and start it again afterwards.

### Devices

Each device has its own access token, so a lost phone is revoked alone instead of
rotating the token of every client. The database keeps a device's name, when it was
registered and last seen, when its token expires, what it may do, and when it was
revoked, but only a SHA-256 hash of its token; the token itself is shown to the device
once, when it registers. Revoking is final: the token never works again, and the device
signs in anew with the shared token. Only the shared token registers devices, so a device
token cannot mint more tokens. A device keeps its id after it is revoked, so data kept per
device can refer to it.

A registration under the name of a device that is not revoked reuses that device instead
of adding one: it takes the new token, access, and lifetime, its old token stops working,
and its notification subscription is dropped. A browser that loses its stored token, e.g.
because it clears site data on exit, signs in again and keeps one device; older devices
that share the name are revoked. Two browsers that should both stay signed in need
different names.

A device token expires 90 days after it is registered unless the registration picks
another lifetime (30 days, a year, or never in the web app); the device then signs in
again with the shared token. Tokens registered before expiry existed expire 90 days after
the upgrade that added it. A device registered read-only may read everything the app
shows, keep its own notifications, and revoke itself; every other request gets `403`.
Read-only devices cannot see the MCP token, which can change data.

The last-seen time is checked on the database's read-only connection and written at most
once a minute per device, so requests do not wait for the database's writer.

The web app asks for the access and lifetime when it signs in with the shared token,
lists the devices under **Devices** in Settings with their expiry and whether they are
read-only, marks the current one, and revokes them. Devices live in the database, so restoring a backup also restores the
devices of that backup: devices registered after it sign in again.

**Treat `web-token` like a password to the server account.** It opens every command of
the app, including ones that download or replace the whole database. `mcp-token` gives the MCP
tools only, but still lets an agent start, complete, and conclude tasks.

The server speaks plain HTTP. Keep the default loopback address; never expose the port.

### Notifications

A device can get notifications while Toodo is closed, through the Web Push service of
its browser: Chrome and Edge on Android and desktop, Firefox, and Safari on iOS and
iPadOS 16.4 or later once Toodo is added to the Home Screen (Safari has no Web Push in
a plain tab). Web Push needs HTTPS, so phones reach the server through an
authenticating HTTPS front (see [Off the Machine](#off-the-machine-cloudflare-tunnel-and-access));
on the server itself, `http://127.0.0.1` counts as secure.

Under **Notifications** in Settings, a device turns notifications on, picks which
ones it gets, and sends itself a test notification:

| Setting | Notifications |
| --- | --- |
| Task awaiting completion | A task moved to `in_review`, so its work awaits review and completion |

The settings **Agent finished or needs input** and **Pull request checks and reviews** are
still listed, but the server no longer watches agents or pull requests, so they send
nothing. Opening a notification opens its task. While notifications are on, the app shows
no notifications of its own on that device, so nothing arrives twice.

Subscriptions belong to devices: a browser signed in with the shared `web-token` signs
in again to get a device token first. Revoking a device ends its subscription, and a
subscription the push service reports gone is dropped.

A notification the push service cannot take for a while (it cannot be reached, or it
answers 429 or 5xx) is tried again after 1, 2, and 4 seconds; while a device's push
service stays unreachable, its other notifications of the same change are skipped. Any
other refusal is not retried. The settings show the last notification that did not
reach the device and why, until a notification (such as a test one) reaches it again.

The server signs its requests to push services with a P-256 key (VAPID) that it creates
in `push-key` in the data directory on first start (`0600`, like the tokens). Browsers
bind their subscriptions to that key: replacing or losing the file ends every
subscription, and each device turns notifications on again. Messages are encrypted for
the device (RFC 8291); the push service sees only where to deliver them and when.
Push services keep a message for an offline device for a day.

### Agents

An agent on the server uses the MCP server with this configuration (the token is the
contents of `mcp-token`):

```json
{
  "mcpServers": {
    "toodo": {
      "type": "http",
      "url": "http://127.0.0.1:47616/mcp",
      "headers": { "Authorization": "Bearer <mcp-token>" }
    }
  }
}
```

An agent on another machine reaches the server the way a browser does: over an SSH
tunnel to the loopback port (`ssh -L 47616:127.0.0.1:47616 <server>`). Don't point local
agents at a public hostname; see [Off the Machine](#off-the-machine-cloudflare-tunnel-and-access).

Settings > Agent access in the web app copies this config or the MCP token alone
("Copy MCP token for agents"; it is not the web sign-in token), checks with **Test
connection** that the server accepts the token it shows, and shows the server instance
and the last request `/mcp` turned away, with its
reason and how many it turned away since the server started. The MCP `initialize` reply
names the instance in `serverInfo.title`.

### Agent MCP Tools

The MCP server has 32 tools:

- Skill: `read_toodo_skill`.
- Workspaces: `list_workspaces`, `create_workspace`, `update_workspace`,
  `archive_workspace`.
- Reading tasks: `list_tasks`, `search_tasks`, `get_task`, `current_task` (finds a task by
  one of its refs, such as `lane:search`).
- Planning: `create_task`, `create_plan`, `update_task`, `move_task`, `add_dependency`,
  `remove_dependency`, `add_related`, `remove_related`, `add_criterion`,
  `remove_criterion`.
- Recording work: `start_task`, `add_progress_note`, `report_blocker`, `check_criterion`,
  `pause_task`, `resume_task`, `wait_task`, `end_wait`, `complete_task`, `conclude_task`,
  `reopen_task`, `delete_task`, `delete_done_tasks`.
- Review: `review_report`.

Two of them help an agent wire a plan:

- **Create.** `create_task` takes `depends_on` and `related`, so a plan is wired in one
  call; an unknown task in either rejects the call and creates nothing.
- **Plan.** `create_plan` creates several tasks in one call and one transaction. Each
  task takes the fields of `create_task` and a `key` unique in the plan; it links to other
  tasks of the plan by key in `depends_on_keys` and `related_keys`, and to existing tasks
  by ID in `depends_on` and `related`. An unknown key or task, a repeated key, keys whose
  dependencies form a cycle, or a failure in any one task rejects the call and creates no
  task. The reply lists the created tasks with their keys, in the order given.

`start_task` only records the start: it moves a ready task to `in_progress` with an
optional reason and refs, and creates nothing else. The agent doing the work moves the
task to review with `update_task` (`status: "in_review"`) and finishes it with
`complete_task` or `conclude_task`. Toodo doesn't check whether a pull request merged;
the caller checks that before completing.

`wait_task` makes a `planned`, `in_progress`, or `in_review` task wait until a time, an
RFC 3339 time with an offset such as `2026-11-10T09:00:00+09:00`; an active task is
paused until then. A thread of the server returns each task whose time has passed to
the status it had, checking every few seconds and right after a start, so a wait that
ended while the server was stopped ends when it starts again. Calling `wait_task` again
moves the time, and `end_wait` returns the task now. The task's `wait` field
(`{ "until", "status" }`, `null` when it doesn't wait) tells until when it waits and the
status it returns to (see [workflow.md](workflow.md#task-states)). `wait_task` takes one
task: there is no bulk wait, and an agent must not wait every task, or a batch of them, at
once.

`read_toodo_skill` returns the worker skill (`src-tauri/src/mcp/toodo-skill.md`); rules it
shares with the `initialize` instructions come from `src-tauri/src/mcp/shared/` (see
[docs/agents.md](agents.md)).

### Task Resources

Tasks are MCP resources, so an agent can wait for a change instead of calling `get_task`
again and again:

- `toodo://tasks/{task_id}`: the task as `get_task` returns it, including `ready` and
  `blockedBy`, so a task's resource changes when a task it depends on is done.

`resources/list` lists the tasks that are not done, and `resources/templates/list` the
URI template. The endpoint is stateless, so notifications need a client of protocol
`2026-07-28`, which opens a `subscriptions/listen` stream with `resourceSubscriptions` (and
optionally `resourcesListChanged`). The stream gets `notifications/resources/updated` for
each watched resource whose content changed, and `notifications/resources/list_changed`
when a task is added, is done, or comes back. The server reads the watched resources again
after every change the app announces, and at least every 5 seconds. Clients of earlier
protocols, which start with `initialize`, can read the resources, but the server does not
offer them `resources/subscribe`: their notifications would need a session.

### Chat Apps over OAuth

The ChatGPT and Claude apps can plan in Toodo as a remote MCP server. They can't hold the
static `mcp-token`, so they sign in with OAuth instead, and the server owner approves each
one. This is public mode, and it's off by default.

**Turning it on.** Set `TOODO_PUBLIC_URL` to the origin the apps reach the server at,
for example `Environment=TOODO_PUBLIC_URL=https://toodo.example.com` in the
[systemd](#systemd) unit. It must be `https://` with no path, query, or fragment (a
trailing `/` is fine); `http://` is accepted only for `localhost`, `127.0.0.1`, and
`[::1]`. Anything else stops the server at start with a message naming the expected form.

Without it, nothing changes: the OAuth and discovery paths answer `404`, and `/mcp` accepts
only the MCP token, only from loopback peers with a loopback `Host`. A request from another
address gets `403` saying to connect through loopback or an SSH tunnel, or to set
`TOODO_PUBLIC_URL`. With it, `/mcp` also accepts the public host, and requests may come from
any peer (the tunnel or proxy in front is the peer). Local agents keep using `mcp-token`
on loopback as before and still see every tool.

**What a chat app can do.** An app gets one or both scopes:

- `toodo.read`: `read_toodo_skill`, `list_workspaces`, `list_tasks`, `search_tasks`,
  `get_task`, `review_report`, and the [task resources](#task-resources).
- `toodo.write`: the read tools, plus `create_workspace`, `create_task`, `create_plan`,
  `update_task`, `move_task`, `add_dependency`, `remove_dependency`, `add_related`,
  `remove_related`, `add_criterion`, `remove_criterion`, `check_criterion`, `add_progress_note`,
  `report_blocker`, `pause_task`, and `wait_task`.

The other tools stay local: `current_task`, `start_task`, `resume_task`, `end_wait`,
`complete_task`, `conclude_task`, `delete_task`, `delete_done_tasks`, `reopen_task`,
`update_workspace`, and `archive_workspace` never appear in an app's tool list, and calling one is refused even
with `toodo.write`. `check_criterion` checks a stored manual criterion. An app's
`initialize` reply and `read_toodo_skill` carry planning instructions for a chat.

**Connecting.** In ChatGPT or Claude, add a custom (remote) MCP connector with the URL
`https://toodo.example.com/mcp` and OAuth authentication; leave client ID and secret empty,
since the app registers itself. The app finds the authorization server from the `401`
at `/mcp`, which points at `/.well-known/oauth-protected-resource/mcp`. It then opens the
consent page at `/oauth/authorize` in the browser: it names the app and where it returns
to, lists the scopes (read is always granted; untick write for a read-only app), and asks
for `web-token`. Approve, and the browser returns to the app. After 5 wrong tokens the
request is dropped; start the connection again from the app.

**Tokens and revoking.** An access token lasts an hour and a refresh token 30 days. Each
refresh replaces both, and a refresh token presented twice revokes the whole grant, so a
copied token stops working once either side uses it. Only SHA-256 hashes of tokens and
client secrets are stored. To disconnect an app, revoke it under **Connected apps** in
Settings, which also shows the public MCP URL, or disconnect it in the app itself; either
ends its access and refresh tokens at once, and the app connects again through the consent
page.

The endpoints, all under `TOODO_PUBLIC_URL`:

- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`:
  protected resource metadata (RFC 9728).
- `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`:
  authorization server metadata (RFC 8414).
- `POST /oauth/register`: dynamic client registration (RFC 7591). Client ID metadata
  documents (an `https://` URL as `client_id`) work too.
- `GET` and `POST /oauth/authorize`: the consent page; PKCE with `S256` is required.
- `POST /oauth/token` and `POST /oauth/revoke`.

To publish the server through Cloudflare, see
[Chat apps through the tunnel](#chat-apps-through-the-tunnel).

### systemd

`toodo service install` (which `scripts/install-server.sh` runs) writes
`~/.config/systemd/user/toodo-server.service` like this. The unit doesn't depend on any
other service, and its `PATH` holds only the directory the server is installed in and
the system directories `/usr/local/bin:/usr/bin:/bin`, since the server runs no other
programs. `TOODO_WEB_DIR` is added when it installs the web app.

```ini
[Unit]
Description=Toodo server
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart=/home/me/.local/bin/toodo-server
Environment=TOODO_LISTEN=127.0.0.1:47616
Environment=TOODO_DATA_DIR=/home/me/.local/share/toodo-server
# Environment=TOODO_PUBLIC_URL=https://toodo.example.com   (public mode, off by default)
Environment=PATH=/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Rerun `toodo service install` to rewrite a unit an earlier version wrote, which ordered
the server after another service and put the directories of other programs on its
`PATH`. A server that fails to start is restarted every 5 s, at most 5
times in 5 minutes; then the unit stays failed until
`systemctl --user reset-failed toodo-server` and `systemctl --user restart toodo-server`.
To set the service up by hand, run `systemctl --user enable --now toodo-server`, and
`loginctl enable-linger $USER` to keep it running without a login session.

## Web App

The web build of the frontend uses the server from a browser. A release install serves it
(`scripts/install-server.sh --release ...`); from a checkout, use `--with-web`, or
`npm ci && npm run build` into `dist-web/` with `TOODO_WEB_DIR` pointing at it. The
browser asks for `web-token` and a device name once, registers itself as a device, and
keeps its device token in local storage.

It is an installable web app (PWA): browsers offer to install it from the server URL, and
it then opens in its own window. The app offers it as well: a banner installs it in
browsers that can (Chrome, Edge), and on iPhone and iPad it explains *Share > Add to Home
Screen*; dismissing the banner hides it on that browser for good. Browsers install web apps only from a secure origin:
`https://`, or `http://127.0.0.1` and `http://localhost`. The build carries a web app
manifest (`/manifest.webmanifest`, icons under `/pwa/`) and a service worker (`/sw.js`)
that caches the app shell, the built HTML, scripts, styles, and icons, so the app starts
without the network. It never caches or answers `/api` or `/mcp`: everything the app
shows comes from the server. Each build has its own cache, which replaces the previous
one once no window uses it any more.

Each build names itself in `/version.json` (a hash of its `index.html`). An open window
asks for it when it starts, when it reconnects to the server (as after `toodo update`
restarts it), and when it is shown again; when the server serves another build than the
window runs, a banner offers to reload. *Reload* lets the new build's service worker take
over and loads the new build; *Later* hides the banner until the server serves yet
another build.

For reading offline, the app keeps the last loaded workspaces, task list, and what task
details showed (notes, history, related links, and criteria) in the browser's IndexedDB, and shows them when it starts without the server.
They are kept for the build that saved them and forgotten when the browser's access token
is (sign-in again or a revoked device).

When the server does not answer (it is down, the device is offline, or a proxy in front of
it answers with its own 502-504 or 520-530 error page), the app shows an offline banner
over itself instead of a broken page, and the service worker starts the cached app instead
of showing such an error page. What was loaded stays readable: the banner tells when the
tasks shown were loaded, and buttons that change data are disabled until the server
answers. The app checks again after 2 s, doubling up to 30 s, at
once when the device comes back online or the app is shown again, and on *Try again*;
once the server answers, the screen goes away and everything is loaded again.

Reports are downloaded in the browser, and database backups are downloaded and uploaded (see
[API](#api)). Reach the loopback port through an SSH tunnel
(`ssh -L 47616:127.0.0.1:47616 <server>`, then `http://127.0.0.1:47616`); anything that
puts it on a network needs its own authentication in front, since the web token opens the
whole server account. To open it from a phone, see
[Off the Machine](#off-the-machine-cloudflare-tunnel-and-access).

The event stream (`/api/events`) is a long-lived server-sent event response with a
keep-alive comment every 15 seconds; a proxy in front must not buffer it. When the stream
drops, the web app reconnects with the id of the last event it got and the server replays
what it missed; when those events are no longer kept, the web app refetches everything.

### Task Events for Other Clients

A program on the server's machine, such as an executor's supervisor, can follow task
status without polling: open `GET /api/events` with the web token or a device token and
read the `task-status-changed` and `task-ready` events. They report every change,
whether it came from the web app or an MCP tool; `toodo` CLI commands
only read.

```sh
curl -N -H "Authorization: Bearer $(cat ~/.local/share/toodo-server/web-token)" \
  http://127.0.0.1:47616/api/events
```

- `task-status-changed`: `{ "taskId", "workspaceId", "from", "to", "at" }`. `from` and
  `to` are `planned`, `in_progress`, `in_review`, or `done`; a new task reports
  `"from": null, "to": "planned"`. `at` is when the change was recorded, in Unix seconds.
  A move to `done` covers completion and conclusion alike; `get_task` tells them apart.
  A wait shows as two changes: the pause (`in_progress` or `in_review` to `planned`) when
  it begins, and the return to that status when its time passes or it ends early. A
  waiting task that was `planned` sends neither, since its status does not change.
- `task-ready`: `{ "taskId", "workspaceId", "unblockedBy", "at" }`, sent after the
  `task-status-changed` of `unblockedBy` when that move to `done` finished the last
  unfinished dependency of the planned task `taskId`. A dependency concluded as not
  adopted keeps its dependents blocked, so it makes none ready.

```text
id: 3f9a01c2-41
event: task-status-changed
data: {"taskId":12,"workspaceId":2,"from":"in_review","to":"done","at":1794190000}

id: 3f9a01c2-42
event: task-ready
data: {"taskId":13,"workspaceId":2,"unblockedBy":12,"at":1794190000}
```

The stream also carries the events the web app uses (`tasks-changed`,
`workspaces-changed`, `guidelines-changed`); skip the names you do not handle. To resume
after a disconnect, send the id of the last event you handled as `Last-Event-ID`: the
server replays the events after it. A `resync` event instead means some were lost (the
server restarted or more than 256 events went by); read the current state with
`list_tasks` and go on from the id of the `resync` event. A stream opened without
`Last-Event-ID` starts with a `ready` event (not to be confused with `task-ready`)
carrying the id to resume from.

### Off the Machine: Cloudflare Tunnel and Access

To use the web app from a phone or another computer without an SSH tunnel, publish it
through a Cloudflare Tunnel with Cloudflare Access in front. The server keeps listening on
loopback; `cloudflared` connects out to Cloudflare, so no port is opened on the machine.
Access signs you in before any request reaches the server, and the web app still asks for
`web-token`, so a stolen token alone is not enough from outside, and a signed-in browser
without the token gets nothing.

You need a domain on Cloudflare and a Zero Trust organization (the free plan does). Below,
`toodo.example.com` stands for the hostname you pick.

1. **Access first.** In Zero Trust, add an Access application of type *self-hosted* for
   `toodo.example.com` (the whole hostname, no path) with an *Allow* policy that includes
   only your own identity, for example your e-mail address with the one-time PIN login. Do
   it before the hostname resolves, so nothing is ever reachable without it. Add no
   *Bypass* policy here: the API, the event stream, and `/mcp` all sit behind this
   application. Chat apps need a narrow bypass of their own; see
   [Chat apps through the tunnel](#chat-apps-through-the-tunnel).
2. **A tunnel of its own.** Create a new, remotely managed tunnel (*Networks > Tunnels*)
   for the server instead of adding a hostname to a tunnel the machine already runs for
   something else: it gets its own token, can be stopped or deleted alone, and a mistake in
   its routes cannot take the other one down. Give it one public hostname,
   `toodo.example.com` to `http://127.0.0.1:47616` (the server's `TOODO_LISTEN`), and let
   everything else fall through to `http_status:404`. Cloudflare adds the proxied DNS
   record for the hostname.
3. **Run the connector as the server's user.** Save the tunnel's token to a file only you
   can read, and run `cloudflared` with it from a systemd user service next to
   `toodo-server.service`:

   ```sh
   mkdir -p -m 700 ~/.config/toodo-tunnel
   (umask 077 && cat > ~/.config/toodo-tunnel/token)   # paste the token, then Ctrl-D
   ```

   ```ini
   # ~/.config/systemd/user/toodo-tunnel.service
   [Unit]
   Description=Cloudflare tunnel for toodo-server
   After=network-online.target toodo-server.service
   Wants=network-online.target

   [Service]
   ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel run --token-file %h/.config/toodo-tunnel/token
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

   Then `systemctl --user daemon-reload && systemctl --user enable --now toodo-tunnel`.
   Never put the token on the command line or in the unit file, where other users of the
   machine can read it.
4. **Check from outside** (any machine, no cookies): every path is a redirect to the Access
   login, never the app:

   ```sh
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://toodo.example.com/api/rpc/list_tasks
   # 302 https://<team>.cloudflareaccess.com/cdn-cgi/access/login/toodo.example.com?...
   ```

   Then open `https://toodo.example.com` on the phone, sign in to Access, and enter
   `web-token` and a name for the phone once; the phone then keeps a device token of its
   own. Install it from the browser: *Install app* (or *Add to Home screen*)
   in Chrome on Android, *Share > Add to Home Screen* in Safari on iOS.

Things to know:

- The web app links its manifest with `crossorigin="use-credentials"`. Browsers fetch a
  manifest without cookies otherwise, Access would answer it with its login redirect, and
  the browser would not offer to install the app.
- The service worker loads pages from the network first, so when the Access session has
  expired, reopening or reloading the app goes through the Access login again. Until then,
  requests to `/api` fail (Access redirects them to its login, which a script cannot
  follow); reload the app to sign in again. The Access session duration of the
  application sets how often that happens.
- `/api/events` works through the tunnel: Cloudflare passes `text/event-stream` responses
  through unbuffered, and the server's 15-second keep-alive stays below Cloudflare's idle
  timeout.
- Agents keep using `/mcp` on loopback (or through an SSH tunnel to it) with `mcp-token`; don't point them at the public hostname. Only chat apps signed in with
  OAuth use it, and only after the bypass in
  [Chat apps through the tunnel](#chat-apps-through-the-tunnel).
- If a phone is lost, revoke it under **Devices** in Settings from another device; the shared
  `web-token` and the other devices keep working.
- To take it offline again, stop and disable `toodo-tunnel`; to remove it, delete the
  tunnel, its DNS record, and the Access application.

#### Chat Apps through the Tunnel

ChatGPT and Claude can't sign in to Access, so the paths they use must skip it while the
rest of the hostname stays behind it. Set `TOODO_PUBLIC_URL=https://toodo.example.com` (see
[Chat Apps over OAuth](#chat-apps-over-oauth)) and restart the server. Then, in Zero Trust,
add one more self-hosted Access application for the same hostname with these paths only:

- `toodo.example.com/mcp`
- `toodo.example.com/oauth/*`
- `toodo.example.com/.well-known/*`

Give it a single *Bypass* policy that includes everyone. Access applies the most specific
path, so these three skip Access and everything else, the web app, `/api`, and the event
stream, still goes through the first application's *Allow* policy. Bypass nothing else.
On the bypassed paths the server checks the caller itself: `/mcp` needs an OAuth access
token, and the consent page needs `web-token`.

Check from outside: `/mcp` now answers the server's own `401`, and `/api` still redirects
to the Access login:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://toodo.example.com/mcp
# 401
curl -s https://toodo.example.com/.well-known/oauth-protected-resource/mcp
# {"resource":"https://toodo.example.com/mcp",...}
curl -s -o /dev/null -w '%{http_code}\n' https://toodo.example.com/api/rpc/list_tasks
# 302
```

## Development

`npm run dev` starts the Vite dev server and forwards `/api` and
`/mcp` to a running `toodo-server` (`TOODO_SERVER`, default
`http://127.0.0.1:47616`).

## API

- `POST /api/rpc/<command>`: runs a command by its name in `src/lib/bindings.ts` (e.g. `list_tasks`) with
  its arguments as a JSON object with camelCase keys. A result is `200` with the JSON
  result; a command error is `{ "kind", "code", "message" }` with `422` (invalidInput),
  `404` (notFound), `409` (rejected), `502` (external), or `500` (internal). `code` is one
  of `CommandErrorCode` in `src/lib/bindings.ts`, e.g. `taskNotFound` or
  `dependencyCycle`, shared with the MCP tools. An unknown command is `404` with code
  `unknownCommand` and malformed arguments `400` with code `invalidArguments`. A command
  that panics is `500` with code `commandPanicked`; the panic text goes only to the
  server log.
- `GET /api/events`: server-sent events `tasks-changed`, `workspaces-changed`,
  `guidelines-changed`, `task-status-changed`, and `task-ready` with the payloads of the
  events in `src/lib/bindings.ts` (see [Task Events for Other
  Clients](#task-events-for-other-clients)). Every event has an id `<epoch>-<sequence>`; `epoch`
  changes with each server start. A request without `Last-Event-ID` starts with a
  `ready` event carrying the current id. With `Last-Event-ID`, the stream first replays
  the events after it (the server keeps the last 256); when some are gone, the id is of
  another server start, or a reader falls behind, the stream sends a `resync` event
  instead, after which the client refetches everything.
- `GET /api/backups/export`: a consistent snapshot of the database, as an
  `application/vnd.sqlite3` attachment named `toodo-backup-<date>.sqlite3`.
- `GET /api/backups/{name}`: the backup named `name` from the backup directory, by the
  file name `list_backups` reports; `404` for any other name.
- `POST /api/backups/restore`: replaces all data with the Toodo database sent as the
  request body (`application/octet-stream`, at most 256 MB, else `413`). The current data
  is saved as a pre-restore backup first, which is the JSON result, like `restore_backup`.
  A file that is not a Toodo database is `422` and changes nothing.
- `GET /api/devices`: every device as `{ id, label, createdAt, lastSeenAt, revokedAt,
  current }` (Unix seconds; `current` marks the device whose token the request bears),
  active ones first.
- `POST /api/devices` with `{ "label": string }`: registers a device and returns `201`
  with `{ device, token }`. Only the shared web token may register (else `403`); a blank
  name or one over 80 characters is `422`.
- `POST /api/devices/{id}/revoke`: revokes the device for good and returns it; `404` for
  an unknown id. Revoking it again keeps the first revocation time.
- `GET /api/push`, `PUT /api/push/settings`, and `POST /api/push/test`: the notification
  state, settings, and test notification of the device (see [Notifications](#notifications)).

Reports are downloaded in the browser, and backups go over the endpoints above and the
`restore_backup { name }` command.

All of them require `Authorization: Bearer <token>` with the shared web
token or the token of a device that is not revoked; `/mcp` requires the MCP token. The
generated bindings in `src/lib/bindings.ts` call the API through `src/web/core.ts` and
`src/web/event.ts`; a test checks that the server routes every command they invoke.
