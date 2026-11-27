import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { webcrypto } from "node:crypto";

import { ACCESS_HEADER, AccessVerifier, parseAccessConfig } from "./access.ts";
import type { AccessRejection, KeySource } from "./access.ts";

const TEAM = "toodo-test.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUD = "test-aud";
const KID = "test-kid";
const NOW = 1_800_000_000;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

let signing: CryptoKeyPair;
let publicJwk: webcrypto.JsonWebKey;

beforeAll(async () => {
  signing = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  publicJwk = await crypto.subtle.exportKey("jwk", signing.publicKey);
});

function base64url(value: string | ArrayBuffer | Uint8Array): string {
  return typeof value === "string" ? Buffer.from(value).toString("base64url") :
    Buffer.from(new Uint8Array(value)).toString("base64url");
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function certs(kid = KID): Uint8Array {
  return json({ keys: [{ ...publicJwk, kid, use: "sig" }] });
}

class FakeKeys {
  fetches = 0;
  source: KeySource = async (url) => {
    if (url !== CERTS_URL) throw new Error(`Unexpected certificate URL: ${url}`);
    this.fetches++;
    return this.body.slice();
  };

  constructor(public body = certs()) {}
}

function verifier(keys = new FakeKeys(), clock = { now: () => 0 }): AccessVerifier {
  return new AccessVerifier(parseAccessConfig(TEAM, AUD), keys.source, clock);
}

function claims(now = NOW) {
  return { iss: ISSUER, aud: [AUD], email: "owner@example.com", sub: "owner", iat: now, nbf: now, exp: now + 3600 };
}

async function token(kid = KID, payload: unknown = claims()): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const signed = `${header}.${base64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(RSA, signing.privateKey, encoder.encode(signed));
  return `${signed}.${base64url(signature)}`;
}

function check(jwt: string): Promise<AccessRejection | null> {
  return verifier().verify(jwt, NOW);
}

describe("Cloudflare Access", () => {
  test("a JWT of the team for the application is accepted", async () => {
    expect(await check(await token())).toBeNull();
    expect(await check(await token(KID, { ...claims(), aud: AUD }))).toBeNull();
    // Both sides of the clock leeway matter, including the inclusive nbf boundary.
    expect(await check(await token(KID, { ...claims(), exp: NOW - 30 }))).toBeNull();
    expect(await check(await token(KID, { ...claims(), nbf: NOW + 30 }))).toBeNull();
    expect(await check(await token(KID, { ...claims(), nbf: NOW + 60 }))).toBeNull();
    expect(await check(await token(KID, { ...claims(), nbf: undefined }))).toBeNull();
  });

  test("other issuers, audiences, and times are rejected", async () => {
    const cases = [
      [{ iss: "https://other.cloudflareaccess.com" }, "issuer"],
      [{ aud: ["other-aud"] }, "audience"],
      [{ exp: NOW - 61 }, "expired"],
      [{ exp: NOW - 60 }, "expired"],
      [{ nbf: NOW + 61 }, "not_yet_valid"],
      [{ exp: undefined }, "malformed"],
      [{ exp: NOW + 0.5 }, "malformed"],
      [{ aud: [AUD, 1] }, "malformed"],
    ] as const;
    for (const [change, rejection] of cases) {
      expect(await check(await token(KID, { ...claims(), ...change }))).toBe(rejection);
    }
  });

  test("forged and malformed JWTs are rejected", async () => {
    const [header, payload, signature] = (await token()).split(".");
    const [, otherClaims] = (await token(KID, { ...claims(), aud: ["other-aud", AUD] })).split(".");
    expect(await check(`${header}.${otherClaims}.${signature}`)).toBe("signature");
    const flipped = Buffer.from(signature, "base64url");
    flipped[0] ^= 1;
    expect(await check(`${header}.${payload}.${base64url(flipped)}`)).toBe("signature");
    expect(await check(await token("other-kid"))).toBe("unknown_key");
    const none = base64url('{"alg":"none","kid":"test-kid"}');
    expect(await check(`${none}.${payload}.`)).toBe("algorithm");
    const noKid = base64url('{"alg":"RS256"}');
    expect(await check(`${noKid}.${payload}.${signature}`)).toBe("unknown_key");
    for (const malformed of ["", "a.b", "a.b.c.d", "!!.!!.!!", `${header}.${payload}.%%`,
      `${header}.${payload}.${signature}=`, `${header}.${payload}.AB`]) {
      expect([malformed, await check(malformed)]).toEqual([malformed, "malformed"]);
    }
  });

  test("an unknown key ID triggers a refresh at most every 30 seconds", async () => {
    const keys = new FakeKeys();
    let time = 0;
    const access = verifier(keys, { now: () => time });
    const original = await token();
    const rotated = await token("rotated-kid");

    expect(await access.verify(original, NOW)).toBeNull();
    expect(await access.verify(original, NOW)).toBeNull();
    expect(keys.fetches).toBe(1);
    keys.body = certs("rotated-kid");
    time = 29_999;
    expect(await access.verify(rotated, NOW)).toBe("unknown_key");
    expect(keys.fetches).toBe(1);
    time = 30_000;
    expect(await access.verify(rotated, NOW)).toBeNull();
    expect(keys.fetches).toBe(2);
  });

  test("the team domain is a host name and the audience must not be empty", () => {
    expect(parseAccessConfig("Team.cloudflareaccess.com", AUD).issuer).toBe("https://team.cloudflareaccess.com");
    expect(parseAccessConfig("https://team.cloudflareaccess.com/", ` ${AUD} `))
      .toEqual({ issuer: "https://team.cloudflareaccess.com", audience: AUD });
    for (const bad of ["", "team", "http://team.cloudflareaccess.com", "team.cloudflareaccess.com/path", "a..b"]) {
      expect(() => parseAccessConfig(bad, AUD)).toThrow(
        `TOODO_CF_ACCESS_TEAM_DOMAIN "${bad}" is not a team domain such as myteam.cloudflareaccess.com`,
      );
    }
    expect(() => parseAccessConfig(TEAM, " ")).toThrow(
      "TOODO_CF_ACCESS_AUD is empty; set it to the Application Audience (AUD) tag of the Access application",
    );
  });

  test("only decodable RSA keys with a key ID are kept", async () => {
    const keys = new FakeKeys(json({
      keys: [
        { kid: "a", kty: "EC", x: "AA", y: "AA" },
        publicJwk,
        { kid: "bad-encoding", kty: "RSA", n: "AR", e: "AQAB" },
        { kid: "short", kty: "RSA", n: "AQ", e: "AQAB" },
        { ...publicJwk, kid: "b" },
      ],
      public_cert: {},
    }));
    const access = verifier(keys);
    expect(await access.verify(await token("a"), NOW)).toBe("unknown_key");
    expect(await access.verify(await token("bad-encoding"), NOW)).toBe("unknown_key");
    expect(await access.verify(await token("short"), NOW)).toBe("signature");
    expect(await access.verify(await token("b"), NOW)).toBeNull();
  });

  test("a failed refresh of stale keys logs the error and keeps the old key", async () => {
    const keys = new FakeKeys();
    let time = 0;
    const access = verifier(keys, { now: () => time });
    const jwt = await token();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await access.verify(jwt, NOW)).toBeNull();
      keys.body = encoder.encode("<html>");
      time = 3_599_999;
      expect(await access.verify(jwt, NOW)).toBeNull();
      expect(keys.fetches).toBe(1);
      time = 3_600_000;
      expect(await access.verify(jwt, NOW)).toBeNull();
      expect(keys.fetches).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(
        `toodo-server: cannot fetch the Cloudflare Access keys from ${CERTS_URL}: the certificate list is not a JSON Web Key Set: `,
      ));
      expect(await access.verify(jwt, NOW)).toBeNull();
      expect(keys.fetches).toBe(2);
    } finally {
      error.mockRestore();
    }
  });

  test("simultaneous verifications wait for the same certificate fetch", async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Uint8Array>();
    let fetches = 0;
    const access = new AccessVerifier(parseAccessConfig(TEAM, AUD), () => {
      fetches++;
      started.resolve();
      return response.promise;
    });
    const jwt = await token();
    const first = access.verify(jwt, NOW);
    await started.promise;
    const second = access.verify(jwt, NOW);
    response.resolve(certs());
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(fetches).toBe(1);
  });

  test("admits reads the Access header and checks against the current time", async () => {
    const access = verifier();
    // A long-lived fixture avoids depending on when the test runner is scheduled.
    const jwt = await token(KID, { ...claims(0), exp: 253_402_300_799 });
    expect(await access.admits(new Headers())).toBe(false);
    expect(await access.admits(new Headers({ [ACCESS_HEADER]: jwt }))).toBe(true);
    expect(await access.admits(new Headers({ [ACCESS_HEADER]: await token(KID, claims(0)) }))).toBe(false);
  });
});
