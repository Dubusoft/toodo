# @dubusoft/toodo

Command line for [Toodo](https://github.com/dev-bokdong/toodo), a task planner that turns a plan into implemented, reviewed code. It installs `toodo-server` and the web app it serves.

## Install

```sh
npx @dubusoft/toodo init
```

or install globally:

```sh
npm i -g @dubusoft/toodo
```

The development channel is `@dubusoft/toodo@dev`.

## Commands

- `toodo init`: set up Toodo on this machine.
- `toodo start`: start the server.
- `toodo stop`: stop the server.
- `toodo status`: show whether the server is running.
- `toodo service install`: install the server as a user service (systemd on Linux, a launchd agent on macOS).

## Requirements

Linux x64 or arm64 (glibc or musl) or macOS x64 or arm64, with Node.js 18 or later. Install with optional dependencies enabled (the default), because the binaries ship in the platform packages `@dubusoft/toodo-linux-<arch>`, `@dubusoft/toodo-linux-<arch>-musl`, and `@dubusoft/toodo-darwin-<arch>`.

See https://github.com/dev-bokdong/toodo for documentation.
