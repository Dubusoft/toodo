// OAuth persistence. Only SHA-256 digests of credentials reach this module. Port of
// `src-tauri/src/storage/oauth.rs`. Functions that act at a time take it (`at`, Unix
// seconds) from the caller.

import type { Database } from "bun:sqlite";

import {
  type OwnerKey,
  type Scopes,
  ScopesError,
  formatScopes,
  isSubsetOf,
  ownerKey,
  parseScopes,
} from "../oauth/scopes.ts";
import { StorageError } from "./errors.ts";

export interface Client {
  clientId: string;
  secretHash: string | null;
  clientName: string | null;
  redirectUris: string[];
  authMethod: string;
  createdAt: number;
}

export interface Grant {
  id: number;
  ownerKey: OwnerKey;
  clientId: string;
  clientName: string | null;
  scopes: Scopes;
  createdAt: number;
  lastUsedAt: number | null;
}

/** The digests of a freshly issued access and refresh token. */
export interface TokenPair {
  accessHash: string;
  refreshHash: string;
}

export interface NewGrant {
  owner: OwnerKey;
  client: Client;
  scopes: Scopes;
  tokens: TokenPair;
}

/** A refresh request: the presented refresh digest, its client, and the tokens to issue. */
export interface Refresh {
  hash: string;
  clientId: string;
  /** `null` keeps the grant's scopes. */
  requested: Scopes | null;
  tokens: TokenPair;
}

export type RefreshResult =
  | { kind: "issued"; scopes: Scopes }
  | { kind: "invalid" }
  | { kind: "invalid_scope" };

interface ClientRow {
  client_id: string;
  secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string;
  auth_method: string;
  created_at: number;
}

interface GrantRow {
  id: number;
  owner_key: string;
  client_id: string;
  client_name: string | null;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
}

function grant(row: GrantRow): Grant {
  let scopes: Scopes;
  try {
    scopes = parseScopes(row.scopes);
  } catch (error) {
    if (error instanceof ScopesError) {
      throw new StorageError({ kind: "invalid_data", reason: error.message });
    }
    throw error;
  }
  return {
    id: row.id,
    ownerKey: ownerKey(row.owner_key),
    clientId: row.client_id,
    clientName: row.client_name,
    scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function redirectUris(stored: string): string[] {
  const invalid = () =>
    new StorageError({ kind: "invalid_data", reason: `invalid redirect URIs ${stored}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || !parsed.every((uri) => typeof uri === "string")) {
    throw invalid();
  }
  return parsed;
}

const GRANT_COLUMNS =
  "g.id, g.owner_key, g.client_id, g.client_name, g.scopes, g.created_at, g.last_used_at";

/** Inserts a registered client and bounds clients without a live grant to 200. */
export function oauthRegisterClient(db: Database, client: Client, at: number): void {
  const redirects = JSON.stringify(client.redirectUris);
  db.transaction(() => {
    db.run("INSERT INTO oauth_clients VALUES (?1, ?2, ?3, ?4, ?5, ?6)", [
      client.clientId,
      client.secretHash,
      client.clientName,
      redirects,
      client.authMethod,
      client.createdAt,
    ]);
    db.run(
      `DELETE FROM oauth_clients WHERE client_id IN (
          SELECT c.client_id FROM oauth_clients c WHERE NOT EXISTS (
              SELECT 1 FROM oauth_grants g JOIN oauth_tokens t ON t.grant_id = g.id
              WHERE g.client_id = c.client_id AND g.revoked_at IS NULL
              AND t.expires_at > ?1 AND t.used_at IS NULL)
          ORDER BY c.created_at DESC, c.rowid DESC LIMIT -1 OFFSET 200)`,
      [at],
    );
  })();
}

export function oauthClient(db: Database, id: string): Client | null {
  const row = db
    .query<ClientRow, [string]>(
      `SELECT client_id, secret_hash, client_name, redirect_uris, auth_method, created_at
       FROM oauth_clients WHERE client_id = ?1`,
    )
    .get(id);
  if (row === null) {
    return null;
  }
  return {
    clientId: row.client_id,
    secretHash: row.secret_hash,
    clientName: row.client_name,
    redirectUris: redirectUris(row.redirect_uris),
    authMethod: row.auth_method,
    createdAt: row.created_at,
  };
}

/** Creates the grant and its first token pair atomically; returns the grant's id. */
export function oauthCreateGrant(db: Database, created: NewGrant, at: number): number {
  return db.transaction(() => {
    const id = Number(
      db.run(
        `INSERT INTO oauth_grants (owner_key, client_id, client_name, scopes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
        [
          created.owner,
          created.client.clientId,
          created.client.clientName,
          formatScopes(created.scopes),
          at,
        ],
      ).lastInsertRowid,
    );
    insertPair(db, id, created.tokens, at);
    return id;
  })();
}

/** Resolves live access and records use. Refresh credentials never authenticate MCP. */
export function oauthAccess(db: Database, hash: string, at: number): Grant | null {
  const row = db
    .query<GrantRow, [string, number]>(
      `SELECT ${GRANT_COLUMNS} FROM oauth_grants g
       JOIN oauth_tokens t ON t.grant_id = g.id WHERE t.token_hash = ?1
       AND t.kind = 'access' AND t.expires_at > ?2 AND g.revoked_at IS NULL`,
    )
    .get(hash, at);
  if (row === null) {
    return null;
  }
  const found = grant(row);
  db.run(
    `UPDATE oauth_grants SET last_used_at = ?2 WHERE id = ?1
     AND (last_used_at IS NULL OR last_used_at <= ?2 - 60)`,
    [found.id, at],
  );
  return found;
}

/** Rotates a refresh credential under one transaction; a replay revokes its family. */
export function oauthRotate(db: Database, refresh: Refresh, at: number): RefreshResult {
  return db.transaction((): RefreshResult => {
    const row = db
      .query<GrantRow & { used_at: number | null; expires_at: number }, [string, string]>(
        `SELECT ${GRANT_COLUMNS}, t.used_at, t.expires_at FROM oauth_grants g
         JOIN oauth_tokens t ON t.grant_id = g.id
         WHERE t.token_hash = ?1 AND t.kind = 'refresh'
         AND g.client_id = ?2 AND g.revoked_at IS NULL`,
      )
      .get(refresh.hash, refresh.clientId);
    if (row === null) {
      return { kind: "invalid" };
    }
    const found = grant(row);
    if (row.used_at !== null) {
      db.run("UPDATE oauth_grants SET revoked_at = ?2 WHERE id = ?1", [found.id, at]);
      return { kind: "invalid" };
    }
    if (row.expires_at <= at) {
      return { kind: "invalid" };
    }
    const scopes = refresh.requested ?? found.scopes;
    if (!isSubsetOf(scopes, found.scopes)) {
      return { kind: "invalid_scope" };
    }
    db.run("UPDATE oauth_tokens SET used_at = ?2 WHERE token_hash = ?1", [refresh.hash, at]);
    // Scopes live on the grant, so narrowing also removes privilege from older access tokens.
    db.run("UPDATE oauth_grants SET scopes = ?2 WHERE id = ?1", [found.id, formatScopes(scopes)]);
    insertPair(db, found.id, refresh.tokens, at);
    return { kind: "issued", scopes };
  })();
}

export function oauthRevokeGrant(db: Database, id: number, at: number): void {
  db.run("UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, ?2) WHERE id = ?1", [id, at]);
}

/** A token a client asks to revoke: its digest and the client presenting it. */
export interface TokenRevocation {
  hash: string;
  clientId: string;
}

export function oauthRevokeToken(db: Database, revocation: TokenRevocation, at: number): void {
  db.run(
    `UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, ?3)
     WHERE client_id = ?2 AND id IN
     (SELECT grant_id FROM oauth_tokens WHERE token_hash = ?1)`,
    [revocation.hash, revocation.clientId, at],
  );
}

export function oauthListGrants(db: Database, at: number): Grant[] {
  return db
    .query<GrantRow, [number]>(
      `SELECT ${GRANT_COLUMNS} FROM oauth_grants g WHERE revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id
                   AND t.expires_at > ?1 AND t.used_at IS NULL)
       ORDER BY g.created_at DESC, g.id DESC`,
    )
    .all(at)
    .map(grant);
}

function insertPair(db: Database, id: number, tokens: TokenPair, at: number): void {
  db.run(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at)
     VALUES (?1, ?2, 'access', ?3), (?4, ?2, 'refresh', ?5)`,
    [tokens.accessHash, id, at + 3600, tokens.refreshHash, at + 30 * 86400],
  );
}
