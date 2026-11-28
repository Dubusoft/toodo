# Troubleshooting

The problems new setups run into most, by what you see. Every error Toodo shows names the
next step that works; this page adds the background. Paths assume the default data
directory, `~/.local/share/toodo-server`; `toodo status` prints the one in use.

## The Server

### The web app does not load

Check whether the server runs:

```sh
toodo status          # exits 0 when it runs, 3 when it is stopped
toodo doctor          # versions, health, and data files, with the fix of each problem
toodo start
```

Read the server log with `toodo logs` (`--follow` keeps printing new lines); it reads
`journalctl --user -u toodo-server` for the systemd user service and `server.log` in the
data directory for a server started by `toodo start`. `toodo restart` starts the server
again. `toodo start` and `toodo init` stop with
`127.0.0.1:47616 is already in use by another program; pick another port with: toodo init --port <port>`
when another program has the port; run the command it prints.

The server listens on loopback only by default, so `http://127.0.0.1:47616` works on the
server itself. From another device, reach it through a tunnel; see
[Off the Machine](server.md#off-the-machine-cloudflare-tunnel-and-access).

### The server does not start: restore a backup by hand

When the database is damaged, the server stops at start and the web app and
`POST /api/backups/restore` cannot restore a backup. `toodo start` then ends with
`toodo-server exited (exit status: 1) before it accepted connections`, and `toodo logs`
shows the cause, e.g.
`cannot back up .../toodo.sqlite3 before migrating it to the schema of this version: database error: file is not a database`.
Put a backup in its place by hand:

```sh
toodo stop
toodo status                  # must say stopped and exit 3 before you touch the files
cd ~/.local/share/toodo-server  # or the Data directory toodo status prints
damaged=damaged-$(date +%Y%m%d-%H%M%S)
mkdir "$damaged"
mv toodo.sqlite3* "$damaged"/  # the database with its -wal and -shm files
ls backups/                   # toodo-auto-*, toodo-pre-restore-*, toodo-pre-migration-*
cp backups/toodo-auto-20261123-080310.sqlite3 toodo.sqlite3
toodo start
toodo doctor                  # ends with "No problems found." and exits 0
```

Move the `-wal` and `-shm` files together with `toodo.sqlite3`: they hold changes of the
damaged file, which SQLite would otherwise apply to the backup. Pick the newest backup
from before the trouble; the time in its name is UTC, and anything changed after it is
lost. When *Settings > Backup & restore* names another directory, the backups are there (the
`directory` in `backup-settings.json`). A backup of an older version is migrated on
start, after a pre-migration backup of it. The damaged files stay in `damaged-<time>/`;
delete them once the restored data looks right.

### Sign-in says the token is wrong

The access token is the content of `web-token` in the data directory:

```sh
cat ~/.local/share/toodo-server/web-token
```

Do not paste the MCP token (`mcp-token`): it is for agents and is rejected at `/api`.
After 20 wrong tokens within a minute, the server answers `429` to that address for the
rest of the minute, even with the right token; wait for it. A device token that expired
asks you to sign in again with `web-token`.

### `toodo update` installs nothing

`toodo update` stays on the channel of the installed version: `dev` for a prerelease,
`latest` for a release. When the newest version of that channel is older than the
installed one, it prints the command that installs it anyway,
`toodo update --channel <channel> --allow-downgrade`. `toodo update --check` shows what
the channel has without installing it. When the server does not answer after an update,
`toodo update` goes back to the previous version by itself and exits `1`; `toodo logs`
shows why the new version did not start. `scripts/install-server.sh` does the same for a
release or checkout install: it lists what it restored and exits `1`, and
`journalctl --user -u toodo-server` shows why.

## Tasks

### A task stays in review

Toodo no longer watches pull requests, so a merge doesn't complete a task. A task stays
`in_review` until the agent or person doing the work calls `complete_task` (or
`conclude_task`), or someone completes it in the web app. Check that its manual criteria
are checked and its `url` criteria answer with a 2xx first; `complete_task` refuses
otherwise and names what is missing.

## Agents and MCP

### The agent gets 401 from Toodo's MCP server

The token `toodo init` gave the agent was replaced, or the agent reaches another Toodo
server. The `401` body names the server's instance. Run `toodo stop` and `toodo start`:
they register the endpoint and the current token again with Claude Code and Codex where
`toodo init` registered them. For other clients, copy the configuration from Settings >
AI app connections again.

### The agent cannot reach Toodo from another machine

The MCP endpoint listens on the server's loopback port only, and Toodo opens no tunnels to
other machines. Reach it from there the way a browser does, through an SSH tunnel
(`ssh -L 47616:127.0.0.1:47616 <server>`), then use `http://127.0.0.1:47616/mcp` with the
MCP token. See [Agents](server.md#agents) and
[Off the Machine](server.md#off-the-machine-cloudflare-tunnel-and-access).
