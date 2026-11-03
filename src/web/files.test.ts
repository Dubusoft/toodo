import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadExport, uploadRestore } from "@/web/files";
import { getToken, setToken } from "@/web/session";

describe("database files of the server", () => {
  beforeEach(() => setToken("secret"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("uploads a database with the token and resolves with the pre-restore backup", async () => {
    const safety = { path: "/data/backups/toodo-pre-restore-20261014-100000.sqlite3", kind: "preRestore" };
    const fetch = vi.fn(async () => new Response(JSON.stringify(safety), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const file = new Blob(["SQLite format 3"]);

    await expect(uploadRestore(file)).resolves.toEqual(safety);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/backups/restore");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("rejects with the message of a command error or the server's text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"kind":"invalidInput","message":"not a Toodo database"}', { status: 422 })),
    );
    await expect(uploadRestore(new Blob(["x"]))).rejects.toThrow("not a Toodo database");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("a database to restore is at most 256 MB", { status: 413 })));
    await expect(uploadRestore(new Blob(["x"]))).rejects.toThrow("at most 256 MB");
  });

  it("forgets a token the server rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing or wrong Toodo access token", { status: 401 })));

    await expect(downloadExport()).rejects.toBeInstanceOf(Error);
    expect(getToken()).toBeNull();
  });

  it("saves a snapshot under the name the server gives it", async () => {
    const response = new Response("SQLite format 3", {
      status: 200,
      headers: { "Content-Disposition": 'attachment; filename="toodo-backup-2026-10-14.sqlite3"' },
    });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(downloadExport()).resolves.toBe("toodo-backup-2026-10-14.sqlite3");
    expect(click).toHaveBeenCalledOnce();
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("toodo-backup-2026-10-14.sqlite3");
  });
});
