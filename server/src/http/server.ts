// The routes of the HTTP server on its one port: the API behind the web token (or a device
// token, or Cloudflare Access), and the web app. MCP (`/mcp`, with the agent's chat
// attachments) is served by `server/src/mcp/`, and in public mode the OAuth server of
// `server/src/oauth/` answers `/oauth` and `/.well-known`.

import { statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { deviceId } from "../domain/device.ts";
import { chatAttachmentId } from "../domain/chat.ts";
import { CommandError } from "../commands/errors.ts";
import { McpEndpoint } from "../mcp/mcp.ts";
import type { ClientMetadataFetcher } from "../oauth/clients.ts";
import { OAuthServer } from "../oauth/routes.ts";
import * as attachments from "./attachments.ts";
import { type Caller, FailedAttempts, failed, text } from "./auth.ts";
import type { AccessVerifier } from "./access.ts";
import * as devices from "./devices.ts";
import * as files from "./files.ts";
import * as push from "./push.ts";
import * as rpc from "./rpc.ts";
import type { Services } from "./services.ts";

export type RouterOptions = {
  readonly services: Services;
  readonly webToken: string;
  readonly mcpToken: string;
  readonly access: AccessVerifier | null;
  /** The web build of the frontend; without it only the API is served. */
  readonly webDir: string | null;
  /** Fetches the metadata documents of OAuth clients that name one as their `client_id`. */
  readonly clientMetadata: ClientMetadataFetcher;
};

/** What the server tells a request about itself: its address, and that an event stream
 * must not time out. */
export type Connection = {
  readonly peer: string;
  readonly keepOpen: () => void;
};

export type Handler = (request: Request, connection: Connection) => Promise<Response>;

type ApiRoute = (
  request: Request,
  caller: Caller,
  params: string[],
  connection: Connection,
) => Response | Promise<Response>;

const NOT_FOUND = (): Response => new Response(null, { status: 404 });

function methodNotAllowed(allowed: readonly string[]): Response {
  return new Response(null, { status: 405, headers: { allow: allowed.join(",") } });
}

/** A path segment as axum's `Path` extractor decodes it; `null` when it is not text. */
function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** An `i64` path parameter, or the `400` axum answers for one that does not parse. */
function int(raw: string, run: (value: number) => Response | Promise<Response>): Response | Promise<Response> {
  const value = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) return text(400, `Invalid URL: Cannot parse \`${raw}\` to a \`i64\``);
  return run(value);
}

/** Serves `relative` from `dir`, else `index.html` for paths of the app such as `/tasks/1`. */
function staticFile(dir: string, pathname: string, method: string): Response {
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
  const decoded = segment(pathname);
  if (decoded === null || decoded.includes("\0")) return NOT_FOUND();
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const parts = relative.split(sep);
  let path = parts.includes("..") ? null : join(dir, relative);
  if (path !== null) {
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) path = join(path, "index.html");
      if (!statSync(path).isFile()) path = null;
    } catch {
      path = null;
    }
  }
  return new Response(Bun.file(path ?? join(dir, "index.html")));
}

export function createHandler(options: RouterOptions): Handler {
  const { services } = options;
  const gate: devices.Gate = {
    services,
    sharedToken: options.webToken,
    mcpToken: options.mcpToken,
    attempts: new FailedAttempts(),
    access: options.access,
  };

  // Routes behind the gate, by method and path pattern.
  const routes: Array<[string, RegExp, ApiRoute]> = [
    ["POST", /^\/api\/rpc\/([^/]+)$/, async (request, _caller, [command]) => {
      const name = segment(command!);
      if (name === null) return text(400, "Invalid URL: the command is not UTF-8");
      return rpc.handle(services, name, await request.text());
    }],
    ["GET", /^\/api\/events$/, (request, _caller, _params, connection) => {
      connection.keepOpen();
      // A header value that is not an id of ours makes the stream resync.
      const stream = services.events.stream(request.headers.get("last-event-id"));
      return new Response(stream.body(), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }],
    ["GET", /^\/api\/backups\/export$/, () => files.exportDatabase(services)],
    ["POST", /^\/api\/backups\/restore$/, (request) => files.restore(services, request)],
    ["GET", /^\/api\/backups\/([^/]+)$/, (_request, _caller, [name]) => {
      const decoded = segment(name!);
      return decoded === null ? NOT_FOUND() : files.download(services, decoded);
    }],
    ["POST", /^\/api\/chat\/attachments$/, (request) =>
      attachments.upload(services, "user", new URL(request.url).searchParams.get("name") ?? "", request)],
    ["GET", /^\/api\/chat\/attachments\/([^/]+)$/, (_request, _caller, [id]) =>
      int(id!, (value) => attachments.send(services, chatAttachmentId(value)))],
    ["GET", /^\/api\/devices$/, (_request, caller) => devices.list(services, caller)],
    ["POST", /^\/api\/devices$/, async (request, caller) => devices.register(services, caller, await request.text())],
    ["POST", /^\/api\/devices\/([^/]+)\/revoke$/, (_request, caller, [id]) =>
      int(id!, (value) => devices.revoke(services, caller, deviceId(value)))],
    ["GET", /^\/api\/session$/, (_request, caller) => devices.session(caller)],
    ["GET", /^\/api\/push$/, (_request, caller) => push.state(services, caller)],
    ["PUT", /^\/api\/push\/subscription$/, async (request, caller) => push.subscribe(services, caller, await request.text())],
    ["DELETE", /^\/api\/push\/subscription$/, (_request, caller) => push.unsubscribe(services, caller)],
    ["PUT", /^\/api\/push\/settings$/, async (request, caller) => push.saveSettings(services, caller, await request.text())],
    ["POST", /^\/api\/push\/test$/, (_request, caller) => push.test(services, caller)],
  ];

  async function api(request: Request, pathname: string, connection: Connection): Promise<Response> {
    // The gate guards every `/api` path: other paths stay 404 (or the web app) rather than
    // 401, and unknown API paths are 404 behind the token instead of the web app.
    const caller = await devices.requireAccess(gate, request, pathname, connection.peer);
    if (caller instanceof Response) return caller;
    const allowed: string[] = [];
    for (const [method, pattern, route] of routes) {
      const match = pattern.exec(pathname);
      if (match === null) continue;
      if (method === request.method || (method === "GET" && request.method === "HEAD")) {
        return route(request, caller, match.slice(1), connection);
      }
      allowed.push(method);
    }
    return allowed.length > 0 ? methodNotAllowed(allowed) : NOT_FOUND();
  }

  const mcp = new McpEndpoint(services, { mcp: options.mcpToken, web: options.webToken });
  const oauth =
    services.publicUrl === null
      ? null
      : new OAuthServer({
          issuer: services.publicUrl,
          webToken: options.webToken,
          storage: services.storage,
          fetcher: options.clientMetadata,
        });

  /** Chat apps signed in over OAuth may not use the chat, like its MCP tools: it is for the
   * agent with the MCP token. */
  const localOnly = () =>
    failed(new CommandError("notPermitted", "chat attachments are local-only; use the MCP token of the server"));

  /** `/mcp` and the agent's chat attachments under it, behind the MCP token. */
  function agent(request: Request, pathname: string, connection: Connection): Response | Promise<Response> {
    const access = mcp.admit(request, connection.peer);
    if (access instanceof Response) return access;
    if (pathname === "/mcp/attachments") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      if (access.kind !== "static") return localOnly();
      return attachments.upload(services, "agent", new URL(request.url).searchParams.get("name") ?? "", request);
    }
    const file = /^\/mcp\/attachments\/([^/]+)$/.exec(pathname);
    if (file !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
      if (access.kind !== "static") return localOnly();
      return int(file[1]!, (value) => attachments.send(services, chatAttachmentId(value)));
    }
    return mcp.serve(request, access);
  }

  return async (request, connection) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return api(request, pathname, connection);
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return agent(request, pathname, connection);
    if (oauth === null) {
      if (pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/")) return NOT_FOUND();
    } else {
      const answer = oauth.route(request, pathname, connection.peer);
      if (answer !== null) return answer;
    }
    return options.webDir === null ? NOT_FOUND() : staticFile(options.webDir, pathname, request.method);
  };
}
