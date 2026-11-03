import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/web/core";
import { getToken, setToken } from "@/web/session";

function reply(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status }));
}

describe("invoke", () => {
  beforeEach(() => setToken("secret"));
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("posts the arguments with the token and resolves with the result", async () => {
    const fetch = reply(200, '[{"id":1}]');
    vi.stubGlobal("fetch", fetch);

    await expect(invoke("list_tasks", { id: 3 })).resolves.toEqual([{ id: 1 }]);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/rpc/list_tasks");
    expect(init.body).toBe('{"id":3}');
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret");
  });

  it("rejects with the command error object", async () => {
    vi.stubGlobal("fetch", reply(409, '{"kind":"rejected","message":"cycle"}'));

    await expect(invoke("add_dependency")).rejects.toEqual({ kind: "rejected", message: "cycle" });
  });

  it("forgets a token the server rejects", async () => {
    vi.stubGlobal("fetch", reply(401, "missing or wrong Toodo access token"));

    await expect(invoke("list_tasks")).rejects.toBeInstanceOf(Error);
    expect(getToken()).toBeNull();
  });

  it("rejects with an Error for an unknown command", async () => {
    vi.stubGlobal("fetch", reply(404, "unknown command"));

    await expect(invoke("nope")).rejects.toThrow("unknown command");
  });
});
