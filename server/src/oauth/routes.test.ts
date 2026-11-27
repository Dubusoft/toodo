import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tokenHash } from "../http/auth.ts";
import { oauthClient, oauthListGrants } from "../storage/oauth.ts";
import { memoryStorage } from "../storage/storage-fixtures.ts";
import type { Storage } from "../storage/storage.ts";
import { CONSENT_FAILURES, OAuthServer, resolveAccessToken } from "./routes.ts";
import { ALL_SCOPES, canWrite, hasScope, parseScopes, READ_SCOPES, serverOwner } from "./scopes.ts";

const VERIFIER = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const REDIRECT = "https://client.example/callback";
const HOST = "203.0.113.7";
const OTHER_HOST = "203.0.113.8";
const ISSUER = "https://toodo.example";

type Json = Record<string, any>;

/** An OAuth server on a new database whose clock starts at 1000, fetching `document` as every
 * client metadata document. */
function server(document: unknown = null) {
  let now = 1000;
  const storage: Storage = memoryStorage();
  storage.setClock(() => now);
  let fetches = 0;
  const s = new OAuthServer({
    issuer: ISSUER,
    webToken: "owner-web-token",
    storage,
    fetcher: async () => {
      fetches++;
      return new TextEncoder().encode(document === null ? "" : JSON.stringify(document));
    },
  });
  return { s, storage, setClock: (at: number) => (now = at), fetches: () => fetches };
}

type Send = {
  query?: Record<string, string>;
  form?: Record<string, string | undefined>;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  peer?: string;
};

async function send(s: OAuthServer, method: string, path: string, init: Send = {}): Promise<Response> {
  const url = new URL(path, ISSUER);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.append(key, value);
  const headers: Record<string, string> = { ...init.headers };
  let body: string | undefined = init.body;
  if (init.form !== undefined) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(init.form)) if (value !== undefined) form.append(key, value);
    body = form.toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  if (init.json !== undefined) body = JSON.stringify(init.json);
  const answer = s.route(new Request(url.href, { method, body, headers }), url.pathname, init.peer ?? HOST);
  if (answer === null) throw new Error(`${path} is not an OAuth route`);
  return answer;
}

async function register(s: OAuthServer, metadata: unknown): Promise<Response> {
  return send(s, "POST", "/oauth/register", { json: metadata });
}

async function client(s: OAuthServer, name = "Example client"): Promise<string> {
  const response = await register(s, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: name });
  expect(response.status).toBe(201);
  return ((await response.json()) as Json).client_id;
}

function query(id: string): Record<string, string> {
  return {
    response_type: "code",
    client_id: id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    state: "<state>&value",
  };
}

const authorize = (s: OAuthServer, q: Record<string, string>) => send(s, "GET", "/oauth/authorize", { query: q });

/** Starts an authorization for client `id` and returns the consent request it made. */
async function pending(s: OAuthServer, id: string, q = query(id)): Promise<string> {
  const before = new Set(s.pending.keys());
  const response = await authorize(s, q);
  expect(response.status).toBe(200);
  return [...s.pending.keys()].find((key) => !before.has(key))!;
}

function approval(id: string): Record<string, string | undefined> {
  return { pending_id: id, web_token: "owner-web-token", decision: "approve", write: "yes" };
}

const consent = (s: OAuthServer, form: Record<string, string | undefined>, peer = HOST) =>
  send(s, "POST", "/oauth/authorize", { form, peer });

function location(response: Response): URL {
  return new URL(response.headers.get("location")!);
}

/** An authorization code for client `id`, approved with both scopes. */
async function code(s: OAuthServer, id: string, q = query(id)): Promise<string> {
  const request = await pending(s, id, q);
  const response = await consent(s, approval(request));
  expect(response.status).toBe(303);
  const params = location(response).searchParams;
  expect(params.get("state")).toBe("<state>&value");
  expect(params.get("iss")).toBe(ISSUER);
  return params.get("code")!;
}

function exchange(id: string, code: string): Record<string, string | undefined> {
  return {
    grant_type: "authorization_code",
    client_id: id,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  };
}

function refreshForm(id: string, refresh: string): Record<string, string | undefined> {
  return { grant_type: "refresh_token", client_id: id, refresh_token: refresh };
}

const token = (s: OAuthServer, form: Record<string, string | undefined>, headers: Record<string, string> = {}) =>
  send(s, "POST", "/oauth/token", { form, headers });

async function pair(s: OAuthServer, id: string): Promise<Json> {
  const response = await token(s, exchange(id, await code(s, id)));
  expect(response.status).toBe(200);
  return (await response.json()) as Json;
}

async function error(response: Response): Promise<string> {
  return ((await response.json()) as Json).error;
}

describe("oauth routes", () => {
  test("scopes are independent and default to both", () => {
    expect(parseScopes(null)).toBe(ALL_SCOPES);
    const write = parseScopes("toodo.write");
    expect(hasScope(write, "read")).toBe(false);
    expect(canWrite(write)).toBe(true);
    expect(canWrite(READ_SCOPES)).toBe(false);
    for (const bad of ["unknown", "", " \t\r\n"]) expect(() => parseScopes(bad)).toThrow();
  });

  test("discovery metadata matches the issuer and supported protocols", async () => {
    const { s } = server();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await send(s, "GET", path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(
        '{"authorization_servers":["https://toodo.example"],"bearer_methods_supported":["header"],"resource":"https://toodo.example/mcp","resource_name":"Toodo","scopes_supported":["toodo.read","toodo.write"]}',
      );
    }
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      const metadata = (await (await send(s, "GET", path)).json()) as Json;
      expect(metadata.issuer).toBe(ISSUER);
      for (const [field, endpoint] of [
        ["authorization_endpoint", "authorize"],
        ["token_endpoint", "token"],
        ["registration_endpoint", "register"],
        ["revocation_endpoint", "revoke"],
      ]) {
        expect(metadata[field!]).toBe(`${ISSUER}/oauth/${endpoint}`);
      }
      expect(metadata.response_types_supported).toEqual(["code"]);
      expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
      expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
      expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_post", "client_secret_basic"]);
      expect(metadata.revocation_endpoint_auth_methods_supported).toEqual(metadata.token_endpoint_auth_methods_supported);
      expect(metadata.client_id_metadata_document_supported).toBe(true);
    }
  });

  test("registration issues only hashed secrets and rejects invalid metadata", async () => {
    const { s, storage } = server();
    for (const method of ["none", "client_secret_post", "client_secret_basic"]) {
      const response = await register(s, { redirect_uris: [REDIRECT], token_endpoint_auth_method: method });
      expect(response.status).toBe(201);
      const value = (await response.json()) as Json;
      const stored = oauthClient(storage.db, value.client_id)!;
      if (method === "none") {
        expect(value.client_secret).toBeUndefined();
        expect(stored.secretHash).toBeNull();
      } else {
        expect(stored.secretHash).toBe(tokenHash(value.client_secret));
        expect(stored.secretHash).not.toBe(value.client_secret);
      }
    }
    for (const [body, expected] of [
      [{}, "invalid_client_metadata"],
      [{ redirect_uris: [] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["http://not-loopback.example/cb"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["https://client.example/#fragment"] }, "invalid_redirect_uri"],
      [{ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_jwt" }, "invalid_client_metadata"],
      [{ redirect_uris: [REDIRECT], grant_types: ["password"] }, "invalid_client_metadata"],
      [{ redirect_uris: [REDIRECT], scope: "admin" }, "invalid_client_metadata"],
    ] as const) {
      const response = await register(s, body);
      expect(response.status).toBe(400);
      expect(await error(response)).toBe(expected);
    }
    const defaults = (await (await register(s, { redirect_uris: [REDIRECT] })).json()) as Json;
    expect(defaults.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(typeof defaults.client_secret).toBe("string");
    expect(Object.keys(defaults)).toEqual([...Object.keys(defaults)].sort());
    expect(defaults.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(defaults.scope).toBe("toodo.read toodo.write");
    expect(defaults.client_secret_expires_at).toBe(0);
  });

  test("client metadata documents are validated and cached", async () => {
    const id = "https://client.example/metadata.json";
    const { s, fetches } = server({ client_id: id, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    for (let i = 0; i < 2; i++) {
      const response = await authorize(s, query(id));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`<strong>${id}</strong>`);
    }
    expect(fetches()).toBe(1);
    expect((await authorize(s, query("https://client.example/"))).status).toBe(400);
    for (const document of [
      { client_id: "https://other.example/document", redirect_uris: [REDIRECT] },
      { client_id: id, redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" },
      { client_id: id, redirect_uris: [] },
    ]) {
      const response = await authorize(server(document).s, query(id));
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  test("the metadata document cache prunes expired documents and evicts the oldest at capacity", async () => {
    const id = "https://client.example/metadata.json";
    const { s } = server({ client_id: id, redirect_uris: [REDIRECT] });
    expect((await authorize(s, query(id))).status).toBe(200);
    const client = s.cache.get(id)!.client;
    const now = performance.now();
    s.cache.clear();
    for (let n = 0; n < 100; n++) s.cache.set(`https://client.example/${n}`, { at: now - (100 - n) * 1000, client });
    s.cache.set("https://client.example/expired", { at: now - 600_000, client });
    expect((await authorize(s, query(id))).status).toBe(200);
    expect(s.cache.size).toBe(100);
    expect(s.cache.has("https://client.example/expired")).toBe(false);
    expect(s.cache.has("https://client.example/0")).toBe(false);
    expect(s.cache.has("https://client.example/1")).toBe(true);
    expect(s.cache.has(id)).toBe(true);
  });

  test("authorization never redirects bad clients or redirects and requires S256 and the resource", async () => {
    const { s } = server();
    expect((await authorize(s, query("unknown"))).headers.get("location")).toBeNull();
    const id = await client(s);
    const attacker = { ...query(id), redirect_uri: "https://attacker.example/callback" };
    expect((await authorize(s, attacker)).headers.get("location")).toBeNull();
    for (const [method, resource, expected] of [
      ["plain", null, "invalid_request"],
      ["S256", "https://other.example/mcp", "invalid_target"],
    ] as const) {
      const q = { ...query(id), code_challenge_method: method, ...(resource === null ? {} : { resource }) };
      const response = await authorize(s, q);
      expect(response.status).toBe(303);
      expect(location(response).searchParams.get("error")).toBe(expected);
    }
    const { redirect_uri: _, ...withoutRedirect } = query(id);
    expect((await authorize(s, { ...withoutRedirect, resource: ISSUER })).status).toBe(200);
  });

  test("consent denial, a wrong token, and unticked write", async () => {
    const { s } = server();
    const id = await client(s);
    let request = await pending(s, id);
    const response = await consent(s, { ...approval(request), web_token: "wrong" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Enter the web sign-in token");
    expect(s.pending.has(request)).toBe(true);
    request = await pending(s, id);
    const denied = await consent(s, { pending_id: request, decision: "deny" });
    expect(location(denied).searchParams.get("error")).toBe("access_denied");
    expect(s.codes.size).toBe(0);
    expect(s.pending.has(request)).toBe(false);
    request = await pending(s, id);
    await consent(s, { ...approval(request), write: undefined });
    expect([...s.codes.values()][0]!.pending.scopes).toBe(READ_SCOPES);
  });

  test("wrong consent tokens lock the address out across requests", async () => {
    const { s } = server();
    const id = await client(s);
    for (let attempt = 1; attempt <= CONSENT_FAILURES; attempt++) {
      const request = await pending(s, id);
      const response = await consent(s, { ...approval(request), web_token: "wrong" });
      expect(response.status).toBe(attempt === CONSENT_FAILURES ? 429 : 200);
    }
    // A sixth attempt is refused even on a new consent request with the right token.
    const request = await pending(s, id);
    const response = await consent(s, approval(request));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(s.codes.size).toBe(0);
    // The request is kept, and another address is still heard.
    expect((await consent(s, approval(request), OTHER_HOST)).status).toBe(303);
  });

  test("the PKCE exchange rejects a wrong verifier and reuse revokes the grant", async () => {
    const { s, storage } = server();
    const id = await client(s);
    const issued = await code(s, id);
    const wrong = await token(s, { ...exchange(id, issued), code_verifier: "z".repeat(43) });
    expect(await error(wrong)).toBe("invalid_grant");
    const response = await token(s, exchange(id, issued));
    expect(response.headers.get("cache-control")).toBe("no-store");
    const tokens = (await response.json()) as Json;
    expect(Object.keys(tokens)).toEqual(["access_token", "expires_in", "refresh_token", "scope", "token_type"]);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    const live = resolveAccessToken(storage, tokens.access_token)!;
    expect(live.ownerKey).toBe(serverOwner());
    expect(live.scopes).toBe(ALL_SCOPES);
    expect(resolveAccessToken(storage, tokens.refresh_token)).toBeNull();
    expect((await token(s, exchange(id, issued))).status).toBe(400);
    expect(resolveAccessToken(storage, tokens.access_token)).toBeNull();
  });

  test("the token request may omit the redirect URI only when the authorization did", async () => {
    for (const included of [false, true]) {
      for (const redirect of [undefined, REDIRECT, "https://client.example/other"]) {
        const { s } = server();
        const id = await client(s);
        const { redirect_uri: _, ...withoutRedirect } = query(id);
        const issued = await code(s, id, included ? query(id) : withoutRedirect);
        const response = await token(s, { ...exchange(id, issued), redirect_uri: redirect });
        if (redirect === REDIRECT || (!included && redirect === undefined)) {
          expect(response.status).toBe(200);
        } else {
          expect(await error(response)).toBe("invalid_grant");
        }
      }
    }
  });

  test("write-only consent can be reduced to read", async () => {
    for (const write of [undefined, "yes"]) {
      const { s } = server();
      const id = await client(s);
      const request = await pending(s, id, { ...query(id), scope: "toodo.write" });
      const response = await consent(s, { ...approval(request), write });
      const issued = location(response).searchParams.get("code")!;
      const tokens = (await (await token(s, exchange(id, issued))).json()) as Json;
      expect(tokens.scope).toBe(write === undefined ? "toodo.read" : "toodo.write");
    }
  });

  test("refresh rotates, narrows, and a replay revokes the family", async () => {
    const { s, storage } = server();
    const id = await client(s);
    const original = await pair(s, id);
    const narrowed = (await (await token(s, { ...refreshForm(id, original.refresh_token), scope: "toodo.read" })).json()) as Json;
    expect(narrowed.scope).toBe("toodo.read");
    expect(narrowed.refresh_token).not.toBe(original.refresh_token);
    const widened = await token(s, { ...refreshForm(id, narrowed.refresh_token), scope: "toodo.write" });
    expect(await error(widened)).toBe("invalid_scope");
    expect(resolveAccessToken(storage, narrowed.access_token)!.scopes).toBe(READ_SCOPES);
    expect((await token(s, refreshForm(id, original.refresh_token))).status).toBe(400);
    expect(resolveAccessToken(storage, narrowed.access_token)).toBeNull();
  });

  test("revocation ignores other clients and accepts unknown tokens", async () => {
    const { s, storage } = server();
    const id = await client(s);
    const other = await client(s);
    for (const field of ["access_token", "refresh_token"]) {
      const tokens = await pair(s, id);
      const revoke = (clientId: string) =>
        send(s, "POST", "/oauth/revoke", { form: { client_id: clientId, token: tokens[field] } });
      expect((await revoke(other)).status).toBe(200);
      expect(resolveAccessToken(storage, tokens.access_token)).not.toBeNull();
      const response = await revoke(id);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(resolveAccessToken(storage, tokens.access_token)).toBeNull();
    }
    const unknown = await send(s, "POST", "/oauth/revoke", { form: { client_id: id, token: "unknown" } });
    expect(unknown.status).toBe(200);
    const missing = await send(s, "POST", "/oauth/revoke", { form: { client_id: id } });
    expect(await error(missing)).toBe("invalid_request");
  });

  test("expiry and last use follow the database clock", async () => {
    const { s, storage, setClock } = server();
    const id = await client(s);
    const tokens = await pair(s, id);
    expect(resolveAccessToken(storage, tokens.access_token)).not.toBeNull();
    expect(oauthListGrants(storage.db, storage.now())[0]!.lastUsedAt).toBe(1000);
    setClock(4600);
    expect(resolveAccessToken(storage, tokens.access_token)).toBeNull();
    setClock(1000 + 30 * 86400);
    expect((await token(s, refreshForm(id, tokens.refresh_token))).status).toBe(400);
  });

  test("pages escape untrusted client names and set security headers", async () => {
    const { s } = server();
    const id = await client(s, `<script>"'&</script>`);
    const response = await authorize(s, query(id));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    const page = await response.text();
    expect(page).toContain('<button name="decision" value="deny" formnovalidate>');
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;");
  });

  test("confidential clients authenticate only with their registered method", async () => {
    const { s } = server();
    for (const method of ["client_secret_post", "client_secret_basic"]) {
      const registration = (await (await register(s, { redirect_uris: [REDIRECT], token_endpoint_auth_method: method })).json()) as Json;
      const id: string = registration.client_id;
      const secret: string = registration.client_secret;
      const unknownToken = { client_id: id, token: "unknown" };
      const revoke = (form: Record<string, string | undefined>, headers: Record<string, string> = {}) =>
        send(s, "POST", "/oauth/revoke", { form, headers });
      const refused = await revoke(unknownToken);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toBe('Basic realm="oauth"');
      expect(await error(refused)).toBe("invalid_client");
      const basic = { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` };
      if (method === "client_secret_basic") {
        expect((await revoke(unknownToken, basic)).status).toBe(200);
        expect((await revoke({ ...unknownToken, client_secret: secret })).status).toBe(401);
        expect((await revoke({ ...unknownToken, client_secret: "wrong" }, basic)).status).toBe(401);
      } else {
        expect((await revoke({ ...unknownToken, client_secret: secret })).status).toBe(200);
        expect((await revoke(unknownToken, basic)).status).toBe(401);
        expect((await revoke({ ...unknownToken, client_secret: "wrong" })).status).toBe(401);
      }
    }
  });

  test("pending requests and unused codes expire without grants", async () => {
    const { s, storage, setClock } = server();
    const id = await client(s);
    const request = await pending(s, id);
    setClock(1600);
    expect((await consent(s, approval(request))).status).toBe(400);
    const issued = await code(s, id);
    setClock(1660);
    expect(await error(await token(s, exchange(id, issued)))).toBe("invalid_grant");
    expect(oauthListGrants(storage.db, storage.now())).toEqual([]);
  });

  test("malformed forms and other methods are refused", async () => {
    const { s } = server();
    for (const path of ["/oauth/token", "/oauth/revoke"]) {
      const response = await send(s, "POST", path, { body: "not-a-form" });
      expect(response.status).toBe(400);
      expect(await error(response)).toBe("invalid_request");
    }
    const consentResponse = await send(s, "POST", "/oauth/authorize", { body: "not-a-form" });
    expect(consentResponse.status).toBe(400);
    expect(consentResponse.headers.get("x-frame-options")).toBe("DENY");
    const twice = await send(s, "GET", "/oauth/authorize?client_id=a&client_id=b");
    expect(twice.status).toBe(400);
    expect(await twice.text()).toContain("valid authorization parameters");
    const wrongMethod = await send(s, "GET", "/oauth/token");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect((await send(s, "DELETE", "/oauth/authorize")).headers.get("allow")).toBe("GET,HEAD,POST");
    expect(s.route(new Request(`${ISSUER}/oauth/other`), "/oauth/other", HOST)).toBeNull();
  });

  test("the redirect keeps the registered query and appends the answer", async () => {
    const { s } = server();
    const redirect = "https://client.example/callback?app=a%20b";
    const registered = (await (await register(s, { redirect_uris: [redirect], token_endpoint_auth_method: "none" })).json()) as Json;
    const request = await pending(s, registered.client_id, { ...query(registered.client_id), redirect_uri: redirect });
    const response = await consent(s, approval(request));
    expect(response.headers.get("location")).toStartWith(
      "https://client.example/callback?app=a%20b&code=",
    );
    expect(response.headers.get("location")).toEndWith("&state=%3Cstate%3E%26value&iss=https%3A%2F%2Ftoodo.example");
  });

  test("exchanged codes have a bounded replay detection window", async () => {
    const { s, setClock } = server();
    const id = await client(s);
    const original = await code(s, id);
    expect((await token(s, exchange(id, original))).status).toBe(200);
    setClock(1659);
    await code(s, id);
    expect(s.codes.has(tokenHash(original))).toBe(true);
    setClock(1660);
    await code(s, id);
    expect(s.codes.has(tokenHash(original))).toBe(false);
  });
});
