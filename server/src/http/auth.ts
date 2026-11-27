// Who may call `/api`: the shared web token, a device token, or a Cloudflare Access JWT,
// with read-only devices limited to reading and too many wrong tokens locking an address
// out. Port of `src-tauri/src/server/devices.rs` (the gate), `src-tauri/src/mcp/attempts.rs`,
// and the token checks and 401 answers of `src-tauri/src/mcp/mod.rs`.

import { createHash } from "node:crypto";
import type { DeviceId } from "../domain/device.ts";
import { CommandError } from "../commands/errors.ts";

/** Why a request was turned away with `401`. */
export type Rejection = "no_header" | "not_bearer" | "wrong_token" | "other_surface_token";

/** Where a request was turned away: `/mcp` or `/api`. */
export type Surface = "mcp" | "api";

/** Who a request to `/api` comes from. */
export type Caller =
  | { readonly kind: "shared" }
  | { readonly kind: "device"; readonly id: DeviceId }
  /** A request Cloudflare Access signed in, without a token that works. */
  | { readonly kind: "access" };

/** The bearer token of a request's `Authorization` header; the scheme is matched without
 * regard to case, as HTTP defines it. */
export function bearer(headers: Headers): string | Rejection {
  const value = headers.get("authorization");
  if (value === null) return "no_header";
  const trimmed = value.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0 || trimmed.slice(0, space).toLowerCase() !== "bearer") return "not_bearer";
  const token = trimmed.slice(space + 1).trim();
  return token === "" ? "not_bearer" : token;
}

/** Compares without stopping at the first difference, so timing does not leak the token. */
export function sameSecret(presented: string, token: string): boolean {
  if (presented.length !== token.length) return false;
  let difference = 0;
  for (let i = 0; i < presented.length; i += 1) difference |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  return difference === 0;
}

const REJECTION_MESSAGES: Record<Surface, Record<Rejection, string>> = {
  mcp: {
    no_header:
      "Toodo MCP: the request has no Authorization header. Send `Authorization: Bearer <MCP token>`: copy the MCP config from Settings > Agent access in the Toodo app, or use the token in `mcp-token` in the server's data directory.",
    not_bearer:
      "Toodo MCP: the Authorization header is not `Bearer <token>`. Send `Authorization: Bearer <MCP token>` with the token alone, without quotes: copy the MCP config from Settings > Agent access in the Toodo app, or use the token in `mcp-token` in the server's data directory.",
    wrong_token:
      "Toodo MCP: this server does not accept the token. It is mistyped, from before the token was replaced, or from another Toodo server, so retrying with it fails again. Copy the MCP config again from Settings > Agent access of the Toodo app that shows the instance below, or use the token in `mcp-token` in this server's data directory, then restart the agent session with it.",
    other_surface_token:
      "Toodo MCP: this is the web sign-in token (`web-token`), which only the web app uses. Agents send the MCP token: copy the MCP config from Settings > Agent access in the Toodo app, or use the token in `mcp-token` in the server's data directory.",
  },
  api: {
    no_header:
      "Toodo API: the request has no Authorization header. Send `Authorization: Bearer <token>` with the web sign-in token (`web-token` in the server's data directory) or a device token; the web app asks for `web-token` when it signs in.",
    not_bearer:
      "Toodo API: the Authorization header is not `Bearer <token>`. Send `Authorization: Bearer <token>` with the web sign-in token (`web-token` in the server's data directory) or a device token, alone and without quotes.",
    wrong_token:
      "Toodo API: the token is neither the web sign-in token nor the token of an active device; the device may be revoked or the token replaced. Sign in to the web app again with the token in `web-token` in the server's data directory.",
    other_surface_token:
      "Toodo API: this is the MCP token for agents, which only `/mcp` accepts. Send the web sign-in token (`web-token` in the server's data directory) or a device token here, and use the MCP token only in an agent's MCP config.",
  },
};

/** `401` with the reason and how to get through, never the token itself; at `/mcp`, with
 * the server's `instance`. */
export function unauthorized(surface: Surface, rejection: Rejection, instance: string | null): Response {
  let body = REJECTION_MESSAGES[surface][rejection];
  if (instance !== null) body += `\nThis is Toodo server instance ${instance}.`;
  return text(401, `${body}\n`, { "www-authenticate": "Bearer" });
}

/** A plain-text answer, as axum sends a `String` body. */
export function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A command's failure, with the status its kind maps to. */
export function failed(error: CommandError): Response {
  return json(ERROR_STATUS[error.kind], error);
}

const ERROR_STATUS: Record<CommandError["kind"], number> = {
  invalidInput: 422,
  notFound: 404,
  rejected: 409,
  external: 502,
  internal: 500,
};

/** Wrong tokens an address may present within `ATTEMPT_WINDOW_MS` before it is locked out. */
export const MAX_FAILURES = 20;
export const ATTEMPT_WINDOW_MS = 60_000;

/** The most addresses tracked at once: beyond it, ones whose window ended are dropped,
 * and when every window is still open the address whose window started first makes room. */
const TRACKED = 1024;

/**
 * Wrong tokens per address, shared by the requests of one surface: once an address presents
 * `limit` wrong tokens within `ATTEMPT_WINDOW_MS`, every request from it is turned away
 * with `429` until the window ends. Only wrong tokens count; a missing header or the other
 * surface's token does not.
 */
export class FailedAttempts {
  readonly #tracked = new Map<string, { since: number; count: number }>();
  readonly #limit: number;
  readonly #now: () => number;

  constructor(limit = MAX_FAILURES, now: () => number = () => performance.now()) {
    this.#limit = limit;
    this.#now = now;
  }

  /** How many milliseconds `peer` must wait before it is heard again, if it is locked out. */
  lockedOut(peer: string): number | null {
    const failures = this.#tracked.get(peer);
    if (failures === undefined) return null;
    const ends = failures.since + ATTEMPT_WINDOW_MS;
    const now = this.#now();
    return failures.count >= this.#limit && now < ends ? ends - now : null;
  }

  record(peer: string): void {
    const now = this.#now();
    if (this.#tracked.size >= TRACKED && !this.#tracked.has(peer)) {
      for (const [address, failures] of this.#tracked) {
        if (now >= failures.since + ATTEMPT_WINDOW_MS) this.#tracked.delete(address);
      }
      if (this.#tracked.size >= TRACKED) {
        let oldest: string | null = null;
        let since = Infinity;
        for (const [address, failures] of this.#tracked) {
          if (failures.since < since) [oldest, since] = [address, failures.since];
        }
        if (oldest !== null) this.#tracked.delete(oldest);
      }
    }
    let failures = this.#tracked.get(peer);
    if (failures === undefined || now >= failures.since + ATTEMPT_WINDOW_MS) {
      failures = { since: now, count: 0 };
      this.#tracked.set(peer, failures);
    }
    failures.count += 1;
  }

  get size(): number {
    return this.#tracked.size;
  }
}

/** The address a request came from, with an IPv4-mapped IPv6 address as its IPv4 one;
 * requests served without one share a single address. */
export function peerAddress(address: string | null): string {
  if (address === null) return "0.0.0.0";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped === null ? address : mapped[1]!;
}

/** `429` for an address that is locked out for `waitMs`, with `Retry-After` in whole
 * seconds, rounded up. */
export function tooMany(surface: "API" | "MCP", waitMs: number): Response {
  const seconds = Math.ceil(waitMs / 1000);
  return text(
    429,
    `Toodo ${surface}: too many requests with a wrong token came from this address. Wait ${seconds} seconds, then retry with the right token (see the server's data directory: \`web-token\` for the web app, \`mcp-token\` for agents); stop clients that still send an old token, or this address is locked out again.\n`,
    { "retry-after": String(seconds) },
  );
}

/** The hash a device's token is stored as. Tokens are 32 random bytes, so a fast hash
 * without salt is enough: there is nothing to guess from a leaked hash. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Whether a read-only device `id` may make this request: it may read, keep its own
 * notifications, and revoke itself. */
export function readOnlyAllows(method: string, path: string, id: DeviceId, readCommands: ReadonlySet<string>): boolean {
  if (method === "GET" || method === "HEAD") return true;
  if (path.startsWith("/api/rpc/")) return readCommands.has(path.slice("/api/rpc/".length));
  return path.startsWith("/api/push/") || path === `/api/devices/${id}/revoke`;
}

export function readOnlyRefused(): Response {
  return json(
    403,
    new CommandError(
      "notPermitted",
      "this device signed in read-only, so it cannot change data; make the change on a device with full access, or revoke this device under Settings > Devices and sign in again with the shared web token, choosing full access",
    ),
  );
}

export function expired(): Response {
  return text(
    401,
    "Toodo API: this device's token has expired. Sign in to the web app again with the token in `web-token` in the server's data directory; the browser then gets a new device token.\n",
    { "www-authenticate": "Bearer" },
  );
}
