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

Releases are paused. The versions published so far carry the Rust `toodo-server`, which
this repository no longer contains; when distribution is prepared again, a Bun-compiled
binary of `server/` replaces it (see "Releases" in the README). The install sections below
describe those published versions; from a checkout, see [From a Checkout](#from-a-checkout).

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
The `npm` workflow published them, until it was removed with the Rust server:

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
  loads again at the next login or `toodo start`. On SIGTERM or Ctrl+C the server stops
  accepting connections and gives the requests in flight up to 5 seconds to finish;
  open event streams of the web app are cut after that and reconnect once it is back.
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
- `toodo update [--channel dev|latest] [--source npm|github] [--allow-downgrade |
  --check]`: update a global npm install, or a release install from GitHub releases (see
  [Update from GitHub Releases](#update-from-github-releases)), and restart the server on
  it, see below. With `--check` it only prints whether
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
  with `TOODO_VERSION` set to the version it publishes; other builds report the version of
  `package.json`.

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

### Update from GitHub Releases

`toodo update --source github` installs from the GitHub releases of the repository instead
of npm, so it needs neither Node.js nor the npm registry, and with a token it reads a
private repository. Every push to `dev` publishes the prerelease `vX.Y.Z-dev.N` (the same
version the npm `dev` channel gets), and every release `vX.Y.Z` carries the same assets:
`toodo-server-v<version>-<platform>.tar.gz` and its `.sha256` for `linux-x86_64`,
`linux-aarch64`, `linux-x86_64-musl`, `linux-aarch64-musl`, `darwin-x86_64`, and
`darwin-aarch64` (the npm workflow builds and uploads them, `scripts/package-server.sh`
packages them; only the newest 10 dev prereleases are kept).

- The repository is `$TOODO_RELEASE_REPO` (`owner/name`), else the one the install came
  from, else `Dubusoft/toodo`.
- The token is `$GH_TOKEN`, else `$GITHUB_TOKEN`; it needs read access to the contents of
  the repository, for example `GH_TOKEN=$(gh auth token) toodo update`. Without one only
  a public repository works.
- The channel works as for npm: `dev` takes the newest prerelease, `latest` the newest
  release, and a release without the asset of this platform (still uploading, or a
  platform it was not built for) is skipped.

It downloads the asset, checks its sha256 and that its `toodo-server` runs and reports the
version of the release, and installs it as a release install: `~/.local/lib/toodo` holds
`bin/toodo`, `bin/toodo-server`, the web app in `web/`, and `toodo-release.json` (the
repository it updates from), and `~/.local/bin/toodo` links to its `toodo`. The install it
replaces is kept beside it until the server answers on the new version. The server is
restarted as with npm (steps 3 and 4 above); when it does not answer, the previous files
are put back and the server is restarted on them.

Once `toodo` is a release install, a plain `toodo update` (and `toodo update --check`)
uses GitHub releases. To move an npm install over, run it once with the source:

```sh
GH_TOKEN=$(gh auth token) toodo update --source github
toodo --version          # from ~/.local/bin/toodo, the release install
npm rm -g @dubusoft/toodo
```

This installs the newest version of the channel even when npm has the same one, and
restarts the server on it. Put `~/.local/bin` before npm's bin directory on `PATH` if
`toodo` still runs the npm copy. On a machine without `toodo`, download the asset of its
platform (`gh release download --repo Dubusoft/toodo --pattern
'toodo-server-*-darwin-aarch64.tar.gz'` for the newest release), unpack it, and run
`./toodo update --source github` from it, then `toodo init` or `toodo service install`.

The web app still looks for a newer version on the npm registry (Settings > General).

## Install and Update

Without Node.js, install and update from releases instead of npm. The script needs curl,
tar, and sha256sum; no Rust toolchain, gh, or GitHub login is needed. Releases carry a Linux
x86_64 (glibc) build only: on arm64, musl, or macOS, [install with npm](#install-with-npm)
instead, or [build from a checkout](#from-a-checkout).

```sh
scripts/install-server.sh --release latest
```

The script needs no checkout in this mode; fetch it alone with
`curl -fsSLO https://raw.githubusercontent.com/Dubusoft/toodo/main/scripts/install-server.sh`
if there is none, and run it with `bash install-server.sh --release latest`. It downloads
the server asset of the release and its checksum from GitHub with `curl`, checks its
sha256 and that the binary reports the release's version, installs it to
`~/.local/bin/toodo-server` and the web app to `~/.local/share/toodo-server-web`, writes the
systemd user service `toodo-server.service` (see [systemd](#systemd)), restarts it, and
checks that it answers (`/api` without a token is `401`, `/` is the web app), retrying for
up to 30 s. It prints where the tokens are, never the tokens. When the new version does
not come up (`toodo service install` fails or the check keeps failing), the script puts
back the server, web app, unit, and listen setting it replaced, restarts the service,
lists what it restored, and exits `1`; `journalctl --user -u toodo-server` shows why the
new version failed.

- `--release latest|vX.Y.Z|vX.Y.Z-dev.N`: the release to install; `latest` is the newest
  stable release, `vX.Y.Z` pins a version, and `vX.Y.Z-dev.N` installs a dev pre-release.
- `--listen ADDR`: listen address of the service (default `127.0.0.1:47616`).
- `--no-service`: install only; leave the service alone.

To update, run it again with the same options; the database and tokens in the data
directory are kept.

Releases before the server was published (0.9.3 and older) have no server asset; build
those from a checkout. Releases before the web app was published carry the binary only;
the script then serves the API and MCP only.

### From a Checkout

A checkout runs the TypeScript server with Bun (installed from https://bun.sh); there is
nothing to build for it, only the web app:

```sh
git pull
npm ci && npm run build
TOODO_WEB_DIR=dist-web bun server/src/main.ts
```

It takes the environment of [Run](#run), creates the database of a new data directory, and
migrates an existing one from the schema of the last Rust release. `install-server.sh`
installs published releases only. On the owner host the checkout runs as `toodo.service`
instead; see [host.md](host.md).

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
| `TOODO_CHAT_AGENT_NAME` | `Dori` | Name the chat shows for the agent connected over MCP (see [Chat](#chat)) |
| `TOODO_CHAT_AGENT_AVATAR` | none | Avatar of that agent: an `https:` URL, or a path on the server such as `/avatar.png` |

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
  and leaves the database unchanged; its error names the directory to fix. When the
  database itself is damaged, restore a backup by hand; see
  [Troubleshooting](troubleshooting.md#the-server-does-not-start-restore-a-backup-by-hand).

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
schema in memory first; a newer schema than the server's is refused, as is a file whose
live tasks have dependencies that loop, and the file itself is never modified.

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
ones it gets, and sends itself a test notification. The server applies the choices when
it sends, so a notification turned off is never pushed to that device. The settings
belong to the device, beside its subscription: devices sign in with the same shared
token, so a phone and a laptop each choose their own.

| Section | Setting | Notifications | New devices |
| --- | --- | --- | --- |
| Chat | Important messages | The agent posted a message that waits on you: one with choices to pick from, or one in a thread waiting for your answer; or a thread started waiting for your answer, such as a request without choices | On |
| Chat | All chat messages | The agent posted any message, important ones included | On |
| Tasks | Task started | A task moved to `in_progress` | Off |
| Tasks | Task awaiting completion | A task moved to `in_review`, so its work awaits review and completion | On |
| Tasks | Task finished | A task was completed or concluded (`done`) | Off |

Chat notifications come only from channels whose notifications are on, and opening one
opens the [chat](#chat) at that channel or thread; opening a task notification opens its
task. Task notifications come from changes agents make over MCP, not from your own changes
in the app. While notifications are on, the app shows no notifications of its own on that
device for what the server pushes, so nothing arrives twice.

Subscriptions belong to devices: a browser signed in with the shared `web-token` signs
in again to get a device token first. Revoking a device ends its subscription, a device
whose token expired gets no notifications, and a subscription the push service reports
gone is dropped.

Push services are on the public internet, so the server posts only there. A
subscription whose endpoint carries credentials or a fragment, or whose host is or
resolves to a loopback, private, link-local, or otherwise reserved address, is refused;
the same check runs before every notification, on the address the server connects to.
The server follows no redirects from a push service and ignores proxy settings in its
environment.

A notification the push service cannot take for a while (it cannot be reached, or it
answers 429 or 5xx) is tried again after 1, 2, and 4 seconds; while a device's push
service stays unreachable, its other notifications of the same change are skipped. Any
other refusal is not retried. Up to eight devices get their notifications at once, and a
device's notifications of one change get 30 seconds, retries included; a push service
that has not taken them by then counts as unreachable, so one slow push service holds up
neither the other devices nor the next change. Changes that arrive while notifications
are being sent are read together once those are done. The settings show the last notification that did not
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

The MCP server has 44 tools:

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
- Guidelines: `get_guidelines`, `add_guideline`, `update_guideline`, `remove_guideline`.
- Review: `review_report`.
- Chat (see [Chat](#chat)): `peek_pending`, `take_pending`, `ack_chat`, `reply_in_chat`,
  `mark_chat_handled`, `list_chat`, `search_chat`, `set_typing`, `list_channels`,
  `create_channel`, `list_threads`, `create_thread`, `update_thread`.

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

`read_toodo_skill` returns the worker skill (`server/src/mcp/toodo-skill.md`); rules it
shares with the `initialize` instructions come from `server/src/mcp/shared/` (see
[docs/agents.md](agents.md)).

### Chat

The web app has a chat with the agent connected over MCP: the round button at the bottom
right opens it, and shows how many of the agent's messages are unread in every channel and
in the threads of the tasks the chat lists.
A thread the agent marked as waiting on an answer (a decision or request) is louder than
an unread count: the button rings in amber with a flag and the number of such threads,
the thread's entry in the chat's list is tinted with a Decision mark, and the sidebar's
Needs attention lists it first, opening its thread in the chat. The chat never opens by
itself.
The chat's agent is Dori by default: the chat shows it under the name and avatar of
`TOODO_CHAT_AGENT_NAME` (default `Dori`) and `TOODO_CHAT_AGENT_AVATAR`. The server does not
run the agent itself; Dori, or any other agent with the `mcp-token`, takes the chat's
messages and answers them.

**Channels and threads.** The chat has channels, starting with `#general` (channel 1,
which holds the messages of versions before channels), and threads under each channel.
People add, rename, and delete channels in the web app, and the agent adds them too. The
default room can be renamed but not deleted; deleting another channel moves its threads to
the default room and keeps its own messages there in an archived thread named after it.
Threads are opened by the agent (Dori opens one per task it works on) and, for a listed
task without one, by opening the task in the chat; the web app has no form to start one.
A thread may follow a task, and the task's
details show its thread and its conversation. A task has one thread: opening a second one
for it, or linking it to another thread, is refused. The chat's list shows the channels,
channel 1 (the default room) first, then the tasks that need an answer (`in_review`, or a
question in their thread nobody answered) and the `in_progress` tasks a lane works on (a
`lane:` ref), each named by its task and with the latest message of its thread on one
line; other tasks' threads open from the task's details, and the Completed button beside In
progress lists the closed and archived threads and those of finished tasks, latest first,
opening each one's conversation. Each channel and thread keeps how far
people read it, so the app shows unread counts per channel and per thread; an archived
thread no longer counts. A channel counts its own messages and those of its threads that
follow no task, which opening it reaches; a task's thread counts on its own, so the
threads of tasks the list leaves out (finished ones, for example) do not keep the count up.
A channel's bell turns its notifications on or off for every device. A thread is `open`,
`closed` when its conversation is over, or `archived`, which
also leaves it out of its channel's list unless asked for; closed and archived threads
take no messages until reopened.

An agent works through the chat tools:

1. `take_pending` returns the people's messages it has not received yet and marks them
   received; `peek_pending` returns them without marking them.
2. `ack_chat` with their `ids` tells the people it read them.
3. `reply_in_chat` posts its answer; `handles` lists the messages it answers, which are
   marked handled by it. It posts in `channel_id` or `thread_id` when given, else where the
   first answered message is, else in channel 1. `mark_chat_handled` marks a message
   handled by an earlier reply (`reply_id`) or by a task made for it (`task_id`).
4. `set_typing` shows that it is writing in `channel_id` or `thread_id` (channel 1 without
   them), only there, for 30 seconds unless sent again; a reply there ends it.

Each message carries its `channelId` and `threadId`. `list_chat` lists the latest messages
with their receipts, of every place or only of `channel_id` (the channel itself) or
`thread_id`, and `before` pages back. `list_channels` lists the channels with `push` and
`unread`, and `create_channel` adds one. `create_thread` opens a thread under `channel_id`
(channel 1 when omitted), following `task_id` if given; `list_threads` lists threads by
`channel_id` or `task_id` with their `status`, `closedAt`, `archivedAt`, `lastMessage`, and
`awaitingAt` (`include_archived` adds archived ones); and `update_thread` changes a
thread's `title`, its task (`task_id`, or `unlink_task`), its `status`, or its waiting
state (`awaiting`). Set `awaiting: true` while the agent waits for an answer, such as a
decision or a request: the first waiting time is kept in `awaitingAt`, waiting threads
appear first, newest waiting time first, and the app lists the thread's task under Needs
answer. Set `awaiting: false` once it is answered.
**Actions.** `reply_in_chat` takes up to 10 `actions`, each `{ "key", "label", "style" }`
(`style` is `default`, `primary`, or `danger`), which the app shows as buttons under the
message: a question to decide, a request to approve, a thread to close, or any other
choice. A person may choose one; the message then takes no other choice. The choice
reaches the agent as a person's message in the same place, with the action's label as its
body and `choiceOf: { messageId, key }`, so `take_pending`, the receipts, and the overdue
note apply to it as to any message; the agent's message shows it in `chosen`
(`{ key, at, choiceId }`). `GET /api/events` also announces it as `chat-action-chosen`.
Toodo stores the choice only: what it means stays with the agent.

**Attachments.** People attach files in the app and the agent with
`POST /mcp/attachments?name=<file name>` (the file as the body, its `Content-Type`, and the
MCP token), each at most 25 MB. An upload returns `{ id, name, contentType, size }`, and a
message takes it by `id`: `attachments` of `reply_in_chat`, or of `send_chat_message` in the
app. A message with files may have an empty body, which then reads as the file names.
Each message lists its `attachments`; the agent reads one with `GET /mcp/attachments/{id}`
and the MCP token, and the app with `GET /api/chat/attachments/{id}`. An upload no message
takes within a day is dropped. The files are kept in `attachments/` of the data directory,
which backups of the database do not include.

**Search.** `search_chat` (and the search in the app's chat) finds earlier messages: every
word of `query` must appear in a message, ignoring case; `channel_id` keeps to a channel and
its threads, `thread_id` to a thread. Each hit carries the message, `channelName`, and
`threadTitle`, the best match first.

**Composer.** The app's composer is one row, as in other messengers: a **+** button that
attaches files, the input, and the send button. On a touch keyboard Enter starts a new
line and only the send button sends; with a physical keyboard Enter sends and Shift+Enter
starts a new line.

**Voice input.** Where the browser offers speech recognition (Chrome on desktop and
Android), the composer shows a microphone in the send button's place while there is
nothing to send, and keeps it while it listens: what the person says, recognized in the
browser's language, joins the draft, which they send like typed text. The browser
recognizes speech through its own service, so voice input needs a connection; the server
receives only the text.

**Unsent messages.** A message the app could not get to the server, because the server
was unreachable, waits in the browser under its client id, also across reloads, and goes
out when the server answers again. The server stores a message once per client id, so it
appears once however often it is sent. One the server refused shows why, with a retry.

Each person's message shows its receipt in the app: sent, then read once the agent
acknowledges it. One not handled within 10 minutes shows that it waits for an answer. A message the agent posts reaches the devices that turned on **Agent
messages in the chat** under [Notifications](#notifications). Chat apps connected over
OAuth do not get the chat tools.

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
for `web-token`. Approve, and the browser returns to the app. After 5 wrong tokens within
a minute from one address, on any consent request, the consent page answers that address
`429` with `Retry-After` until the minute since the first of them is over, even with the
right token; wait, then go back and approve again.

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

On the owner's host, Toodo and Dori run as the one service `toodo.service` from a checkout
instead; see [host.md](host.md). The rest of this section is the released Rust server.

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
(`scripts/install-server.sh --release ...`); from a checkout, build it with
`npm ci && npm run build` into `dist-web/` and point `TOODO_WEB_DIR` at it. The
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
drops, or sends nothing for 45 seconds (a connection a network change left half open), the
web app reconnects with the id of the last event it got and the server replays
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
  adopted keeps its dependents blocked, so it makes none ready. Correcting its outcome
  later (Set outcome to `completed`, or `conclude_task` with `shipped_with`) changes no
  status, so it sends only `task-ready` for each dependent it releases last, with `at`
  set to the time of the correction.

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
Access signs you in before any request reaches the server. By default the web app still
asks for `web-token`, so a stolen token alone is not enough from outside, and a signed-in
browser without the token gets nothing. With [Sign-in through
Access](#sign-in-through-access) set up, the server trusts the Access sign-in instead and
the web app needs no token.

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
  expired, reopening or reloading the app goes through the Access login again. An app that
  stays open (or comes back from the background) notices that Access redirects `/api` to its
  login, which a script cannot follow, and reloads itself into the Access login, which
  returns to the app. It does so once in five minutes at most, so a reload that brings no
  login cannot repeat; the banner's Reload button is left for that case. A plain outage
  never reloads: the app keeps showing what it loaded. The Access session duration of the
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

#### Sign-in through Access

When only you can pass the Access application, the web token adds a second sign-in
without adding much. Tell the server which Access application to trust, and `/api`
accepts the JWT Cloudflare attaches to every request it lets through
(`Cf-Access-Jwt-Assertion`) instead of a token:

- `TOODO_CF_ACCESS_TEAM_DOMAIN`: the team domain of your Zero Trust organization, e.g.
  `myteam.cloudflareaccess.com` (*Settings > Custom Pages* in Zero Trust shows it).
- `TOODO_CF_ACCESS_AUD`: the *Application Audience (AUD) Tag* of the Access application
  for `toodo.example.com` (its *Overview* tab).

Set both in the service (`Environment=` lines, see [systemd](#systemd)) and restart it; one
without the other stops the server from starting. The server then checks each JWT
itself: its RS256 signature against the team's keys at
`https://<team domain>/cdn-cgi/access/certs` (fetched when first needed, again after an
hour or when a JWT names an unknown key, at most every 30 seconds), the team domain as
issuer, the AUD tag among its audiences, and its `exp` and `nbf` times, allowing 60 seconds
of clock difference. A request with a valid JWT is signed in: as the device whose token it
bears, if it bears one that works, else with the access of the shared web token. A device
token that works keeps its own limits: a read-only device still gets `403` for a change,
whatever the JWT. A request without a valid JWT, such as one that reaches the loopback
port directly, goes through the token rules as before.

The web app asks the server (`GET /api/session`) whether Access signed it in before it
asks for a token, and skips the token form when it did. A browser that already has a
device token keeps using it, which notifications need: they belong to devices (see
[Notifications](#notifications)). Whatever the setting, the web app forgets its token only
when the server itself rejects it, not when a proxy in front of it, such as Access with an
expired session, answers `401`.

This covers `/api` and its event stream only. `/mcp` keeps its own token and the OAuth
sign-in of chat apps, and agents keep reaching it over loopback or an SSH tunnel.

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
  `guidelines-changed`, `task-status-changed`, `task-ready`, `chat-changed`,
  `chat-typing`, and `chat-action-chosen` with the payloads of the events in
  `src/lib/bindings.ts` (see [Task Events for Other
  Clients](#task-events-for-other-clients)). Every event has an id `<epoch>-<sequence>`; `epoch`
  changes with each server start. A request without `Last-Event-ID` starts with a
  `ready` event carrying the current id. With `Last-Event-ID`, the stream first replays
  the events after it (the server keeps the last 256); when some are gone, the id is of
  another server start, or a reader falls behind, the stream sends a `resync` event
  instead, after which the client refetches everything.
- `GET /api/supervisor/status`: the Dori status panel (Settings > Dori status), as
  server-sent `status` events carrying the supervisor's latest snapshot (the `/status`
  pages, the `/quota` text, and the working lanes with their recent screens, typed in
  `src/lib/supervisor-status.ts`), then each new one; before the supervisor's first
  snapshot the stream starts with `ready`. The server keeps only the latest snapshot, in
  memory. The supervisor pushes it with `PUT /mcp/supervisor-status` and asks how many
  panels are open with `GET /mcp/supervisor-status` (`{ "watchers": n }`): both take the
  MCP token from loopback only, even in public mode, and a push is refused with `400`
  when it is not a snapshot or `413` above 2 MB. Lane screens and the quota are read only
  while a panel is open.
- `GET /api/supervisor/schedules` and `POST /api/supervisor/schedules`: the scheduled jobs
  panel (Settings > Scheduled jobs), the supervisor's `dori schedule` jobs. `GET` answers
  `{ "ok": true, "jobs": [...], "timeZone": { "name", "label" } }`, each job with its
  description (`null` when it has none), schedule, next and last run, and last result, and Dori's `displayTimeZone`, in which the
  panel says schedules ("Every day at 4:00 AM (KST)", in Korean on a Korean browser) and picks them by repeat
  and time; a cron expression the pickers cannot show is listed and edited as it is. The list shows each job's description in place of
  its command (its kind when it has none); the command shows in its edit form. `POST` takes one change (`list`, `add`, `remove`, `run-now`, `pause`, `resume`,
  or `edit` of a job's cron expression or interval, its description (an empty one removes it), or both, typed in
  `src/lib/supervisor-schedules.ts`) and answers the same way with every job after it. The
  server keeps none of it: the host hands each request to the supervisor Worker, which
  edits its own `sources.json` and reads it again on its next pass, so a change takes
  effect without a restart. Resuming or editing a job counts its slots from that moment, so
  the ones it passed are not caught up. A change the supervisor refuses (an unknown job, a
  cron expression that never fires) is `400` with its `error`, a body that is no request
  `400`, and `503` when no supervisor runs beside the server (`toodo-server`, or the host
  in safe mode) or it does not answer within 10 seconds. A read-only device may list the
  jobs but not change them.
- `GET /api/backups/export`: a consistent snapshot of the database, as an
  `application/vnd.sqlite3` attachment named `toodo-backup-<date>.sqlite3`.
- `GET /api/backups/{name}`: the backup named `name` from the backup directory, by the
  file name `list_backups` reports; `404` for any other name.
- `POST /api/backups/restore`: replaces all data with the Toodo database sent as the
  request body (`application/octet-stream`, at most 256 MB, else `413`). The current data
  is saved as a pre-restore backup first, which is the JSON result, like `restore_backup`.
  A file that is not a Toodo database, or whose live tasks have dependencies that loop,
  is `422` and changes nothing. An upload that stops arriving for 30 seconds is `408`
  and changes nothing.
- `POST /api/chat/attachments?name=<file name>`: uploads a file for a person's chat
  message, the request body with its `Content-Type`, at most 25 MB (else `413`); `201` with
  the attachment. `GET /api/chat/attachments/{id}` sends the file back: PNG, JPEG, GIF, and
  WebP images inline, other files as downloads, all with `nosniff` and a sandboxing
  `Content-Security-Policy`. The agent's side is `/mcp/attachments` with the MCP token
  (see [Chat](#chat)).
- `GET /api/devices`: every device as `{ id, label, createdAt, lastSeenAt, revokedAt,
  current }` (Unix seconds; `current` marks the device whose token the request bears),
  active ones first.
- `POST /api/devices` with `{ "label": string }`: registers a device and returns `201`
  with `{ device, token }`. Only the shared web token may register (else `403`); a blank
  name or one over 80 characters is `422`.
- `POST /api/devices/{id}/revoke`: revokes the device for good and returns it; `404` for
  an unknown id. Revoking it again keeps the first revocation time.
- `GET /api/session`: `{ "via": "access" }` when Cloudflare Access signed the request in
  without a token that works (see [Sign-in through Access](#sign-in-through-access)), else
  `{ "via": "token" }`.
- `GET /api/push`, `PUT /api/push/settings`, and `POST /api/push/test`: the notification
  state, settings, and test notification of the device (see [Notifications](#notifications)).

Reports are downloaded in the browser, and backups go over the endpoints above and the
`restore_backup { name }` command.

All of them require `Authorization: Bearer <token>` with the shared web
token or the token of a device that is not revoked, or a valid Cloudflare Access JWT when
the server is configured for it; `/mcp` requires the MCP token. The
generated bindings in `src/lib/bindings.ts` call the API through `src/web/core.ts` and
`src/web/event.ts`; a test checks that the server routes every command they invoke.
