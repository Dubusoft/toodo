// Web Push message encryption (RFC 8291: `aes128gcm` content encoding of RFC 8188 with
// keys from an ECDH exchange with the subscription) and the application server's VAPID
// identity (RFC 8292): an ES256 key that signs a short-lived token for each push service.
// Port of `src-tauri/src/server/push/crypto.rs`; the key file is the same PKCS#8 document.

import { chmodSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";

import { AUTH_LEN, P256DH_LEN } from "../domain/push.ts";

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** `data` in its own `ArrayBuffer`, the only backing Web Crypto takes. */
export function bytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decodes unpadded base64url, as browsers report subscription keys; padding is tolerated.
 * `null` when `text` is not base64url. */
export function fromBase64url(text: string): Uint8Array | null {
  const unpadded = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(unpadded) || unpadded.length % 4 === 1) return null;
  return new Uint8Array(Buffer.from(unpadded, "base64url"));
}

/** The record size announced in the message header. A message is one record, so it must
 * hold the plaintext, its delimiter, and the authentication tag. */
const RECORD_SIZE = 4096;

const TAG_LEN = 16;

/** The header before the record: salt, record size, key id length, and the key id (the
 * sender's uncompressed P-256 public key). */
const HEADER_LEN = 16 + 4 + 1 + P256DH_LEN;

/** The largest plaintext of a message push services must accept: 4096 bytes in all,
 * header included (RFC 8291, section 4), which leaves 3993. */
export const MAX_PLAINTEXT = 4096 - HEADER_LEN - TAG_LEN - 1;

/** Why a message could not be encrypted for a subscription. */
export class EncryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptError";
  }
}

/** The application server's signing key, kept as PKCS#8 in a file only the owner can read. */
export class VapidKey {
  readonly #private: CryptoKey;
  /** The public key as an uncompressed point: the `applicationServerKey` browsers
   * subscribe with. */
  readonly publicKey: Uint8Array;

  private constructor(privateKey: CryptoKey, publicKey: Uint8Array) {
    this.#private = privateKey;
    this.publicKey = publicKey;
  }

  /** Reads the key at `path`, or creates it there on first start. Browsers bind their
   * subscriptions to this key, so replacing it would silently end every subscription. */
  static async loadOrCreate(path: string): Promise<VapidKey> {
    let pkcs8: Uint8Array;
    try {
      pkcs8 = new Uint8Array(readFileSync(path));
      if (pkcs8.length === 0) {
        rmSync(path);
        pkcs8 = await create(path);
      } else {
        chmodSync(path, 0o600);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      pkcs8 = await create(path);
    }
    return VapidKey.fromPkcs8(pkcs8, path);
  }

  private static async fromPkcs8(pkcs8: Uint8Array, path: string): Promise<VapidKey> {
    let privateKey: CryptoKey;
    try {
      privateKey = await crypto.subtle.importKey("pkcs8", bytes(pkcs8), ES256, true, ["sign"]);
    } catch (error) {
      throw new Error(`${path} is not a P-256 key: ${(error as Error).message}`);
    }
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    const point = new Uint8Array(P256DH_LEN);
    point[0] = 0x04;
    point.set(fromBase64url(jwk.x!)!, 1);
    point.set(fromBase64url(jwk.y!)!, 33);
    return new VapidKey(privateKey, point);
  }

  /** The `Authorization` header for a push service at `audience` (its origin): a JWT
   * with the contact `subject` that expires at `expires` (Unix seconds), and the key. */
  async authorization(audience: string, subject: string, expires: number): Promise<string> {
    const encode = (text: string) => base64url(new TextEncoder().encode(text));
    const header = encode('{"typ":"JWT","alg":"ES256"}');
    const claims = encode(JSON.stringify({ aud: audience, exp: expires, sub: subject }));
    const signed = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.#private,
      new TextEncoder().encode(signed),
    );
    return `vapid t=${signed}.${base64url(new Uint8Array(signature))}, k=${base64url(this.publicKey)}`;
  }
}

/** Generates a key and writes it to `path`, readable only by the owner, refusing to
 * overwrite a file that appeared meanwhile. */
async function create(path: string): Promise<Uint8Array> {
  const pair = await crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const file = openSync(path, "wx", 0o600);
  try {
    writeSync(file, pkcs8);
  } finally {
    closeSync(file);
  }
  return pkcs8;
}

async function importPublic(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes(key), P256, true, []);
}

/** Whether `key` is a point on P-256 that a message can be encrypted for. */
export async function isValidPublicKey(key: Uint8Array): Promise<boolean> {
  if (key.length !== P256DH_LEN) return false;
  try {
    const subscription = await importPublic(key);
    const ours = await crypto.subtle.generateKey(P256, false, ["deriveBits"]);
    await crypto.subtle.deriveBits({ name: "ECDH", public: subscription }, ours.privateKey, 256);
    return true;
  } catch {
    return false;
  }
}

/** Encrypts `plaintext` (at most `MAX_PLAINTEXT` bytes) for the subscription with the
 * public key `uaPublic` and the secret `auth`, with a fresh key pair and salt. */
export async function encrypt(
  uaPublic: Uint8Array,
  auth: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT) {
    throw new EncryptError(`a push message holds at most ${MAX_PLAINTEXT} bytes`);
  }
  if (uaPublic.length !== P256DH_LEN || auth.length !== AUTH_LEN) {
    throw new EncryptError("the subscription keys have the wrong length");
  }
  let subscription: CryptoKey;
  try {
    subscription = await importPublic(uaPublic);
  } catch {
    throw new EncryptError("the subscription key is not a point on P-256");
  }
  const ours = await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ours.publicKey));
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: subscription }, ours.privateKey, 256),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return encryptWith(secret, uaPublic, asPublic, auth, salt, plaintext);
}

/** The message for a known ECDH secret, key pair, and salt (RFC 8291, section 3.4). */
export async function encryptWith(
  ecdhSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  auth: Uint8Array,
  salt: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const { cek, nonce } = await contentKeys(ecdhSecret, uaPublic, asPublic, auth, salt);
  // The delimiter of the last (here: only) record, without further padding.
  const record = new Uint8Array(plaintext.length + 1);
  record.set(plaintext);
  record[plaintext.length] = 2;
  const key = await crypto.subtle.importKey("raw", bytes(cek), "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(nonce) }, key, record));
  const message = new Uint8Array(16 + 4 + 1 + asPublic.length + sealed.length);
  message.set(salt, 0);
  new DataView(message.buffer).setUint32(16, RECORD_SIZE);
  message[20] = asPublic.length;
  message.set(asPublic, 21);
  message.set(sealed, 21 + asPublic.length);
  return message;
}

/** The content encryption key and nonce: the ECDH secret is first combined with the
 * subscription's `auth` secret and both public keys, then keyed by the message's salt. */
export async function contentKeys(
  ecdhSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  auth: Uint8Array,
  salt: Uint8Array,
): Promise<{ cek: Uint8Array; nonce: Uint8Array }> {
  const keyInfo = concat(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdfSha256(auth, ecdhSecret, keyInfo, 32);
  const cek = await hkdfSha256(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfSha256(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  return { cek, nonce };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdfSha256(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bytes(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: bytes(salt), info: bytes(info) },
      key,
      length * 8,
    ),
  );
}
