// The version the server reports: `$TOODO_VERSION` when the build sets it (the npm workflow
// passes the version it publishes), else the version of `package.json`, as the Rust server
// picked it.

import pkg from "../../../package.json" with { type: "json" };

export const VERSION: string = process.env.TOODO_VERSION || pkg.version;

/** `toodo-server <version>`, as `toodo-server --version` prints it. */
export function programVersion(): string {
  return `toodo-server ${VERSION}`;
}
