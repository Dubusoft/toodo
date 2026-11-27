import { describe, expect, test } from "bun:test";

import { configFromEnv, DEFAULT_PORT } from "./config.ts";

function config(vars: Record<string, string>) {
  return configFromEnv((name) => (name === "HOME" ? "/home/me" : vars[name]));
}

function failure(vars: Record<string, string>): string {
  try {
    config(vars);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the configuration to be refused");
}

describe("config", () => {
  test("the default config listens on loopback and keeps data in home", () => {
    const defaults = config({});
    expect(defaults.listen).toEqual({ hostname: "127.0.0.1", port: DEFAULT_PORT });
    expect(defaults.dataDir).toBe("/home/me/.local/share/toodo-server");
    expect(defaults.webDir).toBeNull();
    expect(defaults.publicUrl).toBeNull();
    expect(defaults.pushSubject).toBe("https://github.com/Dubusoft/toodo");
    expect(defaults.access).toBeNull();
    expect(defaults.chatAgent).toEqual({ name: "Dori", avatarUrl: null });
    expect(config({ XDG_DATA_HOME: "/data" }).dataDir).toBe("/data/toodo-server");
    expect(config({ TOODO_LISTEN: "[::1]:8080" }).listen).toEqual({ hostname: "::1", port: 8080 });
    expect(failure({ TOODO_LISTEN: "localhost:8080" })).toBe(
      'TOODO_LISTEN "localhost:8080" is not an address: invalid socket address syntax',
    );
    expect(failure({ TOODO_PUSH_SUBJECT: "toodo@example.com" })).toContain("is not a mailto: or https: URL");
  });

  test("the chat agent avatar is an https URL or a path on the server", () => {
    expect(config({ TOODO_CHAT_AGENT_AVATAR: "/avatar.png", TOODO_CHAT_AGENT_NAME: " Dori " }).chatAgent).toEqual({
      name: "Dori",
      avatarUrl: "/avatar.png",
    });
    expect(config({ TOODO_CHAT_AGENT_AVATAR: "https://example.com/a.png" }).chatAgent.avatarUrl).toBe(
      "https://example.com/a.png",
    );
    for (const avatar of ["http://example.com/a.png", "//example.com/a.png", "avatar.png", "/a b.png"]) {
      expect(failure({ TOODO_CHAT_AGENT_AVATAR: avatar })).toContain("is not an https: URL or a path");
    }
  });

  test("public mode requires a valid origin", () => {
    expect(config({ TOODO_PUBLIC_URL: "https://toodo.example.com/" }).publicUrl).toBe("https://toodo.example.com");
    expect(config({ TOODO_PUBLIC_URL: "http://localhost:47616" }).publicUrl).toBe("http://localhost:47616");
    for (const url of [
      "http://toodo.example.com",
      "https://user:secret@toodo.example.com",
      "https://toodo.example.com/path",
      "https://toodo.example.com/?q",
      "https://toodo.example.com/#f",
      "not a url",
    ]) {
      expect(failure({ TOODO_PUBLIC_URL: url })).toContain("Set TOODO_PUBLIC_URL to an HTTPS origin");
    }
  });

  test("access needs both its settings", () => {
    const team = { TOODO_CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };
    const aud = { TOODO_CF_ACCESS_AUD: "aud" };
    expect(config({ ...team, ...aud }).access?.issuer).toBe("https://team.cloudflareaccess.com");
    expect(failure(team)).toContain("TOODO_CF_ACCESS_AUD");
    expect(failure(aud)).toContain("TOODO_CF_ACCESS_TEAM_DOMAIN");
  });
});
