import { describe, expect, test } from "bun:test";

import { isPublic, literalIp, publicAddresses } from "./net.ts";

describe("net", () => {
  test("only public addresses count as public", () => {
    for (const ip of ["93.184.216.34", "2606:4700::1111", "::ffff:93.184.216.34"]) {
      expect([ip, isPublic(ip)]).toEqual([ip, true]);
    }
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "192.0.2.1",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
    ]) {
      expect([ip, isPublic(ip)]).toEqual([ip, false]);
    }
  });

  test("host names resolving only to private addresses are refused", async () => {
    expect(publicAddresses("localhost")).rejects.toThrow("localhost has no public address");
  });

  test("addresses written in a url are found in every form", () => {
    const literal = (url: string) => literalIp(new URL(url));
    expect(literal("http://127.0.0.1/ready")).toBe("127.0.0.1");
    expect(literal("http://2130706433/ready")).toBe("127.0.0.1");
    expect(literal("http://[::1]/ready")).toBe("::1");
    expect(literal("http://[::ffff:10.0.0.1]/ready")).toBe("::ffff:a00:1");
    expect(isPublic(literal("http://[::ffff:10.0.0.1]/ready")!)).toBe(false);
    expect(literal("https://push.example/x")).toBeNull();
  });
});
