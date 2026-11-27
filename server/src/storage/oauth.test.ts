import { describe, expect, test } from "bun:test";

import { ALL_SCOPES, READ_SCOPES, ownerKey } from "../oauth/scopes.ts";
import {
  type Client,
  oauthAccess,
  oauthClient,
  oauthCreateGrant,
  oauthListGrants,
  oauthRegisterClient,
  oauthRotate,
} from "./oauth.ts";
import { openMemoryDatabase } from "./testing.ts";

const NOW = 1000;

/** The SHA-256 hex digest the OAuth routes store for a credential. */
function hash(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

function client(id: string): Client {
  return {
    clientId: id,
    secretHash: hash("client-secret"),
    clientName: "Example",
    redirectUris: ["https://client.example/callback"],
    authMethod: "client_secret_post",
    createdAt: 1000,
  };
}

describe("oauth storage", () => {
  test("credentials are stored as hashes and access records the last use", () => {
    const db = openMemoryDatabase();
    const c = client("client");
    oauthRegisterClient(db, c, NOW);
    const id = oauthCreateGrant(
      db,
      {
        owner: ownerKey("owner-from-resolver"),
        client: c,
        scopes: ALL_SCOPES,
        tokens: { accessHash: hash("access-secret"), refreshHash: hash("refresh-secret") },
      },
      NOW,
    );
    const stored = db
      .query<{ secret_hash: string }, []>("SELECT secret_hash FROM oauth_clients")
      .get();
    expect(stored?.secret_hash).toBe(hash("client-secret"));
    const hashes = db
      .query<{ token_hash: string }, []>("SELECT token_hash FROM oauth_tokens")
      .all()
      .map((row) => row.token_hash);
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain(hash("access-secret"));
    expect(hashes).toContain(hash("refresh-secret"));
    expect(oauthAccess(db, "access-secret", NOW)).toBeNull();
    const grant = oauthAccess(db, hash("access-secret"), NOW);
    expect(grant?.ownerKey as string | undefined).toBe("owner-from-resolver");
    expect(grant?.id).toBe(id);
    expect(oauthListGrants(db, NOW)[0]?.lastUsedAt).toBe(1000);
    expect(oauthAccess(db, hash("access-secret"), 4600)).toBeNull();
  });

  test("registration bounds orphan clients but preserves clients with a live grant", () => {
    const db = openMemoryDatabase();
    const c = client("live");
    oauthRegisterClient(db, c, NOW);
    oauthCreateGrant(
      db,
      {
        owner: ownerKey("owner"),
        client: c,
        scopes: ALL_SCOPES,
        tokens: { accessHash: "a", refreshHash: "r" },
      },
      NOW,
    );
    for (let n = 0; n < 201; n++) {
      oauthRegisterClient(db, client(`orphan-${n}`), NOW);
    }
    expect(oauthClient(db, "live")).not.toBeNull();
    expect(oauthClient(db, "orphan-0")).toBeNull();
    expect(oauthClient(db, "orphan-200")).not.toBeNull();
    const count = db.query<{ count: number }, []>("SELECT count(*) AS count FROM oauth_clients").get();
    expect(count?.count).toBe(201);
  });

  test("replaying a rotated refresh token revokes every token and narrowing is atomic", () => {
    const db = openMemoryDatabase();
    oauthCreateGrant(
      db,
      {
        owner: ownerKey("owner"),
        client: client("client"),
        scopes: READ_SCOPES,
        tokens: { accessHash: "a", refreshHash: "r" },
      },
      NOW,
    );
    const rotate = (clientId: string, requested: typeof READ_SCOPES | null, n: number) =>
      oauthRotate(
        db,
        { hash: "r", clientId, requested, tokens: { accessHash: `a${n}`, refreshHash: `r${n}` } },
        NOW,
      );
    expect(rotate("other-client", null, 2)).toEqual({ kind: "invalid" });
    expect(rotate("client", ALL_SCOPES, 2)).toEqual({ kind: "invalid_scope" });
    expect(rotate("client", null, 2)).toEqual({ kind: "issued", scopes: READ_SCOPES });
    expect(oauthAccess(db, "a2", NOW)).not.toBeNull();
    expect(rotate("client", null, 3)).toEqual({ kind: "invalid" });
    expect(oauthAccess(db, "a", NOW)).toBeNull();
    expect(oauthAccess(db, "a2", NOW)).toBeNull();
    expect(oauthListGrants(db, NOW)).toEqual([]);
  });
});
