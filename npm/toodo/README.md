# @dubusoft/toodo

Command line for [Toodo](https://github.com/dev-bokdong/toodo), a task tracker that keeps the dependencies between tasks and the memory of the work: notes, decisions, references, and status history. It installs `toodo-server` and the web app it serves.

## Install

The recommended install:

```sh
npm i -g @dubusoft/toodo
toodo init
toodo service install
```

`toodo init` creates the data directory with its database and access tokens, starts the server on `127.0.0.1:47616`, and prints the web app URL and the file that holds the web access token. `toodo service install` keeps the server running as the systemd user service `toodo-server.service`.

`npx @dubusoft/toodo init` works too: it installs the same version globally first, so the server and the `toodo` command do not depend on npm's npx cache. The development channel is `@dubusoft/toodo@dev`.

## Update

```sh
toodo update
```

It installs the newest version of the channel with npm (`latest` for releases, `dev` when a prerelease is installed; pick one with `--channel dev|latest`), restarts the server on it, and checks that it answers. When npm fails, the running server keeps its version.

## MCP Registration

`toodo init` registers the server's MCP endpoint with the coding agents on `PATH`: with `claude mcp add` for Claude Code, and in `$CODEX_HOME/config.toml` (else `~/.codex/config.toml`) for Codex. Rerun `toodo init` after installing an agent to register it too, or pass `--no-mcp` to register with none. `toodo status` prints the MCP URL and the file that holds its token.

## Commands

- `toodo init`: set up Toodo on this machine and register MCP with coding agents.
- `toodo start`: start the server.
- `toodo stop`: stop the server.
- `toodo restart`: stop the server and start it again.
- `toodo status`: show whether the server is running and where its files are.
- `toodo doctor`: check versions, server health, and the data files, with the fix of each problem.
- `toodo logs`: print the end of the server log; `--follow` keeps printing.
- `toodo service install`: install the server as a user service (systemd on Linux, a launchd agent on macOS).
- `toodo update`: update to the newest version and restart the server; a server that does not come back goes back to the previous version. `toodo update --check` only reports a newer version.
- `toodo uninstall`: stop the server and remove its service and MCP registrations; `--delete-data` deletes the data directory too.

`toodo COMMAND --help` shows the options of each. `--listen HOST:PORT` on `init` or `service install` changes the address; an address other than loopback lets other machines reach the server, so prefer a tunnel to it.

## Requirements

- Linux x64 or arm64 (glibc or musl) or macOS x64 or arm64, with Node.js 18 or later. Install with optional dependencies enabled (the default), because the binaries ship in the platform packages `@dubusoft/toodo-linux-<arch>`, `@dubusoft/toodo-linux-<arch>-musl`, and `@dubusoft/toodo-darwin-<arch>`.
- Optional: Claude Code (`claude`) or Codex (`codex`) on `PATH`, to register the MCP endpoint with them.

See https://github.com/dev-bokdong/toodo for documentation.
