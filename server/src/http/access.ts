// Cloudflare Access sign-in verifies the JWT on a request against the team's cached keys
// and the application's audience.

import { STATUS_CODES } from "node:http";

import { debugString, trim } from "../domain/rust.ts";

export const ACCESS_HEADER = "cf-access-jwt-assertion";

const KEY_LIFETIME = 60 * 60 * 1000;
// Unknown key IDs can trigger a refresh, but not on every request.
const REFETCH_INTERVAL = 30 * 1000;
const LEEWAY_SECONDS = 60n;
const MAX_CERTS_BYTES = 64 * 1024;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export type AccessConfig = { readonly issuer: string; readonly audience: string };

export function parseAccessConfig(teamDomain: string, audience: string): AccessConfig {
  const host = trim(teamDomain).replace(/^https:\/\//, "").replace(/\/$/, "");
  if (!host.includes(".") || host.split(".").some((label) => label === "" || /[^A-Za-z0-9-]/.test(label))) {
    throw new Error(
      `TOODO_CF_ACCESS_TEAM_DOMAIN ${debugString(teamDomain)} is not a team domain such as myteam.cloudflareaccess.com`,
    );
  }
  const aud = trim(audience);
  if (aud === "") {
    throw new Error(
      "TOODO_CF_ACCESS_AUD is empty; set it to the Application Audience (AUD) tag of the Access application",
    );
  }
  return { issuer: `https://${host.toLowerCase()}`, audience: aud };
}

export type KeySource = (url: string) => Promise<Uint8Array>;

export function httpKeySource(): KeySource {
  return async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      if (!response.ok) {
        throw new Error(`answered ${response.status} ${STATUS_CODES[response.status] ?? "<unknown status code>"}`);
      }

      // Bound the streamed body rather than trusting the advertised Content-Length.
      const bytes = new Uint8Array(MAX_CERTS_BYTES);
      let size = 0;
      if (response.body !== null) {
        for await (const chunk of response.body) {
          if (size + chunk.length > MAX_CERTS_BYTES) {
            controller.abort();
            throw new Error(`the list is over ${MAX_CERTS_BYTES} bytes`);
          }
          bytes.set(chunk, size);
          size += chunk.length;
        }
      }
      return bytes.subarray(0, size);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      // Abort an unread response on early exit as well as clearing the deadline.
      controller.abort();
      clearTimeout(timeout);
    }
  };
}

export type AccessRejection =
  | "malformed" | "algorithm" | "unknown_key" | "signature"
  | "issuer" | "audience" | "expired" | "not_yet_valid";

type Key = { readonly n: string; readonly e: string; readonly modulusBits: number };
type Jwt = {
  readonly kid: string;
  readonly signed: string;
  readonly signature: Uint8Array<ArrayBuffer>;
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly expires: bigint;
  readonly notBefore: bigint | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  const bytes = Buffer.from(text, "base64url");
  // Buffer accepts padding, other alphabets and nonzero unused bits; Rust rejects them.
  return bytes.toString("base64url") === text ? bytes : null;
}

function parseKeys(body: Uint8Array): Map<string, Key> {
  const prefix = "the certificate list is not a JSON Web Key Set: ";
  let list: unknown;
  try {
    list = JSON.parse(utf8.decode(body));
  } catch (error) {
    throw new Error(prefix + (error instanceof Error ? error.message : String(error)));
  }
  if (!isObject(list) || !Array.isArray(list.keys)) {
    throw new Error(prefix + "expected an object with a keys array");
  }
  const keys = new Map<string, Key>();
  for (const entry of list.keys as readonly unknown[]) {
    if (!isObject(entry)) continue;
    const { kid, kty, n, e } = entry;
    if (typeof kid !== "string" || kty !== "RSA" || typeof n !== "string" || typeof e !== "string") continue;
    const modulus = decodeBase64url(n);
    if (modulus === null || decodeBase64url(e) === null) continue;
    const first = modulus[0] ?? 0;
    // Keep decodable keys even if unusable, so verification reports a signature failure.
    const modulusBits = first === 0 ? 0 : 8 * (modulus.length - 1) + 32 - Math.clz32(first);
    keys.set(kid, { n, e, modulusBits });
  }
  return keys;
}

function isI64(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= I64_MIN && value <= I64_MAX;
}

function parseJwt(token: string): Jwt | AccessRejection {
  const parts = trim(token).split(".");
  if (parts.length !== 3) return "malformed";
  const [header, claims, signature] = parts;
  try {
    const headerBytes = decodeBase64url(header);
    if (headerBytes === null) return "malformed";
    const parsed: unknown = JSON.parse(utf8.decode(headerBytes));
    if (!isObject(parsed) || typeof parsed.alg !== "string" ||
        (parsed.kid != null && typeof parsed.kid !== "string")) return "malformed";
    if (parsed.alg !== "RS256") return "algorithm";
    if (parsed.kid == null) return "unknown_key";

    const signatureBytes = decodeBase64url(signature);
    const claimsBytes = decodeBase64url(claims);
    if (signatureBytes === null || claimsBytes === null) return "malformed";
    const payload: unknown = JSON.parse(utf8.decode(claimsBytes), (
      key: string, value: unknown, context?: { readonly source?: string },
    ) => {
      // Read integer claims from the source so rounding cannot change the time checks
      // or turn a JSON fraction into a valid Rust i64.
      const source = context?.source;
      return (key === "exp" || key === "nbf") && typeof value === "number" &&
        source !== undefined && /^-?\d+$/.test(source) ? BigInt(source) : value;
    });
    if (!isObject(payload)) return "malformed";
    const { iss, aud, exp, nbf } = payload;
    if (typeof iss !== "string" || !isI64(exp) || (nbf != null && !isI64(nbf))) return "malformed";
    const audiences = typeof aud === "string" ? [aud] : aud;
    if (!Array.isArray(audiences) || !audiences.every((value: unknown) => typeof value === "string")) {
      return "malformed";
    }
    return { kid: parsed.kid, signed: `${header}.${claims}`, signature: signatureBytes,
      issuer: iss, audiences, expires: exp, notBefore: nbf ?? null };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return "malformed";
    throw error;
  }
}

export class AccessVerifier {
  private keys = new Map<string, Key>();
  private fetched: number | undefined;
  private tried: number | undefined;
  private keyQueue = Promise.resolve();

  constructor(
    private readonly config: AccessConfig,
    private readonly source: KeySource,
    private readonly clock: { now(): number } = performance,
  ) {}

  async admits(headers: Headers): Promise<boolean> {
    const token = headers.get(ACCESS_HEADER);
    return token !== null && !/[^ -~]/.test(token) &&
      (await this.verify(token, Math.max(0, Math.floor(Date.now() / 1000)))) === null;
  }

  async verify(token: string, nowSeconds: number): Promise<AccessRejection | null> {
    const jwt = parseJwt(token);
    if (typeof jwt === "string") return jwt;
    const key = await this.key(jwt.kid);
    if (key === undefined) return "unknown_key";
    const { n, e, modulusBits } = key;
    if (modulusBits < 2048 || modulusBits > 8192) return "signature";
    try {
      const publicKey = await crypto.subtle.importKey(
        "jwk", { kty: "RSA", n, e, alg: "RS256", ext: true }, RSA, false, ["verify"],
      );
      if (!(await crypto.subtle.verify(RSA, publicKey, jwt.signature, encoder.encode(jwt.signed)))) {
        return "signature";
      }
    } catch (error) {
      if (error instanceof Error) return "signature";
      throw error;
    }
    if (jwt.issuer !== this.config.issuer) return "issuer";
    if (!jwt.audiences.includes(this.config.audience)) return "audience";
    const expires = jwt.expires + LEEWAY_SECONDS;
    if (nowSeconds >= (expires > I64_MAX ? I64_MAX : expires)) return "expired";
    if (jwt.notBefore !== null) {
      const notBefore = jwt.notBefore - LEEWAY_SECONDS;
      if (nowSeconds < (notBefore < I64_MIN ? I64_MIN : notBefore)) return "not_yet_valid";
    }
    return null;
  }

  private async key(kid: string): Promise<Key | undefined> {
    // Like the Rust mutex, wait for the previous lookup before deciding whether to fetch.
    const previous = this.keyQueue;
    const next = Promise.withResolvers<void>();
    this.keyQueue = next.promise;
    await previous;
    try {
      const now = this.clock.now();
      const stale = this.fetched === undefined || now - this.fetched >= KEY_LIFETIME;
      const mayFetch = this.tried === undefined || now - this.tried >= REFETCH_INTERVAL;
      if ((stale || !this.keys.has(kid)) && mayFetch) {
        this.tried = now;
        const url = `${this.config.issuer}/cdn-cgi/access/certs`;
        try {
          this.keys = parseKeys(await this.source(url));
          this.fetched = this.clock.now();
        } catch (error) {
          // Keep the previous keys on failure: a replaced key can still be valid.
          const reason = error instanceof Error ? error.message : String(error);
          console.error(`toodo-server: cannot fetch the Cloudflare Access keys from ${url}: ${reason}`);
        }
      }
      return this.keys.get(kid);
    } finally {
      next.resolve();
    }
  }
}
