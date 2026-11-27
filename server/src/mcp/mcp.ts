// `/mcp`, the MCP endpoint for agents (`src-tauri/src/mcp/mod.rs`, `router` and
// `require_token`): requests from this machine that bear the MCP token reach the endpoint of
// `protocol.ts`; the others are turned away with why and how to get through, which the app's
// status shows too. The HTTP surface mounts it at `/mcp`, with the agent's chat attachments
// on `/mcp/attachments` behind the same guard.

import type * as B from "../../../src/lib/bindings.ts";
import { bearer, FailedAttempts, type Rejection, sameSecret, tooMany, unauthorized } from "../http/auth.ts";
import { McpService, type Backend } from "./protocol.ts";

export type { Backend } from "./protocol.ts";

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
    this.#service = new McpService(backend);
  }

  /**
   * The answer that turns `request`, which came from `peer`, away, or `null` when it may
   * reach `/mcp`. Only loopback peers are served; an address that sent too many wrong tokens
   * gets `429` until it may try again, and every `401` is kept as the last rejection the
   * app's status shows.
   */
  refusal(request: Request, peer: string): Response | null {
    if (!isLoopback(peer)) {
      return new Response(
        "Connect through loopback or an SSH tunnel, or set TOODO_PUBLIC_URL to enable remote MCP access.",
        { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    const wait = this.#attempts.lockedOut(peer);
    if (wait !== null) return tooMany("MCP", wait);
    const presented = bearer(request.headers);
    let rejection: Rejection;
    if (presented === "no_header" || presented === "not_bearer") {
      rejection = presented;
    } else if (sameSecret(presented, this.#tokens.mcp)) {
      return null;
    } else {
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
    return unauthorized("mcp", rejection, status.instance);
  }

  /** Answers a request to `/mcp` that `refusal` let through. */
  serve(request: Request): Promise<Response> {
    return this.#service.handle(request);
  }

  /** Answers a request to `/mcp` that came from `peer`. */
  async handle(request: Request, peer: string): Promise<Response> {
    return this.refusal(request, peer) ?? this.serve(request);
  }
}
