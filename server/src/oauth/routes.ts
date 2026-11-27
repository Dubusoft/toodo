// The authorization server chat apps connect through in public mode (`TOODO_PUBLIC_URL`):
// discovery metadata, dynamic registration, the consent page, the token and revocation
// endpoints, and the short-lived, server-side consent requests and authorization codes.
// Port of `src-tauri/src/oauth/routes.rs` and `resolve_access_token` of
// `src-tauri/src/oauth/mod.rs`.

import { createHash } from "node:crypto";
import { FailedAttempts, sameSecret, tokenHash } from "../http/auth.ts";
import { randomToken } from "../http/tokens.ts";
import {
  type Client,
  type Grant,
  oauthAccess,
  oauthCreateGrant,
  oauthRegisterClient,
  oauthRevokeGrant,
  oauthRevokeToken,
  oauthRotate,
} from "../storage/oauth.ts";
import type { Storage } from "../storage/storage.ts";
import {
  type ClientCache,
  type ClientMetadataFetcher,
  type ClientSource,
  metadataClient,
  parseMetadata,
  resolveClient,
  validateMetadata,
} from "./clients.ts";
import { jsonResponse, OAuthError } from "./errors.ts";
import {
  formatScopes,
  hasScope,
  type OwnerKey,
  parseScopes,
  READ_SCOPES,
  type Scopes,
  ScopesError,
  serverOwner,
} from "./scopes.ts";

/** Wrong web sign-in tokens an address may enter on consent pages within a minute before it
 * is locked out. */
export const CONSENT_FAILURES = 5;

/** The most consent requests kept at once; the oldest is dropped beyond it. */
const MAX_PENDING = 1000;

/** How long a consent request, an authorization code, and the replay detection of an
 * exchanged code last, in seconds. */
const PENDING_FOR = 600;
const CODE_FOR = 60;
const REPLAY_FOR = 600;

/** The largest request body read, as axum's default body limit. */
const BODY_LIMIT = 2 * 1024 * 1024;

const SCOPES_SUPPORTED = ["toodo.read", "toodo.write"];
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];

/** The access a live access token grants. Refresh tokens never authenticate. */
export function resolveAccessToken(storage: Storage, token: string): Grant | null {
  return oauthAccess(storage.db, tokenHash(token), storage.now());
}

interface Pending {
  client: Client;
  redirect: string;
  /** Whether the authorization request named the redirect URI, so the token request must. */
  redirectRequired: boolean;
  challenge: string;
  scopes: Scopes;
  state: string | null;
  resource: string;
  expires: number;
}

interface Code {
  pending: Pending;
  owner: OwnerKey;
  expires: number;
  /** The grant the code was exchanged for; presenting the code again revokes it. */
  grantId: number | null;
}

export interface OAuthOptions {
  issuer: string;
  webToken: string;
  storage: Storage;
  fetcher: ClientMetadataFetcher;
}

/** The methods each route answers; a `GET` route answers `HEAD` too. */
const ROUTES = new Map<string, readonly string[]>([
  ["/.well-known/oauth-protected-resource", ["GET"]],
  ["/.well-known/oauth-protected-resource/mcp", ["GET"]],
  ["/.well-known/oauth-authorization-server", ["GET"]],
  ["/.well-known/openid-configuration", ["GET"]],
  ["/oauth/register", ["POST"]],
  ["/oauth/authorize", ["GET", "POST"]],
  ["/oauth/token", ["POST"]],
  ["/oauth/revoke", ["POST"]],
]);

const AUTHORIZE_FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
] as const;
const CONSENT_FIELDS = ["pending_id", "web_token", "decision", "read", "write"] as const;
const TOKEN_FIELDS = [
  "grant_type",
  "client_id",
  "client_secret",
  "code",
  "redirect_uri",
  "code_verifier",
  "refresh_token",
  "scope",
  "token",
  "token_type_hint",
] as const;

type Fields<K extends string> = Partial<Record<K, string>>;

/** The fields `known` names in `params`, as `serde_urlencoded` reads them into a struct:
 * other fields are ignored, and a known field sent twice rejects the whole form. */
function fields<K extends string>(params: URLSearchParams, known: readonly K[]): Fields<K> | null {
  const found = new Map<K, string>();
  for (const [key, value] of params) {
    const field = known.find((name) => name === key);
    if (field === undefined) continue;
    if (found.has(field)) return null;
    found.set(field, value);
  }
  return Object.fromEntries(found) as Fields<K>;
}

async function body(request: Request): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request.body ?? []) {
    length += chunk.length;
    if (length > BODY_LIMIT) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const tooLarge = () =>
  new Response("Failed to buffer the request body: length limit exceeded", {
    status: 413,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/** The fields of a form body, as axum's `Form` reads it; `null` when it rejects the request
 * for its content type or fields, `"too_large"` past the body limit. */
async function form<K extends string>(request: Request, known: readonly K[]): Promise<Fields<K> | null | "too_large"> {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return null;
  const bytes = await body(request);
  if (bytes === null) return "too_large";
  return fields(new URLSearchParams(new TextDecoder().decode(bytes)), known);
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A page of the consent flow, framed and sent so no other site can embed or read it. */
function html(status: number, content: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Toodo connection</title><style>
body { font: 1rem system-ui; margin: 3rem auto; padding: 0 1rem; max-width: 32rem; line-height: 1.6; color: #222; background: #fff; }
label { display: block; margin: 1rem 0; } input[type=password] { box-sizing: border-box; width: 100%; padding: .6rem; } button { padding: .6rem 1rem; margin-right: .5rem; }
@media (prefers-color-scheme: dark) { body { background: #171717; color: #eee; } input, button { background: #333; color: #eee; } }
</style><main><h1>Connect to Toodo</h1>${content}</main></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

/** `429` for an address that entered too many wrong sign-in tokens, with `Retry-After`. */
function lockedOut(waitMs: number): Response {
  const seconds = Math.ceil(waitMs / 1000);
  const response = html(
    429,
    `Too many incorrect sign-in tokens came from this address. Wait ${seconds} seconds, then go back and approve again with the web sign-in token from the server data directory.`,
  );
  response.headers.set("retry-after", String(seconds));
  return response;
}

function consentPage(id: string, pending: Pending, error: string): Response {
  const host = new URL(pending.redirect).hostname;
  let checkboxes = '<label><input type="checkbox" checked disabled> Read workspaces and tasks (toodo.read)</label>';
  if (hasScope(pending.scopes, "write")) {
    checkboxes +=
      '<label><input type="checkbox" name="write" value="yes" checked> Create and update workspaces and tasks (toodo.write)</label>';
  }
  return html(
    200,
    `<p><strong>${escape(pending.client.clientName ?? pending.client.clientId)}</strong> requests access. Return to ${escape(host)}.</p><p>${escape(error)}</p><form method="post" action="/oauth/authorize"><input type="hidden" name="pending_id" value="${escape(id)}">${checkboxes}<label>Web sign-in token<input type="password" name="web_token" required autocomplete="off"></label><button name="decision" value="approve">Approve</button><button name="decision" value="deny" formnovalidate>Deny</button></form>`,
  );
}

/** Basic credentials: `client_id:client_secret`, each form-urlencoded before base64. */
function decodeBasic(value: string): [string, string] | null {
  if (!value.startsWith("Basic ")) return null;
  const encoded = value.slice("Basic ".length);
  // Canonical padded base64 only, as the `base64` crate's standard engine reads it.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || Buffer.from(encoded, "base64").toString("base64") !== encoded) {
    return null;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const unescape = (part: string) => {
    try {
      return new URL(`https://localhost/?value=${part}`).searchParams.get("value");
    } catch {
      return null;
    }
  };
  const id = unescape(decoded.slice(0, colon));
  const secret = unescape(decoded.slice(colon + 1));
  return id === null || secret === null ? null : [id, secret];
}

function verifierMatches(verifier: string, challenge: string): boolean {
  return (
    /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) &&
    sameSecret(createHash("sha256").update(verifier).digest("base64url"), challenge)
  );
}

/** Whether `challenge` is the unpadded base64url of a SHA-256 digest. */
function s256Challenge(challenge: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  // 43 characters carry 258 bits; the two past the digest must be zero.
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(challenge[42]!);
  return (last & 3) === 0;
}

/** The authorization server, mounted only in public mode. */
export class OAuthServer implements ClientSource {
  readonly issuer: string;
  readonly storage: Storage;
  readonly fetcher: ClientMetadataFetcher;
  readonly cache: ClientCache = new Map();
  readonly pending = new Map<string, Pending>();
  /** Authorization codes by their digest. */
  readonly codes = new Map<string, Code>();
  /** Wrong web sign-in tokens entered on consent pages, per address, whatever request they
   * were entered for. */
  readonly attempts = new FailedAttempts(CONSENT_FAILURES);
  readonly #webToken: string;

  constructor(options: OAuthOptions) {
    this.issuer = options.issuer;
    this.storage = options.storage;
    this.fetcher = options.fetcher;
    this.#webToken = options.webToken;
  }

  get resource(): string {
    return `${this.issuer}/mcp`;
  }

  /** The answer to `request`, which came from `peer`, when `pathname` is one of these routes;
   * `null` when it is not. */
  route(request: Request, pathname: string, peer: string): Promise<Response> | null {
    const methods = ROUTES.get(pathname);
    if (methods === undefined) return null;
    const method = request.method === "HEAD" && methods.includes("GET") ? "GET" : request.method;
    if (!methods.includes(method)) {
      const allow = methods.flatMap((name) => (name === "GET" ? ["GET", "HEAD"] : [name])).join(",");
      return Promise.resolve(new Response(null, { status: 405, headers: { allow } }));
    }
    return this.#answer(request, method, pathname, peer).catch((error: unknown) => {
      if (error instanceof OAuthError) return error.response();
      console.error(`toodo-server: OAuth ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
      return OAuthError.internal().response();
    });
  }

  async #answer(request: Request, method: string, pathname: string, peer: string): Promise<Response> {
    switch (pathname) {
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return this.resourceMetadata();
      case "/.well-known/oauth-authorization-server":
      case "/.well-known/openid-configuration":
        return this.serverMetadata();
      case "/oauth/register": {
        const bytes = await body(request);
        return bytes === null ? tooLarge() : this.register(bytes);
      }
      case "/oauth/authorize": {
        if (method === "GET") {
          const query = fields(new URL(request.url).searchParams, AUTHORIZE_FIELDS);
          if (query === null) {
            return html(400, "Start the connection again from the app with valid authorization parameters.");
          }
          return this.authorize(query);
        }
        const consent = await form(request, CONSENT_FIELDS);
        if (consent === "too_large") return tooLarge();
        if (consent === null || consent.pending_id === undefined || consent.decision === undefined) {
          return html(400, "Start the connection again from the app and submit the consent form.");
        }
        return this.consent(peer, { ...consent, pending_id: consent.pending_id, decision: consent.decision });
      }
      case "/oauth/token":
      case "/oauth/revoke": {
        const token = await form(request, TOKEN_FIELDS);
        if (token === "too_large") return tooLarge();
        if (token === null) {
          throw OAuthError.bad(
            "invalid_request",
            pathname === "/oauth/token"
              ? "Send token parameters as application/x-www-form-urlencoded form fields."
              : "Send token and client authentication as application/x-www-form-urlencoded form fields.",
          );
        }
        return pathname === "/oauth/token" ? this.token(request.headers, token) : this.revoke(request.headers, token);
      }
      default:
        throw new Error(`no handler for ${pathname}`);
    }
  }

  resourceMetadata(): Response {
    return jsonResponse(200, {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
      resource_name: "Toodo",
    });
  }

  serverMetadata(): Response {
    const issuer = this.issuer;
    return jsonResponse(200, {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
      scopes_supported: SCOPES_SUPPORTED,
      client_id_metadata_document_supported: true,
    });
  }

  register(bytes: Uint8Array): Response {
    const metadata = parseMetadata(bytes);
    if (metadata === null) {
      throw OAuthError.bad(
        "invalid_client_metadata",
        "Send JSON metadata with a nonempty redirect_uris array and supported authentication method.",
      );
    }
    const method = validateMetadata(metadata, false);
    const id = randomToken();
    const secret = method === "none" ? null : randomToken();
    let at: number;
    try {
      at = this.storage.now();
      const client = metadataClient(metadata, id, method, secret === null ? null : tokenHash(secret), at);
      oauthRegisterClient(this.storage.db, client, at);
    } catch {
      throw OAuthError.internal();
    }
    const result: Record<string, unknown> = {
      client_id: id,
      client_id_issued_at: at,
      client_secret_expires_at: 0,
      redirect_uris: metadata.redirect_uris,
      token_endpoint_auth_method: method,
      grant_types: metadata.grant_types ?? ["authorization_code", "refresh_token"],
      scope: formatScopes(parseScopes(metadata.scope)),
    };
    if (metadata.client_name !== null) result.client_name = metadata.client_name;
    if (secret !== null) result.client_secret = secret;
    return jsonResponse(201, result);
  }

  async authorize(query: Fields<(typeof AUTHORIZE_FIELDS)[number]>): Promise<Response> {
    let client: Client;
    try {
      client = await resolveClient(this, query.client_id ?? "");
    } catch (error) {
      if (error instanceof OAuthError) return html(400, escape(error.description));
      throw error;
    }
    const redirectRequired = query.redirect_uri !== undefined;
    let redirect: string;
    if (query.redirect_uri !== undefined && client.redirectUris.includes(query.redirect_uri)) {
      redirect = query.redirect_uri;
    } else if (query.redirect_uri === undefined && client.redirectUris.length === 1) {
      redirect = client.redirectUris[0]!;
    } else {
      return html(400, "Register the redirect URI, then start the connection again from the app.");
    }
    const state = query.state ?? null;
    const fail = (error: string, description: string) => this.#redirectError(redirect, state, error, description);
    if (query.response_type !== "code") {
      return fail("unsupported_response_type", "Request response_type=code from the app.");
    }
    const challenge = query.code_challenge;
    if (challenge === undefined || query.code_challenge_method !== "S256" || !s256Challenge(challenge)) {
      return fail("invalid_request", "Start the connection again with an S256 PKCE code challenge.");
    }
    let scopes: Scopes;
    try {
      scopes = parseScopes(query.scope ?? null);
    } catch (error) {
      if (error instanceof ScopesError) return fail("invalid_scope", error.message);
      throw error;
    }
    if (query.resource !== undefined && query.resource !== this.resource && query.resource !== this.issuer) {
      return fail(
        "invalid_target",
        "Request the issuer URL or its /mcp resource, then start the connection again from the app.",
      );
    }
    const id = randomToken();
    const now = this.storage.now();
    const pending: Pending = {
      client,
      redirect,
      redirectRequired,
      challenge,
      scopes,
      state,
      resource: query.resource ?? this.resource,
      expires: now + PENDING_FOR,
    };
    const response = consentPage(id, pending, "");
    for (const [key, request] of this.pending) {
      if (request.expires <= now) this.pending.delete(key);
    }
    // Anyone can start an authorization for a registered client; bound what they can hold.
    if (this.pending.size >= MAX_PENDING) {
      let oldest: string | null = null;
      let expires = Infinity;
      for (const [key, request] of this.pending) {
        if (request.expires < expires) [oldest, expires] = [key, request.expires];
      }
      if (oldest !== null) this.pending.delete(oldest);
    }
    this.pending.set(id, pending);
    return response;
  }

  consent(
    peer: string,
    form: Fields<(typeof CONSENT_FIELDS)[number]> & { pending_id: string; decision: string },
  ): Response {
    const now = this.storage.now();
    const pending = this.pending.get(form.pending_id);
    this.pending.delete(form.pending_id);
    if (pending === undefined || pending.expires <= now) {
      return html(400, "Start the connection again from the app; this consent request has expired.");
    }
    if (form.decision === "deny") {
      return this.#redirectError(
        pending.redirect,
        pending.state,
        "access_denied",
        "Start the connection again from the app and approve it to grant access.",
      );
    }
    // The lockout is per address, so starting new consent requests gains no guesses; the
    // request is kept for when the wait is over.
    const keep = () => this.pending.set(form.pending_id, pending);
    let wait = this.attempts.lockedOut(peer);
    if (wait !== null) {
      keep();
      return lockedOut(wait);
    }
    if (!sameSecret(form.web_token ?? "", this.#webToken)) {
      this.attempts.record(peer);
      wait = this.attempts.lockedOut(peer);
      keep();
      if (wait !== null) return lockedOut(wait);
      return consentPage(
        form.pending_id,
        pending,
        "Enter the web sign-in token from the server data directory and approve again.",
      );
    }
    if (form.decision !== "approve") {
      keep();
      return consentPage(form.pending_id, pending, "Choose Approve or Deny to continue.");
    }
    // Write-only approval keeps its scope; unticking write always grants read-only access.
    let granted = hasScope(pending.scopes, "read") ? 1 : 0;
    if (hasScope(pending.scopes, "write") && form.write !== undefined) granted |= 2;
    pending.scopes = granted === 0 ? READ_SCOPES : (granted as Scopes);
    const code = randomToken();
    const response = this.#redirectTo(pending.redirect, pending.state, [["code", code]]);
    for (const [key, issued] of this.codes) {
      if (!(issued.expires > now || (issued.grantId !== null && issued.expires + REPLAY_FOR > now))) {
        this.codes.delete(key);
      }
    }
    this.codes.set(tokenHash(code), { pending, owner: serverOwner(), expires: now + CODE_FOR, grantId: null });
    return response;
  }

  /** A `303` to `uri` with `pairs`, the request's `state`, and the issuer appended to its
   * query, which keeps what the client registered there as it is. */
  #redirectTo(uri: string, state: string | null, pairs: Array<[string, string]>): Response {
    const url = new URL(uri);
    const added = new URLSearchParams(pairs);
    if (state !== null) added.append("state", state);
    added.append("iss", this.issuer);
    const existing = url.search.slice(1);
    url.search = existing === "" ? added.toString() : `${existing}&${added.toString()}`;
    return new Response(null, { status: 303, headers: { location: url.href, "cache-control": "no-store" } });
  }

  #redirectError(uri: string, state: string | null, error: string, description: string): Response {
    return this.#redirectTo(uri, state, [
      ["error", error],
      ["error_description", description],
    ]);
  }

  /** The client `headers` and `form` authenticate as, by the method it registered. */
  async authenticate(headers: Headers, form: Fields<(typeof TOKEN_FIELDS)[number]>): Promise<Client> {
    const authorization = headers.get("authorization");
    let basic: [string, string] | null = null;
    if (authorization !== null) {
      // A header value must be visible ASCII to be read as text.
      if (!/^[\t\x20-\x7e]*$/.test(authorization)) throw OAuthError.client();
      basic = decodeBasic(authorization);
      if (basic === null) throw OAuthError.client();
    }
    if (basic !== null && form.client_secret !== undefined) throw OAuthError.client();
    const id = basic?.[0] ?? form.client_id;
    if (id === undefined) throw OAuthError.client();
    if (basic !== null && form.client_id !== undefined && form.client_id !== basic[0]) throw OAuthError.client();
    let client: Client;
    try {
      client = await resolveClient(this, id);
    } catch {
      throw OAuthError.client();
    }
    let secret: string | undefined;
    if (client.authMethod === "none" && basic === null && form.client_secret === undefined) return client;
    if (client.authMethod === "client_secret_basic") secret = basic?.[1];
    else if (client.authMethod === "client_secret_post" && basic === null) secret = form.client_secret;
    if (secret === undefined) throw OAuthError.client();
    if (client.secretHash === null || !sameSecret(tokenHash(secret), client.secretHash)) throw OAuthError.client();
    return client;
  }

  async token(headers: Headers, form: Fields<(typeof TOKEN_FIELDS)[number]>): Promise<Response> {
    const client = await this.authenticate(headers, form);
    const access = randomToken();
    const refresh = randomToken();
    const tokens = { accessHash: tokenHash(access), refreshHash: tokenHash(refresh) };
    let scopes: Scopes;
    switch (form.grant_type) {
      case "authorization_code":
        scopes = this.#redeem(client, form, tokens);
        break;
      case "refresh_token":
        scopes = this.#rotate(client, form, tokens);
        break;
      case undefined:
        throw OAuthError.bad("invalid_request", "Send grant_type=authorization_code or grant_type=refresh_token.");
      default:
        throw OAuthError.bad("unsupported_grant_type", "Use authorization_code or refresh_token as grant_type.");
    }
    return jsonResponse(200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: formatScopes(scopes),
    });
  }

  /** Exchanges the authorization code in `form` for a grant with `tokens`. A code is redeemed
   * once: presenting it again revokes the grant it was exchanged for. */
  #redeem(
    client: Client,
    form: Fields<(typeof TOKEN_FIELDS)[number]>,
    tokens: { accessHash: string; refreshHash: string },
  ): Scopes {
    const code = this.codes.get(tokenHash(form.code ?? ""));
    if (code === undefined) throw OAuthError.grant();
    const { pending } = code;
    if (
      pending.client.clientId !== client.clientId ||
      ((pending.redirectRequired || form.redirect_uri !== undefined) && form.redirect_uri !== pending.redirect) ||
      !verifierMatches(form.code_verifier ?? "", pending.challenge)
    ) {
      throw OAuthError.grant();
    }
    if (code.grantId !== null) {
      try {
        oauthRevokeGrant(this.storage.db, code.grantId, this.storage.now());
      } catch {
        throw OAuthError.internal();
      }
      throw OAuthError.grant();
    }
    if (code.expires <= this.storage.now() || (pending.resource !== this.resource && pending.resource !== this.issuer)) {
      throw OAuthError.grant();
    }
    try {
      code.grantId = oauthCreateGrant(
        this.storage.db,
        { owner: code.owner, client, scopes: pending.scopes, tokens },
        this.storage.now(),
      );
    } catch {
      throw OAuthError.internal();
    }
    return pending.scopes;
  }

  #rotate(
    client: Client,
    form: Fields<(typeof TOKEN_FIELDS)[number]>,
    tokens: { accessHash: string; refreshHash: string },
  ): Scopes {
    let requested: Scopes | null = null;
    if (form.scope !== undefined) {
      try {
        requested = parseScopes(form.scope);
      } catch (error) {
        if (error instanceof ScopesError) throw OAuthError.bad("invalid_scope", error.message);
        throw error;
      }
    }
    let result;
    try {
      result = oauthRotate(
        this.storage.db,
        { hash: tokenHash(form.refresh_token ?? ""), clientId: client.clientId, requested, tokens },
        this.storage.now(),
      );
    } catch {
      throw OAuthError.internal();
    }
    switch (result.kind) {
      case "issued":
        return result.scopes;
      case "invalid":
        throw OAuthError.grant();
      case "invalid_scope":
        throw OAuthError.bad("invalid_scope", "Request the same scopes or fewer scopes than the current refresh grant.");
    }
  }

  async revoke(headers: Headers, form: Fields<(typeof TOKEN_FIELDS)[number]>): Promise<Response> {
    const client = await this.authenticate(headers, form);
    if (form.token === undefined) {
      throw OAuthError.bad("invalid_request", "Send the token to revoke in the token form field.");
    }
    try {
      oauthRevokeToken(this.storage.db, { hash: tokenHash(form.token), clientId: client.clientId }, this.storage.now());
    } catch {
      throw OAuthError.internal();
    }
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }
}
