# Parity Harness

`scripts/parity/` compares two Toodo servers by what they answer and what they store. It
exists for the TypeScript port of the Rust server: the port is done when it answers every
call the way the Rust server does, on the same database. Any two servers work: each side is
a command that starts a server, so the harness also compares the Rust server with itself,
which checks the harness.

It runs on Node.js 22.5 or later (`node:sqlite`, TypeScript run as is), with no packages.
Each server is started like `e2e/server.ts` starts one: on a free loopback port, with a data
directory of its own (`TOODO_LISTEN`, `TOODO_DATA_DIR`), signed in with the `web-token` and
`mcp-token` it creates there. A server command defaults to
`src-tauri/target/debug/toodo-server` (`cargo build --bin toodo-server` in `src-tauri/`).

## Commands

```sh
node scripts/parity/parity.ts replay [--a CMD] [--b CMD] [--db FILE] [--out DIR] [--keep]
node scripts/parity/parity.ts shadow --live FILE [--reference CMD] [--candidate CMD] [--rounds N] [--interval SECONDS] [--out DIR]
node scripts/parity/parity.ts rust-check --db FILE [--bin CMD]
node scripts/parity/parity.ts inventory [--bin CMD] [--write]
```

`CMD` is a program and its arguments separated by spaces, such as
`"bun server/src/main.ts"`, the TypeScript server. Every command exits `0` on success and
`1` when it found a difference or a failure.

The TypeScript server neither creates nor migrates a database, so a run against it needs
`--db` (or `--live`): a database the Rust server created, such as a copy of a live one or
the `toodo.sqlite3` a Rust server leaves in a new data directory.

### replay

Copies the database `--db` (a new, empty database without it) into two data directories,
starts server A (`--a`) and server B (`--b`) on them, and runs the scenario in
`scenario.ts` on both. It then compares:

- **Replies**: every step's HTTP status and body. The scenario calls every command of
  `src-tauri/src/bindings.rs` over `/api/rpc` and every MCP tool of the Rust server's
  `tools/list` over `/mcp`, along success and error paths (missing objects, rejected
  transitions, a dependency cycle, invalid input, an unknown command and tool), plus MCP
  `initialize`, `tools/list`, and `resources/list` and a chat attachment upload and
  download.
- **Events**: everything each server sent on `/api/events` during the run, in order. The
  last steps start a marker task; the run waits for its `task-status-changed` event, after
  which every earlier event has arrived.
- **Database**: after both servers stop, a dump of each database in the shape of sqlite3's
  `.dump` (schema, then every row as an `INSERT`, in rowid order; `dump.ts`).

The scenario makes the objects it works on and takes their IDs from the answers of the same
server, so it runs on a new database and on a copy of a live one alike. It fails when a
command or tool of `inventory.json` is not called, or when `bindings.rs` or the reference
server's `tools/list` no longer match `inventory.json`.

`--out` keeps `steps.jsonl` (each step's normalized replies from A and B) and
`differences.json`; `--keep` keeps the data directories. Both may hold the data of the
copied database.

### shadow

Shadow reads against the live database, which it opens read-only and never writes. Each
round copies it with `VACUUM INTO` (one consistent snapshot, also while the live server
writes), starts the reference (`--reference`, the Rust server) and the candidate
(`--candidate`) on two copies, and compares their answers to the reads of `reads.ts`: every
workspace, task, guideline list, channel, thread, saved review, and review report the
database holds, over `/api/rpc` and `/mcp`, and the database dumps afterwards. Rounds repeat
every `--interval` seconds (default 3600) for `--rounds` rounds (default 1), so a run over
several days is one command, e.g. `--rounds 72` for three days of hourly rounds.

Each round appends a line to `shadow.jsonl` in `--out` (the round, its time, the number of
reads, and which ones differed) and writes its differences to `round-N.json`.

The servers answer from copies rather than from the live server, so both see the same data
at the same moment and a difference is never a write that landed between two reads.

### rust-check

For the rollback period after switching servers: opens a copy of the database `--db` with a
Rust server (`--bin`, the last Rust release), runs the reads of `reads.ts`, and runs
`PRAGMA integrity_check` on the copy. It passes when the server starts on the copy, every
read succeeds, and the check reports `ok`. A database whose schema version is newer than the
server's fails, since the server refuses to open it. It prints the schema version before
and after.

### inventory

Prints the commands of `bindings.rs` and the tools of the Rust server's `tools/list` against
`inventory.json`, the list `replay` must cover. After a command or tool is added, run it
with `--write` and add steps for the new entries to `scenario.ts`.

## Normalization

Two servers given the same database and calls still differ in what depends on the moment
or the process. `normalize.ts` replaces exactly those before comparing:

- Clock readings: Unix seconds and milliseconds, RFC 3339 times, and `YYYYMMDD-HHMMSS` file
  name stamps that fall within the run (times from the copied database stay).
- The server instance id (`instance`, `server instance <id>`) and the epoch of event ids
  (`<epoch>-<sequence>`).
- The server's build version where the server names itself (`{ "name": "toodo", "version" }`
  in `app_info` and in the MCP `serverInfo`), since `shadow` compares a release build with
  the checkout's TypeScript server.
- Each server's data directory, URL, listen address, and tokens.
- 32-character hex names, the random names of stored chat attachments.

Object keys are compared in sorted order. The internal tables of the full-text index
(`task_search_*`) are left out of the dump and the index's own rows dumped instead, since
their pages depend on how SQLite merged segments rather than on what the index holds.

## Isolation

A server on a copy must not reach anything the live server reaches. In every copy the
harness deletes the push subscriptions, which name real devices. The servers get
`TOODO_NPM_REGISTRY` pointing at a closed loopback port, so `check_update` fails the same way
on both, and the scenario's URL criterion names a loopback address, which the servers refuse
to fetch. The backup directory is the copy's data directory, since the backup settings are
not part of the database.
