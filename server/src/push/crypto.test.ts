import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTH_LEN } from "../domain/push.ts";
import {
  EncryptError,
  MAX_PLAINTEXT,
  VapidKey,
  base64url,
  bytes,
  encrypt,
  encryptWith,
  fromBase64url,
  isValidPublicKey,
} from "./crypto.ts";
import { Browser } from "./testing.ts";

function d(text: string): Uint8Array {
  return fromBase64url(text)!;
}

describe("push crypto", () => {
  test("encrypts the RFC 8291 example", async () => {
    const message = await encryptWith(
      d("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"),
      d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      d("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
      d("BTBZMqHH6r4Tts7J_aSIgg"),
      d("DGv6ra1nlYgDCS1FRnbzlw"),
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    );
    expect(base64url(message)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  test("a subscription decrypts what is encrypted for it", async () => {
    const browser = await Browser.create();
    expect(await isValidPublicKey(browser.publicKey)).toBe(true);
    const plaintext = new TextEncoder().encode('{"title":"Hi"}');
    const message = await encrypt(browser.publicKey, browser.auth, plaintext);
    expect(await browser.decrypt(message)).toEqual(plaintext);
    expect(encrypt(browser.publicKey, browser.auth, new Uint8Array(MAX_PLAINTEXT + 1))).rejects.toThrow(
      EncryptError,
    );
  });

  // Push services need only accept 4096-byte messages (RFC 8030, section 7.2), header
  // included (RFC 8291, section 4).
  test("the longest message fits in 4096 bytes", async () => {
    const browser = await Browser.create();
    const message = await encrypt(browser.publicKey, new Uint8Array(AUTH_LEN).fill(3), new Uint8Array(MAX_PLAINTEXT));
    expect(message.length).toBe(4096);
  });

  test("points off the curve are not keys", async () => {
    const key = new Uint8Array(65).fill(1);
    key[0] = 4;
    expect(await isValidPublicKey(key)).toBe(false);
    expect(encrypt(key, new Uint8Array(AUTH_LEN), new Uint8Array([1]))).rejects.toThrow(EncryptError);
  });

  test("base64url accepts padding and refuses other alphabets", () => {
    expect(fromBase64url("BTBZMqHH6r4Tts7J_aSIgg==")).toEqual(d("BTBZMqHH6r4Tts7J_aSIgg"));
    expect(fromBase64url("a+b/")).toBeNull();
    expect(fromBase64url("abcde")).toBeNull();
  });

  test("the VAPID key is kept private and signs tokens for its public key", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "push-key-")), "push-key");
    const key = await VapidKey.loadOrCreate(path);
    expect(key.publicKey.length).toBe(65);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = await VapidKey.loadOrCreate(path);
    expect(again.publicKey).toEqual(key.publicKey);

    const header = await key.authorization("https://push.example", "mailto:me@example.com", 1234);
    const [token, k] = header.slice("vapid t=".length).split(", k=") as [string, string];
    expect(header.startsWith("vapid t=")).toBe(true);
    expect(d(k)).toEqual(key.publicKey);
    const signed = token.slice(0, token.lastIndexOf("."));
    const signature = token.slice(token.lastIndexOf(".") + 1);
    expect(JSON.parse(new TextDecoder().decode(d(signed.split(".")[1]!)))).toEqual({
      aud: "https://push.example",
      exp: 1234,
      sub: "mailto:me@example.com",
    });
    const verifier = await crypto.subtle.importKey("raw", bytes(key.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        bytes(d(signature)),
        new TextEncoder().encode(signed),
      ),
    ).toBe(true);
  });

  test("an empty key file is replaced and a broken one is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "push-key-"));
    const empty = join(dir, "empty");
    writeFileSync(empty, "");
    expect((await VapidKey.loadOrCreate(empty)).publicKey.length).toBe(65);
    const broken = join(dir, "broken");
    writeFileSync(broken, "not a key");
    expect(VapidKey.loadOrCreate(broken)).rejects.toThrow(`${broken} is not a P-256 key`);
  });
});
