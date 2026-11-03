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
- `toodo service install`: install the server as a user service.

## Requirements

Linux x64 or arm64 (glibc) only. Install with optional dependencies enabled (the default), because the binaries ship in the `@dubusoft/toodo-linux-<arch>` packages.

See https://github.com/dev-bokdong/toodo for documentation.
