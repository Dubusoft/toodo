# Linux Server

`toodo-server` is Toodo: it runs headless on a Linux machine, next to the herdr server
there if it has one, for one user, and is used from a browser. It serves:

- the commands of the app as an HTTP API with a server-sent event stream (see [API](#api)),
- the frontend, an installable web app (PWA) that uses them (see [Web App](#web-app)),
- the MCP server for coding agents on the machine (`http://127.0.0.1:47616/mcp`),
- the background work: herdr event subscriptions, pull request checks, automatic backups,
  and MCP reverse tunnels to SSH machines,

and keeps its data in SQLite in the server's data directory. Everything is served on one
port, `127.0.0.1:47616` by default.

Data of the Windows desktop app that earlier releases shipped can be moved into a server
with `toodo-server import`; see [migrate-desktop-data.md](migrate-desktop-data.md).

## Machines and Paths

The "Local" machine is the server: local workspaces and the local worktree root use POSIX
paths on it, and the local herdr is the herdr server running there. Workspaces can also
live on saved herdr SSH machines. `herdr machine add <host>` asks questions in a terminal,
so run it on the server yourself.

### Windows Hosts

An SSH machine can be a Windows PC running the OpenSSH server, with Git for Windows on
`PATH` and herdr. Toodo tells a Windows host by its paths: a workspace path or worktree
root on it is a drive path (`D:\dev\repo`) or a UNC path (`\\nas\share\repo`), and the
workspace and the worktree root of one machine must be the same kind of path. Commands go
to such a host as `powershell -EncodedCommand <script>`, which works whether its SSH
server hands commands to `cmd.exe` or to PowerShell: the script starts git (or `cmd.exe`
for a `command` criterion) with a Windows command line built by Toodo, so no shell parses
the arguments, and passes its output and exit code back unchanged.

herdr on Windows serves its API on a named pipe, which `ssh -W` cannot forward, so a
Windows host gets no herdr event subscription. Toodo checks that herdr
runs there with a PowerShell script (it looks for `herdr.exe` on `PATH`, then under
`%HERDR_HOME%` or `%USERPROFILE%\.herdr`, where herdr's installer puts it) and reads
the agent statuses from `herdr --machine <id> pane list` every 5 seconds instead. Without
events, Toodo does not notice a worktree removed or opened again in herdr on that PC.

A workspace kept with a Windows path from the desktop app (`pathProblem: "foreign"`) can
be moved to the PC it lives on: save the PC as a herdr machine, then use **Move** in the
workspace header, pick the machine, and enter the same repository path. Toodo checks that
the path holds a git repository and opens it in herdr; the tasks stay with the workspace.
A move cannot change the kind of path while a task has a worktree of the other kind.

## Versions and Releases

Every GitHub release `vX.Y.Z` carries
`toodo-server-vX.Y.Z-linux-x86_64.tar.gz` (the `toodo-server` binary for x86_64 Linux and,
under `web/`, the web app) with its `.sha256`, built from the same commit. `toodo-server --version` prints the
version, so an installed server compares directly with a release, and the commit it was built from (`toodo-server 0.12.0 (commit
1c78b7a1a2b3)`), so a build of a later commit is told apart from the release it reports.
The server prints the same line when it starts. See "Releases and Updates" in the README for how a release is made.

### npm Packages

The same version is published to npm as `@dubusoft/toodo` (the `toodo` launcher) with
one platform package per target, `@dubusoft/toodo-linux-x64` and
`@dubusoft/toodo-linux-arm64`, each carrying `toodo`, `toodo-server`, and the web app.
The `npm` workflow (`.github/workflows/npm.yml`) publishes them:

- On every push to `dev`, a prerelease `X.Y.Z-dev.N` (the next patch version of
  `package.json`, `N` the run number) under the dist-tag `dev`.
- In a run on `main` with dist-tag `latest`, the release version under the dist-tag
  `latest`, skipped when that version is on npm already. The `Release` workflow starts
  this run; a failed or skipped publish is retried by running the `npm` workflow by hand
  on `main` with dist-tag `latest`.

It publishes with the `NPM_TOKEN` secret when that is set, else through npm trusted
publishing (OIDC). With neither set up it skips publishing with a notice instead of
failing. Packages are staged with `scripts/package-npm.mjs`.

## Install with npm

On Linux x64 or arm64 with glibc (Node.js 18 or later), as the user who runs herdr (if any):

```sh
npx @dubusoft/toodo init
```

`init` creates the data directory with its database and access tokens, saves the listen
address in `cli.json` there, and starts `toodo-server` in the background. It prints the web
app URL and the file that holds the web access token (`cat` it to sign in), and the MCP
URL with its token file. Where `claude` is on `PATH` it registers the MCP endpoint with
`claude mcp add`; where `codex` is on `PATH` it writes the endpoint to
`$CODEX_HOME/config.toml` (else `~/.codex/config.toml`). Running it again keeps the database
and tokens. herdr is not needed to start the server; only workspaces with runner `herdr` (and remote
SSH workspaces) need it. Runner `plain` runs `claude` or `codex` from the server's `PATH`,
and runner `none` needs neither.

- `--port N`: port to listen on, keeping the saved host (default `47616`).
- `--listen HOST:PORT`: address to listen on (default `127.0.0.1:47616`).
- `--data-dir DIR`: data directory (default `$TOODO_DATA_DIR`, else the directory `init`
  recorded, else `$XDG_DATA_HOME/toodo-server` or `~/.local/share/toodo-server`). `init`
  records the absolute path in `$XDG_CONFIG_HOME/toodo/data-dir` (`~/.config/toodo/data-dir`),
  so the other commands find it without the option; they take `--data-dir` too, and the
  option beats `$TOODO_DATA_DIR`, which beats the record.
- `--no-mcp`: register the MCP endpoint with no agent.

To have the `toodo` command at hand, install it globally:

```sh
npm i -g @dubusoft/toodo
```

- `toodo start`, `toodo stop`: start or stop the server, through systemd once the service
  is installed, else as a background process with `server.pid` and `server.log` in the
  data directory.
- `toodo status`: whether the server runs and where its files are; exits `0` when it runs
  and `3` when it is stopped.
- `toodo service install`: run the server as the systemd user service
  `toodo-server.service`, in the same layout as `scripts/install-server.sh`
  (`~/.local/bin/toodo-server`, the web app in `~/.local/share/toodo-server-web`, see
  [systemd](#systemd)). It enables and restarts the service and notes when lingering is
  off.
- `toodo update [--channel dev|latest] [--allow-downgrade]`: update a global install and
  restart the server on it, see below.
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
   by `toodo start` is stopped and started again; on macOS a launchd job `toodo-server`
   (`~/Library/LaunchAgents/toodo-server.plist`) is restarted with `launchctl kickstart -k`.
   A server that is not running is left stopped; for the systemd service the new server and
   web app are still copied, so the next `toodo start` runs the new version.
4. Checks that the server answers (`POST /api/rpc/list_tasks` without a token is `401`).
5. Prints the old and new version and the result.

When npm fails, nothing is restarted and the running server keeps its version. When the
server does not answer after the restart, `toodo update` exits `1` with the cause and the
commands to find out why, restart it, or go back to the previous version.

Without `toodo update`, run `npm i -g @dubusoft/toodo` again, then `toodo service install`
or `toodo stop` and `toodo start`.

## Install and Update

On a server, install and update from releases. As the user who runs herdr, if any (git, gh
logged in, ssh, and curl installed; herdr only for runner `herdr`; no Rust toolchain needed):

```sh
scripts/install-server.sh --release latest
```

The script needs no checkout in this mode; fetch it alone with
`gh api repos/dev-bokdong/toodo/contents/scripts/install-server.sh --jq .content | base64 -d`
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

The binary is `src-tauri/target/release/toodo-server`. It needs `git`, `ssh`, and `gh` on
`PATH` at runtime, plus `herdr` for runner `herdr` and `claude` or `codex` for runner `plain`.

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
| `TOODO_PUSH_SUBJECT` | `https://github.com/dev-bokdong/toodo` | Contact sent to push services with every notification, a `mailto:` or `https:` URL (see [Notifications](#notifications)) |

On first start the data directory gets two access tokens:

- `mcp-token`: agents send it to `/mcp` as `Authorization: Bearer <token>`.
- `web-token`: the shared web token. A browser signs in with it once and is registered
  as a device with a token of its own (see [Devices](#devices)); `/api` accepts the
  shared token too, so existing clients keep working.

The data directory is created readable by its owner only (`0700`) and the token files
`0600`; the server tightens an existing directory and token files on start. To replace a
token, delete its file and restart the server. Replacing `web-token` does not sign out
registered devices; revoke them one by one. The server logs every token file it creates,
and its start line names both token files and the server's instance id.

A request without a valid token gets `401` with `WWW-Authenticate: Bearer` and a
plain-text body that says why and what to do, never the token: no `Authorization`
header, a header that is not `Bearer <token>` (the scheme is case-insensitive), a token
the server does not accept, or the other surface's token (`web-token` at `/mcp`, the MCP
token at `/api`). At `/mcp` the body also names the server instance, which tells a reply
from another Toodo server, e.g. one an old config or a tunnel reached, apart from this one.

### Import

```sh
toodo-server import FILE
```

adds the data of another Toodo database, such as a Windows desktop app's (see
[migrate-desktop-data.md](migrate-desktop-data.md)), to the data in `TOODO_DATA_DIR`, then
exits. It imports workspaces, tasks (with dependencies, status history, commit records,
notes, related links, criteria, and pull request snapshots) in one
transaction, after writing a pre-restore backup into `<data>/backups/`. Devices, push
subscriptions, chat messages, and machine settings (worktree roots) are not imported, and
tasks lose their herdr workspace link. The file is checked and migrated to the latest
schema in memory first; a newer schema than the server's is refused, and the file itself
is never modified.

Imported IDs go after every ID the server has used: task #N becomes #(N + offset), and the
command prints the offset. Into an empty server, tasks keep their numbers. Stop the
service first (`systemctl --user stop toodo-server`) and start it again afterwards.

### Devices

Each device has its own access token, so a lost phone is revoked alone instead of
rotating the token of every client. The database keeps a device's name, when it was
registered and last seen (to within a minute), and when it was revoked, but only a
SHA-256 hash of its token; the token itself is shown to the device once, when it
registers. Revoking is final: the token never works again, and the device signs in anew
with the shared token. Only the shared token registers devices, so a device token cannot
mint more tokens. A device keeps its id after it is revoked, so data kept per device can
refer to it.

The web app lists the devices under **Devices** in Settings, marks the current one,
and revokes them. Devices live in the database, so restoring a backup also restores the
devices of that backup: devices registered after it sign in again.

**Treat `web-token` like a password to the server account.** It opens every command of
the app, including ones that write `~/.ssh/config` (which can run commands through
`ProxyCommand`), list the server's directories, and download or replace the whole
database. Whoever holds it can run code as that user. `mcp-token` gives the MCP
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
| Agent finished or needs input | An agent of a task stopped working, or started waiting for input |
| Pull request checks and reviews | CI of a task's pull request passed or failed; a reviewer approved it or requested changes |
| Task awaiting completion | A task moved to awaiting completion |

Notifications report what changed on its own: agents, pull requests, and the server's
background checks. A change made in the app itself sends none. Opening a notification
opens its task. While notifications are on, the app shows no
notifications of its own on that device, so nothing arrives twice.

Subscriptions belong to devices: a browser signed in with the shared `web-token` signs
in again to get a device token first. Revoking a device ends its subscription, and a
subscription the push service reports gone is dropped.

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

Agents on the server's SSH machines reach the same URL through the reverse tunnels the
server keeps open to them.

Settings > Agent access in the web app copies this config or the MCP token alone
("Copy MCP token for agents"; it is not the web sign-in token), checks with **Test
connection** that the server accepts the token it shows, and shows the server instance
and the last request `/mcp` turned away (local and tunneled agents alike), with its
reason and how many it turned away since the server started. The MCP `initialize` reply
names the instance in `serverInfo.title`.

### Agent MCP Tools

Besides the regular task tools, two arguments help an agent wire and start a plan:

- **Create.** `create_task` takes `depends_on` and `related`, so a plan is wired in one
  call; an unknown task in either rejects the call and creates nothing.
- **Start.** `start_task` takes `agent_command`, which Toodo runs in the shell pane of
  the task's new herdr workspace once the task is started (for the coding agent; only
  for workspaces on the server's machine). The command runs after
  `export TOODO_MCP_URL=<url>; export TOODO_MCP_TOKEN="$(cat <data dir>/mcp-token)"`, so
  the agent can reach the MCP server without the token being typed into the pane; a
  client that expands environment variables in its config can use
  `"Authorization": "Bearer ${TOODO_MCP_TOKEN}"`. The reply is the task with `panes`, `ranIn`
  (the pane the command ran in), and `paneError` when the panes could not be listed or
  the command did not run; the task is started either way.

`read_toodo_skill` returns the worker skill (`src-tauri/src/mcp/toodo-skill.md`). Toodo has
no merge tool: agents follow the workspace's agent merge policy, which never allows merging
past the base branch.

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
  `get_task`.
- `toodo.write`: the read tools, plus `create_workspace`, `create_task`, `update_task`,
  `add_dependency`, `remove_dependency`, `add_related`, `remove_related`,
  `add_criterion`, `remove_criterion`, `check_criterion`, `add_progress_note`,
  `report_blocker`, and `pause_task`.

None of these runs git, herdr, gh, or ssh. `create_workspace` accepts only
`source: "none"` from an app; git workspaces are added in the Toodo app or by a local
agent. The tools that run things stay local: `current_task`, `start_task`, `resume_task`,
`restore_worktree`, `set_worktree_root`, `list_machine_settings`, `complete_task`, and
`conclude_task` never appear in an app's tool list, and calling one is refused even with
`toodo.write`. `check_criterion` checks a stored manual criterion and never runs a
criterion's command; `pause_task` keeps the worktree and herdr workspace. An app's
`initialize` reply and `read_toodo_skill` carry planning instructions for a chat, not the
worktree and pull request workflow.

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

Run it as the user who runs herdr, if any, so it finds herdr's socket, `~/.ssh/config`, and the
`gh` login. `scripts/install-server.sh` writes
`~/.config/systemd/user/toodo-server.service` like this, with `PATH` taken from where it
found `herdr` (when installed), `gh`, `git`, and `ssh` (and `TOODO_WEB_DIR` added when it installs the web
app):

```ini
[Unit]
Description=Toodo server
After=network.target herdr-server.service
Wants=herdr-server.service

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

`herdr-server.service` is the unit of a headless herdr server, if there is one; without it
the `Wants=` is ignored. To set the service up by hand, run
`systemctl --user enable --now toodo-server`. Either way, run
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

When the server does not answer (it is down, the device is offline, or a proxy in front of
it answers with its own 502-504 or 520-530 error page), the app shows an offline screen
over itself instead of a broken page, and the service worker starts the cached app instead
of showing such an error page. The app checks again after 2 s, doubling up to 30 s, at
once when the device comes back online or the app is shown again, and on *Try again*;
once the server answers, the screen goes away and everything is loaded again.

On the server, "Local" is the server itself, so the web app browses the server's
directories (from the server user's home) when you pick a folder for a workspace. Reports
are downloaded in the browser, and database backups are downloaded and uploaded (see
[API](#api)). Reach the loopback port through an SSH tunnel
(`ssh -L 47616:127.0.0.1:47616 <server>`, then `http://127.0.0.1:47616`); anything that
puts it on a network needs its own authentication in front, since the web token opens the
whole server account. To open it from a phone, see
[Off the Machine](#off-the-machine-cloudflare-tunnel-and-access).

The event stream (`/api/events`) is a long-lived server-sent event response with a
keep-alive comment every 15 seconds; a proxy in front must not buffer it. When the stream
drops, the web app reconnects and refetches everything. The pane view's WebSocket
(`/api/panes/stream`) needs the proxy to pass WebSocket upgrades through, with the
browser's `Host` (or `X-Forwarded-Host`), since the server only accepts upgrades whose
`Origin` matches it.

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
- Agents keep using `/mcp` on loopback (or through the server's reverse SSH tunnels)
  with `mcp-token`; don't point them at the public hostname. Only chat apps signed in with
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

`npm run dev` starts the Vite dev server and forwards `/api` (WebSocket upgrades too) and
`/mcp` to a running `toodo-server` (`TOODO_SERVER`, default
`http://127.0.0.1:47616`).

## API

- `POST /api/rpc/<command>`: runs a command by its name in `src/lib/bindings.ts` (e.g. `list_tasks`) with
  its arguments as a JSON object with camelCase keys. A result is `200` with the JSON
  result; a command error is `{ "kind", "message" }` with `422` (invalidInput), `404`
  (notFound), `409` (rejected), `502` (external), or `500` (internal). An unknown command
  is `404` and malformed arguments `400`, both with a text body.
- `GET /api/events`: server-sent events `tasks-changed`, `workspaces-changed`,
  `agent-statuses-changed`, and `pull-request-statuses-changed` with the payloads of the
  events in `src/lib/bindings.ts`.
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
- `POST /api/stream-tickets` with `{ "taskId", "paneId" }`: a ticket for the pane view of
  a pane in the task's herdr workspace, `{ "ticket", "expiresAt" }` (Unix seconds). A pane
  outside that workspace is `404`. The ticket opens one stream within 30 seconds.
- `GET /api/panes/stream?ticket=<ticket>`: the WebSocket of the pane view, authorized by
  the ticket instead of the token; `401` for an unknown, used, or expired ticket and `403`
  for an `Origin` other than the server's own. The server sends
  `{ "type": "frame", "seq", "cols", "rows", "ansi" }` whenever the pane's screen
  changes, and `{ "type": "closed", "reason" }` before it closes. The view is read-only
  until the client sends `{ "type": "control", "on": true }` (answered with the same);
  then `{ "type": "text", "text" }` and `{ "type": "keys", "keys": [...] }` reach the
  pane. Messages are at most 64 KB. The server logs one line per control session.

`list_directories { machine, path }` lists directories on the server for
`{ "kind": "local" }` and on an SSH machine for `{ "kind": "ssh", "label": ... }`. Reports
are downloaded in the browser, and backups go over the endpoints above and the
`restore_backup { name }` command.

All of them except the pane stream require `Authorization: Bearer <token>` with the shared web
token or the token of a device that is not revoked; `/mcp` requires the MCP token. The
generated bindings in `src/lib/bindings.ts` call the API through `src/web/core.ts` and
`src/web/event.ts`; a test checks that the server routes every command they invoke.
