import { expect, test } from "bun:test";

import { guardText } from "../src/messenger/http.ts";
import { redactSecrets } from "../src/redact.ts";

const secrets: Record<string, string> = {
  // Joined at runtime so secret scanners do not take these fake fixtures for real bot tokens.
  discord: ["MTA1NjY3ODkwMTIzNDU2Nzg5MA", "GabcDE", "abcdefghijklmnopqrstuvwxyz0123456789"].join("."),
  telegram: ["123456789", "AAEhBOweik6ad9r_QXMENQjcrTu-oq3hGsW"].join(":"),
  slack: "xoxb-1234567890-abcdefghijkl",
  ghp: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  gho: "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  pat: "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz",
  openai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-0123456789",
  aws: "AKIAIOSFODNN7EXAMPLE",
  bearer: "abcdefghijklmnop.qrstuvwx.yz0123",
};

test("redactSecrets masks every listed secret kind", () => {
  for (const [kind, secret] of Object.entries(secrets)) {
    const out = redactSecrets(kind === "bearer" ? `Authorization: Bearer ${secret}` : `value ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  }
});

test("redactSecrets masks assignments and PEM blocks but keeps the key names", () => {
  expect(redactSecrets("password=hunter2 ok")).toBe("password=[REDACTED] ok");
  expect(redactSecrets("token: abc123xyz")).toBe("token: [REDACTED]");
  expect(redactSecrets('API_KEY="a b c"')).toBe("API_KEY=[REDACTED]");
  expect(redactSecrets("pwd: 123456")).toBe("pwd: [REDACTED]");
  expect(redactSecrets("token: abcdefghijklmnopqrstuvwx")).toBe("token: [REDACTED]");
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAbCd\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`before\n${pem}\nafter`);
  expect(out).toBe("before\n[REDACTED PRIVATE KEY]\nafter");
});

test("redactSecrets leaves ordinary text untouched", () => {
  const plain = [
    "Deploy finished at 12:30 for lane build-7; 3 tests passed.",
    "See https://example.com/a/b?x=1 and PR #42, sk-learn is a library.",
    "the token budget is large; password policy docs updated",
    "commit 3676533abc and ratio 10:20",
    "한국어 메시지도 그대로 둡니다.",
  ];
  for (const t of plain) expect(redactSecrets(t)).toBe(t);
});

test("guardText preserves ordinary English and Korean assignment values", () => {
  const plain = [
    "token: 3 left",
    "secret: plan",
    "secret: 계획",
    "token: 3개 남음",
    "secret: 다음계획을확인하세요",
    "token: remaining",
    'secret: "plan"',
    "password=policy",
    "api_key: documentation",
  ];
  for (const text of plain) expect(guardText(text)).toBe(text);
});

test("guardText redacts secrets and still rejects $(", () => {
  expect(guardText(`key ${secrets.ghp}`)).toBe("key [REDACTED]");
  expect(() => guardText("x $(id)")).toThrow();
});
