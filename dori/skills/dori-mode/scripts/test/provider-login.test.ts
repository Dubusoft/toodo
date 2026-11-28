import { expect, test } from "bun:test";

import { accountToReuse, parseAuthCheck, routeChoice } from "../src/provider-login.ts";

test("takes the sign-in routes that work without a browser on the host, as omo 5.1 offers them", () => {
  // Codex: the legacy sign-in (Continue with ChatGPT needs an OmO device), then the browser login with its paste field.
  expect(routeChoice("codex", ["Continue with ChatGPT", "Legacy sign-in (existing users)"])).toBe("Legacy sign-in (existing users)");
  expect(routeChoice("codex", ["Browser login (default)", "Device code login (headless)"])).toBe("Browser login (default)");
  expect(routeChoice("claude", ["Browser login (default)", "Copy code login (headless)"])).toBe("Copy code login (headless)");
  expect(routeChoice("claude", ["Something new"])).toBeUndefined();
});

test("signs the first existing account in again, or lets omo name a first one", () => {
  expect(accountToReuse("Name for this account (existing: default, work; press Enter to add account-3, or type an existing name to refresh it)")).toBe("default");
  expect(accountToReuse("Name for this account (press Enter for default)")).toBe("");
});

test("reads a sign-in from omo auth check without credentials", () => {
  expect(parseAuthCheck('noise\n{"status":"ready","provider":"chatgpt-subscription","authType":"oauth","accounts":[{"name":"default"},{"name":"login-2"}]}'))
    .toEqual({ signedIn: true, accounts: 2 });
  expect(parseAuthCheck('{"status":"not_ready","reason":"provider_not_found","accounts":[{"name":"default","signIn":"signed_in"}]}'))
    .toEqual({ signedIn: true, accounts: 1 });
  expect(parseAuthCheck('{"status":"not_ready","reason":"credentials_not_configured","accounts":[]}')).toEqual({ signedIn: false, accounts: 0 });
  expect(parseAuthCheck("error: unknown provider")).toBeUndefined();
});
