// Dynamic client registration metadata and client ID metadata documents: what a client
// registers or publishes, how it is checked, and how a `client_id` resolves to a client.
// Port of `src-tauri/src/oauth/clients.rs`.

import { isWebUrl } from "../http/config.ts";
import { publicTarget } from "../net.ts";
import type { Storage } from "../storage/storage.ts";
import { type Client, oauthClient } from "../storage/oauth.ts";
import { OAuthError } from "./errors.ts";
import { parseScopes, ScopesError } from "./scopes.ts";

/** Fetches the client metadata document at `url`; throws when there is none to read. */
export type ClientMetadataFetcher = (url: string) => Promise<Uint8Array>;

/** The largest metadata document read, in bytes. */
const DOCUMENT_LIMIT = 65536;

/** How long a metadata document is fetched and then kept, in milliseconds. */
const FETCH_TIMEOUT_MS = 5000;
const CACHE_FOR_MS = 600_000;
const CACHED_DOCUMENTS = 100;

/** Fetches at most 64 KiB within five seconds from a public address, without redirects. */
export function httpClientMetadataFetcher(): ClientMetadataFetcher {
  return async (target) => {
    const invalid = () =>
      new Error("Publish a JSON client metadata document at the HTTPS client_id URL, without redirects and below 64 KiB.");
    // The timeout also bounds a slow response body.
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
      const url = await publicTarget(target);
      const response = await fetch(url, { redirect: "manual", signal });
      const type = response.headers.get("content-type");
      if (!response.ok || type === null || type.split(";")[0]!.trim() !== "application/json") {
        await response.body?.cancel();
        throw invalid();
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body ?? []) {
        length += chunk.length;
        if (length > DOCUMENT_LIMIT) throw invalid();
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch {
      throw invalid();
    }
  };
}

/** What a client registers, or publishes as its metadata document. */
export interface Metadata {
  redirect_uris: string[];
  client_name: string | null;
  token_endpoint_auth_method: string | null;
  grant_types: string[] | null;
  scope: string | null;
  client_id: string | null;
}

const optionalString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string";

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** `bytes` as metadata JSON, as `serde` reads `Metadata`; `null` when it is not. */
export function parseMetadata(bytes: Uint8Array): Metadata | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const grantTypes = fields.grant_types;
  if (
    !strings(fields.redirect_uris) ||
    !optionalString(fields.client_name) ||
    !optionalString(fields.token_endpoint_auth_method) ||
    !(grantTypes === undefined || grantTypes === null || strings(grantTypes)) ||
    !optionalString(fields.scope) ||
    !optionalString(fields.client_id)
  ) {
    return null;
  }
  return {
    redirect_uris: fields.redirect_uris,
    client_name: fields.client_name ?? null,
    token_endpoint_auth_method: fields.token_endpoint_auth_method ?? null,
    grant_types: grantTypes ?? null,
    scope: fields.scope ?? null,
    client_id: fields.client_id ?? null,
  };
}

function url(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function validScope(scope: string | null): boolean {
  try {
    parseScopes(scope);
    return true;
  } catch (error) {
    if (error instanceof ScopesError) return false;
    throw error;
  }
}

/** The authentication method `metadata` registers; `cimd` holds a metadata document to the
 * public clients they describe. */
export function validateMetadata(metadata: Metadata, cimd: boolean): string {
  const badRedirect = (value: string) => {
    const parsed = url(value);
    // A `#` anywhere starts the fragment, so a URL has one exactly when its text has a `#`.
    return parsed === null || !isWebUrl(parsed) || value.includes("#");
  };
  if (metadata.redirect_uris.length === 0 || metadata.redirect_uris.some(badRedirect)) {
    throw OAuthError.bad(
      "invalid_redirect_uri",
      "Register at least one HTTPS redirect URI (or HTTP loopback URI), without credentials or fragments.",
    );
  }
  const method = metadata.token_endpoint_auth_method ?? (cimd ? "none" : "client_secret_basic");
  if (
    !["none", "client_secret_post", "client_secret_basic"].includes(method) ||
    (cimd && method !== "none") ||
    (metadata.grant_types ?? []).some((type) => type !== "authorization_code" && type !== "refresh_token") ||
    !validScope(metadata.scope)
  ) {
    throw OAuthError.bad(
      "invalid_client_metadata",
      "Register supported scopes, authorization_code/refresh_token grant types, and a supported authentication method; metadata documents must use none.",
    );
  }
  return method;
}

export function metadataClient(metadata: Metadata, id: string, method: string, secretHash: string | null, at: number): Client {
  return {
    clientId: id,
    clientName: metadata.client_name,
    redirectUris: [...metadata.redirect_uris],
    authMethod: method,
    secretHash,
    createdAt: at,
  };
}

/** Metadata documents fetched in the last ten minutes, by `client_id`, with the
 * `performance.now()` they were fetched at. */
export type ClientCache = Map<string, { at: number; client: Client }>;

export interface ClientSource {
  readonly storage: Storage;
  readonly fetcher: ClientMetadataFetcher;
  readonly cache: ClientCache;
}

/** The registered client `id`, else the client its HTTPS metadata document describes. */
export async function resolveClient(source: ClientSource, id: string): Promise<Client> {
  let registered: Client | null;
  try {
    registered = oauthClient(source.storage.db, id);
  } catch {
    throw OAuthError.internal();
  }
  if (registered !== null) return registered;
  const invalid = () =>
    OAuthError.bad(
      "invalid_client",
      "Register the client or publish a valid HTTPS client_id metadata document, then start the connection again from the app.",
    );
  const parsed = url(id);
  if (parsed === null || parsed.protocol !== "https:" || !isWebUrl(parsed) || parsed.pathname === "/" || id.includes("#")) {
    throw invalid();
  }
  const cached = source.cache.get(id);
  if (cached !== undefined && performance.now() - cached.at < CACHE_FOR_MS) return cached.client;
  let bytes: Uint8Array;
  try {
    bytes = await source.fetcher(id);
  } catch {
    throw invalid();
  }
  if (bytes.length > DOCUMENT_LIMIT) throw invalid();
  const metadata = parseMetadata(bytes);
  if (metadata === null || metadata.client_id !== id) throw invalid();
  const method = validateMetadata(metadata, true);
  const client = metadataClient(metadata, id, method, null, source.storage.now());
  const now = performance.now();
  for (const [key, entry] of source.cache) {
    if (now - entry.at >= CACHE_FOR_MS) source.cache.delete(key);
  }
  source.cache.set(id, { at: now, client });
  if (source.cache.size > CACHED_DOCUMENTS) {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [key, entry] of source.cache) {
      if (entry.at < at) [oldest, at] = [key, entry.at];
    }
    if (oldest !== null) source.cache.delete(oldest);
  }
  return client;
}
