# Server/Client Split

> **Note:** The Windows desktop app was removed after this document was written. Toodo now
> has one client, the web app (PWA) served by `toodo-server`; see [server.md](server.md).
> This record is kept as it was.

Toodo is moving from "a desktop app that owns everything" to one **toodo-server** with
thin clients:

- **toodo-server** owns the SQLite database, git and worktree operations, herdr control,
  `gh`, SSH, the MCP server, the background threads, an HTTP API with realtime streams,
  authentication, and serving the web UI.
- **Clients** are the Tauri desktop app and a PWA. Both run the same React frontend and
  hold no domain state of their own. They keep only what belongs to the device they
  run on, such as notifications, opening links, the tray, self-update, and theme.

This document lists what the desktop app does locally today, decides where each piece
lives after the split, records what already goes through the server, sketches the
realtime streams for herdr panes and a Dori chat channel (a lead chat was built later and
then removed), and slices the follow-ups.
References are `path:line` at the time of writing (release 0.11.0).

## Summary

The split is mostly a change of **where the core runs**, not a rewrite of the API:

- Every Tauri command is already a plain function that takes `commands::State`
  (`src-tauri/src/commands/mod.rs:38`). The server routes **all of them** through
  `POST /api/rpc/<command>` (`src-tauri/src/server/rpc.rs:162`), and a test checks that
  every command the bindings invoke is routed.
- The web build already swaps the Tauri modules for HTTP stand-ins (`vite.config.ts:16`,
  `src/web/`). The generated bindings work unchanged over HTTP.
- What remains is: (1) the desktop shell still opens its own database and starts its own
  background threads, MCP server, and tunnels; (2) a few commands take **paths on the
  client machine** or act on the **client's desktop**, and their meaning changes once
  the core is remote; (3) streams the server does not have yet (herdr panes, chat).

So the plan is to keep `POST /api/rpc/<command>` as the single command surface and
leave the commands as they are. New HTTP endpoints are added only where moving data
across machines needs them: files, directory browsing, and streams.

## 1. What the Desktop App Does Locally

### 1.1 Process Setup (Tauri shell)

All in `src-tauri/src/desktop.rs`:

| Operation | Where | Kind |
| --- | --- | --- |
| Registers 49 commands and 5 events with tauri-specta | `src-tauri/src/desktop.rs:27` | Tauri commands |
| Exports `src/lib/bindings.ts` on debug runs | `src-tauri/src/desktop.rs:161` | filesystem (dev only) |
| Loads plugins dialog, updater, process, notification, opener | `src-tauri/src/desktop.rs:164` | Tauri plugins |
| Hides to tray on window close | `src-tauri/src/desktop.rs:175` | window |
| Tray menu: Show, Check for Updates, Quit | `src-tauri/src/desktop.rs:105` | window |
| Resolves `app_data_dir` | `src-tauri/src/desktop.rs:182` | filesystem |
| Opens `toodo.sqlite3` there | `src-tauri/src/desktop.rs:184` | **DB** |
| Loads backup settings from the data dir | `src-tauri/src/desktop.rs:186` | settings file |
| Creates git, gh, ssh, ssh-config, herdr adapters over `ProcessRunner` | `src-tauri/src/desktop.rs:187` | process spawning |
| Starts the herdr event thread | `src-tauri/src/desktop.rs:203` | herdr, background |
| Starts the automatic backup thread | `src-tauri/src/desktop.rs:204` | DB, filesystem, background |
| Starts the pull request check thread | `src-tauri/src/desktop.rs:205` | gh, git, DB, background |
| Opens the MCP server on `127.0.0.1:47615` with a token file | `src-tauri/src/desktop.rs:206` | MCP, filesystem |
| Starts `ssh -R` tunnels to SSH machines | `src-tauri/src/desktop.rs:218` | process spawning |
| Shuts tunnels down on exit | `src-tauri/src/desktop.rs:238` | process |

### 1.2 Adapters (external processes and files)

Every adapter runs on the machine that runs the core. In the desktop app that is the
Windows PC.

| Adapter | Where | What it runs |
| --- | --- | --- |
| `ProcessRunner` | `src-tauri/src/adapters/git.rs:61` | spawns `git`, `gh`, `ssh`, `herdr` |
| `run_in_terminal` | `src-tauri/src/adapters/git.rs:90` | opens a Windows console (`CREATE_NEW_CONSOLE`, `src-tauri/src/adapters/git.rs:105`) for an interactive command |
| herdr CLI | `src-tauri/src/adapters/herdr.rs:164` (status), `src-tauri/src/adapters/herdr.rs:190` (pane list), `src-tauri/src/adapters/herdr.rs:212` (worktree create), `src-tauri/src/adapters/herdr.rs:331` (workspace close), `src-tauri/src/adapters/herdr.rs:338` (workspace focus), `src-tauri/src/adapters/herdr.rs:346` (agent focus), `src-tauri/src/adapters/herdr.rs:367` (machine add) | herdr CLI, JSON envelopes |
| herdr socket events | `src-tauri/src/adapters/herdr_events.rs:111` (local socket or named pipe), `src-tauri/src/adapters/herdr_events.rs:154` (`ssh -W` to a remote socket), `src-tauri/src/adapters/herdr_events.rs:338` (`events.subscribe`) | herdr socket API |
| GitHub | `src-tauri/src/adapters/github.rs:341` onward (find, create, view, close, edit pull requests; issues) | `gh` |
| SSH config | `src-tauri/src/adapters/ssh.rs:52` (read hosts), `src-tauri/src/adapters/ssh.rs:57` (append a `Host` block) | `~/.ssh/config` |
| Remote directories | `src-tauri/src/adapters/ssh.rs:109` | `ssh <host> sh -c ...` |
| MCP tunnels | `src-tauri/src/adapters/ssh_tunnel.rs:39` | `ssh -N -R ...` |
| Orphan tunnel cleanup (Windows) | `src-tauri/src/adapters/windows_process.rs:94` (job object), `src-tauri/src/adapters/windows_process.rs:105` (process list), `src-tauri/src/adapters/windows_process.rs:179` (terminate) | Win32 |
| Backups | `src-tauri/src/storage/backup.rs:34` (export), `src-tauri/src/storage/backup.rs:48` (scheduled backup), `src-tauri/src/storage/backup.rs:62` (restore) | SQLite files |

### 1.3 Commands

Every command below runs **in the desktop process** today: DB access goes through the
`Mutex<Storage>` the shell opened, and git/herdr/gh/ssh are spawned on the PC. The
"Decision" column says where each command runs after the split. **Server** means it is
already served as `POST /api/rpc/<name>` with the same JSON arguments and result, and
clients call it there. Rows marked **changes** need a new endpoint or a different client
flow; section 2 explains them.

Payloads are the camelCase arguments of the generated bindings.

#### Workspaces and machines

| Command | Defined | Local work | Decision |
| --- | --- | --- | --- |
| `list_workspaces` | `src-tauri/src/commands/workspaces.rs:18` | DB | Server |
| `get_workspace` | `src-tauri/src/commands/workspaces.rs:24` | DB | Server |
| `create_workspace` | `src-tauri/src/commands/workspaces.rs:39` | git clone/rev-parse, herdr workspace, DB | Server; path picker **changes** (2.3) |
| `update_workspace` | `src-tauri/src/commands/workspaces.rs:160` | DB | Server |
| `list_workspace_branches` | `src-tauri/src/commands/workspaces.rs:174` | git fetch, for-each-ref | Server |
| `create_workspace_base_branch` | `src-tauri/src/commands/workspaces.rs:191` | git branch, push | Server |
| `delete_workspace` | `src-tauri/src/commands/workspaces.rs:255` | DB | Server |
| `get_machine_settings` | `src-tauri/src/commands/workspaces.rs:261` | DB (worktree root per machine) | Server |
| `save_machine_settings` | `src-tauri/src/commands/workspaces.rs:279` | DB | Server |
| `list_herdr_machines` | `src-tauri/src/commands/machines.rs:23` | `herdr machine list` | Server |
| `add_herdr_machine` | `src-tauri/src/commands/machines.rs:38` | console window running `herdr machine add` | **Changes** (2.4) |
| `list_ssh_hosts` | `src-tauri/src/commands/machines.rs:69` | reads `~/.ssh/config` | Server (the server's config) |
| `add_ssh_host` | `src-tauri/src/commands/machines.rs:76` | appends to `~/.ssh/config` | Server (the server's config) |
| `list_remote_directories` | `src-tauri/src/commands/machines.rs:90` | `ssh` directory listing | Server; generalized (2.3) |

#### Tasks

| Command | Defined | Local work | Decision |
| --- | --- | --- | --- |
| `list_tasks` | `src-tauri/src/commands/tasks.rs:15` | DB | Server |
| `get_task` | `src-tauri/src/commands/tasks.rs:21` | DB | Server |
| `create_task` | `src-tauri/src/commands/tasks.rs:31` | DB | Server |
| `update_task` | `src-tauri/src/commands/tasks.rs:38` | DB | Server |
| `pause_task` | `src-tauri/src/commands/tasks.rs:64` | DB | Server |
| `set_completion_note` | `src-tauri/src/commands/tasks.rs:86` | DB | Server |
| `delete_task` | `src-tauri/src/commands/tasks.rs:119` | herdr worktree remove, DB | Server |
| `add_dependency` | `src-tauri/src/commands/tasks.rs:133` | DB, herdr workspace close | Server |
| `remove_dependency` | `src-tauri/src/commands/tasks.rs:145` | DB | Server |
| `list_commit_records` | `src-tauri/src/commands/tasks.rs:155` | DB | Server |

#### herdr, pull requests, issues

| Command | Defined | Local work | Decision |
| --- | --- | --- | --- |
| `herdr_status` | `src-tauri/src/commands/herdr.rs:21` | `herdr status` | Server |
| `start_task` | `src-tauri/src/commands/herdr.rs:33` | git fetch/branch, herdr worktree create, DB | Server |
| `open_task_in_herdr` | `src-tauri/src/commands/herdr.rs:44` | herdr worktree open, workspace focus | Server; meaning **changes** (2.5) |
| `focus_agent_pane` | `src-tauri/src/commands/herdr.rs:57` | herdr pane list, agent focus | Server; meaning **changes** (2.5) |
| `close_task_workspace` | `src-tauri/src/commands/herdr.rs:70` | herdr workspace close, DB | Server |
| `restore_task_worktree` | `src-tauri/src/commands/herdr.rs:83` | git, herdr worktree create, DB | Server |
| `refresh_commit_records` | `src-tauri/src/commands/completion.rs:48` | git log, DB | Server |
| `open_pull_request` | `src-tauri/src/commands/completion.rs:63` | git push, `gh pr`, DB | Server |
| `complete_task` | `src-tauri/src/commands/completion.rs:77` | `gh pr view`, herdr close, DB | Server |
| `conclude_task` | `src-tauri/src/commands/completion.rs:94` | git log, `gh pr close`, herdr close, DB | Server |
| `list_pull_request_statuses` | `src-tauri/src/commands/completion.rs:763` | in-memory state of the PR thread | Server |
| `branch_freshness` | `src-tauri/src/commands/freshness.rs:20` | git fetch, rev-list, `gh pr view` | Server |
| `link_issue` | `src-tauri/src/commands/issues.rs:24` | `gh issue view`, DB | Server |
| `create_issue` | `src-tauri/src/commands/issues.rs:39` | `gh issue create`, DB | Server |
| `list_agent_statuses` | `src-tauri/src/commands/events.rs:76` | in-memory state of the event thread | Server |

#### App, MCP, review, backups

| Command | Defined | Local work | Decision |
| --- | --- | --- | --- |
| `app_info` | `src-tauri/src/commands/mod.rs:237` | build constants | Server (server version); client keeps its own version (2.6) |
| `mcp_server_info` | `src-tauri/src/commands/mcp.rs:32` | MCP URL and token of this process | Server |
| `list_mcp_tunnels` | `src-tauri/src/commands/mcp.rs:70` | tunnel state of this process | Server |
| `review_period` | `src-tauri/src/commands/review.rs:17` | DB | Server |
| `save_report` | `src-tauri/src/commands/review.rs:29` | writes a file at a client path | **Client** (2.2) |
| `get_backup_settings` | `src-tauri/src/commands/backup.rs:92` | settings file | Server |
| `save_backup_settings` | `src-tauri/src/commands/backup.rs:100` | settings file | Server |
| `list_backups` | `src-tauri/src/commands/backup.rs:116` | lists backup dir | Server |
| `export_database` | `src-tauri/src/commands/backup.rs:123` | copies the DB to a client path | **Changes** (2.2) |
| `restore_database` | `src-tauri/src/commands/backup.rs:131` | restores from a client path | **Changes** (2.2) |

### 1.4 Frontend Calls Into the Tauri Runtime

These run in the WebView. The web build replaces each one with a browser stand-in in
`src/web/`.

| Call | Where | Web stand-in today |
| --- | --- | --- |
| Command invoke (all commands) | generated `src/lib/bindings.ts`, unwrapped in `src/lib/queries.ts:37` | `src/web/core.ts:23` posts to `/api/rpc/<command>` |
| Event listen (5 events) | `src/lib/queries.ts:325` | `src/web/event.ts:120` reads `GET /api/events` |
| Folder picker for a local workspace path | `src/components/workspace-list.tsx:423` | `window.prompt` for a server path (`src/web/dialog.ts`) |
| Save dialog for review reports | `src/components/review.tsx:113` | browser download (`src/components/review.tsx:105`) |
| Save and open dialogs for DB export/restore | `src/components/backup-panel.tsx:47`, `src/components/backup-panel.tsx:63` | `window.prompt` for a server path |
| Open external links | `src/components/markdown.tsx:16` | `window.open` |
| Desktop notifications | `src/lib/agent-alerts.ts:117` | browser `Notification` |
| Update check and relaunch | `src/components/update-banner.tsx:17`, `src/components/update-banner.tsx:50` | no update, `location.reload` |
| Tray update request | `src/components/update-banner.tsx:99` | never fires |
| Theme preference | `src/lib/theme.ts:16` (localStorage) | same |
| Server token | n/a | `src/web/session.ts` (localStorage) |

### 1.5 Settings and Local State

| Setting | Stored | Decision |
| --- | --- | --- |
| Workspaces, tasks, history, notes, machine worktree roots | SQLite in `app_data_dir` | Server DB |
| Backup schedule and retention | JSON next to the DB (`src-tauri/src/commands/backup.rs:35`) | Server data dir |
| MCP token | `mcp-token` in the data dir (`src-tauri/src/mcp/mod.rs:216`) | Server data dir (already) |
| SSH hosts | `~/.ssh/config` of the machine running the core | Server user's config |
| herdr saved machines | herdr on the machine running the core | Server's herdr |
| `gh` login | the machine running the core | Server user's login |
| Theme | client localStorage | Client |
| Server URL and access token | web build: localStorage; desktop: none yet | Client (new for desktop, 2.6) |

## 2. Where Each Piece Goes

### 2.1 Default: Server, Over the Existing RPC

Every command in 1.3 not marked **changes** or **client** stays exactly as it is and
is called over `POST /api/rpc/<name>`. This needs no server change, because the server
routes all of them already. The desktop client stops opening a database, stops
creating adapters, and stops starting threads. Everything in 1.1 from
`src-tauri/src/desktop.rs:182` to `src-tauri/src/desktop.rs:238` moves out of the
client, and the server already does the same in `src-tauri/src/server/mod.rs:231`.

Keeping one RPC route instead of designing REST resources is deliberate. The bindings,
error kinds (`{kind, message}` mapped to 422/404/409/502/500), and the
"every command is routed" test stay the single contract for both clients. Nothing is
duplicated.

The background threads (herdr events, PR checks, backups, MCP tunnels) are server-only.
The client never runs them. Windows-only process code
(`src-tauri/src/adapters/windows_process.rs`, the Windows console path of
`run_in_terminal`) becomes unused once the desktop app no longer spawns `ssh -R`. Keep it
only while the standalone desktop mode exists (see Open Decisions).

### 2.2 Files That Cross the Client/Server Boundary

Three commands take an absolute path on the machine running the core. With a remote
server, that path is on the wrong machine.

| Command | After the split |
| --- | --- |
| `save_report` | **Client only.** The report text is already built in the frontend (`src/components/review.tsx:105`). The web build downloads it. The desktop client writes it with a native save dialog through a client-local Tauri command (or `tauri-plugin-fs`). The server should drop `save_report` from its RPC table, since a server-path write is a needless capability behind the web token. |
| `export_database` | `GET /api/backups/export` streams a consistent snapshot (`Storage::export_to` into a temp file, then the bytes) as `application/vnd.sqlite3` with `Content-Disposition: attachment; filename="toodo-<date>.sqlite3"`. The client saves it: browser download, or a native save dialog in the desktop app. |
| `restore_database` | `POST /api/backups/restore` with the SQLite file as the `application/octet-stream` body (size-capped, for example 256 MB). The server stages it into its backup dir, validates it like `stage_backup` does today, and restores. The result is the same `BackupEntry`. Restoring a server-side backup by name stays an RPC: `restore_backup { name }` instead of a path. |
| `list_backups` | Unchanged, plus `GET /api/backups/{name}` to download one. |

The path-based `export_database`/`restore_database` RPCs should then be removed from the
server's table, for the same reason as `save_report`.

### 2.3 Choosing Directories on the Server

The desktop app picks a local workspace folder with the native dialog
(`src/components/workspace-list.tsx:423`), and remote folders with
`list_remote_directories` over ssh (`src/components/remote-folder-browser.tsx:25`). With
a remote server, "Local" means the server, and a native dialog would browse the wrong
disk.

- Add RPC `list_directories { machine: Machine, path: string | null }` with the same
  result as `list_remote_directories`. For `local`, it lists the server's filesystem
  (directories only, starting at `$HOME`). For `ssh`, it does what
  `list_remote_directories` does today.
- The folder browser then serves both machines, and the native dialog and the
  `window.prompt` stand-in go away. `list_remote_directories` can stay as an alias
  until the frontend switches.

### 2.4 `add_herdr_machine`

On the desktop app, it opens a console window (`src-tauri/src/adapters/git.rs:90`),
because `herdr machine add` asks questions. The server rejects it today
(`src-tauri/src/server/rpc.rs:189`). After the split it stays **rejected over RPC**.
Once the pane stream (section 4) exists, the server can run `herdr machine add <host>`
in a new herdr pane and hand that pane to the client's terminal view. Until then the UI
shows the command to run on the server.

### 2.5 Focus Commands

`open_task_in_herdr` and `focus_agent_pane` focus a workspace or pane in the herdr UI of
the machine running the core. With a remote server, they move the focus of whatever herdr
client is attached on the server, which is useful only if the user is attached there,
for example over `herdr --remote`.

- Keep both as server RPCs, since they still help an attached herdr client.
- After 252, the primary "go to the agent" action in a client is the in-app pane view
  (section 4). The buttons call `focus_agent_pane` only as a secondary action.
- `open_task_in_herdr` also reopens a missing herdr workspace. Split that out as
  `ensure_task_workspace { id }` so the pane view can call it without stealing focus.

### 2.6 Staying in the Client

| Piece | Why it stays |
| --- | --- |
| Notifications (`src/lib/agent-alerts.ts:117`) | They are per device. The diff runs on the client against the event stream, so each client decides itself whether it is focused. A PWA can also subscribe to Web Push (263): the server then sends the notifications itself, also while the app is closed, and the client stays silent (`docs/server.md`, Notifications). |
| Opening links (`src/components/markdown.tsx:16`) | Opens the client's browser. |
| Tray, close-to-tray (`src-tauri/src/desktop.rs:105`, `src-tauri/src/desktop.rs:175`) | Desktop shell only. |
| App updater (`src/components/update-banner.tsx:17`) | Updates the desktop shell. The server updates through `scripts/install-server.sh`. The client compares its own version with `app_info` from the server, and on a major or minor mismatch it shows "server is vX, app is vY" instead of failing on missing commands. |
| Theme (`src/lib/theme.ts:16`) | Per device. |
| Server URL and token | Per device. The PWA keeps the token in localStorage as today (`src/web/session.ts`). The desktop app stores the URL in its config and the token in the Windows credential store, and shows the existing token gate (`src/components/server-access.tsx:26`) on first run. |

The desktop client becomes the web build loaded in the Tauri WebView with a configurable
base URL. Its `src/web/*` stand-ins resolve against that URL instead of the page origin.
Its native plugins stay for the rows above only.

## 3. What Already Goes Through the Server

So nothing is built twice:

- **All 49 commands** over `POST /api/rpc/<command>`, `src-tauri/src/server/rpc.rs:86`
  and the table at `src-tauri/src/server/rpc.rs:162`. The exception is
  `add_herdr_machine`, which is rejected on purpose.
- **Events** over `GET /api/events` (`src-tauri/src/server/mod.rs:340`): `tasks-changed`,
  `workspaces-changed`, `agent-statuses-changed`, and `pull-request-statuses-changed`
  from the server's `Notifier`. A subscriber that falls behind more than
  `EVENT_BUFFER` (`src-tauri/src/server/mod.rs:63`) events has its stream ended
  (`src-tauri/src/server/mod.rs:348`), and the client reconnects and refetches
  everything.
- **Auth**: one bearer `web-token` for `/api` and one `mcp-token` for `/mcp`, both files
  `0600` in a `0700` data dir (`src-tauri/src/server/mod.rs:297`), checked by
  `require_token` (`src-tauri/src/mcp/mod.rs:265`).
- **MCP** on the same port, with every tool.
- **Background work**: herdr events, PR checks, backups, MCP tunnels, all started in
  `src-tauri/src/server/mod.rs:231`.
- **Web UI**: served from `TOODO_WEB_DIR` with an `index.html` fallback
  (`src-tauri/src/server/mod.rs:335`). Releases do not carry the web build yet
  (`docs/server.md`).
- **Frontend transport**: `src/web/core.ts`, `src/web/event.ts` (fetch-streamed SSE
  with the bearer header, backoff reconnect, refetch on reconnect), and
  `src/web/session.ts` (token gate).

What the server does **not** have yet is a backend for the desktop app: `docs/server.md`
says each keeps its own database. Section 6 covers moving the data.

## 4. Realtime Streams

### 4.1 What herdr Offers

herdr's socket API (schema from `herdr api schema --json`, herdr 0.9.5) has no raw
byte stream of pane output. It offers:

- `pane.read`: a terminal snapshot, with source `visible`, `recent`, or
  `recent-unwrapped` and format `text` or `ansi`.
- `pane.send_text`, `pane.send_keys`, and `pane.send_input` for input.
- `events.subscribe` with pane-scoped events such as `pane.updated`,
  `pane.output_matched`, `pane.scroll_changed`, `pane.exited`, and
  `pane.agent_status_changed`. Only one subscription is allowed per connection. Toodo
  already uses this for agent statuses (`src-tauri/src/adapters/herdr_events.rs:338`).

So a pane view mirrors **screen snapshots**. It does not relay a byte stream.

### 4.2 Pane Output and Input: WebSocket

**Transport: WebSocket**, one connection per open pane view.

- Input is frequent, small, and latency-sensitive (every keystroke). SSE plus
  `POST` per keystroke costs a request per key and has no ordering guarantee across
  requests. A WebSocket keeps output and input ordered on one connection.
- Output frames can be large (a full ANSI screen). Binary or text frames on one socket
  avoid SSE's line-based framing and base64.
- The existing event stream stays SSE. It is one-way and low-rate, and it already works
  through the fetch-based reader.

Endpoint:

```
GET /api/panes/stream?ticket=<ticket>   (Upgrade: websocket; the ticket names the pane)
```

Messages are JSON text frames:

```jsonc
// server -> client
{ "type": "frame", "seq": 41, "cols": 120, "rows": 40, "ansi": "<visible screen>" }
{ "type": "control", "on": true }                // answers the client's control message
{ "type": "error", "message": "..." }            // e.g. input while read-only
{ "type": "closed", "reason": "pane_closed" }     // then the server closes the socket
// client -> server
{ "type": "text", "text": "yes\n" }               // pane.send_text
{ "type": "keys", "keys": ["esc"] }               // pane.send_keys
{ "type": "resize", "cols": 120, "rows": 40 }     // optional, later
```

Server side (`PaneMirror`):

- There is one mirror per `(machine, pane)`, reference-counted by viewers. It is
  created on the first viewer and dropped shortly after the last one leaves.
- It talks to the herdr socket directly: the local socket, or `ssh -W <socket>` for SSH
  machines, as `SshSocket` does (`src-tauri/src/adapters/herdr_events.rs`). herdr 0.9.5
  answers one request per connection and then closes it, so every request opens a new
  connection; for SSH machines they share one SSH connection through OpenSSH
  multiplexing (`ControlMaster=auto`, `ControlPersist=60`), so only the first pays the
  handshake. Spawning `herdr --machine ...` per read would cost a process and an ssh
  handshake per frame.
- It reads `pane.read` (`source: visible`, `format: ansi`) and `pane.layout` (for the
  size), every 250 ms while the screen changes, backing off to 2 s while it does not;
  input asks for a read at once. It sends a frame only when the screen or size changed.
  Frames are full screens, so a late joiner or a dropped frame needs no replay, and the
  next frame is complete. (`pane.read` reports a `revision`, but it stayed 0 on herdr
  0.9.5, so frames are compared instead.)
- A slow client gets the newest frame only. Intermediate frames are skipped, the same
  as the event stream's "fall behind, resync" rule.
- The client renders frames with xterm.js (reset, then write the ANSI screen).
  Scrollback uses `--source recent` on demand.

Input safety:

- Views open **read-only**. Input needs an explicit "take control" toggle in the UI,
  which sends `{ "type": "control", "on": true }`, and the server ignores input frames
  until it is on.
- The server accepts only panes in a herdr workspace that belongs to a Toodo task (or the
  pane it created itself for `herdr machine add`). It does not accept arbitrary pane ids.
- Text frames are size-capped, for example 64 KB. The server logs one line per
  control session (pane, start, end), not the keystrokes.

### 4.3 Chat Channel

This section planned a chat channel to an outside agent. A lead chat was built later and
then removed from Toodo, so the design is no longer kept here.

### 4.4 Auth for Streams

- **SSE** keeps the bearer header. The client reads it with `fetch` streaming, not
  `EventSource`, which cannot send headers (`src/web/event.ts:60`).
- **WebSocket**: browsers cannot set `Authorization` on a WebSocket. Use a short-lived
  ticket:
  1. `POST /api/stream-tickets` with the bearer token and
     `{ "taskId": ..., "paneId": ... }` returns `{ "ticket": string, "expiresAt": number }`.
     The server checks that herdr lists the pane in the task's herdr workspace and finds
     the machine from the task. The ticket is random, single-use, valid for 30 s, and
     bound to that pane.
  2. The client opens the WebSocket with `?ticket=`. The server consumes the ticket
     before the upgrade and rejects reuse.

  This keeps the long-lived token out of URLs and logs. A ticket that leaks is useless
  after 30 s or its first use.
- The server also checks `Origin` on the upgrade against its own origin and the desktop
  app's origin, which blocks cross-site WebSocket hijacking.
- Network exposure: the server speaks plain HTTP on loopback today. Any client off the
  machine, whether a PWA on a phone or the desktop app on another PC, reaches it through
  TLS and an authenticating front (a reverse proxy, a zero-trust tunnel, or an SSH
  forward), as `docs/server.md` already requires. A PWA also needs HTTPS for its service
  worker.
- Per-device tokens (256): a `devices` table with hashed tokens, labels, last seen, and
  revoke, next to the shared `web-token`. A client signs in with the shared token once and
  then keeps a device token of its own, so losing a phone does not mean rotating every
  client's token. See `docs/server.md` (Devices).

## 5. Follow-up Slicing

Order: **251 first**. 252 and 253 are independent of each other after it.

### 251: Serve the Web UI as a PWA from toodo-server

- Web app manifest, icons (from `src-tauri/icons/icon.svg`), and a service worker that
  caches the app shell only and never `/api` or `/mcp`.
- Ship the web build in the release: add `dist-web` to the server tarball
  (`scripts/package-server.sh`), and have `install-server.sh --release` install and
  serve it, so the PWA no longer needs a checkout.
- File flows from 2.2: `GET /api/backups/export`, `POST /api/backups/restore`,
  `GET /api/backups/{name}`, `restore_backup { name }`, and dropping the path-based RPCs
  and `save_report` from the server table.
- `list_directories` from 2.3, replacing the `window.prompt` path dialogs.
- Mobile layout checks for the main views. A drawer already exists.
- Done when the PWA installs from the server URL over HTTPS and works on its own:
  creating a workspace, starting a task, the timeline, and review all work, and backup
  export/restore round-trips a file.

### 252: herdr Pane View

- Herdr adapter: a request connection (local socket / `ssh -W`) with `read_pane`,
  `send_text`, and `send_keys`, faked in tests like the others.
- `POST /api/stream-tickets` and `GET /api/panes/stream` (WebSocket), `PaneMirror` with
  viewer refcount and change detection, and the Origin check.
- `ensure_task_workspace` split out of `open_task_in_herdr` (2.5).
- UI: an xterm.js view in the task details sheet for in-progress and in-review tasks,
  read-only by default with a "take control" toggle.
- Optional at the end: run `herdr machine add` in a pane (2.4).
- Done when a client shows a live agent pane of a local and an SSH-machine task, and
  input reaches the pane only after taking control.

### Install and Connection Model

One server serves many clients, and a server and a client can run on the same machine.
Installation works like VS Code Remote-SSH, with one difference: the VS Code server lives
only while a window is attached, but toodo-server must stay resident, because agents, PR
checks, and backups keep running with no client open. So the client installs the server,
and the server runs as a service.

- **Same machine:** the desktop app bundles the server binary, starts it as a sidecar,
  and connects to it like any other server. There is no separate standalone core mode,
  so open decision 1 is settled: one runtime path.
- **Remote machine over SSH:** the client connects with ssh, checks the installed server
  version, installs or upgrades the release matching the client (`install-server.sh`),
  registers a systemd user service, reads the web token over ssh, and connects through
  an `ssh -L` forward. No token copy, no public exposure, and versions stay matched.
- **Phone (PWA):** no ssh, so it reaches the server through TLS and an authenticating
  front (4.4).
- **Many clients:** per-device tokens (4.4) so one device can be revoked alone.

### 254: Desktop Thin Client With a Bundled Local Server

Turn the Tauri app into a client of a configured server: base URL plus token storage
(2.6), the web build's `src/web/*` transport in the WebView, no DB, threads, MCP, or
tunnels in the shell, and the version check against `app_info`. The app ships the server
binary and starts and stops a local server for same-machine use. Depends on 251.

### 255: Install and Upgrade the Server Over SSH

"Add SSH host" in the client: version check, install or upgrade of the matching release,
systemd user service, token read over ssh, and an `ssh -L` forward. Depends on 254.

### 256: Per-Device Tokens

A `devices` table with hashed tokens, labels, last seen, and revoke, plus a UI to manage
them. The shared `web-token` keeps working during migration. Depends on 251; needed
before phones use the server off the machine.

## 6. Open Decisions

These need an owner decision before the thin-client step. They do not block 251 to 253.

1. **Standalone desktop mode.** Settled: removed. The desktop app runs a bundled local
   server instead (see Install and Connection Model).
2. **Workspaces on the Windows PC.** In the desktop app, "Local" is the PC (Windows
   paths). With a Linux server, "Local" is the server. PC-local workspaces either move
   to the server, or the PC becomes an SSH machine of the server (OpenSSH server and
   herdr on Windows, saved with `herdr machine add`). Toodo cannot convert them
   automatically.
3. **Data migration.** One-time move of the desktop database into the server. The
   desktop app exports, then the server restores (via 2.2's upload). The restore needs a
   pass that rewrites or rejects Windows `Local` paths, depending on decision 2.
4. **Exposure.** Which authenticating front the PWA uses off the machine, and whether
   per-device tokens (4.4) are needed before phones use it. The documented front is a
   Cloudflare Tunnel of its own with Cloudflare Access in front, the server staying on
   loopback ("Off the Machine" in `docs/server.md`); per-device tokens remain open.
