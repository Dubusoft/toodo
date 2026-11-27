// `/mcp`, the MCP endpoint for agents (`src-tauri/src/mcp/mod.rs`, `router` and
// `require_token`): requests from this machine that bear the MCP token reach the endpoint of
// `protocol.ts`, and so, in public mode, do chat apps from anywhere that bear an OAuth access
// token; the others are turned away with why and how to get through, which the app's status
// shows too. The HTTP surface mounts it at `/mcp`, with the agent's chat attachments on
// `/mcp/attachments` behind the same guard.

import type * as B from "../../../src/lib/api.ts";
import { bearer, FailedAttempts, type Rejection, sameSecret, text, tooMany, unauthorized } from "../http/auth.ts";
import { resolveAccessToken } from "../oauth/routes.ts";
import { type Access, McpService, type Backend } from "./protocol.ts";

export type { Access, Backend } from "./protocol.ts";

/** The tokens `/mcp` tells apart: the MCP token it accepts, and the web token it names when
 * an agent sends that one instead. */
export type Tokens = { mcp: string; web: string | null };

/** Whether `address` is a loopback address, an IPv4 one mapped into IPv6 included. */
export function isLoopback(address: string | null): boolean {
  if (address === null) return false;
  const ip = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  return /^127\.\d+\.\d+\.\d+$/.test(ip) || ip === "::1" || ip === "0:0:0:0:0:0:0:1";
}

/** How the app's status names why a request was turned away. */
const REASONS: Record<Rejection, B.McpRejectionReason> = {
  no_header: "no_header",
  not_bearer: "not_bearer",
  wrong_token: "wrong_token",
  other_surface_token: "web_token",
};

/** The MCP endpoint behind the MCP token. */
export class McpEndpoint {
  readonly #attempts = new FailedAttempts();
  readonly #service: McpService;
  readonly #backend: Backend;
  readonly #tokens: Tokens;

  constructor(backend: Backend, tokens: Tokens) {
    this.#backend = backend;
    this.#tokens = tokens;
    const allowedHosts = ["localhost", "127.0.0.1", "::1"];
    const issuer = backend.publicUrl ?? null;
    if (issuer !== null) allowedHosts.push(new URL(issuer).hostname, issuer.split("://")[1]!);
    this.#service = new McpService(backend, allowedHosts);
  }

  /**
   * How `request`, which came from `peer`, may reach `/mcp`, or the answer that turns it away.
   * Without a public URL only loopback peers are served; with one, an OAuth access token works
   * from anywhere. An address that sent too many wrong tokens gets `429` until it may try
   * again, and every `401` is kept as the last rejection the app's status shows.
   */
  admit(request: Request, peer: string): Access | Response {
    const issuer = this.#backend.publicUrl ?? null;
    if (issuer === null && !isLoopback(peer)) {
      return text(403, "Connect through loopback or an SSH tunnel, or set TOODO_PUBLIC_URL to enable remote MCP access.");
    }
    const wait = this.#attempts.lockedOut(peer);
    if (wait !== null) return tooMany("MCP", wait);
    const presented = bearer(request.headers);
    let rejection: Rejection;
    if (presented === "no_header" || presented === "not_bearer") {
      rejection = presented;
    } else if (sameSecret(presented, this.#tokens.mcp)) {
      return { kind: "static" };
    } else {
      if (issuer !== null) {
        try {
          const grant = resolveAccessToken(this.#backend.storage, presented);
          if (grant !== null) return { kind: "oauth", grant };
        } catch (error) {
          console.error(
            `toodo: failed to look up an MCP OAuth access token: ${error instanceof Error ? error.message : String(error)}`,
          );
          return text(500, "Reconnect from the app after the server database is available.");
        }
      }
      const web = this.#tokens.web;
      rejection = web !== null && sameSecret(presented, web) ? "other_surface_token" : "wrong_token";
    }
    if (rejection === "wrong_token") this.#attempts.record(peer);
    const status = this.#backend.mcp;
    status.lastRejection = {
      reason: REASONS[rejection],
      at: Math.floor(Date.now() / 1000),
      count: (status.lastRejection?.count ?? 0) + 1,
    };
    const response = unauthorized("mcp", rejection, status.instance);
    if (issuer !== null) {
      // Chat apps find the authorization server from here.
      const invalid = rejection === "no_header" || rejection === "not_bearer" ? "" : ', error="invalid_token"';
      response.headers.set(
        "www-authenticate",
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"${invalid}`,
      );
    }
    return response;
  }

  /** Answers a request to `/mcp` that `admit` let through with `access`. */
  serve(request: Request, access: Access): Promise<Response> {
    return this.#service.handle(request, access);
  }

  /** Answers a request to `/mcp` that came from `peer`. */
  async handle(request: Request, peer: string): Promise<Response> {
    const access = this.admit(request, peer);
    return access instanceof Response ? access : this.serve(request, access);
  }
}
