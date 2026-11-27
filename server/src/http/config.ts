// The server's configuration from `TOODO_*` environment variables. Port of `Config` in
// `src-tauri/src/server/mod.rs`; the messages are the Rust ones.

import { join } from "node:path";
import type * as B from "../../../src/lib/bindings.ts";
import { debugString } from "../domain/rust.ts";
import { DEFAULT_SUBJECT } from "../push/push.ts";
import { type AccessConfig, parseAccessConfig } from "./access.ts";

/** The default port for the API, app, and MCP endpoint. */
export const DEFAULT_PORT = 47616;

/** The name the chat shows for the agent unless `TOODO_CHAT_AGENT_NAME` sets one. */
const DEFAULT_AGENT_NAME = "Dori";

export type Listen = { readonly hostname: string; readonly port: number };

export type Config = {
  readonly listen: Listen;
  readonly dataDir: string;
  readonly webDir: string | null;
  /** The public HTTPS origin, without a trailing slash. */
  readonly publicUrl: string | null;
  /** The contact push services see in the VAPID token of every notification. */
  readonly pushSubject: string;
  /** The Cloudflare Access application whose JWTs sign `/api` requests in. */
  readonly access: AccessConfig | null;
  /** How the chat shows the agent connected over MCP. */
  readonly chatAgent: B.ChatAgent;
};

/** A socket address as Rust's `SocketAddr` parses it: `a.b.c.d:port` or `[v6]:port`. */
function parseListen(value: string): Listen {
  const match = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:.]+)\]):(\d{1,5})$/.exec(value);
  const port = Number(match?.[3]);
  const v4 = match?.[1];
  if (match === null || port > 65535 || (v4 !== undefined && v4.split(".").some((part) => Number(part) > 255))) {
    throw new Error(`TOODO_LISTEN ${debugString(value)} is not an address: invalid socket address syntax`);
  }
  return { hostname: v4 ?? match[2]!, port };
}

/** The origin `TOODO_PUBLIC_URL` names, as `PublicUrl::parse` of the Rust server checks it:
 * HTTPS (HTTP only for localhost), no credentials, path, query, or fragment. */
export function parsePublicUrl(value: string): string {
  const invalid = () =>
    new Error(
      "Set TOODO_PUBLIC_URL to an HTTPS origin such as https://toodo.example.com (HTTP is allowed only for localhost, 127.0.0.1, or [::1]); remove credentials, paths, queries, and fragments.",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  const web =
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  if (!web || url.pathname !== "/" || value.includes("?") || value.includes("#")) throw invalid();
  return url.href.replace(/\/+$/, "");
}

export function configFromEnv(variable: (name: string) => string | undefined): Config {
  const listenValue = variable("TOODO_LISTEN");
  const listen = listenValue === undefined ? { hostname: "127.0.0.1", port: DEFAULT_PORT } : parseListen(listenValue);
  let dataDir = variable("TOODO_DATA_DIR");
  if (dataDir === undefined) {
    const data = variable("XDG_DATA_HOME");
    const home = variable("HOME");
    if (data !== undefined && data !== "") dataDir = join(data, "toodo-server");
    else if (home !== undefined) dataDir = join(home, ".local/share/toodo-server");
    else throw new Error("set TOODO_DATA_DIR or HOME");
  }
  const publicValue = variable("TOODO_PUBLIC_URL");
  const subject = variable("TOODO_PUSH_SUBJECT");
  if (subject !== undefined && !subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error(`TOODO_PUSH_SUBJECT ${debugString(subject)} is not a mailto: or https: URL`);
  }
  const team = variable("TOODO_CF_ACCESS_TEAM_DOMAIN");
  const audience = variable("TOODO_CF_ACCESS_AUD");
  if ((team === undefined) !== (audience === undefined)) {
    throw new Error(
      "set both TOODO_CF_ACCESS_TEAM_DOMAIN and TOODO_CF_ACCESS_AUD to accept Cloudflare Access sign-ins, or neither",
    );
  }
  const name = variable("TOODO_CHAT_AGENT_NAME")?.trim();
  const avatar = variable("TOODO_CHAT_AGENT_AVATAR");
  if (
    avatar !== undefined &&
    !(
      (avatar.startsWith("https://") || (avatar.startsWith("/") && !avatar.startsWith("//"))) &&
      !/[\s\p{Cc}]/u.test(avatar)
    )
  ) {
    throw new Error(
      `TOODO_CHAT_AGENT_AVATAR ${debugString(avatar)} is not an https: URL or a path such as /avatar.png`,
    );
  }
  return {
    listen,
    dataDir,
    webDir: variable("TOODO_WEB_DIR") ?? null,
    publicUrl: publicValue === undefined ? null : parsePublicUrl(publicValue),
    pushSubject: subject ?? DEFAULT_SUBJECT,
    access: team === undefined || audience === undefined ? null : parseAccessConfig(team, audience),
    chatAgent: { name: name === undefined || name === "" ? DEFAULT_AGENT_NAME : name, avatarUrl: avatar ?? null },
  };
}
