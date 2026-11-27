// The secrets and files of the data directory the HTTP server starts from: the access
// tokens (`web-token`, `mcp-token`) and the directory that holds them. Port of the token
// parts of `src-tauri/src/mcp/mod.rs` and `create_private_dir` of
// `src-tauri/src/server/mod.rs`.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The file in the data directory that holds the token of the web app. */
export const WEB_TOKEN_FILE = "web-token";

/** The file in the data directory that holds the token of agents. */
export const MCP_TOKEN_FILE = "mcp-token";

/** 32 random bytes, in hex. */
export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

/** A new server instance id: tells this server apart from other Toodo servers, e.g. the
 * one a tunnel or an old config reached instead. */
export function newInstance(): string {
  return randomToken().slice(0, 12);
}

/**
 * The token in `path`, created with 32 random bytes on first use. Only the owner may read
 * it: a new file is created that way and an existing one is tightened. Creating one is
 * logged, since clients that kept an earlier token are turned away from then on.
 */
export function loadToken(path: string): string {
  let replaced = false;
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token !== "") {
      chmodSync(path, 0o600);
      return token;
    }
    rmSync(path);
    replaced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  console.log(
    `toodo-server: created a new access token in ${path}${replaced ? " (the file was empty)" : ""}; clients that use an earlier token get 401 until they are given this one`,
  );
  const token = randomToken();
  writeFileSync(path, token, { flag: "wx", mode: 0o600 });
  return token;
}

/** Creates the data directory, which holds the access tokens, so that only the owner can
 * enter it; an existing one is tightened. */
export function createPrivateDir(dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(dir, 0o700);
}
